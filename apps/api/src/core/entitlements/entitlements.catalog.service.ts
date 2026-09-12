import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ENTITLEMENT_REGISTRY,
  PLAN_DEFS,
  PLAN_KEYS,
  PLAN_REGION_DEFAULT,
  defaultFreeFor,
  entitlementGreater,
  freeValuesFor,
  isPlanKey,
  planEntitlementsJsonSchema,
  plansForSubject,
  seedPlanVersionValues,
  type EntitlementCatalogDto,
  type EntitlementKey,
  type EntitlementSubjectType,
  type EntitlementValue,
  type PlanCreateVersionInput,
  type PlanDto,
  type PlanKey,
  type PlanUpdateDraftInput,
  type PlanVersionDto,
  type PlanVersionStatus,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, conflict, notFound } from '../../shared/errors/api-error';
import { EntitlementsCache } from './entitlements.cache';

type Tx = Prisma.TransactionClient;
type PlanVersionRow = Prisma.PlanVersionGetPayload<{ include: { plan: true } }>;
type PlanValues = Partial<Record<string, EntitlementValue>>;

/**
 * Каталог: планы и их версии. Публикация делает версию неизменяемой; черновик правится
 * инлайн и в продукт НЕ попадает (лестница чтения: версия подписки, если она не
 * черновик → последняя опубликованная того же плана → defaultFree реестра). Так новый
 * ключ у сервиса №57 «течёт» к подписчикам через свежую версию, а старые значения
 * grandfathered у тех, кто пришит к старой.
 */
