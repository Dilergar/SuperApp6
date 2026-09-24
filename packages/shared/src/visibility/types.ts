import type { WorkspaceRole } from '../constants/roles';

// ============================================================
// core/visibility (27-й платформенный движок) — словарь реестра ТИПОВ ЗАПИСЕЙ
// ============================================================
// Field-Level Security + маскирование для всей экосистемы. `core/access` решает
// «видна ли ЗАПИСЬ и что с ней можно», этот словарь — «какие ПОЛЯ видимой записи и в
// каком виде». Тип записи — ДЕКЛАРИРУЕМАЯ сущность (Salesforce FieldPermissions,
// Twenty fieldPermission, Dataverse IsSecured): реестр называет у каждого поля вид
// данных, класс, владельца решения, группу матрицы, допустимые маски и умолчания.
// СЛОВА живут в каталоге `@superapp/i18n` (`visibility.types.<t>.title`,
// `.sections.<s>.title`, `.fields.<f>.label`).
//
// Файл НАМЕРЕННО без зависимостей (ни zod, ни рантайма): его читает страж
// `pnpm check:visibility` транспиляцией без сборки пакета.

/** Уровень поля для зрителя. Порядок несущий: сложение правил — MAX, потолки — MIN. */
export const VISIBILITY_LEVELS = ['hidden', 'masked', 'full'] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];
export const VISIBILITY_LEVEL_RANK: Record<VisibilityLevel, number> = { hidden: 0, masked: 1, full: 2 };

export function maxVisibilityLevel(a: VisibilityLevel, b: VisibilityLevel): VisibilityLevel {
  return VISIBILITY_LEVEL_RANK[a] >= VISIBILITY_LEVEL_RANK[b] ? a : b;
}
export function minVisibilityLevel(a: VisibilityLevel, b: VisibilityLevel): VisibilityLevel {
  return VISIBILITY_LEVEL_RANK[a] <= VISIBILITY_LEVEL_RANK[b] ? a : b;
}

/** Вид данных поля — определяет допустимые маски (`KIND_MASKS`). */
export const VISIBILITY_FIELD_KINDS = [
  'phone',
  'email',
  'id_number',
  'account',
  'name',
  'date',
  'money',
  'text',
  'address',
  'geo',
  'bool',
  'number',
  'enum',
  'card',
  'presence',
  'image',
  'url',
  'file',
] as const;
export type VisibilityFieldKind = (typeof VISIBILITY_FIELD_KINDS)[number];

/**
 * Класс поля (ISO 27001:2022 8.11 — классификация до маски). Порядок = чувствительность:
 * - public — видно всем, у кого есть запись;
 * - internal — рабочее, внутри организации;
 * - contact — контакт (телефон, e-mail): маска частичная, находимость — отдельная ось;
 * - personal — личное (ДР, город, био);
 * - confidential — деньги и договор;
 * - restricted — ИИН, удостоверение, адрес, IBAN: владелец/админ видят МАСКУ и раскрывают
 *   по одной записи с SMS-подтверждением;
 * - secret — полный номер карты и подобное: `full` не бывает НИ У КОГО (раскрытия нет).
 */
export const VISIBILITY_FIELD_CLASSES = ['public', 'internal', 'contact', 'personal', 'confidential', 'restricted', 'secret'] as const;
export type VisibilityFieldClass = (typeof VISIBILITY_FIELD_CLASSES)[number];
export const VISIBILITY_CLASS_RANK: Record<VisibilityFieldClass, number> = {
  public: 0,
  internal: 1,
  contact: 2,
  personal: 3,
  confidential: 4,
  restricted: 5,
  secret: 6,
};

/**
 * Потолок платформы по классу БЕЗ раскрытия (организация только сужает). `restricted` —
 * не выше маски; полное значение — только раскрытием одной записи. `secret` — маска и та
 * не всегда: раскрытия нет вовсе. На «сам» потолок `restricted` не действует (ЗоПД ст. 24).
 */
export const VISIBILITY_CLASS_CEILING: Record<VisibilityFieldClass, VisibilityLevel> = {
  public: 'full',
  internal: 'full',
  contact: 'full',
  personal: 'full',
  confidential: 'full',
  restricted: 'masked',
  secret: 'masked',
};

/**
 * Потолок бота/ключа API (R9): по умолчанию класс ≤ `internal`; `contact` — только
 * флагом ключа «Доступ к контактным данным»; `personal` и выше — никогда.
 */
export const VISIBILITY_BOT_CLASS_CEILING: VisibilityFieldClass = 'internal';
export const VISIBILITY_BOT_CONTACT_CLASS: VisibilityFieldClass = 'contact';

