// ============================================================
// core/lifecycle (28-й платформенный движок) — словарь реестра ЖИЗНЕННОГО ЦИКЛА ДАННЫХ
// ============================================================
// Каждое хранилище платформы (модель Prisma, сырая таблица, профиль файлов, семейство
// ключей Redis, производное хранилище вне БД) объявляет ПОЛИТИКУ: чьи это данные, сколько
// их хранить и почему, что делать при стирании человека и при удалении организации, как
// срок принуждается и какие рёбра удаления ведут к соседям. Знание «что стирать и в каком
// порядке» живёт здесь, а не в головах и не в порядке строк `purgeWorkspace` (GitLab data
// dictionary + Meta DELF + Elastic ILM).
//
// Правила чтения реестра (несущие):
//  - пустое поле срока = ХРАНИТЬ, и страж `pnpm check:lifecycle` краснеет (урок Google /
//    UniSuper 2024: пустой параметр стал сроком и удалил облако);
//  - длительности — только целые сутки в полях `*Days` или литерал `'forever'` (урок
//    pg_partman #811: строка `'10'` стала десятью секундами);
//  - приоритет: legal hold > пол закона > стирание субъекта > потолок > умолчание;
//    несколько «хранить» — побеждает длиннее, несколько «удалить» — короче.
// Слова для человека — каталог `lifecycle.*` в `@superapp/i18n`, не здесь.

/** Классы данных (таксономия GitLab data classification). Порядок — порядок в интерфейсах. */
export const LIFECYCLE_DATA_CLASSES = [
  'identity_pii',
  'auth_secret',
  'user_content_private',
  'user_content_shared',
  'tenant_record',
  'legal_record',
  'financial_record',
  'security_audit',
  'operational',
  'analytics_event',
  'derived',
  'ephemeral',
] as const;
export type LifecycleDataClass = (typeof LIFECYCLE_DATA_CLASSES)[number];

/** Классы, где legal hold обязан перекрывать удаление (`holdAware: false` запрещён стражем). */
export const LIFECYCLE_HOLD_REQUIRED_CLASSES: readonly LifecycleDataClass[] = [
  'legal_record',
  'tenant_record',
  'user_content_private',
  'user_content_shared',
];

/**
 * Род «коло» — ключа владельца (Figma colos, Ant LDC): по нему данные когда-нибудь уедут в
 * ячейку. `global` — справочники, планы, реестры, личность и сессии (G-hot/G-cold у Ant).
 */
export const LIFECYCLE_OWNER_KINDS = ['user', 'workspace', 'conversation', 'ledger', 'global'] as const;
export type LifecycleOwnerKind = (typeof LIFECYCLE_OWNER_KINDS)[number];

/**
 * Ключ владельца:
 *  - `column` — колонка ЭТОЙ модели (P-модель: индекс обязан вести ею — отчёт готовности к ячейкам);
 *  - `via` — владелец у родителя (id политики родителя): строка живёт внутри чужой записи;
 *  - `polymorphic` — `ownerType + ownerId` (Диск, Заметки, файлы, счета);
 *  - `scoped` — B2C и B2B в одной таблице: организация, если `workspaceColumn` заполнена,
 *    иначе человек `userColumn` (задачи, хроника, решения, ключи API);
 *  - `global` — не принадлежит одному владельцу (с причиной).
 */
export type LifecycleOwnerKey =
  | { kind: Exclude<LifecycleOwnerKind, 'global'>; column: string }
  | { kind: Exclude<LifecycleOwnerKind, 'global'>; via: string }
  | { kind: 'polymorphic'; typeColumn: string; column: string; kinds: readonly Exclude<LifecycleOwnerKind, 'global'>[] }
  | { kind: 'scoped'; workspaceColumn: string; userColumn?: string; conversationColumn?: string }
  | { kind: 'global'; reason: string };

/** Роль человека в строке (DELF edges): чьи это данные и кого касается стирание. */
export const LIFECYCLE_SUBJECT_ROLES = [
  'owner',
  'author',
  'recipient',
  'participant',
  'member',
  'mentioned',
  'employee',
  'actor',
  'counterpart',
  'guest',
] as const;
export type LifecycleSubjectRole = (typeof LIFECYCLE_SUBJECT_ROLES)[number];
export interface LifecycleSubject {
  column: string;
  role: LifecycleSubjectRole;
}

