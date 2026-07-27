import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WORKSPACE_LIMITS } from '@superapp/shared';
import { WorkspacesService } from './workspaces.service';
import { RedisService } from '../../shared/redis/redis.service';

/**
 * Ретеншн архива организаций: пролежавшая в архиве дольше `archiveRetentionDays`
 * удаляется НАВСЕГДА (со всеми задачами, чатами, процессами и хроникой — см.
 * `purgeWorkspace`). Redis-лок — чтобы при нескольких инстансах чистил один.
 *
 * Обычный крон, а не движок джобов: это ретеншн-свип по расписанию, у него нет
 * доменного события-триггера и нечего терять при пропуске прогона — завтрашний
 * заход доберёт всё, что созрело (правило платформы, как у остальных ретеншнов).
 */
@Injectable()
export class WorkspacesCron {
  private readonly logger = new Logger(WorkspacesCron.name);

  constructor(
    private workspaces: WorkspacesService,
    private redis: RedisService,
  ) {}

  @Cron('40 3 * * *') // Ежедневно в 03:40 — рядом с остальными ретеншнами, но не в них
  async handleArchiveRetention(): Promise<void> {
    const ran = await this.redis.withLock(
      'cron:workspaces-archive-retention',
      15 * 60 * 1000,
      async () => {
        // Сначала удаляем созревшее, потом предупреждаем оставшихся — иначе на
        // организацию, которую сносим в этом же прогоне, ушло бы прощальное письмо.
        const purged = await this.workspaces.purgeExpiredArchives();
        if (purged > 0) {
          this.logger.log(
            `Удалено организаций по ретеншну архива (${WORKSPACE_LIMITS.archiveRetentionDays} дн.): ${purged}`,
          );
        }
        const warned = await this.workspaces.warnExpiringArchives();
        if (warned > 0) {
          this.logger.log(`Предупреждений о скором удалении отправлено: ${warned}`);
        }
      },
    );
    if (ran === null) {
      this.logger.debug('Пропущено — лок держит другой инстанс');
    }
  }
}
