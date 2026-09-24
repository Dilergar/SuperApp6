import { Injectable } from '@nestjs/common';
import { Prisma, type Counterparty, type CounterpartyContact } from '@prisma/client';
import { SOURCE_LOCALE } from '@superapp/shared';
import {
  COUNTERPARTY_LIMITS,
  COUNTERPARTY_REF_TYPE,
  WORKSPACE_ROLE_RANK,
  counterpartyIdKey,
  type CounterpartyBankAccountDto,
  type CounterpartyContactDto,
  type CounterpartyDto,
  type CounterpartyKind,
  type CounterpartyLiteDto,
  type CreateCounterpartyBankAccountInput,
  composeSignBasis,
  signBasisColumnsOf,
  signBasisPartsOf,
  type SignBasisColumns,
  type SignBasisInput,
  type CreateCounterpartyContactInput,
  type CreateCounterpartyInput,
  type CursorPage,
  type ListCounterpartiesInput,
  type UpdateCounterpartyContactInput,
  type UpdateCounterpartyInput,
  type WorkspaceRole,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../../core/roles/roles.service';
import { ChatterService, type ChatterTrackSpec } from '../../core/chatter/chatter.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors/api-error';
import { fullNameOrNull } from '../../shared/utils/user-name';
import { VisibilityService, markShaped, type ShapeInput, type ShapedValues } from '../../core/visibility/visibility.service';


const WS_CONTEXT = 'workspace';

/**
 * Сервис «Контрагенты» (B2B) — ЕДИНЫЙ справочник внешних сторон организации.
 *
 * Потребители: «Документооборот» (внешний контур — договоры/АВР), дальше Счета,
 * Финансы B2B, ЭСФ, CRM — все читают отсюда, свой список не заводит никто.
 *
 * Доступ гейтится РОЛЬЮ (модель Staff): чтение — команда (trainee+, Подрядчик
 * изолирован), запись — Менеджер+. В core/access тип НЕ заводится намеренно —
 * пообъектных грантов у справочника нет, а кэшируемый check() по нему не зовётся.
 */
type AccountRow = { id: string; iban: string; bankName: string; bik: string; isPrimary: boolean; createdAt: Date };

@Injectable()
export class CounterpartiesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly roles: RolesService,
    private readonly chatter: ChatterService,
    private readonly i18n: I18nService,
    private readonly visibility: VisibilityService,
  ) {}

  /**
   * Отслеживаемые поля карточки — диффы «было → стало» в хронике. Строится на
   * каждый вызов, а не константой: СНАПШОТ подписи ложится в БД в языке
   * ИСТОЧНИКА и берётся из того же каталога, что показывает живую подпись.
   */
  private trackSpec(): ChatterTrackSpec<Counterparty> {
    const src = (field: string) => this.i18n.translateFor(SOURCE_LOCALE, `chatter.fields.counterparty.${field}`);
    const track = (field: keyof Counterparty, format: (r: Counterparty) => string | null) => ({
      typeKey: 'counterparty.updated',
      label: src(field as string),
      format,
    });
    return {
      name: track('name', (r) => r.name),
      legalName: track('legalName', (r) => r.legalName),
      bin: track('bin', (r) => r.bin),
      legalAddress: track('legalAddress', (r) => r.legalAddress),
      actualAddress: track('actualAddress', (r) => r.actualAddress),
      taxRegime: track('taxRegime', (r) => r.taxRegime),
      directorName: track('directorName', (r) => r.directorName),
      phone: track('phone', (r) => r.phone),
      email: track('email', (r) => r.email),
    };
  }

  /**
   * Основание подписи ЭКРАНУ — в языке зрителя: на карточке его читает человек.
   * В документ та же структура попадает через группу полей шаблона, и там
   * фраза собирается заново, в языке БЛАНКА (`counterparties-registries`).
   */
  private signBasisText(row: SignBasisColumns): string | null {
    return composeSignBasis(
      signBasisPartsOf(row),
      (key, values) => this.i18n.translate(`counterparties.${key}`, values),
      (iso) => this.i18n.format().date(iso),
    );
  }


  // ============================================================
  // Гейты (модель Staff/Documents)
  // ============================================================

  private async roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (roles.length === 0) return null;
    return roles
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b] ?? 0) - (WORKSPACE_ROLE_RANK[a] ?? 0))[0];
  }

  /** Чтение справочника — команда; Подрядчик изолирован. */
  private async requireTeam(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.roleOf(userId, workspaceId);
    if (!role) throw forbidden('workspace.noAccess');
    if (role === 'contractor') throw forbidden('counterparties.contractorNoAccess');
    return role;
  }

  /** Запись (карточки, контакты, счета) — Менеджер+. */
  private async requireManager(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.requireTeam(userId, workspaceId);
    if ((WORKSPACE_ROLE_RANK[role] ?? 0) < WORKSPACE_ROLE_RANK.manager) {
      throw forbidden('counterparties.managerRequired');
    }
    return role;
  }

  // ============================================================
  // Справочник
  // ============================================================

  /**
   * Список: keyset по (name, id) — справочник читается по алфавиту. Архив
   * скрыт по умолчанию; `archived=true` показывает только архив.
   */
  async list(
    userId: string,
    workspaceId: string,
    q: ListCounterpartiesInput,
  ): Promise<CursorPage<CounterpartyDto>> {
    await this.requireTeam(userId, workspaceId);

    const filters: Prisma.CounterpartyWhereInput[] = [
      { workspaceId },
      q.archived ? { archivedAt: { not: null } } : { archivedAt: null },
    ];
    if (q.kind) filters.push({ kind: q.kind });
    if (q.orgForm) filters.push({ orgForm: q.orgForm });
    if (q.search) {
      filters.push({
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { legalName: { contains: q.search, mode: 'insensitive' } },
          { bin: { contains: q.search } },
        ],
      });
    }
    if (q.cursor) {
      // Курсор составной «name|id»: у близнецов по имени страница не теряется
      const sep = q.cursor.lastIndexOf('|');
      if (sep > 0) {
        const cName = q.cursor.slice(0, sep);
        const cId = q.cursor.slice(sep + 1);
        filters.push({ OR: [{ name: { gt: cName } }, { name: cName, id: { gt: cId } }] });
      }
    }

    const rows = await this.db.counterparty.findMany({
      where: { AND: filters },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: q.limit + 1,
      include: { contacts: { where: { archivedAt: null } }, bankAccounts: true },
    });
    const page = rows.slice(0, q.limit);
    const counts = await this.documentCounts(page.map((r) => r.id));
    return {
      items: await this.serializeMany(
        workspaceId,
        page.map((r) => ({ row: r, contacts: r.contacts, accounts: r.bankAccounts, documentsCount: counts.get(r.id) ?? 0 })),
      ),
      nextCursor: rows.length > q.limit ? `${page[page.length - 1].name}|${page[page.length - 1].id}` : null,
    };
  }

  /**
   * Поиск по БИН/ИИН — дедуп в форме («такой контрагент уже есть — открыть его»).
   * Ищем СРЕДИ ЖИВЫХ: архивная карточка номер отпускает.
   */
  async lookup(userId: string, workspaceId: string, bin: string): Promise<CounterpartyLiteDto | null> {
    await this.requireTeam(userId, workspaceId);
    const row = await this.db.counterparty.findFirst({
      where: { workspaceId, bin: bin.trim(), archivedAt: null },
    });
    return row ? this.lite(row) : null;
  }

  async get(userId: string, workspaceId: string, counterpartyId: string): Promise<CounterpartyDto> {
    await this.requireTeam(userId, workspaceId);
    const row = await this.rowOrThrow(workspaceId, counterpartyId, { includeArchived: true });
    const [contacts, accounts, counts] = await Promise.all([
      this.db.counterpartyContact.findMany({
        where: { counterpartyId: row.id, archivedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.counterpartyBankAccount.findMany({
        where: { counterpartyId: row.id },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      }),
      this.documentCounts([row.id]),
    ]);
    return (await this.serializeMany(workspaceId, [{ row, contacts, accounts, documentsCount: counts.get(row.id) ?? 0 }]))[0]!;
  }

  async create(userId: string, workspaceId: string, dto: CreateCounterpartyInput): Promise<CounterpartyDto> {
    await this.requireManager(userId, workspaceId);
    await this.assertWritable(workspaceId, workspaceId, { phone: dto.phone, email: dto.email });
    // Лимит ДО создания (правило платформы): считаем живых
    const count = await this.db.counterparty.count({ where: { workspaceId, archivedAt: null } });
    if (count >= COUNTERPARTY_LIMITS.maxPerWorkspace) {
      throw badRequest('counterparties.limitReached');
    }
    try {
      const row = await this.db.$transaction(async (tx) => {
        const created = await tx.counterparty.create({
          data: {
            workspaceId,
            kind: dto.kind ?? 'legal',
            name: dto.name,
            legalName: dto.legalName ?? null,
            bin: dto.bin ?? null,
            orgForm: dto.orgForm ?? null,
            legalAddress: dto.legalAddress ?? null,
            actualAddress: dto.actualAddress ?? null,
            kbe: dto.kbe ?? null,
            taxRegime: dto.taxRegime ?? null,
            vatPayer: dto.vatPayer ?? false,
            vatSeries: dto.vatSeries ?? null,
            vatNumber: dto.vatNumber ?? null,
            vatDate: dto.vatDate ? new Date(dto.vatDate) : null,
            directorName: dto.directorName ?? null,
            ...signBasisColumnsOf(dto.signBasis),
            phone: dto.phone ?? null,
            email: dto.email ?? null,
            comment: dto.comment ?? null,
            createdById: userId,
          },
        });
        await this.chatter.log(tx, {
          refType: COUNTERPARTY_REF_TYPE,
          refId: created.id,
          workspaceId,
          actorId: userId,
          actorName: await this.nameOf(userId),
          typeKey: 'counterparty.created',
          payload: { name: created.name },
        });
        return created;
      });
      return this.get(userId, workspaceId, row.id);
    } catch (err) {
      this.rethrowBinConflict(err, (dto.kind ?? 'legal') as CounterpartyKind);
      throw err;
    }
  }

  async update(
    userId: string,
    workspaceId: string,
    counterpartyId: string,
    dto: UpdateCounterpartyInput,
  ): Promise<CounterpartyDto> {
    await this.requireManager(userId, workspaceId);
    const before = await this.rowOrThrow(workspaceId, counterpartyId);
    await this.assertWritable(workspaceId, before.id, { phone: dto.phone, email: dto.email });
    try {
      await this.db.$transaction(async (tx) => {
        const after = await tx.counterparty.update({
          where: { id: before.id },
          data: {
            ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.legalName !== undefined ? { legalName: dto.legalName } : {}),
            ...(dto.bin !== undefined ? { bin: dto.bin } : {}),
            ...(dto.orgForm !== undefined ? { orgForm: dto.orgForm } : {}),
            ...(dto.legalAddress !== undefined ? { legalAddress: dto.legalAddress } : {}),
            ...(dto.actualAddress !== undefined ? { actualAddress: dto.actualAddress } : {}),
            ...(dto.kbe !== undefined ? { kbe: dto.kbe } : {}),
            ...(dto.taxRegime !== undefined ? { taxRegime: dto.taxRegime } : {}),
            ...(dto.vatPayer !== undefined ? { vatPayer: dto.vatPayer } : {}),
            ...(dto.vatSeries !== undefined ? { vatSeries: dto.vatSeries } : {}),
            ...(dto.vatNumber !== undefined ? { vatNumber: dto.vatNumber } : {}),
            ...(dto.vatDate !== undefined ? { vatDate: dto.vatDate ? new Date(dto.vatDate) : null } : {}),
            ...(dto.directorName !== undefined ? { directorName: dto.directorName } : {}),
            ...(dto.signBasis !== undefined
              ? signBasisColumnsOf(dto.signBasis)
              : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
            ...(dto.email !== undefined ? { email: dto.email } : {}),
            ...(dto.comment !== undefined ? { comment: dto.comment } : {}),
          },
        });
        // Диффы «было → стало» — по единой спеке; пустой дифф не пишется вовсе
        const diffs = this.chatter.diffTracked(this.trackSpec(), before, after);
        if (diffs.length) {
          const actorName = await this.nameOf(userId);
          await this.chatter.logMany(
            tx,
            diffs.map((d) => ({
              refType: COUNTERPARTY_REF_TYPE,
              refId: before.id,
              workspaceId,
              actorId: userId,
              actorName,
              typeKey: d.typeKey,
              changes: [d.change],
            })),
          );
        }
      });
      return this.get(userId, workspaceId, before.id);
    } catch (err) {
      this.rethrowBinConflict(err, (dto.kind ?? before.kind) as CounterpartyKind);
      throw err;
    }
  }

  /**
   * Архив вместо удаления: на карточке висят документы (юридические записи).
   * Живые документы С НИМ в работе (`in_review`, `sent`) архив блокируют — идущий
   * процесс не должен терять справочник под собой.
   */
  async archive(userId: string, workspaceId: string, counterpartyId: string): Promise<void> {
    await this.requireManager(userId, workspaceId);
    const row = await this.rowOrThrow(workspaceId, counterpartyId);
    const live = await this.db.orgDocument.count({
      where: { workspaceId, counterpartyId: row.id, status: { in: ['in_review', 'sent'] } },
    });
    if (live > 0) {
      throw badRequest('counterparties.documentsInWork');
    }
    await this.db.$transaction(async (tx) => {
      const claimed = await tx.counterparty.updateMany({
        where: { id: row.id, archivedAt: null },
        data: { archivedAt: new Date() },
      });
      if (claimed.count === 0) return;
      await this.chatter.log(tx, {
        refType: COUNTERPARTY_REF_TYPE,
        refId: row.id,
        workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'counterparty.archived',
        payload: { name: row.name },
      });
    });
  }

  /**
   * Вернуть из архива. Архив — жизненный цикл справочника, а не удаление, поэтому
   * возврат обязан быть (прецедент архива организаций). Два условия проверяются
   * ЗАНОВО, потому что за время в архиве мир изменился:
   *  - потолок справочника (иначе возвратом обходится лимит создания);
   *  - БИН/ИИН: партиальный уникум считает только ЖИВЫХ, и пока карточка лежала
   *    в архиве, её номер мог занять другой контрагент → честный 409.
   */
  async restore(userId: string, workspaceId: string, counterpartyId: string): Promise<CounterpartyDto> {
    await this.requireManager(userId, workspaceId);
    const row = await this.rowOrThrow(workspaceId, counterpartyId, { includeArchived: true });
    if (!row.archivedAt) return this.get(userId, workspaceId, row.id);

    const live = await this.db.counterparty.count({ where: { workspaceId, archivedAt: null } });
    if (live >= COUNTERPARTY_LIMITS.maxPerWorkspace) {
      throw badRequest('counterparties.limitReached');
    }
    try {
      await this.db.$transaction(async (tx) => {
        const claimed = await tx.counterparty.updateMany({
          where: { id: row.id, archivedAt: { not: null } },
          data: { archivedAt: null },
        });
        if (claimed.count === 0) return; // гонка: кто-то уже вернул
        await this.chatter.log(tx, {
          refType: COUNTERPARTY_REF_TYPE,
          refId: row.id,
          workspaceId,
          actorId: userId,
          actorName: await this.nameOf(userId),
          typeKey: 'counterparty.restored',
          payload: { name: row.name },
        });
      });
    } catch (err) {
      this.rethrowBinConflict(err, row.kind as CounterpartyKind);
      throw err;
    }
    return this.get(userId, workspaceId, row.id);
  }

  // ============================================================
  // Контактные лица
  // ============================================================

  async addContact(
    userId: string,
    workspaceId: string,
    counterpartyId: string,
    dto: CreateCounterpartyContactInput,
  ): Promise<CounterpartyContactDto> {
    await this.requireManager(userId, workspaceId);
    const parent = await this.rowOrThrow(workspaceId, counterpartyId);
    await this.assertWritable(workspaceId, parent.id, { contactPhone: dto.phone, contactEmail: dto.email });
    const count = await this.db.counterpartyContact.count({
      where: { counterpartyId: parent.id, archivedAt: null },
    });
    if (count >= COUNTERPARTY_LIMITS.maxContactsPerCounterparty) {
      throw badRequest('counterparties.tooManyContacts');
    }
    const created = await this.db.$transaction(async (tx) => {
      const row = await tx.counterpartyContact.create({
        data: {
          counterpartyId: parent.id,
          workspaceId,
          name: dto.name,
          position: dto.position ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
        },
      });
      await this.chatter.log(tx, {
        refType: COUNTERPARTY_REF_TYPE,
        refId: parent.id,
        workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'counterparty.contact_added',
        payload: { contactName: row.name },
      });
      return row;
    });
    return this.contactFor(workspaceId, created);
  }

  async updateContact(
    userId: string,
    workspaceId: string,
    counterpartyId: string,
    contactId: string,
    dto: UpdateCounterpartyContactInput,
  ): Promise<CounterpartyContactDto> {
    await this.requireManager(userId, workspaceId);
    const contact = await this.contactOrThrow(workspaceId, counterpartyId, contactId);
    await this.assertWritable(workspaceId, contact.id, { contactPhone: dto.phone, contactEmail: dto.email });
    const row = await this.db.counterpartyContact.update({
      where: { id: contact.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
      },
    });
    return this.contactFor(workspaceId, row);
  }

  /**
   * Контакт УХОДИТ В АРХИВ, а не удаляется: на него ссылаются документы
   * (`counterpartyContactId` без FK), и его имя обязано читаться в их истории.
   */
  async removeContact(
    userId: string,
    workspaceId: string,
    counterpartyId: string,
    contactId: string,
  ): Promise<void> {
    await this.requireManager(userId, workspaceId);
    const contact = await this.contactOrThrow(workspaceId, counterpartyId, contactId);
    await this.db.$transaction(async (tx) => {
      const claimed = await tx.counterpartyContact.updateMany({
        where: { id: contact.id, archivedAt: null },
        data: { archivedAt: new Date() },
      });
      if (claimed.count === 0) return;
      await this.chatter.log(tx, {
        refType: COUNTERPARTY_REF_TYPE,
        refId: counterpartyId,
        workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'counterparty.contact_removed',
        payload: { contactName: contact.name },
      });
    });
  }

  // ============================================================
  // Банковские счета (клон WorkspaceBankAccount: список с основным)
  // ============================================================

  async addBankAccount(
    userId: string,
    workspaceId: string,
    counterpartyId: string,
    dto: CreateCounterpartyBankAccountInput,
  ): Promise<CounterpartyBankAccountDto> {
    await this.requireManager(userId, workspaceId);
    const parent = await this.rowOrThrow(workspaceId, counterpartyId);
    await this.assertWritable(workspaceId, parent.id, { iban: dto.iban });
    const count = await this.db.counterpartyBankAccount.count({ where: { counterpartyId: parent.id } });
    if (count >= COUNTERPARTY_LIMITS.maxBankAccountsPerCounterparty) {
      throw badRequest('counterparties.tooManyAccounts');
    }
    const row = await this.db.$transaction(async (tx) => {
      // Первый счёт — основной сам; явный isPrimary снимает роль с остальных
      const makePrimary = dto.isPrimary || count === 0;
      if (makePrimary) {
        await tx.counterpartyBankAccount.updateMany({
          where: { counterpartyId: parent.id },
          data: { isPrimary: false },
        });
      }
      return tx.counterpartyBankAccount.create({
        data: {
          counterpartyId: parent.id,
          // Скоуп KEK шифрования IBAN — организация (денормализация, как у контактных лиц)
          workspaceId: parent.workspaceId,
          iban: dto.iban,
          bankName: dto.bankName,
          bik: dto.bik,
          isPrimary: makePrimary,
        },
      });
    });
    return this.accountFor(workspaceId, row);
  }

  async setPrimaryBankAccount(
    userId: string,
    workspaceId: string,
    counterpartyId: string,
    accountId: string,
  ): Promise<void> {
    await this.requireManager(userId, workspaceId);
    await this.rowOrThrow(workspaceId, counterpartyId);
    const account = await this.db.counterpartyBankAccount.findFirst({
      where: { id: accountId, counterpartyId },
    });
    if (!account) throw notFound('counterparties.accountNotFound');
    await this.db.$transaction(async (tx) => {
      await tx.counterpartyBankAccount.updateMany({ where: { counterpartyId }, data: { isPrimary: false } });
      await tx.counterpartyBankAccount.update({ where: { id: account.id }, data: { isPrimary: true } });
    });
  }

  /** Удаление основного передаёт роль старейшему из оставшихся */
  async removeBankAccount(
    userId: string,
    workspaceId: string,
    counterpartyId: string,
    accountId: string,
  ): Promise<void> {
    await this.requireManager(userId, workspaceId);
    await this.rowOrThrow(workspaceId, counterpartyId);
    const account = await this.db.counterpartyBankAccount.findFirst({
      where: { id: accountId, counterpartyId },
    });
    if (!account) throw notFound('counterparties.accountNotFound');
    await this.db.$transaction(async (tx) => {
      await tx.counterpartyBankAccount.delete({ where: { id: account.id } });
      if (account.isPrimary) {
        const oldest = await tx.counterpartyBankAccount.findFirst({
          where: { counterpartyId },
          orderBy: { createdAt: 'asc' },
        });
        if (oldest) {
          await tx.counterpartyBankAccount.update({ where: { id: oldest.id }, data: { isPrimary: true } });
        }
      }
    });
  }

  // ============================================================
  // Сервисный API потребителям (Документооборот, дальше — Счета)
  // ============================================================

  /**
   * Контрагент ЭТОЙ организации для привязки к документу. Контракт `assert*`:
   * право звонящего проверил вызывающий сервис — здесь только принадлежность
   * и жизнеспособность (архивному новый документ не заводится).
   */
  async assertUsable(workspaceId: string, counterpartyId: string): Promise<Counterparty> {
    const row = await this.db.counterparty.findFirst({ where: { id: counterpartyId, workspaceId } });
    if (!row) throw notFound('counterparties.notFoundInWorkspace');
    if (row.archivedAt) throw badRequest('counterparties.archived');
    return row;
  }

  /** Контакт принадлежит контрагенту и жив (для нового документа/отправки) */
  async assertContactUsable(counterpartyId: string, contactId: string): Promise<CounterpartyContact> {
    const row = await this.db.counterpartyContact.findFirst({
      where: { id: contactId, counterpartyId },
    });
    if (!row) throw notFound('counterparties.contactNotFoundHere');
    if (row.archivedAt) throw badRequest('counterparties.contactArchived');
    return row;
  }

  /** Лайт-срезы батчем — для реестра документов (без N+1) */
  async litesFor(ids: string[]): Promise<Map<string, CounterpartyLiteDto>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await this.db.counterparty.findMany({ where: { id: { in: unique } } });
    return new Map(rows.map((r) => [r.id, this.lite(r)]));
  }

  /** Контакты батчем — узкий срез для карточек документов */
  async contactRefsFor(ids: string[]): Promise<Map<string, { id: string; name: string; position: string | null; phone: string | null }>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await this.db.counterpartyContact.findMany({ where: { id: { in: unique } } });
    return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, position: r.position, phone: r.phone }]));
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  /** P2002 по партиальному уникуму БИН → человеческий 409 с подсказкой */
  private rethrowBinConflict(err: unknown, kind: CounterpartyKind): void {
    if ((err as Prisma.PrismaClientKnownRequestError)?.code === 'P2002') {
      // Подпись идентификатора — слово языка ЗАПРОСА: отказ читает человек
      throw conflict('counterparties.idTaken', {
        id: this.i18n.translate(`counterparties.idLabel.${counterpartyIdKey(kind)}`),
      });
    }
  }

  private async rowOrThrow(
    workspaceId: string,
    counterpartyId: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<Counterparty> {
    const row = await this.db.counterparty.findFirst({
      where: {
        id: counterpartyId,
        workspaceId,
        ...(opts.includeArchived ? {} : { archivedAt: null }),
      },
    });
    if (!row) throw notFound('counterparties.notFound');
    return row;
  }

  private async contactOrThrow(workspaceId: string, counterpartyId: string, contactId: string) {
    const row = await this.db.counterpartyContact.findFirst({
      where: { id: contactId, counterpartyId, workspaceId, archivedAt: null },
    });
    if (!row) throw notFound('counterparties.contactNotFound');
    return row;
  }

  /** Сколько документов заведено с контрагентами страницы — одним groupBy */
  private async documentCounts(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.db.orgDocument.groupBy({
      by: ['counterpartyId'],
      where: { counterpartyId: { in: ids } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.counterpartyId as string, r._count._all]));
  }

  private async nameOf(userId: string): Promise<string | null> {
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return fullNameOrNull(u);
  }

  private lite(row: Counterparty): CounterpartyLiteDto {
    return { id: row.id, kind: row.kind as CounterpartyKind, name: row.name, bin: row.bin };
  }

  /**
   * Нельзя записать то, чего не видишь (W, core/visibility): контакты и IBAN — поля типа
   * `counterparty`; маска в теле — 400, скрытое правилами — 403 с кодом.
   */
  private async assertWritable(workspaceId: string, recordId: string, patch: Record<string, unknown>): Promise<void> {
    await this.visibility.assertWritable(this.visibility.viewer('api', { workspaceId }), 'counterparty', { recordId, subjectId: null, workspaceId }, patch);
  }

  /**
   * Контрагенты ГЛАЗАМИ ЗРИТЕЛЯ (core/visibility, `counterparty`): телефон, e-mail, контакты
   * лиц и IBAN — правила организации (по умолчанию стажёру и сотруднику — маской). Реквизиты
   * для договора — пол записи. Одна проекция на страницу: записи, их контакты и счета.
   */
  private async serializeMany(
    workspaceId: string,
    items: Array<{ row: Counterparty; contacts: CounterpartyContact[]; accounts: AccountRow[]; documentsCount: number }>,
  ): Promise<CounterpartyDto[]> {
    const inputs: ShapeInput[] = [];
    const ref = (recordId: string) => ({ recordId, subjectId: null, workspaceId });
    for (const it of items) {
      inputs.push({ ref: ref(it.row.id), values: { phone: it.row.phone, email: it.row.email } });
      for (const c of it.contacts) inputs.push({ ref: ref(c.id), values: { contactPhone: c.phone, contactEmail: c.email } });
      for (const a of it.accounts) inputs.push({ ref: ref(a.id), values: { iban: a.iban } });
    }
    const shaped = await this.visibility.shape(this.visibility.viewer('api', { workspaceId }), 'counterparty', inputs);
    let k = 0;
    return items.map((it) => {
      const own = shaped[k++]!;
      const contacts = it.contacts.map((c) => this.serializeContact(c, shaped[k++]!));
      const accounts = it.accounts.map((a) => this.serializeAccount(a, shaped[k++]!));
      return markShaped(this.serialize(it.row, own, contacts, accounts, it.documentsCount));
    });
  }

  private async contactFor(workspaceId: string, row: CounterpartyContact): Promise<CounterpartyContactDto> {
    const [v] = await this.visibility.shape(this.visibility.viewer('api', { workspaceId }), 'counterparty', [
      { ref: { recordId: row.id, subjectId: null, workspaceId }, values: { contactPhone: row.phone, contactEmail: row.email } },
    ]);
    return this.serializeContact(row, v!);
  }

  private async accountFor(workspaceId: string, row: AccountRow): Promise<CounterpartyBankAccountDto> {
    const [v] = await this.visibility.shape(this.visibility.viewer('api', { workspaceId }), 'counterparty', [
      { ref: { recordId: row.id, subjectId: null, workspaceId }, values: { iban: row.iban } },
    ]);
    return this.serializeAccount(row, v!);
  }

  private serialize(
    row: Counterparty,
    v: ShapedValues,
    contacts: CounterpartyContactDto[],
    accounts: CounterpartyBankAccountDto[],
    documentsCount: number,
  ): CounterpartyDto {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      kind: row.kind as CounterpartyKind,
      name: row.name,
      legalName: row.legalName,
      bin: row.bin,
      orgForm: row.orgForm,
      legalAddress: row.legalAddress,
      actualAddress: row.actualAddress,
      kbe: row.kbe,
      taxRegime: row.taxRegime,
      vatPayer: row.vatPayer,
      vatSeries: row.vatSeries,
      vatNumber: row.vatNumber,
      vatDate: row.vatDate ? row.vatDate.toISOString().slice(0, 10) : null,
      directorName: row.directorName,
      // Фраза для экрана — в языке зрителя; хранится структура
      signBasis: this.signBasisText(row),
      signBasisParts: signBasisPartsOf(row),
      phone: v.phone as CounterpartyDto['phone'],
      email: v.email as CounterpartyDto['email'],
      comment: row.comment,
      createdById: row.createdById,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      documentsCount,
      contacts,
      bankAccounts: accounts,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private serializeContact(row: CounterpartyContact, v: ShapedValues): CounterpartyContactDto {
    return markShaped({
      id: row.id,
      counterpartyId: row.counterpartyId,
      name: row.name,
      position: row.position,
      phone: v.contactPhone as CounterpartyContactDto['phone'],
      email: v.contactEmail as CounterpartyContactDto['email'],
      createdAt: row.createdAt.toISOString(),
    });
  }

  private serializeAccount(row: AccountRow, v: ShapedValues): CounterpartyBankAccountDto {
    return {
      id: row.id,
      iban: v.iban as CounterpartyBankAccountDto['iban'],
      bankName: row.bankName,
      bik: row.bik,
      isPrimary: row.isPrimary,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
