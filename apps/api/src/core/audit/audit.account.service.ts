import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AUDIT_ERROR_CODES, AUDIT_LIMITS, AUDIT_REGISTRY, PD_RECIPIENTS, isAuditEventKey, type NotMeResultDto } from '@superapp/shared';
import { coerceLocale } from '@superapp/i18n';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { authAliveKey } from '../../shared/auth/session-validator.service';
import { badRequest, notFound, tooMany } from '../../shared/errors/api-error';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';
import { AnalyticsService } from '../analytics/analytics.service';
import { KeysCascadesService } from '../keys/api-keys/keys.cascades.service';
import { VerifyService } from '../verify/verify.service';
import { StepUpService } from '../verify/step-up.service';
import { SmsOutboundService } from '../verify/sms-outbound.service';
import { ConsentsService } from '../consents/consents.service';
import { AUDIT_REDIS } from './audit.constants';
import { incrWindow } from '../../shared/redis/incr-window';
import { AuditService } from './audit.service';
import { AuditQueryService } from './audit.query.service';
import { AuditSessionsService } from './audit.sessions.service';
import { AuditLoginGuard } from './audit.login-guard';
import { auditOutcomeOf } from './audit.codes';

type Tx = Prisma.TransactionClient;

/** Финал «Это не я» принимается в течение суток после старта мастера. */
const NOT_ME_WIZARD_MS = 86_400_000;

/**
 * Аккаунт под угрозой (core/audit): экстренная заморозка без входа, разморозка паролем + SMS,
 * мастер «Это не я». Всё, что гасит доступ, — ОДНОЙ транзакцией с событием журнала; сеть
 * (SMS, отзыв токена у Google) — после коммита.
 */
@Injectable()
export class AuditAccountService {
  private readonly logger = new Logger(AuditAccountService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly events: EventBusService,
    private readonly i18n: I18nService,
    private readonly audit: AuditService,
    private readonly query: AuditQueryService,
    private readonly sessions: AuditSessionsService,
    private readonly loginGuard: AuditLoginGuard,
    private readonly verify: VerifyService,
    private readonly sms: SmsOutboundService,
    private readonly cascades: KeysCascadesService,
    private readonly consents: ConsentsService,
    private readonly analytics: AnalyticsService,
    private readonly stepUp: StepUpService,
  ) {}

  /**
   * Поколение токенов вперёд = отзыв ВСЕХ выданных access-токенов (JwtStrategy сверяет epoch) —
   * и личных ключей API (ключ = сессия без срока). В транзакции действия; кэш «жив» чистит
   * вызывающий после коммита.
   */
  async bumpTokenEpochTx(tx: Tx, userId: string): Promise<{ epoch: number; keysRevoked: number }> {
    const before = await tx.apiKey.count({ where: { kind: 'pat', userId, revokedAt: null } });
    const user = await tx.user.update({ where: { id: userId }, data: { tokenEpoch: { increment: 1 } }, select: { tokenEpoch: true } });
    await this.cascades.onTokenEpochBump(tx, userId);
    return { epoch: user.tokenEpoch, keysRevoked: before };
  }

  /** После коммита отзыва: кэш «жив», отметки отозванных семейств, живые сокеты. */
  async afterAccessRevoked(userId: string, families: string[]): Promise<void> {
    await this.redis.cache.forget(authAliveKey(userId));
    await this.redis.cache.delPattern(`user:${userId}:*`).catch(() => undefined);
    await this.sessions.markFamiliesRevoked(families);
    // Окна «сильного подтверждения» (ключи, раскрытие строгих полей) — вместе с сессиями: после
    // «выйти везде», смены пароля или «Это не я» раскрыть ИИН без нового SMS нельзя
    await this.stepUp.end(userId);
    this.events.emit('auth.sessions.revoked', { userId }, 'audit');
  }

  // ============================================================
  // Заморозка без входа
  // ============================================================

