import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../../core/roles/roles.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { fullName } from '../../shared/utils/user-name';
import {
  LEGAL_ENTITY_ERROR_CODES,
  LEGAL_ENTITY_LIMITS,
  REQUISITE_LIMITS,
  WORKSPACE_ROLE_RANK,
  type CreateLegalEntityInput,
  type CreateBankAccountInput,
  type LegalEntityDto,
  type LegalEntityLiteDto,
  type UpdateBankAccountInput,
  type UpdateLegalEntityInput,
  type WorkspaceRole,
} from '@superapp/shared';

type Tx = Prisma.TransactionClient;
/**
 * Поля-реквизиты для create И update. Prisma-шный `…UncheckedUpdateInput` разрешает
 * операторы ({ set }), и такой объект нельзя разложить в `create` — берём подмножество
 * скалярных полей, годное обеим операциям.
 */
type RequisiteData = Partial<
  Pick<
    Prisma.LegalEntityUncheckedCreateInput,
    | 'orgForm'
    | 'taxRegime'
    | 'legalName'
    | 'bin'
    | 'legalAddress'
    | 'kbe'
    | 'vatSeries'
    | 'vatNumber'
    | 'vatPayer'
    | 'vatDate'
    | 'directorUserId'
    | 'signBasis'
  >
>;
type DbLike = DatabaseService | Tx;

const WS_CONTEXT = 'workspace';
const ROLE_RANK = WORKSPACE_ROLE_RANK;

/** Поля-реквизиты, общие у юрлица и старой ручки /requisites. */
const REQUISITE_KEYS = [
  'orgForm',
  'taxRegime',
  'legalName',
  'bin',
  'legalAddress',
  'kbe',
  'vatSeries',
  'vatNumber',
  'directorUserId',
  'signBasis',
] as const;

/**
 * Юрлица организации: список ТОО/ИП, каждое со своими реквизитами и счетами.
 *
 * Головное (isHead) существует ВСЕГДА — его отдаёт старая ручка `/requisites`, на него
 * по умолчанию садятся объекты и трудовые договоры. Самолечение `ensureHeadLegalEntity`
 * по образцу `StaffService.ensureDefaultBranch`: организация, созданная до миграции или
 * потерявшая строку, чинится первым же обращением.
 *
 * Удаления нет — только архив: на юрлицо ссылаются трудовые карточки (FK Restrict),
 * объекты и напечатанные документы.
 */
@Injectable()
export class LegalEntitiesService {
  constructor(
    private db: DatabaseService,
    private roles: RolesService,
    private chatter: ChatterService,
  ) {}

  // ============================================================
  // Головное юрлицо: самолечение и чтение
  // ============================================================

  /**
   * Гарантирует головное юрлицо организации. Идемпотентно: гонка двух вызовов
   * упирается в партиальный уникум `legal_entities_head_per_workspace_key` —
   * конфликт ловим и перечитываем.
   */
  async ensureHeadLegalEntity(workspaceId: string, tx?: Tx): Promise<{ id: string; name: string }> {
    const db: DbLike = tx ?? this.db;
    const found = await db.legalEntity.findFirst({
      where: { workspaceId, isHead: true },
      select: { id: true, name: true },
    });
    if (found) return found;

    const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
    if (!ws) throw new NotFoundException('Организация не найдена');
    try {
      return await db.legalEntity.create({
        data: { workspaceId, name: ws.name, isHead: true },
        select: { id: true, name: true },
      });
    } catch {
      const again = await db.legalEntity.findFirst({
        where: { workspaceId, isHead: true },
        select: { id: true, name: true },
      });
      if (!again) throw new ConflictException('Не удалось создать головное юрлицо');
      return again;
    }
  }

  /** Головное юрлицо (id) — короткий путь для сервисов. */
  async headLegalEntityId(workspaceId: string, tx?: Tx): Promise<string> {
    return (await this.ensureHeadLegalEntity(workspaceId, tx)).id;
  }

