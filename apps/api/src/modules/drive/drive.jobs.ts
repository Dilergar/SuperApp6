import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DRIVE_LIMITS,
  DRIVE_NODE_REF_TYPE,
  drivePhotoMonth,
  driveNameKey,
  type FileOwnerType,
} from '@superapp/shared';
import { JobDiscardError, JobsRegistry } from '../../core/jobs/jobs.registry';
import { JobsService } from '../../core/jobs/jobs.service';
import { FilesService } from '../../core/files/files.service';
import { FilesRefRegistry } from '../../core/files/files-ref.registry';
import { DatabaseService } from '../../shared/database/database.service';
import {
  DRIVE_COPY_JOB,
  DRIVE_INGEST_JOB,
  DRIVE_PHOTO_JOB,
  DRIVE_QUEUE,
  DRIVE_ROLLUP_JOB,
} from './drive.constants';
import { DriveRoutingRegistry } from './drive-routing.registry';
import { DriveSearchService } from './drive-search.service';
import { DriveService } from './drive.service';

/**
 * Профили, которые на Диск не складываются: у них свой дом.
 * Голосовое живёт в чате и Диктофоне, аватарка — в профиле, фото товара — в магазине.
 */
const SKIP_PROFILES = new Set(['voice_message', 'avatar', 'listing_image']);

/**
 * Фоновая работа Диска. Своя очередь `drive`: рекурсивная копия папки и пересчёт
 * роллапов держат слот минутами, и в общей очереди они подпирали бы латентно
 * чувствительные типы (уведомления, плашки чатов).
 */
@Injectable()
export class DriveJobs implements OnModuleInit {
  private readonly logger = new Logger(DriveJobs.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsService,
    private readonly registry: JobsRegistry,
    private readonly files: FilesService,
    private readonly filesRegistry: FilesRefRegistry,
    private readonly routing: DriveRoutingRegistry,
    private readonly drive: DriveService,
    private readonly search: DriveSearchService,
  ) {}

  onModuleInit(): void {
    this.registry.register(DRIVE_INGEST_JOB, (p) => this.ingest(p as unknown as IngestPayload), {
      queue: DRIVE_QUEUE,
      queueConcurrency: 4,
      maxAttempts: 5,
    });
    this.registry.register(DRIVE_ROLLUP_JOB, (p) => this.rollup(String(p.spaceId)), {
      queue: DRIVE_QUEUE,
      maxAttempts: 3,
    });
    this.registry.register(DRIVE_COPY_JOB, (p) => this.copyFolder(p as unknown as CopyPayload), {
      queue: DRIVE_QUEUE,
      maxAttempts: 5,
      leaseMs: 10 * 60 * 1000,
    });
    this.registry.register(DRIVE_PHOTO_JOB, (p) => this.indexPhoto(String(p.nodeId)), {
      queue: DRIVE_QUEUE,
      maxAttempts: 8,
      // Конвейер картинки обычно занимает секунды; ждём его короткими подходами.
      backoffBaseMs: 15_000,
    });

    // Свои загрузки из чатов и задач появляются на Диске сами (модель Teams).
    this.filesRegistry.registerLinkObserver('drive', {
      onLinked: (tx, ev) => this.onFileLinked(tx, ev),
    });
  }

  // ============================================================
  // Автоматическое складывание файлов из переписки
  // ============================================================

  private async onFileLinked(
    tx: Prisma.TransactionClient | null,
    ev: { fileId: string; refType: string; refId: string; actorId: string },
  ): Promise<void> {
    if (ev.refType === DRIVE_NODE_REF_TYPE) return; // свои же связи
    if (!this.routing.has(ev.refType)) return; // сервис не подключён к Диску
    // Джоб ставится В ТОЙ ЖЕ транзакции, что и привязка: сообщение отправилось —
    // джоб есть, откатилось — джоба нет. uniqueKey делает повтор безвредным.
    await this.jobs.enqueue(tx, {
      type: DRIVE_INGEST_JOB,
      payload: { fileId: ev.fileId, refType: ev.refType, refId: ev.refId, actorId: ev.actorId },
      uniqueKey: `drv:${ev.fileId}:${ev.refType}:${ev.refId}`,
    });
  }