/**
 * Кто решает о поле (решение грилла №1): `subject` — ЛИЧНОЕ поле, решает только сам
 * человек (его настройки для Окружения и для коллег объединяются); `controller` —
 * СЛУЖЕБНОЕ поле, решает только организация (Окружение его не расширяет никогда).
 */
export const VISIBILITY_FIELD_CONTROLS = ['subject', 'controller'] as const;
export type VisibilityFieldControl = (typeof VISIBILITY_FIELD_CONTROLS)[number];

/** Группа полей — единица строки матрицы (поле — исключение из группы). */
export const VISIBILITY_FIELD_GROUPS = [
  'identity',
  'profile',
  'contacts',
  'address',
  'presence',
  'requisites',
  'finance',
  'employment',
  'schedule',
  'business',
  'health',
] as const;
export type VisibilityFieldGroup = (typeof VISIBILITY_FIELD_GROUPS)[number];

/** Что полю вообще разрешено при `full` (фильтр, сортировка, поиск, выгрузка…). */
export const VISIBILITY_FIELD_CAPS = ['filter', 'sort', 'search', 'group', 'aggregate', 'export', 'notify', 'template', 'webhook', 'ai'] as const;
export type VisibilityFieldCap = (typeof VISIBILITY_FIELD_CAPS)[number];

/**
 * Маски — ОДНА на вид данных на ВСЕХ поверхностях (продукт, Кабинет, логи). Считаются
 * только на сервере (`masks.ts`); зритель получает символы маски, а не слова.
 */
export const VISIBILITY_MASK_KINDS = [
  'hidden',
  'phone_partial',
  'email_partial',
  'id_last4',
  'name_initials',
  'date_year',
  'date_month_day',
  'time_bucket',
  'money_bucket',
  'address_city',
  'geo_offset',
  'card_last4',
  'text_hidden',
] as const;
export type VisibilityMaskKind = (typeof VISIBILITY_MASK_KINDS)[number];

/** Допустимые маски по виду данных (кроме `hidden` — он допустим всегда). */
export const VISIBILITY_KIND_MASKS: Record<VisibilityFieldKind, readonly VisibilityMaskKind[]> = {
  phone: ['phone_partial'],
  email: ['email_partial'],
  id_number: ['id_last4'],
  account: ['id_last4'],
  name: ['name_initials'],
  date: ['date_year', 'date_month_day'],
  money: ['money_bucket'],
  text: ['text_hidden'],
  address: ['address_city', 'text_hidden'],
  geo: ['geo_offset'],
  bool: [],
  number: [],
  enum: [],
  card: ['card_last4'],
  presence: ['time_bucket'],
  image: [],
  url: ['text_hidden'],
  file: [],
};

/** Раскрытие маскированного значения: нет / по одной записи. `delegated` — только в правиле. */
export const VISIBILITY_REVEAL_MODES = ['none', 'one'] as const;
export type VisibilityRevealMode = (typeof VISIBILITY_REVEAL_MODES)[number];
export const VISIBILITY_RULE_REVEAL_MODES = ['none', 'one', 'delegated'] as const;
export type VisibilityRuleRevealMode = (typeof VISIBILITY_RULE_REVEAL_MODES)[number];

/** Что субъект видит о СЕБЕ: `full` — всегда (оклад, ИИН); `policy` — как все; `hidden` — черновик приказа о нём. */
export const VISIBILITY_SELF_MODES = ['full', 'policy', 'hidden'] as const;
export type VisibilitySelfMode = (typeof VISIBILITY_SELF_MODES)[number];

/** Чья политика: организации или человека (Party-паттерн: одна таблица). */
export const VISIBILITY_OWNER_KINDS = ['workspace', 'user'] as const;
export type VisibilityOwnerKind = (typeof VISIBILITY_OWNER_KINDS)[number];

/** Назначение ответа: наружу (`webhook`/`guest`/`ai`) скрытое поле ОТСУТСТВУЕТ, внутри — маркер. */
export const VISIBILITY_PURPOSES = ['api', 'list', 'card', 'export', 'search', 'notify', 'ai', 'webhook', 'guest', 'explain'] as const;
export type VisibilityPurpose = (typeof VISIBILITY_PURPOSES)[number];
export const VISIBILITY_EXTERNAL_PURPOSES: readonly VisibilityPurpose[] = ['ai', 'webhook', 'guest'];

/**
 * Адресаты правил ОРГАНИЗАЦИИ. `role` — столбец лестницы (id — роль); `department` /
 * `position` / `branch` — словарь `core/audiences` (замок тарифа `visibility.orgAudiences`);
 * `manager_of` — зритель руководит субъектом записи; `branch_head_of` — зритель руководит
 * объектом записи (или основным местом субъекта).
 */
