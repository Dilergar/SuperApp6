import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import {
  LIFECYCLE_EXPORT_PREFIX,
  LIFECYCLE_JOBS,
  LIFECYCLE_LIMITS,
  LIFECYCLE_POLICY_IDS,
  LIFECYCLE_QUEUE,
  asWorkspaceId,
  lifecyclePolicy,
  lifecyclePoliciesOf,
  lifecycleSubjectErasurePlan,
  uuidv7,
  type LifecycleCanaryFinding,
  type LifecycleCanaryFindingKind,
  type LifecycleCanaryLeak,
  type LifecycleCanaryReportDto,
  type LifecycleExportPart,
} from '@superapp/shared';
import { promises as fs } from 'node:fs';
import { DatabaseService } from '../../shared/database/database.service';
import { appTmpPath } from '../../shared/fs/temp-file.util';
import { RedisService } from '../../shared/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { STORAGE_DRIVER, type StorageDriver } from '../files/storage/storage-driver';
import { JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { userScope } from '../keys/keys.constants';
import { LifecycleErasureService } from './lifecycle.erasure.service';
import { LifecycleLooseFk } from './lifecycle.loose-fk';
import { LifecycleMetrics } from './lifecycle.metrics';
import { LifecycleCanaryRegistry, type LifecycleCanaryContext, type LifecycleCanaryPlant } from './lifecycle.purge.registry';
import { LifecycleRuns } from './lifecycle.runs';
import { deletableSql, deleteByPkSql, isQueryTimeout, lifecycleTableOf, rowsByPkSql, subjectWhereSql, userOwnedSql, userReferencedSql, workspaceOwnedSql } from './lifecycle.sql';
import { LifecycleTenantPurgeService } from './lifecycle.tenant-purge';

/** Канарейка уже идёт (второй прогон параллельно смешал бы синтетику и находки). */
export class LifecycleCanaryBusyError extends Error {
  constructor() {
    super('a canary run is already in progress');
  }
}

interface CanarySubjects {
  userId: string;
  peerId: string;
  workspaceId: string | null;
}

/** Состояние прогона в `lifecycle_runs.report` — по нему недоубранное доубирает следующий прогон. */
interface CanaryState {
  subjects?: CanarySubjects;
  plants?: LifecycleCanaryPlant[];
  cleaned?: boolean;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
/** Строк на находку — счёт до потолка (канарейке важен факт, а не точное число) */
const PROBE_CAP = 100;
/** Порядок находок в отчёте и журнале — по хранилищу */
const byStore = (a: LifecycleCanaryFinding, b: LifecycleCanaryFinding) => a.store.localeCompare(b.store) || a.kind.localeCompare(b.kind);

/**
 * Ночная канарейка стирания (Meta DELF, Google deletion canaries).
 *
 * Прогон: синтетические человек (его стирают), сосед и организация соседа, где человек —
 * сотрудник (телефоны `canary:<id>` — ни входа, ни SMS, ни находимости по номеру) → посев
 * модулей-владельцев (`LifecycleCanaryRegistry`: строки каждого хранилища плана стирания —
 * личное, общее с соседом, данные организации; маркер текста и фамилия-маркер) → стирание
 * НАСТОЯЩИМ оркестратором без грейса («стереть все мои сообщения») → воркер loose FK →
 * проверка → архив организации и её purge-каскад → проверка → уборка (стирание соседа,
 * остатки синтетики по ключу, строки аккаунтов).
 *
 * Проверка — двумя слоями. Посеянное: личное исчезло, общее и организации осталось (исчезло —
 * лишнее удаление) без фамилии, томбстоун без текста. Реестр целиком: у стёртого нет личных
 * строк ни одной политики `hard_delete` (утечка пути, которого посев не знал), фамилия не
 * встречается ни в одной строке, что на него ссылается (кроме `retain_legal`), нет ключей
 * Redis по шаблонам субъекта, ключи его скоупа ждут уничтожения; после каскада у организации
 * нет строк. Находка → `lifecycle.canary.failed` (critical) + метрика по хранилищу.
 *
 * Полнота: политика плана стирания без посева — в `unseeded` отчёта и метрике (сьют требует
 * пустоты). Запрос проверки политики ограничен по времени: большая таблица без индекса по
 * колонке субъекта даёт пробел (`skipped`), а не зависший прогон.
 */
@Injectable()
export class LifecycleCanaryService implements OnModuleInit {
  private readonly logger = new Logger(LifecycleCanaryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
    private readonly runs: LifecycleRuns,
    private readonly registry: LifecycleCanaryRegistry,
    private readonly erasure: LifecycleErasureService,
    private readonly tenant: LifecycleTenantPurgeService,
    private readonly looseFk: LifecycleLooseFk,
    private readonly audit: AuditService,
    private readonly metrics: LifecycleMetrics,
    private readonly redis: RedisService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  onModuleInit(): void {
    this.jobsRegistry.register(
      LIFECYCLE_JOBS.canary,
      async () => {
        try {
          await this.run({});
        } catch (err) {
          if (err instanceof LifecycleCanaryBusyError) return;
          throw err;
        }
      },
      // Провал — находка в отчёте, а не ретрай: следующий прогон — следующей ночью
      { queue: LIFECYCLE_QUEUE, queueConcurrency: 1, leaseMs: LIFECYCLE_LIMITS.canary.leaseMs, maxAttempts: 1 },
    );
    // Хранилища самого движка: выгрузка человека (строка, часть, манифест) и ключи Redis с его id
    this.registry.register('lifecycle.engine', (ctx) => this.seedEngineStores(ctx));
  }

  /** Поставить ночной прогон (крон): один в сутки — повтор постановки гасит uniqueKey. */
  async schedule(): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const res = await this.jobs.enqueue(null, { type: LIFECYCLE_JOBS.canary, payload: {}, uniqueKey: `canary:${day}` });
    return res.inserted;
  }

  // ============================================================
  // Прогон
  // ============================================================

  async run(opts: { leak?: LifecycleCanaryLeak }): Promise<LifecycleCanaryReportDto> {
    const started = Date.now();
    const running = await this.runs.findRunning('canary', {});
    if (running) {
      // Зависший прогон (процесс упал посреди) закрывается — его синтетику доберёт уборка ниже
      if (started - running.startedAt.getTime() < LIFECYCLE_LIMITS.canary.leaseMs) throw new LifecycleCanaryBusyError();
      await this.runs.finish(running.id, 'failed', { report: { error: 'stale' } });
    }
    await this.gc();
    const runId = await this.runs.start(null, { kind: 'canary', report: {} });
    const findings = new Map<string, LifecycleCanaryFinding>();
    const add = (store: string, kind: LifecycleCanaryFindingKind, count: number) => {
      if (count <= 0) return;
      const key = `${store}\u0000${kind}`;
      const f = findings.get(key);
      if (f) f.count += count;
      else findings.set(key, { store, kind, count });
    };
    const skipped = new Set<string>();
    let plants: LifecycleCanaryPlant[] = [];
    let subjects: CanarySubjects | null = null;
    let cleaned = false;
    try {
      const marker = `lcm${randomBytes(8).toString('hex')}`;
      const name = `Lcn${randomBytes(6).toString('hex')}`;
      subjects = await this.createSubjects(name);
      await this.runs.saveState(runId, { subjects } satisfies CanaryState);
      const ctx: LifecycleCanaryContext = { runId, userId: subjects.userId, peerId: subjects.peerId, workspaceId: subjects.workspaceId!, marker, name };

      plants = await this.seed(ctx, add);
      await this.runs.saveState(runId, { plants } satisfies CanaryState);

      // Стирание человека — настоящим оркестратором, без грейса, с выбором «стереть все мои сообщения»
      await this.eraseInline(ctx.userId);
      if (opts.leak) await this.plantLeak(ctx, opts.leak);
      await this.looseFk.process(LIFECYCLE_LIMITS.canary.verifyBudgetMs);
      await this.verifySubject(ctx, plants, add, skipped);

      // Организация: архив → purge-каскад реестра → у неё не осталось ничего
      const factory = this.registry.workspaceFactory()!;
      await factory.archive(ctx.workspaceId);
      await this.tenant.purgeNow(asWorkspaceId(ctx.workspaceId));
      await this.looseFk.process(LIFECYCLE_LIMITS.canary.verifyBudgetMs);
      await this.verifyTenant(ctx, plants, add, skipped);
    } catch (err) {
      add('canary', 'error', 1);
      this.logger.error(`canary run ${runId} failed: ${err instanceof Error ? err.stack ?? err.message : err}`);
    } finally {
      if (subjects) cleaned = await this.cleanup(subjects, plants).catch((err: unknown) => {
        this.logger.warn(`canary run ${runId}: cleanup incomplete (${err instanceof Error ? err.message : err}) — the next run finishes it`);
        return false;
      });
    }

    const planted = new Set(plants.map((p) => p.policy));
    const unseeded = this.coverage().filter((id) => !planted.has(id));
    const list = [...findings.values()].sort(byStore);
    const report: LifecycleCanaryReportDto = {
      runId,
      ok: list.length === 0,
      planted: plants.length,
      policies: planted.size,
      unseeded,
      findings: list,
      skipped: [...skipped].sort(),
      durationMs: Date.now() - started,
      cleaned,
    };
    await this.runs.finish(runId, report.ok ? 'done' : 'failed', {
      report: { ok: report.ok, planted: report.planted, policies: report.policies, unseeded, findings: list, skipped: report.skipped, durationMs: report.durationMs, cleaned } as Record<string, unknown>,
    });
    this.metrics.canaryCoverage(unseeded.length);
    if (report.ok) {
      this.metrics.canaryOk(new Date());
    } else {
      for (const f of list) this.metrics.canaryFailed(f.store);
      await this.db.$transaction((tx) =>
        this.audit.record(tx, {
          key: 'lifecycle.canary.failed',
          actor: { kind: 'system' },
          subjectUserId: null,
          workspaceId: null,
          target: { type: 'lifecycle_run', id: runId },
          details: { stores: new Set(list.map((f) => f.store)).size, findings: list.length },
        }),
      );
      this.logger.error(`canary run ${runId}: ${list.length} finding(s) — ${list.map((f) => `${f.store}:${f.kind}×${f.count}`).join(', ')}`);
    }
    return report;
  }

  /** Политики плана стирания человека, которые канарейка обязана посеять (полнота проверки). */
  coverage(): string[] {
    const ids = new Set<string>();
    for (const step of lifecycleSubjectErasurePlan()) {
      if (step.kind === 'hook') for (const p of step.policies) ids.add(p);
      else ids.add(step.policy);
    }
    return [...ids].filter((id) => (LIFECYCLE_POLICY_IDS as readonly string[]).includes(id)).sort();
  }

  // ============================================================
  // Синтетические субъекты и посев
  // ============================================================

  /** Человек и сосед — теневые строки `users` (как бот: без входа, номер `canary:<id>`); организация — модулем организаций. */
  private async createSubjects(name: string): Promise<CanarySubjects> {
    const factory = this.registry.workspaceFactory();
    if (!factory) throw new Error('canary: the workspace factory is not registered (workspaces module)');
    const userId = uuidv7();
    const peerId = uuidv7();
    await this.db.user.create({ data: { id: userId, kind: 'person', phone: `canary:${userId}`, password: '!', firstName: 'Canary', lastName: name } });
    await this.db.user.create({ data: { id: peerId, kind: 'person', phone: `canary:${peerId}`, password: '!', firstName: 'Canary', lastName: 'Peer' } });
    const subjects: CanarySubjects = { userId, peerId, workspaceId: null };
    subjects.workspaceId = await factory.create(peerId, userId, `Canary ${name}`);
    return subjects;
  }

  /** Посев всех зарегистрированных модулей; упавший — находка `seed` (его хранилища не проверены). */
  private async seed(ctx: LifecycleCanaryContext, add: (store: string, kind: LifecycleCanaryFindingKind, n: number) => void): Promise<LifecycleCanaryPlant[]> {
    const out: LifecycleCanaryPlant[] = [];
    for (const [key, seed] of this.registry.entries()) {
      try {
        out.push(...(await seed(ctx)));
      } catch (err) {
        add(key, 'seed', 1);
        this.logger.error(`canary seed "${key}" failed: ${err instanceof Error ? err.stack ?? err.message : err}`);
      }
    }
    return out;
  }

  /** Посев движка: выгрузка человека (строка + часть + манифест) и по ключу на семейство Redis с шаблоном субъекта. */
  private async seedEngineStores(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const plants: LifecycleCanaryPlant[] = [];
    const exportId = uuidv7();
    const prefix = `${LIFECYCLE_EXPORT_PREFIX}${exportId}/`;
    const partKey = `${prefix}part-1.zip`;
    const manifestKey = `${prefix}manifest.json`;
    for (const key of [partKey, manifestKey]) {
      const tmp = appTmpPath(`canary-${exportId}-${key.endsWith('.json') ? 'manifest' : 'part'}`);
      await fs.writeFile(tmp, ctx.marker);
      try {
        await this.storage.putFromFile(key, tmp, key.endsWith('.json') ? 'application/json' : 'application/zip');
      } finally {
        await fs.unlink(tmp).catch(() => undefined);
      }
    }
    const parts: LifecycleExportPart[] = [{ key: partKey, bytes: ctx.marker.length, sha256: '0'.repeat(64) }];
    await this.db.lifecycleExport.create({
      data: { id: exportId, subjectType: 'user', subjectId: ctx.userId, requestedById: ctx.userId, status: 'ready', parts: parts as unknown as Prisma.InputJsonValue, readyAt: new Date() },
    });
    plants.push({ policy: 'LifecycleExport', id: exportId, expect: 'gone' });
    plants.push({ policy: 'derived:lifecycle_exports', id: partKey, expect: 'gone' });
    plants.push({ policy: 'derived:lifecycle_exports', id: manifestKey, expect: 'gone' });
    // Ключ на семейство: шаблон субъекта с id человека, звёздочка — маркер (ключ остаётся в своём
    // семействе и в инстансе его роли)
    for (const p of lifecyclePoliciesOf('redis')) {
      if (p.store.kind !== 'redis' || !p.store.subjectPattern || p.onSubjectErasure.kind !== 'hard_delete') continue;
      const client = this.redis.clientFor(p.store.role);
      if (!client) continue;
      const key = p.store.subjectPattern.replace('{user}', ctx.userId).replace(/\*/g, 'canary');
      const ttl = Math.min(900, p.store.maxTtlSeconds ?? 900);
      await client.set(key, ctx.marker, 'EX', ttl);
      plants.push({ policy: p.id, id: key, expect: 'gone' });
    }
    return plants;
  }

  /** Утечка для проверки самой канарейки (дев-полигон): посев модуля задач или ключ Redis ПОСЛЕ стирания. */
  private async plantLeak(ctx: LifecycleCanaryContext, leak: LifecycleCanaryLeak): Promise<void> {
    if (leak === 'redis') {
      const p = lifecyclePoliciesOf('redis').find((x) => x.store.kind === 'redis' && !!x.store.subjectPattern);
      if (p?.store.kind !== 'redis' || !p.store.subjectPattern) throw new Error('canary: no redis family with a subject pattern');
      await (this.redis.clientFor(p.store.role) ?? this.redis.getClient()).set(p.store.subjectPattern.replace('{user}', ctx.userId).replace(/\*/g, 'leak'), ctx.marker, 'EX', 900);
      return;
    }
    const seed = this.registry.get('tasks.subject');
    if (!seed) throw new Error('canary: the tasks seed is not registered — no row leak to plant');
    await seed(ctx);
  }

  /** Стирание синтетического человека настоящим оркестратором — сразу, без джоба. */
  private async eraseInline(userId: string): Promise<void> {
    const { requestId } = await this.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { deletionScheduledAt: new Date() } });
      return this.erasure.request(tx, { subject: { type: 'user', id: userId }, effectiveAt: new Date(), options: { eraseMessages: true }, inline: true });
    });
    for (let i = 0; i < 20; i++) {
      const out = await this.erasure.execute(requestId, null);
      if (out === 'done') return;
      if (out === 'held') throw new Error(`canary: the erasure of ${userId} is held by a legal hold`);
      if (typeof out === 'number') await new Promise((r) => setTimeout(r, Math.min(out, 1000)));
    }
    throw new Error(`canary: the erasure of ${userId} did not finish`);
  }

  // ============================================================
  // Проверка
  // ============================================================

  /** Слой посеянного и реестр целиком — после стирания человека. */
  private async verifySubject(
    ctx: LifecycleCanaryContext,
    plants: readonly LifecycleCanaryPlant[],
    add: (store: string, kind: LifecycleCanaryFindingKind, n: number) => void,
    skipped: Set<string>,
  ): Promise<void> {
    const state = await this.plantState(plants);
    for (const p of plants) {
      const s = state.get(`${p.policy}\u0000${p.id}`);
      if (p.expect === 'gone') {
        if (s) add(p.policy, p.policy.startsWith('blob:') || p.policy.startsWith('derived:') ? 'blob' : p.policy.startsWith('redis:') ? 'redis' : 'present', 1);
        continue;
      }
      if (!s) {
        add(p.policy, 'missing', 1);
        continue;
      }
      if (s.text?.includes(ctx.name)) add(p.policy, 'name', 1);
      if (p.expect === 'scrubbed' && s.text?.includes(ctx.marker)) add(p.policy, 'marker', 1);
    }

    const pattern = `%${ctx.name}%`;
    for (const id of LIFECYCLE_POLICY_IDS) {
      const policy = lifecyclePolicy(id)!;
      const t = lifecycleTableOf(policy);
      if (!t) continue;
      const se = policy.onSubjectErasure;
      // Личное стёртого по политике удаления — ни строки (кроме удерживаемых заморозкой)
      if (se.kind === 'hard_delete') {
        const who = se.by?.length ? subjectWhereSql(policy, t, se.by, ctx.userId, !!se.personalOnly) : userOwnedSql(policy, t, ctx.userId);
        if (who) {
          const n = await this.probe(Prisma.sql`SELECT count(*)::bigint AS n FROM (SELECT 1 FROM ${t.ident} t WHERE ${who} AND ${deletableSql(policy, t)} LIMIT ${PROBE_CAP}) x`);
          if (n === null) skipped.add(id);
          else add(id, 'owned', n);
        }
      }
      // Фамилия стёртого — ни в одной строке, что на него ссылается (закон держит только retain_legal)
      if (se.kind !== 'retain_legal') {
        const ref = userReferencedSql(policy, t, ctx.userId);
        if (ref) {
          const n = await this.probe(Prisma.sql`SELECT count(*)::bigint AS n FROM (SELECT 1 FROM ${t.ident} t WHERE ${ref} AND to_jsonb(t)::text LIKE ${pattern} LIMIT ${PROBE_CAP}) x`);
          if (n === null) skipped.add(id);
          else add(id, 'name', n);
        }
      }
    }

    // Redis: один проход по ключам с id человека, раскладка по семействам с шаблоном субъекта
    const families = lifecyclePoliciesOf('redis').filter((p) => p.store.kind === 'redis' && !!p.store.subjectPattern && p.onSubjectErasure.kind === 'hard_delete');
    const matchers = families.map((p) => ({ id: p.id, re: globRe((p.store as { subjectPattern: string }).subjectPattern.replace('{user}', ctx.userId)) }));
    // Оба инстанса (состояние и кэш): утечка в любом — находка
    for (const client of this.redis.instances()) {
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `*${ctx.userId}*`, 'COUNT', 1000);
        cursor = next;
        for (const k of keys) {
          const hit = matchers.find((m) => m.re.test(k));
          if (hit) add(hit.id, 'redis', 1);
        }
      } while (cursor !== '0');
    }

    // Ключи скоупа человека: ни одной живой версии (стирание ставит их на уничтожение)
    const live = await this.db.cryptoKeyVersion.count({ where: { key: { scope: userScope(ctx.userId) }, state: { in: ['active', 'pending', 'disabled'] } } });
    add('keys', 'keys', live);
  }

  /** После purge-каскада организации: ни посеянного организации, ни её строк в реестре. */
  private async verifyTenant(
    ctx: LifecycleCanaryContext,
    plants: readonly LifecycleCanaryPlant[],
    add: (store: string, kind: LifecycleCanaryFindingKind, n: number) => void,
    skipped: Set<string>,
  ): Promise<void> {
    const tenantPlants = plants.filter((p) => p.tenant && lifecyclePolicy(p.policy)?.onTenantPurge.kind !== 'retain_legal');
    const state = await this.plantState(tenantPlants);
    for (const p of tenantPlants) if (state.has(`${p.policy}\u0000${p.id}`)) add(p.policy, 'tenant', 1);
    if (await this.db.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { id: true } })) add('Workspace', 'tenant', 1);
    for (const id of LIFECYCLE_POLICY_IDS) {
      const policy = lifecyclePolicy(id)!;
      const t = lifecycleTableOf(policy);
      if (!t || policy.onTenantPurge.kind === 'retain_legal' || policy.onTenantPurge.kind === 'not_applicable') continue;
      const ws = workspaceOwnedSql(policy, t, ctx.workspaceId);
      if (!ws) continue;
      const n = await this.probe(Prisma.sql`SELECT count(*)::bigint AS n FROM (SELECT 1 FROM ${t.ident} t WHERE ${ws} AND ${deletableSql(policy, t)} LIMIT ${PROBE_CAP}) x`);
      if (n === null) skipped.add(id);
      else add(id, 'tenant', n);
    }
  }

  /** Что сейчас лежит по посеянным ключам: есть ли и текст строки (модели и сырые таблицы). */
  private async plantState(plants: readonly LifecycleCanaryPlant[]): Promise<Map<string, { text: string | null }>> {
    const out = new Map<string, { text: string | null }>();
    const byPolicy = new Map<string, string[]>();
    for (const p of plants) byPolicy.set(p.policy, [...(byPolicy.get(p.policy) ?? []), p.id]);
    for (const [policyId, ids] of byPolicy) {
      const policy = lifecyclePolicy(policyId);
      if (!policy) continue;
      const kind = policy.store.kind;
      if (kind === 'model') {
        const t = lifecycleTableOf(policy)!;
        for (const r of await this.db.$queryRaw<Array<{ id: string; j: string }>>(rowsByPkSql(t, ids))) out.set(`${policyId}\u0000${r.id}`, { text: r.j });
      } else if (kind === 'table') {
        const [schema, table] = (policy.store as { table: string }).table.split('.');
        const key = plants.find((p) => p.policy === policyId)?.key ?? 'id';
        if (!schema || !table || !IDENT.test(schema) || !IDENT.test(table) || !IDENT.test(key)) continue;
        const rows = await this.db.$queryRaw<Array<{ id: string; j: string }>>(
          Prisma.sql`SELECT t.${Prisma.raw(`"${key}"`)}::text AS id, to_jsonb(t)::text AS j FROM ${Prisma.raw(`"${schema}"."${table}"`)} t WHERE t.${Prisma.raw(`"${key}"`)}::text = ANY(${ids}::text[])`,
        );
        for (const r of rows) out.set(`${policyId}\u0000${r.id}`, { text: r.j });
      } else if (kind === 'blob' || kind === 'derived') {
        for (const key of ids) if ((await this.storage.size(key)) !== null) out.set(`${policyId}\u0000${key}`, { text: null });
      } else if (policy.store.kind === 'redis') {
        const client = this.redis.clientFor(policy.store.role);
        if (!client) continue;
        for (const key of ids) if ((await client.exists(key)) > 0) out.set(`${policyId}\u0000${key}`, { text: await client.get(key).catch(() => null) });
      }
    }
    return out;
  }

  /** Счёт под потолком времени запроса; истёк — `null` (пробел проверки, а не находка). */
  private async probe(sql: Prisma.Sql): Promise<number | null> {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${LIFECYCLE_LIMITS.canary.queryTimeoutMs}ms`}, true)`;
        const [r] = await tx.$queryRaw<Array<{ n: bigint }>>(sql);
        return Number(r?.n ?? 0);
      });
    } catch (err) {
      if (isQueryTimeout(err)) return null;
      throw err;
    }
  }

  // ============================================================
  // Уборка
  // ============================================================

  /**
   * Синтетика прогона: сосед стирается тем же оркестратором (его личное и общие беседы уходят
   * путём продукта), остатки посеянного — по ключу (синтетика, правило «общее остаётся» к ней
   * не относится), организация, если каскад не дошёл, — каскадом, строки аккаунтов — последними.
   * Возвращает, убрано ли всё (иначе доберёт следующий прогон).
   */
  private async cleanup(subjects: CanarySubjects, plants: readonly LifecycleCanaryPlant[]): Promise<boolean> {
    // Организация первой: сосед — её владелец
    if (subjects.workspaceId && (await this.db.workspace.findUnique({ where: { id: subjects.workspaceId }, select: { id: true } }))) {
      await this.registry.workspaceFactory()?.archive(subjects.workspaceId);
      await this.tenant.purgeNow(asWorkspaceId(subjects.workspaceId));
    }
    for (const id of [subjects.userId, subjects.peerId]) {
      const u = await this.db.user.findUnique({ where: { id }, select: { deletedAt: true } });
      if (u && !u.deletedAt) await this.eraseInline(id);
    }
    // Остатки посеянного по ключу: строки моделей, объекты хранилища, ключи Redis
    const byPolicy = new Map<string, string[]>();
    for (const p of plants) byPolicy.set(p.policy, [...(byPolicy.get(p.policy) ?? []), p.id]);
    for (const [policyId, ids] of byPolicy) {
      const policy = lifecyclePolicy(policyId);
      // Строки аккаунтов — последними (на них держатся внешние ключи прочих строк)
      if (!policy || policyId === 'User') continue;
      if (policy.store.kind === 'model') {
        const t = lifecycleTableOf(policy)!;
        await this.db.$executeRaw(deleteByPkSql(t, ids)).catch((err: unknown) => this.logger.warn(`canary cleanup of ${policyId}: ${err instanceof Error ? err.message : err}`));
      } else if (policy.store.kind === 'table') {
        const [schema, table] = policy.store.table.split('.');
        const key = plants.find((p) => p.policy === policyId)?.key ?? 'id';
        if (schema && table && IDENT.test(schema) && IDENT.test(table) && IDENT.test(key)) {
          await this.db
            .$executeRaw(Prisma.sql`DELETE FROM ${Prisma.raw(`"${schema}"."${table}"`)} t WHERE t.${Prisma.raw(`"${key}"`)}::text = ANY(${ids}::text[])`)
            .catch((err: unknown) => this.logger.warn(`canary cleanup of ${policyId}: ${err instanceof Error ? err.message : err}`));
        }
      } else if (policy.store.kind === 'blob' || policy.store.kind === 'derived') {
        for (const key of ids) await this.storage.delete(key).catch(() => undefined);
      } else if (policy.store.kind === 'redis') {
        await this.redis.clientFor(policy.store.role)?.del(...ids).catch(() => 0);
      }
    }
    await this.purgeLeftovers([subjects.userId, subjects.peerId]);
    // Строки аккаунтов: всё, что на них ссылается внешним ключом, уже ушло (или уйдёт каскадом FK)
    await this.db.user.deleteMany({ where: { id: { in: [subjects.userId, subjects.peerId] } } });
    return true;
  }

  /**
   * Остатки синтетики, которых нет среди посеянного (утечка пути, подсаженная утечка): строки,
   * где синтетический человек — владелец (ключ владельца реестра), и ключи Redis с его id.
   * Иначе утёкшая строка держала бы аккаунт внешним ключом, и уборка не сходилась бы никогда.
   */
  private async purgeLeftovers(userIds: readonly string[]): Promise<void> {
    for (const id of LIFECYCLE_POLICY_IDS) {
      if (id === 'User') continue;
      const policy = lifecyclePolicy(id)!;
      const t = lifecycleTableOf(policy);
      if (!t) continue;
      for (const uid of userIds) {
        const owned = userOwnedSql(policy, t, uid);
        if (!owned) continue;
        await this.db.$executeRaw(Prisma.sql`DELETE FROM ${t.ident} t WHERE ${owned}`).catch((err: unknown) => this.logger.warn(`canary leftovers of ${id}: ${err instanceof Error ? err.message : err}`));
      }
    }
    for (const client of this.redis.instances()) {
      for (const uid of userIds) {
        let cursor = '0';
        do {
          const [next, keys] = await client.scan(cursor, 'MATCH', `*${uid}*`, 'COUNT', 1000);
          cursor = next;
          if (keys.length) await client.del(...keys);
        } while (cursor !== '0');
      }
    }
  }

  /** Недоубранные прогоны (сбой процесса, упавшая уборка) — доубираются перед новым; идущий исключён статусом. */
  private async gc(): Promise<void> {
    const rows = await this.db.$queryRaw<Array<{ id: string; report: Prisma.JsonValue }>>`
      SELECT id::text AS id, report FROM "lifecycle_runs"
       WHERE kind = 'canary' AND status <> 'running'
         AND COALESCE((report->>'cleaned')::boolean, false) = false
         AND report ? 'subjects'
       ORDER BY started_at LIMIT 5`;
    for (const r of rows) {
      const state = (r.report ?? {}) as CanaryState;
      if (!state.subjects) continue;
      const ok = await this.cleanup(state.subjects, state.plants ?? []).catch((err: unknown) => {
        this.logger.warn(`canary gc of ${r.id}: ${err instanceof Error ? err.message : err}`);
        return false;
      });
      if (ok) await this.runs.saveState(r.id, { cleaned: true } satisfies CanaryState);
    }
  }
}

/** Glob-шаблон ключа Redis → регулярное выражение (`*` — любая подстрока). */
function globRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}
