import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVIDENCE_FILE_PROFILES, decodeCursor, encodeCursor } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { sweepAppTmp } from '../../shared/fs/temp-file.util';
import { Prisma } from '@prisma/client';
import {
  LifecycleCanaryRegistry,
  LifecyclePurgeHandlerRegistry,
  LifecycleSubjectHookRegistry,
  LifecycleTenantHookRegistry,
  type LifecycleCanaryPlant,
  type LifecyclePurgeBatchContext,
  type LifecycleSubjectEraseContext,
} from '../lifecycle/lifecycle.purge.registry';
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
 *  - `files.owned` — все файлы удаляемой организации системным путём и физически сразу
 *    (восстанавливать некому); доказательства и файлы под защищающей привязкой — личный
 *    архив КЭДО — живут дальше;
 *  - `files.subject` — стирание человека, ПОСЛЕДНИМ из модульных шагов: модули уже сняли
 *    ссылки его личного контента (Диск — «дом» файла — унёс свои файлы везде). Файл человека
 *    без единой живой ссылки стирается сразу — байты и строка, не ждёт 7 дней корзины
 *    (обещание стирания ≤ 72 ч); файл, на который ещё ссылается ОБЩИЙ контент (вложение в
 *    чужом чате без дома на Диске), остаётся с ним — правило refcount реестра.
 */
@Injectable()
export class FilesLifecycleProvider implements OnModuleInit {
  private readonly logger = new Logger(FilesLifecycleProvider.name);

  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
    private readonly canary: LifecycleCanaryRegistry,
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
        if (!res.done) return { rows: res.rows, done: false };
        // Организация уходит навсегда — её файлы физически сразу, а не через 7 дней корзины
        // (восстанавливать их некому); защищённые привязкой (личный архив КЭДО) и
        // доказательства системное удаление не тронуло — они не в статусе deleted
        const phys = await this.purgeDeletedOf('workspace', workspaceId, ctx.deadline, (tx, ids) => ctx.releasable(tx, 'FileObject', ids), () => undefined);
        return { rows: res.rows + phys.rows, done: phys.done };
      },
      estimate: (workspaceId) => this.db.fileObject.count({ where: { ownerType: 'workspace', ownerId: workspaceId, status: { not: 'deleted' } } }),
    });
    this.subjectHooks.register('files.subject', { erase: (userId, ctx) => this.eraseOwner('user', userId, ctx) });
    // Посев канарейки: личный файл человека без ссылок — строка и байты исчезают сразу
    this.canary.register('files.subject', async (ctx) => {
      const f = await this.files.createCanaryFile({ profile: 'generic', ownerType: 'user', ownerId: ctx.userId, uploaderId: ctx.userId, name: `${ctx.marker}.txt`, mime: 'text/plain', content: ctx.marker });
      return [
        { policy: 'FileObject', id: f.id, expect: 'gone' },
        { policy: 'blob:generic', id: f.storageKey, expect: 'gone' },
      ] satisfies LifecycleCanaryPlant[];
    });
  }

  /**
   * Файлы человека без живых ссылок: системное удаление (доказательства и файлы под
   * защищающей привязкой пропускаются), затем физически СРАЗУ — байты и строка в транзакции
   * с проверкой заморозки. Идемпотентно (курсор по id); `deadline` — продолжение заходом.
   */
  private async eraseOwner(ownerType: 'user', ownerId: string, ctx: LifecycleSubjectEraseContext): Promise<{ rows: number; done: boolean }> {
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      if (ctx.deadline !== null && Date.now() > ctx.deadline) return { rows: 0, done: false };
      const orphans = await this.db.$queryRaw<Array<{ id: string }>>`
        SELECT fo.id::text AS id FROM "file_objects" fo
         WHERE fo.owner_type = ${ownerType} AND fo.owner_id = ${ownerId}::uuid AND fo.status <> 'deleted' AND fo.id > ${after}::uuid
           AND NOT EXISTS (SELECT 1 FROM "file_links" fl WHERE fl.file_id = fo.id)
         ORDER BY fo.id LIMIT 200`;
      if (!orphans.length) break;
      for (const f of orphans) await this.files.systemDeleteFile(f.id);
      after = orphans[orphans.length - 1]!.id;
    }
    return this.purgeDeletedOf(ownerType, ownerId, ctx.deadline, (tx, ids) => ctx.releasable(tx, 'FileObject', ids), (n) => ctx.held(n));
  }

  /**
   * Физически — байты и строки soft-deleted файлов владельца (кроме доказательств), каждая в
   * транзакции с проверкой заморозки. Общий хвост стирания человека и каскада организации.
   */
  private async purgeDeletedOf(
    ownerType: 'user' | 'workspace',
    ownerId: string,
    deadline: number | null,
    releasable: (tx: Prisma.TransactionClient, ids: readonly string[]) => Promise<string[]>,
    held: (rows: number) => void,
  ): Promise<{ rows: number; done: boolean }> {
    let rows = 0;
    let cursor: string | undefined;
    for (;;) {
      if (deadline !== null && Date.now() > deadline) return { rows, done: false };
      const batch = await this.db.fileObject.findMany({
        where: { ownerType, ownerId, status: 'deleted', profile: { notIn: [...EVIDENCE_FILE_PROFILES] }, ...(cursor ? { id: { gt: cursor } } : {}) },
        include: { variants: { select: { storageKey: true } } },
        orderBy: { id: 'asc' },
        take: 100,
      });
      if (!batch.length) break;
      for (const row of batch) {
        const res = await this.purgeRowNow(row, releasable);
        if (res === 'held') held(1);
        else if (res === 'purged') rows++;
      }
      cursor = batch[batch.length - 1]!.id;
    }
    return { rows, done: true };
  }

  /**
   * Физическое удаление одного soft-deleted файла: заморозка — в транзакции удаления строки,
   * байты уходят внутри неё же (заморозка, поставленная после, ждёт коммита и уже ничего не
   * удержит). Общий путь срока корзины и стирания человека.
   */
  private async purgeRowNow(
    row: { id: string; storageKey: string; variants: Array<{ storageKey: string }> },
    releasable: (tx: Prisma.TransactionClient, ids: readonly string[]) => Promise<string[]>,
  ): Promise<'purged' | 'held' | 'gone'> {
    return this.db.$transaction(
      async (tx) => {
        if (!(await releasable(tx, [row.id])).length) return 'held' as const;
        await this.driver.delete(row.storageKey).catch(() => undefined);
        for (const v of row.variants) await this.driver.delete(v.storageKey).catch(() => undefined);
        // cascade заберёт links/variants
        const res = await tx.fileObject.deleteMany({ where: { id: row.id, status: 'deleted' } });
        return res.count === 1 ? ('purged' as const) : ('gone' as const);
      },
      { timeout: 60_000 },
    );
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
      if ((await this.purgeRowNow(row, releasable)) === 'purged') purged++;
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
