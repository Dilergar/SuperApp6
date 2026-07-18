import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DI_TOKENS } from '../../shared/di-tokens';
import { RedisService } from '../../shared/redis/redis.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { DatabaseService } from '../../shared/database/database.service';
import { ContactsService } from '../contacts/contacts.service';
import { PRESENCE } from '@superapp/shared';
import type { PresenceInfo, ContextualStatus } from '@superapp/shared';
import type { CalendarService } from '../calendar/calendar.service';

/** Cached current-event snapshot for a target (shared across viewers). */
type CtxSnapshot = { title: string; endTime: string } | null;

/**
 * Presence (online/offline + last-seen) + contextual calendar status for the messenger.
 *
 * "Online" is a live socket connection, tracked in Redis (multi-instance safe; the gateway
 * uses @socket.io/redis-adapter). Key `presence:<userId>` holds a connection COUNT with a
 * short TTL refreshed by the client heartbeat; `presence:<userId>:lastSeen` records the last
 * disconnect. Privacy honors User.onlineStatusMode + CardVisibility.onlineStatus and requires
 * the viewer to be in the target's Окружение (no public presence); a viewer whose OWN mode is
 * 'nobody' sees no one online (reciprocity). Contextual status inherits the viewer's calendar
 * access level (busy<detailed) via CalendarService (resolved lazily via ModuleRef to avoid the
 * MessengerModule↔CalendarModule↔TasksModule cycle).
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger('PresenceService');
  private calendarRef: CalendarService | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly events: EventBusService,
    private readonly db: DatabaseService,
    private readonly contacts: ContactsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ============================================================
  // Keys
  // ============================================================
  private key(userId: string): string {
    return `presence:${userId}`;
  }
  private lastSeenKey(userId: string): string {
    return `presence:${userId}:lastSeen`;
  }
  private ctxKey(userId: string): string {
    return `presence:${userId}:ctx`;
  }

  /** Lazily resolve CalendarService (no module import → no DI cycle). */
  private calendar(): CalendarService | null {
    if (this.calendarRef) return this.calendarRef;
    try {
      this.calendarRef = this.moduleRef.get<CalendarService>(DI_TOKENS.CalendarService, {
        strict: false,
      });
    } catch {
      this.calendarRef = null;
    }
    return this.calendarRef;
  }

  // ============================================================
  // Connection lifecycle (called by the gateway)
  // ============================================================

  /** A socket connected: bump the connection count and (re)arm the TTL. */
  async onConnect(userId: string): Promise<void> {
    try {
      const c = this.redis.getClient();
      await c.multi().incr(this.key(userId)).expire(this.key(userId), PRESENCE.PRESENCE_TTL_SECONDS).exec();
    } catch (e) {
      this.logger.error(`onConnect ${userId} failed`, e as Error);
    }
  }

  /** Heartbeat: refresh the TTL; if the key has expired/been lost, recreate it. */
  async heartbeat(userId: string): Promise<void> {
    try {
      const c = this.redis.getClient();
      const ok = await c.expire(this.key(userId), PRESENCE.PRESENCE_TTL_SECONDS);
      // ioredis EXPIRE returns 1 if the key existed, 0 if it did not.
      if (ok === 0) {
        await c.multi().incr(this.key(userId)).expire(this.key(userId), PRESENCE.PRESENCE_TTL_SECONDS).exec();
      }
    } catch (e) {
      this.logger.error(`heartbeat ${userId} failed`, e as Error);
    }
  }

  /** A socket disconnected: decrement; on reaching zero, drop the key + record last-seen. */
  async onDisconnect(userId: string): Promise<void> {
    try {
      const c = this.redis.getClient();
      const n = await c.decr(this.key(userId));
      if (n <= 0) {
        await c.del(this.key(userId)); // also clears a stray negative
        await c.set(
          this.lastSeenKey(userId),
          new Date().toISOString(),
          'EX',
          PRESENCE.LAST_SEEN_TTL_SECONDS,
        );
      }
    } catch (e) {
      this.logger.error(`onDisconnect ${userId} failed`, e as Error);
    }
  }

  // ============================================================
  // Reads
  // ============================================================
  async isOnline(userId: string): Promise<boolean> {
    const v = await this.redis.get(this.key(userId));
    return !!v && Number(v) > 0;
  }

  async getLastSeen(userId: string): Promise<string | null> {
    return this.redis.get(this.lastSeenKey(userId));
  }

  /**
   * Per-viewer presence for a set of targets, honoring privacy:
   *   - viewer's OWN mode 'nobody' → sees no one online/contextual (reciprocity).
   *   - target mode 'nobody' OR CardVisibility.onlineStatus=false → always offline/no contextual.
   *   - else target must be in the viewer's Окружение (a ContactLink).
   * Contextual status (only when online) inherits the viewer's calendar access level.
   */
  async statusFor(viewerId: string, targetIds: string[]): Promise<PresenceInfo[]> {
    const targets = [...new Set(targetIds)].filter((id) => !!id && id !== viewerId);
    if (targets.length === 0) return [];

    // Reciprocity: a viewer who hides their own status sees no one.
    const viewer = await this.db.user.findUnique({
      where: { id: viewerId },
      select: { onlineStatusMode: true },
    });
    const viewerHidden = viewer?.onlineStatusMode === 'nobody';

    // The viewer's environment (presence is contacts-only; no public presence).
    const contactIds = new Set(await this.contacts.getContactUserIds(viewerId));

    // Batch-load target privacy fields.
    const rows = await this.db.user.findMany({
      where: { id: { in: targets } },
      select: { id: true, onlineStatusMode: true, cardVisibility: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Один MGET на весь батч вместо 1–2 последовательных GET на цель (100 контактов
    // = 100–200 round-trip'ов к Redis ≈ 50–150мс латентности — перф-ревью 2026-07-18).
    let presenceVals: (string | null)[] = [];
    try {
      presenceVals = targets.length
        ? await this.redis
            .getClient()
            .mget([
              ...targets.map((id) => this.key(id)),
              ...targets.map((id) => this.lastSeenKey(id)),
            ])
        : [];
    } catch {
      presenceVals = new Array(targets.length * 2).fill(null);
    }
    const onlineById = new Map<string, boolean>();
    const lastSeenById = new Map<string, string | null>();
    targets.forEach((id, i) => {
      const v = presenceVals[i];
      onlineById.set(id, !!v && Number(v) > 0);
      lastSeenById.set(id, presenceVals[targets.length + i] ?? null);
    });

    const out: PresenceInfo[] = [];
    for (const targetId of targets) {
      const t = byId.get(targetId);
      const hiddenInfo: PresenceInfo = {
        userId: targetId,
        online: false,
        lastSeen: null,
        contextual: null,
      };

      if (!t) {
        out.push(hiddenInfo);
        continue;
      }

      // Target privacy gates.
      const onlineFlag = this.onlineStatusFlag(t.cardVisibility);
      if (t.onlineStatusMode === 'nobody' || !onlineFlag) {
        out.push(hiddenInfo);
        continue;
      }
      // Reciprocity + contacts-only visibility.
      if (viewerHidden || !contactIds.has(targetId)) {
        out.push(hiddenInfo);
        continue;
      }

      const online = onlineById.get(targetId) ?? false;
      const lastSeen = online ? null : (lastSeenById.get(targetId) ?? null);
      const contextual = online ? await this.contextualFor(viewerId, targetId) : null;
      out.push({ userId: targetId, online, lastSeen, contextual });
    }
    return out;
  }

  // ============================================================
  // Contextual status
  // ============================================================

  /**
   * Contextual status of `targetId` as seen by `viewerId`. The raw current-event
   * (title + end) is cached per target (CONTEXT_TTL) so it's computed once across
   * all viewers; the access-level tailoring (busy vs detailed) is per-viewer/cheap.
   */
  private async contextualFor(viewerId: string, targetId: string): Promise<ContextualStatus> {
    const snap = await this.currentEventCached(targetId);
    if (!snap) return null;

    const cal = this.calendar();
    if (!cal) return null;
    // resolveAccessLevel is private — accessed via the lazily-resolved instance.
    const level = await (cal as unknown as {
      resolveAccessLevel(ownerId: string, viewerId: string): Promise<'none' | 'busy' | 'detailed'>;
    }).resolveAccessLevel(targetId, viewerId);

    if (level === 'none') return null;
    const hhmm = this.formatHHMM(new Date(snap.endTime));
    if (level === 'detailed') {
      return { label: `На ${snap.title} до ${hhmm}`, level: 'detailed' };
    }
    return { label: `Занят до ${hhmm}`, level: 'busy' };
  }

  /** The target's current event, cached in Redis (CONTEXT_TTL). 'none' is cached too. */
  private async currentEventCached(targetId: string): Promise<{ title: string; endTime: string } | null> {
    const cached = await this.redis.getJson<CtxSnapshot | 'none'>(this.ctxKey(targetId));
    if (cached !== null && cached !== undefined) {
      return cached === 'none' ? null : (cached as { title: string; endTime: string });
    }
    const cal = this.calendar();
    let snap: CtxSnapshot = null;
    if (cal) {
      try {
        const ev = await cal.getCurrentEvent(targetId);
        snap = ev ? { title: ev.title, endTime: ev.endTime.toISOString() } : null;
      } catch (e) {
        this.logger.error(`getCurrentEvent ${targetId} failed`, e as Error);
        snap = null;
      }
    }
    await this.redis.setJson(this.ctxKey(targetId), snap ?? 'none', PRESENCE.CONTEXT_TTL_SECONDS);
    return snap;
  }

  // ============================================================
  // Fan-out
  // ============================================================

  /**
   * Tell the user's contacts (+ the user) that their presence/contextual may have changed.
   * Emits an EventBus event the gateway's relay() turns into a socket 'presence:changed';
   * clients then refetch GET /messenger/presence (per-viewer tailoring lives there).
   */
  async fanOutPresenceChange(userId: string): Promise<void> {
    try {
      const contactIds = await this.contacts.getContactUserIds(userId);
      const audienceIds = [...new Set([...contactIds, userId])];
      this.events.emit('messenger.presence.changed', { userId, audienceIds }, 'messenger');
    } catch (e) {
      this.logger.error(`fanOutPresenceChange ${userId} failed`, e as Error);
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  /** Read the onlineStatus flag from the stored card_visibility JSON (default true). */
  private onlineStatusFlag(cardVisibility: unknown): boolean {
    if (cardVisibility && typeof cardVisibility === 'object') {
      const v = (cardVisibility as Record<string, unknown>).onlineStatus;
      if (typeof v === 'boolean') return v;
    }
    return true; // default visibility shows online status
  }

  /** 24h HH:MM in server-local time (kept simple; tz tailoring is a future refinement). */
  private formatHHMM(d: Date): string {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}