  /**
   * Валидирует явно переданное юрлицо и подставляет головное, если не передано.
   * Живое (не архивное) — договоры на архивное не заключаются.
   */
  async resolveLegalEntityId(
    workspaceId: string,
    legalEntityId: string | null | undefined,
    tx?: Tx,
  ): Promise<string> {
    if (!legalEntityId) return this.headLegalEntityId(workspaceId, tx);
    const db: DbLike = tx ?? this.db;
    const le = await db.legalEntity.findFirst({
      where: { id: legalEntityId, workspaceId },
      select: { id: true, archivedAt: true },
    });
    if (!le) throw new NotFoundException('Юрлицо не найдено');
    if (le.archivedAt) {
      throw new ConflictException({
        message: 'Юрлицо в архиве — выберите действующее',
        details: { code: LEGAL_ENTITY_ERROR_CODES.archived },
      });
    }
    return le.id;
  }

  /** Справочник для выпадашек (живые + опционально архивные). */
  async listLite(
    workspaceId: string,
    includeArchived = false,
    tx?: Tx,
  ): Promise<LegalEntityLiteDto[]> {
    const db: DbLike = tx ?? this.db;
    const rows = await db.legalEntity.findMany({
      where: { workspaceId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ isHead: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, isHead: true, bin: true, archivedAt: true },
    });
    return rows.map((r) => ({ ...r, archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null }));
  }

  /**
   * Справочник для форм КОМАНДЫ (объект, договор): видит любой сотрудник, кроме
   * Подрядчика. Реквизитов и счетов не отдаёт — только имя и БИН.
   */
  async listLiteForMember(
    userId: string,
    workspaceId: string,
    includeArchived: boolean,
  ): Promise<LegalEntityLiteDto[]> {
    const role = await this.roleOf(userId, workspaceId);
    if (!role || role === 'contractor') throw new NotFoundException('Организация не найдена');
    await this.ensureHeadLegalEntity(workspaceId);
    return this.listLite(workspaceId, includeArchived);
  }

  // ============================================================
  // CRUD (admin+)
  // ============================================================

