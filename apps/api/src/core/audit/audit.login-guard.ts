import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AUDIT_ERROR_CODES, AUDIT_LIMITS, type AuthFailReason } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { tooMany } from '../../shared/errors/api-error';
import { AUDIT_REDIS } from './audit.constants';
import { AuditMetrics } from './audit.metrics';
import { incrWindow } from '../../shared/redis/incr-window';
import { AuditService } from './audit.service';

type Tx = Prisma.TransactionClient;

/** Кто пытается войти: известный аккаунт или только номер (его HMAC-псевдоним). */
export interface LoginSubject {
  userId: string | null;
  /** `sa6m:` псевдоним номера ключом `audit` — счётчики и журнал без открытого номера */
  phoneHmac: string;
}

const lockKeyForUnknown = (phoneHmac: string) => `auth:lockp:${phoneHmac}`;
const failKeyOf = (s: LoginSubject) => (s.userId ? AUDIT_REDIS.loginFail(s.userId) : `auth:fail:p:${s.phoneHmac}`);
const lockedAttemptsKeyOf = (s: LoginSubject) => AUDIT_REDIS.lockedAttempts(s.userId ?? `p:${s.phoneHmac}`);
const levelKeyOf = (s: LoginSubject) => AUDIT_REDIS.lockLevel(s.userId ?? `p:${s.phoneHmac}`);
const stepUpFailKey = (userId: string) => `auth:stepup:fail:${userId}`;

/**
 * Защита входа по АККАУНТУ (а не только по IP): распределённый перебор и распыление по одному
 * номеру с тысячи адресов упираются в счётчик аккаунта. 5 неудач за 10 минут → блокировка
 * 15 минут, каждая следующая подряд (сутки) — вдвое дольше, не дольше суток. Во время блокировки
 * попытки построчно НЕ пишутся (флуд) — их итог `audit.lockout_summary` при снятии.
 *
 * Неизвестный номер блокируется ТАК ЖЕ (счётчик по HMAC номера в Redis): иначе ответ 429
 * против 401 отличал бы существующий аккаунт от несуществующего. Правда о блокировке известного
 * аккаунта — колонка `users.login_locked_until` (Redis мог потерять ключ); счётчик неудач —
 * Redis, при его недоступности — подсчёт событий журнала за окно.
 */
@Injectable()
export class AuditLoginGuard {
  private readonly logger = new Logger(AuditLoginGuard.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly metrics: AuditMetrics,
  ) {}

  /** Псевдоним номера для счётчиков и `details.targetHmac`. */
  phoneHmac(phone: string): Promise<string> {
    return this.audit.pseudonym(`phone:${phone}`);
  }

  /** До какого момента вход закрыт (null — открыт). Известный аккаунт — по колонке, неизвестный — по Redis. */
  async lockedUntil(s: LoginSubject, userLockedUntil: Date | null): Promise<Date | null> {
    const now = Date.now();
    if (s.userId) return userLockedUntil && userLockedUntil.getTime() > now ? userLockedUntil : null;
    try {
      const ttl = await this.redis.getClient().pttl(lockKeyForUnknown(s.phoneHmac));
      return ttl > 0 ? new Date(now + ttl) : null;
    } catch {
      return null;
    }
  }

  /**
   * НОВАЯ попытка во время блокировки: построчно не пишется (флуд — итог `audit.lockout_summary`),
   * но счётчик итога растёт и детекции её видят (`signal`: перебор «сверх блокировки», распыление,
   * подстановка) — и отказ 429 с Retry-After.
   */
  async rejectLocked(s: LoginSubject, until: Date): Promise<never> {
    await incrWindow(this.redis.getClient(), lockedAttemptsKeyOf(s), AUDIT_LIMITS.lockoutMaxMin * 60 * 2).catch(() => undefined);
    await this.audit.signal({
      key: 'auth.login.failed',
      subjectUserId: s.userId,
      outcome: 'failure',
      reasonCode: 'locked',
      details: { ...(s.userId ? {} : { targetHmac: s.phoneHmac }), attempt: 0 },
    });
    return this.lockedResponse(until);
  }

