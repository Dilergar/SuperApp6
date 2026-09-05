import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NOTE_LIMITS } from '@superapp/shared';
import { RedisService } from '../../shared/redis/redis.service';
import { NotesFoldersService } from './notes-folders.service';
import { NotesService } from './notes.service';

/**
 * Обслуживание Заметок под Redis-локом: в мультиинстансной раскатке прогон делает
 * ровно один процесс, иначе purge пошёл бы дважды.
 */
@Injectable()
export class NotesCron {
  private readonly logger = new Logger(NotesCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly notes: NotesService,
    private readonly folders: NotesFoldersService,
  ) {}

  /** Корзина: что пролежало дольше ретеншна — навсегда (батчами) */
  @Cron('35 3 * * *')
  async purgeTrash(): Promise<void> {
    await this.redis.withLock('cron:notes-purge', 10 * 60 * 1000, async () => {
      const cutoff = new Date(Date.now() - NOTE_LIMITS.trashRetentionDays * 86_400_000);
      let notes = 0;
      for (let pass = 0; pass < 20; pass++) {
        const purged = await this.notes.purgeExpired(cutoff);
        notes += purged;
        if (purged < NOTE_LIMITS.purgeBatch) break;
      }
      let folders = 0;
      for (let pass = 0; pass < 20; pass++) {
        const purged = await this.folders.purgeExpiredFolders(cutoff);
        folders += purged;
        if (purged < NOTE_LIMITS.purgeBatch) break;
      }
      if (notes || folders) this.logger.log(`корзина Заметок: удалено навсегда ${notes} заметок и ${folders} папок`);
    });
  }
}