export const VISIBILITY_WORKSPACE_AUDIENCE_KINDS = ['role', 'department', 'position', 'branch', 'manager_of', 'branch_head_of', 'branch_payroll', 'branch_scheduler'] as const;
export type VisibilityWorkspaceAudienceKind = (typeof VISIBILITY_WORKSPACE_AUDIENCE_KINDS)[number];
/** Адресаты оргструктуры — за замком тарифа (решение грилла №11). */
export const VISIBILITY_ORG_AUDIENCE_KINDS = ['department', 'position', 'branch'] as const;
/**
 * Относительные адресаты: вычисляются по записи, id у них нет. `branch_payroll` — у зрителя
 * пообъектный грант «видит деньги объекта» (`branch#payroll_viewer`, права объекта): его
 * выдают на экране объекта, матрица его показывает, но не создаёт. `branch_scheduler` — зритель
 * ведёт график объекта (руководитель, управляющий или делегат `branch#scheduler`): тот, кто
 * отмечает факт выходов, обязан его видеть.
 */
export const VISIBILITY_RELATIVE_KINDS = ['manager_of', 'branch_head_of', 'branch_payroll', 'branch_scheduler'] as const;
export type VisibilityRelativeKind = (typeof VISIBILITY_RELATIVE_KINDS)[number];

/**
 * Адресаты ЛИЧНОЙ политики человека (решение грилла №8): все · всё Окружение · Группа ·
 * коллеги (по организациям, где оба в команде; с id — только в одной) · человек
 * (исключения «всегда/никогда»). «Никто» — отсутствие аудиторий.
 */
export const VISIBILITY_PERSONAL_AUDIENCE_KINDS = ['everybody', 'circle_all', 'circle', 'colleagues', 'user'] as const;
export type VisibilityPersonalAudienceKind = (typeof VISIBILITY_PERSONAL_AUDIENCE_KINDS)[number];

export const VISIBILITY_AUDIENCE_KINDS = [...VISIBILITY_WORKSPACE_AUDIENCE_KINDS, ...VISIBILITY_PERSONAL_AUDIENCE_KINDS] as const;
export type VisibilityAudienceKind = (typeof VISIBILITY_AUDIENCE_KINDS)[number];

/** Аудитория личного поля по умолчанию (без id). */
export type VisibilityPersonalDefault = 'everybody' | 'circle_all' | 'colleagues';

/** Умолчания уровня — на тип, секцию или поле (без общего состояния между типами). */
export interface VisibilityDefaults {
  /** Служебные поля: уровень по роли в организации */
  roles?: Partial<Record<WorkspaceRole, VisibilityLevel>>;
  /** Служебные поля: уровень по относительному адресату (руководитель, руководитель объекта) */
  relative?: Partial<Record<VisibilityRelativeKind, VisibilityLevel>>;
  /** Кто раскрывает маску по умолчанию (решение грилла №7: владелец и админ) */
  reveal?: readonly WorkspaceRole[];
  /** Личные поля: аудитории по умолчанию (пусто = «Никто») */
  audiences?: readonly VisibilityPersonalDefault[];
}

/** Что видит зритель ЛИЧНОГО поля, если ни одна его аудитория не совпала. */
export interface VisibilityPersonalFallback {
  /** Связанный человек (Окружение или коллега) — «скрыт ≠ недостижим»: маска */
  known?: 'masked' | 'hidden';
  /** Посторонний (находимость по номеру, пре-линк карточка) */
  stranger?: 'masked' | 'hidden';
}

/** Паспорт поля. */
export interface VisibilityFieldDef {
  kind: VisibilityFieldKind;
  class: VisibilityFieldClass;
  control: VisibilityFieldControl;
  group: VisibilityFieldGroup;
  /** Допустимые маски (первая — маска уровня `masked` по умолчанию); ⊆ `VISIBILITY_KIND_MASKS[kind]` */
  masks?: readonly VisibilityMaskKind[];
  /** Что разрешено полю при `full` */
  caps?: readonly VisibilityFieldCap[];
  /** По умолчанию `full` */
  self?: VisibilitySelfMode;
  /** Кому поле обязано быть видно всегда: `self` (ТК ст. 113), `owner` */
  mandatoryVisible?: readonly ('self' | 'owner')[];
  /** Закон требует ≥ 1 аудитории `full` — публикация без неё отвергается */
  legalDuty?: true;
  /** Производное поле: наследует MAX класса входов (страж) */
  derivedFrom?: readonly string[];
  /** Взаимность (только `presence`): скрыл своё — не видишь чужое точно */
  reciprocal?: true;
  /** Колонка `PII_MODELS` (страж: каждое `sensitive` поле ПДн объявлено) */
  pii?: { model: string; field: string };
  /** Переопределение умолчаний секции/типа */
  defaults?: VisibilityDefaults;
  /** Только личные поля */
  fallback?: VisibilityPersonalFallback;
  /** Строка в UI настроек (иначе — фиксированное умолчание, в матрице приглушено) */
  configurable?: boolean;
  /** Границы корзин `money_bucket` (в минимальных единицах валюты, по возрастанию) */
  moneyBuckets?: readonly number[];
}