  /**
   * Пароль в step-up живой сессии (смена пароля/номера, ключи, подтверждение сессии): свой
   * счётчик неудач по аккаунту — 5 за окно первой ступени. Отдельно от блокировки входа: её
   * наводит любой, кто знает номер, и она не должна запирать смену пароля у сессии владельца;
   * а перебор пароля угнанной сессией упирается сюда.
   */
  async assertStepUpOpen(userId: string): Promise<void> {
    const client = this.redis.getClient();
    const [n, ttl] = await Promise.all([client.get(stepUpFailKey(userId)), client.pttl(stepUpFailKey(userId))]).catch(() => [null, 0] as const);
    if (Number(n ?? 0) >= AUDIT_LIMITS.lockoutAttempts && Number(ttl) > 0) this.lockedResponse(new Date(Date.now() + Number(ttl)));
  }

  async onStepUpFailure(userId: string): Promise<void> {
    await incrWindow(this.redis.getClient(), stepUpFailKey(userId), AUDIT_LIMITS.lockoutBaseMin * 60).catch(() => undefined);
  }

  /** Верный пароль step-up — счёт неудач с нуля (опечатки владельца не копятся в блок). */
  async onStepUpSuccess(userId: string): Promise<void> {
    await this.redis
      .getClient()
      .del(stepUpFailKey(userId))
      .catch(() => undefined);
  }

