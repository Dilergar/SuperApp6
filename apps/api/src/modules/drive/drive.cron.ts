import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DRIVE_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { DriveJobs } from './drive.jobs';
import { DriveTreeService } from './drive-tree.service';

/**
 * Обслуживание Диска. Всё под Redis-локом: в мультиинстансной раскатке прогон должен
 * выполнять ровно один процесс, иначе крон-удаление пойдёт дважды.
 */
@Injectable()
export class DriveCron {
  private readonly logger = new Logger(DriveCron.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly tree: DriveTreeService,
    private readonly jobs: DriveJobs,
  ) {}

  /** Корзина: удаляем навсегда то, что пролежало дольше ретеншна */
  @Cron('25 3 * * *')
  async purgeTrash(): Promise<void> {
    await this.redis.withLock('cron:drive-purge', 10 * 60 * 1000, async () => {
      let total = 0;
      // Батчами: одна папка может унести десятки тысяч файлов, и разгребать это
      // одним заходом значит держать соединение и блокировки полчаса.
      for (let pass = 0; pass < 20; pass++) {
        const purged = await this.tree.purgeExpired();
        total += purged;
        if (purged < DRIVE_LIMITS.purgeBatch) break;
      }
      if (total) this.logger.log(`корзина Диска: удалено навсегда ${total} объектов`);

      // Отметки «недавно открывал»: строка на каждую пару (человек, объект) сама не
      // истекает, а показываем мы одну страницу — без ретеншна таблица растёт вечно.
      const cutoff = new Date(Date.now() - DRIVE_LIMITS.recentRetentionDays * 86_400_000);
      const gone = await this.db.driveRecent.deleteMany({ where: { openedAt: { lt: cutoff } } });
      if (gone.count) this.logger.log(`«Недавние»: убрано ${gone.count} устаревших отметок`);
    });
  }

  /**
   * Сверка роллапов: сентинел (subtree_bytes IS NULL) самовосстанавливается сам, но
   * джоб мог быть похоронен, а инстанс — упасть между пометкой и пересчётом. Ночью
   * добиваем всё, что осталось грязным.
   */
  @Cron('45 3 * * *')
  async reconcileRollups(): Promise<void> {
    await this.redis.withLock('cron:drive-rollup', 10 * 60 * 1000, async () => {
      // DISTINCT считает БАЗА. У Prisma `distinct` — постобработка в памяти, и вместе с
      // `take: 200` он означал бы «взять 200 грязных папок и схлопнуть»: одно активное
      // пространство выбирало бы всю пачку целиком, а остальные не пересчитывались бы
      // вовсе.
      const dirty = await this.db.$queryRaw<Array<{ space_id: string }>>`
        SELECT DISTINCT "space_id" FROM "drive_nodes"
         WHERE "kind" = 'folder' AND "subtree_bytes" IS NULL
         LIMIT 200`;
      for (const { space_id } of dirty) await this.jobs.rollup(space_id);
      if (dirty.length) this.logger.log(`пересчитаны размеры в ${dirty.length} пространствах`);
    });
  }

  /**
   * Сверка счётчиков ленты «Фото». Инкременты ведутся при индексации снимка, а
   * удаление узла их не уменьшает намеренно (иначе каждое удаление трогало бы бакет
   * под гонкой) — расхождение лечится здесь, полным пересчётом по месяцам.
   */
  @Cron('5 4 * * *')
  async reconcilePhotoBuckets(): Promise<void> {
    await this.redis.withLock('cron:drive-photos', 10 * 60 * 1000, async () => {
      // Пересчёт и запись — ОДНИМ оператором. Прежний вариант вычитывал агрегат в
      // приложение и делал upsert на каждую пару (пространство, месяц), а следом
      // забирал ЦЕЛИКОМ таблицу бакетов, чтобы найти опустевшие: и то и другое росло
      // линейно от размера платформы внутри десятиминутного лока.
      const written = await this.db.$executeRaw`
        INSERT INTO "drive_photo_buckets" ("id", "space_id", "month", "count")
        SELECT gen_random_uuid(), "space_id", to_char("taken_at_local", 'YYYY-MM'), COUNT(*)::int
          FROM "drive_nodes"
         WHERE "kind" = 'file' AND "taken_at_local" IS NOT NULL AND "trashed_at" IS NULL
         GROUP BY "space_id", to_char("taken_at_local", 'YYYY-MM')
        ON CONFLICT ("space_id", "month") DO UPDATE SET "count" = EXCLUDED."count"`;

      // Месяцы, из которых удалили всё, убираем — иначе скруббер вечно показывал бы
      // непустой месяц, в котором ничего нет.
      const dropped = await this.db.$executeRaw`
        DELETE FROM "drive_photo_buckets" b
         WHERE NOT EXISTS (
           SELECT 1 FROM "drive_nodes" n
            WHERE n."space_id" = b."space_id"
              AND n."kind" = 'file'
              AND n."taken_at_local" IS NOT NULL
              AND n."trashed_at" IS NULL
              AND to_char(n."taken_at_local", 'YYYY-MM') = b."month"
         )`;
      if (written || dropped) {
        this.logger.log(`счётчики «Фото»: обновлено ${written}, убрано пустых ${dropped}`);
      }
    });
  }
}
