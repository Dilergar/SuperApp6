import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DOCS_LIMITS, decodeCursor, encodeCursor } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { FilesService } from '../files/files.service';
import {
  LifecycleCanaryRegistry,
  LifecyclePurgeHandlerRegistry,
  LifecycleSubjectHookRegistry,
  LifecycleTenantHookRegistry,
  type LifecycleCanaryContext,
  type LifecycleCanaryPlant,
  type LifecyclePurgeBatchContext,
} from '../lifecycle/lifecycle.purge.registry';

/** Что шагу «все документы владельца» нужно от каскада организации и от стирания человека. */
interface OwnedPurgeCtx {
  deadline: number | null;
  releasable(tx: Prisma.TransactionClient, policyId: string, ids: readonly string[]): Promise<string[]>;
  /** Каскад организации: заморозка появилась — бросает */
  checkpoint?(): Promise<void>;
  /** Стирание человека: строки под заморозкой остались — заявка ждёт */
  held?(rows: number): void;
}
import { DocsService } from './docs.service';

const ROW_CURSOR = { c: 'date', i: 'uuid' } as const;

/**
 * Шаги раннера сроков core/lifecycle для офисных документов (политика `Document`):
 *  - `docs.trash` — закрытый документ (единственная точка конца жизни — `archive`: пропуска
 *    погашены, файл отвязан) живёт `DOCS_LIMITS.archivedPurgeDays`, дальше строка и
 *    неподписанные вехи уходят. Документ с ПОДПИСАННОЙ вехой не удаляется никогда — на неё
 *    ссылается ЭЦП (доказательство);
 *  - `docs.owned` — каскад организации: все её документы проходят `archive`, неподписанные
 *    уходят сразу (срок архива организации уже был окном восстановления);
 *  - `docs.subject` — стирание человека: то же для его ЛИЧНЫХ документов (владелец — человек;
 *    документы организации остаются ей). Подписанное — доказательство, остаётся всегда.
 */
@Injectable()
export class DocsLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly db: DatabaseService,
    private readonly docs: DocsService,
    private readonly files: FilesService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.handlers.register('docs.trash', {
      purgeBatch: (ctx) => this.trashBatch(ctx),
      estimate: () => this.db.document.count({ where: this.dueWhere(this.trashCutoff()) }),
    });
    this.tenantHooks.register('docs.owned', {
      purge: (workspaceId, ctx) => this.purgeOwned('workspace', workspaceId, ctx),
      estimate: (workspaceId) => this.db.document.count({ where: { ownerType: 'workspace', ownerId: workspaceId } }),
    });
    this.subjectHooks.register('docs.subject', { erase: (userId, ctx) => this.purgeOwned('user', userId, ctx) });
    this.canary.register('docs.subject', (ctx) => this.seedCanary(ctx));
  }

  /** Посев канарейки: личный документ человека тем же путём, что создание (файл-черновик + якорь ссылки). */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const file = await this.files.createCanaryFile({ profile: 'document', ownerType: 'user', ownerId: ctx.userId, uploaderId: ctx.userId, name: `${ctx.marker}.docx`, mime, content: ctx.marker });
    const doc = await this.db.$transaction(async (tx) => {
      const d = await tx.document.create({
        data: { fileId: file.id, ownerType: 'user', ownerId: ctx.userId, createdById: ctx.userId, title: ctx.marker, ext: 'docx', mime, editorKind: 'writer' },
        select: { id: true },
      });
      await this.files.linkSystemInTx(tx, { fileId: file.id, refType: 'document', refId: d.id, role: 'content', createdById: ctx.userId });
      return d;
    });
    return [
      { policy: 'Document', id: doc.id, expect: 'gone' },
      { policy: 'FileObject', id: file.id, expect: 'gone' },
      { policy: 'blob:document', id: file.storageKey, expect: 'gone' },
    ];
  }

  private trashCutoff(): Date {
    return new Date(Date.now() - DOCS_LIMITS.archivedPurgeDays * 86_400_000);
  }

  /** Закрытые раньше `before`, без подписанных вех. */
  private dueWhere(before: Date) {
    return { status: 'archived', deletedAt: { lt: before }, versions: { none: { signed: true } } };
  }

  private async trashBatch({ limit, cursor, releasable }: LifecyclePurgeBatchContext) {
    const c = decodeCursor(cursor, ROW_CURSOR);
    const rows = await this.db.document.findMany({
      where: { ...this.dueWhere(this.trashCutoff()), ...(c ? { OR: [{ deletedAt: { gt: c.c } }, { deletedAt: c.c, id: { gt: c.i } }] } : {}) },
      select: { id: true, deletedAt: true },
      orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    if (!rows.length) return { rows: 0, more: false, cursor: null };
    const deleted = await this.db.$transaction(async (tx) => {
      const ok = await releasable(tx, rows.map((r) => r.id));
      if (!ok.length) return 0;
      // Условие повторено в DELETE: веху могли подписать между выборкой и удалением
      const res = await tx.document.deleteMany({ where: { id: { in: ok }, status: 'archived', versions: { none: { signed: true } } } });
      return res.count;
    });
    const last = rows[rows.length - 1]!;
    return { rows: deleted, more: rows.length === limit, cursor: encodeCursor({ c: last.deletedAt!, i: last.id }) };
  }

  /** Все документы владельца: `archive` каждого, затем неподписанные — навсегда (заморозка удерживает). */
  private async purgeOwned(ownerType: 'workspace' | 'user', ownerId: string, ctx: OwnedPurgeCtx): Promise<{ rows: number; done: boolean }> {
    let after: string | undefined;
    for (;;) {
      if (ctx.deadline !== null && Date.now() > ctx.deadline) return { rows: 0, done: false };
      await ctx.checkpoint?.();
      const batch = await this.db.document.findMany({
        where: { ownerType, ownerId, ...(after ? { id: { gt: after } } : {}) },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 200,
      });
      if (!batch.length) break;
      for (const d of batch) await this.docs.archive(d.id);
      after = batch[batch.length - 1]!.id;
    }
    let rows = 0;
    after = undefined;
    for (;;) {
      if (ctx.deadline !== null && Date.now() > ctx.deadline) return { rows, done: false };
      const ids: string[] = (
        await this.db.document.findMany({
          where: { ownerType, ownerId, status: 'archived', versions: { none: { signed: true } }, ...(after ? { id: { gt: after } } : {}) },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: 500,
        })
      ).map((r) => r.id);
      if (!ids.length) break;
      rows += await this.db.$transaction(async (tx) => {
        const ok = await ctx.releasable(tx, 'Document', ids);
        if (ok.length < ids.length) ctx.held?.(ids.length - ok.length);
        if (!ok.length) return 0;
        const res = await tx.document.deleteMany({ where: { id: { in: ok }, status: 'archived', versions: { none: { signed: true } } } });
        return res.count;
      });
      after = ids[ids.length - 1];
    }
    return { rows, done: true };
  }
}
