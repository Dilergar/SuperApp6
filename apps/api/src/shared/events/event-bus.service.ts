import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Subject, filter, Observable } from 'rxjs';
import type Redis from 'ioredis';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

/**
 * Cross-module event bus, backed by a Redis Stream + consumer group.
 *
 * Why Redis instead of an in-memory RxJS Subject: with more than one API
 * instance, an in-process Subject only delivers events to subscribers living
 * in the SAME process — events emitted on instance A are invisible to
 * listeners on instance B. That silently breaks notifications, task→calendar
 * fan-out, etc. under horizontal scaling.
 *
 * Design:
 *   - emit()  → XADD onto a single capped stream (fire-and-forget).
 *   - Each instance runs ONE consumer in a shared consumer group, so every
 *     event is handled by EXACTLY ONE instance (competing consumers — no
 *     duplicate side-effects across the cluster).
 *   - The consuming instance re-publishes the event onto a local RxJS Subject,
 *     so on()/onPattern() subscribers keep working unchanged.
 *   - XAUTOCLAIM reclaims messages stranded by a crashed/restarted instance.
 *
 * Delivery is at-least-once at the stream level, but handlers are dispatched
 * fire-and-forget (matching the previous in-memory semantics): a throwing
 * handler neither blocks nor replays the event.
 */

const STREAM = 'superapp:events';
const GROUP = 'superapp:workers';
// Approximate cap so the stream can't grow unbounded. Deliberately generous: entries are
// small JSONs (100k ≈ tens of MB), and MAXLEN trims UNREAD entries too — a low cap would
// silently drop the tail during a consumer backlog spike. maybeWarnLag() below surfaces
// such a backlog in the logs long before the cap becomes a data-loss risk.
const MAXLEN = 100_000;
const BLOCK_MS = 5000;
const BATCH = 20;
const CLAIM_IDLE_MS = 60_000; // reclaim messages idle longer than this
const LAG_CHECK_INTERVAL_MS = 5 * 60_000; // how often to sample group lag
const LAG_WARN_THRESHOLD = 1000; // pending entries that count as "falling behind"

export interface AppEvent {
  type: string;
  payload: Record<string, unknown>;
  emittedBy: string; // module name
  timestamp: Date;
}

