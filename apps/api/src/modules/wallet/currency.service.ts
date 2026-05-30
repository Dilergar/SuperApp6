import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WALLET_LIMITS } from '@superapp/shared';
import type {
  Currency as CurrencyDto,
  WalletEntry,
  LedgerEntryDto,
  LedgerEntryType,
  CurrencyHolder,
  IssuerType,
  CreateCurrencyRequest,
  UpdateCurrencyRequest,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { LedgerService } from './ledger.service';

type CurrencyRow = Prisma.CurrencyGetPayload<object>;
type TransferRow = Prisma.LedgerTransferGetPayload<object>;

/**
 * Currency lifecycle + the user-facing wallet (B2C). Owns policy (one active currency per issuer,
 * the 1×/3-months rename, cascade-burn on delete, minting against an owned currency) and delegates
 * the actual money movements to LedgerService (the double-entry ledger over typed accounts).
 */
@Injectable()
export class CurrencyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  // ============================================================
  // Currency lifecycle
  // ============================================================

  async getMyCurrency(userId: string): Promise<CurrencyDto | null> {
    const row = await this.activeCurrencyOf('user', userId);
    return row ? this.toDto(row, userId) : null;
  }

  async createCurrency(userId: string, data: CreateCurrencyRequest): Promise<CurrencyDto> {
    const existing = await this.activeCurrencyOf('user', userId);
    if (existing) {
      throw new ConflictException('У вас уже есть валюта. Можно изменить её или удалить.');
    }
    try {
      const row = await this.db.currency.create({
        data: {
          issuerType: 'user',
          issuerId: userId,
          name: data.name.trim(),
          icon: data.icon,
          scale: 0, // personal coins are whole units
        },
      });
      return this.toDto(row, userId);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('У вас уже есть валюта.');
      }
      throw err;
    }
  }

  /** Rename / re-icon — at most once per 3 months. Retroactive (everything references the id). */
  async renameCurrency(userId: string, data: UpdateCurrencyRequest): Promise<CurrencyDto> {
    const row = await this.activeCurrencyOf('user', userId);
    if (!row) throw new NotFoundException('У вас ещё нет валюты');

    if (row.lastRenamedAt) {
      const nextAt = this.renameNextAt(row.lastRenamedAt);
      if (nextAt && nextAt.getTime() > Date.now()) {
        throw new BadRequestException(
          `Менять валюту можно раз в 3 месяца. Следующее изменение — после ${nextAt.toLocaleDateString('ru-RU')}`,
        );
      }
    }

    const updated = await this.db.currency.update({
      where: { id: row.id },
      data: {
        name: data.name?.trim() ?? row.name,
        icon: data.icon ?? row.icon,
        lastRenamedAt: new Date(),
      },
    });
    return this.toDto(updated, userId);
  }

  /**
   * Delete the currency. Soft-delete + cascade burn (all double-entry): every active escrow hold is
   * voided (reservations released), then each holder's positive balance is burned back to the
   * issuance account (so the journal stays balanced and the currency nets to zero). In-flight tasks
   * simply lose this reward.
   */
  async deleteCurrency(userId: string): Promise<void> {
    const row = await this.activeCurrencyOf('user', userId);
    if (!row) throw new NotFoundException('У вас ещё нет валюты');

    await this.db.$transaction(async (tx) => {
      const activeHolds = await tx.escrowHold.findMany({
        where: { currencyId: row.id, status: 'active' },
      });
      for (const h of activeHolds) {
        if (h.pendingTransferId) await this.ledger.voidPending(tx, h.pendingTransferId);
        await tx.escrowHold.update({ where: { id: h.id }, data: { status: 'released' } });
      }

      const holders = await tx.account.findMany({
        where: { currencyId: row.id, type: 'user', ownerType: 'user' },
      });
      for (const a of holders) {
        if (a.balance > 0n) {
          await this.ledger.burn(
            { currencyId: row.id, ownerId: a.ownerId, amount: Number(a.balance) },
            tx,
          );
        }
      }

      await tx.currency.update({
        where: { id: row.id },
        data: { status: 'deleted', deletedAt: new Date() },
      });
    });
  }

  // ============================================================
  // Wallet operations
  // ============================================================

  /** Manually emit coins of one's own currency onto one's own balance (capped at 10M in hand). */
  async mint(userId: string, amount: number): Promise<WalletEntry> {
    const row = await this.activeCurrencyOf('user', userId);
    if (!row) throw new BadRequestException('Сначала создайте свою валюту');
    await this.ledger.mint({ currencyId: row.id, ownerId: userId, amount });
    return this.walletEntry(row, userId, true);
  }

  /** Holder burns a FOREIGN currency from their balance (irreversible). Own currency is deleted instead. */
  async burn(userId: string, currencyId: string, amount: number): Promise<WalletEntry> {
    const currency = await this.db.currency.findUnique({ where: { id: currencyId } });
    if (!currency || currency.status !== 'active') throw new NotFoundException('Валюта не найдена');
    if (currency.issuerType === 'user' && currency.issuerId === userId) {
      throw new BadRequestException('Свою валюту нельзя сжечь — её можно удалить целиком');
    }
    await this.ledger.burn({ currencyId, ownerId: userId, amount });
    return this.walletEntry(currency, userId, false);
  }

  // ============================================================
  // Wallet views
  // ============================================================

  /** All currencies the viewer holds (own currency always shown), with balances. */
  async getWallet(userId: string): Promise<WalletEntry[]> {
    const accounts = await this.db.account.findMany({
      where: { type: 'user', ownerType: 'user', ownerId: userId },
    });
    const ids = new Set(accounts.map((a) => a.currencyId));
    const own = await this.activeCurrencyOf('user', userId);
    if (own) ids.add(own.id);
    if (ids.size === 0) return [];

    const currencies = await this.db.currency.findMany({
      where: { id: { in: [...ids] }, status: 'active' },
    });
    const issuerUserIds = [
      ...new Set(currencies.filter((c) => c.issuerType === 'user').map((c) => c.issuerId)),
    ];
    const nameById = await this.userNames(issuerUserIds);
    const acctByCurrency = new Map(accounts.map((a) => [a.currencyId, a]));

    const out: WalletEntry[] = [];
    for (const c of currencies) {
      const a = acctByCurrency.get(c.id);
      const balance = a?.balance ?? 0n;
      const held = a?.held ?? 0n;
      const isOwn = c.issuerType === 'user' && c.issuerId === userId;
      if (!isOwn && balance === 0n && held === 0n) continue; // hide empty foreign currencies
      out.push({
        currencyId: c.id,
        name: c.name,
        icon: c.icon,
        scale: c.scale,
        issuerId: c.issuerId,
        issuerName: c.issuerType === 'user' ? nameById.get(c.issuerId) ?? '—' : '—',
        balance: Number(balance),
        held: Number(held),
        available: Number(balance - held),
        isOwn,
      });
    }
    out.sort((a, b) => (a.isOwn === b.isOwn ? b.balance - a.balance : a.isOwn ? -1 : 1));
    return out;
  }

  /** Cursor-paginated transaction history (settled movements only) from the viewer's perspective. */
  async getHistory(
    userId: string,
    q: { currencyId?: string; cursor?: string; limit?: number },
  ): Promise<{ items: LedgerEntryDto[]; nextCursor: string | null }> {
    const limit = Math.min(q.limit ?? WALLET_LIMITS.historyPageSize, 100);

    const accounts = await this.db.account.findMany({
      where: { type: 'user', ownerType: 'user', ownerId: userId },
      select: { id: true },
    });
    const myAccountIds = accounts.map((a) => a.id);
    if (myAccountIds.length === 0) return { items: [], nextCursor: null };
    const mine = new Set(myAccountIds);

    const where: Prisma.LedgerTransferWhereInput = {
      kind: { in: ['posted', 'post_pending'] }, // settled movements; holds (pending/void) are internal
      OR: [{ debitAccountId: { in: myAccountIds } }, { creditAccountId: { in: myAccountIds } }],
    };
    if (q.currencyId) where.currencyId = q.currencyId;
    if (q.cursor) where.id = { lt: BigInt(q.cursor) };

    const rows = await this.db.ledgerTransfer.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: page.map((r) => {
        const received = mine.has(r.creditAccountId);
        const signed = received ? Number(r.amount) : -Number(r.amount);
        return {
          id: r.id.toString(),
          currencyId: r.currencyId,
          entryType: this.entryType(r),
          amount: signed,
          agreementId: r.agreementId,
          memo: r.memo,
          createdAt: r.createdAt.toISOString(),
        };
      }),
      nextCursor: hasMore ? page[page.length - 1].id.toString() : null,
    };
  }

  /** "Holders of my currency" (cap table). Issuer-only by construction — uses the caller's own currency. */
  async getHolders(userId: string): Promise<CurrencyHolder[]> {
    const c = await this.activeCurrencyOf('user', userId);
    if (!c) return [];
    const rows = await this.db.account.findMany({
      where: {
        currencyId: c.id,
        type: 'user',
        ownerType: 'user',
        ownerId: { not: userId },
        balance: { not: 0n },
      },
    });
    const names = await this.userMinis(rows.map((r) => r.ownerId));
    return rows
      .map((r) => {
        const u = names.get(r.ownerId);
        return {
          userId: r.ownerId,
          name: u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—',
          avatar: u?.avatar ?? null,
          balance: Number(r.balance),
        };
      })
      .sort((a, b) => b.balance - a.balance);
  }

  // ============================================================
  // Company (B2B) currency & treasury — issuer = workspace, holder = treasury (P9)
  // ============================================================

  async getCompanyCurrency(workspaceId: string): Promise<CurrencyDto | null> {
    const row = await this.activeCurrencyOf('workspace', workspaceId);
    return row ? this.toCompanyDto(row) : null;
  }

  async createCompanyCurrency(workspaceId: string, data: CreateCurrencyRequest): Promise<CurrencyDto> {
    if (await this.activeCurrencyOf('workspace', workspaceId)) throw new ConflictException('У компании уже есть валюта.');
    try {
      const row = await this.db.currency.create({
        data: { issuerType: 'workspace', issuerId: workspaceId, name: data.name.trim(), icon: data.icon, scale: 0 },
      });
      return this.toCompanyDto(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('У компании уже есть валюта.');
      throw err;
    }
  }

  async renameCompanyCurrency(workspaceId: string, data: UpdateCurrencyRequest): Promise<CurrencyDto> {
    const row = await this.activeCurrencyOf('workspace', workspaceId);
    if (!row) throw new NotFoundException('У компании ещё нет валюты');
    if (row.lastRenamedAt) {
      const nextAt = this.renameNextAt(row.lastRenamedAt);
      if (nextAt && nextAt.getTime() > Date.now()) {
        throw new BadRequestException(`Менять валюту можно раз в 3 месяца. Следующее изменение — после ${nextAt.toLocaleDateString('ru-RU')}`);
      }
    }
    const updated = await this.db.currency.update({
      where: { id: row.id },
      data: { name: data.name?.trim() ?? row.name, icon: data.icon ?? row.icon, lastRenamedAt: new Date() },
    });
    return this.toCompanyDto(updated);
  }

  async deleteCompanyCurrency(workspaceId: string): Promise<void> {
    const row = await this.activeCurrencyOf('workspace', workspaceId);
    if (!row) throw new NotFoundException('У компании ещё нет валюты');
    await this.db.$transaction(async (tx) => {
      const activeHolds = await tx.escrowHold.findMany({ where: { currencyId: row.id, status: 'active' } });
      for (const h of activeHolds) {
        if (h.pendingTransferId) await this.ledger.voidPending(tx, h.pendingTransferId);
        await tx.escrowHold.update({ where: { id: h.id }, data: { status: 'released' } });
      }
      // Burn every positive balance (employees AND the treasury) back to issuance so the books net to 0.
      const holders = await tx.account.findMany({ where: { currencyId: row.id, type: 'user' } });
      for (const a of holders) {
        if (a.balance > 0n) await this.ledger.burn({ currencyId: row.id, ownerType: a.ownerType, ownerId: a.ownerId, amount: Number(a.balance) }, tx);
      }
      await tx.currency.update({ where: { id: row.id }, data: { status: 'deleted', deletedAt: new Date() } });
    });
  }

  /** Mint company coins into the company TREASURY (workspace account). Capped at 10M "in hand". */
  async mintToTreasury(workspaceId: string, amount: number): Promise<WalletEntry> {
    const row = await this.activeCurrencyOf('workspace', workspaceId);
    if (!row) throw new BadRequestException('Сначала создайте валюту компании');
    await this.ledger.mint({ currencyId: row.id, ownerType: 'workspace', ownerId: workspaceId, amount });
    return this.companyEntry(row, workspaceId);
  }

  /** The company treasury wallet (its company-currency balance). */
  async getCompanyWallet(workspaceId: string): Promise<WalletEntry | null> {
    const row = await this.activeCurrencyOf('workspace', workspaceId);
    return row ? this.companyEntry(row, workspaceId) : null;
  }

  /** Pay an employee from the treasury (treasury → user) — a posted transfer; treasury can't go negative. */
  async payEmployee(workspaceId: string, userId: string, amount: number): Promise<WalletEntry> {
    const row = await this.activeCurrencyOf('workspace', workspaceId);
    if (!row) throw new BadRequestException('Сначала создайте валюту компании');
    await this.db.$transaction(async (tx) => {
      const treasury = await this.ledger.getOrCreateHolderAccount(tx, row.id, 'workspace', workspaceId);
      const employee = await this.ledger.getOrCreateHolderAccount(tx, row.id, 'user', userId);
      await this.ledger.transfer(tx, {
        currencyId: row.id,
        fromAccountId: treasury.id,
        toAccountId: employee.id,
        amount,
        memo: 'company payout',
      });
    });
    return this.companyEntry(row, workspaceId);
  }

  /** Holders of the company currency (employees), excluding the treasury. Issuer-only by construction. */
  async getCompanyHolders(workspaceId: string): Promise<CurrencyHolder[]> {
    const c = await this.activeCurrencyOf('workspace', workspaceId);
    if (!c) return [];
    const rows = await this.db.account.findMany({
      where: { currencyId: c.id, type: 'user', ownerType: 'user', balance: { not: 0n } },
    });
    const names = await this.userMinis(rows.map((r) => r.ownerId));
    return rows
      .map((r) => {
        const u = names.get(r.ownerId);
        return { userId: r.ownerId, name: u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—', avatar: u?.avatar ?? null, balance: Number(r.balance) };
      })
      .sort((a, b) => b.balance - a.balance);
  }

  private async companyEntry(currency: CurrencyRow, workspaceId: string): Promise<WalletEntry> {
    const bal = await this.ledger.getBalanceFor('workspace', workspaceId, currency.id);
    return {
      currencyId: currency.id,
      name: currency.name,
      icon: currency.icon,
      scale: currency.scale,
      issuerId: currency.issuerId,
      issuerName: '',
      balance: bal.balance,
      held: bal.held,
      available: bal.available,
      isOwn: true,
    };
  }

  private toCompanyDto(row: CurrencyRow): CurrencyDto {
    const nextAt = row.lastRenamedAt ? this.renameNextAt(row.lastRenamedAt) : null;
    return {
      id: row.id,
      issuerType: row.issuerType as IssuerType,
      issuerId: row.issuerId,
      name: row.name,
      icon: row.icon,
      scale: row.scale,
      currencyType: 'CUSTOM_COIN',
      status: row.status as CurrencyDto['status'],
      isOwner: true,
      renameAvailableAt: nextAt && nextAt.getTime() > Date.now() ? nextAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // ============================================================
  // Helpers
  // ============================================================

  /** Map a journal row to the user-facing entry type the wallet history renders. */
  private entryType(r: TransferRow): LedgerEntryType {
    switch (r.memo) {
      case 'mint':
        return 'mint';
      case 'burn':
        return 'burn';
      case 'currency deleted':
        return 'currency_deleted';
      case 'escrow return':
        return 'reversal';
      default:
        return 'transfer';
    }
  }

  private async walletEntry(currency: CurrencyRow, userId: string, isOwn: boolean): Promise<WalletEntry> {
    const bal = await this.ledger.getBalance(userId, currency.id);
    return {
      currencyId: currency.id,
      name: currency.name,
      icon: currency.icon,
      scale: currency.scale,
      issuerId: currency.issuerId,
      issuerName: '',
      balance: bal.balance,
      held: bal.held,
      available: bal.available,
      isOwn,
    };
  }

  private activeCurrencyOf(issuerType: IssuerType, issuerId: string): Promise<CurrencyRow | null> {
    return this.db.currency.findFirst({ where: { issuerType, issuerId, status: 'active' } });
  }

  private renameNextAt(lastRenamedAt: Date): Date {
    return new Date(lastRenamedAt.getTime() + WALLET_LIMITS.renameCooldownDays * 86_400_000);
  }

  private async userNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const users = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName ?? ''}`.trim()]));
  }

  private async userMinis(ids: string[]) {
    if (ids.length === 0) {
      return new Map<string, { firstName: string; lastName: string | null; avatar: string | null }>();
    }
    const users = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    return new Map(users.map((u) => [u.id, u]));
  }

  private toDto(row: CurrencyRow, viewerId: string): CurrencyDto {
    const nextAt = row.lastRenamedAt ? this.renameNextAt(row.lastRenamedAt) : null;
    return {
      id: row.id,
      issuerType: row.issuerType as IssuerType,
      issuerId: row.issuerId,
      name: row.name,
      icon: row.icon,
      scale: row.scale,
      currencyType: 'CUSTOM_COIN',
      status: row.status as CurrencyDto['status'],
      isOwner: row.issuerType === 'user' && row.issuerId === viewerId,
      renameAvailableAt: nextAt && nextAt.getTime() > Date.now() ? nextAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
