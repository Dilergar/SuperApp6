import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Слушатель голосового движка: расшифровка записи Диктофона готова/не удалась →
 * уведомление владельцу с дип-линком. Голосовые в чатах НЕ пингуем (шумно) —
 * фильтр = наличие привязки voice_recording у файла.
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
      void this.handle(e.type, (e.payload ?? {}) as { fileId?: string });
    });
  }

  private async handle(type: string, payload: { fileId?: string }): Promise<void> {
    try {
      if (!payload.fileId) return;
      if (type !== 'voice.transcript.ready' && type !== 'voice.transcript.failed') return;
      const link = await this.db.fileLink.findFirst({
        where: { refType: 'voice_recording', fileId: payload.fileId },
        select: { refId: true },
      });
      if (!link) return; // не запись Диктофона (голосовое в чате и т.п.)
      const rec = await this.db.voiceRecording.findUnique({
        where: { id: link.refId },
        select: { id: true, ownerId: true, title: true },
      });
      if (!rec) return;
      await this.notifications.notify(
        rec.ownerId,
        type,
        { title: rec.title, recordingId: rec.id, fileId: payload.fileId },
        { actionUrl: `/recorder?id=${rec.id}` },
      );
    } catch (err) {
      this.logger.warn(`notify ${type}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
