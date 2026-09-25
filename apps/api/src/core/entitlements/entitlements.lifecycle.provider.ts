import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleCanaryRegistry, LifecycleTenantHookRegistry, type LifecycleCanaryContext, type LifecycleCanaryPlant } from '../lifecycle/lifecycle.purge.registry';
import { EntitlementsService } from './entitlements.service';

/**
 * Хук каскада организации `entitlements.subject` (подписка, гранты, оверрайды, счётчики —
 * строки без FK): тариф организации забывается путём движка (отметка «триал использован»
 * остаётся — один бизнес-триал на человека). Тариф человека стирает корневой шаг
 * `users.account` (`forgetSubject`) — посев канарейки здесь, у владельца таблиц.
 */
@Injectable()
export class EntitlementsLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly entitlements: EntitlementsService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('entitlements.subject', {
      purge: async (workspaceId) => {
        await this.db.$transaction((tx) => this.entitlements.forgetSubject(tx, { type: 'workspace', id: workspaceId }));
      },
      estimate: async (workspaceId) =>
        (await this.db.subjectSubscription.count({ where: { subjectType: 'workspace', subjectId: workspaceId } })) +
        (await this.db.quotaCounter.count({ where: { subjectType: 'workspace', subjectId: workspaceId } })),
    });
    this.canary.register('entitlements.user', (ctx) => this.seedCanary(ctx));
  }

  /** Посев канарейки: подписка, грант, оверрайд и счётчик квоты человека — стирает `users.account`. */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const subject = { subjectType: 'user', subjectId: ctx.userId };
    const version = await this.db.planVersion.findFirst({ where: { status: 'published' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!version) throw new Error('canary: no published plan version to subscribe the synthetic person to');
    const inHour = new Date(Date.now() + 3_600_000);
    const sub = await this.db.subjectSubscription.create({ data: { ...subject, planVersionId: version.id, status: 'active', source: 'manual', createdBy: ctx.peerId }, select: { id: true } });
    const grant = await this.db.entitlementGrant.create({
      data: { ...subject, key: 'workspaces.maxOwned', value: 2, source: 'manual', reason: ctx.marker, grantedBy: ctx.peerId, idempotencyKey: `canary:${randomUUID()}`, validUntil: inHour },
      select: { id: true },
    });
    const override = await this.db.entitlementOverride.create({
      data: { ...subject, key: 'workspaces.maxOwned', mode: 'set', value: 3, reason: ctx.marker, validUntil: inHour, createdBy: ctx.peerId },
      select: { id: true },
    });
    const counter = await this.db.quotaCounter.create({ data: { ...subject, key: 'visibility.revealsPerDay', used: 1 }, select: { id: true } });
    return [
      { policy: 'SubjectSubscription', id: sub.id, expect: 'gone' },
      { policy: 'EntitlementGrant', id: grant.id, expect: 'gone' },
      { policy: 'EntitlementOverride', id: override.id, expect: 'gone' },
      { policy: 'QuotaCounter', id: counter.id, expect: 'gone' },
    ];
  }
}
