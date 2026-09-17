import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Observable, tap } from 'rxjs';
import { KEYS_ERROR_CODES, KEYS_LIMITS, KEYS_REDIS, routeTemplateOf } from '@superapp/shared';
import { DatabaseService } from '../../../shared/database/database.service';
import { MonthlyPartitions } from '../../../shared/database/monthly-partitions';
import { tooMany } from '../../../shared/errors/api-error';
import { RedisService } from '../../../shared/redis/redis.service';
import type { JwtPayload } from '../../../shared/decorators/current-user.decorator';
import { AnalyticsService } from '../../analytics/analytics.service';
import { KeysNotifier } from './keys.notifications';

const ACCESS_LOG_LIST = 'keys:access-log';
const ACCESS_LOG_MAX = 50_000;

/**
 * Использование ключей без write amplification: `last_used_at`/`use_count` батчем из Redis
 * раз в минуту; журнал обращений `api_access_log` — списком в Redis, слив батчем в месячные
 * партиции; ежедневно — уведомления об истечении (14 и 1 день, одно на порог), `key.expired`,
 * ретеншн журнала сбросом партиций старше `accessLogRetentionDays`; суточный потолок выгрузки
 * строк одним ключом (`exportRowsPerDay`) — счётчик в Redis.
 */
@Injectable()
export class KeysUsageCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(KeysUsageCron.name);
  /** Месячные партиции `api_access_log` (прецедент analytics.events) */
  readonly partitions: MonthlyPartitions;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly analytics: AnalyticsService,
    private readonly notifier: KeysNotifier,
  ) {
    this.partitions = new MonthlyPartitions(db, { table: 'api_access_log', column: 'at', retentionDays: KEYS_LIMITS.accessLogRetentionDays });
  }

  /** Партиции на месяцы вперёд — на старте (best-effort, под замком: инстансов много). */
  async onApplicationBootstrap(): Promise<void> {
    await this.redis
      .withLock('cron:keys:access-partitions', 60_000, () => this.partitions.ensureAhead())
      .catch((err: unknown) => this.logger.error(`api_access_log partitions on boot: ${err instanceof Error ? err.message : String(err)}`));
  }

  // ---- Суточный потолок выгрузки строк одним ключом (аномалия объёма) ----

  private static dayKey(now = new Date()): string {
    return now.toISOString().slice(0, 10);
  }

  /** Сколько строк списков ключ выгрузил сегодня (UTC). */
  async exportRowsToday(keyId: string): Promise<number> {
    try {
      return Number((await this.redis.get(KEYS_REDIS.exportRows(keyId, KeysUsageCron.dayKey()))) ?? 0);
    } catch {
      return 0;
    }
  }

  /** Зачесть выгруженные строки; первое пересечение потолка за сутки — уведомление `key.throttled`. */
  async countExport(keyId: string, rows: number): Promise<void> {
    if (rows <= 0) return;
    try {
      const client = this.redis.getClient();
      const key = KEYS_REDIS.exportRows(keyId, KeysUsageCron.dayKey());
      const total = await client.incrby(key, rows);
      if (total === rows) await client.expire(key, 2 * 86_400);
      if (total >= KEYS_LIMITS.exportRowsPerDay && total - rows < KEYS_LIMITS.exportRowsPerDay) {
        void this.notifier.throttled(keyId, 'export').catch(() => undefined);
      }
    } catch {
      /* best-effort */
    }
  }

  /** Секунд до конца суток UTC — `resendInSec` в 429. */
  static secondsToUtcMidnight(now = new Date()): number {
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async flushUsage(): Promise<void> {
    await this.redis.withLock('cron:keys:usage', 55_000, async () => {
      await this.flushLastUsed();
      await this.flushAccessLog();
    });
  }

  async flushLastUsed(): Promise<number> {
    const client = this.redis.getClient();
    const all = await client.hgetall(KEYS_REDIS.lastUsed);
    const ids = Object.keys(all);
    if (!ids.length) return 0;
    // Снимаем поля ДО записи: новые обращения за время слива попадут в следующий батч
    await client.hdel(KEYS_REDIS.lastUsed, ...ids);
    let n = 0;
    for (const id of ids) {
      try {
        const v = JSON.parse(all[id]!) as { at: string; ip: string | null; country?: string | null; n: number; first?: boolean };
        const row = await this.db.apiKey.findUnique({ where: { id }, select: { id: true, kind: true, userId: true, workspaceId: true, lastUsedAt: true, bot: { select: { workspaceId: true, userId: true } } } });
        if (!row) continue;
        await this.db.apiKey.update({ where: { id }, data: { lastUsedAt: new Date(v.at), lastUsedIp: v.ip, lastUsedCountry: v.country ?? null, useCount: { increment: v.n } } });
        if (!row.lastUsedAt) {
          await this.analytics.track(null, 'keys.key.first_used', { kind: row.kind }, { userId: row.userId ?? row.bot?.userId ?? undefined, workspaceId: row.bot?.workspaceId ?? row.workspaceId });
        }
        n++;
      } catch (err) {
        this.logger.warn(`usage flush ${id}: ${(err as Error).message}`);
      }
    }
    return n;
  }

  /** Строка журнала обращений — в Redis-список (интерцептор), батчем в БД. */
  async record(entry: { keyId: string; method: string; route: string; status: number; ip: string | null }): Promise<void> {
    try {
      const client = this.redis.getClient();
      const len = await client.rpush(ACCESS_LOG_LIST, JSON.stringify({ ...entry, at: new Date().toISOString() }));
      if (len > ACCESS_LOG_MAX) await client.ltrim(ACCESS_LOG_LIST, -ACCESS_LOG_MAX, -1);
    } catch {
      /* best-effort */
    }
  }

  async flushAccessLog(): Promise<number> {
    const client = this.redis.getClient();
    const raw = await client.lrange(ACCESS_LOG_LIST, 0, 4999);
    if (!raw.length) return 0;
    await client.ltrim(ACCESS_LOG_LIST, raw.length, -1);
    const rows = raw
      .map((r) => {
        try {
          return JSON.parse(r) as { keyId: string; method: string; route: string; status: number; ip: string | null; at: string };
        } catch {
          return null;
        }
      })
      .filter((r): r is NonNullable<typeof r> => !!r);
    if (!rows.length) return 0;
    const data = rows.map((r) => ({ keyId: r.keyId, method: r.method, route: r.route, status: r.status, ip: r.ip, at: new Date(r.at) }));
    try {
      await this.db.apiAccessLog.createMany({ data });
    } catch (err) {
      // Месяц без партиции (крон не успел) — завести и повторить один раз
      if (!MonthlyPartitions.isMissingPartition(err)) throw err;
      for (const r of data) await this.partitions.ensureFor(r.at);
      await this.db.apiAccessLog.createMany({ data });
    }
    return rows.length;
  }

  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async daily(): Promise<void> {
    await this.redis.withLock('cron:keys:daily-usage', 600_000, async () => {
      await this.partitions.ensureAhead();
      await this.notifyExpiring();
      await this.retention();
    });
  }

  /** За 14 и за 1 день (одно уведомление на порог — idempotencyKey), истёкшие — один раз. */
  async notifyExpiring(): Promise<number> {
    const now = Date.now();
    let sent = 0;
    for (const days of KEYS_LIMITS.expiringNoticeDays) {
      const until = new Date(now + days * 86_400_000);
      const rows = await this.db.apiKey.findMany({
        where: { revokedAt: null, expiresAt: { gt: new Date(now), lte: until } },
        select: { id: true, name: true, userId: true, workspaceId: true, expiresAt: true, bot: { select: { workspaceId: true } } },
        take: 1000,
      });
      for (const k of rows) {
        const left = Math.max(1, Math.ceil((k.expiresAt!.getTime() - now) / 86_400_000));
        if (left > days) continue;
        await this.notifier.keyEvent(null, 'key.expiring', { id: k.id, name: k.name, userId: k.userId, workspaceId: k.bot?.workspaceId ?? k.workspaceId }, { days: left }, { idempotencyKey: `key.expiring:${k.id}:${days}` });
        sent++;
      }
    }
    const expired = await this.db.apiKey.findMany({
      where: { revokedAt: null, expiresAt: { lte: new Date(now), gt: new Date(now - 2 * 86_400_000) } },
      select: { id: true, name: true, userId: true, workspaceId: true, bot: { select: { workspaceId: true } } },
      take: 1000,
    });
    for (const k of expired) {
      await this.notifier.keyEvent(null, 'key.expired', { id: k.id, name: k.name, userId: k.userId, workspaceId: k.bot?.workspaceId ?? k.workspaceId }, {}, { idempotencyKey: `key.expired:${k.id}` });
      sent++;
    }
    return sent;
  }

  /** Ретеншн — сброс партиций месяцев старше `accessLogRetentionDays`; возвращает число сброшенных. */
  async retention(): Promise<number> {
    const dropped = await this.partitions.dropExpired();
    if (dropped.length) this.logger.log(`api_access_log retention: dropped ${dropped.join(', ')}`);
    return dropped.length;
  }
}

