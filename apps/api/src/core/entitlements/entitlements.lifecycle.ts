import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Cron } from '@nestjs/schedule';
import { GRACE_DAYS, PLAN_DEFS, type EntitlementSubjectRef, type EntitlementSubjectType, type PlanKey } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { EntitlementsCache } from './entitlements.cache';
import { ENTITLEMENT_JOBS, TRIAL_ENDING_WARN_DAYS } from './entitlements.constants';
import { EntitlementsNotifier } from './entitlements.notifications';
import { QuotaReconcileRegistry } from './entitlements.registry';
import { EntitlementsService } from './entitlements.service';
import { AnalyticsService } from '../analytics/analytics.service';

const LIVE = ['trialing', 'active', 'past_due'] as const;

/**
 * Сроки и переходы статусов. Истечение считается ПРИ ЧТЕНИИ (резолвер фильтрует по датам),
 * а джоб `entitlements.expiry` — будильник: status-guarded переход, бамп эпохи,
 * уведомление. Кроны — второй ремень (потерянный джоб) и предупреждения о конце триала.
 */
@Injectable()
export class EntitlementsLifecycle implements OnModuleInit {
  private readonly logger = new Logger(EntitlementsLifecycle.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly jobs: JobsRegistry,
    private readonly cache: EntitlementsCache,
    private readonly notifier: EntitlementsNotifier,
    private readonly reconcile: QuotaReconcileRegistry,
    private readonly entitlements: EntitlementsService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Факт окончания подписки — в транзакции перехода статуса. */
  private trackExpired(tx: Prisma.TransactionClient, subject: EntitlementSubjectRef, planKey: string): Promise<void> {
    return this.analytics.track(
      tx,
      'entitlements.subscription.expired',
      { subscriptionPlan: planKey, contextType: subject.type },
      subject.type === 'user' ? { userId: subject.id, workspaceId: null } : { userId: null, workspaceId: subject.type === 'workspace' ? subject.id : null },
    );
  }

  onModuleInit(): void {
    this.jobs.register(ENTITLEMENT_JOBS.expiry, (payload) => this.handleExpiry(payload), { maxAttempts: 5 });
  }

  private async handleExpiry(payload: Record<string, unknown>): Promise<void> {
    const kind = payload.kind;
    const id = typeof payload.id === 'string' ? payload.id : null;
    if (!id) throw new JobDiscardError('entitlements.expiry: no id');
    if (kind === 'subscription') return this.applySubscriptionExpiry(id);
    if (kind === 'grant') {
      const g = await this.db.entitlementGrant.findUnique({ where: { id }, select: { subjectType: true, subjectId: true } });
      if (g) await this.cache.bump({ type: g.subjectType as EntitlementSubjectType, id: g.subjectId });
      return;
    }
    if (kind === 'override') {
      const o = await this.db.entitlementOverride.findUnique({ where: { id }, select: { subjectType: true, subjectId: true } });
      if (o) await this.cache.bump({ type: o.subjectType as EntitlementSubjectType, id: o.subjectId });
      return;
    }
    throw new JobDiscardError(`entitlements.expiry: unknown kind ${String(kind)}`);
  }

  /**
   * Переходы: trialing → expired (trialEndsAt) · active → past_due (currentPeriodEnd,
   * grace +15 дней) · past_due → expired (graceUntil). «Ещё не созрело» (срок сдвинули) —
   * не ошибка: ставим будильник на новый срок и выходим.
   */
  async applySubscriptionExpiry(subscriptionId: string): Promise<void> {
    const sub = await this.db.subjectSubscription.findUnique({
      where: { id: subscriptionId },
      include: { planVersion: { include: { plan: true } } },
    });
    if (!sub || !(LIVE as readonly string[]).includes(sub.status)) return;
    const subject: EntitlementSubjectRef = { type: sub.subjectType as EntitlementSubjectType, id: sub.subjectId };
    const now = Date.now();
    const planKey = sub.planVersion.plan.key as PlanKey;
    const planLabelKey = PLAN_DEFS[planKey]?.labelKey ?? `entitlements.plans.${planKey}`;

    if (sub.status === 'trialing') {
      if (!sub.trialEndsAt) return;
      if (sub.trialEndsAt.getTime() > now) return this.entitlements.scheduleExpiry(null, sub);
      const res = await this.db.$transaction(async (tx) => {
        const r = await tx.subjectSubscription.updateMany({ where: { id: sub.id, status: 'trialing' }, data: { status: 'expired' } });
        if (r.count !== 1) return false;
        await this.notifier.notify(tx, subject, 'entitlement.trial.expired', { planKey: planLabelKey }, { idempotencyKey: `ent:trial-expired:${sub.id}` });
        await this.trackExpired(tx, subject, planKey);
        return true;
      });
      if (res) await this.cache.bump(subject);
      return;
    }

    if (sub.status === 'active') {
      if (!sub.currentPeriodEnd) return;
      if (sub.currentPeriodEnd.getTime() > now) return this.entitlements.scheduleExpiry(null, sub);
      const graceUntil = new Date(now + GRACE_DAYS * 86_400_000);
      const res = await this.db.$transaction(async (tx) => {
        const r = await tx.subjectSubscription.updateMany({ where: { id: sub.id, status: 'active' }, data: { status: 'past_due', graceUntil } });
        if (r.count !== 1) return false;
        await this.entitlements.scheduleExpiry(tx, { ...sub, status: 'past_due', graceUntil });
        await this.notifier.notify(
          tx,
          subject,
          'entitlement.subscription.grace',
          { planKey: planLabelKey, untilDateIso: graceUntil.toISOString().slice(0, 10) },
          { idempotencyKey: `ent:grace:${sub.id}:${graceUntil.getTime()}` },
        );
        return true;
      });
      if (res) await this.cache.bump(subject);
      return;
    }

    // past_due
    const due = sub.graceUntil ?? sub.currentPeriodEnd;
    if (!due) return;
    if (due.getTime() > now) return this.entitlements.scheduleExpiry(null, sub);
    const res = await this.db.$transaction(async (tx) => {
      const r = await tx.subjectSubscription.updateMany({ where: { id: sub.id, status: 'past_due' }, data: { status: 'expired' } });
      if (r.count !== 1) return false;
      await this.notifier.notify(tx, subject, 'entitlement.subscription.expired', { planKey: planLabelKey }, { idempotencyKey: `ent:expired:${sub.id}` });
      await this.trackExpired(tx, subject, planKey);
      return true;
    });
    if (res) await this.cache.bump(subject);
  }

  /** Предупреждения «пробный период заканчивается» за 7 и за 1 день (одно на рубеж). */
  @Cron('15 4 * * *')
  async trialWarningsCron(): Promise<void> {
    const ran = await this.redis.withLock('cron:entitlements-trial-warnings', 10 * 60 * 1000, () => this.runTrialWarnings());
    if (ran === null) this.logger.debug('trial warnings skipped: lock held by another instance');
  }

  async runTrialWarnings(): Promise<number> {
    const now = Date.now();
    const horizon = new Date(now + Math.max(...TRIAL_ENDING_WARN_DAYS) * 86_400_000);
    const subs = await this.db.subjectSubscription.findMany({
      where: { status: 'trialing', trialEndsAt: { gt: new Date(now), lte: horizon } },
      include: { planVersion: { include: { plan: true } } },
      take: 5000,
    });
    let sent = 0;
    for (const sub of subs) {
      const daysLeft = Math.ceil((sub.trialEndsAt!.getTime() - now) / 86_400_000);
      const rung = [...TRIAL_ENDING_WARN_DAYS].sort((a, b) => a - b).find((d) => daysLeft <= d);
      if (!rung) continue;
      const planKey = sub.planVersion.plan.key as PlanKey;
      await this.notifier.notify(
        null,
        { type: sub.subjectType as EntitlementSubjectType, id: sub.subjectId },
        'entitlement.trial.ending',
        { planKey: PLAN_DEFS[planKey]?.labelKey ?? `entitlements.plans.${planKey}`, days: daysLeft },
        { idempotencyKey: `ent:trial-ending:${sub.id}:${rung}` },
      );
      sent += 1;
    }
    return sent;
  }

  /** Второй ремень: живые подписки с прошедшим сроком, у которых будильник потерялся. */
  @Cron('35 4 * * *')
  async overdueSweepCron(): Promise<void> {
    const ran = await this.redis.withLock('cron:entitlements-overdue', 10 * 60 * 1000, () => this.runOverdueSweep());
    if (ran === null) this.logger.debug('overdue sweep skipped: lock held by another instance');
  }

  async runOverdueSweep(): Promise<number> {
    const now = new Date();
    const subs = await this.db.subjectSubscription.findMany({
      where: {
        OR: [
          { status: 'trialing', trialEndsAt: { lte: now } },
          { status: 'active', currentPeriodEnd: { lte: now } },
          { status: 'past_due', graceUntil: { lte: now } },
        ],
      },
      select: { id: true },
      take: 5000,
    });
    for (const s of subs) await this.applySubscriptionExpiry(s.id);
    return subs.length;
  }

  /** Сверка расходуемых квот с фактом — владельцы данных пересчитывают свои ключи. */
  @Cron('50 4 * * *')
  async quotaReconcileCron(): Promise<void> {
    const ran = await this.redis.withLock('cron:entitlements-quota-reconcile', 30 * 60 * 1000, () => this.runQuotaReconcile());
    if (ran === null) this.logger.debug('quota reconcile skipped: lock held by another instance');
  }

  async runQuotaReconcile(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [key, provider] of this.reconcile.entries()) {
      try {
        out[key] = await provider.reconcile();
      } catch (err) {
        this.logger.error(`quota reconcile "${key}" failed: ${(err as Error).message}`);
        out[key] = -1;
      }
    }
    this.logger.log(`quota reconcile: ${JSON.stringify(out)}`);
    return out;
  }
}
