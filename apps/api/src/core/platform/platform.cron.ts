import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';

/**
 * Уборка кабинета. Журналы команд и чтений живут в журнале безопасности (core/audit):
 * append-only, срок — партициями движка журнала, построчного удаления нет. Здесь удаляются
 * только мёртвые сессии кабинета (истёкшие или отозванные) — токен без refresh живёт 8
 * часов, строка после этого не нужна никому (вход и выход — события журнала).
 * Лок Redis — чтобы чистил один инстанс.
 */
@Injectable()
export class PlatformCron {
  private readonly logger = new Logger(PlatformCron.name);
  /** Мёртвая сессия хранится ещё сутки — на разбор инцидента по ip/userAgent */
  private static readonly DEAD_SESSION_HOURS = 24;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  @Cron('23 4 * * *')
  async sweep(): Promise<void> {
    const ran = await this.redis.withLock('cron:platform-sweep', 10 * 60 * 1000, async () => this.sweepDeadSessions());
    if (ran !== null && ran > 0) this.logger.log(`Console housekeeping removed rows: ${ran}`);
  }

  async sweepDeadSessions(): Promise<number> {
    const cutoff = new Date(Date.now() - PlatformCron.DEAD_SESSION_HOURS * 3_600_000);
    const res = await this.db.platformSession.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
    return res.count;
  }
}
