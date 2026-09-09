// ============================================================
// DSL ШАБЛОНОВ ДОКУМЕНТА — синтаксис, а не интерфейс.
//
// Здесь живут ИМЕНА, которые человек пишет ВНУТРИ бланка («{Document.Number}»,
// «{Form.Vacation Days}») и в формате номера («ORD-{YYYY}-{NNN}»). Это тот же
// DSL, что у форматтеров `core/templates/template-formatters.ts` и у блочного
// рендера `builder-render.driver.ts`.
//
// Имена тегов — АНГЛИЙСКИЕ идентификаторы (модель Salesforce: API-имя одно на
// все языки, а подпись в панели «Что подставить» даёт каталог). Язык самого
// бланка на них не влияет: русский приказ и казахский приказ подставляют одно
// и то же `{Employee.FullName}`.
//
// Слов здесь нет вовсе: печатную фразу периода собирает ВЫЗЫВАЮЩИЙ (у него
// есть язык бланка), а объяснение к плейсхолдерам номера — каталог
// (`documents.numberToken.*`).
// ============================================================

import { isDocDateRangeValue, docDateRangeDays } from './org-documents';

/**
 * Суффиксы тега у поля-периода: «Vacation From», «Vacation To», «Vacation Days».
 * Теги остаются двухчастными («Group.Field») — глубоких путей в синтаксисе
 * шаблонов нет намеренно, а ключ самого поля формы пишет человек на своём языке.
 */
const RANGE_SUFFIXES = ['From', 'To', 'Days'] as const;

/** Все имена тегов, которые даёт поле-период: сам ключ + три производных. */
export function docRangeTagKeys(key: string): string[] {
  return [key, ...RANGE_SUFFIXES.map((s) => `${key} ${s}`)];
}

/**
 * Разворот значений формы для подстановки в шаблон: период {from,to} превращается
 * в плоские ключи «X From» / «X To» / «X Days» + сам «X» печатной строкой периода.
 *
 * Строку периода собирает ВЫЗЫВАЮЩИЙ (`renderRange`): в ней есть и слова, и
 * формат даты, то есть язык бланка, — а у общего пакета каталога нет и быть не
 * может. Один день — просто дата (та же функция, from === to).
 */
export function expandDocFormValues(
  fields: Record<string, unknown>,
  renderRange: (from: string, to: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!isDocDateRangeValue(value)) {
      out[key] = value;
      continue;
    }
    const [self, from, to, days] = docRangeTagKeys(key);
    out[from] = value.from;
    out[to] = value.to;
    out[days] = docDateRangeDays(value);
    out[self] = renderRange(value.from, value.to);
  }
  return out;
}

/** Группа тегов «Document» — реквизиты самой бумаги (владелец группы — сервис документов). */
export function documentTagBag(doc: { title: string; number: string | null; date: Date }): Record<string, unknown> {
  return {
    Document: {
      Title: doc.title,
      Number: doc.number ?? '',
      Date: doc.date,
    },
  };
}

/**
 * Формат номера. Плейсхолдеры машинные (`{YYYY}`), а не буквы языка: номер
 * документа читают и люди, и госсистемы, и один и тот же вид может печататься
 * на трёх языках — «ПР-{ГГГГ}» пришлось бы заводить трижды.
 * «ORD-{YYYY}-{NNN}» → «ORD-2026-007»; сколько букв N, столько знаков в серии.
 */
export const DEFAULT_DOC_NUMBER_FORMAT = '{YYYY}-{NNN}';

/**
 * Плейсхолдеры формата — ДАННЫЕ для подсказки в форме вида: сам тег пишется как
 * есть (он часть DSL), а объяснение к нему берётся из каталога по `descKey`.
 */
export const DOC_NUMBER_TOKENS = [
  { token: '{YYYY}', descKey: 'year' },
  { token: '{YY}', descKey: 'year2' },
  { token: '{MM}', descKey: 'month' },
  { token: '{NNN}', descKey: 'seq' },
] as const;

/** Собрать номер по формату вида. Чистая функция: одна и та же и на сервере, и в превью формы. */
export function formatDocNumber(format: string | null | undefined, seq: number, at: Date): string {
  const src = format && format.trim() ? format : DEFAULT_DOC_NUMBER_FORMAT;
  const year = at.getFullYear();
  return src
    .replace(/\{YYYY\}/g, String(year))
    .replace(/\{YY\}/g, String(year).slice(-2))
    .replace(/\{MM\}/g, String(at.getMonth() + 1).padStart(2, '0'))
    .replace(/\{(N+)\}/g, (_, ns: string) => String(seq).padStart(ns.length, '0'));
}

/** Группа тегов формы подачи: «Form.Days» — то, что заполняет подающий */
export const DOC_FORM_TAG_PREFIX = 'Form';

/**
 * Имена форматов чипа — тот же DSL, что у `core/templates/template-formatters.ts`
 * («{Contract.Salary|words}»). `key` — имя ветки каталога для подписи и примера.
 */
export const DOC_CHIP_FORMATS = [
  { value: '', key: 'asIs' },
  { value: 'date', key: 'date' },
  { value: 'date:long', key: 'dateLong' },
  { value: 'words', key: 'money' },
  { value: 'number', key: 'number' },
] as const;

/** Формат по умолчанию у чипа-даты */
export const DOC_CHIP_FORMAT_DATE = 'date';
