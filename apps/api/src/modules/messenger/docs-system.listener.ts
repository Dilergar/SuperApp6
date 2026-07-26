import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../../shared/events/event-bus.service';
import { DatabaseService } from '../../shared/database/database.service';
import { MessengerService } from './messenger.service';

interface DocsCreatedPayload {
  documentId?: string;
  title?: string;
  refType?: string;
  refId?: string;
  actorId?: string;
  actorName?: string | null;
}

/**
 * Плашка «файл открыт как документ» в чате (движок core/docs).
 *
 * Оживление вложения раздаёт право ПРАВКИ всем, кто может писать в это место, — и это
 * не должно происходить незаметно. У задачи такое событие пишется в хронику core/chatter
 * (там плашка появляется сама), а у сообщения чата хроники нет, поэтому движок объявляет
 * событие на шину, а мессенджер превращает его в системную плашку.
 *
 * Best-effort: потеря плашки не выдаёт и не отбирает прав (они пересчитываются от места
 * на каждом запросе редактора) — это уведомление, а не носитель доступа.
 */
@Injectable()
export class DocsSystemListener implements OnModuleInit {
  private readonly logger = new Logger(DocsSystemListener.name);

  constructor(
    private readonly events: EventBusService,
    private readonly db: DatabaseService,
    private readonly messenger: MessengerService,
  ) {}

  onModuleInit(): void {
    this.events.onPattern('docs.document.*').subscribe((e) => {
      if (e.type !== 'docs.document.created') return;
      void this.handleCreated((e.payload ?? {}) as DocsCreatedPayload);
    });
  }

  private async handleCreated(p: DocsCreatedPayload): Promise<void> {
    try {
      if (p.refType !== 'chat_message' || !p.refId) return;
      const message = await this.db.message.findUnique({
        where: { id: p.refId },
        select: { chatId: true, deletedAt: true },
      });
      if (!message || message.deletedAt) return;
      const who = p.actorName || 'Кто-то';
      await this.messenger.postChatSystemMessage(
        message.chatId,
        'docs.document.created',
        `${who} открыл(а) файл «${p.title ?? 'документ'}» как документ — теперь его правят участники чата`,
      );
    } catch (err) {
      this.logger.warn(`плашка документа не поставлена: ${String((err as Error)?.message ?? err)}`);
    }
  }
}