/**
 * Нормы права, на которые ссылается реестр (пол срока, основание хранения). Код — ключ
 * каталога `lifecycle.citations.<code>` (человек видит норму своими словами); текст
 * нормы в коде не пишется. Спорное — с пометкой в каталоге и в `docs/legal_kz.md`.
 */
export const LIFECYCLE_CITATIONS = [
  /** ЗоПД РК ст. 12: хранение ПДн — в РК, не дольше цели обработки */
  'kz_pd_law_art12',
  /** ЗоПД РК ст. 8 п. 7: удаление по требованию субъекта — 15 рабочих дней */
  'kz_pd_law_art8_7',
  /** ГК РК ст. 41 п. 4 (права третьих лиц): переписка остаётся у собеседников */
  'kz_civil_code_art41_4',
  /** Приказ № 263 (279-НҚ) — приказы по личному составу, лицевые счета: 75 лет */
  'kz_279_personnel_75y',
  /** 279-НҚ — трудовые договоры (источники расходятся 5/75 — до заключения юриста 75) */
  'kz_279_employment_contracts',
  /** 279-НҚ — табели учёта рабочего времени: 5 лет (вредные условия — 75) */
  'kz_279_timesheets_5y',
  /** 279-НҚ — хозяйственные договоры и первичные документы: 5 лет после события */
  'kz_279_contracts_5y',
  /** Закон РК о платежах и платёжных системах ст. 13: хранение сведений 5 лет */
  'kz_payments_law_art13',
  /** Закон РК о ПОД/ФТ ст. 5: сведения об операциях 5 лет после прекращения отношений */
  'kz_aml_law_art5',
  /** Налоговый кодекс РК: хранение учётной документации в сроке исковой давности */
  'kz_tax_code_records',
  /** Цифровой кодекс РК ст. 62: электронная подпись и доказательства — срок документа */
  'kz_digital_code_art62',
  /** Единые требования № 832 п. 38: журналы безопасности 3 года, онлайн ≥ 2 месяцев */
  'kz_et832_p38',
  /** ЗоПД РК ст. 7–8: согласие и его отзыв — доказательство обработки */
  'kz_pd_law_consent_evidence',
  /** Правила № 179 (инциденты ПДн): журнал инцидентов и уведомлений */
  'kz_pd_incident_rules',
] as const;
export type LifecycleCitation = (typeof LIFECYCLE_CITATIONS)[number];

/** Основание хранения. `legal_obligation` без нормы — красный CI. */
export type LifecycleLegalBasis =
  | { kind: 'consent' }
  | { kind: 'contract' }
  | { kind: 'legal_obligation'; citation: LifecycleCitation }
  | { kind: 'legitimate_interest'; reason: string };

/** Бессрочно (до удаления владельцем / навсегда по закону). Единственная НЕ-числовая длительность. */
export const LIFECYCLE_FOREVER = 'forever' as const;
/** Длительность — целые сутки (> 0) или `'forever'`. Строка-число — ошибка стража. */
export type LifecycleDuration = number | typeof LIFECYCLE_FOREVER;

/**
 * События-триггеры срока (Purview event-based retention): отсчёт начинается не с момента
 * записи, а с факта — «после закрытия счёта», «после увольнения».
 */
export const LIFECYCLE_EVENTS = [
  'account.erased',
  'workspace.purged',
  'employment.ended',
  'record.closed',
  'archived',
  'account.closed',
  'revoked',
  'expired',
  'terminal',
] as const;
export type LifecycleEventName = (typeof LIFECYCLE_EVENTS)[number];

/**
 * Откуда отсчитывается срок:
 *  - `created` — от создания строки;
 *  - `lastActivity` — от последней активности (сессии, устройства);
 *  - `parent` — живёт и умирает с родителем (ребёнок по рёбрам удаления);
 *  - `event:<имя>` — от события (закрытие счёта, увольнение, стирание аккаунта).
 */
export type LifecycleRetentionTrigger = 'created' | 'lastActivity' | 'parent' | `event:${LifecycleEventName}`;

