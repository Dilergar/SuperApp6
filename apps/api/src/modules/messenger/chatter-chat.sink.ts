import { Injectable, OnModuleInit } from '@nestjs/common';
import { ChatterEntryDto, renderChatterText } from '@superapp/shared';
import { ChatterRefRegistry } from '../../core/chatter/chatter-ref.registry';
import { MessengerService } from './messenger.service';

/**
 * Chat-sink хроники: проецирует записи core/chatter системными плашками в
 * контекстные чаты (решение продукта: «плашки = Chatter, читать удобно прямо
 * в чате»). Заменил TaskSystemListener (лосси-шина): запись хроники и джоб
 * проекции (core/jobs) создаются в ОДНОЙ транзакции мутации — потерь нет,
 * ретраи/бэкофф/dead-letter у движка джобов, дубль-плашки гасит дедуп ниже
 * по chatterEntryId (ремень на случай краха между постом и терминалом джоба).
 *
 * Направление регистрации — как CallsRecordingRegistry: фича (мессенджер)
 * регистрируется В реестр core-движка, core фичи не импортирует. eventType
 * плашки = typeKey записи (тождество — веб-рендер payload.text не меняется);
 * ленивое создание чата задачи сохраняется (postTaskSystemMessage →
 * getOrCreateTaskChat, как при старом слушателе).
 */
@Injectable()
export class ChatterChatSink implements OnModuleInit {
  constructor(
    private readonly chatterRegistry: ChatterRefRegistry,
    private readonly messenger: MessengerService,
  ) {}

  onModuleInit() {
    this.chatterRegistry.registerChatSink('task', {
      post: async (entry: ChatterEntryDto) => {
        const text = renderChatterText(entry.typeKey, entry);
        await this.messenger.postTaskSystemMessage(entry.refId, entry.typeKey, text, {
          chatterEntryId: entry.id,
        });
      },
    });
  }
}
