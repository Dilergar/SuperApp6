import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WorkspacesService } from './workspaces.service';
import { RedisService } from '../../shared/redis/redis.service';

/**
 * Предупреждения владельцам архивных организаций за 7 / 3 / 1 день до окончательного
 * удаления. Само удаление — ретеншн архива раннера сроков core/lifecycle (шаг
 * workspaces.purge ставит каскад реестра джобом на организацию). Redis-лок — один инстанс.
 */
@Injectable()
export class WorkspacesCron {
  private readonly logger = new Logger(WorkspacesCron.name);

  constructor(
    private workspaces: WorkspacesService,
    private redis: RedisService,
  ) {}

  @Cron('40 3 * * *') // Ежедневно в 03:40
  async handleArchiveWarnings(): Promise<void> {
    const ran = await this.redis.withLock('cron:workspaces-archive-warnings', 15 * 60 * 1000, async () => {
      const warned = await this.workspaces.warnExpiringArchives();
      if (warned > 0) this.logger.log(`Warnings about the coming deletion sent: ${warned}`);
    });
    if (ran === null) this.logger.debug('Skipped — another instance holds the lock');
  }
}