  /**
   * Гашение пропуска `account_freeze` → заморозка: вход, все сессии (и Кабинета), личные ключи
   * API закрыты. Повторная заморозка — идемпотентна (уже заморожен → пропуск гасится, ответ тот же).
   */
  async freeze(verifyToken: string): Promise<{ frozen: true }> {
    const out = await this.db.$transaction(async (tx) => {
      const consumed = await this.verify.consume(tx, { verifyToken, purpose: 'account_freeze' });
      const userId = consumed.userId;
      if (!userId) throw badRequest('auth.verifyStale');
      const now = new Date();
      const claimed = await tx.user.updateMany({ where: { id: userId, securityFrozenAt: null, deletedAt: null }, data: { securityFrozenAt: now, securityFrozenReason: 'self' } });
      if (claimed.count === 0) return { userId, families: [] as string[], fresh: false, phone: consumed.phone };
      const bump = await this.bumpTokenEpochTx(tx, userId);
      const revoked = await this.sessions.revokeFamilies(tx, userId, {}, 'freeze');
      await tx.platformSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      await this.audit.record(tx, {
        key: 'account.frozen',
        subjectUserId: userId,
        actor: { kind: 'anonymous' },
        details: { by: 'self', sessionsRevoked: revoked.count, keysRevoked: bump.keysRevoked },
        evidence: { factor: 'sms', verifyChallengeId: consumed.challengeId },
      });
      await this.analytics.track(tx, 'auth.account.frozen', { by: 'self' }, { userId, workspaceId: null });
      return { userId, families: revoked.families, fresh: true, phone: consumed.phone };
    });
    if (out.fresh) {
      await this.afterAccessRevoked(out.userId, out.families);
      await this.smsAlert(out.userId, out.phone, 'notifications.security.account.frozen.title');
    }
    return { frozen: true };
  }

  /**
   * Разморозка паролем + SMS (пароль проверен на старте цепочки) — В ТРАНЗАКЦИИ вызывающего
   * (AuthService следом выдаёт сессию входа). Возвращает id разморожённого аккаунта.
   */
  async unfreezeTx(tx: Tx, verifyToken: string): Promise<string> {
    const consumed = await this.verify.consume(tx, { verifyToken, purpose: 'account_unfreeze' });
    const userId = consumed.userId;
    if (!userId) throw badRequest('auth.verifyStale');
    const { count } = await tx.user.updateMany({ where: { id: userId, securityFrozenAt: { not: null }, deletedAt: null }, data: { securityFrozenAt: null, securityFrozenReason: null } });
    if (count === 0) throw badRequest('auth.notFrozen');
    await this.loginGuard.unlockTx(tx, userId);
    await this.audit.record(tx, {
      key: 'account.unfrozen',
      subjectUserId: userId,
      actor: { kind: 'user', id: userId },
      details: { by: 'self' },
      evidence: { factor: 'password+sms', verifyChallengeId: consumed.challengeId },
    });
    return userId;
  }

  /** Разморозка командой Кабинета (проверка личности — вне системы, по регламенту поддержки). */
  async unfreezeByPlatformTx(tx: Tx, userId: string): Promise<boolean> {
    const { count } = await tx.user.updateMany({ where: { id: userId, securityFrozenAt: { not: null }, deletedAt: null }, data: { securityFrozenAt: null, securityFrozenReason: null } });
    if (count === 0) return false;
    await this.loginGuard.unlockTx(tx, userId);
    await this.audit.record(tx, { key: 'account.unfrozen', subjectUserId: userId, details: { by: 'platform' } });
    return true;
  }

