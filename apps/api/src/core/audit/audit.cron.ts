import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AUDIT_LIMITS, type AuditDeviceClass } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { AUDIT_REDIS } from './audit.constants';
import { AuditPartitions } from './audit.partitions';
import { AuditService } from './audit.service';
import { AuditSessionsService } from './audit.sessions.service';
import { AuditViewedService } from './audit.viewed';

const DEVICE_CLASSES = new Set(['desktop', 'mobile', 'tablet', 'other']);
/** Самый короткий допустимый срок автозавершения — нижняя граница выборки кандидатов. */
const MIN_IDLE_DAYS = Math.min(...AUDIT_LIMITS.sessionMaxIdleDaysOptions);

/**
 * Кроны журнала безопасности (лок Redis — один инстанс):
 *  - партиции на три месяца вперёд (ежедневно; на буте — тоже);
 *  - автозавершение неактивных сессий по настройке человека (`session_max_idle_days`, 90 по
 *    умолчанию) — одно агрегатное событие на человека за прогон;
 *  - устройства без активности год → забыты (событие без уведомления); забытые старше года —
 *    удаляются (журнал хранит события, строка устройства — нет);
 *  - агрегат «кто смотрел журнал» за завершённые часы → события `audit.viewed`;
 *  - закрытые тревоги старше года удаляются: `security_alerts` — рабочая очередь разбора,
 *    а факт тревоги навсегда остаётся событием `detect.*` журнала.
 */
@Injectable()
export class AuditCron {
  private readonly logger = new Logger(AuditCron.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly partitions: AuditPartitions,
    private readonly sessions: AuditSessionsService,
    private readonly viewed: AuditViewedService,
  ) {}

  @Cron('5 * * * *')
  async viewedFlush(): Promise<void> {
    await this.redis.withLock(AUDIT_REDIS.lock('viewed'), 10 * 60_000, () => this.viewed.flush());
  }

  @Cron('7 3 * * *')
  async partitionsAhead(): Promise<void> {
    await this.redis.withLock(AUDIT_REDIS.lock('partitions'), 5 * 60_000, () => this.partitions.ensureAhead());
  }

  @Cron(CronExpression.EVERY_HOUR)
  async expireInactive(): Promise<number> {
    const done = await this.redis.withLock(AUDIT_REDIS.lock('inactive'), 30 * 60_000, () => this.expireInactiveNow());
    return done ?? 0;
  }

  /** Головы живых семейств, чья последняя активность старше настройки владельца. */
  async expireInactiveNow(): Promise<number> {
    // Нижний порог настройки (MIN_IDLE_DAYS) — диапазон по частичному индексу голов (last_seen_at);
    // без него условие через колонку users читало бы ВСЕ живые сессии платформы каждый час
    const rows = await this.db.$queryRaw<Array<{ user_id: string; family_id: string; idle: number }>>`
      SELECT s.user_id, s.family_id, u.session_max_idle_days AS idle
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.revoked_at IS NULL AND s.rotated_at IS NULL
        AND s.last_seen_at < (now() AT TIME ZONE 'UTC') - make_interval(days => ${MIN_IDLE_DAYS}::int)
        AND s.last_seen_at < (now() AT TIME ZONE 'UTC') - make_interval(days => u.session_max_idle_days)
      LIMIT 5000`;
    const byUser = new Map<string, { families: string[]; idle: number }>();
    for (const r of rows) {
      const e = byUser.get(r.user_id) ?? { families: [], idle: Number(r.idle) };
      e.families.push(r.family_id);
      byUser.set(r.user_id, e);
    }
    let total = 0;
    for (const [userId, e] of byUser) {
      const revoked = await this.db.$transaction(async (tx) => {
        const r = await this.sessions.revokeFamilies(tx, userId, { only: e.families }, 'inactive');
        if (r.count) await this.audit.record(tx, { key: 'auth.session.expired_inactive', subjectUserId: userId, actor: { kind: 'system' }, details: { sessions: r.count, idleDays: e.idle } });
        return r;
      });
      await revoked.afterCommit();
      total += revoked.count;
    }
    if (total) this.logger.log(`inactive sessions ended: ${total}`);
    return total;
  }

  @Cron('41 4 * * *')
  async devices(): Promise<void> {
    await this.redis.withLock(AUDIT_REDIS.lock('devices'), 30 * 60_000, () => this.devicesNow());
  }

  /**
   * Порциями до исчерпания (в пределах бюджета времени лока): 2000 за ночь на миллионах
   * аккаунтов копили бы отставание навсегда. Бюджет вышел — остальное завтра.
   */
  async devicesNow(budgetMs = 20 * 60_000): Promise<{ forgotten: number; purged: number }> {
    const cutoff = new Date(Date.now() - AUDIT_LIMITS.deviceForgetAfterDays * 86_400_000);
    const deadline = Date.now() + budgetMs;
    let forgotten = 0;
    for (;;) {
      const stale = await this.db.userDevice.findMany({ where: { forgottenAt: null, lastSeenAt: { lt: cutoff } }, take: 2000, select: { id: true, userId: true, deviceClass: true } });
      await this.forgetStale(stale);
      forgotten += stale.length;
      if (stale.length < 2000 || Date.now() > deadline) break;
    }
    // Забытые старше года — по частичному индексу `forgotten_at`
    const purged = await this.db.userDevice.deleteMany({ where: { forgottenAt: { lt: cutoff } } });
    return { forgotten, purged: purged.count };
  }

  private async forgetStale(stale: Array<{ id: string; userId: string; deviceClass: string }>): Promise<void> {
    for (const d of stale) {
      await this.db.$transaction(async (tx) => {
        const { count } = await tx.userDevice.updateMany({ where: { id: d.id, forgottenAt: null }, data: { forgottenAt: new Date(), trustedAt: null } });
        if (!count) return;
        await this.audit.record(tx, {
          key: 'account.device_forgotten',
          subjectUserId: d.userId,
          actor: { kind: 'system' },
          target: { type: 'user_device', id: d.id },
          details: { deviceClass: (DEVICE_CLASSES.has(d.deviceClass) ? d.deviceClass : 'other') as AuditDeviceClass, auto: true, sessionsRevoked: 0 },
          notify: false,
        });
      });
    }
  }

  @Cron('47 4 * * *')
  async alerts(): Promise<void> {
    await this.redis.withLock(AUDIT_REDIS.lock('alerts'), 10 * 60_000, () => this.alertsNow());
  }

  /** Закрытые тревоги старше срока — порциями (открытые и в работе не трогаются никогда). */
  async alertsNow(): Promise<number> {
    const cutoff = new Date(Date.now() - AUDIT_LIMITS.closedAlertRetentionDays * 86_400_000);
    let total = 0;
    for (;;) {
      const rows = await this.db.securityAlert.findMany({ where: { status: 'closed', closedAt: { lt: cutoff } }, select: { id: true }, take: 1000 });
      if (!rows.length) break;
      const { count } = await this.db.securityAlert.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, status: 'closed' } });
      total += count;
      if (rows.length < 1000) break;
    }
    if (total) this.logger.log(`closed security alerts purged: ${total}`);
    return total;
  }
}
