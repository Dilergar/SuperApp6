import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PLATFORM_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';

/**
 * Уборка кабинета. Журнал КОМАНД не удаляется никогда (append-only, триггер в БД);
 * удаляются только служебные строки:
 *  - журнал ЧТЕНИЙ старше `accessLogRetentionDays` (строка на каждый просмотр карточки —
 *    самая быстрорастущая таблица кабинета, и ретеншн у неё объявлен в лимитах);
 *  - мёртвые сессии кабинета (истёкшие или отозванные) — токен без refresh живёт 8 часов,
 *    строка после этого не нужна никому.
 * Лок Redis — чтобы чистил один инстанс; порциями, чтобы не держать длинный DELETE.
 */
@Injectable()
export class PlatformCron {
  private readonly logger = new Logger(PlatformCron.name);
  private static readonly BATCH = 5_000;
  /** Мёртвая сессия хранится ещё сутки — на разбор инцидента по ip/userAgent */
  private static readonly DEAD_SESSION_HOURS = 24;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  @Cron('23 4 * * *')
  async sweep(): Promise<void> {
    const ran = await this.redis.withLock('cron:platform-sweep', 10 * 60 * 1000, async () => {
      const logs = await this.sweepAccessLog();
      const sessions = await this.sweepDeadSessions();
      return logs + sessions;
    });
    if (ran !== null && ran > 0) this.logger.log(`Console housekeeping removed rows: ${ran}`);
  }

  async sweepAccessLog(): Promise<number> {
    const cutoff = new Date(Date.now() - PLATFORM_LIMITS.accessLogRetentionDays * 86_400_000);
    let removed = 0;
    for (;;) {
      const batch = await this.db.platformAccessLog.findMany({
        where: { occurredAt: { lt: cutoff } },
        select: { id: true },
        take: PlatformCron.BATCH,
      });
      if (!batch.length) break;
      const res = await this.db.platformAccessLog.deleteMany({ where: { id: { in: batch.map((r) => r.id) } } });
      removed += res.count;
      if (batch.length < PlatformCron.BATCH) break;
    }
    return removed;
  }

  async sweepDeadSessions(): Promise<number> {
    const cutoff = new Date(Date.now() - PlatformCron.DEAD_SESSION_HOURS * 3_600_000);
    const res = await this.db.platformSession.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
    return res.count;
  }
}