  async list(
    userId: string,
    workspaceId: string,
    includeArchived: boolean,
  ): Promise<LegalEntityDto[]> {
    await this.assertCanManage(userId, workspaceId);
    await this.ensureHeadLegalEntity(workspaceId);
    const rows = await this.db.legalEntity.findMany({
      where: { workspaceId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ isHead: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return Promise.all(rows.map((r) => this.serialize(r)));
  }

  async getOne(userId: string, workspaceId: string, leId: string): Promise<LegalEntityDto> {
    await this.assertCanManage(userId, workspaceId);
    const row = await this.db.legalEntity.findFirst({ where: { id: leId, workspaceId } });
    if (!row) throw new NotFoundException('Юрлицо не найдено');
    return this.serialize(row);
  }

  async create(
    userId: string,
    workspaceId: string,
    dto: CreateLegalEntityInput,
  ): Promise<LegalEntityDto> {
    await this.assertCanManage(userId, workspaceId);
    await this.ensureHeadLegalEntity(workspaceId);
    const count = await this.db.legalEntity.count({ where: { workspaceId } });
    if (count >= LEGAL_ENTITY_LIMITS.maxPerWorkspace) {
      throw new BadRequestException(`Лимит юрлиц: ${LEGAL_ENTITY_LIMITS.maxPerWorkspace}`);
    }
    await this.validateDirector(workspaceId, dto.directorUserId ?? null);

    const created = await this.db.$transaction(async (tx) => {
      const row = await tx.legalEntity
        .create({
          data: {
            workspaceId,
            name: dto.name,
            isHead: false,
            sortOrder: count,
            ...this.requisiteData(dto),
          },
        })
        .catch((e: unknown) => this.rethrowBin(e));
      await this.chatter.log(tx, {
        refType: 'workspace',
        refId: workspaceId,
        workspaceId,
        actorId: userId,
        typeKey: 'legal_entity.created',
        payload: { name: row.name },
      });
      return row;
    });
    return this.serialize(created);
  }

  async update(
    userId: string,
    workspaceId: string,
    leId: string,
    dto: UpdateLegalEntityInput,
  ): Promise<LegalEntityDto> {
    await this.assertCanManage(userId, workspaceId);
    const row = await this.db.legalEntity.findFirst({ where: { id: leId, workspaceId } });
    if (!row) throw new NotFoundException('Юрлицо не найдено');
    if (dto.directorUserId) await this.validateDirector(workspaceId, dto.directorUserId);

    const updated = await this.db.$transaction(async (tx) => {
      const next = await tx.legalEntity
        .update({
          where: { id: leId },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
            ...this.requisiteData(dto),
          },
        })
        .catch((e: unknown) => this.rethrowBin(e));
      await this.chatter.log(tx, {
        refType: 'workspace',
        refId: workspaceId,
        workspaceId,
        actorId: userId,
        typeKey: 'legal_entity.updated',
        payload: { name: next.name },
      });
      return next;
    });
    return this.serialize(updated);
  }

  /**
   * Сделать юрлицо ГОЛОВНЫМ. Головное подставляется везде, где юрлицо не выбрано
   * явно, и его же отдаёт старая ручка `/requisites` — без этой операции сеть,
   * заведшая настоящее ТОО вторым, навсегда оставалась бы с автосозданной
   * заглушкой во главе.
   */
  async makeHead(userId: string, workspaceId: string, leId: string): Promise<LegalEntityDto> {
    await this.assertCanManage(userId, workspaceId);
    const row = await this.db.legalEntity.findFirst({ where: { id: leId, workspaceId } });
    if (!row) throw new NotFoundException('Юрлицо не найдено');
    if (row.archivedAt) {
      throw new ConflictException({
        message: 'Архивное юрлицо головным не делают',
        details: { code: LEGAL_ENTITY_ERROR_CODES.archived },
      });
    }
    if (row.isHead) return this.serialize(row);

    const updated = await this.db.$transaction(async (tx) => {
      // Партиальный уникум «ровно одно головное» терпит только последовательность
      // «сняли — поставили», и обе правки обязаны быть в одной транзакции.
      await tx.legalEntity.updateMany({ where: { workspaceId, isHead: true }, data: { isHead: false } });
      const next = await tx.legalEntity.update({ where: { id: leId }, data: { isHead: true } });
      await this.chatter.log(tx, {
        refType: 'workspace',
        refId: workspaceId,
        workspaceId,
        actorId: userId,
        typeKey: 'legal_entity.updated',
        payload: { name: next.name },
        changes: [{ field: 'isHead', label: 'Головное юрлицо', from: 'нет', to: 'да' }],
      });
      return next;
    });
    return this.serialize(updated);
  }

  /** Архив вместо удаления: на юрлицо ссылаются карточки КЭДО и документы. */
  async archive(userId: string, workspaceId: string, leId: string): Promise<LegalEntityDto> {
    await this.assertCanManage(userId, workspaceId);
    const row = await this.db.legalEntity.findFirst({ where: { id: leId, workspaceId } });
    if (!row) throw new NotFoundException('Юрлицо не найдено');
    if (row.isHead) {
      throw new ConflictException({
        message: 'Головное юрлицо архивировать нельзя',
        details: { code: LEGAL_ENTITY_ERROR_CODES.head },
      });
    }
    if (row.archivedAt) return this.serialize(row);

    const updated = await this.db.$transaction(async (tx) => {
      const next = await tx.legalEntity.update({
        where: { id: leId },
        data: { archivedAt: new Date() },
      });
      await this.chatter.log(tx, {
        refType: 'workspace',
        refId: workspaceId,
        workspaceId,
        actorId: userId,
        typeKey: 'legal_entity.archived',
        payload: { name: next.name },
      });
      return next;
    });
    return this.serialize(updated);
  }

  async restore(userId: string, workspaceId: string, leId: string): Promise<LegalEntityDto> {
    await this.assertCanManage(userId, workspaceId);
    const row = await this.db.legalEntity.findFirst({ where: { id: leId, workspaceId } });
    if (!row) throw new NotFoundException('Юрлицо не найдено');
    if (!row.archivedAt) return this.serialize(row);
    const updated = await this.db.legalEntity
      .update({ where: { id: leId }, data: { archivedAt: null } })
      .catch((e: unknown) => this.rethrowBin(e));
    return this.serialize(updated);
  }

  // ============================================================
  // Банковские счета юрлица
  // ============================================================

  async addBankAccount(
    userId: string,
    workspaceId: string,
    leId: string,
    dto: CreateBankAccountInput,
  ): Promise<LegalEntityDto> {
    await this.assertCanManage(userId, workspaceId);
    const le = await this.mustFind(workspaceId, leId);
    await this.db.$transaction(async (tx) => {
      const count = await tx.workspaceBankAccount.count({ where: { legalEntityId: le.id } });
      if (count >= REQUISITE_LIMITS.maxBankAccountsPerWorkspace) {
        throw new BadRequestException('Слишком много счетов — удалите ненужный');
      }
      // Первый счёт — основной сам; явный isPrimary снимает флаг с прочих ЭТОГО юрлица.
      const makePrimary = dto.isPrimary || count === 0;
      if (makePrimary) {
        await tx.workspaceBankAccount.updateMany({
          where: { legalEntityId: le.id, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      await tx.workspaceBankAccount.create({
        data: {
          workspaceId,
          legalEntityId: le.id,
          iban: dto.iban,
          bankName: dto.bankName,
          bik: dto.bik,
          isPrimary: makePrimary,
        },
      });
    });
    return this.getOne(userId, workspaceId, le.id);
  }

  async updateBankAccount(
    userId: string,
    workspaceId: string,
    leId: string,
    accountId: string,
    dto: UpdateBankAccountInput,
  ): Promise<LegalEntityDto> {
    await this.assertCanManage(userId, workspaceId);
    const le = await this.mustFind(workspaceId, leId);
    await this.db.$transaction(async (tx) => {
      const acc = await tx.workspaceBankAccount.findFirst({
        where: { id: accountId, legalEntityId: le.id },
      });
      if (!acc) throw new NotFoundException('Счёт не найден');
      if (dto.isPrimary) {
        await tx.workspaceBankAccount.updateMany({
          where: { legalEntityId: le.id, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      await tx.workspaceBankAccount.update({
        where: { id: acc.id },
        data: {
          ...(dto.iban !== undefined ? { iban: dto.iban } : {}),
          ...(dto.bankName !== undefined ? { bankName: dto.bankName } : {}),
          ...(dto.bik !== undefined ? { bik: dto.bik } : {}),
          ...(dto.isPrimary !== undefined ? { isPrimary: dto.isPrimary } : {}),
        },
      });
    });
    return this.getOne(userId, workspaceId, le.id);
  }

  async removeBankAccount(
    userId: string,
    workspaceId: string,
    leId: string,
    accountId: string,
  ): Promise<LegalEntityDto> {
    await this.assertCanManage(userId, workspaceId);
    const le = await this.mustFind(workspaceId, leId);
    await this.db.$transaction(async (tx) => {
      const acc = await tx.workspaceBankAccount.findFirst({
        where: { id: accountId, legalEntityId: le.id },
      });
      if (!acc) throw new NotFoundException('Счёт не найден');
      await tx.workspaceBankAccount.delete({ where: { id: acc.id } });
      // Основной удалили — роль переходит старейшему из оставшихся счетов юрлица.
      if (acc.isPrimary) {
        const next = await tx.workspaceBankAccount.findFirst({
          where: { legalEntityId: le.id },
          orderBy: { createdAt: 'asc' },
        });
        if (next) {
          await tx.workspaceBankAccount.update({ where: { id: next.id }, data: { isPrimary: true } });
        }
      }
    });
    return this.getOne(userId, workspaceId, le.id);
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  /** Сериализация строки в DTO (реквизиты + счета + имя директора). */
  async serialize(
    row: {
      id: string;
      name: string;
      isHead: boolean;
      sortOrder: number;
      archivedAt: Date | null;
      orgForm: string | null;
      taxRegime: string | null;
      legalName: string | null;
      bin: string | null;
      legalAddress: string | null;
      kbe: string | null;
      vatPayer: boolean;
      vatSeries: string | null;
      vatNumber: string | null;
      vatDate: Date | null;
      directorUserId: string | null;
      signBasis: string | null;
    },
    tx?: Tx,
  ): Promise<LegalEntityDto> {
    const db: DbLike = tx ?? this.db;
    const [accounts, director] = await Promise.all([
      db.workspaceBankAccount.findMany({
        where: { legalEntityId: row.id },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      }),
      // Директор мог быть уволен после записи — имя всё равно показываем.
      row.directorUserId
        ? db.user.findUnique({
            where: { id: row.directorUserId },
            select: { firstName: true, lastName: true },
          })
        : Promise.resolve(null),
    ]);
    return {
      id: row.id,
      name: row.name,
      isHead: row.isHead,
      sortOrder: row.sortOrder,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      orgForm: row.orgForm,
      taxRegime: row.taxRegime,
      legalName: row.legalName,
      bin: row.bin,
      legalAddress: row.legalAddress,
      kbe: row.kbe,
      vatPayer: row.vatPayer,
      vatSeries: row.vatSeries,
      vatNumber: row.vatNumber,
      vatDate: row.vatDate ? row.vatDate.toISOString().slice(0, 10) : null,
      directorUserId: row.directorUserId,
      directorName: director ? fullName(director) : null,
      signBasis: row.signBasis,
      bankAccounts: accounts.map((a) => ({
        id: a.id,
        iban: a.iban,
        bankName: a.bankName,
        bik: a.bik,
        isPrimary: a.isPrimary,
      })),
    };
  }

  private requisiteData(dto: Partial<CreateLegalEntityInput>): RequisiteData {
    const data: RequisiteData = {};
    for (const key of REQUISITE_KEYS) {
      if (dto[key] !== undefined) data[key] = dto[key];
    }
    if (dto.vatPayer !== undefined) data.vatPayer = dto.vatPayer;
    if (dto.vatDate !== undefined) data.vatDate = dto.vatDate;
    return data;
  }

  private async mustFind(workspaceId: string, leId: string) {
    const row = await this.db.legalEntity.findFirst({
      where: { id: leId, workspaceId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Юрлицо не найдено');
    return row;
  }

  /** Директор выбирается из СОТРУДНИКОВ (Подрядчик — не подписант). */
  async validateDirector(workspaceId: string, directorUserId: string | null): Promise<void> {
    if (!directorUserId) return;
    const role = await this.roleOf(directorUserId, workspaceId);
    if (!role || role === 'contractor') {
      throw new BadRequestException('Директор выбирается из сотрудников организации');
    }
  }

  /** Партиальный уникум БИН → машинный код вместо сырого P2002. */
  private rethrowBin(e: unknown): never {
    const code = (e as { code?: string })?.code;
    const meta = (e as { meta?: { target?: unknown } })?.meta;
    const target = JSON.stringify(meta?.target ?? '');
    if (code === 'P2002' && (target.includes('bin') || target.includes('legal_entities_bin'))) {
      throw new ConflictException({
        message: 'Юрлицо с таким БИН уже есть в организации',
        details: { code: LEGAL_ENTITY_ERROR_CODES.binDuplicate },
      });
    }
    throw e as Error;
  }

  private async roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const rows = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (!rows.length) return null;
    return rows.map((r) => r.role as WorkspaceRole).sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0];
  }

  private async assertCanManage(userId: string, workspaceId: string): Promise<void> {
    const role = await this.roleOf(userId, workspaceId);
    if (!role || (role !== 'owner' && role !== 'admin')) {
      throw new NotFoundException('Организация не найдена');
    }
  }
}
