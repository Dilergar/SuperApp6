import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SHARE_LINK_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';

/**
 * Обслуживание движка гостевых ссылок: ретеншн журнала визитов.
 *
 * Сами ссылки НЕ удаляются никогда, в том числе отозванные: «кому и когда мы это
 * отправляли» — это история раздачи данных наружу, и она нужна ровно тогда, когда
 * начинают разбираться, откуда файл ушёл. А вот строки визитов растут на каждое
 * открытие, поэтому у них есть срок.
 */
@Injectable()
export class ShareLinksCron {
  private readonly logger = new Logger(ShareLinksCron.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async handleVisitsRetention(): Promise<void> {
    await this.redis.withLock('cron:share-links-visits', 10 * 60 * 1000, async () => {
      const cutoff = new Date(Date.now() - SHARE_LINK_LIMITS.visitRetentionDays * 86_400_000);
      const batch = SHARE_LINK_LIMITS.visitRetentionBatch;
      let total = 0;
      // Батчами (паттерн ретеншнов скейл-ревью) — не держим долгую блокировку таблицы.
      for (;;) {
        const rows = await this.db.shareLinkVisit.findMany({
          where: { openedAt: { lt: cutoff } },
          select: { id: true },
          take: batch,
        });
        if (rows.length === 0) break;
        await this.db.shareLinkVisit.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
        total += rows.length;
        if (rows.length < batch) break;
      }
      if (total > 0) {
        this.logger.log(
          `Ретеншн гостевых ссылок: удалено ${total} визитов старше ${SHARE_LINK_LIMITS.visitRetentionDays}д`,
        );
      }
    });
  }
}
