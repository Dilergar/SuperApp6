import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { DatabaseService } from '../../shared/database/database.service';
import { AUDIT_SEVERITIES } from '@superapp/shared';
import { AUDIT_REDIS } from './audit.constants';
import { AuditAlertsService, type AuditRaiseInput } from './audit.alerts.service';
import { AuditMetrics } from './audit.metrics';
import { incrWindow } from '../../shared/redis/incr-window';
import { AuditService, type AuditObservedEvent } from './audit.service';

/**
 * Пороги детекций v1 (решение плана: счётчики Redis + правила, тяжёлое — раз в минуту).
 * Сознательно константы движка, а не тариф и не настройка: это защита платформы, а не
 * продукт организации.
 */
export const AUDIT_DETECT = {
  /** Перебор пароля одного аккаунта сверх блокировки (блокировка — на 5-й) */
  bruteforceAccount: { threshold: 15, windowSec: 10 * 60 },
  /** Перебор с одной сети */
  bruteforceIp: { threshold: 30, windowSec: 10 * 60 },
  /** Распыление: столько разных аккаунтов с одной сети за час */
  spray: { accounts: 20, windowSec: 60 * 60 },
  /** Подстановка: доля неудач среди входов за минуту при объёме от */
  stuffing: { minAttempts: 100, failurePct: 40 },
  /** Поток SMS-кодов одному человеку */
  otpFatigue: { threshold: 5, windowSec: 5 * 60 },
  /** Массовая выгрузка/чтение ПДн одним актором за 10 минут, строк */
  massExport: { rows: 1000, windowSec: 10 * 60 },
  /** Вход после такого молчания, дней */
  dormantDays: 180,
  /** Потерянных записей журнала (best-effort/батч) за минуту — деградация */
  degradedPerMinute: 20,
} as const;

const minuteOf = (ms: number) => Math.floor(ms / 60_000);

/**
 * Детекции журнала безопасности (core/audit, `audit.detections.ts`). Наблюдатель записи:
 * на каждое подходящее событие — только INCR/SADD + сравнение с порогом (дёшево, вне
 * транзакции факта, сбой Redis детекцию просто пропускает). Тяжёлое (подстановка по доле
 * неудач, деградация журнала) — крон раз в минуту. Каждая тревога = строка `security_alerts`
 * + событие `detect.*` (+ CRITICAL — сигнал владельцам платформы).
 */
@Injectable()
export class AuditDetections implements OnModuleInit {
  private readonly logger = new Logger(AuditDetections.name);

  constructor(
    private readonly audit: AuditService,
    private readonly alerts: AuditAlertsService,
    private readonly redis: RedisService,
    private readonly db: DatabaseService,
    private readonly metrics: AuditMetrics,
  ) {}

  onModuleInit(): void {
    this.audit.observe('detections', { after: (e) => void this.observe(e).catch((err: unknown) => this.logger.debug(`detection skipped: ${err instanceof Error ? err.message : String(err)}`)) });
  }

  private bump(rule: string, key: string, windowSec: number, by = 1): Promise<number> {
    return incrWindow(this.redis.getClient(), AUDIT_REDIS.detect(rule, key), windowSec, by);
  }

