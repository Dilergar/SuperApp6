import { Injectable, Logger } from '@nestjs/common';
import type { CalendarItem, CalendarLayer } from '@superapp/shared';

/** Ответ провайдера слоя на диапазон: записи + необязательная сводка периода (чип в шапке веба). */
export interface CalendarLayerResult {
  items: CalendarItem[];
  summary?: string | null;
}

/** Провайдер данных слоя: виртуальные записи зрителя userId в [from; to]. Ничего не копируется. */
export interface CalendarLayerProvider {
  provide(userId: string, from: Date, to: Date): Promise<CalendarLayerResult>;
}

/**
 * Реестр слоёв календаря — «розетка» платформы (паттерн FilesRefRegistry/QuickActionRegistry):
 * модуль-владелец данных регистрирует свой провайдер в onModuleInit, и календарь перестаёт
 * знать потребителей поимённо. Ярлык/иконка/тон тумблера слоя живут в shared
 * (CALENDAR_LAYER_REGISTRY — модель NOTIFICATION_REGISTRY), оттуда же ключи в валидацию.
 * Слой 'events' — родной для календаря и через реестр не ходит.
 * Подключить сервис к календарю = запись в CALENDAR_LAYER_REGISTRY + register() здесь.
 */
@Injectable()
export class CalendarLayersRegistry {
  private readonly logger = new Logger(CalendarLayersRegistry.name);
  private readonly providers = new Map<CalendarLayer, CalendarLayerProvider>();

  register(layer: CalendarLayer, provider: CalendarLayerProvider): void {
    if (this.providers.has(layer)) {
      this.logger.warn(`Провайдер слоя «${layer}» перерегистрирован`);
    }
    this.providers.set(layer, provider);
  }

  get(layer: CalendarLayer): CalendarLayerProvider | undefined {
    return this.providers.get(layer);
  }
}
