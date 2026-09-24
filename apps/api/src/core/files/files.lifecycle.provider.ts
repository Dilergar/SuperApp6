import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVIDENCE_FILE_PROFILES, decodeCursor, encodeCursor } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { sweepAppTmp } from '../../shared/fs/temp-file.util';
import { LifecyclePurgeHandlerRegistry, LifecycleTenantHookRegistry, type LifecyclePurgeBatchContext } from '../lifecycle/lifecycle.purge.registry';
import { FilesService } from './files.service';
import { STORAGE_DRIVER, type StorageDriver } from './storage/storage-driver';

const ROW_CURSOR = { c: 'date', i: 'uuid' } as const;

/**
 * Шаги раннера сроков core/lifecycle для файлов (сроки — реестр: `FileObject`, профили
 * байтов, `derived:upload_tmp`) и хук каскада организации `files.owned`:
 *  - `files.deleted` / `FileObject` — байты и строка файла через 7 дней после удаления
 *    (корзина восстановления); доказательства подписи не стираются НИКОГДА;
 *  - `files.deleted` / `blob:audit_export` — выгрузки журнала безопасности живут 7 дней
 *    (минимизация ПДн), дальше — системное удаление тем же путём, что у Диска;
 *  - `files.upload-tmp` — брошенные временные файлы процесса (обрыв загрузки multer,
 *    падение посреди перекодирования) старше суток;
 *  - `files.owned` — все файлы удаляемой организации системным путём (доказательства и
 *    файлы под защищающей привязкой — личный архив КЭДО — живут дальше).
 */
@Injectable()
export class FilesLifecycleProvider implements OnModuleInit {
  private readonly logger = new Logger(FilesLifecycleProvider.name);

  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
  ) {}

  onModuleInit(): void {
    this.handlers.register('files.deleted', {
      purgeBatch: (ctx) => (ctx.policy.store.kind === 'blob' ? this.expireProfile(ctx, ctx.policy.store.profile) : this.purgeDeleted(ctx)),
      estimate: ({ policy, cutoff }) => {
        if (!cutoff) return Promise.resolve(0);
        return policy.store.kind === 'blob'
          ? this.db.fileObject.count({ where: { profile: policy.store.profile, status: { not: 'deleted' }, createdAt: { lt: cutoff } } })
          : this.db.fileObject.count({ where: { status: 'deleted', deletedAt: { lt: cutoff }, profile: { notIn: [...EVIDENCE_FILE_PROFILES] } } });
      },
    });
    this.handlers.register('files.upload-tmp', {
      purgeBatch: async ({ cutoff, limit }) => {
        if (!cutoff) return { rows: 0, more: false };
        const { removed, more } = await sweepAppTmp(cutoff, limit);
        return { rows: removed, more };
      },
    });
    this.tenantHooks.register('files.owned', {
      purge: async (workspaceId, ctx) => {
        const res = await this.files.systemDeleteAllOwnedBy('workspace', workspaceId, { deadline: ctx.deadline });
        return { rows: res.rows, done: res.done };
      },
      estimate: (workspaceId) => this.db.fileObject.count({ where: { ownerType: 'workspace', ownerId: workspaceId, status: { not: 'deleted' } } }),
    });
  }

  /** Физическое удаление soft-deleted старше срока: байты (+ варианты) и строка — под заморозкой пропуск. */
  private async purgeDeleted({ cutoff, limit, cursor, releasable }: LifecyclePurgeBatchContext) {
    if (!cutoff) return { rows: 0, more: false };
    const c = decodeCursor(cursor, ROW_CURSOR);
    const rows = await this.db.fileObject.findMany({
      // Доказательства подписания не стираем НИКОГДА — второй ремень к запрету в softDelete
      where: {
        status: 'deleted',
        deletedAt: { lt: cutoff },
        profile: { notIn: [...EVIDENCE_FILE_PROFILES] },
        ...(c ? { OR: [{ deletedAt: { gt: c.c } }, { deletedAt: c.c, id: { gt: c.i } }] } : {}),
      },
      include: { variants: { select: { storageKey: true } } },
      orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    let purged = 0;
    for (const row of rows) {
      // Заморозка проверяется в транзакции удаления строки; байты уходят внутри неё же —
      // заморозка, поставленная после, ждёт коммита и уже ничего не удержит
      const done = await this.db.$transaction(
        async (tx) => {
          if (!(await releasable(tx, [row.id])).length) return false;
          await this.driver.delete(row.storageKey).catch(() => undefined);
          for (const v of row.variants) await this.driver.delete(v.storageKey).catch(() => undefined);
          // cascade заберёт links/variants
          const res = await tx.fileObject.deleteMany({ where: { id: row.id, status: 'deleted' } });
          return res.count === 1;
        },
        { timeout: 60_000 },
      );
      if (done) purged++;
    }
    const last = rows[rows.length - 1];
    return { rows: purged, more: rows.length === limit, cursor: last?.deletedAt ? encodeCursor({ c: last.deletedAt, i: last.id }) : cursor };
  }

  /**
   * Файлы профиля с собственным сроком (выгрузки журнала безопасности — 7 дней) → системное
   * удаление тем же путём, что у Диска; байты уйдут шагом выше через срок корзины.
   */
  private async expireProfile({ cutoff, limit, cursor, releasable }: LifecyclePurgeBatchContext, profile: string) {
    if (!cutoff) return { rows: 0, more: false };
    const c = decodeCursor(cursor, ROW_CURSOR);
    const rows = await this.db.fileObject.findMany({
      where: {
        profile,
        status: { not: 'deleted' },
        createdAt: { lt: cutoff },
        ...(c ? { OR: [{ createdAt: { gt: c.c } }, { createdAt: c.c, id: { gt: c.i } }] } : {}),
      },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    let expired = 0;
    for (const row of rows) {
      const ok = await this.db.$transaction((tx) => releasable(tx, [row.id]));
      if (!ok.length) continue;
      try {
        await this.files.systemDeleteFile(row.id);
        expired++;
      } catch (err) {
        this.logger.warn(`${profile} file ${row.id} was not expired: ${err instanceof Error ? err.message : err}`);
      }
    }
    const last = rows[rows.length - 1];
    return { rows: expired, more: rows.length === limit, cursor: last ? encodeCursor({ c: last.createdAt, i: last.id }) : cursor };
  }
}
