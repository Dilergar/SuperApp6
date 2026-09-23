import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ERROR_CODES,
  AUDIT_LIMITS,
  type AuditClient,
  type AuditDeviceClass,
  type SecurityCoolingDto,
  type SecuritySessionDto,
  type SecuritySessionsDto,
  type SessionRevokeReason,
  type UserDeviceDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { forbidden, notFound, unauthorized } from '../../shared/errors/api-error';
import type { RequestContext } from '../../shared/context/request-context';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { deviceFromFamily, parseUserAgent } from '../../shared/utils/user-agent';
import { utcTs } from '../../shared/database/sql-time';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';
import { AnalyticsService } from '../analytics/analytics.service';
import { AUDIT_REDIS } from './audit.constants';
import { AuditService } from './audit.service';
import { ipNetOf } from './audit.redact';

type Tx = Prisma.TransactionClient;

/** Ключ «семейство отозвано» — access-токены мягко завершённой сессии гаснут сразу, а не через 15 минут. */
export const authFamilyRevokedKey = (familyId: string) => `auth:revfam:${familyId}`;
/** Сколько живёт отметка отзыва семейства: не меньше срока жизни access-токена. */
const REVOKED_FAMILY_TTL_SEC = 60 * 60;

/** Устройство входа после upsert. */
export interface LoginDevice {
  deviceId: string | null;
  label: string | null;
  deviceClass: AuditDeviceClass;
  /** Устройство новое для аккаунта (или клиент без X-Device-Id с новым семейством UA/страной) */
  isNew: boolean;
  /** Сессии этого устройства доверены сразу (первое устройство, регистрация, подтверждённое ранее) */
  trusted: boolean;
}

/** Поля строки сессии, которые наследует ротация refresh (всё, кроме id/токена/срока). */
export interface SessionContextFields {
  deviceId: string | null;
  uaFamily: string | null;
  ipNet: string | null;
  country: string | null;
  client: string | null;
  familyCreatedAt: Date;
  confirmedAt: Date | null;
}

const DEVICE_CLASSES = new Set<AuditDeviceClass>(['desktop', 'mobile', 'tablet', 'other']);

/**
 * Сессии и устройства человека как ОБЪЕКТЫ безопасности (core/audit): семейство refresh-цепочки
 * = «сессия» (строка ротируется на каждом refresh), устройство — клиентский `X-Device-Id`.
 * Мягкий отзыв (строки остаются: улика reuse и «кто отозвал»), cooling новой сессии, последняя
 * активность, автозавершение неактивных. Права вызывающий проверил («это я»); cooling-гард —
 * здесь (`assertConfirmed`).
 */
@Injectable()
export class AuditSessionsService {
  private readonly logger = new Logger(AuditSessionsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly ws: WorkspaceContextService,
    private readonly analytics: AnalyticsService,
    private readonly bus: EventBusService,
  ) {}

  // ============================================================
  // Вход: устройство, контекст сессии, новизна страны
  // ============================================================

