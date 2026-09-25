import { Injectable, OnModuleInit } from '@nestjs/common';
import { PERSONAL_DOC_REF_TYPE } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { FilesService } from '../../core/files/files.service';
import { LifecycleCanaryRegistry, LifecycleSubjectHookRegistry, type LifecycleCanaryContext, type LifecycleCanaryPlant } from '../../core/lifecycle/lifecycle.purge.registry';

/**
 * КЭДО в стирании человека (`hr.subject`, политика `PersonalDocRecord`): «Мои документы» —
 * личный архив человека (копии-ссылки на документы организаций, дошедшие до него). Запись и
 * её ссылка на файл снимаются; сам файл — документ ОРГАНИЗАЦИИ и живёт её местами (её срок
 * хранения — закон о кадровых документах); если организации уже нет, осиротевший файл
 * уходит обычной уборкой. Под заморозкой запись остаётся (шаг ждёт снятия).
 */
@Injectable()
export class HrLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly files: FilesService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.subjectHooks.register('hr.subject', {
      erase: async (userId, ctx) => {
        let rows = 0;
        let after: string | undefined;
        for (;;) {
          if (ctx.deadline !== null && Date.now() > ctx.deadline) return { rows, done: false };
          const batch = await this.db.personalDocRecord.findMany({
            where: { userId, ...(after ? { id: { gt: after } } : {}) },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: 200,
          });
          if (!batch.length) return { rows, done: true };
          after = batch[batch.length - 1]!.id;
          const ids = batch.map((r) => r.id);
          const ok = await this.db.$transaction((tx) => ctx.releasable(tx, 'PersonalDocRecord', ids));
          if (ok.length < ids.length) ctx.held(ids.length - ok.length);
          if (!ok.length) continue;
          await this.files.unlinkAllForRefs(PERSONAL_DOC_REF_TYPE, ok);
          const { count } = await this.db.personalDocRecord.deleteMany({ where: { id: { in: ok } } });
          rows += count;
        }
      },
    });
    this.canary.register('hr.subject', (ctx) => this.seedCanary(ctx));
  }

  /**
   * Посев канарейки: документ организации дошёл до человека — запись его личного архива со
   * ссылкой на файл организации. Запись уходит с человеком, файл остаётся организации и
   * уходит с её каскадом.
   */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const file = await this.files.createCanaryFile({ profile: 'document', ownerType: 'workspace', ownerId: ctx.workspaceId, uploaderId: ctx.peerId, name: `${ctx.marker}.pdf`, mime: 'application/pdf', content: ctx.marker });
    const record = await this.db.$transaction(async (tx) => {
      const r = await tx.personalDocRecord.create({
        data: { userId: ctx.userId, workspaceId: ctx.workspaceId, workspaceName: 'Canary', title: ctx.marker, fileId: file.id, kind: 'delivered' },
        select: { id: true },
      });
      await this.files.linkSystemInTx(tx, { fileId: file.id, refType: PERSONAL_DOC_REF_TYPE, refId: r.id, role: 'attachment', createdById: ctx.peerId });
      return r;
    });
    return [
      { policy: 'PersonalDocRecord', id: record.id, expect: 'gone' },
      { policy: 'FileObject', id: file.id, expect: 'kept', tenant: true },
      { policy: 'blob:document', id: file.storageKey, expect: 'kept', tenant: true },
    ];
  }
}
