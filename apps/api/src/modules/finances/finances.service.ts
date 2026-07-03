import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { Prisma, FinAccount, FinBook, FinTransaction } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { ContactsService } from '../contacts/contacts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccessService } from '../../core/access/access.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import {
  FIN_LIMITS,
  FIN_DEFAULT_CURRENCY,
  FIN_SEED_ACCOUNTS,
  FIN_SEED_EXPENSE_CATEGORIES,
  FIN_SEED_INCOME_CATEGORIES,
} from '@superapp/shared';
import type {
  FinAccountDto,
  FinBookOverviewDto,
  FinBookRole,
  FinBudgetDto,
  FinCategorySpendDto,
  FinCoinFeedItemDto,
  FinDebtDto,
  FinListTransactionsResult,
  FinMoneySumDto,
  FinMonthReportDto,
  FinPeopleReportRowDto,
  FinPersonDto,
  FinRecurringRuleDto,
  FinShareDto,
  FinSharedBookDto,
  FinTransactionDto,
  FinTransactionType,
  FinTrendPointDto,
} from '@superapp/shared';
import type { FinRecurringRule } from '@prisma/client';

type Tx = Prisma.TransactionClient;

const MONEY_KINDS = new Set(['asset', 'liability']);
const CATEGORY_KINDS = new Set(['expense', 'income']);

/** Date-only column helpers: the API speaks YYYY-MM-DD strings, the DB stores @db.Date. */
const toDbDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
const fromDbDate = (d: Date): string => d.toISOString().slice(0, 10);
const todayStr = (): string => new Date().toISOString().slice(0, 10);

/** Audit snapshots go into Json columns — BigInt must be downgraded to number first. */
const jsonSafe = (o: unknown): Prisma.InputJsonValue | undefined =>
  o == null ? undefined : JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));

/**
 * «Финансы» — the managerial accounting book (B2C): an EDITABLE bookkeeping layer with a
 * double-entry STRUCTURE (Firefly III model — "everything is an account", a transaction is
 * a from→to pair). This is records ABOUT the outside world (наличные, карта Kaspi); the
 * wallet's immutable ledger (coins) stays a separate settlement layer and is only shown
 * here as a read-only projection (Phase 7). Every create/update/delete is audited.
 */
@Injectable()
export class FinancesService {
  private readonly logger = new Logger(FinancesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly contacts: ContactsService,
    private readonly notifications: NotificationsService,
    private readonly access: AccessService,
    private readonly events: EventBusService,
  ) {}

  // ============================================================
  // Book resolution (Phase 6 will extend this to shared books)
  // ============================================================

  /** The caller's own book, created lazily with the seed chart of accounts. */
  async getOrCreateBook(ownerType: 'user' | 'workspace', ownerId: string): Promise<FinBook> {
    const existing = await this.db.finBook.findUnique({
      where: { ownerType_ownerId: { ownerType, ownerId } },
    });
    if (existing) return existing;
    try {
      return await this.db.$transaction(async (tx) => {
        const book = await tx.finBook.create({ data: { ownerType, ownerId } });
        await this.seedBook(tx, book.id);
        return book;
      });
    } catch (e: unknown) {
      // Two first-opens racing: the unique (ownerType, ownerId) wins — reuse the winner.
      if ((e as { code?: string })?.code === 'P2002') {
        return this.db.finBook.findUniqueOrThrow({ where: { ownerType_ownerId: { ownerType, ownerId } } });
      }
      throw e;
    }
  }

  /**
   * Resolve the book the caller works with and assert the required right — the single
   * chokepoint of the module. Own book → owner; foreign book → core/access (`finbook`):
   * editor («ведёт вместе») may edit, viewer («смотрит») may read. Owner is code-side,
   * никогда не переезжает (PRD).
   */
  async resolveBook(userId: string, bookId: string | undefined, need: 'view' | 'edit'): Promise<FinBook & { myRole: FinBookRole }> {
    if (!bookId) {
      const own = await this.getOrCreateBook('user', userId);
      return { ...own, myRole: 'owner' };
    }
    const book = await this.db.finBook.findUnique({ where: { id: bookId } });
    if (!book) throw new NotFoundException('Финансовая книга не найдена');
    if (book.ownerType === 'user' && book.ownerId === userId) return { ...book, myRole: 'owner' };
    const principal = { type: 'user', id: userId };
    if (await this.access.can(principal, 'finbook.edit', book.id)) return { ...book, myRole: 'editor' };
    if (need === 'view' && (await this.access.can(principal, 'finbook.view', book.id))) {
      return { ...book, myRole: 'viewer' };
    }
    throw new ForbiddenException(
      need === 'edit' ? 'Нет права вести эту книгу (нужна роль «ведёт вместе»)' : 'Нет доступа к этой финансовой книге',
    );
  }

  /** Может ли зритель видеть книгу (для rich-card рендереров; Ф6 добавит finbook в core/access). */
  async canViewBook(viewerId: string, bookId: string): Promise<boolean> {
    try {
      await this.resolveBook(viewerId, bookId, 'view');
      return true;
    } catch {
      return false;
    }
  }

  /** Seed chart of accounts: Наличные + Карта, hidden equity peg, category tree. */
  private async seedBook(tx: Tx, bookId: string): Promise<void> {
    await tx.finAccount.createMany({
      data: FIN_SEED_ACCOUNTS.map((a, i) => ({
        bookId,
        kind: 'asset',
        subtype: a.subtype,
        name: a.name,
        icon: a.icon,
        currencyCode: FIN_DEFAULT_CURRENCY,
        sortOrder: i,
      })),
    });
    await tx.finAccount.create({
      data: { bookId, kind: 'equity', name: 'Начальный остаток', isSystem: true, currencyCode: FIN_DEFAULT_CURRENCY },
    });
    const seedTree = async (kind: 'expense' | 'income', seeds: typeof FIN_SEED_EXPENSE_CATEGORIES) => {
      let sort = 0;
      for (const seed of seeds) {
        const parent = await tx.finAccount.create({
          data: { bookId, kind, name: seed.name, icon: seed.icon, currencyCode: FIN_DEFAULT_CURRENCY, sortOrder: sort++ },
        });
        if (seed.children?.length) {
          await tx.finAccount.createMany({
            data: seed.children.map((c, i) => ({
              bookId,
              kind,
              parentId: parent.id,
              name: c.name,
              icon: c.icon,
              currencyCode: FIN_DEFAULT_CURRENCY,
              sortOrder: i,
            })),
          });
        }
      }
    };
    await seedTree('expense', FIN_SEED_EXPENSE_CATEGORIES);
    await seedTree('income', FIN_SEED_INCOME_CATEGORIES);
  }

  // ============================================================
  // Overview + balances
  // ============================================================

  async getOverview(userId: string, bookId?: string): Promise<FinBookOverviewDto> {
    const book = await this.resolveBook(userId, bookId, 'view');
    const accounts = await this.db.finAccount.findMany({
      where: { bookId: book.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const balances = await this.computeBalances(book.id);
    const money = accounts.filter((a) => MONEY_KINDS.has(a.kind));
    const categories = accounts.filter((a) => CATEGORY_KINDS.has(a.kind));
    return {
      book: { id: book.id, ownerType: book.ownerType as 'user' | 'workspace', ownerId: book.ownerId, name: book.name, myRole: book.myRole },
      accounts: money.map((a) => this.serializeAccount(a, balances.get(a.id) ?? 0n)),
      categories: categories.map((a) => this.serializeAccount(a, 0n)),
    };
  }

  /** Signed balances per account: Σ inflow (COALESCE(amount_to, amount)) − Σ outflow (amount). */
  private async computeBalances(bookId: string): Promise<Map<string, bigint>> {
    const inflows = await this.db.$queryRaw<{ id: string; total: bigint }[]>`
      SELECT to_account_id AS id, SUM(COALESCE(amount_to, amount))::bigint AS total
      FROM fin_transactions WHERE book_id = ${bookId} AND deleted_at IS NULL GROUP BY 1`;
    const outflows = await this.db.$queryRaw<{ id: string; total: bigint }[]>`
      SELECT from_account_id AS id, SUM(amount)::bigint AS total
      FROM fin_transactions WHERE book_id = ${bookId} AND deleted_at IS NULL GROUP BY 1`;
    const map = new Map<string, bigint>();
    for (const r of inflows) map.set(r.id, (map.get(r.id) ?? 0n) + BigInt(r.total));
    for (const r of outflows) map.set(r.id, (map.get(r.id) ?? 0n) - BigInt(r.total));
    return map;
  }

  private serializeAccount(a: FinAccount, balance: bigint): FinAccountDto {
    return {
      id: a.id,
      kind: a.kind as FinAccountDto['kind'],
      subtype: a.subtype,
      parentId: a.parentId,
      name: a.name,
      icon: a.icon,
      currencyCode: a.currencyCode,
      archived: a.archived,
      isSystem: a.isSystem,
      sortOrder: a.sortOrder,
      balance: Number(balance),
      debtTotal: a.debtTotal != null ? Number(a.debtTotal) : null,
      debtMonthly: a.debtMonthly != null ? Number(a.debtMonthly) : null,
      debtMonths: a.debtMonths,
      debtDueDay: a.debtDueDay,
    };
  }

  // ============================================================
  // Accounts (asset)
  // ============================================================

  async createAccount(
    userId: string,
    dto: { name: string; subtype: string; icon?: string; currencyCode?: string; openingBalance?: number },
    bookId?: string,
  ): Promise<FinAccountDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const moneyCount = await this.db.finAccount.count({ where: { bookId: book.id, kind: { in: ['asset', 'liability'] } } });
    if (moneyCount >= FIN_LIMITS.maxAccounts) throw new BadRequestException(`Не больше ${FIN_LIMITS.maxAccounts} счетов`);

    const account = await this.db.$transaction(async (tx) => {
      const created = await tx.finAccount.create({
        data: {
          bookId: book.id,
          kind: 'asset',
          subtype: dto.subtype,
          name: dto.name.trim(),
          icon: dto.icon ?? null,
          currencyCode: dto.currencyCode ?? FIN_DEFAULT_CURRENCY,
          sortOrder: moneyCount,
        },
      });
      if (dto.openingBalance && dto.openingBalance > 0) {
        await this.createOpeningTx(tx, book.id, created, dto.openingBalance, userId);
      }
      await this.audit(tx, book.id, 'account', created.id, userId, 'create', undefined, created);
      return created;
    });
    return this.serializeAccount(account, BigInt(dto.openingBalance ?? 0));
  }

  /** Opening balance = equity → asset (the double-entry way to "start with money"). */
  private async createOpeningTx(tx: Tx, bookId: string, account: FinAccount, amount: number, userId: string): Promise<void> {
    const equity = await tx.finAccount.findFirst({ where: { bookId, kind: 'equity' } });
    if (!equity) throw new ConflictException('Системный счёт «Начальный остаток» не найден');
    const row = await tx.finTransaction.create({
      data: {
        bookId,
        fromAccountId: equity.id,
        toAccountId: account.id,
        amount: BigInt(amount),
        currencyCode: account.currencyCode,
        occurredOn: toDbDate(todayStr()),
        note: 'Начальный остаток',
        createdById: userId,
        source: 'manual',
      },
    });
    // Начальный остаток — реальная проводка, влияющая на баланс: аудируем, как и
    // корректировку в setAccountBalance (контракт модуля «каждая проводка в журнале»).
    await this.audit(tx, bookId, 'transaction', row.id, userId, 'create', undefined, row);
  }

  /**
   * «У меня сейчас на счёте N» — Monefy-style balance adjust: writes an opening/adjusting
   * transaction (equity ↔ asset) for the delta, so history stays double-entry-honest.
   */
  async setAccountBalance(userId: string, accountId: string, target: number, bookId?: string): Promise<FinAccountDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const account = await this.db.finAccount.findFirst({ where: { id: accountId, bookId: book.id, kind: 'asset' } });
    if (!account) throw new NotFoundException('Счёт не найден');
    const balances = await this.computeBalances(book.id);
    const current = balances.get(account.id) ?? 0n;
    const delta = BigInt(target) - current;
    if (delta === 0n) return this.serializeAccount(account, current);
    const equity = await this.db.finAccount.findFirst({ where: { bookId: book.id, kind: 'equity' } });
    if (!equity) throw new ConflictException('Системный счёт «Начальный остаток» не найден');
    await this.db.$transaction(async (tx) => {
      const row = await tx.finTransaction.create({
        data: {
          bookId: book.id,
          fromAccountId: delta > 0n ? equity.id : account.id,
          toAccountId: delta > 0n ? account.id : equity.id,
          amount: delta > 0n ? delta : -delta,
          currencyCode: account.currencyCode,
          occurredOn: toDbDate(todayStr()),
          note: 'Корректировка остатка',
          createdById: userId,
          source: 'manual',
        },
      });
      await this.audit(tx, book.id, 'transaction', row.id, userId, 'create', undefined, row);
    });
    return this.serializeAccount(account, BigInt(target));
  }

  async updateAccount(
    userId: string,
    accountId: string,
    dto: { name?: string; icon?: string | null; archived?: boolean; sortOrder?: number },
    bookId?: string,
  ): Promise<FinAccountDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const account = await this.db.finAccount.findFirst({ where: { id: accountId, bookId: book.id, kind: { in: ['asset', 'liability'] } } });
    if (!account) throw new NotFoundException('Счёт не найден');
    if (account.isSystem) throw new BadRequestException('Системный счёт менять нельзя');
    const updated = await this.db.$transaction(async (tx) => {
      const row = await tx.finAccount.update({
        where: { id: account.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
          ...(dto.archived !== undefined ? { archived: dto.archived } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
      });
      await this.audit(tx, book.id, 'account', account.id, userId, 'update', account, row);
      return row;
    });
    const balances = await this.computeBalances(book.id);
    return this.serializeAccount(updated, balances.get(updated.id) ?? 0n);
  }

  /** Delete an account: with history → archive (books never lose data); empty → hard delete. */
  async deleteAccount(userId: string, accountId: string, bookId?: string): Promise<{ archived: boolean }> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const account = await this.db.finAccount.findFirst({ where: { id: accountId, bookId: book.id, kind: { in: ['asset', 'liability'] } } });
    if (!account) throw new NotFoundException('Счёт не найден');
    if (account.isSystem) throw new BadRequestException('Системный счёт удалить нельзя');
    return this.archiveOrDelete(book.id, account, userId);
  }

  // ============================================================
  // Categories (expense / income accounts, 2-level tree)
  // ============================================================

  async createCategory(
    userId: string,
    dto: { kind: 'expense' | 'income'; name: string; icon?: string; parentId?: string },
    bookId?: string,
  ): Promise<FinAccountDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const count = await this.db.finAccount.count({ where: { bookId: book.id, kind: { in: ['expense', 'income'] } } });
    if (count >= FIN_LIMITS.maxCategories) throw new BadRequestException(`Не больше ${FIN_LIMITS.maxCategories} категорий`);
    if (dto.parentId) await this.assertValidParent(book.id, dto.kind, dto.parentId);

    const created = await this.db.$transaction(async (tx) => {
      const row = await tx.finAccount.create({
        data: {
          bookId: book.id,
          kind: dto.kind,
          parentId: dto.parentId ?? null,
          name: dto.name.trim(),
          icon: dto.icon ?? null,
          currencyCode: FIN_DEFAULT_CURRENCY,
          sortOrder: count,
        },
      });
      await this.audit(tx, book.id, 'account', row.id, userId, 'create', undefined, row);
      return row;
    });
    return this.serializeAccount(created, 0n);
  }

