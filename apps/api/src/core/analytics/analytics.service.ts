import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  ANALYTICS_LIMITS,
  type AnalyticsIdentifyResultDto,
  type AnalyticsPropsOf,
  type AnalyticsServerEventKey,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { DryRun } from '../../shared/context/dry-run.context';
import { JobsService } from '../jobs/jobs.service';
import {
  ANALYTICS_JOBS,
  ANALYTICS_REDIS,
  ANALYTICS_STREAM,
  analyticsEnv,
  type AnalyticsCounter,
  type AnalyticsIngestEvent,
  type AnalyticsStreamEntry,
} from './analytics.constants';
import { isUuid, uaForAnalytics, uuidOrNull } from './analytics.enrich';

type Tx = Prisma.TransactionClient;

export interface AnalyticsTrackOptions {
  /** Человек-актор. По умолчанию — из контекста запроса; `null` — без личности (гость). */
  userId?: string | null;
  /** Организация. По умолчанию — проверенная chokepoint'ом из контекста; `null` — личное. */
  workspaceId?: string | null;
  /** Сущность, к которой относится факт (id — только uuid) */
  ref?: { type: string; id: string } | null;
  occurredAt?: Date;
}

/** Буфер событий без транзакции: сколько ждать и сколько копить до XADD. */
const FLUSH_MS = 50;
const FLUSH_MAX = 200;

/**
 * core/analytics — 21-й платформенный движок: продуктовая аналитика.
 *
 * Публичный контракт сервисов:
 *  - `track(tx, key, props, opts?)` — факт сервера. С `tx` строка ложится в
 *    `analytics.outbox` В ТРАНЗАКЦИИ мутации (откат = события нет, сеть в транзакцию
 *    не попадает); без `tx` — буфер 50 мс → XADD. Ключ и свойства проверяет компилятор
 *    (реестр `packages/shared/src/analytics/`), значения — консьюмер.
 *  - `forgetUser(tx, userId)` / `forgetWorkspace(tx, workspaceId)` — забвение на путях
 *    удаления аккаунта и организации.
 *
 * Аналитика ≠ аудит: правда «кто/что/когда» — `core/chatter`; сюда не пишется
 * свободный текст, и источником для расследований движок не служит.
 */
