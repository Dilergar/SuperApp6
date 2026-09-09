import type { TranslationValues } from './translator';
import type { Formatters } from './format';

// ============================================================
// МАШИННАЯ ДАТА В ВЕЧНОМ PAYLOAD.
//
// Уведомление и запись хроники живут в БД годами и хранят СТРУКТУРУ, а текст
// собирается при чтении. Но payload несёт примитивы: дата уезжает в него строкой
// (`'2026-09-01'`), а ICU умеет форматировать только `Date`/число — и человек
// видел машинное «2026-09» там, где ждал «сентябрь 2026».
//
// Формат нельзя запечь у продюсера: правила принадлежат РЕГИОНУ ЗРИТЕЛЯ, а
// имена месяцев — его ЯЗЫКУ. Поэтому продюсер помечает значение суффиксом `Iso`:
//
//   payload: { startsOnIso: '2026-09-01' }
//   каталог: "…назначил на «{positionName}» с {startsOn}"
//
// Рендер подставляет отформатированное значение под именем БЕЗ суффикса. Вид
// формата выводится из САМОГО значения (оно машинное, поэтому вывод точен):
// `YYYY-MM` → месяц с годом, `YYYY-MM-DD` → дата, полный ISO с `T` → дата и время.
// Уже заданное имя без суффикса (снимок старой записи) не перебивается — старые
// строки читаются как есть.
// ============================================================

const SUFFIX = 'Iso';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Машинная строка → строка в правилах и словах зрителя; чужая форма — как есть. */
function formatIso(value: string, fmt: Formatters): string {
  if (MONTH_RE.test(value)) return fmt.date(`${value}-01`, 'monthYear');
  if (DAY_RE.test(value)) return fmt.date(value, 'long');
  if (DATE_TIME_RE.test(value)) return fmt.dateTime(value);
  return value;
}

/**
 * Развернуть `<имя>Iso` в `<имя>` форматтерами зрителя. Возвращает НОВЫЙ объект;
 * уже заданное `<имя>` не перебивается. Значение остаётся в наборе и под своим
 * именем с суффиксом — по нему видно, что в записи лежала машинная дата.
 */
export function resolveIsoValues(fmt: Formatters, values: TranslationValues): TranslationValues {
  let out: TranslationValues | null = null;
  for (const [name, value] of Object.entries(values)) {
    if (!name.endsWith(SUFFIX) || name.length === SUFFIX.length) continue;
    if (typeof value !== 'string' || value === '') continue;
    const target = name.slice(0, -SUFFIX.length);
    if (values[target] !== undefined) continue;
    out ??= { ...values };
    out[target] = formatIso(value, fmt);
  }
  return out ?? values;
}
