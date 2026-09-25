import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LIFECYCLE_FOREVER,
  LIFECYCLE_POLICY_IDS,
  LIFECYCLE_RETENTION_PRESETS,
  LIFECYCLE_SHORTENING_DELAY_DAYS,
  LIFECYCLE_TENANT_CLASSES,
  LIFECYCLE_TENANT_CLASS_GROUPS,
  lifecycleCeilingKeyOf,
  lifecycleDaysValue,
  lifecyclePolicy,
  type LifecycleDuration,
  type LifecycleLawClassDto,
  type LifecyclePolicy,
  type LifecycleSettingPreviewDto,
  type LifecycleSettingUpdateInput,
  type LifecycleSettingsClassDto,
  type LifecycleSettingsDto,
  type LifecycleTenantClass,
  type LifecycleWorkspaceSummaryDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, notFound } from '../../shared/errors/api-error';
import { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ChatterRefRegistry } from '../chatter/chatter-ref.registry';
import { ChatterService } from '../chatter/chatter.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { LifecycleHoldsService } from './lifecycle.holds.service';
import { LifecycleSettings, lifecycleChoiceAt, lifecycleTenantPolicies } from './lifecycle.settings';
import { isQueryTimeout, lifecycleTableOf, tenantOlderThanSql } from './lifecycle.sql';
import { msUntilPurgeWindow } from './lifecycle.window';

type Tx = Prisma.TransactionClient;
const DAY_MS = 86_400_000;
/** Потолок счёта предпросмотра: «больше N» честнее, чем минуты полного скана. */
const PREVIEW_CAP = 100_000;
/** Хроника раздела «Сроки хранения» организации. */
export const LIFECYCLE_SETTINGS_REF_TYPE = 'lifecycle_settings';
/** Классы «по закону»: срок не выбирается, страница показывает норму. */
const LAW_CLASSES = ['legal_record', 'financial_record', 'security_audit'] as const;

/** `'forever'` → null (колонка `days`), сутки — как есть. */
function toColumn(d: LifecycleDuration): number | null {
  return d === LIFECYCLE_FOREVER ? null : d;
}
/** Срок в payload и аналитике: 0 — «вечно» (ICU `=0 {…}`). */
function toCount(d: LifecycleDuration): number {
  return d === LIFECYCLE_FOREVER ? 0 : d;
}

/**
 * Сроки хранения организации (core/lifecycle Э5): страница «Данные и сроки хранения».
 *
 * Коридор класса — [наибольший пол закона политик класса; min(потолки политик, потолок
 * тарифа)]; у секционированного журнала потолок не выше общего срока (партиция уходит
 * целиком — дольше строка не проживёт). Удлинение действует сразу; сокращение — через
 * `LIFECYCLE_SHORTENING_DELAY_DAYS`: уведомление всем членам, окно экспорта, отмена до
 * вступления (ретроактивное сокращение без предупреждения — скандал Slack 2024). Потолок
 * тарифа ограничивает ВЫБОР (402 с разблокировкой), ретроактивно не режет.
 *
 * Каждое изменение — одной транзакцией: строка настройки, журнал безопасности, хроника
 * раздела, уведомление членам и факт аналитики.
 */
