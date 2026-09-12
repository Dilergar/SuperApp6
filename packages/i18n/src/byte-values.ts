import type { TranslationValues } from './translator';

// ============================================================
// МАШИННЫЙ ОБЪЁМ В ВЕЧНОМ PAYLOAD И В ОТКАЗЕ.
//
// «4,1 ГБ» — это ЯЗЫК (единица) и РЕГИОН (разделитель дроби) зрителя, поэтому
// строку нельзя запечь у продюсера: уведомление живёт в БД годами и читается
// разными людьми, а отказ 402 переводится в языке запроса уже в фильтре.
// Продюсер помечает число суффиксом `Bytes`:
//
//   payload/params: { usedBytes: 4_400_000_000, valueBytes: 16_106_127_360 }
//   каталог:        "{used} из {value}"
//
// Рендер подставляет отформатированное значение под именем БЕЗ суффикса. Уже
// заданное имя без суффикса (снимок старой записи) не перебивается.
// Правило и его родня — `<имя>Iso` (даты) и `<имя>Key` (ключи каталога) — в
// docs/i18n.md.
// ============================================================

const SUFFIX = 'Bytes';

/**
 * Развернуть `<имя>Bytes` в `<имя>` строкой «4,1 ГБ» словами и правилами зрителя.
 * Возвращает НОВЫЙ объект; само число остаётся в наборе под именем с суффиксом —
 * по нему видно, что в записи лежал машинный объём.
 */
export function resolveByteValues(bytes: (value: number) => string, values: TranslationValues): TranslationValues {
  let out: TranslationValues | null = null;
  for (const [name, value] of Object.entries(values)) {
    if (!name.endsWith(SUFFIX) || name.length === SUFFIX.length) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const target = name.slice(0, -SUFFIX.length);
    if (values[target] !== undefined) continue;
    out ??= { ...values };
    out[target] = bytes(value);
  }
  return out ?? values;
}
