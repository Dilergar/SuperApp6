import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { DocsService } from './docs.service';

/**
 * Жнец брошенных блокировок — ТРЕТИЙ ремень закрытия сессии правки.
 *
 * Протокол WOPI не гарантирует сигнала «ушёл последний»: (1) основной — Unlock от
 * редактора; (2) подсказка «сохранение при выходе» срезает срок блокировки до минут;
 * (3) этот крон добивает всё, что пережило оба. Без него документ, чей редактор упал
 * вместе с вкладкой, висел бы «занятым» до конца срока блокировки, а веха по итогам
 * правки не нарезалась бы вовсе.
 */
@Injectable()
export class DocsCron {
  private readonly logger = new Logger(DocsCron.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly docs: DocsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reapExpiredSessions(): Promise<void> {
    // Redis-лок: жнец выполняет ОДИН инстанс, иначе два закрытия одной сессии
    // потягались бы за нарезку вехи (status-guard их разведёт, но работа лишняя).
    await this.redis.withLock('docs:reaper', 4 * 60 * 1000, async () => {
      const stale = await this.db.documentSession.findMany({
        where: { status: 'open', expiresAt: { lte: new Date() } },
        orderBy: { expiresAt: 'asc' },
        take: 100,
      });
      if (!stale.length) return;
      let closed = 0;
      for (const session of stale) {
        try {
          if (await this.docs.closeSession(session, 'expired')) closed++;
        } catch (err) {
          this.logger.warn(
            `не удалось закрыть сессию ${session.id}: ${String((err as Error)?.message ?? err)}`,
          );
        }
      }
      if (closed) this.logger.log(`жнец закрыл просроченных сессий правки: ${closed}`);
    });
  }
}
