import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ENTITLEMENT_ERROR_CODES,
  ENTITLEMENT_REGISTRY,
  GRACE_DAYS,
  PLAN_DEFS,
  TRIAL_DAYS,
  TRIAL_PLAN,
  WORKSPACE_ROLE_RANK,
  entitlementKeysFor,
  isEntitlementKey,
  type EntitlementCheckItemDto,
  type EntitlementCheckResponseDto,
  type EntitlementCheckResultDto,
  type EntitlementErrorCode,
  type EntitlementGrantDto,
  type EntitlementKey,
  type EntitlementOverrideDto,
  type EntitlementSnapshotDto,
  type EntitlementSubjectDetailDto,
  type EntitlementSubjectRef,
  type EntitlementSubjectType,
  type EntitlementUnlockDto,
  type EntitlementValue,
  type EntitlementValueDto,
  type EntitlementsChangedBusPayload,
  type GrantCreateInput,
  type OverrideSetInput,
  type PlanKey,
  type QuotaCounterDto,
  type SubjectSubscriptionDto,
  type SubscriptionSetInput,
  type SubscriptionStatus,
  type SubscriptionSummaryDto,
  type TrialExtendInput,
  type WorkspaceRole,
  type WsEntitlementsChanged, uuidv7 } from '@superapp/shared';

import { DatabaseService } from '../../shared/database/database.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { utcTs } from '../../shared/database/sql-time';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { badRequest, conflict, notFound, paymentRequired } from '../../shared/errors/api-error';
import { JobsService } from '../jobs/jobs.service';
import { RealtimeRegistry } from '../realtime/realtime.registry';
import { EntitlementsCache, type RawSnapshot, type RawSubscription } from './entitlements.cache';
import { EntitlementsCatalogService } from './entitlements.catalog.service';
import { ENTITLEMENT_BUS_EVENTS, ENTITLEMENT_JOBS, ENTITLEMENT_QUOTA_WARN_RATIO } from './entitlements.constants';
import { EntitlementsNotifier } from './entitlements.notifications';
import { EntitlementsQuotaService, type QuotaState } from './entitlements.quota.service';
import { UsageProviderRegistry } from './entitlements.registry';
import { resolveSubjectValues, type ResolvedValue } from './entitlements.resolver';

type Tx = Prisma.TransactionClient;
const LIVE_STATUSES = ['trialing', 'active', 'past_due'] as const;
const ENDED_STATUSES = ['expired', 'cancelled'];
/** Сколько дней после конца подписки клиент ещё показывает «тариф истёк» (а не «никогда не было») */
const RECENTLY_ENDED_DAYS = 30;
type SubscriptionRow = Prisma.SubjectSubscriptionGetPayload<{ include: { planVersion: { include: { plan: true } } } }>;
/** Счётчики квот субъекта, прочитанные один раз на запрос (см. `countersLoader`) */
type CountersLoader = (subject: EntitlementSubjectRef) => Promise<Map<string, QuotaState>>;
/** Опубликованные значения планов — снимок каталога, общий на весь ответ */
type PublishedValues = Map<PlanKey, Partial<Record<string, EntitlementValue>>>;

/** Вид правки кабинета для уведомления субъекту (ключ каталога собирается из него). */
type SupportChange = 'subscriptionSet' | 'subscriptionCleared' | 'trialExtended' | 'grantCreated' | 'grantRevoked' | 'overrideSet' | 'overrideCleared';

/** Строки полиморфных таблиц → по субъекту (пакетный резолв читает их одним запросом). */
function groupBySubject<T extends { subjectId: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) out.set(row.subjectId, [...(out.get(row.subjectId) ?? []), row]);
  return out;
}

/**
 * core/entitlements — 19-й платформенный движок: «кто что может и сколько».
 *
 * Вход резолва всегда (userId, субъект контекста): person-ключи — из субъекта `user`,
 * container-ключи — из субъекта контекста (личное пространство = сам человек;
 * организация — из ALS `X-Workspace-Id`, не из query). Порядок в ручке потребителя:
 * контекст → `access.can` (403, без апселла) → `entitlements.assert*` (402) →
 * резерв квоты в tx → эффект. Права движок НЕ проверяет — проверяет вызывающий.
 */
