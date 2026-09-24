// Непрозрачный курсор keyset-пагинации — один кодек на все списки платформы (API и клиенты).
//
// Правило (docs/api_conventions.md): курсор = значения ключа сортировки последней отданной
// строки + её id как разрыв ничьих (`(sortAt, id)`). Клиент курсор не разбирает. Декодер
// ПРОВЕРЯЕТ каждое поле по схеме (дата, uuid, число, строка, флаг): мусорный или подделанный
// курсор = начало списка, а не 500 и не строка «не того вида» в сыром SQL.

import { isUuid } from './uuid';

export type CursorFieldKind = 'date' | 'uuid' | 'string' | 'number' | 'boolean';
/** Схема полей курсора; `'<вид>?'` — поле может быть null. */
export type CursorSpec = Readonly<Record<string, CursorFieldKind | `${CursorFieldKind}?`>>;

type KindValue<K extends string> = K extends 'date'
  ? Date
  : K extends 'number'
    ? number
    : K extends 'boolean'
      ? boolean
      : string;

export type DecodedCursor<S extends CursorSpec> = {
  [F in keyof S]: S[F] extends `${infer K}?` ? KindValue<K> | null : KindValue<S[F] & string>;
};

/** Значение поля при кодировании: дата уходит ISO-строкой. */
export type CursorValue = Date | string | number | boolean | null;

const MAX_CURSOR_LENGTH = 2048;
const MAX_STRING_FIELD = 512;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(raw: string): string | null {
  if (!raw || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Закодировать курсор. Порядок полей не важен; даты — ISO-строкой. */
export function encodeCursor(values: Readonly<Record<string, CursorValue>>): string {
  const plain: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(values)) plain[k] = v instanceof Date ? v.toISOString() : v;
  return toBase64Url(JSON.stringify(plain));
}

/** Разобрать курсор по схеме; любое несоответствие (формат, вид поля, лишнее/нет поля) — null. */
export function decodeCursor<S extends CursorSpec>(raw: string | null | undefined, spec: S): DecodedCursor<S> | null {
  if (!raw) return null;
  const text = fromBase64Url(raw);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).some((k) => !(k in spec))) return null;
  const out: Record<string, unknown> = {};
  for (const [field, rawKind] of Object.entries(spec)) {
    const optional = rawKind.endsWith('?');
    const kind = (optional ? rawKind.slice(0, -1) : rawKind) as CursorFieldKind;
    const v = obj[field];
    if (v === null || v === undefined) {
      if (!optional) return null;
      out[field] = null;
      continue;
    }
    switch (kind) {
      case 'date': {
        if (typeof v !== 'string' || v.length > 40) return null;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return null;
        out[field] = d;
        break;
      }
      case 'uuid':
        if (!isUuid(v)) return null;
        out[field] = v.toLowerCase();
        break;
      case 'string':
        if (typeof v !== 'string' || v.length > MAX_STRING_FIELD) return null;
        out[field] = v;
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        out[field] = v;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return null;
        out[field] = v;
        break;
      default:
        return null;
    }
  }
  return out as DecodedCursor<S>;
}
