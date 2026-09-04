import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ASSET_STATUSES,
  HOLDING_KINDS,
  OBJECTS_ERROR_CODES,
  type AssetCardDto,
  type AssetDto,
  type AssetModelDto,
  type AssetModelInput,
  type AssetMoveDto,
  type AssetServiceInput,
  type AssetServiceRecordDto,
  type AssetsQuery,
  type CreateAssetInput,
  type CursorPage,
  type FileDto,
  type MoveAssetInput,
  type ObjectCapsDto,
  type SetAssetCustodianInput,
  type SetAssetHoldingInput,
  type SetAssetStatusInput,
  type UpdateAssetInput,
  type UpdateAssetModelInput,
  type UpdateAssetServiceInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { FilesService } from '../../core/files/files.service';
import { ObjectsService } from './objects.service';

type Tx = Prisma.TransactionClient;

const STATUS_LABEL = new Map<string, string>(ASSET_STATUSES.map((s) => [s.value, s.label]));
const HOLDING_LABEL = new Map<string, string>(HOLDING_KINDS.map((h) => [h.value, h.label]));

export const ASSET_REF_TYPE = 'asset';
export const ASSET_MODEL_REF_TYPE = 'asset_model';
export const ASSET_SERVICE_REF_TYPE = 'asset_service';