@Injectable()
export class EntitlementsCatalogService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EntitlementsCatalogService.name);
  /** Опубликованные значения по плану — кэш процесса под эпохой каталога */
  private publishedCache: { epoch: string; byPlan: Map<PlanKey, PlanValues> } | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly cache: EntitlementsCache,
  ) {}

  /** Планы из кода обязаны существовать в БД: новый ключ плана появляется без миграции данных. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureCatalog();
    } catch (err) {
      this.logger.error(`ensureCatalog failed: ${(err as Error).message}`);
    }
  }

  async ensureCatalog(): Promise<void> {
    for (const key of PLAN_KEYS) {
      const def = PLAN_DEFS[key];
      const plan = await this.db.plan.upsert({
        where: { key },
        create: { key, subjectType: def.subjectType, sortOrder: def.sortOrder },
        update: { sortOrder: def.sortOrder },
        include: { versions: { select: { id: true }, take: 1 } },
      });
      if (plan.versions.length) continue;
      const seed = seedPlanVersionValues(key);
      await this.db.planVersion.create({
        data: {
          planId: plan.id,
          version: 1,
          status: def.free ? 'published' : 'draft',
          region: PLAN_REGION_DEFAULT,
          entitlements: seed as Prisma.InputJsonValue,
          note: def.free ? 'free: defaultFree of the registry' : 'seed: multiplier policy',
          publishedAt: def.free ? new Date() : null,
        },
      });
      this.logger.log(`catalog: plan "${key}" seeded (v1 ${def.free ? 'published' : 'draft'})`);
    }
  }

  // ============================================================
  // Лестница чтения
  // ============================================================

  /**
   * Значения версии подписки. Черновик подписчикам не виден (правится инлайн);
   * архивная версия у уже пришитого субъекта читается (grandfathered).
   *
   * Подмена черновика последней опубликованной идёт через кэш каталога, а не отдельным
   * запросом: сегодня на черновиках сидят ВСЕ миграционные подписки, и каждый резолв
   * снимка стоил бы лишним SELECT'ом — на карточках людей это N+1 (`personKeysFor`).
   */
  async valuesForSubscription(sub: { planVersion: PlanVersionRow }): Promise<PlanValues> {
    const v = sub.planVersion;
    if (v.status !== 'draft') return (v.entitlements as PlanValues) ?? {};
    const byPlan = await this.publishedValuesByPlan();
    return byPlan.get(v.plan.key as PlanKey) ?? {};
  }

  /** Опубликованные значения всех планов (кэш процесса под эпохой каталога). */
  async publishedValuesByPlan(): Promise<Map<PlanKey, PlanValues>> {
    const epoch = await this.cache.catalogEpoch();
    if (this.publishedCache && this.publishedCache.epoch === epoch) return this.publishedCache.byPlan;
    const rows = await this.db.planVersion.findMany({
      where: { status: 'published' },
      orderBy: { version: 'desc' },
      include: { plan: { select: { key: true } } },
    });
    const byPlan = new Map<PlanKey, PlanValues>();
    for (const r of rows) {
      const key = r.plan.key;
      if (!isPlanKey(key) || byPlan.has(key)) continue; // первая = самая свежая версия
      byPlan.set(key, (r.entitlements as PlanValues) ?? {});
    }
    this.publishedCache = { epoch, byPlan };
    return byPlan;
  }

  /**
   * Ближайшая ступень субъекта, где значение ключа больше текущего (по опубликованным
   * версиям; отсутствующий в версии ключ = defaultFree). null — такой ступени нет.
   */
  async unlockPlanFor(
    subjectType: EntitlementSubjectType,
    key: EntitlementKey,
    current: EntitlementValue,
    // Снимок опубликованных значений, если вызывающий уже держит его на руках:
    // страница «Тариф и лимиты» спрашивает ступень для КАЖДОГО ключа, и без этого
    // каждый ключ стоил бы отдельным чтением эпохи каталога из Redis.
    preloaded?: Map<PlanKey, PlanValues>,
  ): Promise<PlanKey | null> {
    const byPlan = preloaded ?? (await this.publishedValuesByPlan());
    const def = ENTITLEMENT_REGISTRY[key];
    for (const plan of plansForSubject(subjectType)) {
      if (PLAN_DEFS[plan].free) continue;
      const values = byPlan.get(plan);
      if (!values) continue;
      const v = key in values ? (values[key] as EntitlementValue) : defaultFreeFor(def, subjectType);
      if (entitlementGreater(current, v)) return plan;
    }
    return null;
  }

  /** Версия для пина подписки: последняя опубликованная, иначе последняя любая (черновик станет видим после публикации). */
  async latestVersionForPin(planKey: PlanKey, tx: Tx | DatabaseService = this.db): Promise<PlanVersionRow> {
    const plan = await tx.plan.findUnique({ where: { key: planKey } });
    if (!plan) throw notFound('entitlement.planNotFound');
    const published = await tx.planVersion.findFirst({
      where: { planId: plan.id, status: 'published' },
      orderBy: { version: 'desc' },
      include: { plan: true },
    });
    if (published) return published;
    const any = await tx.planVersion.findFirst({ where: { planId: plan.id }, orderBy: { version: 'desc' }, include: { plan: true } });
    if (!any) throw notFound('entitlement.versionNotFound');
    return any;
  }

  async versionById(id: string, tx: Tx | DatabaseService = this.db): Promise<PlanVersionRow> {
    const v = await tx.planVersion.findUnique({ where: { id }, include: { plan: true } });
    if (!v) throw notFound('entitlement.versionNotFound');
    return v;
  }

  // ============================================================
  // Чтение каталога (кабинет)
  // ============================================================

  async listCatalog(): Promise<EntitlementCatalogDto> {
    const plans = await this.db.plan.findMany({
      orderBy: [{ subjectType: 'asc' }, { sortOrder: 'asc' }],
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    const freeValues = {
      user: freeValuesFor('user'),
      workspace: freeValuesFor('workspace'),
      family: freeValuesFor('family'),
    };
    return {
      plans: plans.map((p) => this.toPlanDto(p)),
      freeValues,
    };
  }

  toPlanDto(p: Prisma.PlanGetPayload<{ include: { versions: true } }>): PlanDto {
    const key = p.key as PlanKey;
    return {
      id: p.id,
      key,
      subjectType: p.subjectType as EntitlementSubjectType,
      status: p.status as PlanDto['status'],
      sortOrder: p.sortOrder,
      labelKey: PLAN_DEFS[key]?.labelKey ?? `entitlements.plans.${key}`,
      versions: p.versions.map((v) => this.toVersionDto({ ...v, plan: p })),
    };
  }

  toVersionDto(v: PlanVersionRow): PlanVersionDto {
    return {
      id: v.id,
      planId: v.planId,
      planKey: v.plan.key as PlanKey,
      version: v.version,
      status: v.status as PlanVersionStatus,
      region: v.region,
      entitlements: (v.entitlements as PlanValues) ?? {},
      note: v.note,
      publishedAt: v.publishedAt?.toISOString() ?? null,
      publishedBy: v.publishedBy,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    };
  }

  // ============================================================
  // Мутации (зовёт кабинет через команды; права проверил исполнитель)
  // ============================================================

  /**
   * Новый черновик: значения — свой JSON либо копия последней версии плана.
   *
   * Копия берётся ТОЛЬКО из применимых сегодня ключей: реестр живёт — ключ могли
   * сузить по субъектам, переименовать или убрать вовсе, а старая версия хранит его
   * как есть (подписчики на ней grandfathered). Без фильтра «создать черновик»
   * падало бы на значении, которое движок сам когда-то и засеял. Свой JSON, наоборот,
   * проверяется строго: его пишет человек здесь и сейчас.
   */
  async createVersion(tx: Tx, actorId: string, input: PlanCreateVersionInput): Promise<PlanVersionDto> {
    const plan = await tx.plan.findUnique({ where: { key: input.planKey } });
    if (!plan) throw notFound('entitlement.planNotFound');
    const last = await tx.planVersion.findFirst({ where: { planId: plan.id }, orderBy: { version: 'desc' } });
    const subjectType = plan.subjectType as EntitlementSubjectType;
    const values = input.entitlements ?? this.applicableOnly((last?.entitlements as PlanValues) ?? {}, subjectType);
    this.assertValues(values, plan.subjectType as EntitlementSubjectType);
    const created = await tx.planVersion.create({
      data: {
        planId: plan.id,
        version: (last?.version ?? 0) + 1,
        status: 'draft',
        region: PLAN_REGION_DEFAULT,
        entitlements: values as Prisma.InputJsonValue,
        note: input.note ?? `draft by ${actorId}`,
      },
      include: { plan: true },
    });
    return this.toVersionDto(created);
  }

  async updateDraft(tx: Tx, _actorId: string, input: PlanUpdateDraftInput): Promise<{ before: PlanVersionDto; after: PlanVersionDto }> {
    const v = await this.versionById(input.planVersionId, tx);
    if (v.status !== 'draft') throw conflict('entitlement.versionNotDraft');
    this.assertValues(input.entitlements, v.plan.subjectType as EntitlementSubjectType);
    const updated = await tx.planVersion.update({
      where: { id: v.id },
      data: { entitlements: input.entitlements as Prisma.InputJsonValue, ...(input.note !== undefined ? { note: input.note } : {}) },
      include: { plan: true },
    });
    return { before: this.toVersionDto(v), after: this.toVersionDto(updated) };
  }

  /** Публикация: валидация по реестру (S15), статус-гвард, бамп эпохи каталога. */
  async publishVersion(tx: Tx, actorId: string, versionId: string): Promise<{ before: PlanVersionDto; after: PlanVersionDto }> {
    const v = await this.versionById(versionId, tx);
    if (v.status === 'published') throw conflict('entitlement.versionAlreadyPublished');
    if (v.status !== 'draft') throw conflict('entitlement.versionNotDraft');
    this.assertValues((v.entitlements as PlanValues) ?? {}, v.plan.subjectType as EntitlementSubjectType);
    const res = await tx.planVersion.updateMany({
      where: { id: v.id, status: 'draft' },
      data: { status: 'published', publishedAt: new Date(), publishedBy: actorId },
    });
    if (res.count !== 1) throw conflict('entitlement.versionAlreadyPublished');
    const after = await this.versionById(v.id, tx);
    await this.cache.bumpCatalog();
    return { before: this.toVersionDto(v), after: this.toVersionDto(after) };
  }

  /**
   * В архив: только опубликованную, на которую не пришита ни одна ЖИВАЯ подписка.
   *
   * И отдельно — последнюю опубликованную версию плана нельзя убрать, пока по плану
   * есть живые подписки ЛЮБОЙ его версии: подписка на черновике читает значения
   * последней опубликованной (лестница чтения), и проверка «пришита ли к этой версии»
   * таких подписчиков не видит — они молча упали бы на `defaultFree`.
   */
  async archiveVersion(tx: Tx, _actorId: string, versionId: string): Promise<{ before: PlanVersionDto; after: PlanVersionDto }> {
    const v = await this.versionById(versionId, tx);
    if (v.status !== 'published') throw conflict('entitlement.versionNotPublished');
    const pinned = await tx.subjectSubscription.count({
      where: { planVersionId: v.id, status: { in: ['trialing', 'active', 'past_due'] } },
    });
    if (pinned > 0) throw conflict('entitlement.versionPinned');
    const otherPublished = await tx.planVersion.count({ where: { planId: v.planId, status: 'published', id: { not: v.id } } });
    if (otherPublished === 0) {
      const livePlanSubscribers = await tx.subjectSubscription.count({
        where: { status: { in: ['trialing', 'active', 'past_due'] }, planVersion: { planId: v.planId } },
      });
      if (livePlanSubscribers > 0) throw conflict('entitlement.planLastPublished');
    }
    const res = await tx.planVersion.updateMany({ where: { id: v.id, status: 'published' }, data: { status: 'archived' } });
    if (res.count !== 1) throw conflict('entitlement.versionNotPublished');
    const after = await this.versionById(v.id, tx);
    await this.cache.bumpCatalog();
    return { before: this.toVersionDto(v), after: this.toVersionDto(after) };
  }

  /** Оставить только ключи, которые реестр знает СЕГОДНЯ и разрешает этому субъекту. */
  private applicableOnly(values: PlanValues, subjectType: EntitlementSubjectType): PlanValues {
    const out: PlanValues = {};
    for (const [key, value] of Object.entries(values)) {
      const def = ENTITLEMENT_REGISTRY[key as EntitlementKey];
      if (def?.subjects.includes(subjectType)) out[key] = value;
    }
    return out;
  }

  /** Ключи только из реестра, значения по виду ключа, ключ применим к субъекту плана. */
  private assertValues(values: PlanValues, subjectType: EntitlementSubjectType): void {
    const parsed = planEntitlementsJsonSchema.safeParse(values);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(issue?.message ?? 'validation.entitlements.badValue', undefined, { path: issue?.path ?? [] });
    }
    for (const key of Object.keys(values)) {
      const def = ENTITLEMENT_REGISTRY[key as EntitlementKey];
      if (!def.subjects.includes(subjectType)) throw badRequest('entitlement.keyNotForSubject', { key });
    }
  }
}