export interface LifecycleRetention {
  trigger: LifecycleRetentionTrigger;
  /** Пол закона: ниже нельзя ни организации, ни тарифу, ни человеку */
  floorDays?: LifecycleDuration;
  /** Умолчание — ОБЯЗАТЕЛЬНО (пусто = красный CI) */
  defaultDays: LifecycleDuration;
  /** Потолок минимизации / тарифа: дольше хранить нельзя */
  ceilingDays?: LifecycleDuration;
  /** Организация выбирает срок в коридоре [пол; потолок] (`lifecycle_settings` по классу данных) */
  tenantConfigurable?: boolean;
  /** Человек выбирает срок сам (таймер автоудаления чата) */
  userConfigurable?: boolean;
  /** Ключ тарифа, дающий потолок (`lifecycle.retention.<class>.ceilingDays`) */
  entitlementKey?: string;
}

/** Что делать со следом человека при стирании его аккаунта (DELF, GitLab ghost, Stripe redaction). */
export type LifecycleSubjectErasure =
  /** `personalOnly` — только строки вне организации (личная задача стирается, задача организации остаётся) */
  | { kind: 'hard_delete'; personalOnly?: boolean }
  | { kind: 'crypto_shred'; keyScope: 'user' | 'workspace' }
  | { kind: 'pseudonymize'; fields: readonly string[] }
  | { kind: 'redact'; fields: readonly string[] }
  | { kind: 'retain_legal'; citation: LifecycleCitation; untilDays: LifecycleDuration }
  | { kind: 'none'; reason: string };

/** Что делать при окончательном удалении организации (замена «знания в голове» о каскаде). */
export type LifecycleTenantPurge =
  | { kind: 'cascade_fk' }
  | { kind: 'registry_hook'; key: string }
  | { kind: 'batched_delete'; column: string }
  | { kind: 'crypto_shred' }
  | { kind: 'retain_legal'; citation: LifecycleCitation; untilDays: LifecycleDuration }
  | { kind: 'not_applicable' };

/**
 * Рёбра графа удаления (Meta DELF, GitLab loose FK):
 *  - `deep` — удаление родителя удаляет ребёнка (каскад);
 *  - `shallow` — удаляется только связь, ребёнок живёт (у него другие владельцы);
 *  - `refcount` — ребёнок умирает с последним родителем (файл с несколькими местами —
 *    Facebook 2018: видео удалили вместе с эфемерной копией);
 *  - `async_delete` / `async_nullify` — строки без FK добирает воркер `lifecycle.loose-fk`.
 */
export const LIFECYCLE_EDGE_KINDS = ['deep', 'shallow', 'refcount', 'async_delete', 'async_nullify'] as const;
export type LifecycleEdgeKind = (typeof LIFECYCLE_EDGE_KINDS)[number];
export interface LifecycleEdge {
  /** id политики ребёнка */
  to: string;
  kind: LifecycleEdgeKind;
  /** Колонка ребёнка, которая указывает на родителя (FK или полиморфная ссылка) */
  via?: string;
}

/** Ярусы хранения (Elastic ILM): cold = NDJSON.gz + подписанный манифест в объектном хранилище. */
export interface LifecycleTier {
  tier: 'hot' | 'warm' | 'cold';
  minAgeDays: number;
  /** Не сбрасывать горячее, пока архив не выгружен и не сверен (ILM `wait_for_snapshot`) */
  waitForArchive?: boolean;
}

/**
 * Как срок принуждается:
 *  - `drop_partition` — сброс целой партиции (> 50 ГБ — только так, GitLab);
 *  - `batched_delete` — раннер `lifecycle.purge.<policy>` батчами по ведущему индексу `column`;
 *  - `ttl_sweep` — TTL самого хранилища (Redis, presign);
 *  - `transient` — живёт секунды/минуты и не копится;
 *  - `cascade` — уходит с родителем по рёбрам удаления (свой срок не нужен);
 *  - `none` — не принуждается (вечное / удаляет владелец) — только с причиной.
 */
export type LifecycleEnforcement =
  | { kind: 'drop_partition'; column: string; period: 'day' | 'month' }
  | {
      kind: 'batched_delete';
      /** Колонка времени, от которой считается срок (ведущий индекс раннера) */
      column: string;
      /** Дополнительное условие строки: колонка ∈ значений (`null` = IS NULL). Сырой SQL в реестре запрещён */
      filter?: LifecycleRowFilter;
      /** Свой шаг purge модуля-владельца (`LifecyclePurgeHandlerRegistry`) — когда фильтра мало */
      handler?: string;
    }
  | { kind: 'ttl_sweep' }
  | { kind: 'transient' }
  | { kind: 'cascade' }
  | { kind: 'none'; reason: string };

