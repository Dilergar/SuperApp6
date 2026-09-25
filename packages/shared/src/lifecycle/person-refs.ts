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
 * Системная плашка чата (`messages.payload` системного сообщения): структура записи
 * `chatter = { actorName, actorId, payload, changes }` (группы, задачи, сервисы, таймер) или
 * событие уведомления `notification = { type, payload }`, плюс снимок `text` в языке-источнике.
 * Имя актора лежит парой `actorName` ↔ `actorId`, прочие имена — парами `PERSON_NAME_REFS`.
 * Ключи функции `message_person_ids(payload)` (частичный GIN-индекс по системным сообщениям).
 */
export const PLAQUE_ACTOR_ID_KEY = 'actorId';
export const MESSAGE_PERSON_ID_KEYS = [
  PLAQUE_ACTOR_ID_KEY,
  ...new Set<string>([...CHATTER_PERSON_ID_KEYS, ...CHANGE_PERSON_ID_KEYS, ...NOTIFICATION_PERSON_ID_KEYS]),
] as readonly string[];

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

/**
 * Нарушения правила в плашке: имя актора без `actorId` (кроме пустого — «кто-то» — и метки
 * удалённого, которые не имена), имена в payload без пары. Пусто — порядок.
 */
export function plaquePersonProblems(chatter: { actorName?: unknown; actorId?: unknown; payload?: unknown } | null | undefined, deletedLabel: string): string[] {
  if (!chatter) return [];
  const out: string[] = [];
  const name = typeof chatter.actorName === 'string' ? chatter.actorName.trim() : '';
  if (name && name !== deletedLabel && !(typeof chatter.actorId === 'string' && chatter.actorId)) out.push('actorName without actorId');
  out.push(...personRefProblems(asObj(chatter.payload), CHATTER_PERSON_ID_KEYS));
  return out;
}

/**
 * Переписать имена человека в payload системной плашки меткой (стирание): актор структуры,
 * пары в её payload и изменениях, пары в payload события уведомления. Снимок `text` пересобирает
 * вызывающий (ему нужен каталог) — по флагу `changed`. Id остаются: зритель рисует томбстоун.
 */
export function redactPlaquePersonRefs(payload: unknown, userId: string, label: string): { payload: unknown; changed: boolean } {
  const p = asObj(payload);
  if (!p) return { payload, changed: false };
  const next: Json = { ...p };
  let changed = false;
  const chatter = asObj(p.chatter);
  if (chatter) {
    const c: Json = { ...chatter };
    if (c[PLAQUE_ACTOR_ID_KEY] === userId && typeof c.actorName === 'string' && c.actorName !== label) {
      c.actorName = label;
      changed = true;
    }
    const inner = redactPersonRefs(c.payload ?? null, c.changes ?? null, userId, label);
    if (inner.changed) {
      if (c.payload !== undefined) c.payload = inner.payload;
      if (c.changes !== undefined) c.changes = inner.changes;
      changed = true;
    }
    // Имя актора продублировано в значениях шаблона (`payload.actorName` групповых плашек)
    const values = asObj(c.payload);
    if (values && c[PLAQUE_ACTOR_ID_KEY] === userId && typeof values.actorName === 'string' && values.actorName !== label) {
      c.payload = { ...values, actorName: label };
      changed = true;
    }
    next.chatter = c;
  }
  const notification = asObj(p.notification);
  if (notification) {
    const inner = redactPersonRefs(notification.payload ?? null, null, userId, label);
    if (inner.changed) {
      next.notification = { ...notification, payload: inner.payload };
      changed = true;
    }
  }
  return { payload: changed ? next : payload, changed };
}

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

/**
 * Копия JSON без id людей (ключи `MESSAGE_PERSON_ID_KEYS` на любой глубине): чужая системная
 * плашка в архиве человека несёт имена, но не идентификаторы других людей.
 */
export function withoutPersonIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPersonIds);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if ((MESSAGE_PERSON_ID_KEYS as readonly string[]).includes(k)) continue;
    out[k] = withoutPersonIds(v);
  }
  return out;
}