function dateStr(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function dayOf(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/**
 * Оборудование объекта (семья `Asset`).
 *
 * Два независимых измерения: ГДЕ стоит (объект + узел внутри линии) и ЧЬЁ /
 * на чьём балансе. Любое изменение того и другого — ЗАПИСЬ В ЖУРНАЛ в той же
 * транзакции: «переместили» без следа кто и когда — потеря, а не экономия.
 *
 * Денежное и балансовое (цена, ремонты, юрлицо-балансодержатель, арендодатель)
 * ОТСУТСТВУЕТ в ответе без права `branch.payroll.view` — сервер его не отдаёт.
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly chatter: ChatterService,
    private readonly files: FilesService,
    private readonly objects: ObjectsService,
  ) {}

  // ============================================================
  // Справочник моделей
  // ============================================================

  async listModels(
    userId: string,
    workspaceId: string,
    q: { kind?: string; search?: string; archived?: boolean },
  ): Promise<AssetModelDto[]> {
    const scope = await this.objects.scopeOf(userId, workspaceId);
    if (!scope.role || scope.role === 'contractor') throw new NotFoundException('Организация не найдена');
    const rows = await this.db.assetModel.findMany({
      where: {
        workspaceId,
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.archived ? {} : { archivedAt: null }),
        ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
      take: 200,
      include: { _count: { select: { assets: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as AssetModelDto['kind'],
      name: r.name,
      manufacturer: r.manufacturer,
      category: r.category,
      glyph: r.glyph,
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
      assetsCount: r._count.assets,
    }));
  }

  async createModel(userId: string, workspaceId: string, dto: AssetModelInput): Promise<AssetModelDto> {
    await this.assertAnyManage(userId, workspaceId);
    const row = await this.db.assetModel
      .create({
        data: {
          workspaceId,
          kind: dto.kind ?? 'equipment',
          name: dto.name,
          manufacturer: dto.manufacturer ?? null,
          category: dto.category ?? null,
          glyph: dto.glyph ?? null,
          createdById: userId,
        },
      })
      .catch((e: unknown) => {
        if ((e as { code?: string })?.code === 'P2002') {
          throw new ConflictException('Модель с таким названием уже есть');
        }
        throw e as Error;
      });
    return { ...this.modelDto(row), assetsCount: 0 };
  }

  async updateModel(
    userId: string,
    workspaceId: string,
    modelId: string,
    dto: UpdateAssetModelInput,
  ): Promise<AssetModelDto> {
    await this.assertAnyManage(userId, workspaceId);
    const found = await this.db.assetModel.findFirst({ where: { id: modelId, workspaceId } });
    if (!found) throw new NotFoundException('Модель не найдена');
    const row = await this.db.assetModel.update({
      where: { id: modelId },
      data: {
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.manufacturer !== undefined ? { manufacturer: dto.manufacturer } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.glyph !== undefined ? { glyph: dto.glyph } : {}),
      },
      include: { _count: { select: { assets: true } } },
    });
    return { ...this.modelDto(row), assetsCount: row._count.assets };
  }

  /** Удаление модели — только пустой: экземпляры держат её (FK Restrict + 409). */
  async removeModel(userId: string, workspaceId: string, modelId: string): Promise<void> {
    await this.assertAnyManage(userId, workspaceId);
    const found = await this.db.assetModel.findFirst({ where: { id: modelId, workspaceId } });
    if (!found) throw new NotFoundException('Модель не найдена');
    const used = await this.db.asset.count({ where: { modelId } });
    if (used > 0) {
      throw new ConflictException({
        message: 'По этой модели есть оборудование — сначала спишите или перенесите его',
        details: { code: OBJECTS_ERROR_CODES.assetModelInUse },
      });
    }
    await this.db.assetModel.delete({ where: { id: modelId } });
  }

  // ============================================================
  // Экземпляры
  // ============================================================

  async list(
    userId: string,
    workspaceId: string,
    branchId: string,
    q: AssetsQuery,
  ): Promise<CursorPage<AssetDto>> {
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, branchId);
    const branchIds = q.subtree
      ? (
          await this.db.staffBranch.findMany({
            where: { workspaceId, OR: [{ id: branch.id }, { ancestorIds: { has: branch.id } }] },
            select: { id: true },
          })
        ).map((b) => b.id)
      : [branch.id];

    const limit = q.limit ?? 30;
    const rows = await this.db.asset.findMany({
      where: {
        workspaceId,
        branchId: { in: branchIds },
        archivedAt: null,
        ...(q.status ? { status: q.status } : {}),
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: 'insensitive' } },
                { inventoryNumber: { contains: q.search, mode: 'insensitive' } },
                { serialNumber: { contains: q.search, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(q.cursor ? { id: { lt: q.cursor } } : {}),
      },
      include: this.assetInclude(),
      // Порядок = курсор: страница режется по id, поэтому и сортировка по id.
      // Ручной `sortOrder` для этого списка убран из контракта (см. updateAssetSchema).
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const [photos, names] = await Promise.all([
      this.photoMap(page.map((a) => a.id)),
      this.namesFor(page.map((a) => a.custodianUserId)),
    ]);
    return {
      items: page.map((a) =>
        this.assetDto(a, caps, photos.get(a.id) ?? null, a.custodianUserId ? (names.get(a.custodianUserId) ?? null) : null),
      ),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async card(userId: string, workspaceId: string, assetId: string): Promise<AssetCardDto> {
    const { asset, caps } = await this.assetOrThrow(userId, workspaceId, assetId);
    const [moves, services, children, photos] = await Promise.all([
      this.db.assetMove.findMany({ where: { assetId }, orderBy: { movedAt: 'desc' }, take: 100 }),
      this.db.assetServiceRecord.findMany({ where: { assetId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.db.asset.findMany({
        where: { parentAssetId: assetId, archivedAt: null },
        select: { id: true, name: true, status: true },
      }),
      this.photoMap([assetId]),
    ]);
    // Владение и баланс — под правом на деньги, и это правило обязано стоять во ВСЕХ
    // путях ответа: журнал перемещений раскрывал ось «своё → аренда» тому, кому
    // денежные поля самого актива не отдаются.
    const visibleMoves = caps.payrollView ? moves : moves.filter((m) => m.kind !== 'holding');

    const nameOf = await this.namesFor([
      ...visibleMoves.flatMap((m) => [m.movedById, m.fromUserId, m.toUserId]),
      asset.custodianUserId,
      ...services.map((r) => r.performedByUserId),
    ]);
    const branchIds = [
      ...new Set(visibleMoves.flatMap((m) => [m.fromBranchId, m.toBranchId].filter((x): x is string => !!x))),
    ];
    const [branches, counterparties, serviceTotal] = await Promise.all([
      this.db.staffBranch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }),
      this.db.counterparty.findMany({
        where: {
          workspaceId,
          id: { in: [...new Set(services.map((r) => r.counterpartyId).filter((x): x is string => !!x))] },
        },
        select: { id: true, name: true },
      }),
      // TCO = сумма всех ремонтов, агрегатом по ВСЕМ записям, а не по загруженной
      // странице журнала: иначе на 101-м ремонте сумма молча станет неверной.
      caps.payrollView
        ? this.db.assetServiceRecord.aggregate({ where: { assetId }, _sum: { cost: true } })
        : Promise.resolve(null),
    ]);
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const counterpartyName = new Map(counterparties.map((c) => [c.id, c.name]));

    const assetDto = this.assetDto(
      asset,
      caps,
      photos.get(assetId) ?? null,
      asset.custodianUserId ? (nameOf.get(asset.custodianUserId) ?? null) : null,
    );
    if (serviceTotal) assetDto.serviceCost = String(serviceTotal._sum.cost ?? 0n);

    return {
      asset: assetDto,
      caps,
      moves: visibleMoves.map((m) => this.moveDto(m, nameOf, branchName)),
      services: services.map((r) =>
        this.serviceDto(r, caps, {
          performedBy: r.performedByUserId ? (nameOf.get(r.performedByUserId) ?? null) : null,
          counterparty: r.counterpartyId ? (counterpartyName.get(r.counterpartyId) ?? null) : null,
        }),
      ),
      children: children.map((c) => ({ id: c.id, name: c.name, status: c.status as AssetDto['status'] })),
    };
  }

  async create(
    userId: string,
    workspaceId: string,
    branchId: string,
    dto: CreateAssetInput,
  ): Promise<AssetDto> {
    const { caps } = await this.objects.getOrThrow(userId, workspaceId, branchId);
    this.objects.assertManage(caps);
    if ((dto.purchasePrice !== undefined && dto.purchasePrice !== null) && !caps.payrollView) {
      throw new ForbiddenException('Цену покупки заполняет тот, кто видит деньги объекта');
    }
    await this.assertRefsOwned(workspaceId, dto);

    const created = await this.db
      .$transaction(async (tx) => {
        // Модель обязательна, но заводится на лету из формы: «Кофемашина Jura X8»
        // должна появиться одним движением, а не походом в отдельный справочник.
        const model = dto.modelId
          ? await tx.assetModel.findFirst({ where: { id: dto.modelId, workspaceId } })
          : await this.upsertModel(tx, workspaceId, userId, dto.newModel!);
        if (!model) throw new BadRequestException('Модель не найдена в этой организации');

        const asset = await tx.asset.create({
          data: {
            workspaceId,
            modelId: model.id,
            kind: model.kind,
            branchId,
            name: dto.name,
            inventoryNumber: dto.inventoryNumber ?? null,
            serialNumber: dto.serialNumber ?? null,
            parentAssetId: dto.parentAssetId ?? null,
            locationNote: dto.locationNote ?? null,
            holdingKind: dto.holdingKind ?? 'owned',
            balanceLegalEntityId: dto.balanceLegalEntityId ?? null,
            holdingCounterpartyId: dto.holdingCounterpartyId ?? null,
            custodianUserId: dto.custodianUserId ?? null,
            status: dto.status ?? 'active',
            purchasedOn: dto.purchasedOn ? dayOf(dto.purchasedOn) : null,
            commissionedOn: dto.commissionedOn ? dayOf(dto.commissionedOn) : null,
            warrantyUntil: dto.warrantyUntil ? dayOf(dto.warrantyUntil) : null,
            purchasePrice: dto.purchasePrice ? BigInt(dto.purchasePrice) : null,
            currency: dto.currency ?? 'KZT',
            note: dto.note ?? null,
            createdById: userId,
          },
          include: this.assetInclude(),
        });
        // Первая запись журнала — само появление в объекте.
        await tx.assetMove.create({
          data: {
            workspaceId,
            assetId: asset.id,
            kind: 'placement',
            toBranchId: branchId,
            toUserId: dto.custodianUserId ?? null,
            movedById: userId,
          },
        });
        await this.chatter.log(tx, {
          refType: ASSET_REF_TYPE,
          refId: asset.id,
          workspaceId,
          actorId: userId,
          typeKey: 'asset.created',
          payload: { name: asset.name },
        });
        return asset;
      })
      .catch((e: unknown) => this.rethrowInventory(e));

    return this.assetDto(created, caps, null, await this.userName(created.custodianUserId));
  }

  async update(
    userId: string,
    workspaceId: string,
    assetId: string,
    dto: UpdateAssetInput,
  ): Promise<AssetDto> {
    const { asset, caps } = await this.assetOrThrow(userId, workspaceId, assetId);
    this.objects.assertManage(caps);
    // Цена — денежное поле: без права его не только не видно, но и не изменить.
    if ((dto.purchasePrice !== undefined || dto.currency !== undefined) && !caps.payrollView) {
      throw new ForbiddenException('Цену покупки заполняет тот, кто видит деньги объекта');
    }
    const updated = await this.db
      .$transaction(async (tx) => {
        const row = await tx.asset.update({
          where: { id: assetId },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.inventoryNumber !== undefined ? { inventoryNumber: dto.inventoryNumber } : {}),
            ...(dto.serialNumber !== undefined ? { serialNumber: dto.serialNumber } : {}),
            ...(dto.locationNote !== undefined ? { locationNote: dto.locationNote } : {}),
            ...(dto.purchasedOn !== undefined ? { purchasedOn: dto.purchasedOn ? dayOf(dto.purchasedOn) : null } : {}),
            ...(dto.commissionedOn !== undefined
              ? { commissionedOn: dto.commissionedOn ? dayOf(dto.commissionedOn) : null }
              : {}),
            ...(dto.warrantyUntil !== undefined
              ? { warrantyUntil: dto.warrantyUntil ? dayOf(dto.warrantyUntil) : null }
              : {}),
            ...(dto.purchasePrice !== undefined
              ? { purchasePrice: dto.purchasePrice ? BigInt(dto.purchasePrice) : null }
              : {}),
            ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
            ...(dto.note !== undefined ? { note: dto.note } : {}),
          },
          include: this.assetInclude(),
        });
        if (dto.name !== undefined && dto.name !== asset.name) {
          await this.chatter.log(tx, {
            refType: ASSET_REF_TYPE,
            refId: assetId,
            workspaceId,
            actorId: userId,
            typeKey: 'asset.updated',
            changes: [{ field: 'name', label: 'Название', from: asset.name, to: dto.name }],
            payload: { fieldLabel: 'Название' },
          });
        }
        return row;
      })
      .catch((e: unknown) => this.rethrowInventory(e));
    return this.assetDto(updated, caps, null, await this.userName(updated.custodianUserId));
  }

  /** Перемещение: новое место + ЗАПИСЬ ЖУРНАЛА одной транзакцией. */
  async move(userId: string, workspaceId: string, assetId: string, dto: MoveAssetInput): Promise<AssetDto> {
    const { asset, caps } = await this.assetOrThrow(userId, workspaceId, assetId);
    this.objects.assertManage(caps);
    if (dto.branchId && dto.branchId !== asset.branchId) {
      // Право нужно и на объект-ПРИЁМНИК: иначе оборудование уезжало бы в чужую ветку.
      const target = await this.objects.getOrThrow(userId, workspaceId, dto.branchId);
      this.objects.assertManage(target.caps);
    }
    if (dto.parentAssetId) {
      const parent = await this.db.asset.findFirst({ where: { id: dto.parentAssetId, workspaceId } });
      if (!parent) throw new BadRequestException('Родительское оборудование не найдено');
      if (dto.parentAssetId === assetId) throw new BadRequestException('Нельзя вложить актив сам в себя');
    }

    const updated = await this.db.$transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id: assetId },
        data: {
          ...(dto.branchId ? { branchId: dto.branchId } : {}),
          ...(dto.parentAssetId !== undefined ? { parentAssetId: dto.parentAssetId } : {}),
          ...(dto.locationNote !== undefined ? { locationNote: dto.locationNote } : {}),
        },
        include: this.assetInclude(),
      });
      await tx.assetMove.create({
        data: {
          workspaceId,
          assetId,
          kind: 'placement',
          fromBranchId: asset.branchId,
          toBranchId: dto.branchId ?? asset.branchId,
          fromParentAssetId: asset.parentAssetId,
          toParentAssetId: dto.parentAssetId ?? asset.parentAssetId,
          reason: dto.reason ?? null,
          movedById: userId,
        },
      });
      await this.chatter.log(tx, {
        refType: ASSET_REF_TYPE,
        refId: assetId,
        workspaceId,
        actorId: userId,
        typeKey: 'asset.moved',
        changes: [
          {
            field: 'branchId',
            label: 'Место',
            from: asset.branch?.name ?? null,
            to: row.branch?.name ?? null,
          },
        ],
      });
      return row;
    });
    return this.assetDto(updated, caps, null, await this.userName(updated.custodianUserId));
  }

  async setCustodian(
    userId: string,
    workspaceId: string,
    assetId: string,
    dto: SetAssetCustodianInput,
  ): Promise<AssetDto> {
    const { asset, caps } = await this.assetOrThrow(userId, workspaceId, assetId);
    this.objects.assertManage(caps);
    await this.assertRefsOwned(workspaceId, { custodianUserId: dto.custodianUserId });
    const [fromName, toName] = await Promise.all([
      this.userName(asset.custodianUserId),
      this.userName(dto.custodianUserId),
    ]);
    const updated = await this.db.$transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id: assetId },
        data: { custodianUserId: dto.custodianUserId },
        include: this.assetInclude(),
      });
      // Ответственный — ЗАПИСЬ В ЖУРНАЛЕ. Акт передачи с подписью придёт позже
      // отдельным документом (core/sign), журнал останется его основанием.
      await tx.assetMove.create({
        data: {
          workspaceId,
          assetId,
          kind: 'custodian',
          fromUserId: asset.custodianUserId,
          toUserId: dto.custodianUserId,
          reason: dto.reason ?? null,
          movedById: userId,
        },
      });
      await this.chatter.log(tx, {
        refType: ASSET_REF_TYPE,
        refId: assetId,
        workspaceId,
        actorId: userId,
        typeKey: 'asset.custodian_set',
        changes: [{ field: 'custodian', label: 'Ответственный', from: fromName, to: toName }],
      });
      return row;
    });
    return this.assetDto(updated, caps, null, toName);
  }

  async setHolding(
    userId: string,
    workspaceId: string,
    assetId: string,
    dto: SetAssetHoldingInput,
  ): Promise<AssetDto> {
    const { asset, caps } = await this.assetOrThrow(userId, workspaceId, assetId);
    this.objects.assertManage(caps);
    if (!caps.payrollView) throw new ForbiddenException('Владение и баланс меняет тот, кто видит деньги объекта');
    await this.assertRefsOwned(workspaceId, dto);
    const updated = await this.db.$transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id: assetId },
        data: {
          holdingKind: dto.holdingKind,
          ...(dto.balanceLegalEntityId !== undefined ? { balanceLegalEntityId: dto.balanceLegalEntityId } : {}),
          ...(dto.holdingCounterpartyId !== undefined
            ? { holdingCounterpartyId: dto.holdingCounterpartyId }
            : {}),
        },
        include: this.assetInclude(),
      });
      await tx.assetMove.create({
        data: {
          workspaceId,
          assetId,
          kind: 'holding',
          fromValue: asset.holdingKind,
          toValue: dto.holdingKind,
          reason: dto.reason ?? null,
          movedById: userId,
        },
      });
      await this.chatter.log(tx, {
        refType: ASSET_REF_TYPE,
        refId: assetId,
        workspaceId,
        actorId: userId,
        typeKey: 'asset.holding_set',
        changes: [
          {
            field: 'holdingKind',
            label: 'Владение',
            from: HOLDING_LABEL.get(asset.holdingKind) ?? asset.holdingKind,
            to: HOLDING_LABEL.get(dto.holdingKind) ?? dto.holdingKind,
          },
        ],
      });
      return row;
    });
    return this.assetDto(updated, caps, null, await this.userName(updated.custodianUserId));
  }

  async setStatus(
    userId: string,
    workspaceId: string,
    assetId: string,
    dto: SetAssetStatusInput,
  ): Promise<AssetDto> {
    const { asset, caps } = await this.assetOrThrow(userId, workspaceId, assetId);
    this.objects.assertManage(caps);
    const updated = await this.db.$transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id: assetId },
        data: {
          status: dto.status,
          // Списанное и утилизированное уходит из живых списков объекта; возврат в
          // рабочий статус ОБЯЗАН снимать метку архива, иначе ошибочное списание
          // необратимо: статус вернулся, а из списков и поиска актив исчез навсегда.
          archivedAt: dto.status === 'written_off' || dto.status === 'disposed' ? new Date() : null,
        },
        include: this.assetInclude(),
      });
      await tx.assetMove.create({
        data: {
          workspaceId,
          assetId,
          kind: 'status',
          fromValue: asset.status,
          toValue: dto.status,
          reason: dto.reason ?? null,
          movedById: userId,
        },
      });
      await this.chatter.log(tx, {
        refType: ASSET_REF_TYPE,
        refId: assetId,
        workspaceId,
        actorId: userId,
        typeKey: 'asset.status_set',
        changes: [
          {
            field: 'status',
            label: 'Состояние',
            from: STATUS_LABEL.get(asset.status) ?? asset.status,
            to: STATUS_LABEL.get(dto.status) ?? dto.status,
          },
        ],
      });
      return row;
    });
    return this.assetDto(updated, caps, null, await this.userName(updated.custodianUserId));
  }

  // ============================================================
  // Обслуживание
  // ============================================================

  async logService(
    userId: string,
    workspaceId: string,
    assetId: string,
    dto: AssetServiceInput,
  ): Promise<AssetServiceRecordDto> {
    const { caps } = await this.assetOrThrow(userId, workspaceId, assetId);
    this.objects.assertManage(caps);
    if (dto.cost && !caps.payrollView) {
      throw new ForbiddenException('Стоимость ремонта заполняет тот, кто видит деньги объекта');
    }
    await this.assertRefsOwned(workspaceId, dto);
    const row = await this.db.$transaction(async (tx) => {
      const saved = await tx.assetServiceRecord.create({
        data: {
          workspaceId,
          assetId,
          kind: dto.kind ?? 'repair',
          status: dto.status ?? 'done',
          title: dto.title,
          description: dto.description ?? null,
          scheduledOn: dto.scheduledOn ? dayOf(dto.scheduledOn) : null,
          startedAt: dto.startedAt ? new Date(dto.startedAt) : null,
          finishedAt: dto.finishedAt ? new Date(dto.finishedAt) : null,
          nextDueOn: dto.nextDueOn ? dayOf(dto.nextDueOn) : null,
          cost: dto.cost ? BigInt(dto.cost) : null,
          currency: dto.currency ?? 'KZT',
          performedByUserId: dto.performedByUserId ?? null,
          counterpartyId: dto.counterpartyId ?? null,
          createdById: userId,
        },
      });
      await this.chatter.log(tx, {
        refType: ASSET_REF_TYPE,
        refId: assetId,
        workspaceId,
        actorId: userId,
        typeKey: 'asset.service_logged',
        payload: { title: saved.title },
      });
      return saved;
    });
    return this.serviceDto(row, caps, await this.serviceNames(workspaceId, row));
  }

  async updateService(
    userId: string,
    workspaceId: string,
    assetId: string,
    recordId: string,
    dto: UpdateAssetServiceInput,
  ): Promise<AssetServiceRecordDto> {
    const { caps } = await this.assetOrThrow(userId, workspaceId, assetId);
    this.objects.assertManage(caps);
    const found = await this.db.assetServiceRecord.findFirst({ where: { id: recordId, assetId, workspaceId } });
    if (!found) throw new NotFoundException('Запись обслуживания не найдена');
    if (dto.cost !== undefined && !caps.payrollView) {
      throw new ForbiddenException('Стоимость ремонта заполняет тот, кто видит деньги объекта');
    }
    await this.assertRefsOwned(workspaceId, dto);
    const row = await this.db.assetServiceRecord.update({
      where: { id: recordId },
      data: {
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.scheduledOn !== undefined ? { scheduledOn: dto.scheduledOn ? dayOf(dto.scheduledOn) : null } : {}),
        ...(dto.startedAt !== undefined ? { startedAt: dto.startedAt ? new Date(dto.startedAt) : null } : {}),
        ...(dto.finishedAt !== undefined ? { finishedAt: dto.finishedAt ? new Date(dto.finishedAt) : null } : {}),
        ...(dto.nextDueOn !== undefined ? { nextDueOn: dto.nextDueOn ? dayOf(dto.nextDueOn) : null } : {}),
        ...(dto.cost !== undefined ? { cost: dto.cost ? BigInt(dto.cost) : null } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.performedByUserId !== undefined ? { performedByUserId: dto.performedByUserId } : {}),
        ...(dto.counterpartyId !== undefined ? { counterpartyId: dto.counterpartyId } : {}),
      },
    });
    return this.serviceDto(row, caps, await this.serviceNames(workspaceId, row));
  }

  // ============================================================
  // Файлы актива (движок core/files; своих таблиц нет)
  // ============================================================

  /** Файлы МОДЕЛИ: инструкция и паспорт — один раз на весь парк одинаковых машин. */
  async listModelFiles(userId: string, workspaceId: string, modelId: string): Promise<FileDto[]> {
    await this.modelOrThrow(userId, workspaceId, modelId, false);
    const byRef = await this.files.listLinked(ASSET_MODEL_REF_TYPE, [modelId]);
    return byRef.get(modelId) ?? [];
  }

  async attachModelFile(
    userId: string,
    workspaceId: string,
    modelId: string,
    fileId: string,
  ): Promise<void> {
    await this.modelOrThrow(userId, workspaceId, modelId, true);
    await this.files.linkFile(userId, fileId, ASSET_MODEL_REF_TYPE, modelId);
  }

  async detachModelFile(
    userId: string,
    workspaceId: string,
    modelId: string,
    fileId: string,
  ): Promise<void> {
    await this.modelOrThrow(userId, workspaceId, modelId, true);
    await this.files.unlinkFile(userId, fileId, ASSET_MODEL_REF_TYPE, modelId);
  }

  /** Модель организации + право: читает вся команда, правит управляющий объектом. */
  private async modelOrThrow(
    userId: string,
    workspaceId: string,
    modelId: string,
    needManage: boolean,
  ): Promise<void> {
    const found = await this.db.assetModel.findFirst({
      where: { id: modelId, workspaceId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Модель не найдена');
    if (needManage) {
      await this.assertAnyManage(userId, workspaceId);
      return;
    }
    const scope = await this.objects.scopeOf(userId, workspaceId);
    if (!scope.role || scope.role === 'contractor') throw new NotFoundException('Организация не найдена');
  }

  async listFiles(userId: string, workspaceId: string, assetId: string): Promise<FileDto[]> {
    await this.assetOrThrow(userId, workspaceId, assetId);
    const byRef = await this.files.listLinked(ASSET_REF_TYPE, [assetId]);
    return byRef.get(assetId) ?? [];
  }

  async attachFile(userId: string, workspaceId: string, assetId: string, fileId: string): Promise<void> {
    const { caps } = await this.assetOrThrow(userId, workspaceId, assetId);
    this.objects.assertManage(caps);
    await this.files.linkFile(userId, fileId, ASSET_REF_TYPE, assetId);
  }

  async detachFile(userId: string, workspaceId: string, assetId: string, fileId: string): Promise<void> {
    const { caps } = await this.assetOrThrow(userId, workspaceId, assetId);
    this.objects.assertManage(caps);
    await this.files.unlinkFile(userId, fileId, ASSET_REF_TYPE, assetId);
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  /** Актив + права зрителя (право считается по ОБЪЕКТУ актива). */
  async assetOrThrow(userId: string, workspaceId: string, assetId: string) {
    const asset = await this.db.asset.findFirst({
      where: { id: assetId, workspaceId },
      include: this.assetInclude(),
    });
    if (!asset) throw new NotFoundException('Оборудование не найдено');
    const scope = await this.objects.scopeOf(userId, workspaceId);
    const caps = this.objects.capsFor(scope, asset.branch);
    if (!caps.view) throw new NotFoundException('Оборудование не найдено');
    return { asset, caps };
  }

  private assetInclude() {
    return {
      branch: { select: { id: true, name: true, ancestorIds: true } },
      model: { select: { name: true, manufacturer: true } },
      parentAsset: { select: { name: true } },
      balanceLegalEntity: { select: { name: true } },
      holdingCounterparty: { select: { name: true } },
    } as const;
  }

  private modelDto(r: {
    id: string;
    kind: string;
    name: string;
    manufacturer: string | null;
    category: string | null;
    glyph: string | null;
    archivedAt: Date | null;
  }): Omit<AssetModelDto, 'assetsCount'> {
    return {
      id: r.id,
      kind: r.kind as AssetModelDto['kind'],
      name: r.name,
      manufacturer: r.manufacturer,
      category: r.category,
      glyph: r.glyph,
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
    };
  }

  private assetDto(
    a: Prisma.AssetGetPayload<{
      include: {
        branch: { select: { id: true; name: true; ancestorIds: true } };
        model: { select: { name: true; manufacturer: true } };
        parentAsset: { select: { name: true } };
        balanceLegalEntity: { select: { name: true } };
        holdingCounterparty: { select: { name: true } };
      };
    }>,
    caps: ObjectCapsDto,
    photo: FileDto | null,
    /** ФИО ответственного: имя резолвится вызывающим (батчем в списке, точечно в карточке). */
    custodianName: string | null = null,
  ): AssetDto {
    const dto: AssetDto = {
      id: a.id,
      workspaceId: a.workspaceId,
      branchId: a.branchId,
      branchName: a.branch.name,
      modelId: a.modelId,
      modelName: a.model.name,
      manufacturer: a.model.manufacturer,
      kind: a.kind as AssetDto['kind'],
      name: a.name,
      inventoryNumber: a.inventoryNumber,
      serialNumber: a.serialNumber,
      parentAssetId: a.parentAssetId,
      parentAssetName: a.parentAsset?.name ?? null,
      locationNote: a.locationNote,
      custodianUserId: a.custodianUserId,
      custodianName,
      status: a.status as AssetDto['status'],
      purchasedOn: dateStr(a.purchasedOn),
      commissionedOn: dateStr(a.commissionedOn),
      warrantyUntil: dateStr(a.warrantyUntil),
      note: a.note,
      archivedAt: a.archivedAt ? a.archivedAt.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
      photo,
    };
    // Денежное и балансовое — ТОЛЬКО с правом: полей просто нет в ответе.
    if (caps.payrollView) {
      dto.holdingKind = a.holdingKind as AssetDto['holdingKind'];
      dto.balanceLegalEntityId = a.balanceLegalEntityId;
      dto.balanceLegalEntityName = a.balanceLegalEntity?.name ?? null;
      dto.holdingCounterpartyId = a.holdingCounterpartyId;
      dto.holdingCounterpartyName = a.holdingCounterparty?.name ?? null;
      dto.purchasePrice = a.purchasePrice === null ? null : String(a.purchasePrice);
      dto.currency = a.currency;
    }
    return dto;
  }

  private moveDto(
    m: {
      id: string;
      assetId: string;
      kind: string;
      fromBranchId: string | null;
      toBranchId: string | null;
      fromUserId: string | null;
      toUserId: string | null;
      fromValue: string | null;
      toValue: string | null;
      reason: string | null;
      movedById: string;
      movedAt: Date;
    },
    nameOf: Map<string, string>,
    branchName: Map<string, string>,
  ): AssetMoveDto {
    const label = (branchId: string | null, userId: string | null, value: string | null): string | null => {
      if (branchId) return branchName.get(branchId) ?? null;
      if (userId) return nameOf.get(userId) ?? null;
      if (value) return STATUS_LABEL.get(value) ?? HOLDING_LABEL.get(value) ?? value;
      return null;
    };
    return {
      id: m.id,
      assetId: m.assetId,
      kind: m.kind as AssetMoveDto['kind'],
      fromLabel: label(m.fromBranchId, m.fromUserId, m.fromValue),
      toLabel: label(m.toBranchId, m.toUserId, m.toValue),
      reason: m.reason,
      movedById: m.movedById,
      movedByName: nameOf.get(m.movedById) ?? null,
      movedAt: m.movedAt.toISOString(),
    };
  }

  private serviceDto(
    r: {
      id: string;
      assetId: string;
      kind: string;
      status: string;
      title: string;
      description: string | null;
      scheduledOn: Date | null;
      startedAt: Date | null;
      finishedAt: Date | null;
      nextDueOn: Date | null;
      cost: bigint | null;
      currency: string;
      performedByUserId: string | null;
      counterpartyId: string | null;
      createdAt: Date;
    },
    caps: ObjectCapsDto,
    /** Имена исполнителя и подрядчика — резолвит вызывающий (батчем в карточке). */
    names: { performedBy?: string | null; counterparty?: string | null } = {},
  ): AssetServiceRecordDto {
    const dto: AssetServiceRecordDto = {
      id: r.id,
      assetId: r.assetId,
      kind: r.kind as AssetServiceRecordDto['kind'],
      status: r.status as AssetServiceRecordDto['status'],
      title: r.title,
      description: r.description,
      scheduledOn: dateStr(r.scheduledOn),
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      nextDueOn: dateStr(r.nextDueOn),
      performedByUserId: r.performedByUserId,
      performedByName: names.performedBy ?? null,
      counterpartyId: r.counterpartyId,
      counterpartyName: names.counterparty ?? null,
      createdAt: r.createdAt.toISOString(),
    };
    if (caps.payrollView) {
      dto.cost = r.cost === null ? null : String(r.cost);
      dto.currency = r.currency;
    }
    return dto;
  }

  /**
   * Обложка плитки: первый файл-ФОТО целиком. Не ссылка: профиль `asset_photo`
   * приватный, вечной ссылки у него нет — веб получает её через движок файлов.
   */
  private async photoMap(assetIds: string[]): Promise<Map<string, FileDto>> {
    const out = new Map<string, FileDto>();
    if (assetIds.length === 0) return out;
    const byRef = await this.files.listLinked(ASSET_REF_TYPE, assetIds);
    for (const [refId, files] of byRef) {
      const photo = files.find((f) => f.kind === 'image');
      if (photo) out.set(refId, photo);
    }
    return out;
  }

  private async upsertModel(
    tx: Tx,
    workspaceId: string,
    userId: string,
    dto: { name: string; manufacturer?: string | null; kind?: string },
  ) {
    const kind = dto.kind ?? 'equipment';
    const existing = await tx.assetModel.findFirst({ where: { workspaceId, kind, name: dto.name } });
    if (existing) return existing;
    return tx.assetModel.create({
      data: {
        workspaceId,
        kind,
        name: dto.name,
        manufacturer: dto.manufacturer ?? null,
        createdById: userId,
      },
    });
  }

  /** Имена исполнителя и подрядчика одной записи обслуживания (точечный ответ мутации). */
  private async serviceNames(
    workspaceId: string,
    r: { performedByUserId: string | null; counterpartyId: string | null },
  ): Promise<{ performedBy: string | null; counterparty: string | null }> {
    const [performedBy, counterparty] = await Promise.all([
      this.userName(r.performedByUserId),
      r.counterpartyId
        ? this.db.counterparty
            .findFirst({ where: { id: r.counterpartyId, workspaceId }, select: { name: true } })
            .then((c) => c?.name ?? null)
        : Promise.resolve(null),
    ]);
    return { performedBy, counterparty };
  }

  /** Имена людей одним запросом: карточка и список не ходят в БД на каждую строку. */
  private async namesFor(ids: (string | null)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (list.length === 0) return new Map();
    const users = await this.db.user.findMany({
      where: { id: { in: list } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(users.map((u) => [u.id, [u.lastName, u.firstName].filter(Boolean).join(' ') || 'Сотрудник']));
  }

  /**
   * Чужие id внутрь не пускаем.
   *
   * Внешние ключи на юрлицо, контрагента и родительский актив в БД НЕ скоуплены
   * организацией, а у ответственного FK нет вовсе — поэтому принадлежность
   * проверяется здесь, на входе. Иначе в ответе оказывалось бы название чужого ТОО
   * или ФИО постороннего человека (`balanceLegalEntityName`, `custodianName`).
   */
  private async assertRefsOwned(
    workspaceId: string,
    refs: {
      balanceLegalEntityId?: string | null;
      holdingCounterpartyId?: string | null;
      counterpartyId?: string | null;
      parentAssetId?: string | null;
      custodianUserId?: string | null;
      performedByUserId?: string | null;
    },
  ): Promise<void> {
    const checks: Promise<void>[] = [];
    const need = async (found: Promise<unknown>, message: string): Promise<void> => {
      if (!(await found)) throw new BadRequestException(message);
    };
    if (refs.balanceLegalEntityId) {
      checks.push(
        need(
          this.db.legalEntity.findFirst({ where: { id: refs.balanceLegalEntityId, workspaceId }, select: { id: true } }),
          'Юрлицо не найдено в этой организации',
        ),
      );
    }
    for (const id of [refs.holdingCounterpartyId, refs.counterpartyId]) {
      if (!id) continue;
      checks.push(
        need(
          this.db.counterparty.findFirst({ where: { id, workspaceId }, select: { id: true } }),
          'Контрагент не найден в этой организации',
        ),
      );
    }
    if (refs.parentAssetId) {
      checks.push(
        need(
          this.db.asset.findFirst({ where: { id: refs.parentAssetId, workspaceId }, select: { id: true } }),
          'Родительское оборудование не найдено',
        ),
      );
    }
    for (const id of [refs.custodianUserId, refs.performedByUserId]) {
      if (!id) continue;
      checks.push(
        need(
          this.db.userRole.findFirst({
            where: { userId: id, context: 'workspace', tenantId: workspaceId, isActive: true },
            select: { id: true },
          }),
          'Человек не работает в этой организации',
        ),
      );
    }
    await Promise.all(checks);
  }

  private async userName(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return u ? [u.lastName, u.firstName].filter(Boolean).join(' ') : null;
  }

  /** Управлять оборудованием может тот, кто управляет хоть одним объектом. */
  private async assertAnyManage(userId: string, workspaceId: string): Promise<void> {
    const scope = await this.objects.scopeOf(userId, workspaceId);
    if (scope.full) return;
    const granted = this.objects.grantedIds(scope) ?? [];
    if (granted.length === 0) throw new NotFoundException('Организация не найдена');
    const branches = await this.db.staffBranch.findMany({
      where: { workspaceId },
      select: { id: true, ancestorIds: true },
    });
    const canAny = branches.some((b) => this.objects.capsFor(scope, b).manage);
    if (!canAny) throw new ForbiddenException('Справочник моделей ведёт управляющий объектом');
  }

  private rethrowInventory(e: unknown): never {
    if ((e as { code?: string })?.code === 'P2002') {
      throw new ConflictException({
        message: 'Инвентарный номер уже занят',
        details: { code: OBJECTS_ERROR_CODES.assetInventoryDuplicate },
      });
    }
    throw e as Error;
  }
}
