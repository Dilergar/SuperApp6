import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { VERIFY_LIMITS } from '@superapp/shared';

/**
 * Обслуживание движка подтверждений: ретеншн цепочек (7 дней аудит-окна, дальше
 * строки не нужны — все счётчики скользящие ≤24ч). Батчами, под Redis-локом.
 */
@Injectable()
export class VerifyCron {
  private readonly logger = new Logger(VerifyCron.name);

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
  ) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async handleRetention() {
    await this.redis.withLock('cron:verify:retention', 120, async () => {
      const cutoff = new Date(Date.now() - VERIFY_LIMITS.retentionDays * 86_400_000);
      let total = 0;
      // Батчами по 5000 (паттерн ретеншнов скейл-ревью) — не держим долгую блокировку.
      for (;;) {
        const batch: Array<{ id: string }> = await this.db.verifyChallenge.findMany({
          where: { createdAt: { lt: cutoff } },
          select: { id: true },
          take: 5000,
        });
        if (batch.length === 0) break;
        await this.db.verifyChallenge.deleteMany({ where: { id: { in: batch.map((r) => r.id) } } });
        total += batch.length;
        if (batch.length < 5000) break;
      }
      if (total > 0) this.logger.log(`Ретеншн verify: удалено ${total} цепочек старше ${VERIFY_LIMITS.retentionDays}д`);
    });
  }
}
