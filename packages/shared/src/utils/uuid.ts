// UUIDv7 (RFC 9562 §5.7) и правила обращения с идентификаторами платформы.
//
// Правило (docs/api_conventions.md): id НЕПРОЗРАЧЕН — не парсится, не несёт шард, не является
// секретом. Id генерирует БАЗА (`DEFAULT uuidv7()`); приложение зовёт `uuidv7()` только когда
// id нужен ДО вставки (ключ объекта в хранилище, ссылка в той же транзакции). У v7 первые
// 48 бит — миллисекунды Unix: голова id одинакова для всего, что создано рядом по времени,
// поэтому для шардирования путей и коротких подписей берётся ХВОСТ (`opaqueIdTail`) — случайная
// часть. Публичные id записей, чувствительных ко времени создания (инциденты ПДн, тревоги,
// заявки на стирание, заморозки), — v4 (`crypto.randomUUID()`): v7 раскрывает момент (RFC 9562 §8).

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

let lastMs = -1;
let seq = 0;

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * Новый UUIDv7: 48 бит времени, версия 7, 12 бит счётчика внутри миллисекунды (монотонность в
 * процессе: два id одной миллисекунды упорядочены), вариант RFC, 62 случайных бита.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  let ms = Math.floor(nowMs);
  if (ms <= lastMs) {
    seq = (seq + 1) & 0xfff;
    // Счётчик миллисекунды исчерпан (4096 id) — «занимаем» следующую миллисекунду, порядок сохраняется
    if (seq === 0) lastMs += 1;
    ms = lastMs;
  } else {
    lastMs = ms;
    seq = randomBytes(2).reduce((a, b) => (a << 8) | b, 0) & 0x7ff; // старт с половины диапазона — место для роста
  }
  const b = randomBytes(16);
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = (ms >>> 24) & 0xff;
  b[3] = (ms >>> 16) & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = 0x70 | ((seq >>> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = Array.from(b, (x) => HEX[x]!).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Версия UUID (4, 7, …) или null, если строка не UUID. */
export function uuidVersion(id: string): number | null {
  const m = UUID_RE.exec(id);
  return m ? parseInt(m[1]!, 16) : null;
}

/**
 * Момент создания из UUIDv7 — ТОЛЬКО как подсказка планировщику (поиск строки по id в
 * партиционированной таблице: `lookupByIdWithTimeHint`). Для v4 и чужих строк — null.
 */
export function uuidv7Time(id: string): Date | null {
  if (uuidVersion(id) !== 7) return null;
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(parseInt(hex, 16));
}

/**
 * Хвост id — последние `n` шестнадцатеричных знаков (случайная часть и у v4, и у v7). Для
 * шардирования путей хранилища и коротких различителей в подписях; голову v7 (время) брать нельзя.
 */
export function opaqueIdTail(id: string, n = 4): string {
  const hex = id.replace(/-/g, '');
  return hex.slice(Math.max(0, hex.length - n));
}

// ---------------------------------------------------------------- типизированные id

declare const ID_BRAND: unique symbol;
/**
 * Id сущности с видом на уровне типов (Atlassian 2022: скрипт удаления принял id сайта за
 * id приложения — 883 сайта, две недели восстановления). Разрушающие пути (каскад
 * организации, стирание человека) принимают ТОЛЬКО типизированный id: перепутать
 * организацию с человеком не даёт компилятор, вид по БД проверяет сам путь.
 */
export type EntityId<K extends string> = string & { readonly [ID_BRAND]: K };
export type WorkspaceId = EntityId<'workspace'>;
export type UserId = EntityId<'user'>;

/** Строка → id организации (только формат; существование и вид проверяет разрушающий путь по БД). */
export function asWorkspaceId(id: string): WorkspaceId {
  if (!isUuid(id)) throw new Error('asWorkspaceId: not a uuid');
  return id as WorkspaceId;
}

/** Строка → id человека (только формат). */
export function asUserId(id: string): UserId {
  if (!isUuid(id)) throw new Error('asUserId: not a uuid');
  return id as UserId;
}
