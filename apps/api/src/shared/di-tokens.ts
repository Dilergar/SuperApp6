/**
 * Единый манифест СТРОКОВЫХ DI-токенов — ленивых ModuleRef-рёбер между модулями.
 *
 * Зачем: циклы модулей закрываются `moduleRef.get('<Имя>', { strict: false })`, но голая
 * строка «ломается молча» при переименовании сервиса. Все такие рёбра обязаны ходить через
 * этот манифест: (1) опечатка становится ошибкой компиляции, (2) DiTokensSmokeCheck при
 * бутстрапе резолвит каждый токен и валит старт, если провайдер пропал, (3) карта рёбер
 * в CLAUDE.md ссылается сюда как на источник правды.
 *
 * Значения = имена провайдеров, под которыми модули регистрируют алиасы
 * (`{ provide: DI_TOKENS.X, useExisting: XService }`) — менять значение можно только
 * синхронно с регистрацией.
 */
export const DI_TOKENS = {
  /** Мессенджер ← core/rich-cards и др. (цикл: messenger сам тянет rich-cards). */
  MessengerService: 'MessengerService',
  /** Календарь ← мессенджер (PresenceService-цикл). */
  CalendarService: 'CalendarService',
  /** Магазин ← задачи (settlement заказа «с задачей» при приёмке). */
  ShopService: 'ShopService',
  /** Процессы ← задачи (onTaskCompleted/onTaskCancelled шага-задачи). */
  ProcessesService: 'ProcessesService',
  /** Финансы ← контакты (синхронный отзыв finbook-грантов при разрыве связи) и ← ноды Процессов. */
  FinancesService: 'FinancesService',
  /** Офис ← воркспейсы (каскад увольнения: participations встреч + чаты). */
  OfficeService: 'OfficeService',
  /** Staff ← ноды Процессов (аттестация из процесса). */
  StaffService: 'StaffService',
  /** Воркспейсы ← ноды Процессов (резолв членов/ролей). */
  WorkspacesService: 'WorkspacesService',
  /** Rich-cards ← ноды Процессов (карточка в чат из процесса). */
  RichCardsService: 'RichCardsService',
} as const;

export type DiTokenName = keyof typeof DI_TOKENS;

/** Список для smoke-проверки на бутстрапе (см. AppModule.onApplicationBootstrap). */
export const ALL_DI_TOKENS: readonly string[] = Object.values(DI_TOKENS);