export interface VisibilitySectionDef {
  fields: Record<string, VisibilityFieldDef>;
  defaults?: VisibilityDefaults;
}

/** Паспорт типа записи. */
export interface VisibilityTypeDef {
  /** Сервис-владелец (корзина матрицы, провайдер в API регистрирует он) */
  service: string;
  /** Чья политика правит ЭТИМ типом: организации или самого человека */
  owner: VisibilityOwnerKind;
  /** Чья запись: человека (для `self` / руководителя) либо ничья (карточка организации, контрагент) */
  subject: 'user' | 'none';
  sections: Record<string, VisibilitySectionDef>;
  /** Поля, видимые ВСЕМ, у кого есть право на запись (в `sections` их нет) */
  floor: readonly string[];
  defaults: VisibilityDefaults;
  /** Этапы записи: правило может быть ограничено этапом */
  stages?: readonly string[];
}

/** Хелпер объявления файла сервиса: сохраняет литеральные ключи. */
export function defineVisibilityTypes<const T extends Record<string, VisibilityTypeDef>>(defs: T): T {
  return defs;
}

// ============================================================
// Провод (P): `Guarded<T>` — типизированный объект В САМОМ поле (решение грилла №4)
// ============================================================
// `null` = «пусто», маркер = «есть, но не для вас». Компилятор заставляет обработать
// маркер там, где поле читается; правка (PATCH) принимает только `T`.

export interface Masked {
  $v: 'masked';
  mask: VisibilityMaskKind;
  /** Символы маски (`+7 70* *** *5 67`), не слова; `null` — пусто либо маска полного скрытия */
  display: string | null;
  /** Можно раскрыть эту одну запись кнопкой «Показать» (`POST /visibility/reveal`) */
  reveal: VisibilityRevealMode;
}
export interface Hidden {
  $v: 'hidden';
}
export type Guarded<T> = T | Masked | Hidden;

export const HIDDEN: Hidden = Object.freeze({ $v: 'hidden' as const }) as Hidden;

/** Значение — маркер движка (маска или скрыто)? */
export function isGuardMarker(v: unknown): v is Masked | Hidden {
  return !!v && typeof v === 'object' && !Array.isArray(v) && ((v as { $v?: unknown }).$v === 'masked' || (v as { $v?: unknown }).$v === 'hidden');
}
export function isMasked(v: unknown): v is Masked {
  return !!v && typeof v === 'object' && (v as { $v?: unknown }).$v === 'masked';
}
export function isHidden(v: unknown): v is Hidden {
  return !!v && typeof v === 'object' && (v as { $v?: unknown }).$v === 'hidden';
}
/** Поле видно полностью (значение `T`, включая `null` = пусто). */
export function isVisible<T>(v: Guarded<T>): v is T {
  return !isGuardMarker(v);
}
/** Значение или запасное (для мест, где маска не рисуется: сортировка, подпись). */
export function visibleOr<T, F>(v: Guarded<T>, fallback: F): T | F {
  return isGuardMarker(v) ? fallback : v;
}

/**
 * Для подписей и текста: значение (видно), символы маски (маска), `null` (скрыто). Фамилия
 * постороннему — «Н.»; номер знакомому при «скрыто» — «+7 70* *** *5 67».
 */
export function guardedDisplay<T>(v: Guarded<T>): T | string | null {
  if (isMasked(v)) return v.display;
  if (isHidden(v)) return null;
  return v as T;
}

/** Причина решения — для «Почему» (explain) и подсказок UI. */
export const VISIBILITY_WHY_SOURCES = [
  'floor',
  'self',
  'mandatory',
  'rule',
  'deny',
  'default',
  'ceiling',
  'personal',
  'personal_exception',
  'personal_fallback',
  'reciprocal',
  'bot_ceiling',
  'purpose',
  'no_record',
  'error',
] as const;
export type VisibilityWhySource = (typeof VISIBILITY_WHY_SOURCES)[number];
