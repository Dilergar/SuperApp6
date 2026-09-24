import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type Redis from 'ioredis';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  ANALYTICS_CLASS_CODE,
  ANALYTICS_OWNER_CODE,
  ANALYTICS_PLATFORMS,
  ANALYTICS_SOURCE_CODE,
  WORKSPACE_ROLE_RANK,
  analyticsEventDef,
  analyticsSourceOf,
  type AnalyticsEventDef,
  type AnalyticsQuarantineReason, uuidv7 } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { utcTs } from '../../shared/database/sql-time';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { RolesService } from '../roles/roles.service';
import { RecentIds, TtlCache } from './analytics.cache';
import {
  ANALYTICS_GROUP,
  ANALYTICS_INGEST_VERSION,
  ANALYTICS_REDIS,
  ANALYTICS_STREAM,
  analyticsEnv,
  type AnalyticsCounter,
  type AnalyticsIngestEvent,
  type AnalyticsIngestReject,
  type AnalyticsStreamEntry,
} from './analytics.constants';
import { clampEventTime, dayInZone, isUuid, redactProps, safeJsonParse, sanitizeKey, shapeOf, uuidOrNull } from './analytics.enrich';
import { AnalyticsPartitions } from './analytics.partitions';
import { AnalyticsService } from './analytics.service';

type Tx = Prisma.TransactionClient;
type Client = Tx | DatabaseService;

const READ_COUNT = 50;
const BLOCK_MS = 1000;
const CLAIM_IDLE_MS = 60_000;
const INSERT_CHUNK = 1000;
const OUTBOX_BATCH = 1000;
const OUTBOX_EVERY_MS = 1000;
/** Сколько батчей outbox дренировать за тик (дальше — следующий тик) */
const OUTBOX_MAX_ROUNDS = 10;

interface UserInfo {
  phone: string;
  deleted: boolean;
  optOut: boolean;
}

interface Row {
  eventId: string;
  ts: Date;
  occurredAt: Date;
  receivedAt: Date;
  corrected: boolean;
  key: string;
  service: string;
  cls: number;
  source: number;
  userId: string | null;
  anonymousId: string | null;
  workspaceId: string | null;
  owner: number;
  sessionId: string | null;
  deviceId: string | null;
  loginSid: string | null;
  planKey: string | null;
  planVersion: number | null;
  role: string | null;
  platform: string;
  appVersion: string | null;
  deviceClass: number | null;
  os: string | null;
  browser: string | null;
  locale: string | null;
  tz: string | null;
  route: string | null;
  refType: string | null;
  refId: string | null;
  props: string;
  sampleRate: number;
  internal: boolean;
  schemaVersion: number;
}

/** Итог конвейера: эффекты вне БД применяются вызывающим ПОСЛЕ коммита. */
interface IngestOutcome {
  eventIds: string[];
  times: Date[];
  counters: Partial<Record<AnalyticsCounter, number>>;
}

/**
 * Ошибка, которая могла прийти от «ядовитой» строки внутри транзакции: Postgres после
 * первой ошибки отвечает `25P02 current transaction is aborted`, Prisma — P2028/P2010.
 * Такие пачки разбираются по одной строке, а не ретраятся вечно.
 */
const sqlStateOf = (err: unknown): string =>
  err instanceof Prisma.PrismaClientKnownRequestError ? String((err.meta as { code?: string } | undefined)?.code ?? '') : '';

/**
 * «Ядовитая» строка — только ошибка ДАННЫХ (класс 22) или целостности (23). Класс 42
 * (синтаксис, приведение типов) — баг кода, а не строки: такие события не хоронятся
 * в карантин, а ждут исправления в stream'е/outbox.
 */
const isPoisonCandidate = (err: unknown): boolean => /^(22|23)/.test(sqlStateOf(err));

const isMissingPartition = (err: unknown) => /no partition of relation/i.test(err instanceof Error ? err.message : String(err));

/** Потолок одновременных обращений к БД из обогащения (батч в 2500 событий — не 2500 запросов разом). */
const ENRICH_CONCURRENCY = 16;