  /** Устройство входа — upsert `user_devices` В ТРАНЗАКЦИИ входа. */
  async deviceForLogin(tx: Tx, userId: string, ctx: RequestContext | undefined, opts: { registration?: boolean } = {}): Promise<LoginDevice> {
    const ua = parseUserAgent(ctx?.userAgent);
    const deviceClass = (ua.deviceClass ?? 'other') as AuditDeviceClass;
    const now = new Date();
    const live = await tx.userDevice.count({ where: { userId, forgottenAt: null } });
    if (ctx?.deviceId) {
      const existing = await tx.userDevice.findUnique({ where: { userId_deviceId: { userId, deviceId: ctx.deviceId } } });
      if (existing && !existing.forgottenAt) {
        await tx.userDevice.update({
          where: { id: existing.id },
          data: { lastSeenAt: now, ...(ctx.country ? { lastCountry: ctx.country } : {}), ...(ua.label ? { label: ua.label, platform: ua.os, browser: ua.browser, deviceClass } : {}) },
        });
        return { deviceId: ctx.deviceId, label: existing.customLabel ?? ua.label ?? existing.label, deviceClass, isNew: false, trusted: !!existing.trustedAt };
      }
      // Первое устройство аккаунта и устройство регистрации — доверены сразу
      const trusted = !!opts.registration || live === 0;
      const data = {
        label: ua.label ?? 'Unknown device',
        platform: ua.os,
        browser: ua.browser,
        deviceClass,
        lastSeenAt: now,
        lastCountry: ctx.country ?? null,
        trustedAt: trusted ? now : null,
        forgottenAt: null,
      };
      if (existing) await tx.userDevice.update({ where: { id: existing.id }, data: { ...data, customLabel: null } });
      else await tx.userDevice.create({ data: { ...data, userId, deviceId: ctx.deviceId, firstSeenAt: now } });
      return { deviceId: ctx.deviceId, label: ua.label, deviceClass, isNew: !opts.registration, trusted };
    }
    // Клиент без X-Device-Id (старый клиент, curl): новизна — (семейство UA, страна) на 30 дней
    let isNew = !opts.registration;
    if (isNew) {
      try {
        const won = await this.redis
          .getClient()
          .set(AUDIT_REDIS.unknownDevice(userId, ua.family ?? 'unknown', ctx?.country ?? '--'), '1', 'EX', AUDIT_LIMITS.unknownDeviceNoveltyDays * 86_400, 'NX');
        isNew = won === 'OK';
      } catch {
        isNew = true;
      }
    }
    const liveSessions = opts.registration ? 0 : await tx.session.count({ where: { userId, revokedAt: null, expiresAt: { gt: now } } });
    return { deviceId: null, label: ua.label, deviceClass, isNew, trusted: !!opts.registration || (live === 0 && liveSessions === 0) };
  }

  /** Контекст новой семьи сессий: сеть, страна, клиент, момент входа, подтверждение (cooling). */
  newFamilyFields(ctx: RequestContext | undefined, device: LoginDevice, now = new Date()): SessionContextFields {
    return {
      deviceId: device.deviceId,
      uaFamily: ctx?.uaFamily ?? null,
      ipNet: ipNetOf(ctx?.ip ?? null),
      country: ctx?.country ?? null,
      client: ctx?.client ?? null,
      familyCreatedAt: now,
      confirmedAt: device.trusted ? now : null,
    };
  }

