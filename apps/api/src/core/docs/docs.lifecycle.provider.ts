import { Injectable, OnModuleInit } from '@nestjs/common';
import { DOCS_LIMITS, decodeCursor, encodeCursor } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import {
  LifecyclePurgeHandlerRegistry,
  LifecycleTenantHookRegistry,
  type LifecyclePurgeBatchContext,
  type LifecycleTenantPurgeContext,
} from '../lifecycle/lifecycle.purge.registry';
import { DocsService } from './docs.service';

const ROW_CURSOR = { c: 'date', i: 'uuid' } as const;

/**
 * Шаги раннера сроков core/lifecycle для офисных документов (политика `Document`):
 *  - `docs.trash` — закрытый документ (единственная точка конца жизни — `archive`: пропуска
 *    погашены, файл отвязан) живёт `DOCS_LIMITS.archivedPurgeDays`, дальше строка и
 *    неподписанные вехи уходят. Документ с ПОДПИСАННОЙ вехой не удаляется никогда — на неё
 *    ссылается ЭЦП (доказательство);
 *  - `docs.owned` — каскад организации: все её документы проходят `archive`, неподписанные
 *    уходят сразу (срок архива организации уже был окном восстановления).
 */
@Injectable()
export class DocsLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly db: DatabaseService,
    private readonly docs: DocsService,
  ) {}

  onModuleInit(): void {
    this.handlers.register('docs.trash', {
      purgeBatch: (ctx) => this.trashBatch(ctx),
      estimate: () => this.db.document.count({ where: this.dueWhere(this.trashCutoff()) }),
    });
    this.tenantHooks.register('docs.owned', {
      purge: (workspaceId, ctx) => this.purgeOwned(workspaceId, ctx),
      estimate: (workspaceId) => this.db.document.count({ where: { ownerType: 'workspace', ownerId: workspaceId } }),
    });
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

  /** Каскад организации: `archive` каждого документа, затем неподписанные — навсегда (заморозка удерживает). */
  private async purgeOwned(workspaceId: string, ctx: LifecycleTenantPurgeContext): Promise<{ rows: number; done: boolean }> {
    let after: string | undefined;
    for (;;) {
      if (ctx.deadline !== null && Date.now() > ctx.deadline) return { rows: 0, done: false };
      await ctx.checkpoint();
      const batch = await this.db.document.findMany({
        where: { ownerType: 'workspace', ownerId: workspaceId, ...(after ? { id: { gt: after } } : {}) },
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
          where: { ownerType: 'workspace', ownerId: workspaceId, status: 'archived', versions: { none: { signed: true } }, ...(after ? { id: { gt: after } } : {}) },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: 500,
        })
      ).map((r) => r.id);
      if (!ids.length) break;
      rows += await this.db.$transaction(async (tx) => {
        const ok = await ctx.releasable(tx, 'Document', ids);
        if (!ok.length) return 0;
        const res = await tx.document.deleteMany({ where: { id: { in: ok }, status: 'archived', versions: { none: { signed: true } } } });
        return res.count;
      });
      after = ids[ids.length - 1];
    }
    return { rows, done: true };
  }
}
