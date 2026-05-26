import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { google, calendar_v3 } from 'googleapis';
import { CalendarEvent as CalEventRow, GoogleConnection } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import type {
  GoogleConnectionStatus,
  GoogleCalendarListItem,
  GoogleSyncResult,
} from '@superapp/shared';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
];
const NEW_CALENDAR = '__new__';
const SYNC_CAL_NAME = 'SuperApp6';
const TASKS_CAL_NAME = 'SuperApp6 · Задачи';

/**
 * Google Calendar two-way sync (Phase 4). OAuth connect + incremental sync engine.
 * Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI in env;
 * when unset the integration is inert (endpoints report "not configured").
 *
 * Mapping: our CalendarEvent.googleEventId ↔ Google event id (idempotent upsert,
 * which also absorbs sync "echo" of our own writes). Conflicts: last-write-wins by
 * update time. Deletions mirror both ways. Participants are NOT pushed as attendees.
 * MVP limit: per-occurrence recurrence exceptions are synced at master+EXDATE level.
 */
@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);

  constructor(
    private db: DatabaseService,
    private events: EventBusService,
  ) {}

  isConfigured(): boolean {
    return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new BadRequestException('Google-интеграция не настроена (нет OAuth-кредов в .env)');
    }
  }

  // ============================================================
  // OAuth flow
  // ============================================================

  getAuthUrl(userId: string): string {
    this.assertConfigured();
    return this.oauth().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // force refresh_token every time
      scope: SCOPES,
      state: this.signState(userId),
    });
  }

  /** Exchange the OAuth code, store tokens, create dedicated calendars, kick off a full sync. */
  async handleCallback(code: string, state: string): Promise<string> {
    this.assertConfigured();
    const userId = this.verifyState(state);
    if (!userId) throw new BadRequestException('Недействительный state');

    const o = this.oauth();
    const { tokens } = await o.getToken(code);
    o.setCredentials(tokens);

    let email = 'google';
    try {
      const info = await google.oauth2({ version: 'v2', auth: o }).userinfo.get();
      email = info.data.email ?? email;
    } catch { /* non-fatal */ }

    const existing = await this.db.googleConnection.findUnique({ where: { userId } });
    const conn = await this.db.googleConnection.upsert({
      where: { userId },
      create: {
        userId,
        googleEmail: email,
        accessToken: tokens.access_token ?? '',
        refreshToken: tokens.refresh_token ?? '',
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      },
      update: {
        googleEmail: email,
        accessToken: tokens.access_token ?? existing?.accessToken ?? '',
        // Google omits refresh_token on re-consent sometimes; keep the old one then.
        refreshToken: tokens.refresh_token ?? existing?.refreshToken ?? '',
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      },
    });

    try {
      await this.ensureCalendars(conn);
      await this.fullSync(userId);
      await this.registerWatch(userId);
    } catch (e) {
      this.logger.error(`Initial Google sync failed: ${e instanceof Error ? e.message : e}`);
    }

    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    return `${webUrl}/calendar?google=connected`;
  }

  async getStatus(userId: string): Promise<GoogleConnectionStatus> {
    const c = await this.db.googleConnection.findUnique({ where: { userId } });
    if (!c) return { connected: false, email: null, syncCalendarId: null, syncCalendarName: null, tasksCalendarId: null, lastSyncedAt: null };
    let name: string | null = SYNC_CAL_NAME;
    if (c.syncCalendarId) {
      try {
        const cal = await this.client(c);
        const r = await cal.calendars.get({ calendarId: c.syncCalendarId });
        name = r.data.summary ?? name;
      } catch { /* ignore */ }
    }
    return {
      connected: true,
      email: c.googleEmail,
      syncCalendarId: c.syncCalendarId,
      syncCalendarName: name,
      tasksCalendarId: c.tasksCalendarId,
      lastSyncedAt: c.lastSyncedAt ? c.lastSyncedAt.toISOString() : null,
    };
  }

  async disconnect(userId: string): Promise<void> {
    const c = await this.db.googleConnection.findUnique({ where: { userId } });
    if (!c) return;
    try {
      const o = this.oauth();
      o.setCredentials({ refresh_token: c.refreshToken });
      if (c.channelId && c.channelResourceId) {
        await google.calendar({ version: 'v3', auth: o }).channels.stop({
          requestBody: { id: c.channelId, resourceId: c.channelResourceId },
        });
      }
      await o.revokeToken(c.refreshToken);
    } catch { /* best-effort */ }
    await this.db.googleConnection.delete({ where: { userId } });
  }

  async listCalendars(userId: string): Promise<GoogleCalendarListItem[]> {
    const cal = await this.clientFor(userId);
    const r = await cal.calendarList.list({ maxResults: 250 });
    return (r.data.items ?? [])
      .filter((i) => i.id)
      .map((i) => ({
        id: i.id!,
        summary: i.summary ?? '(без названия)',
        primary: !!i.primary,
        accessRole: i.accessRole ?? 'reader',
      }));
  }

  async selectCalendar(userId: string, calendarId: string): Promise<void> {
    const c = await this.requireConn(userId);
    let id = calendarId;
    if (calendarId === NEW_CALENDAR) {
      id = await this.createCalendar(c, SYNC_CAL_NAME);
    }
    await this.db.googleConnection.update({
      where: { userId },
      data: { syncCalendarId: id, syncToken: null }, // reset → full resync against new calendar
    });
    await this.fullSync(userId);
    await this.registerWatch(userId);
  }

  // ============================================================
  // Sync engine
  // ============================================================

  /** Manual "sync now": pull remote changes + (re)export task deadlines. */
  async syncNow(userId: string): Promise<GoogleSyncResult> {
    const pulled = await this.pullIncremental(userId);
    const pushedTasks = await this.exportTasks(userId);
    return { pushed: pushedTasks, pulled: pulled.pulled, deleted: pulled.deleted };
  }

  /** Push every local own event lacking a Google id, then pull everything, then export tasks. */
  async fullSync(userId: string): Promise<void> {
    const c = await this.requireConn(userId);
    if (!c.syncCalendarId) return;
    const cal = await this.client(c);

    const localEvents = await this.db.calendarEvent.findMany({
      where: { userId, recurrenceParentId: null },
    });
    for (const ev of localEvents) {
      try { await this.pushEventWith(cal, c, ev); } catch (e) { this.logger.warn(`push ${ev.id}: ${e instanceof Error ? e.message : e}`); }
    }
    await this.pullIncremental(userId);
    await this.exportTasks(userId);
  }

  /** Outbound: create/update one local event in Google (called by the EventBus listener). */
  async pushEvent(userId: string, eventId: string): Promise<void> {
    const c = await this.db.googleConnection.findUnique({ where: { userId } });
    if (!c?.syncCalendarId) return;
    const ev = await this.db.calendarEvent.findUnique({ where: { id: eventId } });
    if (!ev || ev.userId !== userId || ev.recurrenceParentId) return; // only own masters/standalone
    const cal = await this.client(c);
    try { await this.pushEventWith(cal, c, ev); } catch (e) { this.logger.warn(`push ${eventId}: ${e instanceof Error ? e.message : e}`); }
  }

  /** Outbound deletion mirror. */
  async deleteRemote(userId: string, googleEventId: string): Promise<void> {
    const c = await this.db.googleConnection.findUnique({ where: { userId } });
    if (!c?.syncCalendarId || !googleEventId) return;
    try {
      const cal = await this.client(c);
      await cal.events.delete({ calendarId: c.syncCalendarId, eventId: googleEventId });
    } catch (e) { this.logger.warn(`delete remote ${googleEventId}: ${e instanceof Error ? e.message : e}`); }
  }

  private async pushEventWith(cal: calendar_v3.Calendar, c: GoogleConnection, ev: CalEventRow): Promise<void> {
    const body = this.toGoogleEvent(ev);
    if (ev.googleEventId) {
      await cal.events.update({ calendarId: c.syncCalendarId!, eventId: ev.googleEventId, requestBody: body });
    } else {
      const r = await cal.events.insert({ calendarId: c.syncCalendarId!, requestBody: body });
      if (r.data.id) {
        await this.db.calendarEvent.update({
          where: { id: ev.id },
          data: { googleEventId: r.data.id, googleCalendarId: c.syncCalendarId },
        });
      }
    }
  }

  /** Inbound incremental pull (events.list with syncToken; 410 → full resync). */
  async pullIncremental(userId: string): Promise<{ pulled: number; deleted: number }> {
    const c = await this.requireConn(userId);
    if (!c.syncCalendarId) return { pulled: 0, deleted: 0 };
    const cal = await this.client(c);

    let pageToken: string | undefined;
    let syncToken: string | undefined = c.syncToken ?? undefined;
    let pulled = 0;
    let deleted = 0;
    let nextSyncToken: string | undefined;

    for (;;) {
      let resp;
      try {
        resp = await cal.events.list({
          calendarId: c.syncCalendarId,
          singleEvents: false,
          showDeleted: true,
          maxResults: 250,
          ...(syncToken ? { syncToken } : { timeMin: new Date(Date.now() - 365 * 86400000).toISOString() }),
          ...(pageToken ? { pageToken } : {}),
        });
      } catch (e: unknown) {
        const code = (e as { code?: number }).code;
        if (code === 410) {
          // token expired → reset and full resync from scratch
          await this.db.googleConnection.update({ where: { userId }, data: { syncToken: null } });
          syncToken = undefined;
          pageToken = undefined;
          continue;
        }
        throw e;
      }

      for (const g of resp.data.items ?? []) {
        const res = await this.applyGoogleEvent(userId, c, g);
        if (res === 'deleted') deleted++;
        else if (res === 'upserted') pulled++;
      }

      if (resp.data.nextPageToken) { pageToken = resp.data.nextPageToken; continue; }
      nextSyncToken = resp.data.nextSyncToken ?? undefined;
      break;
    }

    await this.db.googleConnection.update({
      where: { userId },
      data: { syncToken: nextSyncToken ?? c.syncToken, lastSyncedAt: new Date() },
    });
    return { pulled, deleted };
  }

  private async applyGoogleEvent(
    userId: string,
    c: GoogleConnection,
    g: calendar_v3.Schema$Event,
  ): Promise<'deleted' | 'upserted' | 'skip'> {
    if (!g.id) return 'skip';
    // Skip recurring-instance exceptions for MVP (handled at master level).
    if (g.recurringEventId) return 'skip';

    const existing = await this.db.calendarEvent.findFirst({ where: { userId, googleEventId: g.id } });

    if (g.status === 'cancelled') {
      if (existing) { await this.db.calendarEvent.delete({ where: { id: existing.id } }); return 'deleted'; }
      return 'skip';
    }

    const mapped = this.fromGoogleEvent(g);
    if (!mapped) return 'skip';

    if (existing) {
      // Conflict: last-write-wins. Google updated vs our updatedAt.
      const gUpdated = g.updated ? new Date(g.updated).getTime() : 0;
      if (gUpdated <= existing.updatedAt.getTime()) return 'skip';
      await this.db.calendarEvent.update({ where: { id: existing.id }, data: mapped });
    } else {
      await this.db.calendarEvent.create({
        data: { ...mapped, userId, googleEventId: g.id, googleCalendarId: c.syncCalendarId },
      });
    }
    return 'upserted';
  }

  /** One-way export of task deadlines into the dedicated tasks calendar (never pulled back). */
  async exportTasks(userId: string): Promise<number> {
    const c = await this.db.googleConnection.findUnique({ where: { userId } });
    if (!c?.tasksCalendarId) return 0;
    const cal = await this.client(c);
    const tasks = await this.db.task.findMany({
      where: { creatorId: userId, dueDate: { not: null }, status: { notIn: ['done', 'cancelled'] } },
      select: { id: true, title: true, dueDate: true, allDay: true },
      take: 500,
    });
    let n = 0;
    for (const t of tasks) {
      const due = t.dueDate as Date;
      const id = 'task' + t.id.replace(/-/g, '');
      const body: calendar_v3.Schema$Event = {
        id,
        summary: `✓ ${t.title}`,
        start: t.allDay ? { date: this.dateOnly(due) } : { dateTime: due.toISOString() },
        end: t.allDay ? { date: this.dateOnly(due) } : { dateTime: new Date(+due + 3600000).toISOString() },
        extendedProperties: { private: { superappTaskId: t.id } },
      };
      try {
        await cal.events.update({ calendarId: c.tasksCalendarId, eventId: id, requestBody: body });
        n++;
      } catch {
        try { await cal.events.insert({ calendarId: c.tasksCalendarId, requestBody: body }); n++; } catch { /* ignore */ }
      }
    }
    return n;
  }

  // ============================================================
  // Push notifications (webhooks)
  // ============================================================

  async registerWatch(userId: string): Promise<void> {
    const webhook = process.env.GOOGLE_WEBHOOK_URL;
    if (!webhook) return; // needs a public HTTPS URL; skipped in local dev
    const c = await this.requireConn(userId);
    if (!c.syncCalendarId) return;
    const cal = await this.client(c);
    const channelId = crypto.randomUUID();
    try {
      const r = await cal.events.watch({
        calendarId: c.syncCalendarId,
        requestBody: { id: channelId, type: 'web_hook', address: webhook, token: userId },
      });
      await this.db.googleConnection.update({
        where: { userId },
        data: {
          channelId,
          channelResourceId: r.data.resourceId ?? null,
          channelExpiry: r.data.expiration ? new Date(Number(r.data.expiration)) : null,
        },
      });
    } catch (e) { this.logger.warn(`watch register: ${e instanceof Error ? e.message : e}`); }
  }

  async handleWebhook(channelId: string, resourceState: string): Promise<void> {
    if (resourceState === 'sync') return; // initial handshake
    const c = await this.db.googleConnection.findFirst({ where: { channelId } });
    if (!c) return;
    await this.pullIncremental(c.userId).catch((e) => this.logger.warn(`webhook sync: ${e instanceof Error ? e.message : e}`));
  }

  /** Cron: renew channels nearing expiry + poll fallback for everyone. */
  async pollAndRenew(): Promise<number> {
    const conns = await this.db.googleConnection.findMany({ where: { syncCalendarId: { not: null } }, take: 1000 });
    for (const c of conns) {
      await this.pullIncremental(c.userId).catch(() => undefined);
      if (c.channelExpiry && c.channelExpiry.getTime() - Date.now() < 24 * 3600000) {
        await this.registerWatch(c.userId).catch(() => undefined);
      }
    }
    return conns.length;
  }

  // ============================================================
  // Helpers — OAuth client, calendars, field mapping
  // ============================================================

  private oauth() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI,
    );
  }

  private async clientFor(userId: string): Promise<calendar_v3.Calendar> {
    return this.client(await this.requireConn(userId));
  }

  /** Build an authed Calendar client; persist refreshed access tokens. */
  private async client(c: GoogleConnection): Promise<calendar_v3.Calendar> {
    this.assertConfigured();
    const o = this.oauth();
    o.setCredentials({
      access_token: c.accessToken,
      refresh_token: c.refreshToken,
      expiry_date: c.tokenExpiry ? c.tokenExpiry.getTime() : undefined,
    });
    o.on('tokens', (t) => {
      this.db.googleConnection
        .update({
          where: { userId: c.userId },
          data: {
            accessToken: t.access_token ?? c.accessToken,
            tokenExpiry: t.expiry_date ? new Date(t.expiry_date) : c.tokenExpiry,
            ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
          },
        })
        .catch(() => undefined);
    });
    return google.calendar({ version: 'v3', auth: o });
  }

  private async requireConn(userId: string): Promise<GoogleConnection> {
    const c = await this.db.googleConnection.findUnique({ where: { userId } });
    if (!c) throw new NotFoundException('Google не подключён');
    return c;
  }

  private async ensureCalendars(c: GoogleConnection): Promise<void> {
    const data: { syncCalendarId?: string; tasksCalendarId?: string } = {};
    if (!c.syncCalendarId) data.syncCalendarId = await this.createCalendar(c, SYNC_CAL_NAME);
    if (!c.tasksCalendarId) data.tasksCalendarId = await this.createCalendar(c, TASKS_CAL_NAME);
    if (Object.keys(data).length) {
      await this.db.googleConnection.update({ where: { userId: c.userId }, data });
      Object.assign(c, data);
    }
  }

  private async createCalendar(c: GoogleConnection, summary: string): Promise<string> {
    const cal = await this.client(c);
    const r = await cal.calendars.insert({ requestBody: { summary } });
    return r.data.id!;
  }

  /** Local CalendarEvent → Google event resource. No attendees (RSVP stays internal). */
  private toGoogleEvent(ev: CalEventRow): calendar_v3.Schema$Event {
    const body: calendar_v3.Schema$Event = {
      summary: ev.title,
      description: ev.description ?? undefined,
      location: ev.location ?? undefined,
      extendedProperties: { private: { superappEventId: ev.id } },
    };
    if (ev.allDay) {
      body.start = { date: this.dateOnly(ev.startTime) };
      body.end = { date: this.dateOnly(new Date(+ev.endTime + 86400000)) }; // Google all-day end is exclusive
    } else {
      body.start = { dateTime: ev.startTime.toISOString() };
      body.end = { dateTime: ev.endTime.toISOString() };
    }
    if (ev.recurrenceRule) {
      const rec = [`RRULE:${ev.recurrenceRule}`];
      if (ev.exDates.length) {
        rec.push('EXDATE:' + ev.exDates.map((d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')).join(','));
      }
      body.recurrence = rec;
    }
    return body;
  }

  /** Google event → local CalendarEvent fields (for create/update). */
  private fromGoogleEvent(g: calendar_v3.Schema$Event): {
    title: string;
    description: string | null;
    location: string | null;
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    recurrenceRule: string | null;
  } | null {
    const startRaw = g.start?.dateTime ?? g.start?.date;
    const endRaw = g.end?.dateTime ?? g.end?.date;
    if (!startRaw) return null;
    const allDay = !g.start?.dateTime;
    const start = new Date(startRaw);
    let end = endRaw ? new Date(endRaw) : new Date(+start + 3600000);
    if (allDay && endRaw) end = new Date(+new Date(endRaw) - 86400000); // exclusive → inclusive
    const rrule = (g.recurrence ?? []).find((r) => r.startsWith('RRULE:'))?.replace(/^RRULE:/, '') ?? null;
    return {
      title: g.summary ?? '(без названия)',
      description: g.description ?? null,
      location: g.location ?? null,
      startTime: start,
      endTime: end,
      allDay,
      recurrenceRule: rrule,
    };
  }

  private dateOnly(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  // ---- signed OAuth state (callback is unauthenticated) ----

  private signState(userId: string): string {
    const exp = Date.now() + 10 * 60 * 1000;
    const payload = `${userId}.${exp}`;
    const sig = crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev').update(payload).digest('base64url');
    return Buffer.from(`${payload}.${sig}`).toString('base64url');
  }

  private verifyState(state: string): string | null {
    try {
      const [userId, exp, sig] = Buffer.from(state, 'base64url').toString().split('.');
      const expected = crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev').update(`${userId}.${exp}`).digest('base64url');
      if (sig !== expected || Date.now() > Number(exp)) return null;
      return userId;
    } catch {
      return null;
    }
  }
}
