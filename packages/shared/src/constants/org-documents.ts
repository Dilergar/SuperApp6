// ============================================================
// Сервис «Документы» (B2B) — справочники, статусы, лимиты.
//
// НЕ путать с `constants/documents.ts`: там движок core/docs (файл + редактор),
// здесь — сервис документооборота организации, который на нём стоит.
//
// Вид документа — справочник ОРГАНИЗАЦИИ (её приказы нумеруются по её правилам),
// а не платформенный список: у каждой компании свой набор бумаг.
// ============================================================

/** Полиморфный ключ карточки документа во всех движках (approvals, chatter, search) */
export const ORG_DOCUMENT_REF_TYPE = 'org_document';

/**
 * Категория вида — от неё зависят профиль редактора маршрутов и правила ТК РК.
 *
 * `external` («С контрагентами») — ВНЕШНИЙ контур документооборота: договоры и
 * АВР, где вторая сторона подписывает по гостевой ссылке. По маршрутам Процессов
 * такие виды в v1 не ходят вовсе (путь прямой: черновик → «Отправить контрагенту»),
 * поэтому surface у категории нет — нарисованный маршрут было бы нечем запустить.
 */
export const DOC_CATEGORIES = ['hr', 'general', 'external'] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

/** Профиль редактора маршрутов; у `external` его НЕТ (маршруты для него — не в v1) */
export const DOC_CATEGORY_SURFACE: Partial<Record<DocCategory, string>> = {
  hr: 'documents.hr',
  general: 'documents.general',
};

/**
 * Кто видит документы этого вида. Автор, сторона и участники маршрута видят ВСЕГДА —
 * настройка добавляет зрителей сверх них, а не отнимает у них.
 */
export const DOC_VISIBILITIES = ['managers', 'department', 'team'] as const;
export type DocVisibility = (typeof DOC_VISIBILITIES)[number];

/**
 * Чем подписывается документ ЭТОГО вида (core/sign).
 *
 * Уровень задаёт ВИД, а не каждый маршрут по отдельности: кадровые документы по
 * ст. 33 ТК РК требуют именно ЭЦП, и выбирать это руками на каждом маршруте —
 * способ однажды забыть. `none` — «подписи не требуется»: акт приёмки внутри
 * компании законно закрывается согласованием.
 */
export const DOC_SIGNATURE_LEVELS = ['none', 'pep', 'ecp'] as const;
export type DocSignatureLevel = (typeof DOC_SIGNATURE_LEVELS)[number];

/**
 * Жизненный путь документа. Отдельные `signed` и `registered` — не бюрократия:
 * подпись даёт силу, номер даёт место в книге регистрации, и по ТК РК это разные
 * события с разными датами.
 */
export const DOC_STATUSES = [
  'draft',
  'in_review',
  // Внешний этап (категория «С контрагентами»): документ у второй стороны
  'sent',
  'rejected',
  'declined_external',
  'signed',
  'registered',
  'active',
  'cancelled',
  'archived',
] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

/** Статусы, в которых документ ещё правится автором (после отправки правка закрыта) */
export const DOC_EDITABLE_STATUSES: readonly DocStatus[] = ['draft', 'rejected'];

/**
 * Статусы, в которых документ ЕЩЁ ИДЁТ по маршруту, — то есть ноды вправе присвоить
 * номер, пометить подписанным и подшить.
 *
 * Отменённый сюда не входит: маршрут исполняется асинхронно и может дойти до своей
 * ноды уже после того, как человек нажал «Отменить», — без этой проверки отменённый
 * документ получал номер из книги регистрации и уезжал в личное дело.
 */
export const DOC_ROUTABLE_STATUSES: readonly DocStatus[] = ['in_review', 'signed', 'registered', 'active'];

/**
 * Документ «в работе» — блокирует архив ВИДА. `sent` здесь обязателен: документ
 * у контрагента — это идущий процесс, и убрать его вид в архив значило бы
 * оставить возвращающийся документ без справочника.
 */
export const DOC_IN_WORK_STATUSES: readonly DocStatus[] = ['draft', 'in_review', 'sent'];

/**
 * Срок подписания контрагентом по умолчанию (задаётся при отправке). Истёк →
 * документ АВТОМАТИЧЕСКИ возвращается в черновик, автору уходит уведомление.
 */
export const DOC_EXTERNAL_DEFAULT_TTL_DAYS = 30;

/** Сколько внутренних подписантов можно назначить при отправке контрагенту */
export const DOC_EXTERNAL_MAX_INTERNAL_SIGNERS = 10;

/** Виды полей формы подачи (то, что заполняет сотрудник перед отправкой) */
export const DOC_FIELD_KINDS = ['text', 'textarea', 'number', 'date', 'daterange', 'select'] as const;
export type DocFieldKind = (typeof DOC_FIELD_KINDS)[number];

/** Значение поля «Период дат»: один день = from === to (в форме — тумблер «один день») */
export interface DocDateRangeValue {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isDocDateRangeValue(v: unknown): v is DocDateRangeValue {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.from === 'string' && ISO_DATE.test(r.from) && typeof r.to === 'string' && ISO_DATE.test(r.to);
}

/** Календарное число дней периода включительно («с 1 по 14» = 14) */
export function docDateRangeDays(v: DocDateRangeValue): number {
  const [fy, fm, fd] = v.from.split('-').map(Number);
  const [ty, tm, td] = v.to.split('-').map(Number);
  const diff = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
  return diff + 1;
}

// Разворот значений формы в теги шаблона, группа тегов «Документ» и формат
// номера — это СИНТАКСИС бланка, а не интерфейс: они живут в `doc-template-dsl.ts`
// и переезжают на другие языки вместе с бланками (docs/i18n_migration.md).

/**
 * Кому выдаётся бланк. Тот же список, что в `docTemplateGrantSchema`: у снятия
 * доступа тип приезжает ИЗ ПУТИ, мимо схемы тела, и сверять его надо этим же списком.
 */
export const DOC_GRANT_PRINCIPAL_TYPES: readonly string[] = ['user', 'department', 'position', 'branch'];

export const DOC_LIMITS = {
  maxTypesPerWorkspace: 100,
  maxTemplatesPerType: 50,
  maxFormFields: 30,
  maxNameLength: 120,
  maxTitleLength: 200,
  maxNumberFormatLength: 40,
  /**
   * Потолок ЗНАЧЕНИЯ поля формы подачи. Значение попадает в документ и в анкету
   * запуска маршрута, поэтому оно ограничено так же, как поля анкеты процессов.
   */
  maxFieldValueLength: 500,
  /** Страница реестра документов */
  pageSize: 50,
  maxPageSize: 200,
} as const;
