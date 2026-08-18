import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Counterparty, type CounterpartyContact } from '@prisma/client';
import {
  COUNTERPARTY_LIMITS,
  COUNTERPARTY_REF_TYPE,
  WORKSPACE_ROLE_RANK,
  counterpartyIdLabel,
  type CounterpartyBankAccountDto,
  type CounterpartyContactDto,
  type CounterpartyDto,
  type CounterpartyKind,
  type CounterpartyLiteDto,
  type CreateCounterpartyBankAccountInput,
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
import { fullName } from '../../shared/utils/user-name';

const WS_CONTEXT = 'workspace';

/** Отслеживаемые поля карточки — диффы «было → стало» в хронике */
const TRACK_SPEC: ChatterTrackSpec<Counterparty> = {
  name: { typeKey: 'counterparty.updated', label: 'Название', format: (r) => r.name },
  legalName: { typeKey: 'counterparty.updated', label: 'Юрнаименование', format: (r) => r.legalName },
  bin: { typeKey: 'counterparty.updated', label: 'БИН/ИИН', format: (r) => r.bin },
  legalAddress: { typeKey: 'counterparty.updated', label: 'Юрадрес', format: (r) => r.legalAddress },
  actualAddress: { typeKey: 'counterparty.updated', label: 'Фактический адрес', format: (r) => r.actualAddress },
  taxRegime: { typeKey: 'counterparty.updated', label: 'Налоговый режим', format: (r) => r.taxRegime },
  directorName: { typeKey: 'counterparty.updated', label: 'Руководитель', format: (r) => r.directorName },
  phone: { typeKey: 'counterparty.updated', label: 'Телефон', format: (r) => r.phone },
  email: { typeKey: 'counterparty.updated', label: 'E-mail', format: (r) => r.email },
};

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
@Injectable()
export class CounterpartiesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly roles: RolesService,
    private readonly chatter: ChatterService,
  ) {}

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
    if (!role) throw new ForbiddenException('Нет доступа к этой организации');
    if (role === 'contractor') throw new ForbiddenException('Подрядчику справочник контрагентов недоступен');
    return role;
  }

  /** Запись (карточки, контакты, счета) — Менеджер+. */
  private async requireManager(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.requireTeam(userId, workspaceId);
    if ((WORKSPACE_ROLE_RANK[role] ?? 0) < WORKSPACE_ROLE_RANK.manager) {
      throw new ForbiddenException('Недостаточно прав (нужен Менеджер или выше)');
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
      items: page.map((r) => this.serialize(r, r.contacts, r.bankAccounts, counts.get(r.id) ?? 0)),
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
    return this.serialize(row, contacts, accounts, counts.get(row.id) ?? 0);
  }

  async create(userId: string, workspaceId: string, dto: CreateCounterpartyInput): Promise<CounterpartyDto> {
    await this.requireManager(userId, workspaceId);
    // Лимит ДО создания (правило платформы): считаем живых
    const count = await this.db.counterparty.count({ where: { workspaceId, archivedAt: null } });
    if (count >= COUNTERPARTY_LIMITS.maxPerWorkspace) {
      throw new BadRequestException('Достигнут предел контрагентов в организации');
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
            signBasis: dto.signBasis ?? null,
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
            ...(dto.signBasis !== undefined ? { signBasis: dto.signBasis } : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
            ...(dto.email !== undefined ? { email: dto.email } : {}),
            ...(dto.comment !== undefined ? { comment: dto.comment } : {}),
          },
        });
        // Диффы «было → стало» — по единой спеке; пустой дифф не пишется вовсе
        const diffs = this.chatter.diffTracked(TRACK_SPEC, before, after);
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
      throw new BadRequestException('С контрагентом есть документы в работе — сначала завершите их');
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
      throw new BadRequestException('Достигнут предел контрагентов в организации');
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
    const count = await this.db.counterpartyContact.count({
      where: { counterpartyId: parent.id, archivedAt: null },
    });
    if (count >= COUNTERPARTY_LIMITS.maxContactsPerCounterparty) {
      throw new BadRequestException('Слишком много контактных лиц у контрагента');
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
    return this.serializeContact(created);
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
    const row = await this.db.counterpartyContact.update({
      where: { id: contact.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
      },
    });
    return this.serializeContact(row);
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
    const count = await this.db.counterpartyBankAccount.count({ where: { counterpartyId: parent.id } });
    if (count >= COUNTERPARTY_LIMITS.maxBankAccountsPerCounterparty) {
      throw new BadRequestException('Слишком много счетов у контрагента');
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
          iban: dto.iban,
          bankName: dto.bankName,
          bik: dto.bik,
          isPrimary: makePrimary,
        },
      });
    });
    return this.serializeAccount(row);
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
    if (!account) throw new NotFoundException('Счёт не найден');
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
    if (!account) throw new NotFoundException('Счёт не найден');
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
    if (!row) throw new NotFoundException('Контрагент не найден в этой организации');
    if (row.archivedAt) throw new BadRequestException('Контрагент в архиве — верните его или выберите другого');
    return row;
  }

  /** Контакт принадлежит контрагенту и жив (для нового документа/отправки) */
  async assertContactUsable(counterpartyId: string, contactId: string): Promise<CounterpartyContact> {
    const row = await this.db.counterpartyContact.findFirst({
      where: { id: contactId, counterpartyId },
    });
    if (!row) throw new NotFoundException('Контактное лицо не найдено у этого контрагента');
    if (row.archivedAt) throw new BadRequestException('Контактное лицо в архиве — выберите другое');
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
      throw new ConflictException(
        `Контрагент с таким ${counterpartyIdLabel(kind)} уже есть в справочнике`,
      );
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
    if (!row) throw new NotFoundException('Контрагент не найден');
    return row;
  }

  private async contactOrThrow(workspaceId: string, counterpartyId: string, contactId: string) {
    const row = await this.db.counterpartyContact.findFirst({
      where: { id: contactId, counterpartyId, workspaceId, archivedAt: null },
    });
    if (!row) throw new NotFoundException('Контактное лицо не найдено');
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

  private async nameOf(userId: string): Promise<string> {
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return fullName(u);
  }

  private lite(row: Counterparty): CounterpartyLiteDto {
    return { id: row.id, kind: row.kind as CounterpartyKind, name: row.name, bin: row.bin };
  }

  private serialize(
    row: Counterparty,
    contacts: CounterpartyContact[],
    accounts: { id: string; iban: string; bankName: string; bik: string; isPrimary: boolean; createdAt: Date }[],
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
      signBasis: row.signBasis,
      phone: row.phone,
      email: row.email,
      comment: row.comment,
      createdById: row.createdById,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      documentsCount,
      contacts: contacts.map((c) => this.serializeContact(c)),
      bankAccounts: accounts.map((a) => this.serializeAccount(a)),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private serializeContact(row: CounterpartyContact): CounterpartyContactDto {
    return {
      id: row.id,
      counterpartyId: row.counterpartyId,
      name: row.name,
      position: row.position,
      phone: row.phone,
      email: row.email,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private serializeAccount(row: {
    id: string;
    iban: string;
    bankName: string;
    bik: string;
    isPrimary: boolean;
    createdAt: Date;
  }): CounterpartyBankAccountDto {
    return {
      id: row.id,
      iban: row.iban,
      bankName: row.bankName,
      bik: row.bik,
      isPrimary: row.isPrimary,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