  /** Заморозка командой Кабинета (угон, компрометация): тот же эффект, что у человека. */
  async freezeByPlatformTx(tx: Tx, userId: string): Promise<{ families: string[]; changed: boolean }> {
    const now = new Date();
    const claimed = await tx.user.updateMany({ where: { id: userId, securityFrozenAt: null, deletedAt: null }, data: { securityFrozenAt: now, securityFrozenReason: 'platform' } });
    if (claimed.count === 0) return { families: [], changed: false };
    const bump = await this.bumpTokenEpochTx(tx, userId);
    const revoked = await this.sessions.revokeFamilies(tx, userId, {}, 'freeze');
    await tx.platformSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await this.audit.record(tx, { key: 'account.frozen', subjectUserId: userId, details: { by: 'platform', sessionsRevoked: revoked.count, keysRevoked: bump.keysRevoked } });
    return { families: revoked.families, changed: true };
  }

  /** SMS о заморозке — best-effort после коммита (≤ 1 в час), без ссылок; след передачи номера оператору. */
  private async smsAlert(userId: string, phone: string, titleKey: string): Promise<void> {
    try {
      const user = await this.db.user.findUnique({ where: { id: userId }, select: { locale: true } });
      const locale = coerceLocale(user?.locale);
      const sent = await this.sms.sendAccountAlert(userId, phone, `SuperApp6: ${this.i18n.translateFor(locale, titleKey)}`);
      if (!sent) return;
      const k = PD_RECIPIENTS.kazinfoteh;
      await this.audit.recordBestEffort({
        key: 'pd.transfer',
        subjectUserId: userId,
        actor: { kind: 'system' },
        details: { recipient: 'kazinfoteh', recipientCountry: k.country, basis: k.basis, fields: ['phone', 'notification_text'], purpose: 'notification_sms', crossBorder: k.crossBorder },
      });
    } catch (err) {
      this.logger.warn(`freeze SMS was not sent: ${(err as Error).message}`);
    }
  }

  // ============================================================
  // «Это не я»
  // ============================================================

  /**
   * Шаг 1 мастера: событие оспорено → завершены все ДРУГИЕ сессии, забыты чужие устройства,
   * отозваны личные ключи API (без бампа эпохи — текущая сессия остаётся), отключён Google.
   * Cooling-гард: свежая неподтверждённая сессия (угонщик с паролем) мастер не запустит.
   */
  async notMeStart(user: JwtPayload, eventId: string): Promise<NotMeResultDto> {
    await this.sessions.assertConfirmed(user);
    await this.rateLimit(user.sub);
    const event = await this.query.rawOne({ kind: 'subject', userId: user.sub }, eventId);
    if (!event) throw notFound('audit.event_not_found', undefined, { code: AUDIT_ERROR_CODES.eventNotFound });
    const def = isAuditEventKey(event.eventKey) ? AUDIT_REGISTRY[event.eventKey] : undefined;
    if (!def?.disputable || auditOutcomeOf(event.outcome) !== 'success') throw badRequest('audit.not_disputable', undefined, { code: AUDIT_ERROR_CODES.notDisputable });
    const currentFamily = await this.sessions.currentFamilyOf(user);
    const current = currentFamily ? await this.db.session.findFirst({ where: { familyId: currentFamily }, select: { deviceId: true } }) : null;
    const ref = { type: 'security_event', id: eventId };

    const out = await this.db.$transaction(async (tx) => {
      await this.audit.record(tx, { key: 'account.event_disputed', ref, details: {} });
      const revoked = await this.sessions.revokeFamilies(tx, user.sub, { except: currentFamily }, 'not_me');
      const forgotten = await tx.userDevice.updateMany({
        where: { userId: user.sub, forgottenAt: null, ...(current?.deviceId ? { deviceId: { not: current.deviceId } } : {}) },
        data: { forgottenAt: new Date(), trustedAt: null },
      });
      const keysRevoked = await this.cascades.revokePersonalKeys(tx, user.sub, 'not_me');
      // НЕ служебный отзыв: у служебного хуки не бегут (им пользуется кнопка «Отключить», которая
      // сама удаляет подключение) — и мастер отзывал бы согласие, оставляя токены Google живыми.
      // Хук владельца данных удаляет подключение здесь же, токен у Google гасится после коммита.
      const google = await this.consents.revoke(tx, { subject: { type: 'user', id: user.sub }, documentKey: 'integration_google', actorUserId: user.sub, reason: 'not_me' });
      const result: NotMeResultDto = { sessionsRevoked: revoked.count, devicesForgotten: forgotten.count, keysRevoked, googleDisconnected: google.revoked > 0 };
      await this.audit.record(tx, { key: 'account.not_me_started', ref, details: result });
      return { result, families: revoked.families, googleAfter: google.afterCommit };
    });
    await this.sessions.markFamiliesRevoked(out.families);
    await this.redis.cache.delPattern(`user:${user.sub}:*`).catch(() => undefined);
    this.events.emit('auth.sessions.revoked', { userId: user.sub }, 'audit');
    await out.googleAfter().catch((err: unknown) => this.logger.warn(`google disconnect after "not me" failed: ${err instanceof Error ? err.message : String(err)}`));
    return out.result;
  }

