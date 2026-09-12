import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHmac, randomUUID } from 'crypto';
import {
  PLATFORM_ERROR_CODES,
  PLATFORM_JWT_AUDIENCE,
  PLATFORM_LIMITS,
  type PlatformLoginResponse,
  type PlatformMeDto,
  type PlatformStepUpResponse,
  type VerifyStartResponse,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { SessionValidatorService } from '../../shared/auth/session-validator.service';
import { forbidden, tooMany, unauthorized } from '../../shared/errors/api-error';
import type { PlatformActor } from '../../shared/decorators/platform.decorator';
import { VerifyService } from '../verify/verify.service';
import { PlatformAccessService } from './platform-access.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformPolicyService } from './platform-policy.service';
import { PlatformNotifier } from './platform.notifications';
import { PLATFORM_AUDIT_KEYS, PLATFORM_REDIS } from './platform.constants';

type Tx = Prisma.TransactionClient;

interface PlatformJwtPayload {
  sub: string;
  sid: string;
  epoch: number;
  aud: string;
}

/**
 * Вход и сессия кабинета. Токен кабинета: СВОЙ секрет, `aud: 'platform'`, строка
 * `PlatformSession`, `epoch` = tokenEpoch человека, 8 часов, без refresh; продлевается
 * активностью (метка в Redis), простой > 20 мин → 401. Отзыв: logout, приостановка
 * сотрудника, смена пароля (tokenEpoch). Ответ старта не раскрывает, сотрудник ли это.
 */
@Injectable()
export class PlatformAuthService {
  private readonly logger = new Logger(PlatformAuthService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly sessions: SessionValidatorService,
    private readonly verify: VerifyService,
    private readonly access: PlatformAccessService,
    private readonly audit: PlatformAuditService,
    private readonly policy: PlatformPolicyService,
    private readonly notifier: PlatformNotifier,
  ) {}

  /** Стоп-кран (S18): `PLATFORM_CONSOLE_ENABLED=false` → 404 на всём /platform/*. */
  consoleEnabled(): boolean {
    return process.env.PLATFORM_CONSOLE_ENABLED !== 'false';
  }

  /** Секрет читается на каждый вызов (env-константы модуля вычислялись бы до validateEnv). */
  private secret(): string {
    const own = process.env.PLATFORM_JWT_SECRET;
    if (own) return own;
    // development: производный от JWT_SECRET отдельной строкой контекста
    return createHmac('sha256', process.env.JWT_SECRET ?? '').update('superapp6:platform-console').digest('hex');
  }

  // ============================================================
  // Вход: пароль → SMS → токен
  // ============================================================

  async start(phone: string, password: string, ip?: string): Promise<VerifyStartResponse> {
    const failKey = PLATFORM_REDIS.loginFail(phone);
    let fails = 0;
    try {
      fails = Number((await this.redis.get(failKey)) ?? 0);
    } catch {
      /* best-effort */
    }
    if (fails >= PLATFORM_LIMITS.loginFailMax) {
      throw tooMany('platform.login_blocked', { minutes: PLATFORM_LIMITS.loginBlockMinutes }, { code: PLATFORM_ERROR_CODES.loginBlocked, resendInSec: PLATFORM_LIMITS.loginBlockMinutes * 60 });
    }
    const user = await this.db.user.findUnique({ where: { phone }, select: { id: true, phone: true, password: true, deletedAt: true, deletionScheduledAt: true } });
    const ok = !!user && !user.deletedAt && !user.deletionScheduledAt && (await bcrypt.compare(password, user.password));
    if (!ok) {
      try {
        const client = this.redis.getClient();
        const n = await client.incr(failKey);
        if (n === 1) await client.expire(failKey, PLATFORM_LIMITS.loginBlockMinutes * 60);
      } catch {
        /* best-effort */
      }
      throw unauthorized('auth.badCredentials');
    }
    try {
      await this.redis.del(failKey);
    } catch {
      /* best-effort */
    }
    // Код уходит и НЕ-сотруднику: «сотрудник ли это» ответ не раскрывает; отказ — на login.
    return this.verify.startForPlatform(user!.id, user!.phone, 'platform_login', ip);
  }

  async login(verifyToken: string, meta: { ip: string | null; userAgent: string | null }): Promise<PlatformLoginResponse> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PLATFORM_LIMITS.sessionHours * 3_600_000);
    const { session, userId, epoch } = await this.db.$transaction(async (tx) => {
      const consumed = await this.verify.consume(tx, { verifyToken, purpose: 'platform_login' });
      const userId = consumed.userId;
      if (!userId) throw unauthorized('auth.verifyStale');
      const staff = await tx.platformStaff.findUnique({ where: { userId } });
      if (!staff || staff.status !== 'active') {
        throw forbidden('platform.not_staff', undefined, { code: PLATFORM_ERROR_CODES.notStaff });
      }
      const user = await tx.user.findUnique({ where: { id: userId }, select: { tokenEpoch: true } });
      const session = await tx.platformSession.create({
        data: { userId, expiresAt, ip: meta.ip, userAgent: meta.userAgent, lastActiveAt: now },
      });
      await this.audit.write(tx, {
        actorId: userId,
        sessionId: session.id,
        commandKey: PLATFORM_AUDIT_KEYS.login,
        outcome: 'ok',
        readOnly: true,
        risk: 'low',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return { session, userId, epoch: user?.tokenEpoch ?? 0 };
    });
    const payload: PlatformJwtPayload = { sub: userId, sid: session.id, epoch, aud: PLATFORM_JWT_AUDIENCE };
    const accessToken = this.jwt.sign(payload, { secret: this.secret(), expiresIn: `${PLATFORM_LIMITS.sessionHours}h` });
    await this.touch(session.id);
    return { accessToken, expiresAt: expiresAt.toISOString() };
  }

  // ============================================================
  // Аутентификация запроса (гард)
  // ============================================================

  async authenticate(raw: string, meta: { ip: string | null; userAgent: string | null; requestId: string }): Promise<PlatformActor> {
    let payload: PlatformJwtPayload;
    try {
      payload = this.jwt.verify<PlatformJwtPayload>(raw, { secret: this.secret(), audience: PLATFORM_JWT_AUDIENCE });
    } catch {
      throw unauthorized('auth.invalidToken');
    }
    if (!payload?.sub || !payload.sid || payload.aud !== PLATFORM_JWT_AUDIENCE) throw unauthorized('auth.invalidToken');

    // Живость аккаунта и поколение токенов — общий валидатор (смена пароля отзывает и кабинет)
    await this.sessions.assertAlive({ sub: payload.sub, phone: '', role: '', epoch: payload.epoch, sid: payload.sid });

    const session = await this.db.platformSession.findUnique({ where: { id: payload.sid } });
    if (!session || session.userId !== payload.sub) throw unauthorized('auth.invalidToken');
    if (session.revokedAt) throw unauthorized('platform.session_revoked', undefined, { code: PLATFORM_ERROR_CODES.sessionRevoked });
    if (session.expiresAt.getTime() <= Date.now()) throw unauthorized('auth.sessionExpired');

    // Простой: серверная метка в Redis; промах (рестарт Redis) → берём lastActiveAt из БД
    const idleMs = PLATFORM_LIMITS.idleMinutes * 60_000;
    let lastActive = session.lastActiveAt.getTime();
    try {
      const cached = await this.redis.get(PLATFORM_REDIS.sessionActive(session.id));
      if (cached) lastActive = Math.max(lastActive, Number(cached));
    } catch {
      /* best-effort */
    }
    if (Date.now() - lastActive > idleMs) {
      await this.db.platformSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date() } });
      throw unauthorized('platform.session_idle', undefined, { code: PLATFORM_ERROR_CODES.sessionIdle });
    }

    const access = await this.access.accessOf(payload.sub);
    if (access.status !== 'active') throw forbidden('platform.not_staff', undefined, { code: PLATFORM_ERROR_CODES.notStaff });

    await this.touch(session.id);
    return {
      userId: payload.sub,
      sessionId: session.id,
      roles: access.roles,
      capabilities: access.capabilities,
      sudoUntil: await this.sudoUntil(session.id),
      sessionExpiresAt: session.expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    };
  }

  /** Метка активности: Redis (быстро) + БД раз в минуту (переживает рестарт Redis). */
  private async touch(sid: string): Promise<void> {
    const now = Date.now();
    try {
      await this.redis.set(PLATFORM_REDIS.sessionActive(sid), String(now), PLATFORM_LIMITS.sessionHours * 3600);
    } catch {
      /* best-effort */
    }
    // БД — не чаще раза в минуту: lastActiveAt старше минуты → обновить
    await this.db.platformSession
      .updateMany({ where: { id: sid, lastActiveAt: { lt: new Date(now - 60_000) } }, data: { lastActiveAt: new Date(now) } })
      .catch(() => undefined);
  }

  async sudoUntil(sid: string): Promise<Date | null> {
    try {
      const raw = await this.redis.get(PLATFORM_REDIS.sudo(sid));
      if (!raw) return null;
      const until = Number(raw);
      return until > Date.now() ? new Date(until) : null;
    } catch {
      return null;
    }
  }

  /** Высокорисковое действие сбрасывает таймер sudo. */
  async refreshSudo(sid: string): Promise<Date | null> {
    const current = await this.sudoUntil(sid);
    if (!current) return null;
    return this.setSudo(sid);
  }

  private async setSudo(sid: string): Promise<Date> {
    const until = new Date(Date.now() + PLATFORM_LIMITS.sudoMinutes * 60_000);
    await this.redis.set(PLATFORM_REDIS.sudo(sid), String(until.getTime()), PLATFORM_LIMITS.sudoMinutes * 60);
    return until;
  }

  // ============================================================
  // Step-up (sudo)
  // ============================================================

  async stepUpStart(actor: PlatformActor, password: string, ip?: string): Promise<VerifyStartResponse> {
    // Step-up — второй фактор перед опасной командой, поэтому пароль здесь считается
    // так же строго, как на входе: без счётчика угнанная сессия перебирала бы пароль
    // сотрудника бесплатно и без следа в журнале.
    const failKey = PLATFORM_REDIS.stepUpFail(actor.userId);
    let fails = 0;
    try {
      fails = Number((await this.redis.get(failKey)) ?? 0);
    } catch {
      /* best-effort */
    }
    if (fails >= PLATFORM_LIMITS.loginFailMax) {
      throw tooMany(
        'platform.login_blocked',
        { minutes: PLATFORM_LIMITS.loginBlockMinutes },
        { code: PLATFORM_ERROR_CODES.loginBlocked, resendInSec: PLATFORM_LIMITS.loginBlockMinutes * 60 },
      );
    }
    const user = await this.db.user.findUnique({ where: { id: actor.userId }, select: { phone: true, password: true } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      let n = 0;
      try {
        const client = this.redis.getClient();
        n = await client.incr(failKey);
        if (n === 1) await client.expire(failKey, PLATFORM_LIMITS.loginBlockMinutes * 60);
      } catch {
        /* best-effort */
      }
      await this.audit.writeDenied({
        actorId: actor.userId,
        actorRolesSnapshot: actor.roles,
        sessionId: actor.sessionId,
        requestId: actor.requestId,
        commandKey: PLATFORM_AUDIT_KEYS.stepUp,
        errorCode: 'auth.wrongPassword',
        readOnly: true,
        risk: 'high',
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      if (n === PLATFORM_LIMITS.loginFailMax) {
        await this.notifier.securityAlert(null, actor.userId, 'stepUpBurst', `${n}`).catch(() => undefined);
      }
      throw unauthorized('auth.wrongPassword');
    }
    try {
      await this.redis.del(failKey);
    } catch {
      /* best-effort */
    }
    return this.verify.startForPlatform(actor.userId, user.phone, 'platform_step_up', ip);
  }

  async stepUpConfirm(actor: PlatformActor, verifyToken: string): Promise<PlatformStepUpResponse> {
    await this.db.$transaction(async (tx) => {
      await this.verify.consume(tx, { verifyToken, purpose: 'platform_step_up', expectedUserId: actor.userId });
      await this.audit.write(tx, {
        actorId: actor.userId,
        sessionId: actor.sessionId,
        requestId: actor.requestId,
        commandKey: PLATFORM_AUDIT_KEYS.stepUp,
        outcome: 'ok',
        readOnly: true,
        risk: 'low',
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    });
    const until = await this.setSudo(actor.sessionId);
    return { sudoUntil: until.toISOString() };
  }

  // ============================================================
  // Выход и отзыв
  // ============================================================

  async logout(actor: PlatformActor): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.platformSession.updateMany({ where: { id: actor.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.write(tx, {
        actorId: actor.userId,
        sessionId: actor.sessionId,
        requestId: actor.requestId,
        commandKey: PLATFORM_AUDIT_KEYS.logout,
        outcome: 'ok',
        readOnly: true,
        risk: 'low',
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    });
    await this.forgetSession(actor.sessionId);
  }

  async revokeAll(tx: Tx | null, userId: string): Promise<void> {
    const db = tx ?? this.db;
    const rows = await db.platformSession.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
    await db.platformSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    for (const r of rows) await this.forgetSession(r.id);
  }

  private async forgetSession(sid: string): Promise<void> {
    try {
      await this.redis.del(PLATFORM_REDIS.sessionActive(sid));
      await this.redis.del(PLATFORM_REDIS.sudo(sid));
    } catch {
      /* best-effort */
    }
  }

  async me(actor: PlatformActor): Promise<PlatformMeDto> {
    const people = await this.access.peopleOf([actor.userId]);
    return {
      userId: actor.userId,
      person: people.get(actor.userId) ?? { id: actor.userId, firstName: '', lastName: null, avatar: null },
      roles: actor.roles,
      capabilities: actor.capabilities,
      sudoUntil: actor.sudoUntil?.toISOString() ?? null,
      sessionExpiresAt: actor.sessionExpiresAt.toISOString(),
      policy: await this.policy.get(),
    };
  }
}
