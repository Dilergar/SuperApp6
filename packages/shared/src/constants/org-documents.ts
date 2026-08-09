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

/** Категория вида — от неё зависят профиль редактора маршрутов и правила ТК РК */
export const DOC_CATEGORIES = [
  { value: 'hr', label: 'Кадры', surface: 'documents.hr' },
  { value: 'general', label: 'Общие', surface: 'documents.general' },
] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number]['value'];

export const DOC_CATEGORY_SURFACE: Record<DocCategory, string> = {
  hr: 'documents.hr',
  general: 'documents.general',
};

/**
 * Кто видит документы этого вида. Автор, сторона и участники маршрута видят ВСЕГДА —
 * настройка добавляет зрителей сверх них, а не отнимает у них.
 */
export const DOC_VISIBILITIES = [
  { value: 'managers', label: 'Только управляющие' },
  { value: 'department', label: 'Отдел сотрудника' },
  { value: 'team', label: 'Вся команда' },
] as const;
export type DocVisibility = (typeof DOC_VISIBILITIES)[number]['value'];

/**
 * Чем подписывается документ ЭТОГО вида (core/sign).
 *
 * Уровень задаёт ВИД, а не каждый маршрут по отдельности: кадровые документы по
 * ст. 33 ТК РК требуют именно ЭЦП, и выбирать это руками на каждом маршруте —
 * способ однажды забыть. `none` — «подписи не требуется»: акт приёмки внутри
 * компании законно закрывается согласованием.
 */
export const DOC_SIGNATURE_LEVELS = [
  { value: 'none', label: 'Без электронной подписи' },
  { value: 'pep', label: 'Простая подпись (код из SMS)' },
  { value: 'ecp', label: 'ЭЦП (ключ НУЦ РК)' },
] as const;
export type DocSignatureLevel = (typeof DOC_SIGNATURE_LEVELS)[number]['value'];

/**
 * Жизненный путь документа. Отдельные `signed` и `registered` — не бюрократия:
 * подпись даёт силу, номер даёт место в книге регистрации, и по ТК РК это разные
 * события с разными датами.
 */
export const DOC_STATUSES = [
  { value: 'draft', label: 'Черновик' },
  { value: 'in_review', label: 'На маршруте' },
  { value: 'rejected', label: 'Отклонён' },
  { value: 'signed', label: 'Подписан' },
  { value: 'registered', label: 'Зарегистрирован' },
  { value: 'active', label: 'Действует' },
  { value: 'cancelled', label: 'Отменён' },
  { value: 'archived', label: 'В архиве' },
] as const;
export type DocStatus = (typeof DOC_STATUSES)[number]['value'];

export const DOC_STATUS_LABELS = DOC_STATUSES.reduce(
  (acc, s) => ({ ...acc, [s.value]: s.label }),
  {} as Record<DocStatus, string>,
);

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

/** Виды полей формы подачи (то, что заполняет сотрудник перед отправкой) */
export const DOC_FIELD_KINDS = [
  { value: 'text', label: 'Строка' },
  { value: 'textarea', label: 'Текст' },
  { value: 'number', label: 'Число' },
  { value: 'date', label: 'Дата' },
  { value: 'daterange', label: 'Период дат' },
  { value: 'select', label: 'Выбор из списка' },
] as const;
export type DocFieldKind = (typeof DOC_FIELD_KINDS)[number]['value'];

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

/**
 * Разворот значений формы для подстановки в шаблон: период {from,to} превращается
 * в плоские ключи «X С» / «X По» / «X Дней» + сам «X» строкой «с … по …» (один
 * день — просто дата). Теги остаются двухчастными «Форма.Поле» — глубоких путей
 * в синтаксисе шаблонов нет намеренно.
 */
export function expandDocFormValues(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const dot = (s: string) => s.split('-').reverse().join('.');
  for (const [key, value] of Object.entries(fields)) {
    if (!isDocDateRangeValue(value)) {
      out[key] = value;
      continue;
    }
    const days = docDateRangeDays(value);
    out[`${key} С`] = value.from;
    out[`${key} По`] = value.to;
    out[`${key} Дней`] = days;
    out[key] = value.from === value.to ? dot(value.from) : `с ${dot(value.from)} по ${dot(value.to)}`;
  }
  return out;
}

/**
 * Формат номера. Плейсхолдеры русские, чтобы кадровик писал их как на бумаге:
 * «ПР-{ГГГГ}-{NNN}» → «ПР-2026-007». Сколько букв N, столько знаков в серии.
 */
export const DEFAULT_DOC_NUMBER_FORMAT = '{ГГГГ}-{NNN}';

/** Собрать номер по формату вида. Чистая функция: одна и та же и на сервере, и в превью формы. */
export function formatDocNumber(format: string | null | undefined, seq: number, at: Date): string {
  const src = format && format.trim() ? format : DEFAULT_DOC_NUMBER_FORMAT;
  const year = at.getFullYear();
  return src
    .replace(/\{ГГГГ\}/g, String(year))
    .replace(/\{ГГ\}/g, String(year).slice(-2))
    .replace(/\{ММ\}/g, String(at.getMonth() + 1).padStart(2, '0'))
    .replace(/\{(N+)\}/g, (_, ns: string) => String(seq).padStart(ns.length, '0'));
}

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