@Injectable()
export class LifecycleSettingsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: LifecycleSettings,
    private readonly holds: LifecycleHoldsService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
    private readonly chatter: ChatterService,
    private readonly chatterRefs: ChatterRefRegistry,
    private readonly notifications: NotificationsService,
    private readonly notificationRefs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    // Уведомление о смене срока — всем членам организации; ведёт на её главную (страница
    // сроков — владельцу и админу, остальным хватает текста уведомления)
    this.notificationRefs.register('lifecycle_retention', {
      canViewMany: async (userIds, workspaceId) => {
        const rows = await this.db.userRole.findMany({
          where: { userId: { in: userIds }, context: 'workspace', tenantId: workspaceId, isActive: true },
          select: { userId: true },
          distinct: ['userId'],
        });
        return rows.map((r) => r.userId);
      },
      href: (ref) => `/workspaces/${ref.id}`,
    });
    // Хроника раздела видна тем же, кто меняет сроки: владельцу и админу
    this.chatterRefs.register(LIFECYCLE_SETTINGS_REF_TYPE, {
      canView: (viewerId, workspaceId) =>
        this.holds.assertManager(viewerId, workspaceId).then(
          () => true,
          () => false,
        ),
    });
  }

  // ============================================================
  // Чтение
  // ============================================================

  async get(userId: string, workspaceId: string): Promise<LifecycleSettingsDto> {
    await this.holds.assertManager(userId, workspaceId);
    const rows = await this.db.lifecycleSetting.findMany({ where: { workspaceId }, take: LIFECYCLE_TENANT_CLASSES.length * 2 });
    const byClass = new Map(rows.map((r) => [r.dataClass, r]));
    const classes: LifecycleSettingsClassDto[] = [];
    for (const dataClass of LIFECYCLE_TENANT_CLASSES) classes.push(await this.classCard(workspaceId, dataClass, byClass.get(dataClass) ?? null));
    return {
      classes,
      law: this.lawClasses(),
      presets: [...LIFECYCLE_RETENTION_PRESETS],
      shorteningDelayDays: LIFECYCLE_SHORTENING_DELAY_DAYS,
    };
  }

  /** Последствия выбранного срока ДО сохранения: сколько строк старше и когда начнётся удаление. */
  async preview(userId: string, workspaceId: string, input: LifecycleSettingUpdateInput): Promise<LifecycleSettingPreviewDto> {
    await this.holds.assertManager(userId, workspaceId);
    const now = new Date();
    const row = await this.db.lifecycleSetting.findUnique({ where: { workspaceId_dataClass: { workspaceId, dataClass: input.dataClass } } });
    const policies = lifecycleTenantPolicies(input.dataClass);
    const current = row ? lifecycleChoiceAt(row, now) : this.classDefault(policies);
    const unchanged = current === input.days && !(row?.pendingSet && row.pendingEffectiveAt && row.pendingEffectiveAt > now);
    const shortened = lifecycleDaysValue(input.days) < lifecycleDaysValue(current);
    const counts: LifecycleSettingPreviewDto['counts'] = [];
    if (input.days !== LIFECYCLE_FOREVER) {
      // Строки, которые окажутся вне срока, если он вступит СЕЙЧАС (оценка сверху)
      const cutoff = new Date(now.getTime() - input.days * DAY_MS);
      for (const p of policies) counts.push({ policyId: p.id, ...(await this.countOlder(p, workspaceId, cutoff)) });
    }
    const effectiveAt = input.days === LIFECYCLE_FOREVER || unchanged ? null : shortened ? new Date(now.getTime() + LIFECYCLE_SHORTENING_DELAY_DAYS * DAY_MS) : now;
    return { dataClass: input.dataClass, days: input.days, shortened, effectiveAt: effectiveAt?.toISOString() ?? null, counts, unchanged };
  }

  /**
   * Четыре плитки страницы: место (квота Диска организации), записей по классам (счёт с
   * потолком), ближайшее автоудаление (вступающее сокращение или ночной прогон, если есть
   * строки старше срока), действующие заморозки.
   */
  async summary(userId: string, workspaceId: string): Promise<LifecycleWorkspaceSummaryDto> {
    await this.holds.assertManager(userId, workspaceId);
    const now = new Date();
    const subject = { type: 'workspace' as const, id: workspaceId };
    const storage = await this.entitlements.quotaState(subject, 'files.storageBytes');
    const rows = await this.db.lifecycleSetting.findMany({ where: { workspaceId }, take: LIFECYCLE_TENANT_CLASSES.length * 2 });
    const byClass = new Map(rows.map((r) => [r.dataClass, r]));
    const counts: LifecycleWorkspaceSummaryDto['counts'] = [];
    let next: LifecycleWorkspaceSummaryDto['nextDeletion'] = null;
    const nightly = new Date(now.getTime() + msUntilPurgeWindow(now));
    const earlier = (cand: NonNullable<LifecycleWorkspaceSummaryDto['nextDeletion']>) => {
      if (!next || cand.at < next.at) next = cand;
    };
    for (const dataClass of LIFECYCLE_TENANT_CLASSES) {
      const policies = lifecycleTenantPolicies(dataClass);
      let total = 0;
      let capped = false;
      let older = false;
      for (const p of policies) {
        const all = await this.countOlder(p, workspaceId, new Date(now.getTime() + DAY_MS));
        total += all.rows;
        capped ||= all.capped;
        const days = await this.settings.effectiveFor(p, workspaceId);
        if (days !== LIFECYCLE_FOREVER && !older) older = (await this.countOlder(p, workspaceId, new Date(now.getTime() - days * DAY_MS), 1)).rows > 0;
      }
      counts.push({ dataClass, rows: total, capped });
      const row = byClass.get(dataClass);
      if (row?.pendingSet && row.pendingEffectiveAt && row.pendingEffectiveAt > now) earlier({ dataClass, at: row.pendingEffectiveAt.toISOString(), reason: 'pending' });
      if (older) earlier({ dataClass, at: nightly.toISOString(), reason: 'nightly' });
    }
    // Как список раздела: заморозки платформы и свои (хранитель) админ не видит и не считает
    const activeHolds = await this.holds.countActiveForWorkspace(userId, workspaceId);
    return { storage: { usedBytes: storage.used, limitBytes: storage.limit }, counts, nextDeletion: next, activeHolds };
  }

  // ============================================================
  // Запись
  // ============================================================

  async update(userId: string, workspaceId: string, input: LifecycleSettingUpdateInput): Promise<LifecycleSettingsClassDto> {
    await this.holds.assertManager(userId, workspaceId);
    const policies = lifecycleTenantPolicies(input.dataClass);
    const corridor = this.policyCorridor(policies);
    if (lifecycleDaysValue(input.days) < corridor.min) throw badRequest('lifecycle.retentionBelowFloor', { days: corridor.min });
    if (lifecycleDaysValue(input.days) > lifecycleDaysValue(corridor.max)) throw badRequest('lifecycle.retentionAboveCeiling', { days: toCount(corridor.max) });
    // Потолок тарифа — отказ 402 с разблокировкой (длиннее — на ступени выше)
    await this.entitlements.assertAtMost({ type: 'workspace', id: workspaceId }, lifecycleCeilingKeyOf(input.dataClass), toColumn(input.days));

    const now = new Date();
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lifecycle:settings:${workspaceId}:${input.dataClass}`}))`;
      const row = await tx.lifecycleSetting.findUnique({ where: { workspaceId_dataClass: { workspaceId, dataClass: input.dataClass } } });
      const current = row ? lifecycleChoiceAt(row, now) : this.classDefault(policies);
      const pendingLive = !!row?.pendingSet && !!row.pendingEffectiveAt && row.pendingEffectiveAt > now;
      // Тот же срок и ничего не ждёт — повтор (двойной клик) не пишет второе событие
      if (current === input.days && !pendingLive) return;
      const shortened = lifecycleDaysValue(input.days) < lifecycleDaysValue(current);
      const effectiveAt = shortened ? new Date(now.getTime() + LIFECYCLE_SHORTENING_DELAY_DAYS * DAY_MS) : now;
      const version = (row?.policyVersion ?? 0) + 1;
      const data = shortened
        ? // Сокращение ждёт окна: действующий срок в строке — нынешний выбор (вступивший отложенный — тоже)
          { days: toColumn(current), pendingSet: true, pendingDays: toColumn(input.days), pendingEffectiveAt: effectiveAt }
        : { days: toColumn(input.days), pendingSet: false, pendingDays: null, pendingEffectiveAt: null };
      await tx.lifecycleSetting.upsert({
        where: { workspaceId_dataClass: { workspaceId, dataClass: input.dataClass } },
        create: { workspaceId, dataClass: input.dataClass, ...data, policyVersion: version, changedById: userId, changedAt: now },
        update: { ...data, policyVersion: version, changedById: userId, changedAt: now },
      });
      await this.recordChange(tx, { userId, workspaceId, dataClass: input.dataClass, from: current, to: input.days, shortened, effectiveAt, version, cancelled: false });
    });
    this.settings.invalidate(workspaceId);
    return this.cardOf(workspaceId, input.dataClass);
  }

  /** Отменить отложенное сокращение до вступления: срок остаётся нынешним. */
  async cancelPending(userId: string, workspaceId: string, dataClass: LifecycleTenantClass): Promise<LifecycleSettingsClassDto> {
    await this.holds.assertManager(userId, workspaceId);
    const now = new Date();
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lifecycle:settings:${workspaceId}:${dataClass}`}))`;
      const row = await tx.lifecycleSetting.findUnique({ where: { workspaceId_dataClass: { workspaceId, dataClass } } });
      if (!row?.pendingSet || !row.pendingEffectiveAt || row.pendingEffectiveAt <= now) throw notFound('lifecycle.noPendingChange');
      const current: LifecycleDuration = row.days === null ? LIFECYCLE_FOREVER : row.days;
      const pending: LifecycleDuration = row.pendingDays === null ? LIFECYCLE_FOREVER : row.pendingDays;
      const version = row.policyVersion + 1;
      await tx.lifecycleSetting.update({
        where: { id: row.id },
        data: { pendingSet: false, pendingDays: null, pendingEffectiveAt: null, policyVersion: version, changedById: userId, changedAt: now },
      });
      await this.recordChange(tx, { userId, workspaceId, dataClass, from: pending, to: current, shortened: false, effectiveAt: now, version, cancelled: true });
    });
    this.settings.invalidate(workspaceId);
    return this.cardOf(workspaceId, dataClass);
  }

  /**
   * Вступившие отложенные сокращения — в действующий срок (порядок в строке; принуждение
   * вступление учитывает и без этого). Крон движка, раз в час.
   */
  async promoteDue(now = new Date()): Promise<number> {
    const n = await this.db.$executeRaw`
      UPDATE "lifecycle_settings"
         SET "days" = "pending_days", "pending_set" = false, "pending_days" = NULL, "pending_effective_at" = NULL
       WHERE "pending_set" AND "pending_effective_at" <= ${now}::timestamptz`;
    return n;
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  /** Журнал безопасности, хроника раздела, уведомление всем членам, факт аналитики — в транзакции изменения. */
  private async recordChange(
    tx: Tx,
    c: { userId: string; workspaceId: string; dataClass: LifecycleTenantClass; from: LifecycleDuration; to: LifecycleDuration; shortened: boolean; effectiveAt: Date; version: number; cancelled: boolean },
  ): Promise<void> {
    await this.audit.record(tx, {
      key: 'lifecycle.settings.changed',
      workspaceId: c.workspaceId,
      target: { type: 'workspace', id: c.workspaceId },
      details: { dataClass: c.dataClass, fromDays: toColumn(c.from), toDays: toColumn(c.to), effectiveAt: c.effectiveAt.toISOString(), shortened: c.shortened },
    });
    const payload = {
      classLabelKey: `lifecycle.settings.classes.${c.dataClass}.title`,
      fromDays: toCount(c.from),
      toDays: toCount(c.to),
      shortened: c.shortened,
      effectiveOnIso: c.effectiveAt.toISOString().slice(0, 10),
    };
    await this.chatter.log(tx, {
      refType: LIFECYCLE_SETTINGS_REF_TYPE,
      refId: c.workspaceId,
      workspaceId: c.workspaceId,
      actorId: c.userId,
      typeKey: c.cancelled ? 'lifecycle_settings.retention_cancelled' : 'lifecycle_settings.retention_changed',
      payload,
    });
    const ws = await tx.workspace.findUnique({ where: { id: c.workspaceId }, select: { name: true } });
    await this.notifications.send(tx, {
      type: c.cancelled ? 'lifecycle.retention.cancelled' : 'lifecycle.retention.changed',
      to: [{ type: 'workspace', id: c.workspaceId }],
      payload: { ...payload, workspaceName: ws?.name ?? '' },
      ref: { type: 'lifecycle_retention', id: c.workspaceId },
      actorId: c.userId,
      workspaceId: c.workspaceId,
      idempotencyKey: `lifecycle:settings:${c.workspaceId}:${c.dataClass}:${c.version}`,
    });
    if (!c.cancelled) {
      await this.analytics.track(tx, 'lifecycle.retention.changed', { dataClass: c.dataClass, days: toCount(c.to), shortened: c.shortened }, { userId: c.userId, workspaceId: c.workspaceId });
    }
  }

  private async cardOf(workspaceId: string, dataClass: LifecycleTenantClass): Promise<LifecycleSettingsClassDto> {
    const row = await this.db.lifecycleSetting.findUnique({ where: { workspaceId_dataClass: { workspaceId, dataClass } } });
    return this.classCard(workspaceId, dataClass, row);
  }

  private async classCard(
    workspaceId: string,
    dataClass: LifecycleTenantClass,
    row: { days: number | null; pendingSet: boolean; pendingDays: number | null; pendingEffectiveAt: Date | null; changedById: string | null; changedAt: Date } | null,
  ): Promise<LifecycleSettingsClassDto> {
    const now = new Date();
    const policies = lifecycleTenantPolicies(dataClass);
    const corridor = this.policyCorridor(policies);
    const subject = { type: 'workspace' as const, id: workspaceId };
    const ceilingKey = lifecycleCeilingKeyOf(dataClass);
    const ceilingValue = await this.entitlements.valueOf(subject, ceilingKey);
    const planCeiling: LifecycleDuration | null = typeof ceilingValue === 'number' ? ceilingValue : null;
    const max = planCeiling !== null && planCeiling < lifecycleDaysValue(corridor.max) ? planCeiling : corridor.max;
    const current = row ? lifecycleChoiceAt(row, now) : this.classDefault(policies);
    const pendingLive = !!row?.pendingSet && !!row.pendingEffectiveAt && row.pendingEffectiveAt > now;
    return {
      dataClass,
      group: LIFECYCLE_TENANT_CLASS_GROUPS[dataClass],
      policies: policies.map((p) => p.id),
      current,
      defaultDays: this.classDefault(policies),
      custom: !!row,
      pending: pendingLive ? { days: row!.pendingDays === null ? LIFECYCLE_FOREVER : row!.pendingDays, effectiveAt: row!.pendingEffectiveAt!.toISOString() } : null,
      min: corridor.min,
      max,
      policyMax: corridor.max,
      planCeiling,
      unlock: planCeiling !== null ? await this.entitlements.unlockOf(subject, ceilingKey) : null,
      aboveCeiling: planCeiling !== null && lifecycleDaysValue(current) > planCeiling,
      changedById: row?.changedById ?? null,
      changedAt: row?.changedAt.toISOString() ?? null,
    };
  }

  /** Умолчание класса — у всех его настраиваемых политик одно (страж реестра); иначе — самое длинное. */
  private classDefault(policies: readonly LifecyclePolicy[]): LifecycleDuration {
    let best: LifecycleDuration = 1;
    for (const p of policies) if (lifecycleDaysValue(p.retention.defaultDays) > lifecycleDaysValue(best)) best = p.retention.defaultDays;
    return best;
  }

  /**
   * Коридор класса по политикам (без тарифа): пол — наибольший пол закона, потолок — наименьший
   * потолок политики; у секционированного журнала — не выше общего срока (партиция уходит
   * целиком, дольше строка не проживёт).
   */
  private policyCorridor(policies: readonly LifecyclePolicy[]): { min: number; max: LifecycleDuration } {
    let min = 1;
    let max: LifecycleDuration = LIFECYCLE_FOREVER;
    for (const p of policies) {
      const floor = p.retention.floorDays;
      if (floor !== undefined && floor !== LIFECYCLE_FOREVER && floor > min) min = floor;
      const caps: LifecycleDuration[] = [];
      if (p.retention.ceilingDays !== undefined) caps.push(p.retention.ceilingDays);
      if (p.enforcement.kind === 'drop_partition') caps.push(p.retention.defaultDays);
      for (const c of caps) if (lifecycleDaysValue(c) < lifecycleDaysValue(max)) max = c;
    }
    return { min, max: lifecycleDaysValue(max) < min ? min : max };
  }

  /** Строк организации старше момента по политике — с потолком и таймаутом (предпросмотр не читает таблицу целиком). */
  private async countOlder(policy: LifecyclePolicy, workspaceId: string, cutoff: Date, cap = PREVIEW_CAP): Promise<{ rows: number; capped: boolean }> {
    const table = lifecycleTableOf(policy);
    const en = policy.enforcement;
    const column = en.kind === 'batched_delete' || en.kind === 'drop_partition' ? en.column : null;
    if (!table || !column) return { rows: 0, capped: false };
    const sql = tenantOlderThanSql(policy, table, column, workspaceId, cutoff, cap + 1);
    if (!sql) return { rows: 0, capped: false };
    try {
      const [r] = await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
        return tx.$queryRaw<Array<{ n: bigint }>>(sql);
      });
      const n = Number(r?.n ?? 0);
      return n > cap ? { rows: cap, capped: true } : { rows: n, capped: false };
    } catch (err) {
      if (isQueryTimeout(err)) return { rows: cap, capped: true };
      throw err;
    }
  }

  /** Классы «по закону» на странице организации: политики организации с правовым основанием. */
  private lawClasses(): LifecycleLawClassDto[] {
    const out: LifecycleLawClassDto[] = [];
    for (const dataClass of LAW_CLASSES) {
      const policies = LIFECYCLE_POLICY_IDS.map((id) => lifecyclePolicy(id)!).filter(
        (p) => p.dataClass === dataClass && p.ownerKey.kind !== 'global' && p.legalBasis.kind === 'legal_obligation',
      );
      if (!policies.length) continue;
      const citation = policies.map((p) => (p.legalBasis.kind === 'legal_obligation' ? p.legalBasis.citation : null)).find((c) => !!c) ?? null;
      let floor: LifecycleDuration | null = null;
      for (const p of policies) {
        const f = p.retention.floorDays;
        if (f !== undefined && (floor === null || lifecycleDaysValue(f) > lifecycleDaysValue(floor))) floor = f;
      }
      out.push({ dataClass, policies: policies.map((p) => p.id), citation, floorDays: floor });
    }
    return out;
  }
}