  private async assertValidParent(bookId: string, kind: string, parentId: string): Promise<FinAccount> {
    const parent = await this.db.finAccount.findFirst({ where: { id: parentId, bookId } });
    if (!parent || parent.kind !== kind) throw new BadRequestException('Родительская категория не найдена');
    if (parent.parentId) throw new BadRequestException('Категории вкладываются максимум на два уровня');
    return parent;
  }

  async updateCategory(
    userId: string,
    categoryId: string,
    dto: { name?: string; icon?: string | null; archived?: boolean; sortOrder?: number; parentId?: string | null },
    bookId?: string,
  ): Promise<FinAccountDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const category = await this.db.finAccount.findFirst({ where: { id: categoryId, bookId: book.id, kind: { in: ['expense', 'income'] } } });
    if (!category) throw new NotFoundException('Категория не найдена');
    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === category.id) throw new BadRequestException('Категория не может быть родителем себя');
      const childrenCount = await this.db.finAccount.count({ where: { parentId: category.id } });
      if (childrenCount > 0) throw new ConflictException('У категории есть подкатегории — сначала перенесите их');
      await this.assertValidParent(book.id, category.kind, dto.parentId);
    }
    const updated = await this.db.$transaction(async (tx) => {
      const row = await tx.finAccount.update({
        where: { id: category.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
          ...(dto.archived !== undefined ? { archived: dto.archived } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
        },
      });
      await this.audit(tx, book.id, 'account', category.id, userId, 'update', category, row);
      return row;
    });
    return this.serializeAccount(updated, 0n);
  }

  async deleteCategory(userId: string, categoryId: string, bookId?: string): Promise<{ archived: boolean }> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const category = await this.db.finAccount.findFirst({ where: { id: categoryId, bookId: book.id, kind: { in: ['expense', 'income'] } } });
    if (!category) throw new NotFoundException('Категория не найдена');
    const childrenCount = await this.db.finAccount.count({ where: { parentId: category.id } });
    if (childrenCount > 0) throw new ConflictException('У категории есть подкатегории — сначала удалите или перенесите их');
    return this.archiveOrDelete(book.id, category, userId);
  }

  /** Shared tail for accounts & categories: rows with history are archived, empty rows die. */
  private async archiveOrDelete(bookId: string, account: FinAccount, userId: string): Promise<{ archived: boolean }> {
    const txCount = await this.db.finTransaction.count({
      where: { OR: [{ fromAccountId: account.id }, { toAccountId: account.id }] },
    });
    if (txCount > 0) {
      await this.db.$transaction(async (tx) => {
        const row = await tx.finAccount.update({ where: { id: account.id }, data: { archived: true } });
        await this.audit(tx, bookId, 'account', account.id, userId, 'update', account, row);
      });
      return { archived: true };
    }
    await this.db.$transaction(async (tx) => {
      await tx.finBudget.deleteMany({ where: { categoryAccountId: account.id } });
      // FinRecurringRule ссылается на счёт голыми строками (без FK): без явной чистки
      // повтор с удалённым from/toAccountId остаётся, крон вечно падает на loadPair и шлёт
      // владельцу «пора записать» по несуществующему счёту.
      await tx.finRecurringRule.deleteMany({
        where: { bookId, OR: [{ fromAccountId: account.id }, { toAccountId: account.id }] },
      });
      await tx.finAccount.delete({ where: { id: account.id } });
      await this.audit(tx, bookId, 'account', account.id, userId, 'delete', account, undefined);
    });
    return { archived: false };
  }

  // ============================================================
  // Transactions
  // ============================================================

  /** The allowed from→to kind pairs and the derived display type. */
  private derivePairType(fromKind: string, toKind: string): FinTransactionType {
    if ((fromKind === 'asset' || fromKind === 'liability') && toKind === 'expense') return 'expense';
    if (fromKind === 'income' && toKind === 'asset') return 'income';
    if (fromKind === 'asset' && toKind === 'asset') return 'transfer';
    if (fromKind === 'asset' && toKind === 'liability') return 'debt_payment';
    if (fromKind === 'liability' && toKind === 'asset') return 'debt_draw';
    if ((fromKind === 'equity' && toKind === 'asset') || (fromKind === 'asset' && toKind === 'equity')) return 'opening';
    throw new BadRequestException('Недопустимая пара счетов для операции');
  }

  /**
   * Currency semantics: amount lives in the money-side currency (from for expense/transfer,
   * to for income). amountTo exists ONLY for cross-currency money→money moves (обмен: «снял
   * 100$ → получил 52 000₸» — two sums, no FX rates in v1).
   */
  private resolveCurrency(
    from: FinAccount,
    to: FinAccount,
    amountTo: number | null | undefined,
  ): { currencyCode: string; amountTo: bigint | null } {
    const moneyFrom = MONEY_KINDS.has(from.kind);
    const moneyTo = MONEY_KINDS.has(to.kind);
    if (moneyFrom && moneyTo && from.currencyCode !== to.currencyCode) {
      if (amountTo == null) throw new BadRequestException('Для обмена валют укажите сумму зачисления (amountTo)');
      return { currencyCode: from.currencyCode, amountTo: BigInt(amountTo) };
    }
    if (amountTo != null) throw new BadRequestException('amountTo указывается только при обмене валют');
    return { currencyCode: moneyFrom ? from.currencyCode : to.currencyCode, amountTo: null };
  }

  private async loadPair(
    bookId: string,
    fromId: string,
    toId: string,
    rejectArchived = false,
  ): Promise<{ from: FinAccount; to: FinAccount }> {
    if (fromId === toId) throw new BadRequestException('Счета операции должны различаться');
    const rows = await this.db.finAccount.findMany({ where: { id: { in: [fromId, toId] }, bookId } });
    const from = rows.find((r) => r.id === fromId);
    const to = rows.find((r) => r.id === toId);
    if (!from || !to) throw new NotFoundException('Счёт операции не найден в этой книге');
    if (from.kind === 'equity' || to.kind === 'equity') {
      throw new BadRequestException('Начальный остаток задаётся при создании счёта, вручную он не редактируется');
    }
    // На СОЗДАНИИ новой операции архивный счёт/категорию не оживляем (иначе скрытый счёт
    // получает ненулевой баланс). На ПРАВКЕ существующей операции архив допустим — иначе
    // нельзя исправить историческую операцию по счёту, который потом архивировали.
    if (rejectArchived && (from.archived || to.archived)) {
      throw new BadRequestException('Нельзя записать операцию на архивный счёт или категорию');
    }
    return { from, to };
  }

  /**
   * «На кого / от кого»: ссылка на человека, имя снимком. «На себя» всегда разрешено
   * (personUserId === записывающего) — assertReachable пропускается, т.к. сам себя в
   * окружении не держишь; остальных проверяем на достижимость из окружения.
   */
  private async resolvePerson(userId: string, personUserId: string): Promise<{ id: string; name: string }> {
    if (personUserId !== userId) {
      await this.contacts.assertReachable(userId, [personUserId], 'Этого человека нет в вашем окружении');
    }
    const person = await this.db.user.findUnique({
      where: { id: personUserId },
      select: { firstName: true, lastName: true },
    });
    if (!person) throw new BadRequestException('Пользователь не найден');
    return { id: personUserId, name: `${person.firstName} ${person.lastName ?? ''}`.trim() };
  }

  async createTransaction(
    userId: string,
    dto: {
      fromAccountId: string;
      toAccountId: string;
      amount: number;
      amountTo?: number;
      occurredOn?: string;
      note?: string;
      personUserId?: string;
      source?: string;
      recurringRuleId?: string;
    },
    bookId?: string,
  ): Promise<FinTransactionDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const { from, to } = await this.loadPair(book.id, dto.fromAccountId, dto.toAccountId, true);
    this.derivePairType(from.kind, to.kind);
    const { currencyCode, amountTo } = this.resolveCurrency(from, to, dto.amountTo);
    const person = dto.personUserId ? await this.resolvePerson(userId, dto.personUserId) : null;

    const created = await this.db.$transaction(async (tx) => {
      const row = await tx.finTransaction.create({
        data: {
          bookId: book.id,
          fromAccountId: from.id,
          toAccountId: to.id,
          amount: BigInt(dto.amount),
          amountTo,
          currencyCode,
          occurredOn: toDbDate(dto.occurredOn ?? todayStr()),
          note: dto.note?.trim() || null,
          personUserId: person?.id ?? null,
          personName: person?.name ?? null,
          createdById: userId,
          source: dto.source ?? 'manual',
          recurringRuleId: dto.recurringRuleId ?? null,
        },
      });
      await this.audit(tx, book.id, 'transaction', row.id, userId, 'create', undefined, row);
      return row;
    });
    // План-факт: пороги 80% / 100% проверяются ПОСЛЕ коммита, синхронно (детерминизм:
    // fire-and-forget гонялся бы с быстрыми последовательными тратами); сбой уведомления
    // не роняет запись операции.
    if (to.kind === 'expense') {
      try {
        await this.checkBudgetThresholds(book, to, created);
      } catch (e) {
        this.logger.warn(`budget threshold check failed: ${(e as Error)?.message ?? e}`);
      }
    }
    // Ф8: сайд-эффект для процессов («при расходе > X — согласование») — не деньги, шина уместна.
    // `source` в payload обязателен: анти-runaway-гвард ProcessTriggerRouter отсекает
    // события, порождённые самим движком процессов (source='process'), — иначе нода
    // «Финансы: записать» + триггер «Записана операция» = бесконечная петля.
    this.events.emit(
      'finance.transaction.created',
      {
        bookId: book.id,
        ownerType: book.ownerType,
        ownerId: book.ownerId,
        ...(book.ownerType === 'workspace' ? { workspaceId: book.ownerId } : {}),
        transactionId: created.id,
        txType: this.derivePairType(from.kind, to.kind),
        amount: Number(created.amount),
        currencyCode: created.currencyCode,
        source: created.source,
      },
      'finances',
    );
    return this.serializeTx(created, new Map([[from.id, from.kind], [to.id, to.kind]]));
  }

  async updateTransaction(
    userId: string,
    txId: string,
    dto: {
      fromAccountId?: string;
      toAccountId?: string;
      amount?: number;
      amountTo?: number | null;
      occurredOn?: string;
      note?: string | null;
      personUserId?: string | null;
    },
    bookId?: string,
  ): Promise<FinTransactionDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const existing = await this.db.finTransaction.findFirst({ where: { id: txId, bookId: book.id, deletedAt: null } });
    if (!existing) throw new NotFoundException('Операция не найдена');

    const fromId = dto.fromAccountId ?? existing.fromAccountId;
    const toId = dto.toAccountId ?? existing.toAccountId;
    // Правка исторической операции: архивный счёт допустим (rejectArchived=false).
    const { from, to } = await this.loadPair(book.id, fromId, toId);
    this.derivePairType(from.kind, to.kind);

    // Кросс-валютная пара: если меняют СУММУ обмена, но не прислали новую сумму зачисления —
    // старый amountTo стал бы несогласован с новым amount (нога назначения по старому курсу).
    const crossCurrency = MONEY_KINDS.has(from.kind) && MONEY_KINDS.has(to.kind) && from.currencyCode !== to.currencyCode;
    if (crossCurrency && dto.amount !== undefined && dto.amountTo === undefined) {
      throw new BadRequestException('При изменении суммы обмена укажите и сумму зачисления (amountTo)');
    }
    const effectiveAmountTo =
      dto.amountTo !== undefined ? dto.amountTo : crossCurrency ? (existing.amountTo != null ? Number(existing.amountTo) : null) : null;
    const { currencyCode, amountTo } = this.resolveCurrency(from, to, effectiveAmountTo);

    let personId = existing.personUserId;
    let personName = existing.personName;
    if (dto.personUserId !== undefined) {
      if (dto.personUserId === null) {
        personId = null;
        personName = null;
      } else {
        const person = await this.resolvePerson(userId, dto.personUserId);
        personId = person.id;
        personName = person.name;
      }
    }

    const updated = await this.db.$transaction(async (tx) => {
      const row = await tx.finTransaction.update({
        where: { id: existing.id },
        data: {
          fromAccountId: from.id,
          toAccountId: to.id,
          amount: dto.amount !== undefined ? BigInt(dto.amount) : existing.amount,
          amountTo,
          currencyCode,
          occurredOn: dto.occurredOn !== undefined ? toDbDate(dto.occurredOn) : existing.occurredOn,
          note: dto.note !== undefined ? (dto.note?.trim() || null) : existing.note,
          personUserId: personId,
          personName,
        },
      });
      await this.audit(tx, book.id, 'transaction', row.id, userId, 'update', existing, row);
      return row;
    });
    // План-факт: правка (напр. сумма вверх) может пробить лимит — перепроверяем пороги, как в
    // createTransaction. Проверяем и НОВУЮ категорию, и СТАРУЮ (если сменилась/поменялся период),
    // чтобы алерт 80/100% не потерялся ни на одном пути изменения.
    const affected = new Map<string, { acc: FinAccount; row: FinTransaction }>();
    if (to.kind === 'expense') affected.set(`${to.id}:${fromDbDate(updated.occurredOn)}`, { acc: to, row: updated });
    if (existing.toAccountId !== to.id || !existing.occurredOn || fromDbDate(existing.occurredOn) !== fromDbDate(updated.occurredOn)) {
      const oldTo = await this.db.finAccount.findUnique({ where: { id: existing.toAccountId } });
      if (oldTo && oldTo.kind === 'expense') {
        // старая категория/период — используем СТАРУЮ строку (сумма/дата) как «сдвиг вниз» уже
        // применён удалением старой суммы; порог мог как раз пересечься в другую сторону — но
        // нам важно не пропустить рост в НОВОЙ; для старой достаточно новой строки-«состояния».
        affected.set(`${oldTo.id}:${fromDbDate(updated.occurredOn)}`, { acc: oldTo, row: updated });
      }
    }
    for (const { acc, row } of affected.values()) {
      try {
        await this.checkBudgetThresholds(book, acc, row);
      } catch (e) {
        this.logger.warn(`budget threshold check (update) failed: ${(e as Error)?.message ?? e}`);
      }
    }
    return this.serializeTx(updated, new Map([[from.id, from.kind], [to.id, to.kind]]));
  }

  async deleteTransaction(userId: string, txId: string, bookId?: string): Promise<{ success: true }> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const existing = await this.db.finTransaction.findFirst({ where: { id: txId, bookId: book.id, deletedAt: null } });
    if (!existing) throw new NotFoundException('Операция не найдена');
    await this.db.$transaction(async (tx) => {
      await tx.finTransaction.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
      await this.audit(tx, book.id, 'transaction', existing.id, userId, 'delete', existing, undefined);
    });
    return { success: true };
  }

  async listTransactions(
    userId: string,
    query: {
      bookId?: string;
      from?: string;
      to?: string;
      accountId?: string;
      categoryId?: string;
      personUserId?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<FinListTransactionsResult> {
    const book = await this.resolveBook(userId, query.bookId, 'view');
    const limit = query.limit ?? FIN_LIMITS.transactionsPageSize;

    const and: Prisma.FinTransactionWhereInput[] = [];
    if (query.from) and.push({ occurredOn: { gte: toDbDate(query.from) } });
    if (query.to) and.push({ occurredOn: { lte: toDbDate(query.to) } });
    if (query.accountId) and.push({ OR: [{ fromAccountId: query.accountId }, { toAccountId: query.accountId }] });
    if (query.categoryId) {
      // A parent category includes its children's transactions.
      const children = await this.db.finAccount.findMany({ where: { bookId: book.id, parentId: query.categoryId }, select: { id: true } });
      const ids = [query.categoryId, ...children.map((c) => c.id)];
      and.push({ OR: [{ fromAccountId: { in: ids } }, { toAccountId: { in: ids } }] });
    }
    if (query.personUserId) and.push({ personUserId: query.personUserId });

    const rows = await this.db.finTransaction.findMany({
      where: { bookId: book.id, deletedAt: null, ...(and.length ? { AND: and } : {}) },
      orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? page[page.length - 1].id : null;

    const kinds = await this.accountKinds(book.id);
    // Автор записи (для общих книг — «кто внёс»): имена батчем.
    const authorIds = [...new Set(page.map((t) => t.createdById))];
    const authors = authorIds.length
      ? await this.db.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const authorName = new Map(authors.map((a) => [a.id, `${a.firstName} ${a.lastName ?? ''}`.trim()]));
    return {
      items: page.map((t) => ({ ...this.serializeTx(t, kinds), createdByName: authorName.get(t.createdById) ?? null })),
      nextCursor,
    };
  }

  private async accountKinds(bookId: string): Promise<Map<string, string>> {
    const accounts = await this.db.finAccount.findMany({ where: { bookId }, select: { id: true, kind: true } });
    return new Map(accounts.map((a) => [a.id, a.kind]));
  }

  private serializeTx(t: FinTransaction, kinds: Map<string, string>): FinTransactionDto {
    const fromKind = kinds.get(t.fromAccountId) ?? 'asset';
    const toKind = kinds.get(t.toAccountId) ?? 'asset';
    let type: FinTransactionType;
    try {
      type = this.derivePairType(fromKind, toKind);
    } catch {
      type = 'transfer';
    }
    return {
      id: t.id,
      bookId: t.bookId,
      type,
      fromAccountId: t.fromAccountId,
      toAccountId: t.toAccountId,
      amount: Number(t.amount),
      amountTo: t.amountTo != null ? Number(t.amountTo) : null,
      currencyCode: t.currencyCode,
      occurredOn: fromDbDate(t.occurredOn),
      note: t.note,
      personUserId: t.personUserId,
      personName: t.personName,
      createdById: t.createdById,
      source: t.source as FinTransactionDto['source'],
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  // ============================================================
  // План-факт: лимиты + отчёты (Phase 2)
  // ============================================================

  private periodRange(period: string): { start: Date; end: Date } {
    const [y, m] = period.split('-').map(Number);
    return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
  }

  private formatMoneyHuman(minor: bigint | number, code: string): string {
    const symbols: Record<string, string> = { KZT: '₸', USD: '$', EUR: '€', RUB: '₽' };
    const major = Number(minor) / 100;
    return `${major.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${symbols[code] ?? code}`;
  }

  /** PUT semantics: amount=null удаляет лимит. Лимиты — только на категории расходов. */
  async upsertBudget(
    userId: string,
    dto: { period: string; categoryAccountId: string; amount: number | null; currencyCode?: string },
    bookId?: string,
  ): Promise<{ deleted: boolean } | FinBudgetDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const category = await this.db.finAccount.findFirst({
      where: { id: dto.categoryAccountId, bookId: book.id, kind: 'expense', archived: false },
    });
    if (!category) throw new NotFoundException('Категория расходов не найдена');

    const where = {
      bookId_categoryAccountId_period: { bookId: book.id, categoryAccountId: category.id, period: dto.period },
    };
    if (dto.amount === null) {
      const existing = await this.db.finBudget.findUnique({ where });
      if (existing) {
        await this.db.$transaction(async (tx) => {
          await tx.finBudget.delete({ where });
          await this.audit(tx, book.id, 'budget', existing.id, userId, 'delete', existing, undefined);
        });
      }
      return { deleted: true };
    }
    const row = await this.db.$transaction(async (tx) => {
      const before = await tx.finBudget.findUnique({ where });
      // На update без явной валюты сохраняем СТАРУЮ (иначе USD-лимит молча становится
      // KZT-лимитом и все USD-траты выпадают из плана-факта); на create — dto ?? KZT.
      const currencyCode = dto.currencyCode ?? before?.currencyCode ?? 'KZT';
      const saved = await tx.finBudget.upsert({
        where,
        create: {
          bookId: book.id,
          categoryAccountId: category.id,
          period: dto.period,
          amount: BigInt(dto.amount as number),
          currencyCode,
        },
        update: { amount: BigInt(dto.amount as number), currencyCode },
      });
      await this.audit(tx, book.id, 'budget', saved.id, userId, before ? 'update' : 'create', before ?? undefined, saved);
      return saved;
    });
    const spent = await this.spentForCategory(book.id, category.id, row.currencyCode, dto.period);
    return {
      id: row.id,
      categoryAccountId: row.categoryAccountId,
      period: row.period,
      amount: Number(row.amount),
      currencyCode: row.currencyCode,
      spent: Number(spent),
    };
  }

  /** Fact for a category (its own + subcategories) in one currency for one month. */
  private async spentForCategory(bookId: string, categoryId: string, currencyCode: string, period: string): Promise<bigint> {
    const { start, end } = this.periodRange(period);
    const children = await this.db.finAccount.findMany({ where: { bookId, parentId: categoryId }, select: { id: true } });
    const ids = [categoryId, ...children.map((c) => c.id)];
    const rows = await this.db.$queryRaw<{ total: bigint | null }[]>`
      SELECT SUM(amount)::bigint AS total FROM fin_transactions
      WHERE book_id = ${bookId} AND deleted_at IS NULL AND currency_code = ${currencyCode}
        AND to_account_id = ANY(${ids}) AND occurred_on >= ${start} AND occurred_on < ${end}`;
    return rows[0]?.total != null ? BigInt(rows[0].total) : 0n;
  }

  async getMonthReport(userId: string, period: string, bookId?: string): Promise<FinMonthReportDto> {
    const book = await this.resolveBook(userId, bookId, 'view');
    const { start, end } = this.periodRange(period);

    const expenseRows = await this.db.$queryRaw<{ id: string; code: string; total: bigint }[]>`
      SELECT t.to_account_id AS id, t.currency_code AS code, SUM(t.amount)::bigint AS total
      FROM fin_transactions t JOIN fin_accounts a ON a.id = t.to_account_id
      WHERE t.book_id = ${book.id} AND t.deleted_at IS NULL AND a.kind = 'expense'
        AND t.occurred_on >= ${start} AND t.occurred_on < ${end}
      GROUP BY 1, 2`;
    const incomeRows = await this.db.$queryRaw<{ id: string; code: string; total: bigint }[]>`
      SELECT t.from_account_id AS id, t.currency_code AS code, SUM(t.amount)::bigint AS total
      FROM fin_transactions t JOIN fin_accounts a ON a.id = t.from_account_id
      WHERE t.book_id = ${book.id} AND t.deleted_at IS NULL AND a.kind = 'income'
        AND t.occurred_on >= ${start} AND t.occurred_on < ${end}
      GROUP BY 1, 2`;
    const debtRows = await this.db.$queryRaw<{ code: string; total: bigint }[]>`
      SELECT t.currency_code AS code, SUM(t.amount)::bigint AS total
      FROM fin_transactions t
        JOIN fin_accounts af ON af.id = t.from_account_id
        JOIN fin_accounts at ON at.id = t.to_account_id
      WHERE t.book_id = ${book.id} AND t.deleted_at IS NULL
        AND af.kind = 'asset' AND at.kind = 'liability'
        AND t.occurred_on >= ${start} AND t.occurred_on < ${end}
      GROUP BY 1`;

    const toSpend = (rows: { id: string; code: string; total: bigint }[]): FinCategorySpendDto[] =>
      rows.map((r) => ({ categoryId: r.id, currencyCode: r.code, amount: Number(r.total) }));
    const totals = (rows: { code: string; total: bigint }[] | { id: string; code: string; total: bigint }[]): FinMoneySumDto[] => {
      const map = new Map<string, number>();
      for (const r of rows as { code: string; total: bigint }[]) map.set(r.code, (map.get(r.code) ?? 0) + Number(r.total));
      return [...map.entries()].map(([currencyCode, amount]) => ({ currencyCode, amount }));
    };

    // Budgets + fact (category + its children, budget currency).
    const budgets = await this.db.finBudget.findMany({ where: { bookId: book.id, period } });
    const childrenMap = new Map<string, string[]>();
    if (budgets.length) {
      const cats = await this.db.finAccount.findMany({ where: { bookId: book.id, kind: 'expense' }, select: { id: true, parentId: true } });
      for (const c of cats) {
        if (!c.parentId) continue;
        childrenMap.set(c.parentId, [...(childrenMap.get(c.parentId) ?? []), c.id]);
      }
    }
    const expenseByKey = new Map<string, number>();
    for (const r of expenseRows) expenseByKey.set(`${r.id}:${r.code}`, Number(r.total));
    const budgetDtos: FinBudgetDto[] = budgets.map((b) => {
      const scope = [b.categoryAccountId, ...(childrenMap.get(b.categoryAccountId) ?? [])];
      const spent = scope.reduce((sum, id) => sum + (expenseByKey.get(`${id}:${b.currencyCode}`) ?? 0), 0);
      return {
        id: b.id,
        categoryAccountId: b.categoryAccountId,
        period: b.period,
        amount: Number(b.amount),
        currencyCode: b.currencyCode,
        spent,
      };
    });

    return {
      period,
      expenseByCategory: toSpend(expenseRows),
      incomeByCategory: toSpend(incomeRows),
      debtPayments: debtRows.map((r) => ({ currencyCode: r.code, amount: Number(r.total) })),
      totalExpense: totals(expenseRows),
      totalIncome: totals(incomeRows),
      budgets: budgetDtos,
    };
  }

  async getTrend(userId: string, months: number, bookId?: string): Promise<FinTrendPointDto[]> {
    const book = await this.resolveBook(userId, bookId, 'view');
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
    const expenseRows = await this.db.$queryRaw<{ period: string; code: string; total: bigint }[]>`
      SELECT to_char(t.occurred_on, 'YYYY-MM') AS period, t.currency_code AS code, SUM(t.amount)::bigint AS total
      FROM fin_transactions t JOIN fin_accounts a ON a.id = t.to_account_id
      WHERE t.book_id = ${book.id} AND t.deleted_at IS NULL AND a.kind = 'expense' AND t.occurred_on >= ${start}
      GROUP BY 1, 2`;
    const incomeRows = await this.db.$queryRaw<{ period: string; code: string; total: bigint }[]>`
      SELECT to_char(t.occurred_on, 'YYYY-MM') AS period, t.currency_code AS code, SUM(t.amount)::bigint AS total
      FROM fin_transactions t JOIN fin_accounts a ON a.id = t.from_account_id
      WHERE t.book_id = ${book.id} AND t.deleted_at IS NULL AND a.kind = 'income' AND t.occurred_on >= ${start}
      GROUP BY 1, 2`;

    const points: FinTrendPointDto[] = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      const period = d.toISOString().slice(0, 7);
      points.push({
        period,
        expense: expenseRows.filter((r) => r.period === period).map((r) => ({ currencyCode: r.code, amount: Number(r.total) })),
        income: incomeRows.filter((r) => r.period === period).map((r) => ({ currencyCode: r.code, amount: Number(r.total) })),
      });
    }
    return points;
  }

  /**
   * Пороговые уведомления план-факта: если ИМЕННО ЭТА операция пересекла 80% или 100%
   * лимита категории (или её родителя) — владелец книги получает уведомление.
   */
  private async checkBudgetThresholds(book: FinBook, category: FinAccount, tx: FinTransaction): Promise<void> {
    if (book.ownerType !== 'user') return; // org books: уведомления решим вместе с B2B-UI
    const period = fromDbDate(tx.occurredOn).slice(0, 7);
    const affectedIds = [category.id, ...(category.parentId ? [category.parentId] : [])];
    const budgets = await this.db.finBudget.findMany({
      where: { bookId: book.id, period, categoryAccountId: { in: affectedIds }, currencyCode: tx.currencyCode },
    });
    if (!budgets.length) return;
    const cats = await this.db.finAccount.findMany({
      where: { id: { in: budgets.map((b) => b.categoryAccountId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(cats.map((c) => [c.id, c.name]));
    const periodLabel = new Date(`${period}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

    for (const budget of budgets) {
      const spentAfter = await this.spentForCategory(book.id, budget.categoryAccountId, budget.currencyCode, period);
      const spentBefore = spentAfter - tx.amount;
      const limit = budget.amount;
      const crossed = (thresholdNum: bigint, thresholdDen: bigint) =>
        spentBefore * thresholdDen < limit * thresholdNum && spentAfter * thresholdDen >= limit * thresholdNum;
      const payload = {
        categoryName: nameById.get(budget.categoryAccountId) ?? 'Категория',
        spent: this.formatMoneyHuman(spentAfter, budget.currencyCode),
        limit: this.formatMoneyHuman(limit, budget.currencyCode),
        periodLabel,
        bookId: book.id,
        categoryAccountId: budget.categoryAccountId,
        period,
      };
      if (crossed(1n, 1n)) {
        await this.notifications.notify(book.ownerId, 'finance.budget.exceeded', payload, { actionUrl: '/finance' });
      } else if (crossed(4n, 5n)) {
        await this.notifications.notify(book.ownerId, 'finance.budget.warning', payload, { actionUrl: '/finance' });
      }
    }
  }

  // ============================================================
  // «Близкие» + отчёт по людям (Phase 3)
  // ============================================================

  /** The curated quick-pick list; names/avatars are read live from users. */
  async listPeople(userId: string, bookId?: string): Promise<FinPersonDto[]> {
    const book = await this.resolveBook(userId, bookId, 'view');
    const rows = await this.db.finPerson.findMany({
      where: { bookId: book.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    if (!rows.length) return [];
    const users = await this.db.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => {
      const u = byId.get(r.userId);
      return {
        userId: r.userId,
        name: u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : r.name,
        avatar: u?.avatar ?? null,
      };
    });
  }

  async addPerson(userId: string, personUserId: string, bookId?: string): Promise<FinPersonDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const count = await this.db.finPerson.count({ where: { bookId: book.id } });
    if (count >= FIN_LIMITS.maxPeople) throw new BadRequestException(`Не больше ${FIN_LIMITS.maxPeople} близких`);
    const person = await this.resolvePerson(userId, personUserId);
    try {
      await this.db.finPerson.create({ data: { bookId: book.id, userId: person.id, name: person.name, sortOrder: count } });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code !== 'P2002') throw e; // уже в списке — идемпотентно
    }
    const u = await this.db.user.findUnique({ where: { id: person.id }, select: { avatar: true } });
    return { userId: person.id, name: person.name, avatar: u?.avatar ?? null };
  }

  async removePerson(userId: string, personUserId: string, bookId?: string): Promise<{ success: true }> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    await this.db.finPerson.deleteMany({ where: { bookId: book.id, userId: personUserId } });
    return { success: true };
  }

  /** «На кого трачу / от кого получаю» — the analytics dimension nobody else has. */
  async getPeopleReport(
    userId: string,
    query: { from?: string; to?: string },
    bookId?: string,
  ): Promise<FinPeopleReportRowDto[]> {
    const book = await this.resolveBook(userId, bookId, 'view');
    const range: Prisma.FinTransactionWhereInput = {
      bookId: book.id,
      deletedAt: null,
      personUserId: { not: null },
      ...(query.from || query.to
        ? {
            occurredOn: {
              ...(query.from ? { gte: toDbDate(query.from) } : {}),
              ...(query.to ? { lte: toDbDate(query.to) } : {}),
            },
          }
        : {}),
    };
    const spent = await this.db.finTransaction.groupBy({
      by: ['personUserId', 'currencyCode'],
      where: { ...range, toAccount: { kind: 'expense' } },
      _sum: { amount: true },
    });
    const received = await this.db.finTransaction.groupBy({
      by: ['personUserId', 'currencyCode'],
      where: { ...range, fromAccount: { kind: 'income' } },
      _sum: { amount: true },
    });

    const ids = [...new Set([...spent, ...received].map((r) => r.personUserId as string))];
    if (!ids.length) return [];
    const users = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    const snapshots = await this.db.finPerson.findMany({ where: { bookId: book.id, userId: { in: ids } } });
    const snapshotById = new Map(snapshots.map((s) => [s.userId, s.name]));

    const rows = new Map<string, FinPeopleReportRowDto>();
    const rowFor = (id: string): FinPeopleReportRowDto => {
      let row = rows.get(id);
      if (!row) {
        const u = userById.get(id);
        row = {
          userId: id,
          name: u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : snapshotById.get(id) ?? 'Пользователь',
          avatar: u?.avatar ?? null,
          spent: [],
          received: [],
        };
        rows.set(id, row);
      }
      return row;
    };
    for (const r of spent) {
      rowFor(r.personUserId as string).spent.push({ currencyCode: r.currencyCode, amount: Number(r._sum.amount ?? 0n) });
    }
    for (const r of received) {
      rowFor(r.personUserId as string).received.push({ currencyCode: r.currencyCode, amount: Number(r._sum.amount ?? 0n) });
    }
    // Сортировка: кто «дороже» всего (по первой валюте трат)
    return [...rows.values()].sort((a, b) => (b.spent[0]?.amount ?? 0) - (a.spent[0]?.amount ?? 0));
  }

  // ============================================================
  // Шеринг книги (Phase 6): «смотрит» / «ведёт вместе», люди и Группы
  // ============================================================

  /** Owner-only гейт для управления доступом. */
  private async requireOwnBook(userId: string, bookId?: string): Promise<FinBook> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    if (book.myRole !== 'owner') throw new ForbiddenException('Доступом управляет только владелец книги');
    return book;
  }

  async listShares(userId: string, bookId?: string): Promise<FinShareDto[]> {
    const book = await this.requireOwnBook(userId, bookId);
    const tuples = await this.db.relationTuple.findMany({
      where: { resourceType: 'finbook', resourceId: book.id, relation: { in: ['viewer', 'editor'] } },
      orderBy: { createdAt: 'asc' },
    });
    const userIds = tuples.filter((t) => t.subjectType === 'user').map((t) => t.subjectId);
    const circleIds = tuples.filter((t) => t.subjectType === 'circle').map((t) => t.subjectId);
    const [users, circles] = await Promise.all([
      userIds.length
        ? this.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true, avatar: true } })
        : Promise.resolve([]),
      circleIds.length
        ? this.db.circle.findMany({ where: { id: { in: circleIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const circleById = new Map(circles.map((c) => [c.id, c]));
    return tuples.map((t) => {
      const u = t.subjectType === 'user' ? userById.get(t.subjectId) : null;
      return {
        principalType: t.subjectType as 'user' | 'circle',
        principalId: t.subjectId,
        role: t.relation as 'viewer' | 'editor',
        name: u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : circleById.get(t.subjectId)?.name ?? null,
        avatar: u?.avatar ?? null,
      };
    });
  }

  async addShare(
    userId: string,
    dto: { principalType: 'user' | 'circle'; principalId: string; role: 'viewer' | 'editor' },
    bookId?: string,
  ): Promise<FinShareDto[]> {
    const book = await this.requireOwnBook(userId, bookId);
    if (dto.principalType === 'user') {
      if (dto.principalId === userId) throw new BadRequestException('Себе доступ не нужен — это ваша книга');
      await this.contacts.assertReachable(userId, [dto.principalId], 'Делиться финансами можно только с людьми из окружения');
    } else {
      const circle = await this.db.circle.findFirst({ where: { id: dto.principalId, ownerId: userId } });
      if (!circle) throw new NotFoundException('Группа не найдена');
    }
    const subjectRelation = dto.principalType === 'circle' ? 'member' : undefined;
    // Одна роль на принципала: снимаем обе, ставим нужную.
    for (const relation of ['viewer', 'editor'] as const) {
      await this.access.revoke({
        resourceType: 'finbook',
        resourceId: book.id,
        relation,
        subjectType: dto.principalType,
        subjectId: dto.principalId,
        ...(subjectRelation ? { subjectRelation } : {}),
      });
    }
    await this.access.grant({
      resourceType: 'finbook',
      resourceId: book.id,
      relation: dto.role,
      subjectType: dto.principalType,
      subjectId: dto.principalId,
      ...(subjectRelation ? { subjectRelation } : {}),
    });
    if (dto.principalType === 'user') {
      const me = await this.db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
      try {
        await this.notifications.notify(dto.principalId, 'finance.book.shared', {
          ownerName: me ? `${me.firstName} ${me.lastName ?? ''}`.trim() : 'Пользователь',
          roleLabel: dto.role === 'editor' ? 'ведёт вместе' : 'смотрит',
          bookId: book.id,
        }, { actionUrl: `/finance?bookId=${book.id}` });
      } catch (e) {
        this.logger.warn(`share notify failed: ${(e as Error)?.message ?? e}`);
      }
    }
    return this.listShares(userId, book.id);
  }

  async removeShare(
    userId: string,
    principalType: 'user' | 'circle',
    principalId: string,
    bookId?: string,
  ): Promise<FinShareDto[]> {
    const book = await this.requireOwnBook(userId, bookId);
    const subjectRelation = principalType === 'circle' ? 'member' : undefined;
    for (const relation of ['viewer', 'editor'] as const) {
      await this.access.revoke({
        resourceType: 'finbook',
        resourceId: book.id,
        relation,
        subjectType: principalType,
        subjectId: principalId,
        ...(subjectRelation ? { subjectRelation } : {}),
      });
    }
    return this.listShares(userId, book.id);
  }

  /** Книги, которыми со мной поделились («смотрит» включает «ведёт»). */
  async listSharedWithMe(userId: string): Promise<FinSharedBookDto[]> {
    const principal = { type: 'user', id: userId };
    const ids = await this.access.listObjects(principal, 'viewer', 'finbook');
    if (!ids.length) return [];
    const books = await this.db.finBook.findMany({ where: { id: { in: ids }, ownerType: 'user' } });
    if (!books.length) return [];
    const owners = await this.db.user.findMany({
      where: { id: { in: books.map((b) => b.ownerId) } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    const ownerById = new Map(owners.map((o) => [o.id, o]));
    const result: FinSharedBookDto[] = [];
    for (const book of books) {
      if (book.ownerId === userId) continue;
      const owner = ownerById.get(book.ownerId);
      const canEdit = await this.access.can(principal, 'finbook.edit', book.id);
      result.push({
        bookId: book.id,
        name: book.name,
        ownerUserId: book.ownerId,
        ownerName: owner ? `${owner.firstName} ${owner.lastName ?? ''}`.trim() : 'Пользователь',
        ownerAvatar: owner?.avatar ?? null,
        myRole: canEdit ? 'editor' : 'viewer',
      });
    }
    return result;
  }

  /** Разрыв связи (удаление/блок) — прямые user-гранты книг между парой отзываются (PRD). */
  async revokeSharesBetween(userAId: string, userBId: string): Promise<void> {
    const books = await this.db.finBook.findMany({
      where: { ownerType: 'user', ownerId: { in: [userAId, userBId] } },
      select: { id: true, ownerId: true },
    });
    for (const book of books) {
      const other = book.ownerId === userAId ? userBId : userAId;
      for (const relation of ['viewer', 'editor'] as const) {
        await this.access.revoke({
          resourceType: 'finbook',
          resourceId: book.id,
          relation,
          subjectType: 'user',
          subjectId: other,
        });
      }
    }
  }

  // ============================================================
  // Долги «я должен» (Phase 5): рассрочка-покупка + кредит деньгами
  // ============================================================

  private static readonly INTEREST_CATEGORY = 'Проценты по кредитам';

  /** Ленивая категория для переплаты по кредиту (total − received). */
  private async ensureInterestCategory(tx: Tx, bookId: string): Promise<FinAccount> {
    const existing = await tx.finAccount.findFirst({
      where: { bookId, kind: 'expense', name: FinancesService.INTEREST_CATEGORY, parentId: null },
    });
    if (existing) return existing;
    return tx.finAccount.create({
      data: { bookId, kind: 'expense', name: FinancesService.INTEREST_CATEGORY, icon: '🏦', currencyCode: FIN_DEFAULT_CURRENCY, sortOrder: 999 },
    });
  }

  /**
   * Создать долг. installment (рассрочка-покупка): расход ПОЛНОЙ суммой в категорию в момент
   * покупки (решение грилла — бьёт лимит месяца покупки), долг на N месяцев. loan (кредит
   * деньгами): зачисление на счёт; received < total → разница уходит расходом в «Проценты
   * по кредитам» (PnL честный, остаток долга = |баланс liability|).
   */
  async createDebt(
    userId: string,
    dto: {
      name: string;
      type: 'installment' | 'loan';
      monthlyPayment: number;
      months: number;
      totalAmount?: number;
      dueDay: number;
      currencyCode?: string;
      occurredOn?: string;
      note?: string;
      personUserId?: string;
      categoryAccountId?: string;
      creditAccountId?: string;
      amountReceived?: number;
    },
    bookId?: string,
  ): Promise<FinDebtDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const currencyCode = dto.currencyCode ?? FIN_DEFAULT_CURRENCY;
    const total = BigInt(dto.totalAmount ?? dto.monthlyPayment * dto.months);
    if (total <= 0n) throw new BadRequestException('Сумма долга должна быть больше нуля');

    let category: FinAccount | null = null;
    let creditAccount: FinAccount | null = null;
    if (dto.type === 'installment') {
      category = await this.db.finAccount.findFirst({ where: { id: dto.categoryAccountId, bookId: book.id, kind: 'expense', archived: false } });
      if (!category) throw new NotFoundException('Категория покупки не найдена');
    } else {
      creditAccount = await this.db.finAccount.findFirst({ where: { id: dto.creditAccountId, bookId: book.id, kind: 'asset', archived: false } });
      if (!creditAccount) throw new NotFoundException('Счёт зачисления не найден');
      if (creditAccount.currencyCode !== currencyCode) throw new BadRequestException('Валюта кредита должна совпадать с валютой счёта зачисления');
    }
    const received = dto.type === 'loan' ? BigInt(dto.amountReceived ?? Number(total)) : 0n;
    if (dto.type === 'loan' && received > total) throw new BadRequestException('Получено не может превышать сумму долга');
    const person = dto.personUserId ? await this.resolvePerson(userId, dto.personUserId) : null;
    const occurredOn = toDbDate(dto.occurredOn ?? todayStr());

    const liability = await this.db.$transaction(async (tx) => {
      const debt = await tx.finAccount.create({
        data: {
          bookId: book.id,
          kind: 'liability',
          subtype: dto.type,
          name: dto.name.trim(),
          icon: dto.type === 'installment' ? '🛍️' : '🏦',
          currencyCode,
          debtTotal: total,
          debtMonthly: BigInt(dto.monthlyPayment),
          debtMonths: dto.months,
          debtDueDay: dto.dueDay,
        },
      });
      const baseTx = {
        bookId: book.id,
        currencyCode,
        occurredOn,
        note: dto.note?.trim() || null,
        createdById: userId,
        source: 'manual',
      };
      if (dto.type === 'installment' && category) {
        await tx.finTransaction.create({
          data: {
            ...baseTx,
            fromAccountId: debt.id,
            toAccountId: category.id,
            amount: total,
            personUserId: person?.id ?? null,
            personName: person?.name ?? null,
          },
        });
      } else if (creditAccount) {
        await tx.finTransaction.create({
          data: { ...baseTx, fromAccountId: debt.id, toAccountId: creditAccount.id, amount: received },
        });
        if (received < total) {
          const interestCat = await this.ensureInterestCategory(tx, book.id);
          await tx.finTransaction.create({
            data: { ...baseTx, fromAccountId: debt.id, toAccountId: interestCat.id, amount: total - received, note: 'Проценты и комиссии по кредиту' },
          });
        }
      }
      await this.audit(tx, book.id, 'debt', debt.id, userId, 'create', undefined, debt);
      return debt;
    });

    // Рассрочка = расход полной суммой → лимит категории проверяется как у обычной траты.
    if (dto.type === 'installment' && category) {
      const shadowTx = { occurredOn, amount: total, currencyCode } as FinTransaction;
      try {
        await this.checkBudgetThresholds(book, category, shadowTx);
      } catch (e) {
        this.logger.warn(`budget threshold check failed: ${(e as Error)?.message ?? e}`);
      }
    }
    return this.serializeDebt(liability, total);
  }

  private serializeDebt(a: FinAccount, remaining: bigint): FinDebtDto {
    const total = a.debtTotal ?? 0n;
    const monthly = a.debtMonthly ?? 0n;
    const paid = total - remaining;
    return {
      accountId: a.id,
      name: a.name,
      icon: a.icon,
      subtype: a.subtype ?? 'installment',
      currencyCode: a.currencyCode,
      total: Number(total),
      monthly: Number(monthly),
      months: a.debtMonths ?? 0,
      dueDay: a.debtDueDay ?? 1,
      remaining: Number(remaining < 0n ? 0n : remaining),
      paidMonths: monthly > 0n ? Number(paid / monthly) : 0,
      closedAt: a.debtClosedAt?.toISOString() ?? null,
      archived: a.archived,
    };
  }

  async listDebts(userId: string, bookId?: string): Promise<FinDebtDto[]> {
    const book = await this.resolveBook(userId, bookId, 'view');
    const debts = await this.db.finAccount.findMany({
      where: { bookId: book.id, kind: 'liability' },
      orderBy: [{ debtClosedAt: 'asc' }, { createdAt: 'desc' }],
    });
    if (!debts.length) return [];
    const balances = await this.computeBalances(book.id);
    return debts.map((d) => this.serializeDebt(d, -(balances.get(d.id) ?? 0n)));
  }

  /** «Оплачено» в 1 тап: платёж = min(amount ?? ежемесячный, остаток); остаток 0 → долг закрыт. */
  async payDebt(
    userId: string,
    debtAccountId: string,
    dto: { fromAccountId: string; amount?: number },
    bookId?: string,
  ): Promise<FinDebtDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const source = await this.db.finAccount.findFirst({ where: { id: dto.fromAccountId, bookId: book.id, kind: 'asset', archived: false } });
    if (!source) throw new NotFoundException('Счёт списания не найден');

    // Атомарность: весь платёж (пересчёт остатка → запись → закрытие) под ОДНОЙ транзакцией
    // с FOR UPDATE на строку долга — сериализует конкурентные payDebt (двойной тап / два
    // editor'а общей книги), закрывает переплату сверх остатка и закрытие по устаревшему
    // балансу (модель WalletBalance в кошельке). Остаток считается ВНУТРИ лока.
    const result = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM fin_accounts WHERE id = ${debtAccountId} AND book_id = ${book.id} FOR UPDATE`;
      const debt = await tx.finAccount.findFirst({ where: { id: debtAccountId, bookId: book.id, kind: 'liability' } });
      if (!debt) throw new NotFoundException('Долг не найден');
      if (debt.debtClosedAt) throw new BadRequestException('Долг уже закрыт');
      if (source.currencyCode !== debt.currencyCode) throw new BadRequestException('Валюта платежа должна совпадать с валютой долга');

      const remaining = await this.debtRemainingTx(tx, debt.id);
      if (remaining <= 0n) throw new BadRequestException('Долг уже выплачен');
      const requested = dto.amount != null ? BigInt(dto.amount) : (debt.debtMonthly != null ? debt.debtMonthly : remaining);
      const amount = requested > remaining ? remaining : requested; // кэп остатком — без переплаты

      const row = await tx.finTransaction.create({
        data: {
          bookId: book.id,
          fromAccountId: source.id,
          toAccountId: debt.id,
          amount,
          currencyCode: source.currencyCode,
          occurredOn: toDbDate(todayStr()),
          createdById: userId,
          source: 'manual',
        },
      });
      await this.audit(tx, book.id, 'transaction', row.id, userId, 'create', undefined, row);

      const left = remaining - amount;
      if (left <= 0n) await tx.finAccount.update({ where: { id: debt.id }, data: { debtClosedAt: new Date() } });
      return { row, left: left < 0n ? 0n : left, closed: left <= 0n, debt };
    });

    // Пост-коммит сайд-эффекты (как в createTransaction): событие для триггеров + нотиф о закрытии.
    this.events.emit(
      'finance.transaction.created',
      {
        bookId: book.id, ownerType: book.ownerType, ownerId: book.ownerId,
        ...(book.ownerType === 'workspace' ? { workspaceId: book.ownerId } : {}),
        transactionId: result.row.id, txType: 'debt_payment',
        amount: Number(result.row.amount), currencyCode: result.row.currencyCode, source: 'manual',
      },
      'finances',
    );
    if (result.closed) {
      await this.notifySafe(book, 'finance.debt.paid', {
        debtName: result.debt.name,
        amount: this.formatMoneyHuman(result.debt.debtTotal ?? 0n, result.debt.currencyCode),
      });
    }
    const fresh = await this.db.finAccount.findUniqueOrThrow({ where: { id: debtAccountId } });
    return this.serializeDebt(fresh, result.left);
  }

  /** Остаток долга ВНУТРИ транзакции (для FOR UPDATE-пути): −(inflow − outflow) по liability-счёту. */
  private async debtRemainingTx(tx: Tx, accountId: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ balance: bigint | null }[]>`
      SELECT
        COALESCE((SELECT SUM(COALESCE(amount_to, amount)) FROM fin_transactions WHERE to_account_id = ${accountId} AND deleted_at IS NULL), 0)
        - COALESCE((SELECT SUM(amount) FROM fin_transactions WHERE from_account_id = ${accountId} AND deleted_at IS NULL), 0) AS balance`;
    const balance = rows[0]?.balance != null ? BigInt(rows[0].balance) : 0n;
    return -balance;
  }

  async updateDebt(
    userId: string,
    debtAccountId: string,
    dto: { name?: string; dueDay?: number; monthlyPayment?: number },
    bookId?: string,
  ): Promise<FinDebtDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const debt = await this.db.finAccount.findFirst({ where: { id: debtAccountId, bookId: book.id, kind: 'liability' } });
    if (!debt) throw new NotFoundException('Долг не найден');
    const updated = await this.db.$transaction(async (tx) => {
      const row = await tx.finAccount.update({
        where: { id: debt.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.dueDay !== undefined ? { debtDueDay: dto.dueDay } : {}),
          ...(dto.monthlyPayment !== undefined ? { debtMonthly: BigInt(dto.monthlyPayment) } : {}),
        },
      });
      await this.audit(tx, book.id, 'debt', debt.id, userId, 'update', debt, row);
      return row;
    });
    const balances = await this.computeBalances(book.id);
    return this.serializeDebt(updated, -(balances.get(updated.id) ?? 0n));
  }

  private async notifySafe(book: FinBook, type: Parameters<NotificationsService['notify']>[1], payload: Record<string, unknown>): Promise<void> {
    if (book.ownerType !== 'user') return;
    try {
      await this.notifications.notify(book.ownerId, type, payload, { actionUrl: '/finance' });
    } catch (e) {
      this.logger.warn(`notify failed: ${(e as Error)?.message ?? e}`);
    }
  }

  // ============================================================
  // Повторяющиеся операции (Phase 5)
  // ============================================================

  /** Следующее срабатывание СТРОГО ПОСЛЕ `after` (UTC-полночь; день месяца клампится к концу месяца). */
  computeNextRun(interval: 'monthly' | 'weekly', dayOfMonth: number | null, weekday: number | null, after: Date): Date {
    const day = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate()));
    if (interval === 'weekly') {
      const target = weekday ?? 1; // 1..7 ISO
      const current = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
      let delta = target - current;
      if (delta <= 0) delta += 7;
      return new Date(day.getTime() + delta * 86400000);
    }
    const wanted = dayOfMonth ?? 1;
    const candidate = (y: number, m: number): Date => {
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      return new Date(Date.UTC(y, m, Math.min(wanted, last)));
    };
    const thisMonth = candidate(day.getUTCFullYear(), day.getUTCMonth());
    if (thisMonth.getTime() > day.getTime()) return thisMonth;
    return candidate(day.getUTCFullYear(), day.getUTCMonth() + 1);
  }

  private serializeRecurring(r: FinRecurringRule, currencyCode = 'KZT'): FinRecurringRuleDto {
    return {
      id: r.id,
      title: r.title,
      fromAccountId: r.fromAccountId,
      toAccountId: r.toAccountId,
      amount: Number(r.amount),
      currencyCode,
      note: r.note,
      personUserId: r.personUserId,
      personName: r.personName,
      interval: r.interval as 'monthly' | 'weekly',
      dayOfMonth: r.dayOfMonth,
      weekday: r.weekday,
      autoRecord: r.autoRecord,
      active: r.active,
      nextRunAt: r.nextRunAt.toISOString(),
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
    };
  }

  async createRecurring(
    userId: string,
    dto: {
      title: string;
      fromAccountId: string;
      toAccountId: string;
      amount: number;
      note?: string;
      personUserId?: string;
      interval: 'monthly' | 'weekly';
      dayOfMonth?: number;
      weekday?: number;
      autoRecord?: boolean;
    },
    bookId?: string,
  ): Promise<FinRecurringRuleDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const { from, to } = await this.loadPair(book.id, dto.fromAccountId, dto.toAccountId);
    this.derivePairType(from.kind, to.kind);
    if (MONEY_KINDS.has(from.kind) && MONEY_KINDS.has(to.kind) && from.currencyCode !== to.currencyCode) {
      throw new BadRequestException('Повторы между валютами не поддерживаются (курс меняется) — записывайте обмен вручную');
    }
    const person = dto.personUserId ? await this.resolvePerson(userId, dto.personUserId) : null;
    const rule = await this.db.finRecurringRule.create({
      data: {
        bookId: book.id,
        title: dto.title.trim(),
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: BigInt(dto.amount),
        note: dto.note?.trim() || null,
        personUserId: person?.id ?? null,
        personName: person?.name ?? null,
        interval: dto.interval,
        dayOfMonth: dto.interval === 'monthly' ? dto.dayOfMonth ?? 1 : null,
        weekday: dto.interval === 'weekly' ? dto.weekday ?? 1 : null,
        autoRecord: dto.autoRecord ?? true,
        nextRunAt: this.computeNextRun(dto.interval, dto.dayOfMonth ?? null, dto.weekday ?? null, new Date()),
      },
    });
    // Валюта = денежная нога (asset/liability); один из from/to — категория (валюта не важна).
    const moneySide = MONEY_KINDS.has(from.kind) ? from : to;
    return this.serializeRecurring(rule, moneySide.currencyCode);
  }

  async listRecurring(userId: string, bookId?: string): Promise<FinRecurringRuleDto[]> {
    const book = await this.resolveBook(userId, bookId, 'view');
    const rules = await this.db.finRecurringRule.findMany({ where: { bookId: book.id }, orderBy: { createdAt: 'asc' } });
    if (!rules.length) return [];
    // Батч валют денежных ног (from или to — что окажется asset/liability).
    const acctIds = [...new Set(rules.flatMap((r) => [r.fromAccountId, r.toAccountId]))];
    const accts = await this.db.finAccount.findMany({ where: { id: { in: acctIds } }, select: { id: true, kind: true, currencyCode: true } });
    const acctById = new Map(accts.map((a) => [a.id, a]));
    const ruleCurrency = (r: FinRecurringRule): string => {
      const f = acctById.get(r.fromAccountId), t = acctById.get(r.toAccountId);
      const money = f && MONEY_KINDS.has(f.kind) ? f : t;
      return money?.currencyCode ?? 'KZT';
    };
    return rules.map((r) => this.serializeRecurring(r, ruleCurrency(r)));
  }

  async updateRecurring(
    userId: string,
    ruleId: string,
    dto: { title?: string; amount?: number; note?: string | null; dayOfMonth?: number; weekday?: number; autoRecord?: boolean; active?: boolean },
    bookId?: string,
  ): Promise<FinRecurringRuleDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const rule = await this.db.finRecurringRule.findFirst({ where: { id: ruleId, bookId: book.id } });
    if (!rule) throw new NotFoundException('Повтор не найден');
    const dayChanged = dto.dayOfMonth !== undefined || dto.weekday !== undefined;
    const updated = await this.db.finRecurringRule.update({
      where: { id: rule.id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.amount !== undefined ? { amount: BigInt(dto.amount) } : {}),
        ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
        ...(dto.dayOfMonth !== undefined ? { dayOfMonth: dto.dayOfMonth } : {}),
        ...(dto.weekday !== undefined ? { weekday: dto.weekday } : {}),
        ...(dto.autoRecord !== undefined ? { autoRecord: dto.autoRecord } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dayChanged
          ? {
              nextRunAt: this.computeNextRun(
                rule.interval as 'monthly' | 'weekly',
                dto.dayOfMonth ?? rule.dayOfMonth,
                dto.weekday ?? rule.weekday,
                new Date(),
              ),
            }
          : {}),
      },
    });
    const money = await this.db.finAccount.findMany({
      where: { id: { in: [updated.fromAccountId, updated.toAccountId] } },
      select: { id: true, kind: true, currencyCode: true },
    });
    const moneySide = money.find((a) => MONEY_KINDS.has(a.kind));
    return this.serializeRecurring(updated, moneySide?.currencyCode ?? 'KZT');
  }

  async deleteRecurring(userId: string, ruleId: string, bookId?: string): Promise<{ success: true }> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    await this.db.finRecurringRule.deleteMany({ where: { id: ruleId, bookId: book.id } });
    return { success: true };
  }

  /** «Записать сейчас» — для правил-напоминаний (и вообще любых): операция сегодняшним днём. */
  async recordRecurringNow(userId: string, ruleId: string, bookId?: string): Promise<FinTransactionDto> {
    const book = await this.resolveBook(userId, bookId, 'edit');
    const rule = await this.db.finRecurringRule.findFirst({ where: { id: ruleId, bookId: book.id } });
    if (!rule) throw new NotFoundException('Повтор не найден');
    return this.createTransaction(
      userId,
      {
        fromAccountId: rule.fromAccountId,
        toAccountId: rule.toAccountId,
        amount: Number(rule.amount),
        note: rule.note ?? rule.title,
        personUserId: rule.personUserId ?? undefined,
        source: 'recurring',
        recurringRuleId: rule.id,
      },
      bookId,
    );
  }

  // ---------- крон-механика (вызывается FinancesCron под Redis-локом) ----------

  /** Срабатывания повторов: авто-запись или напоминание. Claim через сдвиг nextRunAt (двойной прогон невозможен). */
  async processDueRecurring(): Promise<number> {
    const now = new Date();
    const due = await this.db.finRecurringRule.findMany({
      where: { active: true, nextRunAt: { lte: now } },
      take: 200,
    });
    let processed = 0;
    for (const rule of due) {
      const next = this.computeNextRun(rule.interval as 'monthly' | 'weekly', rule.dayOfMonth, rule.weekday, now);
      const claimed = await this.db.finRecurringRule.updateMany({
        where: { id: rule.id, nextRunAt: rule.nextRunAt },
        data: { nextRunAt: next, lastRunAt: now },
      });
      if (claimed.count === 0) continue; // другой инстанс забрал
      const book = await this.db.finBook.findUnique({ where: { id: rule.bookId } });
      if (!book || book.ownerType !== 'user') continue;
      const amountHuman = this.formatMoneyHuman(rule.amount, (await this.db.finAccount.findUnique({ where: { id: rule.fromAccountId }, select: { currencyCode: true } }))?.currencyCode ?? 'KZT');
      if (rule.autoRecord) {
        try {
          await this.createTransaction(
            book.ownerId,
            {
              fromAccountId: rule.fromAccountId,
              toAccountId: rule.toAccountId,
              amount: Number(rule.amount),
              note: rule.note ?? rule.title,
              personUserId: rule.personUserId ?? undefined,
              source: 'recurring',
              recurringRuleId: rule.id,
            },
            undefined,
          );
          await this.notifySafe(book, 'finance.recurring.recorded', { title: rule.title, amount: amountHuman });
        } catch (e) {
          this.logger.warn(`auto-record failed for rule ${rule.id}: ${(e as Error)?.message ?? e}`);
          await this.notifySafe(book, 'finance.recurring.due', { title: rule.title, amount: amountHuman });
        }
      } else {
        await this.notifySafe(book, 'finance.recurring.due', { title: rule.title, amount: amountHuman });
      }
      processed++;
    }
    return processed;
  }

  /** Напоминания «сегодня платёж по долгу» (дедуп — debtRemindedAt, раз в день). */
  async processDebtReminders(): Promise<number> {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayDay = now.getUTCDate();
    const lastDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

    const rows = await this.db.$queryRaw<
      { id: string; book_id: string; name: string; currency_code: string; debt_monthly: bigint | null; debt_due_day: number; balance: bigint }[]
    >`
      SELECT a.id, a.book_id, a.name, a.currency_code, a.debt_monthly, a.debt_due_day,
        (SELECT COALESCE(SUM(COALESCE(t.amount_to, t.amount)), 0) FROM fin_transactions t WHERE t.to_account_id = a.id AND t.deleted_at IS NULL)
        - (SELECT COALESCE(SUM(t.amount), 0) FROM fin_transactions t WHERE t.from_account_id = a.id AND t.deleted_at IS NULL) AS balance
      FROM fin_accounts a
      WHERE a.kind = 'liability' AND a.archived = false AND a.debt_closed_at IS NULL AND a.debt_due_day IS NOT NULL
        AND (a.debt_reminded_at IS NULL OR a.debt_reminded_at < ${todayStart})`;

    let sent = 0;
    for (const row of rows) {
      const dueToday = row.debt_due_day === todayDay || (row.debt_due_day > lastDayOfMonth && todayDay === lastDayOfMonth);
      if (!dueToday) continue;
      const remaining = -BigInt(row.balance);
      if (remaining <= 0n) continue;
      const book = await this.db.finBook.findUnique({ where: { id: row.book_id } });
      if (!book || book.ownerType !== 'user') continue;
      const monthly = row.debt_monthly != null ? BigInt(row.debt_monthly) : remaining;
      const payAmount = monthly > remaining ? remaining : monthly;
      await this.notifySafe(book, 'finance.debt.payment_due', {
        debtName: row.name,
        amount: this.formatMoneyHuman(payAmount, row.currency_code),
        debtAccountId: row.id,
      });
      await this.db.finAccount.update({ where: { id: row.id }, data: { debtRemindedAt: now } });
      sent++;
    }
    return sent;
  }

  // ============================================================
  // Коины: авто-лента экосистемы (Phase 7) — read-only проекция леджера
  // ============================================================

  /**
   * «Финансовое лицо» кошелька-леджера: реальные движения коинов (posted / post_pending)
   * с контекстом источника (задача / заказ / выпуск) и контрагентом. Кошелёк личный —
   * лента доступна только своему владельцу и НЕ шерится с книгой (решение грилла).
   */
  async getCoinFeed(userId: string, cursor?: string, limit = 30): Promise<{ items: FinCoinFeedItemDto[]; nextCursor: string | null }> {
    const myAccounts = await this.db.account.findMany({
      where: { ownerType: 'user', ownerId: userId, type: 'user' },
      select: { id: true },
    });
    if (!myAccounts.length) return { items: [], nextCursor: null };
    const myIds = new Set(myAccounts.map((a) => a.id));
    const ids = [...myIds];

    const rows = await this.db.ledgerTransfer.findMany({
      where: {
        kind: { in: ['posted', 'post_pending'] },
        OR: [{ debitAccountId: { in: ids } }, { creditAccountId: { in: ids } }],
      },
      orderBy: { id: 'desc' },
      ...(cursor ? { cursor: { id: BigInt(cursor) }, skip: 1 } : {}),
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? String(page[page.length - 1].id) : null;
    if (!page.length) return { items: [], nextCursor: null };

    // --- batched enrichment ---
    const currencies = await this.db.currency.findMany({
      where: { id: { in: [...new Set(page.map((r) => r.currencyId))] } },
      select: { id: true, name: true, icon: true },
    });
    const currencyById = new Map(currencies.map((c) => [c.id, c]));

    const counterIds = [...new Set(page.map((r) => (myIds.has(r.debitAccountId) ? r.creditAccountId : r.debitAccountId)))];
    const counterAccounts = await this.db.account.findMany({
      where: { id: { in: counterIds } },
      select: { id: true, type: true, ownerType: true, ownerId: true },
    });
    const counterById = new Map(counterAccounts.map((a) => [a.id, a]));
    const counterUserIds = counterAccounts.filter((a) => a.type === 'user' && a.ownerType === 'user').map((a) => a.ownerId);
    const counterUsers = counterUserIds.length
      ? await this.db.user.findMany({ where: { id: { in: counterUserIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const userNameById = new Map(counterUsers.map((u) => [u.id, `${u.firstName} ${u.lastName ?? ''}`.trim()]));
    const wsIds = counterAccounts.filter((a) => a.ownerType === 'workspace').map((a) => a.ownerId);
    const workspaces = wsIds.length
      ? await this.db.workspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, name: true } })
      : [];
    const wsNameById = new Map(workspaces.map((w) => [w.id, w.name]));

    const agreementIds = [...new Set(page.map((r) => r.agreementId).filter(Boolean))] as string[];
    const agreements = agreementIds.length
      ? await this.db.escrowAgreement.findMany({ where: { id: { in: agreementIds } }, select: { id: true, refType: true, refId: true } })
      : [];
    const agreementById = new Map(agreements.map((a) => [a.id, a]));
    const taskIds = agreements.filter((a) => a.refType === 'task').map((a) => a.refId);
    const orderIds = agreements.filter((a) => a.refType === 'order').map((a) => a.refId);
    const tasks = taskIds.length
      ? await this.db.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true } })
      : [];
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const orders = orderIds.length
      ? await this.db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, titleSnapshot: true, crowdfunding: true } })
      : [];
    const orderById = new Map(orders.map((o) => [o.id, o]));

    const items: FinCoinFeedItemDto[] = page.map((r) => {
      const out = myIds.has(r.debitAccountId);
      const counter = counterById.get(out ? r.creditAccountId : r.debitAccountId);
      const currency = currencyById.get(r.currencyId);
      let kind: FinCoinFeedItemDto['kind'] = 'other';
      let title = r.memo ?? (out ? 'Перевод' : 'Получено');
      let href: string | null = null;
      let counterpartyUserId: string | null = null;
      let counterpartyName: string | null = null;

      const agreement = r.agreementId ? agreementById.get(r.agreementId) : null;
      if (agreement?.refType === 'task') {
        kind = 'task';
        const task = taskById.get(agreement.refId);
        title = `${out ? 'Выплата награды за задачу' : 'Награда за задачу'}${task ? ` «${task.title}»` : ''}`;
        href = `/tasks/${agreement.refId}`;
      } else if (agreement?.refType === 'order') {
        kind = 'order';
        const order = orderById.get(agreement.refId);
        const word = order?.crowdfunding ? (out ? 'Вклад в сбор' : 'Сбор (вскладчину)') : out ? 'Покупка' : 'Продажа';
        title = `${word}${order ? `: ${order.titleSnapshot}` : ''}`;
        href = '/shop';
      } else if (counter?.type === 'issuance') {
        kind = out ? 'burn' : 'mint';
        title = out ? 'Монеты сожжены' : 'Выпуск монет';
      } else if (counter?.ownerType === 'system') {
        title = r.memo ?? 'Платформа';
      }

      if (counter?.type === 'user' && counter.ownerType === 'user' && counter.ownerId !== userId) {
        counterpartyUserId = counter.ownerId;
        counterpartyName = userNameById.get(counter.ownerId) ?? null;
      } else if (counter?.ownerType === 'workspace') {
        counterpartyName = wsNameById.get(counter.ownerId) ? `Казна: ${wsNameById.get(counter.ownerId)}` : 'Казна компании';
      }

      return {
        id: String(r.id),
        direction: out ? 'out' : 'in',
        amount: Number(r.amount),
        currencyName: currency?.name ?? 'Коины',
        currencyIcon: currency?.icon ?? '🪙',
        title,
        kind,
        counterpartyUserId,
        counterpartyName,
        href,
        createdAt: r.createdAt.toISOString(),
      };
    });
    return { items, nextCursor };
  }

  // ============================================================
  // Экосистемные мосты (Phase 8): календарный слой + нода Процессов
  // ============================================================

  /**
   * Виртуальный слой «Платежи» для календаря (как слой задач — НЕ копируется): раскрывает
   * дни платежей по открытым долгам и повторяющимся операциям в диапазоне. Личная книга.
   */
  async getPaymentsForCalendar(userId: string, from: Date, to: Date): Promise<Array<{
    kind: 'finance';
    id: string;
    title: string;
    start: string;
    allDay: true;
    amount: number;
    currencyCode: string;
    href: string;
  }>> {
    const book = await this.db.finBook.findUnique({ where: { ownerType_ownerId: { ownerType: 'user', ownerId: userId } } });
    if (!book) return [];
    const [debts, rules] = await Promise.all([
      this.db.finAccount.findMany({
        where: { bookId: book.id, kind: 'liability', archived: false, debtClosedAt: null, debtDueDay: { not: null } },
        select: { id: true, name: true, currencyCode: true, debtMonthly: true, debtDueDay: true },
      }),
      this.db.finRecurringRule.findMany({ where: { bookId: book.id, active: true } }),
    ]);
    if (!debts.length && !rules.length) return [];
    const ruleCurrency = new Map<string, string>();
    if (rules.length) {
      const accs = await this.db.finAccount.findMany({
        where: { id: { in: rules.map((r) => r.fromAccountId) } },
        select: { id: true, currencyCode: true },
      });
      for (const r of rules) ruleCurrency.set(r.id, accs.find((a) => a.id === r.fromAccountId)?.currencyCode ?? 'KZT');
    }

    const items: Array<{ kind: 'finance'; id: string; title: string; start: string; allDay: true; amount: number; currencyCode: string; href: string }> = [];
    const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    for (let d = start; d <= to; d = new Date(d.getTime() + 86400000)) {
      const day = d.getUTCDate();
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      const iso = d.toISOString();
      const dateStr = iso.slice(0, 10);
      const isoWeekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
      for (const debt of debts) {
        const due = debt.debtDueDay as number;
        if (day === Math.min(due, lastDay)) {
          items.push({
            kind: 'finance',
            id: `debt:${debt.id}:${dateStr}`,
            title: `📅 Платёж: ${debt.name}`,
            start: iso,
            allDay: true,
            amount: Number(debt.debtMonthly ?? 0n),
            currencyCode: debt.currencyCode,
            href: '/finance',
          });
        }
      }
      for (const rule of rules) {
        const hit =
          rule.interval === 'monthly'
            ? day === Math.min(rule.dayOfMonth ?? 1, lastDay)
            : isoWeekday === (rule.weekday ?? 1);
        if (hit) {
          items.push({
            kind: 'finance',
            id: `recurring:${rule.id}:${dateStr}`,
            title: `🔁 ${rule.title}`,
            start: iso,
            allDay: true,
            amount: Number(rule.amount),
            currencyCode: ruleCurrency.get(rule.id) ?? 'KZT',
            href: '/finance',
          });
        }
      }
    }
    return items;
  }

  /**
   * Управленческая запись для книги ОРГАНИЗАЦИИ — вызывается нодой Процессов
   * «Финансы: записать операцию». Категория ищется по имени (лениво создаётся),
   * деньги ходят через счёт «Касса» (лениво). source='process'.
   */
  async recordOperationForBook(
    workspaceId: string,
    dto: { kind: 'expense' | 'income'; amount: number; categoryName: string; note?: string; actorUserId: string },
  ): Promise<{ transactionId: string; bookId: string }> {
    if (!Number.isFinite(dto.amount) || dto.amount <= 0) throw new BadRequestException('Сумма должна быть больше нуля');
    const book = await this.getOrCreateBook('workspace', workspaceId);
    const categoryName = dto.categoryName.trim() || 'Прочее';

    return this.db.$transaction(async (tx) => {
      let category = await tx.finAccount.findFirst({
        where: { bookId: book.id, kind: dto.kind, name: categoryName, parentId: null, archived: false },
      });
      if (!category) {
        category = await tx.finAccount.create({
          data: { bookId: book.id, kind: dto.kind, name: categoryName, icon: dto.kind === 'expense' ? '🧾' : '💰', currencyCode: FIN_DEFAULT_CURRENCY, sortOrder: 500 },
        });
      }
      let cashbox = await tx.finAccount.findFirst({ where: { bookId: book.id, kind: 'asset', archived: false }, orderBy: { sortOrder: 'asc' } });
      if (!cashbox) {
        cashbox = await tx.finAccount.create({
          data: { bookId: book.id, kind: 'asset', subtype: 'other', name: 'Касса', icon: '🧮', currencyCode: FIN_DEFAULT_CURRENCY },
        });
      }
      const row = await tx.finTransaction.create({
        data: {
          bookId: book.id,
          fromAccountId: dto.kind === 'expense' ? cashbox.id : category.id,
          toAccountId: dto.kind === 'expense' ? category.id : cashbox.id,
          amount: BigInt(Math.round(dto.amount)),
          currencyCode: FIN_DEFAULT_CURRENCY,
          occurredOn: toDbDate(todayStr()),
          note: dto.note?.trim() || null,
          createdById: dto.actorUserId,
          source: 'process',
        },
      });
      await this.audit(tx, book.id, 'transaction', row.id, dto.actorUserId, 'create', undefined, row);
      return { row, book };
    }).then(({ row, book }) => {
      // Инвариант «каждая запись эмитит событие» — как в createTransaction. source='process'
      // → анти-runaway-гвард ProcessTriggerRouter отсекает петлю нода→триггер→нода, но при
      // появлении B2B-UI ручные записи в книгу организации (source='manual') триггеры увидят.
      this.events.emit(
        'finance.transaction.created',
        {
          bookId: book.id,
          ownerType: book.ownerType,
          ownerId: book.ownerId,
          workspaceId: book.ownerId,
          transactionId: row.id,
          txType: dto.kind,
          amount: Number(row.amount),
          currencyCode: row.currencyCode,
          source: 'process',
        },
        'finances',
      );
      return { transactionId: row.id, bookId: book.id };
    });
  }

  // ============================================================
  // Audit
  // ============================================================

  private async audit(
    tx: Tx,
    bookId: string,
    entityType: string,
    entityId: string,
    userId: string,
    action: 'create' | 'update' | 'delete',
    before?: unknown,
    after?: unknown,
  ): Promise<void> {
    await tx.finAuditLog.create({
      data: {
        bookId,
        entityType,
        entityId,
        userId,
        action,
        before: jsonSafe(before) ?? Prisma.JsonNull,
        after: jsonSafe(after) ?? Prisma.JsonNull,
      },
    });
  }
}
