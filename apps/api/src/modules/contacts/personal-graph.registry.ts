import { Injectable, Logger } from '@nestjs/common';

/**
 * Что сервис обязан сделать, когда личная связь между двумя людьми ИСЧЕЗЛА
 * (удаление контакта или блокировка). Разрыв связи = потеря всего, что
 * выдавалось «потому что вы в окружении друг у друга».
 */
export interface PersonalGraphHook {
  /**
   * Отозвать прямые (пер-человек) гранты между парой. Групповые рёбра
   * (`…@circle#member`) снимает сам граф — членство уезжает вместе со связью.
   * Обязан быть ИДЕМПОТЕНТНЫМ: вызывается и при удалении, и при блоке, и
   * повторно (блок поверх блока).
   */
  onUnlinked(userAId: string, userBId: string): Promise<void>;
}

/**
 * Реестр «что отозвать при разрыве связи» (паттерн FilesRefRegistry /
 * CallsRefRegistry / ChatterRefRegistry: движок не импортирует потребителей).
 *
 * Заведён потому, что инвариант «разрыв связи = потеря доступа» соблюдался
 * ровно ОДНИМ сервисом (финансы, через ленивый DI-токен), а персональный
 * шеринг календаря, витрин, вишлиста и «сотрудники магазина» переживали и
 * удаление, и блокировку: все они выдавались под `assertReachable`, но снимать
 * их было некому. Каждый новый сервис, выдающий грант «человеку из окружения»,
 * теперь закрывает это одной регистрацией, а не правкой ContactsService.
 */
@Injectable()
export class PersonalGraphRegistry {
  private readonly logger = new Logger(PersonalGraphRegistry.name);
  private readonly hooks = new Map<string, PersonalGraphHook>();

  register(key: string, hook: PersonalGraphHook): void {
    this.hooks.set(key, hook);
  }

  /**
   * Связь разорвана — прогоняем все хуки. Каждый изолирован: упавший сосед не
   * должен помешать остальным отозвать доступ (это security-эффект), поэтому
   * ошибка ЛОГИРУЕТСЯ как error и не роняет запрос — у потребителей есть свои
   * вторые ремни (шина + ночные свипы). Порядок регистрации не важен.
   */
  async fireUnlinked(userAId: string, userBId: string): Promise<void> {
    for (const [key, hook] of this.hooks) {
      try {
        await hook.onUnlinked(userAId, userBId);
      } catch (err) {
        this.logger.error(
          `Отзыв доступа при разрыве связи не удался (${key}, ${userAId}↔${userBId}): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  /** Зарегистрированные ключи — для дев-диагностики и тестов. */
  get registeredKeys(): string[] {
    return [...this.hooks.keys()];
  }
}
