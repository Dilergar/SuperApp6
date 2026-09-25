import { Injectable, OnModuleInit } from '@nestjs/common';
import { RECORDER_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { FilesService } from '../../core/files/files.service';
import {
  LifecycleCanaryRegistry,
  LifecyclePurgeHandlerRegistry,
  LifecycleSubjectHookRegistry,
  type LifecycleCanaryContext,
  type LifecycleCanaryPlant,
} from '../../core/lifecycle/lifecycle.purge.registry';
import { RecorderService } from './recorder.service';

/**
 * Диктофон в движке сроков core/lifecycle: `recorder.trash` (политика `VoiceRecording`) —
 * корзина `RECORDER_LIMITS.trashRetentionDays`: запись уходит навсегда (файл и транскрипт
 * прибирают движки файлов и голоса — транскрипт только вместе с файлом).
 */
@Injectable()
export class RecorderLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly recorder: RecorderService,
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.handlers.register('recorder.trash', {
      purgeBatch: ({ limit, cursor, releasable }) => this.recorder.purgeTrashBatch({ before: this.cutoff(), limit, cursor, releasable }),
      estimate: () => this.recorder.countTrashDue(this.cutoff()),
    });
    // Стирание человека: все его записи (файлы и транскрипты — путём «навсегда»)
    this.subjectHooks.register('recorder.subject', {
      erase: (userId, ctx) =>
        this.recorder.purgeOwnerRecordings(userId, { deadline: ctx.deadline, held: (n) => ctx.held(n), releasable: (tx, ids) => ctx.releasable(tx, 'VoiceRecording', ids) }),
    });
    this.canary.register('recorder.subject', (ctx) => this.seedCanary(ctx));
  }

  /** Посев канарейки: запись диктофона человека с аудиофайлом (ссылка как у живой загрузки) — исчезает с байтами. */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const file = await this.files.createCanaryFile({ profile: 'dictaphone', ownerType: 'user', ownerId: ctx.userId, uploaderId: ctx.userId, name: `${ctx.marker}.webm`, mime: 'audio/webm', content: ctx.marker });
    const rec = await this.db.$transaction(async (tx) => {
      const r = await tx.voiceRecording.create({ data: { ownerId: ctx.userId, title: ctx.marker, source: 'upload' }, select: { id: true } });
      await this.files.linkSystemInTx(tx, { fileId: file.id, refType: 'voice_recording', refId: r.id, role: 'attachment', createdById: ctx.userId });
      return r;
    });
    return [
      { policy: 'VoiceRecording', id: rec.id, expect: 'gone' },
      { policy: 'FileObject', id: file.id, expect: 'gone' },
      { policy: 'blob:dictaphone', id: file.storageKey, expect: 'gone' },
    ];
  }

  private cutoff(): Date {
    return new Date(Date.now() - RECORDER_LIMITS.trashRetentionDays * 86_400_000);
  }
}