@Injectable()
export class EventBusService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(EventBusService.name);
  private readonly eventStream = new Subject<AppEvent>();
  private readonly consumerName = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

  private consumer: Redis | null = null;
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(private readonly redis: RedisService) {}

  // Start consuming only AFTER every module's onModuleInit ran, so all
  // on()/onPattern() listeners are already subscribed and no early event is
  // dispatched into the void.
  async onApplicationBootstrap(): Promise<void> {
    // Dedicated connection: XREADGROUP blocks, so it must not share the
    // connection used for normal commands. maxRetriesPerRequest=null is the
    // recommended setting for blocking reads.
    this.consumer = this.redis.getClient().duplicate({
      maxRetriesPerRequest: null,
    });
    this.running = true;
    await this.ensureGroup();
    this.loop = this.consumeLoop();
    this.logger.log(`EventBus consuming as "${this.consumerName}"`);
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    // Force-unblock a pending XREADGROUP so the loop exits promptly.
    this.consumer?.disconnect();
    try {
      await this.loop;
    } catch {
      /* loop already torn down */
    }
  }

  /** Emit an event to the whole cluster. Fire-and-forget (never blocks caller). */
  emit(
    type: string,
    payload: Record<string, unknown>,
    emittedBy: string,
  ): void {
    const event: AppEvent = { type, payload, emittedBy, timestamp: new Date() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.redis.getClient() as any)
      .xadd(STREAM, 'MAXLEN', '~', MAXLEN, '*', 'data', JSON.stringify(event))
      .catch((err: unknown) =>
        this.logger.error(
          `Failed to publish ${type}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  /** Subscribe to events of a specific type. */
  on(eventType: string): Observable<AppEvent> {
    return this.eventStream.pipe(filter((event) => event.type === eventType));
  }

  /** Subscribe to all events matching a pattern (e.g. 'task.*'). */
  onPattern(pattern: string): Observable<AppEvent> {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return this.eventStream.pipe(filter((event) => regex.test(event.type)));
  }

  // ------------------------------------------------------------
  // Consumer internals
  // ------------------------------------------------------------

  // ioredis stream-command overloads are awkward to satisfy with variadic
  // args; this typed escape hatch keeps the call sites readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get c(): any {
    return this.consumer;
  }

  private async ensureGroup(): Promise<void> {
    try {
      // '$' = only deliver events added AFTER the group is created; we never
      // want to replay historical side-effects on startup.
      await this.c.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('BUSYGROUP')) {
        this.logger.warn(`xgroup CREATE failed: ${msg}`);
      }
    }
  }

  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.reclaimStale();
        await this.maybeWarnLag();

        const res = (await this.c.xreadgroup(
          'GROUP',
          GROUP,
          this.consumerName,
          'COUNT',
          BATCH,
          'BLOCK',
          BLOCK_MS,
          'STREAMS',
          STREAM,
          '>',
        )) as [string, [string, string[]][]][] | null;

        if (!res) continue; // BLOCK timed out — loop again

        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            this.dispatch(fields);
            await this.c.xack(STREAM, GROUP, id);
          }
        }
      } catch (err) {
        if (!this.running) break; // disconnect() during shutdown
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('NOGROUP')) {
          await this.ensureGroup();
          continue;
        }
        this.logger.error(`consume loop error: ${msg}`);
        await new Promise((r) => setTimeout(r, 1000)); // backoff
      }
    }
  }

  private lastLagCheck = 0;

  /**
   * Streams-гигиена: раз в LAG_CHECK_INTERVAL_MS сэмплируем лаг consumer-группы.
   * Молчаливое отставание (события копятся в pending / стрим растёт к MAXLEN-обрезке)
   * должно быть видно в логах ДО того, как хвост потеряется.
   */
  private async maybeWarnLag(): Promise<void> {
    const now = Date.now();
    if (now - this.lastLagCheck < LAG_CHECK_INTERVAL_MS) return;
    this.lastLagCheck = now;
    try {
      const pendingRes = (await this.c.xpending(STREAM, GROUP)) as [number, ...unknown[]] | null;
      const pending = pendingRes?.[0] ?? 0;
      const streamLen = (await this.c.xlen(STREAM)) as number;
      if (pending >= LAG_WARN_THRESHOLD || streamLen >= MAXLEN * 0.8) {
        this.logger.warn(
          `EventBus lag: pending=${pending}, stream len=${streamLen}/${MAXLEN} — consumers falling behind, tail loss possible at cap`,
        );
      }
    } catch {
      /* диагностика — не критично */
    }
  }

  /** Reclaim messages left pending by a crashed/restarted instance. */
  private async reclaimStale(): Promise<void> {
    try {
      const res = (await this.c.xautoclaim(
        STREAM,
        GROUP,
        this.consumerName,
        CLAIM_IDLE_MS,
        '0',
        'COUNT',
        BATCH,
      )) as [string, [string, string[]][], string[]?] | null;
      const entries = res?.[1] ?? [];
      for (const [id, fields] of entries) {
        if (!fields) continue; // tombstone for a since-deleted message
        this.dispatch(fields);
        await this.c.xack(STREAM, GROUP, id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('NOGROUP')) {
        this.logger.warn(`xautoclaim failed: ${msg}`);
      }
    }
  }

  /** Parse a stream entry (["data", "<json>"]) and re-publish it locally. */
  private dispatch(fields: string[]): void {
    const i = fields.indexOf('data');
    if (i === -1) return;
    try {
      const raw = JSON.parse(fields[i + 1]) as AppEvent;
      this.eventStream.next({ ...raw, timestamp: new Date(raw.timestamp) });
    } catch (err) {
      this.logger.error(
        `Failed to parse event: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