  /**
   * Новая страна входа: страна известна И среди прежних удачных входов её не было. Страна
   * неизвестна (нет гео-заголовка) — новизна не считается; первый вход со страной — тоже нет.
   */
  async countryNovelty(tx: Tx, userId: string, country: string | null): Promise<{ newCountry: boolean; previousCountry: string | null }> {
    if (!country) return { newCountry: false, previousCountry: null };
    const prior = await tx.securityEvent.findMany({
      where: { subjectUserId: userId, eventKey: 'auth.login.success', country: { not: null } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: { country: true },
    });
    if (!prior.length) return { newCountry: false, previousCountry: null };
    const seen = new Set(prior.map((p) => p.country));
    return { newCountry: !seen.has(country), previousCountry: prior[0]!.country };
  }

  // ============================================================
  // Cooling: новая сессия до подтверждения не гасит чужой доступ
  // ============================================================

  private async familyOf(user: JwtPayload): Promise<string | null> {
    if (user.fam) return user.fam;
    if (!user.sid) return null;
    const row = await this.db.session.findUnique({ where: { id: user.sid }, select: { familyId: true } });
    return row?.familyId ?? null;
  }

  /** Голова живого семейства (последняя строка ротации). */
  private head(userId: string, familyId: string) {
    return this.db.session.findFirst({
      where: { userId, familyId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, confirmedAt: true, familyCreatedAt: true, deviceId: true, expiresAt: true },
    });
  }

  /**
   * Cooling-гард: неподтверждённая сессия младше 24 ч не может завершать чужие сессии, выходить
   * везде, менять пароль/номер, забывать и переименовывать устройства, жать «Это не я» — иначе
   * угонщик с паролем первым же действием выгнал бы владельца. Срок прошёл → подтверждается сама.
   * Токен прошлой эпохи (без `sid`) — пропускается (живёт ≤ 15 минут).
   */
  async assertConfirmed(user: JwtPayload): Promise<void> {
    if (user.keyId || user.kind === 'bot') return;
    const familyId = await this.familyOf(user);
    if (!familyId) return;
    const head = await this.head(user.sub, familyId);
    if (!head) throw unauthorized('auth.sessionExpired');
    if (head.confirmedAt) return;
    const confirmAt = new Date(head.familyCreatedAt.getTime() + AUDIT_LIMITS.coolingHours * 3_600_000);
    if (Date.now() >= confirmAt.getTime()) {
      await this.db.$transaction((tx) => this.markConfirmed(tx, user.sub, familyId, head.deviceId, 'elapsed'));
      return;
    }
    throw forbidden('auth.cooling_period', undefined, { code: AUDIT_ERROR_CODES.coolingPeriod, confirmAt: confirmAt.toISOString(), canConfirmNow: true });
  }

  /** Состояние плашки cooling текущей сессии. */
  async cooling(user: JwtPayload): Promise<SecurityCoolingDto> {
    const familyId = await this.familyOf(user);
    if (!familyId) return { confirmed: true, confirmAt: null };
    const head = await this.head(user.sub, familyId);
    if (!head || head.confirmedAt) return { confirmed: true, confirmAt: null };
    const confirmAt = new Date(head.familyCreatedAt.getTime() + AUDIT_LIMITS.coolingHours * 3_600_000);
    if (Date.now() >= confirmAt.getTime()) {
      await this.db.$transaction((tx) => this.markConfirmed(tx, user.sub, familyId, head.deviceId, 'elapsed'));
      return { confirmed: true, confirmAt: null };
    }
    return { confirmed: false, confirmAt: confirmAt.toISOString() };
  }

  /** Подтвердить семейство (+ доверить устройство) и записать событие — в транзакции вызывающего. */
  async markConfirmed(tx: Tx, userId: string, familyId: string, deviceId: string | null, via: 'step_up' | 'elapsed', evidence?: Record<string, unknown>): Promise<boolean> {
    const now = new Date();
    const { count } = await tx.session.updateMany({ where: { userId, familyId, confirmedAt: null }, data: { confirmedAt: now } });
    if (count === 0) return false;
    if (deviceId) await tx.userDevice.updateMany({ where: { userId, deviceId, trustedAt: null }, data: { trustedAt: now } });
    await this.audit.record(tx, {
      key: 'auth.session.confirmed',
      subjectUserId: userId,
      actor: via === 'elapsed' ? { kind: 'system' } : undefined,
      target: { type: 'session', id: familyId },
      details: { via },
      ...(evidence ? { evidence } : {}),
    });
    return true;
  }

  // ============================================================
  // Мягкий отзыв семейств
  // ============================================================

  /**
   * Отозвать семейства (все строки каждого) — В ТРАНЗАКЦИИ вызывающего. `only` — эти семейства;
   * `except` — все, кроме этого. Возвращает число семейств; `afterCommit` гасит их access-токены
   * немедленно (отметка в Redis) — вызвать ПОСЛЕ коммита.
   */
  async revokeFamilies(tx: Tx, userId: string, scope: { only?: string[]; except?: string | null; deviceId?: string }, reason: SessionRevokeReason): Promise<{ count: number; families: string[]; afterCommit: () => Promise<void> }> {
    const now = new Date();
    const rows = await tx.session.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(scope.only ? { familyId: { in: scope.only } } : {}),
        ...(scope.except ? { familyId: { not: scope.except } } : {}),
        ...(scope.deviceId ? { deviceId: scope.deviceId } : {}),
      },
      select: { familyId: true },
      distinct: ['familyId'],
    });
    const families = rows.map((r) => r.familyId);
    if (families.length) {
      await tx.session.updateMany({ where: { userId, familyId: { in: families }, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } });
    }
    return { count: families.length, families, afterCommit: () => this.markFamiliesRevoked(families) };
  }

  /**
   * После коммита отзыва: отметка «семейство отозвано» (её проверяет валидатор сессии на каждом
   * запросе — access-токены гаснут сразу) и разрыв живых сокетов ИМЕННО этих семейств
   * (`auth.families.revoked` → комнаты `fam:<id>`): авторизация сокета — только на рукопожатии.
   */
  async markFamiliesRevoked(families: string[]): Promise<void> {
    if (!families.length) return;
    this.bus.emit('auth.families.revoked', { families }, 'audit');
    try {
      const pipe = this.redis.getClient().pipeline();
      for (const f of families) pipe.set(authFamilyRevokedKey(f), '1', 'EX', REVOKED_FAMILY_TTL_SEC);
      await pipe.exec();
    } catch (err) {
      this.logger.warn(`revoked family marks were not set: ${(err as Error).message}`);
    }
  }

  // ============================================================
  // Последняя активность (раз в 5 минут на семейство)
  // ============================================================

  /** Отметить активность семейства и его устройства — не чаще раза в 5 минут, fire-and-forget. */
  touch(userId: string, familyId: string | undefined): void {
    if (!familyId) return;
    void (async () => {
      const won = await this.redis
        .getClient()
        .set(AUDIT_REDIS.sessionSeen(familyId), '1', 'EX', AUDIT_LIMITS.lastSeenEveryMin * 60, 'NX')
        .catch(() => null);
      if (won !== 'OK') return;
      const now = new Date();
      await this.db.session.updateMany({ where: { userId, familyId, revokedAt: null }, data: { lastSeenAt: now } });
      await this.db.$executeRaw`
        UPDATE user_devices SET last_seen_at = ${utcTs(now)}
        WHERE user_id = ${userId} AND forgotten_at IS NULL
          AND device_id = (SELECT device_id FROM sessions WHERE family_id = ${familyId} AND device_id IS NOT NULL LIMIT 1)`;
    })().catch((err: unknown) => this.logger.debug(`session touch skipped: ${err instanceof Error ? err.message : String(err)}`));
  }

  // ============================================================
  // Список сессий и устройств человека
  // ============================================================

  async list(user: JwtPayload): Promise<SecuritySessionsDto> {
    const currentFamily = await this.familyOf(user);
    const now = Date.now();
    const endedSince = new Date(now - 90 * 86_400_000);
    // Головы семейств: последняя строка ротации (прокрученные — история, не устройства)
    const heads = await this.db.session.findMany({
      // Живые, недавно завершённые и недавно истёкшие; истёкшие давно (никем не отозванные) — нет:
      // иначе за годы они вытесняли бы живые сессии из потолка выборки
      where: { userId: user.sub, rotatedAt: null, OR: [{ revokedAt: null, expiresAt: { gt: endedSince } }, { revokedAt: { gt: endedSince } }] },
      orderBy: { familyCreatedAt: 'desc' },
      take: 200,
      select: { familyId: true, deviceId: true, uaFamily: true, deviceInfo: true, client: true, country: true, familyCreatedAt: true, lastSeenAt: true, confirmedAt: true, revokedAt: true, revokedReason: true, expiresAt: true },
    });
    const devIds = [...new Set(heads.map((h) => h.deviceId).filter((d): d is string => !!d))];
    const devices = devIds.length ? await this.db.userDevice.findMany({ where: { userId: user.sub, deviceId: { in: devIds } }, select: { deviceId: true, label: true, customLabel: true, deviceClass: true } }) : [];
    const devOf = new Map(devices.map((d) => [d.deviceId, d]));
    const active: SecuritySessionDto[] = [];
    const ended: SecuritySessionDto[] = [];
    for (const h of heads) {
      const d = h.deviceId ? devOf.get(h.deviceId) : undefined;
      const fromFamily = h.uaFamily ? deviceFromFamily(h.uaFamily) : { label: null, deviceClass: null };
      const legacy = !d && !fromFamily.label ? parseUserAgent(h.deviceInfo) : null;
      const cls = (d?.deviceClass ?? fromFamily.deviceClass ?? legacy?.deviceClass ?? null) as AuditDeviceClass | null;
      const expired = !h.revokedAt && h.expiresAt.getTime() <= now;
      const coolUntil = h.familyCreatedAt.getTime() + AUDIT_LIMITS.coolingHours * 3_600_000;
      const dto: SecuritySessionDto = {
        id: h.familyId,
        device: { label: d?.customLabel ?? d?.label ?? fromFamily.label ?? legacy?.label ?? null, class: cls && DEVICE_CLASSES.has(cls) ? cls : null },
        deviceId: h.deviceId,
        client: (h.client as AuditClient | null) ?? null,
        country: h.country,
        createdAt: h.familyCreatedAt.toISOString(),
        lastSeenAt: h.lastSeenAt.toISOString(),
        isCurrent: h.familyId === currentFamily,
        confirmedAt: h.confirmedAt?.toISOString() ?? (now >= coolUntil ? new Date(coolUntil).toISOString() : null),
        confirmAt: h.confirmedAt || now >= coolUntil ? null : new Date(coolUntil).toISOString(),
        revokedAt: h.revokedAt?.toISOString() ?? (expired ? h.expiresAt.toISOString() : null),
        revokedReason: (h.revokedReason as SessionRevokeReason | null) ?? (expired ? 'inactive' : null),
      };
      if (h.revokedAt || expired) {
        if ((h.revokedAt ?? h.expiresAt).getTime() > endedSince.getTime()) ended.push(dto);
      } else active.push(dto);
    }
    active.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.lastSeenAt.localeCompare(a.lastSeenAt));
    return { active, ended: ended.slice(0, 50) };
  }

  async devices(user: JwtPayload): Promise<UserDeviceDto[]> {
    const currentFamily = await this.familyOf(user);
    const current = currentFamily ? await this.db.session.findFirst({ where: { familyId: currentFamily }, select: { deviceId: true } }) : null;
    const rows = await this.db.userDevice.findMany({ where: { userId: user.sub, forgottenAt: null }, orderBy: { lastSeenAt: 'desc' }, take: 100 });
    const counts = await this.db.session.groupBy({
      by: ['deviceId'],
      where: { userId: user.sub, revokedAt: null, rotatedAt: null, expiresAt: { gt: new Date() }, deviceId: { in: rows.map((r) => r.deviceId) } },
      _count: { _all: true },
    });
    const countOf = new Map(counts.map((c) => [c.deviceId, c._count._all]));
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.deviceId,
      label: r.customLabel ?? r.label,
      renamed: !!r.customLabel,
      class: (DEVICE_CLASSES.has(r.deviceClass as AuditDeviceClass) ? r.deviceClass : 'other') as AuditDeviceClass,
      platform: r.platform,
      browser: r.browser,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      lastCountry: r.lastCountry,
      trustedAt: r.trustedAt?.toISOString() ?? null,
      isCurrent: !!current?.deviceId && current.deviceId === r.deviceId,
      activeSessions: countOf.get(r.deviceId) ?? 0,
    }));
  }

  /** Переименовать своё устройство (cooling-гард — у вызывающего). */
  async renameDevice(user: JwtPayload, id: string, label: string): Promise<UserDeviceDto> {
    const row = await this.db.userDevice.findFirst({ where: { id, userId: user.sub, forgottenAt: null } });
    if (!row) throw notFound('audit.device_not_found', undefined, { code: AUDIT_ERROR_CODES.deviceNotFound });
    await this.db.$transaction(async (tx) => {
      await tx.userDevice.update({ where: { id: row.id }, data: { customLabel: label } });
      await this.audit.record(tx, { key: 'account.device_renamed', target: { type: 'user_device', id: row.id }, details: {} });
    });
    return (await this.devices(user)).find((d) => d.id === id)!;
  }

  /**
   * Забыть устройство: его сессии завершаются, доверие снимается — следующий вход с него придёт
   * с уведомлением «новое устройство». Текущее устройство из самого себя не забывается (выход).
   */
  async forgetDevice(user: JwtPayload, id: string): Promise<{ sessionsRevoked: number }> {
    const row = await this.db.userDevice.findFirst({ where: { id, userId: user.sub, forgottenAt: null } });
    if (!row) throw notFound('audit.device_not_found', undefined, { code: AUDIT_ERROR_CODES.deviceNotFound });
    const currentFamily = await this.familyOf(user);
    if (currentFamily) {
      const cur = await this.db.session.findFirst({ where: { familyId: currentFamily }, select: { deviceId: true } });
      if (cur?.deviceId === row.deviceId) throw forbidden('audit.current_session', undefined, { code: AUDIT_ERROR_CODES.currentSession });
    }
    const res = await this.db.$transaction(async (tx) => {
      // status-guarded: два одновременных «забыть» дают одно событие и одно уведомление
      const { count } = await tx.userDevice.updateMany({ where: { id: row.id, forgottenAt: null }, data: { forgottenAt: new Date(), trustedAt: null } });
      if (!count) throw notFound('audit.device_not_found', undefined, { code: AUDIT_ERROR_CODES.deviceNotFound });
      const revoked = await this.revokeFamilies(tx, user.sub, { deviceId: row.deviceId }, 'other_session');
      await this.audit.record(tx, {
        key: 'account.device_forgotten',
        subjectUserId: user.sub,
        target: { type: 'user_device', id: row.id },
        details: { deviceClass: (DEVICE_CLASSES.has(row.deviceClass as AuditDeviceClass) ? row.deviceClass : 'other') as AuditDeviceClass, auto: false, sessionsRevoked: revoked.count },
        notify: { params: { device: row.customLabel ?? row.label } },
      });
      await this.analytics.track(tx, 'audit.device.forgotten', { sessionsRevoked: revoked.count }, { userId: user.sub, workspaceId: null });
      return revoked;
    });
    await res.afterCommit();
    return { sessionsRevoked: res.count };
  }

  // ============================================================
  // Настройки безопасности человека
  // ============================================================

  async settings(userId: string): Promise<{ sessionMaxIdleDays: number }> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { sessionMaxIdleDays: true } });
    return { sessionMaxIdleDays: u?.sessionMaxIdleDays ?? AUDIT_LIMITS.sessionMaxIdleDaysDefault };
  }

  async updateSettings(userId: string, input: { sessionMaxIdleDays: number }): Promise<{ sessionMaxIdleDays: number }> {
    await this.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { sessionMaxIdleDays: input.sessionMaxIdleDays } });
      await this.audit.record(tx, { key: 'account.settings_changed', details: { sessionMaxIdleDays: input.sessionMaxIdleDays } });
    });
    return { sessionMaxIdleDays: input.sessionMaxIdleDays };
  }

  /** Текущая семья запроса (для «не завершать себя»). */
  currentFamilyOf(user: JwtPayload): Promise<string | null> {
    return this.familyOf(user);
  }

  /** Контекст запроса из ALS (для входа — устройство, сеть, страна). */
  get requestContext(): RequestContext | undefined {
    return this.ws.request;
  }
}
