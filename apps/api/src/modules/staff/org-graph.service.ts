import { Injectable, Logger } from '@nestjs/common';
import { TEAM_WORKSPACE_ROLES } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { activeAssignmentWhere } from '../../shared/utils/assignment-window';
import { RedisService } from '../../shared/redis/redis.service';
import { buildOrgGraph, type OrgGraph, type OrgSnapshotData } from './org-resolve';

const WS_CONTEXT = 'workspace';
const REDIS_KEY = (wsId: string) => `org:graph:v1:${wsId}`;
const REDIS_TTL_SECONDS = 600;
const LOCAL_TTL_MS = 15_000;

/**
 * Снимок оргструктуры организации (четыре запроса) + кэш: процессный Map 15 с и Redis
 * 600 с. Сброс — `invalidate(workspaceId)` после КАЖДОЙ мутации Staff (там же, где
 * resync проекции прав) и при смене состава/владельца организации.
 *
 * Строки замещений в снимке сырые (даты — строки YYYY-MM-DD); «сегодня» в снимок не
 * запекается — дата всегда параметр функций org-resolve, иначе кэш был бы небезопасен.
 * Redis best-effort: его сбой не мешает читать структуру.
 */
@Injectable()
export class OrgGraphService {
  private readonly logger = new Logger(OrgGraphService.name);
  private readonly local = new Map<string, { at: number; graph: OrgGraph }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async load(workspaceId: string): Promise<OrgGraph> {
    const hit = this.local.get(workspaceId);
    if (hit && Date.now() - hit.at < LOCAL_TTL_MS) return hit.graph;

    let data: OrgSnapshotData | null = null;
    try {
      data = await this.redis.getJson<OrgSnapshotData>(REDIS_KEY(workspaceId));
    } catch (e) {
      this.logger.warn(`org graph redis read: ${(e as Error).message}`);
    }
    if (!data) {
      data = await this.snapshot(workspaceId);
      try {
        await this.redis.set(REDIS_KEY(workspaceId), JSON.stringify(data), REDIS_TTL_SECONDS);
      } catch (e) {
        this.logger.warn(`org graph redis write: ${(e as Error).message}`);
      }
    }
    const graph = buildOrgGraph(data);
    this.local.set(workspaceId, { at: Date.now(), graph });
    return graph;
  }

  /** Снимок МИМО кэша (проверка циклов на записи читает живые данные) */
  async loadFresh(workspaceId: string): Promise<OrgGraph> {
    return buildOrgGraph(await this.snapshot(workspaceId));
  }

  async invalidate(workspaceId: string): Promise<void> {
    this.local.delete(workspaceId);
    try {
      await this.redis.del(REDIS_KEY(workspaceId));
    } catch (e) {
      this.logger.warn(`org graph redis del: ${(e as Error).message}`);
    }
  }

  private async snapshot(workspaceId: string): Promise<OrgSnapshotData> {
    const [ws, departments, positions, branches, assignments, deputies, members] = await Promise.all([
      this.db.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } }),
      this.db.staffDepartment.findMany({
        where: { workspaceId },
        select: { id: true, name: true, parentId: true, headPositionId: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.staffPosition.findMany({
        where: { workspaceId },
        select: { id: true, name: true, departmentId: true, reportsToPositionId: true, glyph: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.staffBranch.findMany({
        where: { workspaceId },
        // ancestorIds — дерево объектов: «руководитель объекта» поднимается к
        // ближайшему предку с управляющей должностью (у этажа своей может не быть).
        select: {
          id: true,
          name: true,
          isDefault: true,
          headPositionId: true,
          sortOrder: true,
          ancestorIds: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      // Только ДЕЙСТВУЮЩИЕ: вертикаль, адресаты и ростер не должны видеть
      // истёкшее назначение. Снимок сбрасывается джобом rollover в полночь.
      this.db.staffAssignment.findMany({
        where: { workspaceId, ...activeAssignmentWhere() },
        select: {
          id: true,
          userId: true,
          positionId: true,
          branchId: true,
          isPrimary: true,
          status: true,
          startsOn: true,
          endsOn: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.staffDeputy.findMany({
        where: { workspaceId },
        select: {
          id: true,
          positionId: true,
          branchId: true,
          deputyPositionId: true,
          deputyUserId: true,
          startsOn: true,
          endsOn: true,
          note: true,
          createdById: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.userRole.findMany({
        where: { context: WS_CONTEXT, tenantId: workspaceId, isActive: true, role: { in: [...TEAM_WORKSPACE_ROLES] } },
        select: { userId: true, role: true },
      }),
    ]);
    const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    return {
      workspaceId,
      ownerId: ws?.ownerId ?? '',
      departments,
      positions,
      branches,
      assignments: assignments.map((a) => ({
        ...a,
        startsOn: date(a.startsOn),
        endsOn: date(a.endsOn),
        createdAt: a.createdAt.toISOString(),
      })),
      deputies: deputies.map((d) => ({
        ...d,
        startsOn: date(d.startsOn),
        endsOn: date(d.endsOn),
        createdAt: d.createdAt.toISOString(),
      })),
      members,
    };
  }
}
