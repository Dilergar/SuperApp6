import type { Translator, TranslationValues } from './translator';
import { resolveLabelKeys } from './label-keys';
import { resolveAudienceLabels } from './audience-label';
import { resolveIsoValues } from './iso-values';
import { createFormatters, type Formatters } from './format';
import type { Locale } from '@superapp/shared';

// ============================================================
// Рендер записи хроники в языке ЗРИТЕЛЯ (переезд renderChatterText из shared).
//
// Запись в БД вечна и хранит СТРУКТУРУ: typeKey + payload + changes. Текст
// собирается на выходе — поэтому один и тот же факт («срок 03.09 → 10.09»)
// читается по-казахски у одного человека и по-английски у другого, и старые
// записи переводятся задним числом вместе с каталогом.
//
// `changes[].label` и `changes[].from/to` остаются СНАПШОТОМ: они были
// display-строками на момент записи и работают фолбэком для типов, чьи подписи
// ещё не переехали в каталог. `changes[].raw` — сырые значения: если они есть,
// дата и число форматируются профилем региона зрителя, а не тем, что запеклось.
//
// То же и для дат ВНУТРИ фразы: продюсер кладёт `<имя>Iso`, рендер подставляет
// отформатированное значение под именем без суффикса (`resolveIsoValues`), и для
// адресатов: `<имя>Audience` — снимок структуры, подпись собирается при чтении
// (`resolveAudienceLabels`).
// ============================================================

export type ChatterRawKind = 'text' | 'date' | 'datetime' | 'number' | 'key';

export interface ChatterRaw {
  from: string | null;
  to: string | null;
  kind: ChatterRawKind;
}

export interface ChatterChangeLike {
  field: string;
  label: string;
  from: string | null;
  to: string | null;
  raw?: ChatterRaw | null;
  /** Поле под правилами видимости (core/visibility): значение замаскировано или скрыто для зрителя */
  concealed?: 'masked' | 'hidden';
}

export interface ChatterEntryLike {
  refType?: string;
  actorName?: string | null;
  changes?: ReadonlyArray<ChatterChangeLike> | null;
  payload?: Record<string, unknown> | null;
}

/** Сырое значение → строка в правилах зрителя; null → прочерк из каталога. */
function renderRaw(
  value: string | null,
  kind: ChatterRawKind,
  t: Translator,
  fmt: Formatters,
  dash: string,
): string {
  if (value === null || value === '') return dash;
  if (kind === 'date') return fmt.date(value);
  if (kind === 'datetime') return fmt.dateTime(value);
  if (kind === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? fmt.number(n) : value;
  }
  // Слово продукта: в записи лежит КЛЮЧ. Ключа нет в каталоге (переименовали,
  // сервис уехал) — показываем как есть: запись честнее пустоты.
  if (kind === 'key') return t.has(value) ? t(value) : value;
  return value;
}

/**
 * Значения «было → стало» в языке зрителя: сырое (дата, число, ключ) —
 * пересобранным, иначе снимок записи. Одна функция на СЕРВЕР (плоский `text`)
 * и на ВЕБ (чипы диффа): разойдись они, чип перестал бы находиться в тексте.
 */
export function chatterChangeDisplay(
  change: ChatterChangeLike | null | undefined,
  t: Translator,
  fmt: Formatters,
  dash: string,
): { from: string; to: string } {
  if (!change) return { from: dash, to: dash };
  // Поле под правилами видимости (core/visibility): скрытое — словом «Скрыто», маска — её символы
  const concealed = change.concealed;
  if (concealed === 'hidden') {
    const hidden = t.has('common.guarded.hidden') ? t('common.guarded.hidden') : dash;
    return { from: hidden, to: hidden };
  }
  if (concealed === 'masked') return { from: change.from ?? '•••', to: change.to ?? '•••' };
  return {
    from: change.raw ? renderRaw(change.raw.from, change.raw.kind, t, fmt, dash) : change.from ?? dash,
    to: change.raw ? renderRaw(change.raw.to, change.raw.kind, t, fmt, dash) : change.to ?? dash,
  };
}

/** Подпись изменённого поля: каталог (если тип переведён) → снапшот записи. */
export function chatterFieldLabel(
  t: Translator,
  refType: string | undefined,
  change: ChatterChangeLike,
): string {
  const key = `chatter.fields.${refType ?? ''}.${change.field}`;
  return refType && t.has(key) ? t(key) : change.label;
}

/**
 * Плоский текст записи. Значения плейсхолдеров: всё из `payload`, поверх —
 * `from`/`to` из первого изменения и снимок имени актёра (payload не должен их
 * перебивать одноимённым ключом).
 */
export function renderChatter(
  t: Translator,
  typeKey: string,
  entry: ChatterEntryLike,
  formatters?: Formatters,
): string {
  const key = `chatter.type.${typeKey}`;
  // Неизвестный тип (старая запись, тип удалён) — показываем сам ключ, а не пустоту:
  // так видно, что запись есть, и по строке можно найти её в коде.
  if (!t.has(key)) return typeKey;

  const fmt = formatters ?? createFormatters(t.locale);
  const dash = t('common.labels.dash');
  const first = entry.changes?.[0];

  const vars: Record<string, unknown> = { ...(entry.payload ?? {}) };
  const display = chatterChangeDisplay(first, t, fmt, dash);
  vars.from = display.from;
  vars.to = display.to;
  // Актор: снимок имени → слово из payload по ключу («Система», когда действие
  // совершил не человек) → общее «Кто-то». Ключ, а не слово: запись вечна.
  const actorSnapshot = entry.actorName?.trim();
  if (actorSnapshot) vars.actorName = actorSnapshot;
  else if (typeof vars.actorNameKey !== 'string') vars.actorName = t('common.labels.someone');

  // Подпись изменённого поля берётся из каталога по refType и полю — той же
  // ступенью, что у `chatterFieldLabel`. Снимок `payload.fieldLabel` кладут
  // только типы, чей словарь ещё не переехал: он сильнее и не перебивается.
  if (vars.fieldLabel === undefined && first) {
    vars.fieldLabel = chatterFieldLabel(t, entry.refType, first);
  }

  // Условная презентация — В РЕНДЕРЕ, а не в payload: филиал показываем только
  // когда он есть, и формат можно менять без миграции вечных записей.
  if (vars.branchClause === undefined) {
    const branchName = entry.payload?.branchName;
    vars.branchClause =
      typeof branchName === 'string' && branchName ? ` · ${t('chatter.branchClause', { name: branchName })}` : '';
  }

  // Адресат («Отдел «Продажи»», «Руководитель инициатора») лежит в записи СНИМКОМ
  // структуры и собирается словом здесь, в языке зрителя. Разворот идёт ПЕРВЫМ —
  // до отбрасывания объектов ниже: снимок и есть объект.
  const withAudiences = resolveAudienceLabels(t, vars);

  // ICU принимает только примитивы: объект/массив в payload → пустая строка
  // (в UI не должно появиться «[object Object]»).
  const values: TranslationValues = {};
  for (const [k, v] of Object.entries(withAudiences)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') continue;
    values[k] = v as string | number | boolean;
  }
  // Порядок: сначала машинные даты (`<имя>Iso` → «1 сентября 2026»), потом ключи
  // каталога — подпись может опираться на уже развёрнутую дату, но не наоборот.
  return t(key, resolveLabelKeys(t, resolveIsoValues(fmt, values)));
}