  private raise(input: AuditRaiseInput): Promise<unknown> {
    return this.alerts.raise(input).catch((err: unknown) => this.logger.warn(`alert ${input.kind} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  async observe(e: AuditObservedEvent): Promise<void> {
    switch (e.key) {
      case 'auth.login.failed':
        return this.loginFailed(e);
      case 'auth.login.success':
        await this.loginSucceeded();
        return this.dormant(e);
      case 'pd.transfer':
        if (e.details.purpose === 'otp_sms' && e.subjectUserId) return this.otp(e.subjectUserId, e);
        return;
      case 'data.export':
        return this.volume(e, typeof e.details.rows === 'number' ? e.details.rows : 0);
      case 'pii.read':
        return this.volume(e, typeof e.details.count === 'number' ? e.details.count : 0);
      default:
        return;
    }
  }

  private async loginFailed(e: AuditObservedEvent): Promise<void> {
    await this.bump('login_fail', String(minuteOf(Date.now())), 180);
    // Аккаунт: известный — по id, неизвестный номер — по псевдониму (details.targetHmac)
    const account = e.subjectUserId ?? (typeof e.details.targetHmac === 'string' ? e.details.targetHmac : null);
    if (account) {
      const n = await this.bump('bf_acct', account, AUDIT_DETECT.bruteforceAccount.windowSec);
      if (n === AUDIT_DETECT.bruteforceAccount.threshold) {
        await this.raise({
          kind: 'bruteforce_account',
          severity: 'high',
          dedupeKey: `acct:${account}`,
          subjectUserId: e.subjectUserId,
          evidence: [e.id],
          finding: { events: n, accounts: 1, windowMin: AUDIT_DETECT.bruteforceAccount.windowSec / 60 },
        });
      }
    }
    if (!e.ipHmac) return;
    const perIp = await this.bump('bf_ip', e.ipHmac, AUDIT_DETECT.bruteforceIp.windowSec);
    if (perIp === AUDIT_DETECT.bruteforceIp.threshold) {
      await this.raise({
        kind: 'bruteforce_ip',
        severity: 'high',
        dedupeKey: `ip:${e.ipHmac}`,
        ipHmac: e.ipHmac,
        evidence: [e.id],
        finding: { events: perIp, networks: 1, windowMin: AUDIT_DETECT.bruteforceIp.windowSec / 60 },
        platformEvent: 'bruteforceIp',
      });
    }
    if (account) {
      const k = AUDIT_REDIS.detect('spray', e.ipHmac);
      // Одним MULTI: множество без срока (сбой между SADD и EXPIRE) копило бы аккаунты вечно
      const res = await this.redis.getClient().multi().sadd(k, account).expire(k, AUDIT_DETECT.spray.windowSec, 'NX').scard(k).exec();
      const added = Number(res?.[0]?.[1] ?? 0);
      const accounts = Number(res?.[2]?.[1] ?? 0);
      if (added && accounts === AUDIT_DETECT.spray.accounts) {
        await this.raise({
          kind: 'password_spray',
          severity: 'critical',
          dedupeKey: `ip:${e.ipHmac}`,
          ipHmac: e.ipHmac,
          evidence: [e.id],
          finding: { events: perIp, accounts, networks: 1, windowMin: AUDIT_DETECT.spray.windowSec / 60 },
          platformEvent: 'passwordSpray',
        });
      }
    }
  }

  private async loginSucceeded(): Promise<void> {
    await this.bump('login_ok', String(minuteOf(Date.now())), 180);
  }

  /** Первый вход после долгого молчания — сигнал угона «спящего» аккаунта. */
  private async dormant(e: AuditObservedEvent): Promise<void> {
    if (!e.subjectUserId) return;
    const prev = await this.db.securityEvent.findFirst({
      where: { eventKey: 'auth.login.success', subjectUserId: e.subjectUserId, occurredAt: { lt: e.occurredAt }, NOT: { eventId: e.eventId } },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });
    if (!prev) return;
    const silentDays = Math.floor((e.occurredAt.getTime() - prev.occurredAt.getTime()) / 86_400_000);
    if (silentDays < AUDIT_DETECT.dormantDays) return;
    await this.raise({
      kind: 'dormant_login',
      severity: 'medium',
      dedupeKey: `acct:${e.subjectUserId}`,
      subjectUserId: e.subjectUserId,
      evidence: [e.id],
      finding: { events: 1, accounts: 1, windowMin: silentDays * 24 * 60 },
    });
  }

  private async otp(userId: string, e: AuditObservedEvent): Promise<void> {
    const n = await this.bump('otp', userId, AUDIT_DETECT.otpFatigue.windowSec);
    if (n !== AUDIT_DETECT.otpFatigue.threshold) return;
    await this.raise({
      kind: 'otp_fatigue',
      severity: 'high',
      dedupeKey: `acct:${userId}`,
      subjectUserId: userId,
      evidence: [e.id].filter((id) => id !== '0'),
      finding: { events: n, accounts: 1, windowMin: AUDIT_DETECT.otpFatigue.windowSec / 60 },
    });
  }

  /** Объём выгрузок и чтений ПДн одним актором (ключ API, бот, человек, сотрудник). */
  private async volume(e: AuditObservedEvent, rows: number): Promise<void> {
    if (!e.actorId || rows <= 0) return;
    const total = await this.bump('volume', e.actorId, AUDIT_DETECT.massExport.windowSec, Math.min(rows, 10_000_000));
    // Порог пересечён ЭТИМ событием — одна тревога на окно, а не на каждое следующее
    if (total < AUDIT_DETECT.massExport.rows || total - rows >= AUDIT_DETECT.massExport.rows) return;
    await this.raise({
      kind: 'mass_export',
      severity: 'high',
      dedupeKey: `actor:${e.actorId}`,
      subjectUserId: e.actorKind === 'user' ? e.actorId : null,
      workspaceId: e.workspaceId,
      evidence: [e.id].filter((id) => id !== '0'),
      finding: { events: 1, rows: total, windowMin: AUDIT_DETECT.massExport.windowSec / 60 },
      platformEvent: 'massExport',
      // Выгрузка внутри организации — её владелец узнаёт сам (план §6.7); ссылка — на событие,
      // которое организация видит в своём журнале (личная выгрузка «Мои данные» — не её дело)
      ...(e.workspaceId && e.visWorkspace && e.id !== '0'
        ? { orgNotice: { eventId: e.id, rows: total, windowMin: AUDIT_DETECT.massExport.windowSec / 60, actorId: e.actorId } }
        : {}),
    });
  }

  /**
   * [dev] Посев правила синтетическими событиями (строк журнала нет) — проверка порогов без
   * настоящих 20 неудачных входов (их остановил бы троттлинг входа). Только дев-полигон.
   */
  async seed(kind: 'password_spray' | 'bruteforce_ip' | 'otp_fatigue' | 'mass_export' | 'credential_stuffing', subjectUserId: string, org?: { workspaceId: string; eventId: string }): Promise<{ dedupeKey: string }> {
    const tag = Math.random().toString(36).slice(2, 10);
    const ipHmac = `sa6m:1:dev:${tag}`;
    // Синтетический субъект: счётчики окна живут в Redis между прогонами — порог «пересечён
    // этим событием» у настоящего человека второй прогон уже не повторил бы
    void subjectUserId;
    subjectUserId = randomUUID();
    const base = (key: AuditObservedEvent['key'], extra: Partial<AuditObservedEvent>): AuditObservedEvent =>
      ({ id: '0', eventId: '00000000-0000-0000-0000-000000000000', occurredAt: new Date(), key, def: undefined as never, outcome: 'failure', reasonCode: null, actorKind: 'anonymous', actorId: null, subjectUserId: null, workspaceId: null, visWorkspace: false, ipHmac, targetType: null, targetId: null, country: null, client: 'web', uaFamily: null, requestId: null, details: {}, ...extra }) as AuditObservedEvent;
    switch (kind) {
      case 'password_spray':
        for (let i = 0; i < AUDIT_DETECT.spray.accounts; i++) await this.observe(base('auth.login.failed', { details: { targetHmac: `sa6m:1:dev:acct-${tag}-${i}` } }));
        return { dedupeKey: `ip:${ipHmac}` };
      case 'bruteforce_ip':
        for (let i = 0; i < AUDIT_DETECT.bruteforceIp.threshold; i++) await this.observe(base('auth.login.failed', { details: {} }));
        return { dedupeKey: `ip:${ipHmac}` };
      case 'otp_fatigue':
        for (let i = 0; i < AUDIT_DETECT.otpFatigue.threshold; i++) await this.observe(base('pd.transfer', { outcome: 'success', subjectUserId, details: { purpose: 'otp_sms' } }));
        return { dedupeKey: `acct:${subjectUserId}` };
      case 'mass_export':
        // С организацией — событие-причина из её журнала: проверка уведомления владельцу
        await this.observe(base('data.export', { outcome: 'success', actorKind: 'user', actorId: subjectUserId, details: { rows: AUDIT_DETECT.massExport.rows + 1 }, ...(org ? { id: org.eventId, workspaceId: org.workspaceId, visWorkspace: true } : {}) }));
        return { dedupeKey: `actor:${subjectUserId}` };
      case 'credential_stuffing': {
        const minute = String(minuteOf(Date.now()));
        await this.bump('login_fail', minute, 180, 80);
        await this.bump('login_ok', minute, 180, 40);
        await this.tickNow(Date.now() + 60_000);
        return { dedupeKey: `wave:${Math.floor(minuteOf(Date.now() + 60_000) / 10)}` };
      }
    }
  }

  // ============================================================
  // Тяжёлые правила — раз в минуту
  // ============================================================

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    await this.redis.withLock(AUDIT_REDIS.lock('detect'), 50_000, async () => {
      await this.tickNow();
      await this.gaugeOpenAlerts();
    });
  }

  /** Метрика «открытые тревоги по серьёзности» (очередь разбора; индекс `(status, opened_at)`). */
  private async gaugeOpenAlerts(): Promise<void> {
    const rows = await this.db.securityAlert.groupBy({ by: ['severity'], where: { status: { in: ['open', 'ack'] } }, _count: { _all: true } });
    const bySeverity = new Map(rows.map((r) => [r.severity, r._count._all]));
    for (const sev of AUDIT_SEVERITIES) this.metrics.alertsOpen.set({ severity: sev }, bySeverity.get(sev) ?? 0);
  }

  /** Подстановка учёток (доля неудач прошлой минуты) и деградация журнала (потерянные записи). */
  async tickNow(now = Date.now()): Promise<{ stuffing: boolean; degraded: boolean }> {
    const client = this.redis.getClient();
    const prev = String(minuteOf(now) - 1);
    const [failRaw, okRaw] = await client.mget(AUDIT_REDIS.detect('login_fail', prev), AUDIT_REDIS.detect('login_ok', prev));
    const fail = Number(failRaw ?? 0);
    const total = fail + Number(okRaw ?? 0);
    let stuffing = false;
    if (total >= AUDIT_DETECT.stuffing.minAttempts) {
      const pct = Math.round((fail / total) * 100);
      if (pct > AUDIT_DETECT.stuffing.failurePct) {
        stuffing = true;
        await this.raise({
          kind: 'credential_stuffing',
          severity: 'critical',
          // Одна тревога на 10-минутную волну
          dedupeKey: `wave:${Math.floor(minuteOf(now) / 10)}`,
          finding: { events: total, windowMin: 1, failureRatePct: pct },
          platformEvent: 'credentialStuffing',
        });
      }
    }
    // Потерянные записи журнала за прошлую минуту — общий счётчик ВСЕХ инстансов (Redis): метрика
    // процесса видна только своему инстансу, а крон под локом достаётся любому из них
    const delta = Number((await client.get(AUDIT_REDIS.writeFailures(minuteOf(now) - 1))) ?? 0);
    let degraded = false;
    if (delta >= AUDIT_DETECT.degradedPerMinute) {
      degraded = true;
      await this.raise({
        kind: 'audit_degraded',
        severity: 'critical',
        dedupeKey: `hour:${Math.floor(minuteOf(now) / 60)}`,
        finding: { failures: delta, windowMin: 1 },
        platformEvent: 'auditDegraded',
      });
    }
    return { stuffing, degraded };
  }
}
