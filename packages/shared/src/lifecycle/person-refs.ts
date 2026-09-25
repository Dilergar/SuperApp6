// ============================================================
// Снимки имён людей внутри JSON (payload хроники и уведомлений, изменения хроники)
// ============================================================
// Имя человека в JSON чужой записи («снят с должности: Иванов», «Иванов принял приглашение»)
// переживает его аккаунт, если стирание не знает, чьё оно. Правило: имя лежит ТОЛЬКО парой с
// id того, чьё оно, — стирание переписывает имя меткой «удалённый пользователь» по id (и гасит
// собранный из него снимок текста). Поиск строк по id — GIN-индексом на SQL-функции
// «id людей строки» (`chatter_person_ids` / `notification_person_ids`, миграция
// `20260927000000_person_refs`); список ключей функции и этих констант сверяет смоук бута.

/** Поле имени в payload → поле id того же человека рядом. */
export const PERSON_NAME_REFS = {
  targetName: 'targetUserId',
  otherName: 'otherUserId',
  fromName: 'fromUserId',
  byName: 'byUserId',
  ownerName: 'ownerUserId',
  deputyLabel: 'deputyUserId',
} as const;
export type PersonNameField = keyof typeof PERSON_NAME_REFS;
export type PersonIdField = (typeof PERSON_NAME_REFS)[PersonNameField];

/** Ключи id людей в payload хроники (`chatter_person_ids`). */
export const CHATTER_PERSON_ID_KEYS = ['targetUserId', 'deputyUserId'] as const satisfies readonly PersonIdField[];
/** Ключи id людей в payload уведомлений (`notification_person_ids`). */
export const NOTIFICATION_PERSON_ID_KEYS = ['targetUserId', 'otherUserId', 'fromUserId', 'byUserId', 'ownerUserId'] as const satisfies readonly PersonIdField[];
/** Изменение хроники, чьё значение — человек: id рядом со снимком `from` / `to`. */
export const CHANGE_PERSON_ID_KEYS = ['fromUserId', 'toUserId'] as const;

/**
 * `targetName` — имя ЦЕЛИ записи: человека (тогда рядом `targetUserId`) или объекта (файл,
 * папка Диска и Заметок — без id). Проверке пары не подлежит: имя человека-цели обязан
 * сопровождать `targetUserId` сам писатель.
 */
const AMBIGUOUS_NAME_FIELDS: ReadonlySet<string> = new Set(['targetName']);

/**
 * Нарушения правила в payload: имя человека без id рядом или пара, которой нет у движка (её
 * строки индекс движка не найдёт — стирание пропустило бы имя). Пусто — порядок.
 */
export function personRefProblems(payload: Record<string, unknown> | null | undefined, allowedIdKeys: readonly string[]): string[] {
  if (!payload) return [];
  const out: string[] = [];
  for (const [nameKey, idKey] of Object.entries(PERSON_NAME_REFS)) {
    if (!(nameKey in payload) || payload[nameKey] === null || payload[nameKey] === undefined) continue;
    const hasId = typeof payload[idKey] === 'string' && !!payload[idKey];
    if (AMBIGUOUS_NAME_FIELDS.has(nameKey) && !hasId) continue;
    if (!allowedIdKeys.includes(idKey)) out.push(`${nameKey}: the pair ${idKey} is not indexed by this engine`);
    else if (!hasId) out.push(`${nameKey} without ${idKey}`);
  }
  return out;
}

/**
 * Переписать имена человека внутри JSON строки меткой (стирание): пары payload (имя рядом с
 * его id) и значения «было → стало» изменений хроники (`from` / `to` рядом с `fromUserId` /
 * `toUserId`, вместе с сырыми `raw.from` / `raw.to`). Id остаётся — зритель рисует по нему
 * томбстоун. Имя ключом каталога («кто-то») — слово продукта, не трогается.
 */
export function redactPersonRefs(payload: unknown, changes: unknown, userId: string, label: string): { payload: unknown; changes: unknown; changed: boolean } {
  let changed = false;
  let nextPayload = payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = { ...(payload as Record<string, unknown>) };
    for (const [nameKey, idKey] of Object.entries(PERSON_NAME_REFS)) {
      if (p[idKey] !== userId || !(nameKey in p) || p[nameKey] === null || p[nameKey] === label) continue;
      p[nameKey] = label;
      changed = true;
    }
    nextPayload = p;
  }
  let nextChanges = changes;
  if (Array.isArray(changes)) {
    nextChanges = changes.map((c: unknown) => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return c;
      const item = { ...(c as Record<string, unknown>) };
      const raw = item.raw && typeof item.raw === 'object' && !Array.isArray(item.raw) ? { ...(item.raw as Record<string, unknown>) } : null;
      for (const [side, idKey] of [['from', 'fromUserId'], ['to', 'toUserId']] as const) {
        if (item[idKey] !== userId) continue;
        if (item[side] !== null && item[side] !== label) {
          item[side] = label;
          changed = true;
        }
        if (raw && raw[side] !== null && raw[side] !== undefined && raw[side] !== label) {
          raw[side] = label;
          changed = true;
        }
      }
      if (raw) item.raw = raw;
      return item;
    });
  }
  return { payload: nextPayload, changes: nextChanges, changed };
}