  private async ingest(payload: IngestPayload): Promise<void> {
    const { fileId, refType, refId, actorId } = payload;
    const file = await this.db.fileObject.findUnique({
      where: { id: fileId },
      select: { id: true, uploaderId: true, status: true, profile: true, name: true, size: true },
    });
    // Файл удалили/не дозагрузили, пока джоб ждал очереди — работа потеряла смысл.
    if (!file || file.status !== 'ready') return;
    if (SKIP_PROFILES.has(file.profile)) return;
    // ТОЛЬКО СВОИ загрузки: чужое вложение на моём Диске было бы неожиданностью,
    // а его удаление у меня погасило бы файл у автора.
    if (file.uploaderId !== actorId) return;

    const provider = this.routing.get(refType);
    if (!provider) return; // модуль выключен в этой сборке

    const placement = await provider.resolvePlacement(refId, actorId);
    if (!placement) return;

    const space = await this.drive.getOrCreateSpace(placement.ownerType as FileOwnerType, placement.ownerId);
    const folder = await this.drive.systemFolder(space.id, 'chat_uploads');
    try {
      await this.drive.placeFile(actorId, {
        spaceId: space.id,
        parentId: folder.id,
        fileId: file.id,
        parentAncestors: [...folder.ancestorIds, folder.id],
        depth: folder.depth + 1,
      });
    } catch (err) {
      // Человек прислал вложение и тут же удалил сообщение — файла к моменту укладки
      // уже нет. Это ПОСТОЯННЫЙ отказ, а не сбой: ретраить нечего, и пять попыток
      // с бэкоффом закончились бы dead-letter'ом, то есть ложной аварией в проде.
      if (err instanceof NotFoundException) {
        this.logger.log(`ingest ${fileId}: файл исчез до укладки — пропускаем`);
        return;
      }
      throw err;
    }
  }

  // ============================================================
  // Роллапы размеров
  // ============================================================

  async enqueueRollup(tx: Prisma.TransactionClient | null, spaceId: string): Promise<void> {
    await this.jobs.enqueue(tx, {
      type: DRIVE_ROLLUP_JOB,
      payload: { spaceId },
      uniqueKey: `drl:${spaceId}`,
    });
  }

