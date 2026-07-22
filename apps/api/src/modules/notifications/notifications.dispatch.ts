import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobsRegistry } from '../../core/jobs/jobs.registry';
import { NotificationsService } from './notifications.service';
import { NOTIFY_DISPATCH_JOB, mapEventToNotifications } from './notifications.map';

/**
 * Обработчик джоба `notifications.dispatch` (Волна 1 движка джобов; заменил
 * NotificationsEventsListener на шине): эмиттеры ставят джоб через
 * `NotificationsService.emitEvent` в момент доменного события, движок джобов
 * гарантирует исполнение (ретраи/бэкофф/dead-letter), а раскладка «кому что» —
 * чистая карта notifications.map.ts.
 *
 * Идемпотентность at-least-once: dedupKey = `j<jobId>:<userId>:<type>` —
 * ретрай после частичного фанаута (создал 2 из 5 строк и упал) не дублит
 * уже созданные (ON CONFLICT DO NOTHING в notify).
 */
@Injectable()
export class NotificationsDispatch implements OnModuleInit {
  constructor(
    private readonly jobsRegistry: JobsRegistry,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.jobsRegistry.register(NOTIFY_DISPATCH_JOB, async (payload, ctx) => {
      const eventType = String(payload['event'] ?? '');
      const data = (payload['data'] ?? {}) as Record<string, unknown>;
      for (const t of mapEventToNotifications(eventType, data)) {
        await this.notifications.notify(t.userId, t.type, t.payload, {
          actionUrl: t.actionUrl,
          dedupKey: `j${ctx.jobId}:${t.userId}:${t.type}`,
        });
      }
    });
  }
}