@Injectable()
export class AnalyticsService implements OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsService.name);
  private buffer: AnalyticsIngestEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Длина stream'а для политики сброса — сэмплируется не чаще раза в секунду */
  private streamLen = 0;
  private streamLenAt = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly ctx: WorkspaceContextService,
    private readonly jobs: JobsService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  // ============================================================
  // Серверные факты
  // ============================================================

  async track<K extends AnalyticsServerEventKey>(
    tx: Tx | null,
    key: K,
    props: AnalyticsPropsOf<K>,
    opts: AnalyticsTrackOptions = {},
  ): Promise<void> {
    // Предпросмотр команды кабинета: эффект вне отката (XADD) обязан молчать
    if (!analyticsEnv().enabled || DryRun.active()) return;
    const event = this.serverEvent(key, props as Record<string, unknown>, opts);
    if (tx) {
      await tx.$executeRaw`INSERT INTO analytics.outbox (payload) VALUES (${JSON.stringify(event)}::jsonb)`;
      return;
    }
    this.buffer.push(event);
    if (this.buffer.length >= FLUSH_MAX) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
  }

  private serverEvent(key: string, props: Record<string, unknown>, opts: AnalyticsTrackOptions): AnalyticsIngestEvent {
    const c = this.ctx.get();
    const now = new Date();
    const userId = opts.userId !== undefined ? uuidOrNull(opts.userId) : uuidOrNull(c?.userId);
    const workspaceId = opts.workspaceId !== undefined ? uuidOrNull(opts.workspaceId) : uuidOrNull(c?.activeWorkspaceId);
    const ua = uaForAnalytics(c?.client?.userAgent);
    return {
      eventId: randomUUID(),
      key,
      occurredAt: (opts.occurredAt ?? now).toISOString(),
      receivedAt: now.toISOString(),
      platform: 'server',
      appVersion: null,
      userId,
      anonymousId: null,
      workspaceId,
      claimedWorkspaceId: null,
      role: workspaceId && workspaceId === c?.activeWorkspaceId ? (c?.role ?? null) : null,
      sessionId: c?.client?.sessionId ?? null,
      deviceId: c?.client?.deviceId ?? null,
      loginSid: c?.client?.loginSid ?? null,
      deviceClass: ua.deviceClass,
      os: ua.os,
      browser: ua.browser,
      locale: c?.locale ?? null,
      tz: null,
      route: null,
      refType: opts.ref?.type ? opts.ref.type.slice(0, 64) : null,
      refId: uuidOrNull(opts.ref?.id),
      props,
      sampleRate: 1,
      gpc: false,
    };
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer.length) return;
    const events = this.buffer;
    this.buffer = [];
    await this.publish({ v: 1, events, rejects: [] });
  }

  // ============================================================
  // Приём (путь HTTP — ни одного запроса к Postgres)
  // ============================================================

  /** Одна запись stream'а на батч: XADD O(1). Ошибка Redis — потеря телеметрии, не отказ UI. */
  async publish(entry: AnalyticsStreamEntry): Promise<boolean> {
    if (!entry.events.length && !entry.rejects.length) return true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.redis.getClient() as any).xadd(ANALYTICS_STREAM, 'MAXLEN', '~', analyticsEnv().streamMaxLen, '*', 'data', JSON.stringify(entry));
      return true;
    } catch (err) {
      this.logger.error(`analytics publish failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Заполненность stream'а (0..1) для политики сброса по классам. Значение сэмплируется
   * в фоне не чаще раза в секунду: путь запроса не ждёт XLEN.
   */
  streamFill(): number {
    const now = Date.now();
    if (now - this.streamLenAt > 1000) {
      this.streamLenAt = now;
      this.redis
        .getClient()
        .xlen(ANALYTICS_STREAM)
        .then((n) => (this.streamLen = n))
        .catch(() => undefined);
    }
    return this.streamLen / analyticsEnv().streamMaxLen;
  }

  /** Счётчики приёма за сутки UTC (витрина «Качество данных»). */
  async bumpCounters(delta: Partial<Record<AnalyticsCounter, number>>): Promise<void> {
    const entries = Object.entries(delta).filter(([, n]) => (n ?? 0) > 0) as Array<[AnalyticsCounter, number]>;
    if (!entries.length) return;
    const key = ANALYTICS_REDIS.counters(new Date().toISOString().slice(0, 10));
    try {
      const p = this.redis.getClient().pipeline();
      for (const [field, n] of entries) p.hincrby(key, field, n);
      p.expire(key, 3 * 86_400);
      await p.exec();
    } catch {
      /* счётчики — диагностика */
    }
  }

  // ============================================================
  // Личность и согласие
  // ============================================================

  /**
   * Склейка «аноним → аккаунт». Первая привязка побеждает; повторная к ДРУГОМУ
   * аккаунту помечает строку `contested` и останавливает склейку по ней. Новая или
   * оспоренная связь ставит дни с событиями этого анонима (окно 30 дней) на пересчёт.
   */
  async link(anonymousId: string, userId: string, source: 'identify' | 'login'): Promise<AnalyticsIdentifyResultDto> {
    if (!isUuid(anonymousId) || !isUuid(userId)) return { linked: false, contested: false };
    const anon = anonymousId.toLowerCase();
    const created = await this.db.analyticsIdentityLink.createMany({
      data: [{ anonymousId: anon, userId, source }],
      skipDuplicates: true,
    });
    if (created.count > 0) {
      await this.markRelinkDays(anon);
      await this.track(null, 'analytics.identity.linked', { contested: false }, { userId, workspaceId: null });
      return { linked: true, contested: false };
    }
    const row = await this.db.analyticsIdentityLink.findUnique({ where: { anonymousId: anon } });
    if (!row || row.userId === userId) return { linked: false, contested: row?.contested ?? false };
    if (!row.contested) {
      const res = await this.db.analyticsIdentityLink.updateMany({
        where: { anonymousId: anon, contested: false },
        data: { contested: true, contestedAt: new Date() },
      });
      if (res.count > 0) {
        await this.markRelinkDays(anon);
        await this.track(null, 'analytics.identity.linked', { contested: true }, { userId, workspaceId: null });
      }
    }
    return { linked: false, contested: true };
  }

  /** Дни с событиями анонима в окне ретро-склейки → в набор «грязных» (пересчитает крон). */
  private async markRelinkDays(anonymousId: string): Promise<void> {
    const env = analyticsEnv();
    const since = new Date(Date.now() - ANALYTICS_LIMITS.identityRelinkDays * 86_400_000);
    try {
      const rows = await this.db.$queryRaw<Array<{ day: string }>>`
        SELECT DISTINCT to_char(ts AT TIME ZONE ${env.timezone}, 'YYYY-MM-DD') AS day
        FROM analytics.events
        WHERE anonymous_id = ${anonymousId}::uuid AND ts >= ${since.toISOString()}::timestamptz`;
      if (rows.length) await this.redis.getClient().sadd(ANALYTICS_REDIS.dirtyDays, ...rows.map((r) => r.day));
    } catch (err) {
      this.logger.warn(`relink days for an anonymous id: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getOptOut(userId: string): Promise<boolean> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { analyticsOptOut: true } });
    return u?.analyticsOptOut ?? false;
  }

  /**
   * Отказ человека от аналитики использования. ПРАВДА — движок согласий (`core/consents`, вид
   * `analytics`, режим opt-out); `users.analytics_opt_out` — её ЗЕРКАЛО, которое читает приём
   * событий. Поэтому своей двери записи у аналитики нет: зеркало ставит `ConsentsService`
   * в транзакции приёмки/отзыва через `applyOptOut(tx, …)`, а после коммита зовёт `publishOptOut`.
   * Отказ применяется НА СЕРВЕРЕ при приёме (product/telemetry не пишутся); факт смены —
   * business-событие в той же транзакции.
   */
  async applyOptOut(tx: Tx, userId: string, optOut: boolean): Promise<void> {
    await tx.user.update({ where: { id: userId }, data: { analyticsOptOut: optOut } });
    await this.track(tx, 'analytics.consent.changed', { optOut }, { userId, workspaceId: null });
  }

  /** После коммита: кэш отказа в Redis, чтобы консьюмер увидел его без минутной задержки. */
  async publishOptOut(userId: string, optOut: boolean): Promise<void> {
    try {
      await this.redis.set(ANALYTICS_REDIS.optOut(userId), optOut ? '1' : '0', 300);
    } catch {
      /* консьюмер дочитает из БД */
    }
  }

  // ============================================================
  // Забвение (оба пути удаления: аккаунт и организация)
  // ============================================================

  /**
   * В транзакции анонимизации аккаунта: агрегаты по человеку уходят сразу, сырьё
   * (партиции, миллионы строк) — джобом батчами с повторным проходом (события, уже
   * летевшие в очереди, догоняются). Ссылки «аноним → аккаунт» удаляет джоб ПОСЛЕ
   * событий этих анонимов.
   */
  async forgetUser(tx: Tx, userId: string): Promise<void> {
    if (!isUuid(userId)) return;
    await tx.analyticsRollupActorDay.deleteMany({ where: { actorId: userId } });
    await this.jobs.enqueue(tx, { type: ANALYTICS_JOBS.userErase, payload: { userId, pass: 1 }, uniqueKey: `erase:user:${userId}:1` });
  }

  /** В транзакции purge организации: роллапы с её измерением — сразу, сырьё — джобом. */
  async forgetWorkspace(tx: Tx, workspaceId: string): Promise<void> {
    if (!isUuid(workspaceId)) return;
    await tx.analyticsRollupActorDay.deleteMany({ where: { workspaceId } });
    await tx.analyticsRollupEventDay.deleteMany({ where: { workspaceId } });
    await tx.analyticsRollupSessionDay.deleteMany({ where: { workspaceId } });
    await this.jobs.enqueue(tx, {
      type: ANALYTICS_JOBS.workspaceErase,
      payload: { workspaceId, pass: 1 },
      uniqueKey: `erase:workspace:${workspaceId}:1`,
    });
  }
}
