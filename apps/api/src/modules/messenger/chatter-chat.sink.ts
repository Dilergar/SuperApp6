import { Injectable, OnModuleInit } from '@nestjs/common';
import { ChatterEntryDto } from '@superapp/shared';
import { renderChatter, SOURCE_LOCALE } from '@superapp/i18n';
import { ChatterRefRegistry } from '../../core/chatter/chatter-ref.registry';
import { I18nService } from '../../shared/i18n/i18n.service';
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
 *
 * МУЛЬТИЯЗЫЧНОСТЬ. Сообщение живёт в БД вечно, а язык читателя меняется,
 * поэтому в payload едут ДВЕ вещи:
 *  • `text` — снимок в языке-ИСТОЧНИКЕ (en). Он фолбэк: старый клиент, превью
 *    цитаты у клиента без каталога, и вообще всё, что не умеет перерисовывать;
 *  • `chatter` — СТРУКТУРА записи (актёр, changes, payload). Из неё лента
 *    мессенджера собирает текст заново в языке ЗАПРОСА (MessengerService).
 */
@Injectable()
export class ChatterChatSink implements OnModuleInit {
  constructor(
    private readonly chatterRegistry: ChatterRefRegistry,
    private readonly messenger: MessengerService,
    private readonly i18n: I18nService,
  ) {}

  onModuleInit() {
    this.chatterRegistry.registerChatSink('task', {
      post: async (entry: ChatterEntryDto) => {
        const source = {
          refType: entry.refType,
          actorName: entry.actorName,
          changes: entry.changes,
          payload: entry.payload,
        };
        // Джоб проекции исполняется В ФОНЕ: языка запроса тут нет по построению,
        // и брать «текущий» было бы лотереей. Снимок пишем в языке-источнике.
        const text = renderChatter(this.i18n.forLocale(SOURCE_LOCALE), entry.typeKey, source);
        await this.messenger.postTaskSystemMessage(entry.refId, entry.typeKey, text, {
          chatterEntryId: entry.id,
          chatter: source,
        });
      },
    });
  }
}