/** `Promise.all` с потолком параллельности: пул соединений не выбирается одной пачкой. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/**
 * Консьюмер приёма: stream `superapp:analytics` (группа, по консьюмеру на инстанс,
 * XAUTOCLAIM зависших) + дренаж `analytics.outbox` (SKIP LOCKED, в одной транзакции
 * со вставкой). Конвейер: реестр и рубильник → строгая схема → PII-скан → личность
 * (удалённый аккаунт — прочь; членство в заявленной организации) → отказ человека
 * (product/telemetry) → обогащение (снимок тарифа, внутренний аккаунт) → вставка
 * `unnest … ON CONFLICT DO NOTHING` пачками. Транзиентная ошибка — без ack
 * (переклейм), постоянная — карантин и ack.
 */
@Injectable()
export class AnalyticsIngestService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsIngestService.name);
  private readonly consumerName = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private consumer: Redis | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private lastOutbox = 0;

  private readonly seen = new RecentIds(200_000);
  private readonly users = new TtlCache<string, UserInfo | null>(60_000, 100_000);
  private readonly plans = new TtlCache<string, { planKey: string | null; planVersion: number | null }>(60_000, 50_000);
  private readonly membership = new TtlCache<string, string | null>(60_000, 100_000);
  private overrides: { at: number; map: Map<string, string> } = { at: 0, map: new Map() };
  private staff: { at: number; set: Set<string> } = { at: 0, set: new Set() };

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly entitlements: EntitlementsService,
    private readonly roles: RolesService,
    private readonly partitions: AnalyticsPartitions,
    private readonly analytics: AnalyticsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const env = analyticsEnv();
    if (!env.enabled || !env.consumerEnabled) {
      this.logger.log('analytics consumer is disabled (ANALYTICS_ENABLED / ANALYTICS_CONSUMER_ENABLED)');
      return;
    }
    this.consumer = this.redis.getClient().duplicate({ maxRetriesPerRequest: null });
    this.running = true;
    await this.ensureGroup();
    this.loop = this.consumeLoop();
    this.logger.log(`analytics consumer "${this.consumerName}" started`);
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.consumer?.disconnect();
    try {
      await this.loop;
    } catch {
      /* цикл уже снят */
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get c(): any {
    return this.consumer;
  }

  private async ensureGroup(): Promise<void> {
    try {
      await this.c.xgroup('CREATE', ANALYTICS_STREAM, ANALYTICS_GROUP, '0', 'MKSTREAM');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('BUSYGROUP')) this.logger.warn(`xgroup CREATE failed: ${msg}`);
    }
  }

  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        if (Date.now() - this.lastOutbox >= OUTBOX_EVERY_MS) {
          this.lastOutbox = Date.now();
          await this.drainOutbox();
        }
        await this.reclaimStale();
        const res = (await this.c.xreadgroup(
          'GROUP',
          ANALYTICS_GROUP,
          this.consumerName,
          'COUNT',
          READ_COUNT,
          'BLOCK',
          BLOCK_MS,
          'STREAMS',
          ANALYTICS_STREAM,
          '>',
        )) as [string, [string, string[]][]][] | null;
        if (!res) continue;
        for (const [, entries] of res) await this.processEntries(entries);
      } catch (err) {
        if (!this.running) break;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('NOGROUP')) {
          await this.ensureGroup();
          continue;
        }
        this.logger.error(`analytics consume loop: ${msg}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async reclaimStale(): Promise<void> {
    try {
      const res = (await this.c.xautoclaim(ANALYTICS_STREAM, ANALYTICS_GROUP, this.consumerName, CLAIM_IDLE_MS, '0', 'COUNT', READ_COUNT)) as
        | [string, [string, string[] | null][], string[]?]
        | null;
      const entries = (res?.[1] ?? []).filter((e): e is [string, string[]] => !!e[1]);
      if (entries.length) await this.processEntries(entries);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('NOGROUP')) this.logger.warn(`xautoclaim failed: ${msg}`);
    }
  }

  /** Записи stream'а → конвейер → ack. Битая запись (не JSON) — постоянная ошибка: ack сразу. */
  private async processEntries(entries: Array<[string, string[]]>): Promise<void> {
    const events: AnalyticsIngestEvent[] = [];
    const rejects: AnalyticsIngestReject[] = [];
    const ids: string[] = [];
    for (const [id, fields] of entries) {
      ids.push(id);
      const i = fields.indexOf('data');
      if (i === -1) continue;
      try {
        const entry = safeJsonParse<AnalyticsStreamEntry>(fields[i + 1] ?? '');
        if (Array.isArray(entry?.events)) events.push(...entry.events);
        if (Array.isArray(entry?.rejects)) rejects.push(...entry.rejects);
      } catch {
        this.logger.warn(`analytics stream entry ${id} is not JSON — acknowledged and skipped`);
      }
    }
    const outcome = await this.ingest(events, rejects, null);
    await this.finalize(outcome);
    if (ids.length) await this.c.xack(ANALYTICS_STREAM, ANALYTICS_GROUP, ...ids);
  }

  /**
   * Дренаж outbox: выборка с SKIP LOCKED, вставка и удаление строк — одной транзакцией.
   * Постоянная ошибка пачки (а внутри транзакции она абортит всё) — разбор по одной
   * строке в своих транзакциях: «ядовитая» строка уходит в карантин и удаляется,
   * иначе она вечно блокировала бы очередь.
   */
  async drainOutbox(): Promise<number> {
    let total = 0;
    for (let round = 0; round < OUTBOX_MAX_ROUNDS; round++) {
      let n: number;
      try {
        n = await this.drainBatch(OUTBOX_BATCH, null);
      } catch (err) {
        if (!isPoisonCandidate(err)) throw err;
        n = await this.drainOneByOne();
      }
      total += n;
      if (n < OUTBOX_BATCH) break;
    }
    return total;
  }

  /**
   * Пачка outbox одной транзакцией. `exactId` — ровно одна строка (разбор по одной):
   * условие `id > …` со SKIP LOCKED отдало бы СОСЕДНЮЮ строку, если эту держит другой
   * инстанс, и в карантин ушёл бы не тот payload.
   */
  private async drainBatch(limit: number, exactId: bigint | null): Promise<number> {
    let outcome: IngestOutcome | null = null;
    const n = await this.db.$transaction(
      async (tx) => {
        const rows = exactId === null
          ? await tx.$queryRaw<Array<{ id: bigint; payload: unknown }>>`
              SELECT id, payload FROM analytics.outbox ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`
          : await tx.$queryRaw<Array<{ id: bigint; payload: unknown }>>`
              SELECT id, payload FROM analytics.outbox WHERE id = ${exactId} FOR UPDATE SKIP LOCKED`;
        if (!rows.length) return 0;
        const events = rows.map((r) => r.payload as AnalyticsIngestEvent).filter((e) => e && typeof e === 'object');
        outcome = await this.ingest(events, [], tx);
        await tx.$executeRaw`DELETE FROM analytics.outbox WHERE id = ANY(${rows.map((r) => r.id)}::bigint[])`;
        return rows.length;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    // Эффекты вне БД — только после коммита: откат не должен оставлять «виденные» id
    if (outcome) await this.finalize(outcome);
    return n;
  }

  private async drainOneByOne(): Promise<number> {
    let done = 0;
    let cursor: bigint | null = null;
    for (let i = 0; i < OUTBOX_BATCH; i++) {
      const head: Array<{ id: bigint; payload: unknown }> = cursor === null
        ? await this.db.$queryRaw`SELECT id, payload FROM analytics.outbox ORDER BY id LIMIT 1`
        : await this.db.$queryRaw`SELECT id, payload FROM analytics.outbox WHERE id > ${cursor} ORDER BY id LIMIT 1`;
      const row = head[0];
      if (!row) break;
      cursor = row.id;
      try {
        // Строку держит другой инстанс — она его: идём к следующей
        if ((await this.drainBatch(1, row.id)) === 0) continue;
      } catch (err) {
        if (!isPoisonCandidate(err)) throw err;
        const key = sanitizeKey((row.payload as { key?: unknown } | null)?.key);
        await this.writeQuarantine(this.db, [{ key, reason: 'schema', count: 1, shape: shapeOf((row.payload as { props?: unknown } | null)?.props) }]);
        await this.db.$executeRaw`DELETE FROM analytics.outbox WHERE id = ${row.id}`;
        this.logger.warn(`analytics outbox row ${row.id} (${key}) rejected by the database and quarantined`);
      }
      done++;
    }
    return done;
  }

  /** Эффекты после коммита: дедуп-кольцо, «грязные» дни, счётчики. */
  private async finalize(outcome: IngestOutcome): Promise<void> {
    for (const id of outcome.eventIds) this.seen.add(id);
    if (outcome.times.length) await this.markDirty(outcome.times, analyticsEnv().timezone);
    await this.analytics.bumpCounters(outcome.counters);
  }

  // ============================================================
  // Конвейер
  // ============================================================

  async ingest(events: AnalyticsIngestEvent[], rejects: AnalyticsIngestReject[], tx: Tx | null): Promise<IngestOutcome> {
    const counters: Partial<Record<AnalyticsCounter, number>> = {};
    const bump = (k: AnalyticsCounter, n = 1) => (counters[k] = (counters[k] ?? 0) + n);
    const quarantine = new Map<string, { key: string; reason: AnalyticsQuarantineReason; count: number; shape: Record<string, string> }>();
    const addQ = (key: string, reason: AnalyticsQuarantineReason, shape: Record<string, string>) => {
      const k = sanitizeKey(key);
      const id = `${k}|${reason}`;
      const hit = quarantine.get(id);
      if (hit) hit.count++;
      else if (quarantine.size < 200) quarantine.set(id, { key: k, reason, count: 1, shape });
    };
    for (const r of rejects) addQ(r.key, r.reason, r.shape && typeof r.shape === 'object' ? r.shape : {});

    const overrides = await this.loadOverrides();
    const candidates: Array<{ ev: AnalyticsIngestEvent; def: AnalyticsEventDef; props: Record<string, unknown> }> = [];
    for (const ev of events) {
      if (!ev || typeof ev.key !== 'string' || !isUuid(ev.eventId)) {
        addQ(String(ev?.key ?? '(missing)'), 'schema', {});
        bump('dropped');
        continue;
      }
      if (this.seen.has(ev.eventId)) continue;
      const def = analyticsEventDef(ev.key);
      if (!def) {
        addQ(ev.key, 'unknown_key', shapeOf(ev.props));
        bump('dropped');
        continue;
      }
      if ((overrides.get(ev.key) ?? def.status) === 'blocked') {
        bump('blocked');
        continue;
      }
      const parsed = def.props.safeParse(ev.props ?? {});
      if (!parsed.success) {
        addQ(ev.key, 'schema', shapeOf(ev.props));
        bump('dropped');
        continue;
      }
      const redacted = redactProps(parsed.data as Record<string, unknown>);
      if (redacted.redacted) {
        bump('redacted', redacted.redacted);
        addQ(ev.key, 'pii', shapeOf(parsed.data));
      }
      candidates.push({ ev, def, props: redacted.props });
    }

    // ---- Личность: одним запросом на батч ----
    const userInfo = await this.loadUsers(candidates.map((c) => c.ev.userId).filter(isUuid));
    await this.loadMemberships(candidates.map((c) => ({ userId: c.ev.userId, workspaceId: c.ev.claimedWorkspaceId })));
    const staff = await this.loadStaff();
    const env = analyticsEnv();

    const kept: Array<{ ev: AnalyticsIngestEvent; def: AnalyticsEventDef; props: Record<string, unknown>; userId: string | null; workspaceId: string | null; role: string | null; user: UserInfo | null }> = [];
    for (const c of candidates) {
      const userId = uuidOrNull(c.ev.userId);
      const user = userId ? (userInfo.get(userId) ?? null) : null;
      // Удалённый (анонимизированный) или несуществующий аккаунт: событие в полёте не воскрешает его
      if (userId && (!user || user.deleted)) {
        bump('dropped');
        continue;
      }
      let workspaceId = uuidOrNull(c.ev.workspaceId);
      let role = c.ev.role ?? null;
      if (!workspaceId && userId && c.ev.claimedWorkspaceId) {
        const r = this.membership.get(`${userId}:${c.ev.claimedWorkspaceId}`);
        if (r) {
          workspaceId = uuidOrNull(c.ev.claimedWorkspaceId);
          role = r;
        }
      }
      if (c.def.class !== 'business' && (c.ev.gpc === true || user?.optOut)) {
        bump('optedOut');
        continue;
      }
      kept.push({ ...c, userId, workspaceId, role, user });
    }

    await this.loadPlans(kept.map((k) => (k.workspaceId ? `workspace:${k.workspaceId}` : k.userId ? `user:${k.userId}` : null)));

    const rows: Row[] = kept.map((k) => {
      const receivedAt = new Date(Date.parse(k.ev.receivedAt) || Date.now());
      const { ts, corrected } = clampEventTime(k.ev.occurredAt, receivedAt);
      const plan = k.workspaceId ? this.plans.get(`workspace:${k.workspaceId}`) : k.userId ? this.plans.get(`user:${k.userId}`) : undefined;
      const platform = (ANALYTICS_PLATFORMS as readonly string[]).includes(k.ev.platform) ? k.ev.platform : 'web';
      const internal = !!k.userId && (staff.has(k.userId) || (!!k.user && env.internalPhonePrefixes.some((p) => k.user!.phone.startsWith(p))));
      return {
        eventId: k.ev.eventId.toLowerCase(),
        ts,
        occurredAt: new Date(Date.parse(k.ev.occurredAt) || ts.getTime()),
        receivedAt,
        corrected,
        key: k.ev.key,
        service: this.serviceOf(k.ev.key, k.def, k.props),
        cls: ANALYTICS_CLASS_CODE[k.def.class],
        source: ANALYTICS_SOURCE_CODE[analyticsSourceOf(platform as (typeof ANALYTICS_PLATFORMS)[number])],
        userId: k.userId,
        anonymousId: uuidOrNull(k.ev.anonymousId),
        workspaceId: k.workspaceId,
        owner: k.workspaceId ? ANALYTICS_OWNER_CODE.workspace : k.userId ? ANALYTICS_OWNER_CODE.personal : ANALYTICS_OWNER_CODE.anonymous,
        sessionId: uuidOrNull(k.ev.sessionId),
        deviceId: uuidOrNull(k.ev.deviceId),
        loginSid: uuidOrNull(k.ev.loginSid),
        planKey: plan?.planKey ?? null,
        planVersion: plan?.planVersion ?? null,
        role: k.role ? String(k.role).slice(0, 32) : null,
        platform,
        appVersion: k.ev.appVersion ? String(k.ev.appVersion).slice(0, 32) : null,
        deviceClass: typeof k.ev.deviceClass === 'number' ? k.ev.deviceClass : null,
        os: k.ev.os ? String(k.ev.os).slice(0, 16) : null,
        browser: k.ev.browser ? String(k.ev.browser).slice(0, 16) : null,
        locale: k.ev.locale ? String(k.ev.locale).slice(0, 16) : null,
        tz: k.ev.tz ? String(k.ev.tz).slice(0, 64) : null,
        route: k.ev.route ? String(k.ev.route).slice(0, 256) : null,
        refType: k.ev.refType ? String(k.ev.refType).slice(0, 64) : null,
        refId: uuidOrNull(k.ev.refId),
        props: JSON.stringify(k.props),
        sampleRate: typeof k.ev.sampleRate === 'number' && k.ev.sampleRate > 0 && k.ev.sampleRate <= 1 ? k.ev.sampleRate : 1,
        internal,
        schemaVersion: k.def.version,
      };
    });

    const client: Client = tx ?? this.db;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      inserted += await this.insertChunk(client, chunk, (key) => addQ(key, 'schema', {}));
    }
    if (inserted) bump('accepted', inserted);
    if (quarantine.size) await this.writeQuarantine(client, [...quarantine.values()]);
    return { eventIds: rows.map((r) => r.eventId), times: rows.map((r) => r.ts), counters };
  }

  /** Сервис строки: у просмотра страницы — область маршрута, у прочих — владелец ключа. */
  private serviceOf(key: string, def: AnalyticsEventDef, props: Record<string, unknown>): string {
    if (key === 'navigation.page.viewed' && typeof props.service === 'string') return props.service;
    return def.service;
  }

  private async insertChunk(client: Client, chunk: Row[], onPermanent: (key: string) => void): Promise<number> {
    try {
      return await this.insertRows(client, chunk);
    } catch (err) {
      if (isMissingPartition(err)) {
        const months = new Set(chunk.map((r) => `${r.ts.getUTCFullYear()}-${r.ts.getUTCMonth()}`));
        for (const m of months) {
          const [y, mo] = m.split('-').map(Number);
          await this.partitions.ensureFor(new Date(Date.UTC(y, mo, 1)));
        }
        return this.insertRows(client, chunk);
      }
      // Внутри чужой транзакции (outbox) ошибка уже абортила её — только наверх;
      // не ошибка данных (связь, баг кода) — тоже наверх: без ack, событие не теряется
      if (client !== this.db || !isPoisonCandidate(err)) throw err;
      // Постоянная ошибка данных в пачке: вставляем по одной, виновные — в карантин
      let n = 0;
      for (const row of chunk) {
        try {
          n += await this.insertRows(client, [row]);
        } catch (rowErr) {
          if (!isPoisonCandidate(rowErr)) throw rowErr;
          onPermanent(row.key);
          this.logger.warn(`analytics row rejected by the database (${row.key}): ${rowErr instanceof Error ? rowErr.message.slice(0, 200) : ''}`);
        }
      }
      return n;
    }
  }

  /**
   * Пачка — ОДНИМ типизированным параметром через `jsonb_to_recordset`: список колонок
   * задаёт типы явно. Параллельные массивы (`unnest($1::uuid[], …)`) здесь ломаются —
   * Prisma отдаёт массив из одних NULL как `integer[]`, и приведение к `uuid[]` падает.
   */
  private async insertRows(client: Client, rows: Row[]): Promise<number> {
    const records = rows.map((r) => ({
      event_id: r.eventId,
      ts: r.ts.toISOString(),
      occurred_at: r.occurredAt.toISOString(),
      received_at: r.receivedAt.toISOString(),
      time_corrected: r.corrected,
      event_key: r.key,
      service: r.service,
      class: r.cls,
      source: r.source,
      user_id: r.userId,
      anonymous_id: r.anonymousId,
      workspace_id: r.workspaceId,
      owner_type: r.owner,
      session_id: r.sessionId,
      device_id: r.deviceId,
      login_sid: r.loginSid,
      plan_key: r.planKey,
      plan_version: r.planVersion,
      role: r.role,
      platform: r.platform,
      app_version: r.appVersion,
      device_class: r.deviceClass,
      os: r.os,
      browser: r.browser,
      locale: r.locale,
      tz: r.tz,
      route: r.route,
      ref_type: r.refType,
      ref_id: r.refId,
      props: JSON.parse(r.props) as unknown,
      sample_rate: r.sampleRate,
      is_internal: r.internal,
      schema_version: r.schemaVersion,
      ingest_version: ANALYTICS_INGEST_VERSION,
    }));
    return client.$executeRaw`
      INSERT INTO analytics.events (
        event_id, ts, occurred_at, received_at, time_corrected, event_key, service, class, source,
        user_id, anonymous_id, workspace_id, owner_type, session_id, device_id, login_sid,
        plan_key, plan_version, role, platform, app_version, device_class, os, browser, locale, tz,
        route, ref_type, ref_id, props, sample_rate, is_internal, schema_version, ingest_version
      )
      SELECT
        event_id, ts, occurred_at, received_at, time_corrected, event_key, service, class, source,
        user_id, anonymous_id, workspace_id, owner_type, session_id, device_id, login_sid,
        plan_key, plan_version, role, platform, app_version, device_class, os, browser, locale, tz,
        route, ref_type, ref_id, COALESCE(props, '{}'::jsonb), sample_rate, is_internal, schema_version, ingest_version
      FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS r(
        event_id uuid, ts timestamptz, occurred_at timestamptz, received_at timestamptz, time_corrected boolean,
        event_key text, service text, class smallint, source smallint,
        user_id uuid, anonymous_id uuid, workspace_id uuid, owner_type smallint,
        session_id uuid, device_id uuid, login_sid uuid,
        plan_key text, plan_version integer, role text, platform text, app_version text,
        device_class smallint, os text, browser text, locale text, tz text,
        route text, ref_type text, ref_id uuid, props jsonb, sample_rate real, is_internal boolean,
        schema_version smallint, ingest_version smallint
      )
      ON CONFLICT (event_id, ts) DO NOTHING`;
  }

  private async writeQuarantine(
    client: Client,
    items: Array<{ key: string; reason: AnalyticsQuarantineReason; count: number; shape: Record<string, string> }>,
  ): Promise<void> {
    const now = new Date();
    for (const q of items) {
      await client.$executeRaw`
        INSERT INTO analytics_quarantine (id, event_key, reason, count, first_seen_at, last_seen_at, sample_shape)
        VALUES (${uuidv7()}::uuid, ${q.key}, ${q.reason}, ${q.count}, ${utcTs(now)}, ${utcTs(now)}, ${JSON.stringify(q.shape)}::jsonb)
        ON CONFLICT (event_key, reason) DO UPDATE SET
          count = analytics_quarantine.count + EXCLUDED.count,
          last_seen_at = EXCLUDED.last_seen_at,
          sample_shape = EXCLUDED.sample_shape`;
    }
  }

  /** Дни (в поясе платформы), куда легли события, — пересчитает роллап-крон. */
  private async markDirty(times: Date[], timezone: string): Promise<void> {
    const days = new Set(times.map((t) => dayInZone(t, timezone)));
    try {
      await this.redis.getClient().sadd(ANALYTICS_REDIS.dirtyDays, ...days);
    } catch {
      /* ночной пересчёт последних 7 дней — второй ремень */
    }
  }

  // ============================================================
  // Кэши обогащения
  // ============================================================

  private async loadOverrides(): Promise<Map<string, string>> {
    if (Date.now() - this.overrides.at < 30_000) return this.overrides.map;
    const rows = await this.db.analyticsEventOverride.findMany({ select: { eventKey: true, status: true } });
    this.overrides = { at: Date.now(), map: new Map(rows.map((r) => [r.eventKey, r.status])) };
    return this.overrides.map;
  }

  /** Сбросить кэш рубильника (после команды кабинета на этом инстансе). */
  invalidateOverrides(): void {
    this.overrides.at = 0;
  }

  private async loadStaff(): Promise<Set<string>> {
    if (Date.now() - this.staff.at < 60_000) return this.staff.set;
    const rows = await this.db.platformStaff.findMany({ where: { status: 'active' }, select: { userId: true } });
    this.staff = { at: Date.now(), set: new Set(rows.map((r) => r.userId)) };
    return this.staff.set;
  }

  private async loadUsers(ids: string[]): Promise<Map<string, UserInfo | null>> {
    const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
    const out = new Map<string, UserInfo | null>();
    const missing: string[] = [];
    for (const id of unique) {
      const hit = this.users.get(id);
      if (hit !== undefined) out.set(id, hit);
      else missing.push(id);
    }
    if (missing.length) {
      const rows = await this.db.user.findMany({
        where: { id: { in: missing } },
        select: { id: true, phone: true, deletedAt: true, analyticsOptOut: true },
      });
      const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
      for (const id of missing) {
        const r = byId.get(id);
        const info = r ? { phone: r.phone, deleted: !!r.deletedAt, optOut: r.analyticsOptOut } : null;
        this.users.set(id, info);
        out.set(id, info);
      }
    }
    // Свежий тумблер человека (Redis, TTL 5 мин) сильнее минутного кэша
    if (unique.length) {
      try {
        const flags = await this.redis.getClient().mget(...unique.map((id) => ANALYTICS_REDIS.optOut(id)));
        unique.forEach((id, i) => {
          const info = out.get(id);
          if (info && flags[i] !== null) info.optOut = flags[i] === '1';
        });
      } catch {
        /* остаётся значение из БД */
      }
    }
    return out;
  }

  private async loadMemberships(pairs: Array<{ userId: string | null; workspaceId: string | null }>): Promise<void> {
    const todo = new Map<string, { userId: string; workspaceId: string }>();
    for (const p of pairs) {
      if (!isUuid(p.userId) || !isUuid(p.workspaceId)) continue;
      const key = `${p.userId}:${p.workspaceId}`;
      if (this.membership.get(key) === undefined) todo.set(key, { userId: p.userId, workspaceId: p.workspaceId });
    }
    const rank: Record<string, number> = WORKSPACE_ROLE_RANK;
    await mapLimit([...todo.entries()], ENRICH_CONCURRENCY, async ([key, p]) => {
      const roles = await this.roles.getRolesInContext(p.userId, 'workspace', p.workspaceId);
      const top = roles.map((r) => r.role).sort((a, b) => (rank[b] ?? 0) - (rank[a] ?? 0))[0] ?? null;
      this.membership.set(key, top);
    });
  }

  /** Снимок тарифа субъекта (живая подписка) — в событие, а не join «текущего». */
  private async loadPlans(subjects: Array<string | null>): Promise<void> {
    const todo = [...new Set(subjects.filter((s): s is string => !!s))].filter((s) => this.plans.get(s) === undefined);
    await mapLimit(todo, ENRICH_CONCURRENCY, async (s) => {
      const [type, id] = s.split(':') as ['user' | 'workspace', string];
      try {
        const sub = await this.entitlements.liveSubscriptionOf({ type, id });
        this.plans.set(s, { planKey: sub?.planVersion.plan.key ?? null, planVersion: sub?.planVersion.version ?? null });
      } catch {
        this.plans.set(s, { planKey: null, planVersion: null });
      }
    });
  }
}
