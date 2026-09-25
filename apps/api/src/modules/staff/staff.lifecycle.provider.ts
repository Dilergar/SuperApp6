import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleCanaryRegistry, LifecycleSubjectHookRegistry, type LifecycleCanaryContext, type LifecycleCanaryPlant } from '../../core/lifecycle/lifecycle.purge.registry';
import { StaffService } from './staff.service';

/**
 * Сотрудники в стирании человека (`staff.subject`, политики `StaffAssignment`, `StaffDeputy`):
 * назначения и замещения — записи ОРГАНИЗАЦИИ, но стёртый человек не может занимать
 * должность. Снимаются тем же путём, что при уходе из организации (запись в хронике по
 * каждой должности — след для кадрового аудита остаётся). Путь организации (`workspaces.subject`)
 * снимает их у текущих членств; здесь — хвосты организаций, где членства уже нет.
 * Организация, чьи записи держит заморозка, не трогается (шаг ждёт снятия).
 */
@Injectable()
export class StaffLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly staff: StaffService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.subjectHooks.register('staff.subject', {
      erase: async (userId, ctx) => {
        const [assignments, deputies] = await Promise.all([
          this.db.staffAssignment.findMany({ where: { userId }, select: { id: true, workspaceId: true } }),
          this.db.staffDeputy.findMany({ where: { deputyUserId: userId }, select: { id: true, workspaceId: true } }),
        ]);
        const byWs = new Map<string, { a: string[]; d: string[] }>();
        for (const r of assignments) (byWs.get(r.workspaceId) ?? byWs.set(r.workspaceId, { a: [], d: [] }).get(r.workspaceId)!).a.push(r.id);
        for (const r of deputies) (byWs.get(r.workspaceId) ?? byWs.set(r.workspaceId, { a: [], d: [] }).get(r.workspaceId)!).d.push(r.id);
        let rows = 0;
        for (const [workspaceId, ids] of byWs) {
          if (ctx.deadline !== null && Date.now() > ctx.deadline) return { rows, done: false };
          const [okA, okD] = await this.db.$transaction(async (tx) => [await ctx.releasable(tx, 'StaffAssignment', ids.a), await ctx.releasable(tx, 'StaffDeputy', ids.d)]);
          if (okA.length < ids.a.length || okD.length < ids.d.length) {
            ctx.held(ids.a.length - okA.length + ids.d.length - okD.length);
            continue;
          }
          await this.staff.removeAllAssignmentsForUser(workspaceId, userId, userId);
          rows += ids.a.length + ids.d.length;
        }
        return { rows, done: true };
      },
    });
    this.canary.register('staff.subject', (ctx) => this.seedCanary(ctx));
  }

  /**
   * Посев канарейки: должность в организации канарейки, назначения человека и соседа на неё,
   * заместительство человека. Строки человека снимаются (как уход из организации), соседа —
   * остаются; всё уходит с каскадом организации.
   */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const branch = await this.db.staffBranch.findFirst({ where: { workspaceId: ctx.workspaceId, isDefault: true }, select: { id: true } });
    if (!branch) throw new Error('canary: the canary organisation has no default branch');
    const position = await this.db.staffPosition.create({ data: { workspaceId: ctx.workspaceId, name: ctx.marker }, select: { id: true } });
    const base = { workspaceId: ctx.workspaceId, positionId: position.id, branchId: branch.id, assignedBy: ctx.peerId };
    const his = await this.db.staffAssignment.create({ data: { ...base, userId: ctx.userId, isPrimary: true }, select: { id: true } });
    const peers = await this.db.staffAssignment.create({ data: { ...base, userId: ctx.peerId, isPrimary: true }, select: { id: true } });
    const deputy = await this.db.staffDeputy.create({ data: { workspaceId: ctx.workspaceId, positionId: position.id, deputyUserId: ctx.userId, note: ctx.marker, createdById: ctx.peerId }, select: { id: true } });
    return [
      { policy: 'StaffAssignment', id: his.id, expect: 'gone', tenant: true },
      { policy: 'StaffAssignment', id: peers.id, expect: 'kept', tenant: true },
      { policy: 'StaffDeputy', id: deputy.id, expect: 'gone', tenant: true },
    ];
  }
}