/**
 * Условие строки для раннера purge: `{ status: ['completed'] }` = `status IN ('completed')`,
 * `{ savedAt: [null] }` = `saved_at IS NULL`. Только имена колонок модели и литералы — раннер
 * собирает SQL сам (идентификаторы проверяются по схеме, значения — параметрами).
 */
export type LifecycleRowFilter = Readonly<Record<string, readonly (string | null)[]>>;

/** Дополнительное правило срока той же таблицы (джобы: completed — сутки, discarded — 30 дней). */
export interface LifecycleExtraRule {
  filter: LifecycleRowFilter;
  days: number;
  /** Колонка времени правила (по умолчанию — колонка основного правила) */
  column?: string;
}

/** Роль инстанса Redis для семейства ключей (две роли: состояние ≠ кэш). */
export type LifecycleRedisRole = 'state' | 'cache' | 'external';

/** Хранилище, которое описывает политика. */
export type LifecycleStore =
  | { kind: 'model'; model: string }
  | { kind: 'table'; table: string }
  | { kind: 'blob'; profile: string }
  | {
      kind: 'redis';
      family: string;
      /** Glob-шаблоны ключей семейства (`presence:*:lastSeen`) — по ним сверяется живой Redis */
      patterns: readonly string[];
      role: LifecycleRedisRole;
      /** Потолок TTL (сек); `null` — без TTL (стрим с MAXLEN, эпоха, водяной знак) */
      maxTtlSeconds: number | null;
      /** Шаблон ключей человека (`{user}` подставляется) — стирание субъекта = DEL по шаблону */
      subjectPattern?: string;
    }
  | { kind: 'derived'; name: string; location: string };

export type LifecycleStoreKind = LifecycleStore['kind'];

/** Политика жизненного цикла одного хранилища. */
export interface LifecyclePolicy {
  /** id политики: имя модели Prisma, `table:<schema.table>`, `blob:<profile>`, `redis:<family>`, `derived:<name>` */
  id: string;
  store: LifecycleStore;
  /** Модуль-владелец (`messenger`, `core/audit`, …) — он отвечает за хуки стирания и экспорта */
  owner: string;
  /** Версия политики: СОКРАЩЕНИЕ срока = новая версия + dry-run-отчёт + «четыре глаза»; удлинение свободно */
  version: number;
  dataClass: LifecycleDataClass;
  ownerKey: LifecycleOwnerKey;
  subjects: readonly LifecycleSubject[];
  legalBasis: LifecycleLegalBasis;
  retention: LifecycleRetention;
  onSubjectErasure: LifecycleSubjectErasure;
  onTenantPurge: LifecycleTenantPurge;
  edges: readonly LifecycleEdge[];
  tiers?: readonly LifecycleTier[];
  enforcement: LifecycleEnforcement;
  /** Дополнительные правила срока (только при `batched_delete`) */
  extraRules?: readonly LifecycleExtraRule[];
  /** Legal hold перекрывает удаление этой политики (обязателен у legal/tenant/user_content_*) */
  holdAware: boolean;
  /** Ключ `core/audit`, которым доказывается каждый прогон/стирание */
  proofEvent?: string;
  /** Флаг остановки принуждения (GitLab pause_mechanism) — выключатель в коде */
  pause?: boolean;
  /** Модель — корень пользовательской сущности (обязана иметь мягкое скрытие `deletedAt`) */
  rootEntity?: boolean;
  /** Модель — экспортируется человеку/организации (`LifecycleExportRegistry`) */
  exportable?: 'user' | 'workspace' | 'both';
}

/** Политика в файле области: id и `store` модели дописывает реестр. */
export type LifecyclePolicyInput = Omit<LifecyclePolicy, 'id' | 'store'> & { store?: LifecycleStore };

/** Корни графа удаления (DELF): от них по рёбрам достижимо всё, что не `global`. */
export const LIFECYCLE_ROOTS = ['User', 'Workspace', 'Chat'] as const;

/** Источник действующего срока (для объяснения в UI и в отчёте прогона). */
export type LifecycleRetentionSource = 'hold' | 'floor' | 'erasure' | 'ceiling' | 'tenant' | 'user' | 'default';

/** Действующий срок с объяснением. `days = 'forever'` — не удаляется. */
export interface LifecycleEffectiveRetention {
  days: LifecycleDuration;
  source: LifecycleRetentionSource;
}
