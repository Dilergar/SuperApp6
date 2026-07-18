import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Слушатель голосового движка: расшифровка записи Диктофона готова/не удалась →
 * уведомление владельцу с дип-линком. Голосовые в чатах НЕ пингуем (шумно) —
 * фильтр по payload.links (движок кладёт привязки файла в событие; свой запрос
 * в fileLink на каждый чужой транскрипт не нужен).
 */
@Injectable()
export class RecorderEvents implements OnModuleInit {
  private readonly logger = new Logger(RecorderEvents.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.events.onPattern('voice.transcript.*').subscribe((e) => {
      void this.handle(
        e.type,
        (e.payload ?? {}) as { fileId?: string; links?: Array<{ refType?: string; refId?: string }> },
      );
    });
  }

  private async handle(
    type: string,
    payload: { fileId?: string; links?: Array<{ refType?: string; refId?: string }> },
  ): Promise<void> {
    try {
      if (!payload.fileId) return;
      if (type !== 'voice.transcript.ready' && type !== 'voice.transcript.failed') return;
      // ВСЕ привязки-записи: общий файл записи звонка живёт в Диктофоне у КАЖДОГО
      // клейманта — транскрипт один, уведомление получает каждый владелец строки
      const recIds = (payload.links ?? [])
        .filter((l) => l?.refType === 'voice_recording' && l.refId)
        .map((l) => l.refId as string);
      if (!recIds.length) return; // не запись Диктофона (голосовое в чате и т.п.)
      const recs = await this.db.voiceRecording.findMany({
        where: { id: { in: recIds } },
        select: { id: true, ownerId: true, title: true },
      });
      for (const rec of recs) {
        await this.notifications
          .notify(
            rec.ownerId,
            type,
            { title: rec.title, recordingId: rec.id, fileId: payload.fileId },
            { actionUrl: `/recorder?id=${rec.id}` },
          )
          .catch(() => undefined);
      }
    } catch (err) {
      this.logger.warn(`notify ${type}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