  /**
   * Пересчёт «грязных» папок (subtree_bytes IS NULL — сентинел Nextcloud).
   *
   * Идём от САМЫХ ГЛУБОКИХ: родитель считается суммой детей, поэтому дети обязаны быть
   * посчитаны раньше. Если у папки остался хоть один непосчитанный ребёнок, она честно
   * остаётся грязной и досчитается следующим проходом — так пересчёт самовосстанавливается
   * после любого обрыва, в отличие от инкрементов, которые под массовым перемещением
   * разъезжаются молча.
   */
  async rollup(spaceId: string): Promise<void> {
    for (let pass = 0; pass < 32; pass++) {
      const dirty = await this.db.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "drive_nodes"
         WHERE "space_id" = ${spaceId} AND "kind" = 'folder' AND "subtree_bytes" IS NULL
         ORDER BY "depth" DESC
         LIMIT ${DRIVE_LIMITS.rollupBatch}`;
      if (!dirty.length) return;

      for (const { id } of dirty) {
        await this.db.$executeRaw`
          UPDATE "drive_nodes" p
             SET "subtree_bytes" = CASE WHEN c."unknown" > 0 THEN NULL ELSE COALESCE(c."b", 0) END,
                 "subtree_files" = CASE WHEN c."unknown" > 0 THEN NULL ELSE COALESCE(c."f", 0)::int END
            FROM (
              SELECT SUM("subtree_bytes") AS "b",
                     SUM("subtree_files") AS "f",
                     COUNT(*) FILTER (WHERE "subtree_bytes" IS NULL) AS "unknown"
                FROM "drive_nodes"
               WHERE "parent_id" = ${id} AND "trashed_at" IS NULL
            ) c
           WHERE p."id" = ${id}`;
      }
      // Ровно полная пачка — вероятно, есть ещё; иначе выходим.
      if (dirty.length < DRIVE_LIMITS.rollupBatch) {
        const left = await this.db.driveNode.count({
          where: { spaceId, kind: 'folder', subtreeBytes: null },
        });
        if (!left) return;
      }
    }
  }

  // ============================================================
  // Рекурсивная копия папки
  // ============================================================

  async enqueueCopy(sourceId: string, targetId: string, actorId: string): Promise<void> {
    await this.jobs.enqueue(null, {
      type: DRIVE_COPY_JOB,
      payload: { sourceId, targetId, actorId },
      uniqueKey: `dcp:${sourceId}:${targetId}`,
    });
  }

  /**
   * Копия содержимого папки. Идемпотентность держится на имени: в свежесозданной
   * целевой папке имена детей уникальны, поэтому повторный заход джоба (исполнение
   * at-least-once) видит уже созданное и пропускает его, а не плодит дубли.
   */
  private async copyFolder(payload: CopyPayload): Promise<void> {
    const { sourceId, targetId, actorId } = payload;
    const [source, target] = await Promise.all([
      this.db.driveNode.findUnique({ where: { id: sourceId } }),
      this.db.driveNode.findUnique({ where: { id: targetId } }),
    ]);
    // Исходник или назначение удалили, пока джоб ждал — копировать нечего и некуда.
    if (!source || !target) throw new JobDiscardError('копия отменена: узел исчез');
    const space = await this.db.driveSpace.findUniqueOrThrow({ where: { id: target.spaceId } });

    const children = await this.db.driveNode.findMany({
      where: { parentId: sourceId, trashedAt: null },
      orderBy: { id: 'asc' },
    });

    for (const child of children) {
      const exists = await this.db.driveNode.findFirst({
        where: { parentId: targetId, nameKey: driveNameKey(child.name), trashedAt: null },
      });
      if (exists) {
        if (child.kind === 'folder') await this.enqueueCopy(child.id, exists.id, actorId);
        continue;
      }

      if (child.kind === 'folder') {
        const created = await this.db.driveNode.create({
          data: {
            spaceId: target.spaceId,
            kind: 'folder',
            parentId: target.id,
            name: child.name,
            nameKey: driveNameKey(child.name),
            createdById: actorId,
            ancestorIds: [...target.ancestorIds, target.id],
            depth: target.depth + 1,
            sortRank: 0,
            subtreeBytes: BigInt(0),
            subtreeFiles: 0,
          },
        });
        await this.search.index(created);
        await this.enqueueCopy(child.id, created.id, actorId);
        continue;
      }

      if (!child.fileId) continue;
      const copy = await this.files.copyFile({
        fileId: child.fileId,
        actorId,
        ownerType: space.ownerType as FileOwnerType,
        ownerId: space.ownerId,
        name: child.name,
      });
      await this.drive.placeFile(actorId, {
        spaceId: target.spaceId,
        parentId: target.id,
        fileId: copy.id,
        name: child.name,
        parentAncestors: [...target.ancestorIds, target.id],
        depth: target.depth + 1,
      });
    }
  }

  // ============================================================
  // Лента «Фото»
  // ============================================================

  async enqueuePhoto(tx: Prisma.TransactionClient | null, nodeId: string): Promise<void> {
    await this.jobs.enqueue(tx, {
      type: DRIVE_PHOTO_JOB,
      payload: { nodeId },
      uniqueKey: `dph:${nodeId}`,
      // Конвейер картинки стартует сразу после загрузки — даём ему фору, чтобы не
      // потратить первую попытку впустую.
      runAt: new Date(Date.now() + 5_000),
    });
  }

  /**
   * Проставить снимку дату СЪЁМКИ и учесть его в счётчиках месяцев.
   *
   * Дата берётся из EXIF (её кладёт конвейер движка файлов). Пока конвейер не
   * отработал — честный throw: движок ретраит с бэкоффом, и это правильнее, чем
   * записать дату загрузки и навсегда поставить отпускное фото не в тот месяц.
   */
  private async indexPhoto(nodeId: string): Promise<void> {
    const node = await this.db.driveNode.findUnique({ where: { id: nodeId } });
    if (!node || !node.fileId || node.trashedAt) return;
    if (node.takenAtLocal) return; // уже учтён

    const file = await this.db.fileObject.findUnique({
      where: { id: node.fileId },
      select: { kind: true, meta: true, createdAt: true, status: true },
    });
    if (!file || file.status !== 'ready') return;
    if (file.kind !== 'image' && file.kind !== 'video') return;

    const meta = (file.meta ?? {}) as Record<string, unknown>;
    if (meta.pipeline === 'pending') throw new Error('конвейер ещё не отработал');

    // EXIF есть — берём стенное время съёмки; нет (скриншот, скачанная картинка) —
    // время появления файла. Обе величины хранятся БЕЗ пояса: ночной снимок не должен
    // уезжать на соседние сутки при смене пояса зрителя.
    const shot = typeof meta.takenAtLocal === 'string' ? new Date(meta.takenAtLocal) : null;
    const takenAtLocal = shot && !Number.isNaN(shot.getTime()) ? shot : file.createdAt;
    const month = drivePhotoMonth(takenAtLocal);

    await this.db.$transaction(async (tx) => {
      const hit = await tx.driveNode.updateMany({
        where: { id: nodeId, takenAtLocal: null },
        data: { takenAtLocal },
      });
      // Клейм не сработал — снимок уже посчитан соседним заходом, бакет не трогаем.
      if (!hit.count) return;
      await tx.drivePhotoBucket.upsert({
        where: { spaceId_month: { spaceId: node.spaceId, month } },
        create: { spaceId: node.spaceId, month, count: 1 },
        update: { count: { increment: 1 } },
      });
    });
  }
}

interface IngestPayload {
  fileId: string;
  refType: string;
  refId: string;
  actorId: string;
}

interface CopyPayload {
  sourceId: string;
  targetId: string;
  actorId: string;
}
