import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OBJECT_KINDS, type RichCardPayload, type SearchSourceType } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ChatterRefRegistry } from '../../core/chatter/chatter-ref.registry';
import { FilesRefRegistry } from '../../core/files/files-ref.registry';
import { SearchRegistry } from '../../core/search/search.registry';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';
import type { SearchProviderOpts, SearchProviderResult } from '../../core/search/search.types';
import { DriveRoutingRegistry } from '../drive/drive-routing.registry';
import { activeAssignmentWhere } from '../../shared/utils/assignment-window';
import { ObjectsService } from './objects.service';

export const BRANCH_REF_TYPE = 'branch';

/**
 * Регистрации сервиса «Объекты» в движках (Принцип 1) — одним файлом.
 * Движки про объекты не знают: сервис регистрируется в них сам.
 */
@Injectable()
export class ObjectsRegistriesProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly objects: ObjectsService,
    private readonly chatterRegistry: ChatterRefRegistry,
    private readonly filesRegistry: FilesRefRegistry,
    private readonly searchRegistry: SearchRegistry,
    private readonly richCards: RichCardRegistry,
    private readonly driveRouting: DriveRoutingRegistry,
  ) {}

  onModuleInit(): void {
    // ---- Хроника объекта: видит член объекта (или его предка) ----
    this.chatterRegistry.register(BRANCH_REF_TYPE, {
      canView: (viewerId, refId) => this.canView(viewerId, refId),
    });

    // ---- Файлы объекта (фото площадки, схемы, инструкции) ----
    this.filesRegistry.register(
      BRANCH_REF_TYPE,
      {
        canView: (viewerId, refId) => this.canView(viewerId, refId),
        canAttach: (userId, refId) => this.canManage(userId, refId),
      },
      // Видимость решает ОБЪЕКТ, а не владение файлом организации: иначе фото
      // закрытой площадки скачал бы любой, кто узнал fileId. Профили ограничены —
      // публичный профиль с вечным токеном к приватному месту не привязывается.
      { scopedPlace: true, allowedProfiles: ['document', 'asset_photo', 'drive_file'] },
    );

    // ---- Файлы объекта попадают на Диск ОРГАНИЗАЦИИ ----
    this.driveRouting.register(BRANCH_REF_TYPE, {
      resolvePlacement: async (refId) => {
        const row = await this.db.staffBranch.findUnique({
          where: { id: refId },
          select: { workspaceId: true },
        });
        return row ? { ownerType: 'workspace', ownerId: row.workspaceId } : null;
      },
    });

    // ---- Хроника оборудования: движения, ответственный, владение, ремонты ----
    // Без этой регистрации записи `asset.*` писались «в стол»: ChatterService на
    // незарегистрированный refType отвечает 404 «Хроника недоступна».
    this.chatterRegistry.register('asset', {
      canView: (viewerId, refId) => this.canViewAsset(viewerId, refId),
    });

    // ---- Файлы оборудования: фото экземпляра, паспорт модели, чек ремонта ----
    // Право считается по ОБЪЕКТУ актива: фото видит член объекта, посторонний нет.
    this.filesRegistry.register(
      'asset',
      {
        canView: (viewerId, refId) => this.canViewAsset(viewerId, refId),
        canAttach: (userId, refId) => this.canManageAsset(userId, refId),
      },
      { scopedPlace: true, allowedProfiles: ['asset_photo', 'document', 'drive_file'] },
    );
    this.filesRegistry.register(
      'asset_model',
      {
        // Инструкция крепится к МОДЕЛИ один раз — видит вся команда организации.
        canView: (viewerId, refId) => this.canViewModel(viewerId, refId),
        canAttach: (userId, refId) => this.canManageModel(userId, refId),
      },
      { allowedProfiles: ['document', 'asset_photo', 'drive_file'] },
    );
    this.filesRegistry.register(
      'asset_service',
      {
        canView: (viewerId, refId) => this.canViewService(viewerId, refId),
        canAttach: (userId, refId) => this.canManageService(userId, refId),
      },
      { scopedPlace: true, allowedProfiles: ['document', 'asset_photo', 'drive_file'] },
    );
    this.driveRouting.register('asset', {
      resolvePlacement: async (refId) => {
        const row = await this.db.asset.findUnique({ where: { id: refId }, select: { workspaceId: true } });
        return row ? { ownerType: 'workspace' as const, ownerId: row.workspaceId } : null;
      },
    });
    // Инструкция модели и чек ремонта — тоже файлы организации: без маршрутизации
    // они не появлялись на Диске вообще.
    this.driveRouting.register('asset_model', {
      resolvePlacement: async (refId) => {
        const row = await this.db.assetModel.findUnique({ where: { id: refId }, select: { workspaceId: true } });
        return row ? { ownerType: 'workspace' as const, ownerId: row.workspaceId } : null;
      },
    });
    this.driveRouting.register('asset_service', {
      resolvePlacement: async (refId) => {
        const row = await this.db.assetServiceRecord.findUnique({
          where: { id: refId },
          select: { workspaceId: true },
        });
        return row ? { ownerType: 'workspace' as const, ownerId: row.workspaceId } : null;
      },
    });

    // ---- Глобальный поиск: имя и адрес объекта ----
    this.searchRegistry.register({
      type: BRANCH_REF_TYPE as SearchSourceType,
      label: 'Объекты',
      search: (viewerId, query, opts) => this.search(viewerId, query, opts),
    });

    // ---- Поиск оборудования: имя, инвентарный, серийный ----
    this.searchRegistry.register({
      type: 'asset' as SearchSourceType,
      label: 'Оборудование',
      search: (viewerId, query, opts) => this.searchAssets(viewerId, query, opts),
    });

    // ---- Rich card «Объект»: переслать точку в чат ----
    this.richCards.registerRenderer(BRANCH_REF_TYPE, (deps, viewerId, refId) =>
      this.renderCard(deps, viewerId, refId),
    );
  }

  /** Право видеть объект — через `capsFor` (грант на сам объект ИЛИ на предка). */
  private async canView(viewerId: string, refId: string): Promise<boolean> {
    const row = await this.db.staffBranch.findUnique({
      where: { id: refId },
      select: { workspaceId: true, id: true, ancestorIds: true },
    });
    if (!row) return false;
    const scope = await this.objects.scopeOf(viewerId, row.workspaceId);
    return this.objects.capsFor(scope, row).view;
  }

  private async canManage(viewerId: string, refId: string): Promise<boolean> {
    const row = await this.db.staffBranch.findUnique({
      where: { id: refId },
      select: { workspaceId: true, id: true, ancestorIds: true },
    });
    if (!row) return false;
    const scope = await this.objects.scopeOf(viewerId, row.workspaceId);
    return this.objects.capsFor(scope, row).manage;
  }

  /**
   * Поиск объектов: организации зрителя → фильтр по имени/адресу → обрезка правами
   * (грант на сам объект или на любого предка — `ancestorIds`).
   */
  private async search(
    viewerId: string,
    query: string,
    opts: SearchProviderOpts,
  ): Promise<SearchProviderResult> {
    const memberships = await this.db.userRole.findMany({
      where: { userId: viewerId, context: 'workspace', isActive: true, role: { not: 'contractor' } },
      select: { tenantId: true },
    });
    const workspaceIds = [...new Set(memberships.map((m) => m.tenantId).filter((v): v is string => !!v))];
    if (!workspaceIds.length) return { items: [] };

    // Обрезка правами — В SQL. Раньше бралось `limit * 3` строк и права
    // проверялись в JS: если первые совпадения оказывались чужими точками сети,
    // выдача была ПУСТОЙ при живых доступных объектах.
    const rightsWhere = await this.branchRightsWhere(viewerId, workspaceIds);
    if (rightsWhere.length === 0) return { items: [] };

    const rows = await this.db.staffBranch.findMany({
      where: {
        archivedAt: null,
        AND: [
          { OR: rightsWhere },
          {
            OR: [
              { name: { contains: query, mode: 'insensitive' } },
              { address: { contains: query, mode: 'insensitive' } },
            ],
          },
        ],
      },
      orderBy: { name: 'asc' },
      take: opts.limit,
    });

    const items: SearchProviderResult['items'] = [];
    for (const r of rows) {
      items.push({
        type: BRANCH_REF_TYPE as SearchSourceType,
        id: r.id,
        title: r.name,
        snippet:
          [r.address, OBJECT_KINDS.find((k) => k.value === r.kind)?.label].filter(Boolean).join(' · ') || 'Объект',
        url: `/workspaces/${r.workspaceId}/objects/${r.id}`,
        chatId: null,
        messageId: null,
        avatar: null,
        createdAt: r.createdAt.toISOString(),
        score: 0,
      });
    }
    return { items };
  }

  /**
   * Условие «объекты, доступные зрителю» для SQL: сам объект по гранту ИЛИ любой
   * его предок (`ancestor_ids && $granted` — тот самый GIN-индекс). Считается по
   * одной области прав на организацию, а не по строке.
   */
  private async branchRightsWhere(
    viewerId: string,
    workspaceIds: string[],
  ): Promise<Prisma.StaffBranchWhereInput[]> {
    const out: Prisma.StaffBranchWhereInput[] = [];
    for (const wsId of workspaceIds) {
      const scope = await this.objects.scopeOf(viewerId, wsId);
      if (scope.full) {
        out.push({ workspaceId: wsId });
        continue;
      }
      const granted = this.objects.grantedIds(scope) ?? [];
      if (granted.length === 0) continue;
      out.push({
        workspaceId: wsId,
        OR: [{ id: { in: granted } }, { ancestorIds: { hasSome: granted } }],
      });
    }
    return out;
  }

  /** Право на актив = право на его ОБЪЕКТ (грант на объект или предка). */
  private async canViewAsset(viewerId: string, refId: string): Promise<boolean> {
    const caps = await this.assetCaps(viewerId, refId);
    return caps?.view ?? false;
  }

  private async canManageAsset(viewerId: string, refId: string): Promise<boolean> {
    const caps = await this.assetCaps(viewerId, refId);
    return caps?.manage ?? false;
  }

  private async assetCaps(viewerId: string, assetId: string) {
    const asset = await this.db.asset.findUnique({
      where: { id: assetId },
      select: { workspaceId: true, branch: { select: { id: true, ancestorIds: true } } },
    });
    if (!asset) return null;
    const scope = await this.objects.scopeOf(viewerId, asset.workspaceId);
    return this.objects.capsFor(scope, asset.branch);
  }

  private async canViewModel(viewerId: string, refId: string): Promise<boolean> {
    const model = await this.db.assetModel.findUnique({ where: { id: refId }, select: { workspaceId: true } });
    if (!model) return false;
    const scope = await this.objects.scopeOf(viewerId, model.workspaceId);
    return !!scope.role && scope.role !== 'contractor';
  }

  private async canManageModel(viewerId: string, refId: string): Promise<boolean> {
    const model = await this.db.assetModel.findUnique({ where: { id: refId }, select: { workspaceId: true } });
    if (!model) return false;
    const scope = await this.objects.scopeOf(viewerId, model.workspaceId);
    if (scope.full) return true;
    const branches = await this.db.staffBranch.findMany({
      where: { workspaceId: model.workspaceId },
      select: { id: true, ancestorIds: true },
    });
    return branches.some((b) => this.objects.capsFor(scope, b).manage);
  }

  private async canViewService(viewerId: string, refId: string): Promise<boolean> {
    const rec = await this.db.assetServiceRecord.findUnique({ where: { id: refId }, select: { assetId: true } });
    return rec ? this.canViewAsset(viewerId, rec.assetId) : false;
  }

  private async canManageService(viewerId: string, refId: string): Promise<boolean> {
    const rec = await this.db.assetServiceRecord.findUnique({ where: { id: refId }, select: { assetId: true } });
    return rec ? this.canManageAsset(viewerId, rec.assetId) : false;
  }

  /** Поиск оборудования: организации зрителя, обрезка правами по объекту актива. */
  private async searchAssets(
    viewerId: string,
    query: string,
    opts: SearchProviderOpts,
  ): Promise<SearchProviderResult> {
    const memberships = await this.db.userRole.findMany({
      where: { userId: viewerId, context: 'workspace', isActive: true, role: { not: 'contractor' } },
      select: { tenantId: true },
    });
    const workspaceIds = [...new Set(memberships.map((m) => m.tenantId).filter((v): v is string => !!v))];
    if (!workspaceIds.length) return { items: [] };
    // Право на актив = право на его ОБЪЕКТ, и это условие тоже уходит в SQL.
    const rights = await this.branchRightsWhere(viewerId, workspaceIds);
    if (rights.length === 0) return { items: [] };
    const rows = await this.db.asset.findMany({
      where: {
        archivedAt: null,
        AND: [
          {
            OR: rights.map((r) => ({
              workspaceId: r.workspaceId as string,
              ...(r.OR ? { branch: { OR: r.OR } } : {}),
            })),
          },
          {
            OR: [
              { name: { contains: query, mode: 'insensitive' } },
              { inventoryNumber: { contains: query, mode: 'insensitive' } },
              { serialNumber: { contains: query, mode: 'insensitive' } },
            ],
          },
        ],
      },
      include: { branch: { select: { id: true, name: true, ancestorIds: true } } },
      orderBy: { name: 'asc' },
      take: opts.limit,
    });
    const items: SearchProviderResult['items'] = [];
    for (const r of rows) {
      items.push({
        type: 'asset' as SearchSourceType,
        id: r.id,
        title: r.name,
        snippet: [r.branch.name, r.inventoryNumber ? `инв. ${r.inventoryNumber}` : null].filter(Boolean).join(' · '),
        url: `/workspaces/${r.workspaceId}/objects/${r.branchId}/assets/${r.id}`,
        chatId: null,
        messageId: null,
        avatar: null,
        createdAt: r.createdAt.toISOString(),
        score: 0,
      });
    }
    return { items };
  }

  private async renderCard(
    deps: RichCardDeps,
    viewerId: string,
    refId: string,
  ): Promise<RichCardPayload | null> {
    const row = await deps.db.staffBranch.findUnique({ where: { id: refId } });
    if (!row) return null;
    const scope = await this.objects.scopeOf(viewerId, row.workspaceId);
    const caps = this.objects.capsFor(scope, row);
    if (!caps.view) return null;

    const kindLabel = OBJECT_KINDS.find((k) => k.value === row.kind)?.label ?? 'Объект';
    const members = await deps.db.staffAssignment.findMany({
      // Счётчик людей на карточке — про действующих (правило канона: каждый
      // потребитель «кто сейчас работает» фильтрует по датам назначения).
      where: { workspaceId: row.workspaceId, branchId: row.id, ...activeAssignmentWhere() },
      select: { userId: true },
    });
    return {
      kind: 'rich_card',
      cardType: BRANCH_REF_TYPE,
      ref: { type: BRANCH_REF_TYPE, id: refId },
      title: row.name,
      subtitle: row.address ?? kindLabel,
      icon: '🏬',
      imageUrl: null,
      fields: [
        { label: 'Вид', value: kindLabel },
        { label: 'Людей', value: String(new Set(members.map((m) => m.userId)).size) },
        ...(row.timeZone ? [{ label: 'Пояс', value: row.timeZone }] : []),
      ],
      progress: null,
      status: row.archivedAt ? 'В архиве' : kindLabel,
      actions: [],
      href: `/workspaces/${row.workspaceId}/objects/${row.id}`,
    };
  }
}