/** Сколько строк списка вернул ответ: `data` — массив либо `data.items` — массив (CursorPage/OffsetPage). */
function rowsOf(body: unknown): number {
  if (!body || typeof body !== 'object') return 0;
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) return (data as { items: unknown[] }).items.length;
  return 0;
}

/**
 * Глобальный интерцептор: обращение ключом → строка журнала (метод, шаблон маршрута
 * без id, статус, IP) через Redis; чтения — под суточным потолком выгрузки строк
 * (`exportRowsPerDay`: потолок достигнут → `429 keys.export_cap` до конца суток UTC).
 * Живых сессий не касается.
 */
@Injectable()
export class ApiKeyAccessInterceptor implements NestInterceptor {
  constructor(private readonly usage: KeysUsageCron) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<{ user?: JwtPayload; method: string; path?: string; originalUrl?: string; ip?: string }>();
    const keyId = req?.user?.keyId;
    if (!keyId) return next.handle();
    const res = context.switchToHttp().getResponse<{ statusCode?: number }>();
    const route = routeTemplateOf((req.path ?? req.originalUrl ?? '').replace(/^\/api(?:\/v1)?/, ''));
    const record = (status: number) => void this.usage.record({ keyId, method: req.method, route, status, ip: req.ip ?? null });
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (isRead && (await this.usage.exportRowsToday(keyId)) >= KEYS_LIMITS.exportRowsPerDay) {
      record(429);
      throw tooMany('keys.export_cap', undefined, { code: KEYS_ERROR_CODES.exportCap, resendInSec: KeysUsageCron.secondsToUtcMidnight() });
    }
    return next.handle().pipe(
      tap({
        next: (body) => {
          record(res.statusCode ?? 200);
          if (isRead) void this.usage.countExport(keyId, rowsOf(body));
        },
        error: (err: { status?: number }) => record(typeof err?.status === 'number' ? err.status : 500),
      }),
    );
  }
}
