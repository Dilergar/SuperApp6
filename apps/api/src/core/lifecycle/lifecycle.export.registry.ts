import { Injectable, Logger } from '@nestjs/common';
import type { LifecycleExportSide, Locale } from '@superapp/shared';

/** Что сборщик выгрузки даёт провайдеру модуля. */
export interface LifecycleExportContext {
  exportId: string;
  side: LifecycleExportSide;
  /** Человек (`user`) или организация (`workspace`), чьи данные выгружаются */
  subjectId: string;
  /** Заказчик — зритель: поля под правилами видимости, язык текстов архива */
  requesterId: string;
  locale: Locale;
}

/** Страница строк провайдера: форма архива (JSON), без секретов и чужих идентификаторов. */
export interface LifecycleExportPage {
  rows: Record<string, unknown>[];
  /** Курсор следующей страницы; `null` — строк больше нет */
  next: string | null;
}

/**
 * Провайдер выгрузки модуля-владельца политики — когда общего сборщика мало: чтение со своими
 * правилами (пол ленты и таймер чата, маскировка «было → стало» хроники, три зрителя журнала
 * безопасности), текст в языке заказчика, чужие люди без id.
 *
 * Контракт: страница ≤ `limit` строк, идемпотентно по курсору; удалённое и вне срока не
 * отдаёт; `verify` — НЕЗАВИСИМАЯ перепроверка владельца строк страницы (Google Takeout 2019:
 * чужие видео в архиве) — `false` останавливает сборку целиком. Смысл проверки — «чужого нет»:
 * строка, удалённая между страницей и проверкой, не чужая (в живой организации что-то удаляют
 * постоянно — иначе выгрузка крупной организации падала бы почти всегда).
 */
export interface LifecycleExportProvider {
  page(ctx: LifecycleExportContext, cursor: string | null, limit: number): Promise<LifecycleExportPage>;
  verify(ctx: LifecycleExportContext, rows: readonly Record<string, unknown>[]): Promise<boolean>;
  /** Сторона вне тарифа — строки не уходят, манифест называет причину */
  skip?(ctx: LifecycleExportContext): Promise<'entitlement' | null>;
}

/**
 * Реестр провайдеров выгрузки (`LifecycleExportRegistry`): ключ — политика реестра и сторона.
 * Движок фичи не импортирует — модуль регистрирует провайдер в `onModuleInit`. Смоук бута
 * сверяет: каждая экспортируемая сторона политики отбирается реестром (ключ владельца или
 * `exportScope`) либо провайдером.
 */
@Injectable()
export class LifecycleExportRegistry {
  private readonly logger = new Logger(LifecycleExportRegistry.name);
  private readonly providers = new Map<string, LifecycleExportProvider>();

  register(policyId: string, side: LifecycleExportSide, provider: LifecycleExportProvider): void {
    const key = `${policyId}|${side}`;
    if (this.providers.has(key)) this.logger.warn(`lifecycle export provider "${key}" is already registered — overwriting`);
    this.providers.set(key, provider);
  }

  get(policyId: string, side: LifecycleExportSide): LifecycleExportProvider | undefined {
    return this.providers.get(`${policyId}|${side}`);
  }
}
