import { Injectable, OnModuleInit } from '@nestjs/common';
import { RECORDER_LIMITS } from '@superapp/shared';
import { LifecyclePurgeHandlerRegistry } from '../../core/lifecycle/lifecycle.purge.registry';
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
    private readonly recorder: RecorderService,
  ) {}

  onModuleInit(): void {
    this.handlers.register('recorder.trash', {
      purgeBatch: ({ limit, cursor, releasable }) => this.recorder.purgeTrashBatch({ before: this.cutoff(), limit, cursor, releasable }),
      estimate: () => this.recorder.countTrashDue(this.cutoff()),
    });
  }

  private cutoff(): Date {
    return new Date(Date.now() - RECORDER_LIMITS.trashRetentionDays * 86_400_000);
  }
}