@Injectable()
export class EntitlementsService implements OnModuleInit {
  private readonly logger = new Logger(EntitlementsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly cache: EntitlementsCache,
    private readonly catalog: EntitlementsCatalogService,
    private readonly quota: EntitlementsQuotaService,
    private readonly usage: UsageProviderRegistry,
    private readonly wsContext: WorkspaceContextService,
    private readonly jobs: JobsService,
    private readonly notifier: EntitlementsNotifier,
    private readonly realtime: RealtimeRegistry,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Опции факта аналитики для субъекта тарифа: человек — актор, организация — контекст. */
  private analyticsSubject(subject: EntitlementSubjectRef): { userId?: string; workspaceId: string | null } {
    return subject.type === 'user' ? { userId: subject.id, workspaceId: null } : { workspaceId: subject.type === 'workspace' ? subject.id : null };
  }

  onModuleInit(): void {
    // Снимок человека изменился → его вкладки перечитывают `/entitlements/me`.
    // Для организации состав знает modules/workspaces — он подписывается сам.
    this.realtime.registerRelay(ENTITLEMENT_BUS_EVENTS.changed, ({ payload }) => {
      const p = payload as EntitlementsChangedBusPayload;
      if (p?.subjectType !== 'user' || !p.subjectId) return null;
      const wire: WsEntitlementsChanged = { subjectType: p.subjectType, subjectId: p.subjectId };
      return { rooms: [`user:${p.subjectId}`], name: 'entitlements:changed', payload: wire };
    });
  }

  // ============================================================
  // Субъекты
  // ============================================================

  /** Субъект контекста запроса: организация из ALS либо сам человек. */
  contextSubject(userId: string): EntitlementSubjectRef {
    const ws = this.wsContext.activeWorkspaceId;
    return ws ? { type: 'workspace', id: ws } : { type: 'user', id: userId };
  }

  /**
   * Зритель ЭТОГО запроса распоряжается тарифом субъекта? Личное пространство —
   * всегда своё; организация — владелец и админ (роль из чокпоинта, ALS). Вне
   * запроса (джоб, крон, кабинет) роли нет — значит «не распоряжается»: такие
   * пути ходят через `system*`-методы, где гейта нет по конвенции.
   */
  private managesSubject(subject: EntitlementSubjectRef): boolean {
    if (subject.type !== 'workspace') return true;
    const ctx = this.wsContext.get();
    if (!ctx || ctx.activeWorkspaceId !== subject.id) return false;
    const rank = ctx.role ? (WORKSPACE_ROLE_RANK[ctx.role as WorkspaceRole] ?? 0) : 0;
    return rank >= WORKSPACE_ROLE_RANK.admin;
  }

  /** Субъект для ключа: person-ключи всегда у человека, container — у контекста. */
  private subjectForKey(userId: string, key: EntitlementKey, subject?: EntitlementSubjectRef): EntitlementSubjectRef {
    if (ENTITLEMENT_REGISTRY[key].carrier === 'person') return { type: 'user', id: userId };
    return subject ?? this.contextSubject(userId);
  }

  /** Ключ объявлен у субъекта этого вида? (реестр, поле `subjects`) */
  private keyAppliesTo(key: EntitlementKey, subjectType: EntitlementSubjectType): boolean {
    return ENTITLEMENT_REGISTRY[key].subjects.includes(subjectType);
  }

  /**
   * Fail-CLOSED на входе резолва: у ключа, которого у субъекта нет, `valueOf` вернул
   * бы `null`, а `null` у limit/quota читается как «без ограничения» — потолок молча
   * исчез бы, а `assertCanCreate` вышел бы ДО лока и COUNT. Спросить личный ключ у
   * организации (или наоборот) — баг ВЫЗЫВАЮЩЕГО, а не отказ тарифа: внутренняя
   * ошибка, не 402. Частая причина — вызов `can`/`limit` вне запроса (в джобе ALS
   * пуст, и `contextSubject` отдаёт личный субъект): субъект там передают явно.
   */
  private assertKeyForSubject(key: EntitlementKey, subject: EntitlementSubjectRef): void {
    if (this.keyAppliesTo(key, subject.type)) return;
    throw new Error(
      `entitlements: key "${key}" is not declared for subject type "${subject.type}" (registry: ${ENTITLEMENT_REGISTRY[key].subjects.join('|')})`,
    );
  }

  // ============================================================
  // Снимок субъекта (кэш)
  // ============================================================

  async subjectSnapshot(subject: EntitlementSubjectRef): Promise<RawSnapshot> {
    return this.cache.getOrCompute(subject, () => this.compute(subject));
  }

  private async liveSubscription(subject: EntitlementSubjectRef, tx: Tx | DatabaseService = this.db): Promise<SubscriptionRow | null> {
    return tx.subjectSubscription.findFirst({
      where: { subjectType: subject.type, subjectId: subject.id, status: { in: [...LIVE_STATUSES] } },
      include: { planVersion: { include: { plan: true } } },
    });
  }

  private subscriptionEndsAt(sub: SubscriptionRow): Date | null {
    switch (sub.status) {
      case 'trialing':
        return sub.trialEndsAt;
      case 'past_due':
        return sub.graceUntil ?? sub.currentPeriodEnd;
      default:
        return sub.currentPeriodEnd;
    }
  }

  private async compute(subject: EntitlementSubjectRef): Promise<RawSnapshot> {
    const now = new Date();
    const [live, grants, overrides] = await Promise.all([
      this.liveSubscription(subject),
      this.db.entitlementGrant.findMany({
        where: {
          subjectType: subject.type,
          subjectId: subject.id,
          revokedAt: null,
          effectiveFrom: { lte: now },
          OR: [{ validUntil: null }, { validUntil: { gt: now } }],
        },
      }),
      this.db.entitlementOverride.findMany({ where: { subjectType: subject.type, subjectId: subject.id, validUntil: { gt: now } } }),
    ]);
    // Живой подписки нет → недавно закончившаяся: клиент рисует «тариф истёк», не
    // путая с «никогда не было»
    const ended = live ? null : await this.recentlyEndedOf(subject, now);
    return this.assemble(subject, now, live, grants, overrides, ended);
  }

  private async recentlyEndedOf(subject: EntitlementSubjectRef, now: Date): Promise<SubscriptionRow | null> {
    return this.db.subjectSubscription.findFirst({
      where: {
        subjectType: subject.type,
        subjectId: subject.id,
        status: { in: ENDED_STATUSES },
        updatedAt: { gt: new Date(now.getTime() - RECENTLY_ENDED_DAYS * 86_400_000) },
      },
      orderBy: { updatedAt: 'desc' },
      include: { planVersion: { include: { plan: true } } },
    });
  }

  /**
   * Снимки ПАЧКИ субъектов: четыре запроса на всю пачку вместо четырёх на каждого.
   * Нужен там, где снимки спрашивают десятками (косметика на карточках людей —
   * `personKeysFor`): цикл из одиночных `compute` был бы N+1 на горячем пути.
   */
  private async computeMany(subjects: EntitlementSubjectRef[]): Promise<Map<string, RawSnapshot>> {
    const out = new Map<string, RawSnapshot>();
    const byType = new Map<EntitlementSubjectType, string[]>();
    for (const s of subjects) byType.set(s.type, [...(byType.get(s.type) ?? []), s.id]);
    for (const [subjectType, ids] of byType) {
      const now = new Date();
      const [subs, grants, overrides] = await Promise.all([
        this.db.subjectSubscription.findMany({
          where: { subjectType, subjectId: { in: ids }, status: { in: [...LIVE_STATUSES] } },
          include: { planVersion: { include: { plan: true } } },
        }),
        this.db.entitlementGrant.findMany({
          where: { subjectType, subjectId: { in: ids }, revokedAt: null, effectiveFrom: { lte: now }, OR: [{ validUntil: null }, { validUntil: { gt: now } }] },
        }),
        this.db.entitlementOverride.findMany({ where: { subjectType, subjectId: { in: ids }, validUntil: { gt: now } } }),
      ]);
      const liveBy = new Map(subs.map((s) => [s.subjectId, s]));
      const noLive = ids.filter((id) => !liveBy.has(id));
      const endedRows = noLive.length
        ? await this.db.subjectSubscription.findMany({
            where: {
              subjectType,
              subjectId: { in: noLive },
              status: { in: ENDED_STATUSES },
              updatedAt: { gt: new Date(now.getTime() - RECENTLY_ENDED_DAYS * 86_400_000) },
            },
            orderBy: { updatedAt: 'desc' },
            include: { planVersion: { include: { plan: true } } },
          })
        : [];
      const endedBy = new Map<string, SubscriptionRow>();
      for (const row of endedRows) if (!endedBy.has(row.subjectId)) endedBy.set(row.subjectId, row); // orderBy desc → первая = свежая
      const grantsBy = groupBySubject(grants);
      const overridesBy = groupBySubject(overrides);
      await Promise.all(
        ids.map(async (id) => {
          const subject: EntitlementSubjectRef = { type: subjectType, id };
          const snap = await this.assemble(subject, now, liveBy.get(id) ?? null, grantsBy.get(id) ?? [], overridesBy.get(id) ?? [], endedBy.get(id) ?? null);
          out.set(this.cache.keyOf(subject), snap);
        }),
      );
    }
    return out;
  }

  /** Сборка снимка из уже прочитанных источников (общая для одиночного и пакетного путей). */
  private async assemble(
    subject: EntitlementSubjectRef,
    now: Date,
    live: SubscriptionRow | null,
    grants: Prisma.EntitlementGrantGetPayload<object>[],
    overrides: Prisma.EntitlementOverrideGetPayload<object>[],
    ended: SubscriptionRow | null,
  ): Promise<RawSnapshot> {
    const planValues = live ? await this.catalog.valuesForSubscription(live) : null;
    const resolved = resolveSubjectValues({
      subjectType: subject.type,
      planValues,
      grants: grants
        .filter((g) => isEntitlementKey(g.key))
        .map((g) => ({
          key: g.key,
          value: g.value as EntitlementValue,
          source: g.source as EntitlementGrantDto['source'],
          priority: g.priority,
          validUntil: g.validUntil,
        })),
      overrides: overrides
        .filter((o) => isEntitlementKey(o.key))
        .map((o) => ({ key: o.key, mode: o.mode as EntitlementOverrideDto['mode'], value: (o.value ?? null) as EntitlementValue, validUntil: o.validUntil })),
      subscriptionEndsAt: live ? this.subscriptionEndsAt(live) : null,
    });
    const values: RawSnapshot['values'] = {};
    for (const [key, v] of Object.entries(resolved.values) as [EntitlementKey, ResolvedValue][]) {
      values[key] = { value: v.value, source: v.source, sourceKind: v.sourceKind, sourceUntil: v.sourceUntil?.toISOString() ?? null };
    }
    let recentlyEnded: RawSnapshot['recentlyEnded'] = null;
    if (!live && ended) {
      const planKey = ended.planVersion.plan.key as PlanKey;
      recentlyEnded = { planKey, planLabelKey: PLAN_DEFS[planKey]?.labelKey ?? `entitlements.plans.${planKey}`, status: ended.status, endedAt: ended.updatedAt.toISOString() };
    }
    return {
      subjectType: subject.type,
      subjectId: subject.id,
      values,
      subscription: live ? this.rawSubscription(live) : null,
      recentlyEnded,
      expiresAt: resolved.expiresAt?.toISOString() ?? null,
      computedAt: now.toISOString(),
    };
  }

  private rawSubscription(sub: SubscriptionRow): RawSubscription {
    const planKey = sub.planVersion.plan.key as PlanKey;
    return {
      id: sub.id,
      planKey,
      planLabelKey: PLAN_DEFS[planKey]?.labelKey ?? `entitlements.plans.${planKey}`,
      version: sub.planVersion.version,
      status: sub.status,
      startedAt: sub.startedAt.toISOString(),
      trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      graceUntil: sub.graceUntil?.toISOString() ?? null,
      expiresAt: this.subscriptionEndsAt(sub)?.toISOString() ?? null,
    };
  }

  // ============================================================
  // Чтение
  // ============================================================

  async valueOf(subject: EntitlementSubjectRef, key: EntitlementKey): Promise<EntitlementValue> {
    this.assertKeyForSubject(key, subject);
    const snap = await this.subjectSnapshot(subject);
    return snap.values[key]?.value ?? null;
  }

  /** Фича доступна? (person-ключи — у человека, container — у контекста/субъекта) */
  async can(userId: string, key: EntitlementKey, subject?: EntitlementSubjectRef): Promise<boolean> {
    const v = await this.valueOf(this.subjectForKey(userId, key, subject), key);
    return v === true;
  }

  /** Потолок лимита/квоты (null — без ограничения). */
  async limit(userId: string, key: EntitlementKey, subject?: EntitlementSubjectRef): Promise<number | null> {
    const v = await this.valueOf(this.subjectForKey(userId, key, subject), key);
    return typeof v === 'number' ? v : null;
  }

  /**
   * Кому идти за разблокировкой. Владельцу и админу организации не сообщают «решает
   * владелец» — они и есть те, кто решает: им замок говорит «доступно на ступени X»
   * (`by: 'self'`), рядовому сотруднику — «решает владелец».
   */
  private async unlockFor(
    subject: EntitlementSubjectRef,
    key: EntitlementKey,
    current: EntitlementValue,
    byPlan?: PublishedValues,
  ): Promise<EntitlementUnlockDto> {
    return {
      by: subject.type === 'workspace' && !this.managesSubject(subject) ? 'workspace_owner' : 'self',
      plan: await this.catalog.unlockPlanFor(subject.type, key, current, byPlan),
    };
  }

  /**
   * Ленивый загрузчик счётчиков квот: один `peekAll` на СУБЪЕКТ за вызов, а не на
   * ключ. Снимок спрашивает расход у каждого ключа, а счётчики субъекта лежат в
   * одной таблице — без этого два ключа Диска стоили бы двумя одинаковыми выборками.
   */
  private countersLoader(): CountersLoader {
    const cache = new Map<string, Promise<Map<string, QuotaState>>>();
    return (subject) => {
      const key = `${subject.type}:${subject.id}`;
      let p = cache.get(key);
      if (!p) cache.set(key, (p = this.quota.peekAll(subject)));
      return p;
    };
  }

  /** Расход ключа: quota — счётчик; limit с провайдером — COUNT; иначе null. */
  private async usageOf(
    subject: EntitlementSubjectRef,
    key: EntitlementKey,
    opts: { tx?: Tx; counters?: CountersLoader } = {},
  ): Promise<{ used: number | null; resetAt: Date | null }> {
    const def = ENTITLEMENT_REGISTRY[key];
    if (def.kind === 'quota') {
      const q = opts.counters ? ((await opts.counters(subject)).get(key) ?? null) : await this.quota.peek(subject, key, opts.tx);
      return { used: q?.used ?? 0, resetAt: q?.periodEnd ?? null };
    }
    if (def.kind === 'limit') {
      const provider = this.usage.get(key);
      if (!provider) return { used: null, resetAt: null };
      return { used: await provider.count(subject, opts.tx), resetAt: null };
    }
    return { used: null, resetAt: null };
  }

  private toSummary(raw: RawSubscription | null): SubscriptionSummaryDto | null {
    if (!raw) return null;
    return {
      planKey: raw.planKey as PlanKey,
      planLabelKey: raw.planLabelKey,
      version: raw.version,
      status: raw.status as SubscriptionStatus,
      startedAt: raw.startedAt,
      trialEndsAt: raw.trialEndsAt,
      currentPeriodEnd: raw.currentPeriodEnd,
      graceUntil: raw.graceUntil,
      expiresAt: raw.expiresAt,
    };
  }

  private async toValueDto(
    subject: EntitlementSubjectRef,
    key: EntitlementKey,
    v: RawSnapshot['values'][string],
    ctx: { counters: CountersLoader; byPlan: PublishedValues },
  ): Promise<EntitlementValueDto> {
    const def = ENTITLEMENT_REGISTRY[key];
    const usage = def.hasUsage ? await this.usageOf(subject, key, { counters: ctx.counters }) : { used: null, resetAt: null };
    return {
      key,
      kind: def.kind,
      carrier: def.carrier,
      unit: def.unit ?? null,
      period: def.period ?? null,
      value: v.value,
      used: usage.used,
      resetAt: usage.resetAt?.toISOString() ?? null,
      source: v.source,
      sourceKind: v.sourceKind,
      sourceUntil: v.sourceUntil,
      unlock: await this.unlockFor(subject, key, v.value, ctx.byPlan),
    };
  }

  /**
   * Снимок контекста для клиента: container-ключи субъекта контекста + person-ключи
   * человека. В продукт НЕ уезжают `reason`/`grantedBy`/`createdBy` источников.
   *
   * Тариф организации (ступень, статус, даты, «недавно закончился») — дело владельца
   * и админа: рядовому сотруднику и подрядчику уезжают ЗНАЧЕНИЯ (чтобы шкала места
   * на Диске организации работала у всех), но не коммерческая карточка подписки.
   */
  async snapshot(userId: string, subject?: EntitlementSubjectRef): Promise<EntitlementSnapshotDto> {
    const ctx = subject ?? this.contextSubject(userId);
    return this.buildSnapshot(userId, ctx, this.managesSubject(ctx));
  }

  /**
   * Снимок для КАБИНЕТА платформы и фона: прав НЕ проверяет (`system*`-метод,
   * конвенция движков) и несёт подписку целиком. Права проверил исполнитель команд.
   */
  async systemSnapshot(userId: string, subject: EntitlementSubjectRef): Promise<EntitlementSnapshotDto> {
    return this.buildSnapshot(userId, subject, true);
  }

  private async buildSnapshot(userId: string, ctx: EntitlementSubjectRef, includeSubscription: boolean): Promise<EntitlementSnapshotDto> {
    const person: EntitlementSubjectRef = { type: 'user', id: userId };
    // Расход ключей и ступень разблокировки собираются ПАРАЛЛЕЛЬНО и на общих
    // предзагрузках: счётчики — один `peekAll` на субъект, опубликованные значения
    // планов — один снимок каталога на весь ответ (иначе чтение эпохи каталога из
    // Redis повторялось бы на каждый ключ страницы «Тариф и лимиты»).
    const [ctxSnap, personSnap, byPlan] = await Promise.all([
      this.subjectSnapshot(ctx),
      ctx.type === 'user' && ctx.id === userId ? null : this.subjectSnapshot(person),
      this.catalog.publishedValuesByPlan(),
    ]);
    const counters = this.countersLoader();
    const personSource = personSnap ?? ctxSnap;
    const containerKeys = entitlementKeysFor(ctx.type).filter((key) => ENTITLEMENT_REGISTRY[key].carrier !== 'person' && !!ctxSnap.values[key]);
    const personKeys = entitlementKeysFor('user').filter((key) => ENTITLEMENT_REGISTRY[key].carrier === 'person' && !!personSource.values[key]);
    const dtos = await Promise.all([
      ...containerKeys.map((key) => this.toValueDto(ctx, key, ctxSnap.values[key], { counters, byPlan })),
      ...personKeys.map((key) => this.toValueDto(person, key, personSource.values[key], { counters, byPlan })),
    ]);
    const values: EntitlementSnapshotDto['values'] = {};
    for (const dto of dtos) values[dto.key] = dto;
    const expires = [ctxSnap.expiresAt, personSnap?.expiresAt ?? null].filter((x): x is string => !!x).sort()[0] ?? null;
    return {
      contextType: ctx.type === 'workspace' ? 'workspace' : 'user',
      contextId: ctx.id,
      subscription: includeSubscription ? this.toSummary(ctxSnap.subscription) : null,
      // Личная подписка — всегда своя: её видит сам человек в любом контексте
      personalSubscription: personSnap ? this.toSummary(personSnap.subscription) : null,
      recentlyEnded:
        includeSubscription && ctxSnap.recentlyEnded
          ? { planKey: ctxSnap.recentlyEnded.planKey as PlanKey, planLabelKey: ctxSnap.recentlyEnded.planLabelKey, status: ctxSnap.recentlyEnded.status as SubscriptionStatus, endedAt: ctxSnap.recentlyEnded.endedAt }
          : null,
      values,
      expiresAt: expires,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Батч-проверка (клиенты, AI-инструменты): «можно ли добавить delta».
   *
   * Расход и ступень разблокировки считаются ОДИН раз на ключ, даже если батч
   * спрашивает его несколько раз с разными `delta`: иначе пятьдесят элементов
   * запроса превращались бы в пятьдесят COUNT'ов по живым сущностям.
   */
  async check(userId: string, items: EntitlementCheckItemDto[]): Promise<EntitlementCheckResponseDto> {
    const ctx = this.contextSubject(userId);
    const counters = this.countersLoader();
    const byPlan = await this.catalog.publishedValuesByPlan();
    type Ready = { subject: EntitlementSubjectRef; value: EntitlementValue; used: number | null; unlock: EntitlementUnlockDto };
    const prepared = new Map<EntitlementKey, Ready | null>();
    await Promise.all(
      [...new Set(items.map((i) => i.key))].map(async (key) => {
        const subject = this.subjectForKey(userId, key, ctx);
        // Ключа у этого субъекта нет (личный ключ спросили в контексте организации или
        // наоборот). Молчаливое `allowed: true` было бы разрешением по несуществующему
        // потолку (fail-open) — на нём клиент и AI-инструмент построили бы действие,
        // которое сервер потом отвергнет.
        if (!this.keyAppliesTo(key, subject.type)) {
          prepared.set(key, null);
          return;
        }
        const snap = await this.subjectSnapshot(subject);
        const value = snap.values[key]?.value ?? null;
        const used = ENTITLEMENT_REGISTRY[key].kind === 'feature' ? null : (await this.usageOf(subject, key, { counters })).used;
        prepared.set(key, { subject, value, used, unlock: await this.unlockFor(subject, key, value, byPlan) });
      }),
    );
    const results: EntitlementCheckResultDto[] = [];
    for (const item of items) {
      const ready = prepared.get(item.key);
      if (!ready) {
        const subject = this.subjectForKey(userId, item.key, ctx);
        results.push({
          key: item.key,
          allowed: false,
          value: null,
          used: null,
          remaining: null,
          code: ENTITLEMENT_ERROR_CODES.keyNotForSubject,
          unlock: { by: subject.type === 'workspace' ? 'workspace_owner' : 'self', plan: null },
        });
        continue;
      }
      const { value, used, unlock } = ready;
      const def = ENTITLEMENT_REGISTRY[item.key];
      const delta = item.delta ?? 1;
      let allowed = true;
      let code: EntitlementErrorCode | null = null;
      let remaining: number | null = null;
      if (def.kind === 'feature') {
        allowed = value === true;
        if (!allowed) code = ENTITLEMENT_ERROR_CODES.featureLocked;
      } else if (typeof value === 'number') {
        remaining = Math.max(0, value - (used ?? 0));
        allowed = (used ?? 0) + delta <= value;
        if (!allowed) code = item.key === 'workspace.seats' ? ENTITLEMENT_ERROR_CODES.seatRequired : def.kind === 'quota' ? ENTITLEMENT_ERROR_CODES.quotaExhausted : ENTITLEMENT_ERROR_CODES.limitReached;
      }
      results.push({ key: item.key, allowed, value, used, remaining, code, unlock });
    }
    return { contextType: ctx.type === 'workspace' ? 'workspace' : 'user', contextId: ctx.id, results };
  }

  /**
   * Person-ключи ЧУЖИХ людей батчем (косметика видна всем): ни одной container-ценности
   * чужого субъекта наружу (S13).
   *
   * Лента, ростер и карточки просят ключи десятками, поэтому путь ПАКЕТНЫЙ: два
   * обращения к Redis на всех и один резолв из БД на все промахи (`computeMany`).
   * Снимки ложатся в тот же кэш, что и одиночные, — правила слияния не дублируются.
   */
  async personKeysFor(userIds: string[]): Promise<Map<string, Partial<Record<EntitlementKey, EntitlementValue>>>> {
    const out = new Map<string, Partial<Record<EntitlementKey, EntitlementValue>>>();
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return out;
    const snaps = await this.cache.getManyOrCompute(
      ids.map((id) => ({ type: 'user' as const, id })),
      (missing) => this.computeMany(missing),
    );
    const personKeys = entitlementKeysFor('user').filter((key) => ENTITLEMENT_REGISTRY[key].carrier === 'person');
    for (const id of ids) {
      const snap = snaps.get(this.cache.keyOf({ type: 'user', id }));
      const person: Partial<Record<EntitlementKey, EntitlementValue>> = {};
      for (const key of personKeys) person[key] = snap?.values[key]?.value ?? null;
      out.set(id, person);
    }
    return out;
  }

  // ============================================================
  // Отказы 402
  // ============================================================

  private async denial(
    subject: EntitlementSubjectRef,
    key: EntitlementKey,
    code: EntitlementErrorCode,
    value: EntitlementValue,
    used: number | null,
  ) {
    const unlock = await this.unlockFor(subject, key, value);
    const CATALOG_KEY_OF: Record<EntitlementErrorCode, string> = {
      [ENTITLEMENT_ERROR_CODES.featureLocked]: 'entitlement.featureLocked',
      [ENTITLEMENT_ERROR_CODES.seatRequired]: 'entitlement.seatRequired',
      [ENTITLEMENT_ERROR_CODES.quotaExhausted]: 'entitlement.quotaExhausted',
      [ENTITLEMENT_ERROR_CODES.planExpired]: 'entitlement.planExpired',
      [ENTITLEMENT_ERROR_CODES.limitReached]: 'entitlement.limitReached',
      [ENTITLEMENT_ERROR_CODES.keyNotForSubject]: 'entitlement.keyNotForSubject',
    };
    const catalogKey = CATALOG_KEY_OF[code];
    // Числа в тексте отказа остаются МАШИННЫМИ: объём собирает в «4,1 ГБ» фильтр
    // отказов в языке запроса (конвенция `<имя>Bytes`, docs/i18n.md), счётные идут
    // числом и форматируются ICU по правилам зрителя. Сервис строку не печёт: он не
    // знает, кто и на каком языке прочтёт отказ.
    const bytes = ENTITLEMENT_REGISTRY[key].unit === 'bytes';
    const params = {
      key,
      ...(bytes ? { usedBytes: used ?? 0 } : { used: used ?? 0 }),
      ...(typeof value === 'number' ? (bytes ? { valueBytes: value } : { value }) : {}),
    };
    // Карта «где упирается тариф»: отказ бросается и откатывает транзакцию вызывающего,
    // поэтому факт идёт МИМО неё (буфер → stream), а не в outbox
    await this.analytics.track(null, 'entitlements.access.denied', { key, code, contextType: subject.type }, { workspaceId: subject.type === 'workspace' ? subject.id : null });
    return paymentRequired(catalogKey, params, { code, key, value, used, contextType: subject.type, unlock });
  }

  async assertFeature(userId: string, key: EntitlementKey, subject?: EntitlementSubjectRef): Promise<void> {
    const s = this.subjectForKey(userId, key, subject);
    if (!(await this.can(userId, key, s))) throw await this.denial(s, key, ENTITLEMENT_ERROR_CODES.featureLocked, false, null);
  }

  /**
   * Лимит-максимум ПОД advisory-локом в транзакции создания (S9): два одновременных
   * создания на пороге не проходят COUNT оба. Провайдер расхода обязан читать через tx.
   */
  async assertCanCreate(tx: Tx, subject: EntitlementSubjectRef, key: EntitlementKey, delta = 1): Promise<void> {
    const def = ENTITLEMENT_REGISTRY[key];
    if (def.kind !== 'limit') throw new Error(`entitlements: assertCanCreate is for limit keys, got ${key} (${def.kind})`);
    const value = await this.valueOf(subject, key);
    if (value === null) return; // без ограничения — лок не нужен
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${subject.type}:${subject.id}:${key}`}))`;
    const provider = this.usage.get(key);
    if (!provider) throw new Error(`entitlements: no usage provider for ${key}`);
    const used = await provider.count(subject, tx);
    if (typeof value === 'number' && used + delta > value) {
      const code = key === 'workspace.seats' ? ENTITLEMENT_ERROR_CODES.seatRequired : ENTITLEMENT_ERROR_CODES.limitReached;
      if (key === 'workspace.seats') this.notifySeatsExhaustedLater(subject, used, value);
      throw await this.denial(subject, key, code, value, used);
    }
  }

  /** Списать квоту в транзакции; отказ — 402 `quota_exhausted`; пороги 80 % / 100 % — уведомления. */
  async consume(tx: Tx, subject: EntitlementSubjectRef, key: EntitlementKey, delta: number): Promise<{ used: number; limit: number | null }> {
    const def = ENTITLEMENT_REGISTRY[key];
    if (def.kind !== 'quota') throw new Error(`entitlements: consume is for quota keys, got ${key} (${def.kind})`);
    const value = await this.valueOf(subject, key);
    const limit = typeof value === 'number' ? value : null;
    const res = await this.quota.consume(tx, subject, key, delta, limit);
    if (!res.ok) {
      void this.notifyQuota(null, subject, key, res.used, limit, res.periodEnd, true);
      throw await this.denial(subject, key, ENTITLEMENT_ERROR_CODES.quotaExhausted, value, res.used);
    }
    if (limit !== null && limit > 0) {
      const crossedWarn = res.previousUsed < limit * ENTITLEMENT_QUOTA_WARN_RATIO && res.used >= limit * ENTITLEMENT_QUOTA_WARN_RATIO;
      const crossedFull = res.previousUsed < limit && res.used >= limit;
      if (crossedFull) await this.notifyQuota(tx, subject, key, res.used, limit, res.periodEnd, true);
      else if (crossedWarn) await this.notifyQuota(tx, subject, key, res.used, limit, res.periodEnd, false);
    }
    return { used: res.used, limit };
  }

  async release(tx: Tx, subject: EntitlementSubjectRef, key: EntitlementKey, delta: number): Promise<void> {
    this.assertKeyForSubject(key, subject); // единственный путь квоты, не идущий через valueOf
    await this.quota.release(tx, subject, key, delta);
  }

  /** Текущее состояние квоты: расход и потолок (null — без ограничения). */
  async quotaState(subject: EntitlementSubjectRef, key: EntitlementKey): Promise<{ used: number; limit: number | null; resetAt: Date | null }> {
    const value = await this.valueOf(subject, key);
    const q = await this.quota.peek(subject, key);
    return { used: q?.used ?? 0, limit: typeof value === 'number' ? value : null, resetAt: q?.periodEnd ?? null };
  }

  /**
   * Дешёвая предпроверка ВНЕ транзакции (ранний отказ до тяжёлой работы — загрузки
   * байтов). Не заменяет `consume`: авторитетное списание идёт в транзакции эффекта.
   */
  async assertQuotaHeadroom(subject: EntitlementSubjectRef, key: EntitlementKey, delta: number): Promise<void> {
    const state = await this.quotaState(subject, key);
    if (state.limit !== null && state.used + delta > state.limit) {
      throw await this.denial(subject, key, ENTITLEMENT_ERROR_CODES.quotaExhausted, state.limit, state.used);
    }
  }

  private periodKey(periodEnd: Date | null): string {
    // Без периода (Диск) — календарный месяц: не чаще одного уведомления на порог в месяц
    return periodEnd ? periodEnd.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 7);
  }

  private async notifyQuota(tx: Tx | null, subject: EntitlementSubjectRef, key: EntitlementKey, used: number, limit: number | null, periodEnd: Date | null, exhausted: boolean): Promise<void> {
    if (limit === null) return;
    const def = ENTITLEMENT_REGISTRY[key];
    const bytes = def.unit === 'bytes';
    const payload: Record<string, unknown> = {
      keyLabelKey: def.labelKey,
      percent: Math.min(100, Math.round((used / limit) * 100)),
      periodKey: this.periodKey(periodEnd),
      ...(bytes ? { usedBytes: used, valueBytes: limit } : { used, value: limit }),
    };
    await this.notifier.notify(tx, subject, exhausted ? 'entitlement.quota.exhausted' : 'entitlement.quota.threshold', payload, {
      idempotencyKey: `ent:quota:${subject.type}:${subject.id}:${key}:${exhausted ? '100' : '80'}:${this.periodKey(periodEnd)}`,
    });
  }

  /**
   * Уведомление «места кончились» уходит ПОСЛЕ раскрутки стека: в момент отказа
   * открыта транзакция вызывающего (advisory-лок + `FOR UPDATE` на организации), и
   * поход за адресатами во ВТОРОЕ соединение держал бы эти локи на время фанаута.
   * Сам отказ транзакцию откатит, а уведомление владельцу обязано выжить — поэтому
   * оно идёт вне транзакции, и его сбой только логируется.
   */
  private notifySeatsExhaustedLater(subject: EntitlementSubjectRef, used: number, value: number): void {
    const timer = setTimeout(() => void this.notifySeatsExhausted(subject, used, value), 0);
    timer.unref?.();
  }

  private async notifySeatsExhausted(subject: EntitlementSubjectRef, used: number, value: number): Promise<void> {
    try {
      const ws = await this.db.workspace.findUnique({ where: { id: subject.id }, select: { name: true } });
      await this.notifier.notify(null, subject, 'entitlement.seats.exhausted', { used, value, workspaceName: ws?.name ?? '' }, {
        idempotencyKey: `ent:seats:${subject.id}:${value}:${new Date().toISOString().slice(0, 7)}`,
      });
    } catch (err) {
      this.logger.warn(`seats notification failed: ${(err as Error).message}`);
    }
  }

  // ============================================================
  // Жизненный цикл подписки
  // ============================================================

  /** Ближайший срок подписки → джоб-будильник (uniqueKey с меткой времени: сдвиг срока = новый джоб). */
  async scheduleExpiry(tx: Tx | null, sub: { id: string; status: string; trialEndsAt: Date | null; currentPeriodEnd: Date | null; graceUntil: Date | null }): Promise<void> {
    const due =
      sub.status === 'trialing' ? sub.trialEndsAt : sub.status === 'past_due' ? sub.graceUntil ?? sub.currentPeriodEnd : sub.currentPeriodEnd;
    if (!due) return;
    await this.jobs.enqueue(tx, {
      type: ENTITLEMENT_JOBS.expiry,
      payload: { kind: 'subscription', id: sub.id },
      runAt: due,
      uniqueKey: `ent:sub:${sub.id}:${due.getTime()}`,
    });
  }

  /**
   * Пробный период: человек — `personal`, организация — `business_pro`, 30 дней;
   * бизнес-триал один на человека (частичный уникум) — второй молча не заводится,
   * как и при уже живой подписке. Возвращает null, если триал не начался.
   */
  async startTrial(tx: Tx, subject: EntitlementSubjectRef, opts: { consumedBy?: string } = {}): Promise<SubjectSubscriptionDto | null> {
    if (subject.type === 'family') return null;
    const planKey = TRIAL_PLAN[subject.type];
    const version = await this.catalog.latestVersionForPin(planKey, tx);
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 86_400_000);
    // INSERT … ON CONFLICT DO NOTHING, а не create()+catch(P2002): нарушение уникума в
    // Postgres АБОРТИТ всю транзакцию вызывающего (createWorkspace), а «триал не
    // положен» — штатный исход, не ошибка. Конфликт без цели ловит ОБА частичных
    // уникума (живая подписка субъекта, потраченный бизнес-триал человека).
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO subject_subscriptions
        (id, subject_type, subject_id, plan_version_id, status, started_at, trial_ends_at, source, trial_consumed_by, created_at, updated_at)
      VALUES (${uuidv7()}::uuid, ${subject.type}, ${subject.id}, ${version.id}::uuid, 'trialing', ${utcTs(now)}, ${utcTs(trialEndsAt)}, 'trial',
        ${subject.type === 'workspace' ? (opts.consumedBy ?? null) : null}, ${utcTs(now)}, ${utcTs(now)})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (!inserted.length) return null;
    const created = await tx.subjectSubscription.findUniqueOrThrow({ where: { id: inserted[0].id }, include: { planVersion: { include: { plan: true } } } });
    await this.scheduleExpiry(tx, created);
    await this.analytics.track(
      tx,
      'entitlements.subscription.started',
      { subscriptionPlan: created.planVersion.plan.key, subscriptionVersion: created.planVersion.version, status: 'trialing', origin: 'trial', contextType: subject.type },
      this.analyticsSubject(subject),
    );
    await this.cache.bump(subject);
    return this.toSubscriptionDto(created);
  }

  /**
   * Удаление человека / purge организации: полиморфные строки без FK — чистим сами.
   *
   * ИСКЛЮЧЕНИЕ — строка потраченного бизнес-триала: она не значение, а ЖУРНАЛ «этот
   * человек свой пробный период уже получил». Удали её вместе с организацией — и
   * цепочка «архив → 90 дней → purge → новая организация» выдавала бы владельцу
   * второй триал бесконечно. Строка остаётся отменённой: значений она не даёт
   * (резолвер читает только живые статусы), живой уникум не занимает, а частичный
   * уникум по `trial_consumed_by` продолжает держать «один бизнес-триал на человека».
   */
  async forgetSubject(tx: Tx, subject: EntitlementSubjectRef): Promise<void> {
    if (subject.type === 'workspace') {
      await tx.subjectSubscription.updateMany({
        where: { subjectType: 'workspace', subjectId: subject.id, trialConsumedBy: { not: null }, status: { in: [...LIVE_STATUSES] } },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
      await tx.subjectSubscription.deleteMany({ where: { subjectType: 'workspace', subjectId: subject.id, trialConsumedBy: null } });
    } else {
      await tx.subjectSubscription.deleteMany({ where: { subjectType: subject.type, subjectId: subject.id } });
    }
    await tx.entitlementGrant.deleteMany({ where: { subjectType: subject.type, subjectId: subject.id } });
    await tx.entitlementOverride.deleteMany({ where: { subjectType: subject.type, subjectId: subject.id } });
    await this.quota.forget(tx, subject);
    await this.cache.bump(subject);
  }

  // ============================================================
  // Мутации кабинета (права проверил исполнитель команд)
  // ============================================================

  /**
   * Субъект правки должен СУЩЕСТВОВАТЬ: удалённый аккаунт и зарезервированный вид
   * `family` (своих ключей у него сегодня нет, UI тоже) не принимаем — иначе команда
   * кабинета оставляла бы подписки и гранты, которые никто никогда не прочтёт.
   */
  private async assertSubjectExists(subject: EntitlementSubjectRef, tx: Tx | DatabaseService): Promise<void> {
    const exists =
      subject.type === 'user'
        ? await tx.user.count({ where: { id: subject.id, deletedAt: null } })
        : subject.type === 'workspace'
          ? await tx.workspace.count({ where: { id: subject.id } })
          : 0;
    if (!exists) throw notFound('entitlement.subjectNotFound');
  }

  /**
   * Субъект узнаёт, что его права изменила поддержка. Продюсер решает КОМУ (человек —
   * сам себе, организация — владелец и админы), движок уведомлений — КАК. Отправка
   * идёт В ТОЙ ЖЕ транзакции, что и правка: откат команды (или предпросмотр) уносит
   * и уведомление. Кто именно из сотрудников правил — внутреннее дело кабинета и
   * наружу не едет.
   */
  private async notifySupportChange(tx: Tx, subject: EntitlementSubjectRef, change: SupportChange): Promise<void> {
    await this.notifier.notify(tx, subject, 'entitlement.support.changed', { changeKey: `entitlements.supportChange.${change}` });
  }

  async setSubscription(tx: Tx, actorId: string, input: SubscriptionSetInput): Promise<{ before: SubjectSubscriptionDto | null; after: SubjectSubscriptionDto | null }> {
    const subject = input.subject as EntitlementSubjectRef;
    await this.assertSubjectExists(subject, tx);
    const live = await this.liveSubscription(subject, tx);
    const before = live ? this.toSubscriptionDto(live) : null;
    const now = new Date();

    // Снять: живая → cancelled (free)
    if (input.planVersionId === null || (!input.planVersionId && !input.planKey)) {
      if (live) {
        await tx.subjectSubscription.updateMany({ where: { id: live.id, status: { in: [...LIVE_STATUSES] } }, data: { status: 'cancelled', cancelledAt: now } });
        await this.analytics.track(
          tx,
          'entitlements.subscription.changed',
          { subscriptionPlan: 'none', subscriptionVersion: 0, previousPlan: live.planVersion.plan.key, direction: 'down', status: 'cancelled', contextType: subject.type },
          this.analyticsSubject(subject),
        );
      }
      await this.notifySupportChange(tx, subject, 'subscriptionCleared');
      await this.cache.bump(subject);
      return { before, after: null };
    }

    const version = input.planVersionId
      ? await this.catalog.versionById(input.planVersionId, tx)
      : await this.catalog.latestVersionForPin(input.planKey as PlanKey, tx);
    if (version.status !== 'published') throw conflict('entitlement.versionNotPublished');
    if (version.plan.subjectType !== subject.type) throw badRequest('entitlement.planSubjectMismatch');

    const status: SubscriptionStatus = input.status ?? 'active';
    // Поставить подписку сразу в `expired`/`cancelled` нельзя: снять тариф — это
    // отдельный исход команды (planVersionId: null), а не «живая» строка в мёртвом
    // статусе, которую резолвер всё равно не прочтёт.
    if (!LIVE_STATUSES.includes(status as (typeof LIVE_STATUSES)[number])) throw badRequest('entitlement.statusNotLive');
    if (live) {
      await tx.subjectSubscription.updateMany({ where: { id: live.id, status: { in: [...LIVE_STATUSES] } }, data: { status: 'cancelled', cancelledAt: now } });
    }
    const created = await tx.subjectSubscription.create({
      data: {
        subjectType: subject.type,
        subjectId: subject.id,
        planVersionId: version.id,
        status,
        startedAt: now,
        trialEndsAt: status === 'trialing' ? (input.trialEndsAt ? new Date(input.trialEndsAt) : new Date(now.getTime() + TRIAL_DAYS * 86_400_000)) : null,
        currentPeriodEnd: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : null,
        graceUntil: status === 'past_due' ? new Date(now.getTime() + GRACE_DAYS * 86_400_000) : null,
        source: 'manual',
        createdBy: actorId,
      },
      include: { planVersion: { include: { plan: true } } },
    });
    await this.scheduleExpiry(tx, created);
    if (live) {
      const from = live.planVersion.plan.sortOrder;
      const to = created.planVersion.plan.sortOrder;
      await this.analytics.track(
        tx,
        'entitlements.subscription.changed',
        {
          subscriptionPlan: created.planVersion.plan.key,
          subscriptionVersion: created.planVersion.version,
          previousPlan: live.planVersion.plan.key,
          direction: to > from ? 'up' : to < from ? 'down' : 'same',
          status,
          contextType: subject.type,
        },
        this.analyticsSubject(subject),
      );
    } else {
      await this.analytics.track(
        tx,
        'entitlements.subscription.started',
        { subscriptionPlan: created.planVersion.plan.key, subscriptionVersion: created.planVersion.version, status, origin: 'manual', contextType: subject.type },
        this.analyticsSubject(subject),
      );
    }
    await this.notifySupportChange(tx, subject, 'subscriptionSet');
    await this.cache.bump(subject);
    return { before, after: this.toSubscriptionDto(created) };
  }

  async extendTrial(tx: Tx, _actorId: string, input: TrialExtendInput): Promise<{ before: SubjectSubscriptionDto; after: SubjectSubscriptionDto }> {
    const subject = input.subject as EntitlementSubjectRef;
    const live = await this.liveSubscription(subject, tx);
    if (!live) throw notFound('entitlement.subscriptionNotFound');
    if (live.status !== 'trialing' || !live.trialEndsAt) throw conflict('entitlement.trialNotActive');
    const next = new Date(input.trialEndsAt);
    if (next.getTime() <= live.trialEndsAt.getTime()) throw badRequest('entitlement.trialEndsNotLater');
    const res = await tx.subjectSubscription.updateMany({ where: { id: live.id, status: 'trialing' }, data: { trialEndsAt: next } });
    if (res.count !== 1) throw conflict('entitlement.trialNotActive');
    const after = (await tx.subjectSubscription.findUnique({ where: { id: live.id }, include: { planVersion: { include: { plan: true } } } }))!;
    await this.scheduleExpiry(tx, after);
    await this.notifySupportChange(tx, subject, 'trialExtended');
    await this.cache.bump(subject);
    return { before: this.toSubscriptionDto(live), after: this.toSubscriptionDto(after) };
  }

  async createGrant(tx: Tx, actorId: string, input: GrantCreateInput): Promise<EntitlementGrantDto> {
    const subject = input.subject as EntitlementSubjectRef;
    await this.assertSubjectExists(subject, tx);
    if (!ENTITLEMENT_REGISTRY[input.key].subjects.includes(subject.type)) throw badRequest('entitlement.keyNotForSubject', { key: input.key });
    const idempotencyKey = input.idempotencyKey ?? `manual:${actorId}:${subject.type}:${subject.id}:${input.key}:${Date.now()}`;
    const row = await tx.entitlementGrant.upsert({
      where: { idempotencyKey },
      create: {
        subjectType: subject.type,
        subjectId: subject.id,
        key: input.key,
        value: input.value as Prisma.InputJsonValue,
        source: input.source,
        priority: input.priority ?? 0,
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
        reason: input.reason ?? null,
        grantedBy: actorId,
        idempotencyKey,
      },
      update: {},
    });
    if (row.validUntil) {
      await this.jobs.enqueue(tx, {
        type: ENTITLEMENT_JOBS.expiry,
        payload: { kind: 'grant', id: row.id },
        runAt: row.validUntil,
        uniqueKey: `ent:grant:${row.id}:${row.validUntil.getTime()}`,
      });
    }
    await this.notifySupportChange(tx, subject, 'grantCreated');
    await this.cache.bump(subject);
    return this.toGrantDto(row);
  }

  async revokeGrant(tx: Tx, _actorId: string, grantId: string): Promise<{ before: EntitlementGrantDto; after: EntitlementGrantDto }> {
    const row = await tx.entitlementGrant.findUnique({ where: { id: grantId } });
    if (!row) throw notFound('entitlement.grantNotFound');
    if (row.revokedAt) return { before: this.toGrantDto(row), after: this.toGrantDto(row) };
    const after = await tx.entitlementGrant.update({ where: { id: grantId }, data: { revokedAt: new Date() } });
    const grantSubject: EntitlementSubjectRef = { type: row.subjectType as EntitlementSubjectType, id: row.subjectId };
    await this.notifySupportChange(tx, grantSubject, 'grantRevoked');
    await this.cache.bump(grantSubject);
    return { before: this.toGrantDto(row), after: this.toGrantDto(after) };
  }

  async setOverride(tx: Tx, actorId: string, input: OverrideSetInput): Promise<{ before: EntitlementOverrideDto | null; after: EntitlementOverrideDto }> {
    const subject = input.subject as EntitlementSubjectRef;
    await this.assertSubjectExists(subject, tx);
    if (!ENTITLEMENT_REGISTRY[input.key].subjects.includes(subject.type)) throw badRequest('entitlement.keyNotForSubject', { key: input.key });
    const where = { subjectType_subjectId_key: { subjectType: subject.type, subjectId: subject.id, key: input.key } };
    const prev = await tx.entitlementOverride.findUnique({ where });
    const value = input.mode === 'set' ? (input.value as Prisma.InputJsonValue) : Prisma.JsonNull;
    const row = await tx.entitlementOverride.upsert({
      where,
      create: {
        subjectType: subject.type,
        subjectId: subject.id,
        key: input.key,
        mode: input.mode,
        value,
        reason: input.reason,
        validUntil: new Date(input.validUntil),
        createdBy: actorId,
      },
      update: { mode: input.mode, value, reason: input.reason, validUntil: new Date(input.validUntil), createdBy: actorId },
    });
    await this.jobs.enqueue(tx, {
      type: ENTITLEMENT_JOBS.expiry,
      payload: { kind: 'override', id: row.id },
      runAt: row.validUntil,
      uniqueKey: `ent:override:${row.id}:${row.validUntil.getTime()}`,
    });
    await this.notifySupportChange(tx, subject, 'overrideSet');
    await this.cache.bump(subject);
    return { before: prev ? this.toOverrideDto(prev) : null, after: this.toOverrideDto(row) };
  }

  async clearOverride(tx: Tx, _actorId: string, subject: EntitlementSubjectRef, key: EntitlementKey): Promise<{ before: EntitlementOverrideDto | null }> {
    const where = { subjectType_subjectId_key: { subjectType: subject.type, subjectId: subject.id, key } };
    const prev = await tx.entitlementOverride.findUnique({ where });
    if (!prev) throw notFound('entitlement.overrideNotFound');
    await tx.entitlementOverride.delete({ where });
    await this.notifySupportChange(tx, subject, 'overrideCleared');
    await this.cache.bump(subject);
    return { before: this.toOverrideDto(prev) };
  }

  /** Карточка субъекта для кабинета: всё, что движок знает, + итоговый снимок. */
  async subjectDetail(subject: EntitlementSubjectRef): Promise<EntitlementSubjectDetailDto> {
    await this.assertSubjectExists(subject, this.db);
    const [history, grants, overrides, counters] = await Promise.all([
      this.db.subjectSubscription.findMany({
        where: { subjectType: subject.type, subjectId: subject.id },
        include: { planVersion: { include: { plan: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.db.entitlementGrant.findMany({ where: { subjectType: subject.type, subjectId: subject.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
      this.db.entitlementOverride.findMany({ where: { subjectType: subject.type, subjectId: subject.id }, orderBy: { createdAt: 'desc' } }),
      this.quota.peekAll(subject),
    ]);
    const live = history.find((s) => (LIVE_STATUSES as readonly string[]).includes(s.status)) ?? null;
    const ownerId = subject.type === 'user' ? subject.id : subject.type === 'workspace' ? (await this.db.workspace.findUnique({ where: { id: subject.id }, select: { ownerId: true } }))?.ownerId ?? subject.id : subject.id;
    const snapshot = await this.systemSnapshot(ownerId, subject);
    const countersDto: QuotaCounterDto[] = [...counters.entries()].map(([key, q]) => ({
      subjectType: subject.type,
      subjectId: subject.id,
      key,
      used: q.used,
      periodStart: q.periodStart?.toISOString() ?? null,
      periodEnd: q.periodEnd?.toISOString() ?? null,
      updatedAt: new Date().toISOString(),
    }));
    return {
      subject,
      subscription: live ? this.toSubscriptionDto(live) : null,
      history: history.map((s) => this.toSubscriptionDto(s)),
      grants: grants.map((g) => this.toGrantDto(g)),
      overrides: overrides.map((o) => this.toOverrideDto(o)),
      counters: countersDto,
      snapshot,
    };
  }

  // ============================================================
  // DTO
  // ============================================================

  toSubscriptionDto(s: SubscriptionRow): SubjectSubscriptionDto {
    return {
      id: s.id,
      subjectType: s.subjectType as EntitlementSubjectType,
      subjectId: s.subjectId,
      planKey: s.planVersion.plan.key as PlanKey,
      planVersionId: s.planVersionId,
      version: s.planVersion.version,
      status: s.status as SubscriptionStatus,
      startedAt: s.startedAt.toISOString(),
      trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
      graceUntil: s.graceUntil?.toISOString() ?? null,
      cancelledAt: s.cancelledAt?.toISOString() ?? null,
      source: s.source as SubjectSubscriptionDto['source'],
      trialConsumedBy: s.trialConsumedBy,
      createdBy: s.createdBy,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  toGrantDto(g: Prisma.EntitlementGrantGetPayload<object>): EntitlementGrantDto {
    return {
      id: g.id,
      subjectType: g.subjectType as EntitlementSubjectType,
      subjectId: g.subjectId,
      key: g.key,
      value: g.value as EntitlementValue,
      source: g.source as EntitlementGrantDto['source'],
      priority: g.priority,
      effectiveFrom: g.effectiveFrom.toISOString(),
      validUntil: g.validUntil?.toISOString() ?? null,
      reason: g.reason,
      grantedBy: g.grantedBy,
      idempotencyKey: g.idempotencyKey,
      revokedAt: g.revokedAt?.toISOString() ?? null,
      createdAt: g.createdAt.toISOString(),
    };
  }

  toOverrideDto(o: Prisma.EntitlementOverrideGetPayload<object>): EntitlementOverrideDto {
    return {
      id: o.id,
      subjectType: o.subjectType as EntitlementSubjectType,
      subjectId: o.subjectId,
      key: o.key,
      mode: o.mode as EntitlementOverrideDto['mode'],
      value: (o.value ?? null) as EntitlementValue,
      reason: o.reason,
      validUntil: o.validUntil.toISOString(),
      createdBy: o.createdBy,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    };
  }

  /** Живая подписка субъекта (для lifecycle и dev). */
  async liveSubscriptionOf(subject: EntitlementSubjectRef): Promise<SubscriptionRow | null> {
    return this.liveSubscription(subject);
  }
}
