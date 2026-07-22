import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FILE_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { FilesService } from './files.service';
import { STORAGE_DRIVER, StorageDriver } from './storage/storage-driver';

/**
 * Жизненный цикл файлов (Redis-лок — выполняет один инстанс; строки клеймятся
 * status-guarded updateMany, лок — не гарантия): брошенные загрузки, физическое
 * удаление после ретеншна, сверка квот. Ретраи медиа-конвейера и скана переехали на движок джобов core/jobs.
 */
@Injectable()
export class FilesCron {
  private readonly logger = new Logger(FilesCron.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
    private readonly files: FilesService,
  ) {}

  /** Ежечасно: незавершённые загрузки старше 24ч → failed, объект/мультипарт зачищаются */
  @Cron('7 * * * *')
  async handleStaleUploads(): Promise<void> {
    const ran = await this.redis.withLock('cron:files-stale-uploads', 10 * 60 * 1000, () =>
      this.sweepStaleUploads(),
    );
    if (ran !== null && ran > 0) this.logger.log(`Брошенных загрузок закрыто: ${ran}`);
  }

  async sweepStaleUploads(): Promise<number> {
    const cutoff = new Date(Date.now() - FILE_LIMITS.staleUploadHours * 3600 * 1000);
    const rows = await this.db.fileObject.findMany({
      where: { status: 'uploading', createdAt: { lt: cutoff } },
      select: { id: true, storageKey: true, uploadId: true },
      take: 200,
    });
    let closed = 0;
    for (const row of rows) {
      const res = await this.db.fileObject.updateMany({
        where: { id: row.id, status: 'uploading' },
        data: { status: 'failed', error: 'загрузка брошена', uploadId: null },
      });
      if (res.count !== 1) continue; // кто-то успел завершить/отменить — не трогаем
      if (row.uploadId) await this.driver.abortMultipart(row.storageKey, row.uploadId);
      await this.driver.delete(row.storageKey).catch(() => undefined);
      closed++;
    }
    return closed;
  }

  /** Ежедневно 04:10: физически удалить soft-deleted старше ретеншна (байты + строки) */
  @Cron('10 4 * * *')
  async handlePurgeDeleted(): Promise<void> {
    const ran = await this.redis.withLock('cron:files-purge-deleted', 30 * 60 * 1000, () =>
      this.sweepDeleted(),
    );
    if (ran !== null && ran > 0) this.logger.log(`Физически удалено файлов: ${ran}`);
  }

  async sweepDeleted(): Promise<number> {
    const cutoff = new Date(Date.now() - FILE_LIMITS.deletedRetentionDays * 24 * 3600 * 1000);
    const rows = await this.db.fileObject.findMany({
      where: { status: 'deleted', deletedAt: { lt: cutoff } },
      include: { variants: { select: { storageKey: true } } },
      take: 500,
    });
    let purged = 0;
    for (const row of rows) {
      await this.driver.delete(row.storageKey).catch(() => undefined);
      for (const v of row.variants) {
        await this.driver.delete(v.storageKey).catch(() => undefined);
      }
      // cascade заберёт links/variants
      await this.db.fileObject.delete({ where: { id: row.id } }).catch(() => undefined);
      purged++;
    }
    return purged;
  }

  /** Ежечасно :23 — прибрать осиротевшие ready-файлы (safety net уборки сирот) */
  @Cron('23 * * * *')
  async handleOrphanReady(): Promise<void> {
    const ran = await this.redis.withLock('cron:files-orphan-ready', 10 * 60 * 1000, () =>
      this.files.sweepOrphanReady(FILE_LIMITS.orphanReadyGraceHours * 3600 * 1000),
    );
    if (ran !== null && ran > 0) this.logger.log(`Осиротевших файлов прибрано: ${ran}`);
  }

  /** Ежедневно 04:40: сверка квот — пересчёт от фактических ready-файлов (drift-фикс) */
  @Cron('40 4 * * *')
  async handleQuotaReconcile(): Promise<void> {
    await this.redis.withLock('cron:files-quota-reconcile', 30 * 60 * 1000, () =>
      this.reconcileQuotas(),
    );
  }

  async reconcileQuotas(): Promise<void> {
    const agg = await this.db.fileObject.groupBy({
      by: ['ownerType', 'ownerId'],
      where: { status: 'ready' },
      _sum: { size: true },
      _count: { _all: true },
    });
    const seen = new Set<string>();
    for (const a of agg) {
      seen.add(`${a.ownerType}:${a.ownerId}`);
      const bytes = a._sum.size ?? BigInt(0);
      await this.db.fileQuotaUsage.upsert({
        where: { ownerType_ownerId: { ownerType: a.ownerType, ownerId: a.ownerId } },
        create: { ownerType: a.ownerType, ownerId: a.ownerId, bytesUsed: bytes, filesCount: a._count._all },
        update: { bytesUsed: bytes, filesCount: a._count._all },
      });
    }
    // Владельцы без ready-файлов → обнулить остатки
    const stale = await this.db.fileQuotaUsage.findMany({
      where: { OR: [{ bytesUsed: { gt: 0 } }, { filesCount: { gt: 0 } }] },
      select: { id: true, ownerType: true, ownerId: true },
    });
    for (const u of stale) {
      if (seen.has(`${u.ownerType}:${u.ownerId}`)) continue;
      await this.db.fileQuotaUsage.update({
        where: { id: u.id },
        data: { bytesUsed: BigInt(0), filesCount: 0 },
      });
    }
  }
}