  /**
   * Финал мастера: что человек сделал на шагах 3–4 (смена пароля и номера — своими ручками).
   * Журнал — улика, а не пересказ клиента: «пароль сменён» берётся из события смены пароля ПОСЛЕ
   * старта мастера, а не из тела запроса; финал без старта по этому событию — отказ; повтор финала
   * (двойной клик, ретрай) второго события и второго уведомления не пишет.
   */
  async notMeComplete(user: JwtPayload, input: { eventId: string; passwordChanged: boolean; phoneConfirmed: boolean }): Promise<{ completed: true }> {
    const event = await this.query.rawOne({ kind: 'subject', userId: user.sub }, input.eventId);
    if (!event) throw notFound('audit.event_not_found', undefined, { code: AUDIT_ERROR_CODES.eventNotFound });
    const ref = { refType: 'security_event', refId: input.eventId };
    const started = await this.db.securityEvent.findFirst({
      where: { eventKey: 'account.not_me_started', subjectUserId: user.sub, ...ref, occurredAt: { gt: new Date(Date.now() - NOT_ME_WIZARD_MS) } },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });
    if (!started) throw badRequest('audit.not_disputable', undefined, { code: AUDIT_ERROR_CODES.notDisputable });
    const since = { gte: started.occurredAt };
    const [done, passwordChanged, phoneChanged] = await Promise.all([
      this.db.securityEvent.count({ where: { eventKey: 'account.not_me_completed', subjectUserId: user.sub, ...ref, occurredAt: since } }),
      this.db.securityEvent.count({ where: { eventKey: { in: ['auth.password.changed', 'auth.password.reset_completed'] }, subjectUserId: user.sub, occurredAt: since } }),
      this.db.securityEvent.count({ where: { eventKey: 'auth.phone.changed', subjectUserId: user.sub, occurredAt: since } }),
    ]);
    if (done > 0) return { completed: true };
    const details = { credentialsRotated: passwordChanged > 0, numberConfirmed: phoneChanged > 0 || input.phoneConfirmed };
    await this.db.$transaction(async (tx) => {
      await this.audit.record(tx, { key: 'account.not_me_completed', ref: { type: 'security_event', id: input.eventId }, details });
      await this.analytics.track(tx, 'audit.not_me.completed', details, { userId: user.sub, workspaceId: null });
    });
    return { completed: true };
  }

  private async rateLimit(userId: string): Promise<void> {
    try {
      const n = await incrWindow(this.redis.getClient(), AUDIT_REDIS.notMe(userId), 3600);
      if (n > AUDIT_LIMITS.notMePerHour) throw tooMany('http.tooManyRequests', undefined, { retryInSec: 3600 });
    } catch (err) {
      if ((err as { getStatus?: () => number }).getStatus?.() === 429) throw err;
      /* Redis недоступен — без потолка (действие защищает человека) */
    }
  }
}
