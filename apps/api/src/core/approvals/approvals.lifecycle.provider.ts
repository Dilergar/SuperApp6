import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleCanaryRegistry, LifecycleTenantHookRegistry, type LifecycleCanaryContext, type LifecycleCanaryPlant } from '../lifecycle/lifecycle.purge.registry';
import { ApprovalsService } from './approvals.service';

/**
 * Хук каскада организации `approvals.workspace` (политика `ApprovalRequest`): живые заявки
 * организации больше никого не ждут — отменяются (стопки людей чистеют), затем все заявки
 * организации удаляются (внешнего ключа на организацию у них нет — сами не уйдут). Шаг согласования человека (снимок его имени)
 * псевдонимизирует общий шаг стирания по `assigneeId` — посев канарейки здесь.
 */
@Injectable()
export class ApprovalsLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly approvals: ApprovalsService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('approvals.workspace', {
      purge: (workspaceId, ctx) => this.approvals.purgeWorkspace(workspaceId, { deadline: ctx.deadline, releasable: (tx, ids) => ctx.releasable(tx, 'ApprovalRequest', ids) }),
      estimate: (workspaceId) => this.db.approvalRequest.count({ where: { workspaceId } }),
    });
    this.canary.register('approvals.steps', (ctx) => this.seedCanary(ctx));
  }

  /**
   * Посев канарейки: закрытая заявка организации (соседа), шаг которой решал человек, со снимком
   * его имени — остаётся организации без имени, уходит с её каскадом. Закрыта — кроны
   * эскалации её не трогают.
   */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const now = new Date();
    const req = await this.db.approvalRequest.create({
      data: {
        refType: 'org_document',
        refId: randomUUID(),
        refTitle: ctx.marker,
        workspaceId: ctx.workspaceId,
        status: 'approved',
        createdById: ctx.peerId,
        finishedAt: now,
        steps: {
          create: { order: 1, kind: 'approval', title: ctx.marker, status: 'approved', assigneeType: 'user', assigneeId: ctx.userId, assigneeLabelName: `Canary ${ctx.name}`, assigneeLabel: `Canary ${ctx.name}`, decidedAt: now },
        },
      },
      select: { id: true, steps: { select: { id: true } } },
    });
    return [
      { policy: 'ApprovalRequest', id: req.id, expect: 'kept', tenant: true },
      ...req.steps.map((st) => ({ policy: 'ApprovalStep', id: st.id, expect: 'kept' as const, tenant: true })),
    ];
  }
}