  /** Ответ «вход закрыт до …» (попытка уже посчитана `onFailure`). */
  lockedResponse(until: Date): never {
    throw tooMany('auth.locked', undefined, { code: AUDIT_ERROR_CODES.loginLocked, retryInSec: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)), lockedUntil: until.toISOString() });
  }

  /**
   * Неудачный вход: событие журнала (fail-closed — сбой базы = отказ 503, а не молчаливый пропуск
   * счёта), счётчик окна, на пороге — блокировка. Возвращает момент блокировки, если она стоит
   * (наступила этой попыткой или параллельной).
   */
  async onFailure(s: LoginSubject, reason: AuthFailReason): Promise<Date | null> {
    let attempt = 0;
    try {
      attempt = await incrWindow(this.redis.getClient(), failKeyOf(s), AUDIT_LIMITS.lockoutWindowMin * 60);
    } catch {
      attempt = s.userId ? (await this.audit.count({ key: 'auth.login.failed', subjectUserId: s.userId, sinceMs: AUDIT_LIMITS.lockoutWindowMin * 60_000 })) + 1 : 1;
    }
    await this.audit.record(null, {
      key: 'auth.login.failed',
      subjectUserId: s.userId,
      outcome: 'failure',
      reasonCode: reason,
      details: { ...(s.userId ? {} : { targetHmac: s.phoneHmac }), attempt },
    });
    if (attempt < AUDIT_LIMITS.lockoutAttempts) return null;
    return this.lock(s, attempt);
  }

  /**
   * Блокировка — ОДНА на залп. Параллельные неудачи пересекают порог разом (5, 6, 7… одним
   * INCR), и раньше КАЖДАЯ поднимала ступень: один залп из десятка запросов = блок на сутки и
   * десяток уведомлений «вход заблокирован». Теперь ставит блок тот, кто сменил «открыт» на
   * «закрыт» (status-guarded строка аккаунта / SET NX неизвестного номера), остальные получают
   * уже стоящий блок.
   */
  private async lock(s: LoginSubject, attempts: number): Promise<Date | null> {
    const client = this.redis.getClient();
    const base = AUDIT_LIMITS.lockoutBaseMin * 60_000;
    if (s.userId) {
      const userId = s.userId;
      const now = new Date();
      const claimed = await this.db.user.updateMany({
        where: { id: userId, OR: [{ loginLockedUntil: null }, { loginLockedUntil: { lte: now } }] },
        data: { loginLockedUntil: new Date(now.getTime() + base) },
      });
      if (!claimed.count) {
        const cur = await this.db.user.findUnique({ where: { id: userId }, select: { loginLockedUntil: true } });
        return cur?.loginLockedUntil && cur.loginLockedUntil.getTime() > Date.now() ? cur.loginLockedUntil : null;
      }
    } else {
      const won = await client.set(lockKeyForUnknown(s.phoneHmac), '1', 'PX', base, 'NX').catch(() => 'OK');
      if (won !== 'OK') {
        const ttl = await client.pttl(lockKeyForUnknown(s.phoneHmac)).catch(() => 0);
        return ttl > 0 ? new Date(Date.now() + ttl) : null;
      }
    }
    let level = 1;
    try {
      level = await incrWindow(client, levelKeyOf(s), 86_400);
    } catch {
      /* без Redis — первая ступень */
    }
    const minutes = Math.min(AUDIT_LIMITS.lockoutBaseMin * AUDIT_LIMITS.lockoutFactor ** (level - 1), AUDIT_LIMITS.lockoutMaxMin);
    const until = new Date(Date.now() + minutes * 60_000);
    // Итог отбитых во время ПРОШЛОЙ блокировки: при непрерывной атаке человек может не войти
    // вовсе — тогда итог иначе не записался бы никогда
    const blocked = s.userId ? Number((await client.getdel(lockedAttemptsKeyOf(s)).catch(() => null)) ?? 0) : 0;
    if (s.userId) {
      const userId = s.userId;
      await this.db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { loginLockedUntil: until } });
        if (blocked > 0) await this.audit.record(tx, { key: 'audit.lockout_summary', subjectUserId: userId, actor: { kind: 'system' }, details: { attempts: blocked } });
        await this.audit.record(tx, { key: 'auth.login.locked', subjectUserId: userId, outcome: 'denied', reasonCode: 'too_many_failures', details: { attempts, minutes, level }, notify: { params: { minutes } } });
      });
    } else {
      await client.set(lockKeyForUnknown(s.phoneHmac), '1', 'PX', minutes * 60_000).catch(() => undefined);
      await this.audit.record(null, { key: 'auth.login.locked', outcome: 'denied', reasonCode: 'too_many_failures', details: { attempts, minutes, level } });
    }
    await client.del(failKeyOf(s)).catch(() => undefined);
    this.metrics.lockouts.inc();
    return until;
  }

  /**
   * Удачный вход / сброс пароля — В ТРАНЗАКЦИИ входа: счётчик окна обнуляется, отметка блокировки
   * снимается, итог отбитых во время блокировки попыток пишется одной строкой.
   */
  async onSuccessTx(tx: Tx, userId: string): Promise<void> {
    const client = this.redis.getClient();
    const s: LoginSubject = { userId, phoneHmac: '' };
    let blocked = 0;
    try {
      blocked = Number((await client.getdel(lockedAttemptsKeyOf(s))) ?? 0);
      await client.del(failKeyOf(s));
    } catch {
      /* Redis недоступен — итог потерян, вход не ломаем */
    }
    await tx.user.updateMany({ where: { id: userId, loginLockedUntil: { not: null } }, data: { loginLockedUntil: null } });
    if (blocked > 0) await this.audit.record(tx, { key: 'audit.lockout_summary', subjectUserId: userId, actor: { kind: 'system' }, details: { attempts: blocked } });
  }

  /** Снять блокировку (сброс пароля, команда Кабинета, дев-полигон). */
  async unlockTx(tx: Tx, userId: string): Promise<boolean> {
    const { count } = await tx.user.updateMany({ where: { id: userId, loginLockedUntil: { not: null } }, data: { loginLockedUntil: null } });
    await this.onSuccessTx(tx, userId);
    try {
      await this.redis.getClient().del(levelKeyOf({ userId, phoneHmac: '' }), stepUpFailKey(userId));
    } catch {
      /* ступень истечёт сама */
    }
    return count > 0;
  }
}
