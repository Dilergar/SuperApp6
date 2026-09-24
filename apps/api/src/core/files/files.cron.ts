import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EVIDENCE_FILE_PROFILES, FILE_LIMITS, type FileOwnerType } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { EntitlementsQuotaService } from '../entitlements/entitlements.quota.service';
import { QuotaReconcileRegistry } from '../entitlements/entitlements.registry';
import { FilesService } from './files.service';
import { STORAGE_DRIVER, StorageDriver } from './storage/storage-driver';

/**
 * Жизненный цикл файлов (Redis-лок — выполняет один инстанс; строки клеймятся
 * status-guarded updateMany, лок — не гарантия): брошенные загрузки, сироты, сверка
 * квот. Физическое удаление по сроку, выгрузки со своим сроком и временный каталог —
 * шаги раннера сроков core/lifecycle (`files.lifecycle.provider.ts`). Ретраи
 * медиа-конвейера и скана — движок джобов core/jobs.
 */
@Injectable()
export class FilesCron implements OnModuleInit {
  private readonly logger = new Logger(FilesCron.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
    private readonly files: FilesService,
    private readonly quota: EntitlementsQuotaService,
    private readonly reconcileRegistry: QuotaReconcileRegistry,
  ) {}

  /** Ежечасно: незавершённые загрузки старше 24ч → failed, объект/мультипарт зачищаются */
  @Cron('7 * * * *')
  async handleStaleUploads(): Promise<void> {
    const ran = await this.redis.withLock('cron:files-stale-uploads', 10 * 60 * 1000, () =>
      this.sweepStaleUploads(),
    );
    if (ran !== null && ran > 0) this.logger.log(`Abandoned uploads closed: ${ran}`);
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
        data: { status: 'failed', error: 'the upload was abandoned', uploadId: null },
      });
      if (res.count !== 1) continue; // кто-то успел завершить/отменить — не трогаем
      if (row.uploadId) await this.driver.abortMultipart(row.storageKey, row.uploadId);
      await this.driver.delete(row.storageKey).catch(() => undefined);
      closed++;
    }
    return closed;
  }

  /** Ежечасно :23 — прибрать осиротевшие ready-файлы (safety net уборки сирот) */
  @Cron('23 * * * *')
  async handleOrphanReady(): Promise<void> {
    const ran = await this.redis.withLock('cron:files-orphan-ready', 10 * 60 * 1000, () =>
      this.files.sweepOrphanReady(FILE_LIMITS.orphanReadyGraceHours * 3600 * 1000),
    );
    if (ran !== null && ran > 0) this.logger.log(`Orphaned files cleaned up: ${ran}`);
  }

  /**
   * Сверка квот — пересчёт от фактических ready-файлов (drift-фикс). Расписание держит
   * движок тарифов (`entitlements.quota reconcile`, 04:50): Диск регистрирует провайдер.
   */
  onModuleInit(): void {
    this.reconcileRegistry.register('files.storageBytes', { reconcile: () => this.reconcileQuotas() });
  }

  async reconcileQuotas(): Promise<number> {
    const agg = await this.db.fileObject.groupBy({
      by: ['ownerType', 'ownerId'],
      // Доказательства подписания (core/sign) в квоту не входят НИГДЕ — ни при
      // загрузке, ни здесь: иначе ночная сверка вернула бы их обратно, и правило
      // «вне квоты» продержалось бы ровно до сверки.
      where: { status: 'ready', profile: { notIn: [...EVIDENCE_FILE_PROFILES] } },
      _sum: { size: true },
      _count: { _all: true },
    });
    const seen = new Set<string>();
    for (const a of agg) {
      seen.add(`${a.ownerType}:${a.ownerId}`);
      const subject = { type: a.ownerType as FileOwnerType, id: a.ownerId };
      await this.quota.set(subject, 'files.storageBytes', Number(a._sum.size ?? BigInt(0)));
      await this.quota.set(subject, 'files.count', a._count._all);
    }
    // Владельцы без ready-файлов → обнулить остатки
    for (const key of ['files.storageBytes', 'files.count'] as const) {
      for (const s of await this.quota.subjectsWithCounter(key)) {
        if (seen.has(`${s.type}:${s.id}`)) continue;
        await this.quota.set(s, key, 0);
      }
    }
    return agg.length;
  }
}
