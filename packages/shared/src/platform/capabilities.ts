// ============================================================
// core/platform (20-й движок) — каталог CAPABILITIES кабинета платформы
// ============================================================
// Плоский каталог строк `<домен>.<объект>.<действие>`. Команда реестра объявляет
// ОДНУ capability из него; роль сотрудника — набор capabilities. Компилятор
// выводит union: опечатка в декларации команды — ошибка сборки, а не дыра.
//
// Права сотрудников платформы НИКОГДА не выводятся из `user_roles` продукта —
// у кабинета свои таблицы (`PlatformStaff` / `PlatformStaffRole`).

export const PLATFORM_CAPABILITIES = [
  // Сам кабинет
  'platform.staff.read',
  'platform.staff.write',
  // Пара «пишет / одобряет» у самого опасного: состав штата и политика кабинета
  // меняются при включённом four-eyes только через второго сотрудника
  'platform.staff.approve',
  'platform.policy.write',
  'platform.policy.approve',
  'platform.audit.read',
  'platform.lookup.read',
  'platform.pii.reveal',
  // Тарифы (core/entitlements)
  'entitlements.catalog.read',
  'entitlements.catalog.write',
  'entitlements.subject.read',
  'entitlements.subject.write',
  // Пары «пишет / одобряет» стоят у ВСЕХ команд, повышающих права субъекта: подписка,
  // грант и индивидуальное условие дают один и тот же эффект, и контроль на одной
  // двери обходился бы соседней
  'entitlements.subject.approve',
  'entitlements.override.write',
  'entitlements.override.approve',
  'entitlements.grant.write',
  'entitlements.grant.approve',
  // Продуктовая аналитика (core/analytics): агрегаты и отчёты · панель «Активность»
  // карточки 360 (агрегаты по одному человеку — отдельное право) · реестр событий,
  // забвение и пересчёт роллапов
  'analytics.read',
  'analytics.person.read',
  'analytics.manage',
  // Движок ключей (core/keys): реестр ключей организации масками и журнал ·
  // ротация корня/подписи, заморозка KEK организации, отзыв ключа (пара «пишет /
  // одобряет» — заморозка организации и ротация корня идут через второго сотрудника)
  'keys.read',
  'keys.write',
  'keys.approve',
  // Движок согласий (core/consents): документы платформы и охват принятия · черновики ·
  // публикация версии — ВСЕГДА через второго сотрудника (пара «пишет / одобряет»)
  'consents.read',
  'consents.write',
  'consents.approve',
  // Журнал инцидентов ПДн (ЗоПД ст. 25 п. 2 пп. 8): чтение · открытие и шаги уведомления
  'pd.incidents.read',
  'pd.incidents.write',
  // Журнал безопасности (core/audit): консоль «Безопасность» (события, тревоги, целостность) ·
  // отзыв сессий, заморозка, закрытие тревог, стрим · выгрузка журнала — через второго сотрудника
  'security.read',
  'security.write',
  'security.approve',
  // Жизненный цикл данных (core/lifecycle): окончательное удаление архивной организации
  // командой — ВСЕГДА через второго сотрудника (пара «пишет / одобряет»)
  'lifecycle.purge.write',
  'lifecycle.purge.approve',
  // Заморозки (legal hold) платформы и снятие любой заморозки — тоже через второго сотрудника
  'lifecycle.holds.write',
  'lifecycle.holds.approve',
  // Дашборд «Данные» (база, бэкапы, партиции, сроки, стирания, канарейка) и отчёты по нему ·
  // пауза и срок политики хранения (пара «пишет / одобряет»: сокращение срока у всей
  // платформы — через второго сотрудника) · повтор этапа застрявшего стирания
  'data.read',
  'lifecycle.retention.write',
  'lifecycle.retention.approve',
  'lifecycle.erasure.write',
  // Восстановление арендатора из архива (после PITR): извлечь строки организации и вернуть их —
  // всегда через второго сотрудника
  'lifecycle.restore.write',
  'lifecycle.restore.approve',
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

export function isPlatformCapability(value: unknown): value is PlatformCapability {
  return typeof value === 'string' && (PLATFORM_CAPABILITIES as readonly string[]).includes(value);
}

/** Пара «пишет / одобряет» одного объекта — предмет правила SoD (разделение обязанностей). */
export function approvePairOf(cap: PlatformCapability): PlatformCapability | null {
  if (!cap.endsWith('.write')) return null;
  const candidate = `${cap.slice(0, -'.write'.length)}.approve`;
  return isPlatformCapability(candidate) ? candidate : null;
}

/**
 * Конфликт SoD внутри набора: одна роль (или один человек) не должна одновременно
 * писать и одобрять один и тот же объект. Возвращает пары-нарушители.
 */
export function sodConflicts(caps: readonly PlatformCapability[]): Array<[PlatformCapability, PlatformCapability]> {
  const set = new Set(caps);
  const out: Array<[PlatformCapability, PlatformCapability]> = [];
  for (const cap of set) {
    const pair = approvePairOf(cap);
    if (pair && set.has(pair)) out.push([cap, pair]);
  }
  return out;
}
