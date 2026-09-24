#!/usr/bin/env node
/**
 * Разметка schema.prisma под нативный uuid (архитектура данных, миграция ids_native_uuid_v7).
 *
 * Что переводится в `@db.Uuid` (16 байт вместо 36-символьного TEXT — вдвое меньше индексы ключей и FK):
 *   - PK `String @id @default(uuid())` → `@default(dbgenerated("uuidv7()"))` (генерирует БАЗА: сырые
 *     INSERT тоже получают v7, часы одни). Исключение — публичные id записей, чувствительных по
 *     времени создания (RFC 9562 §8: v7 раскрывает момент): `gen_random_uuid()` (v4);
 *   - FK-колонки на такие PK;
 *   - колонки-ссылки `*Id` / `*Ids` на сущности платформы, если ВСЕ значения базы — UUID
 *     (`--data idcheck.json`), кроме полиморфных и внешних идентификаторов (KEEP_TEXT).
 * Остаются text: полиморфные ссылки (`refId`, `targetId`, `subjectId`, `resourceId`), внешние id
 * (Google, S3 multipart, LiveKit egress, провайдеры SMS), значения-сентинелы ('platform', 'system').
 *
 * Запуск: node scripts/gen-uuid-schema.cjs --data <idcheck.json> [--write]
 * Идемпотентен: уже размеченные поля не трогает.
 */
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = path.join(__dirname, '..', 'prisma', 'schema.prisma');
const args = process.argv.slice(2);
const dataFile = args[args.indexOf('--data') + 1];
const WRITE = args.includes('--write');

/** Публичные id, по которым нельзя узнать момент создания (инциденты ПДн, тревоги безопасности). */
const V4_PK = new Set(['PdIncident', 'SecurityAlert']);
/** Полиморфные и внешние идентификаторы — text навсегда (значение может быть не UUID). */
const KEEP_TEXT = /^(refId|targetId|resourceId|subjectId|egressId|nodeId|eventId|externalId|providerMessageId|googleEventId|googleCalendarId|syncCalendarId|tasksCalendarId|channelId|channelResourceId|uploadId|procedureId|livekitRoomSid|roomSid|sid|requestId|idempotencyKey|messageId|deviceId|sessionId|installationId|sourceId|objectId|entityId|keyId|kid|runAsUserId|assigneeId|audienceId|anonymousId)$/;

const schema = fs.readFileSync(SCHEMA, 'utf8');
const data = dataFile ? new Map(JSON.parse(fs.readFileSync(dataFile, 'utf8')).map((o) => [o.col, o])) : new Map();

// Модели: имя → таблица, поля
const models = new Map();
for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
  const table = (m[2].match(/@@map\("([^"]+)"\)/) || [])[1] || m[1];
  models.set(m[1], { table, body: m[2] });
}
const pkUuid = new Set();
// PK с uuid: и ещё не размеченный `uuid()`, и уже переведённый `uuidv7()` / `gen_random_uuid()` (идемпотентность)
for (const [name, m] of models) {
  if (/^\s+id\s+String\s+@id\s+@default\((uuid\(\)|dbgenerated\("(uuidv7|gen_random_uuid)\(\)"\))\)/m.test(m.body)) pkUuid.add(name);
}
// FK на PK с uuid(): модель.поле
const fk = new Set();
for (const [name, m] of models) {
  for (const line of m.body.split('\n')) {
    const f = line.trim().match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s+.*@relation\(([^)]*)\)/);
    if (!f || !/fields:/.test(f[5])) continue;
    const refs = f[5].match(/references:\s*\[([^\]]+)\]/)[1].split(',').map((s) => s.trim());
    const flds = f[5].match(/fields:\s*\[([^\]]+)\]/)[1].split(',').map((s) => s.trim());
    if (pkUuid.has(f[2]) && refs.length === 1 && refs[0] === 'id') for (const x of flds) fk.add(`${name}.${x}`);
  }
}

let changed = 0;
const decisions = [];
const out = schema.replace(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm, (whole, name, body) => {
  const m = models.get(name);
  const lines = body.split('\n').map((line) => {
    const f = line.match(/^(\s+)(\w+)(\s+)String(\[\])?(\?)?(.*)$/);
    if (!f) return line;
    const [, indent, field, sp, list, opt, rest] = f;
    if (/@db\.Uuid\b/.test(rest)) return line;
    const db = (rest.match(/@map\("([^"]+)"\)/) || [])[1] || field;
    const col = `${m.table}.${db}`;
    const isPk = /@id\b/.test(rest) && pkUuid.has(name) && field === 'id';
    const isFk = fk.has(`${name}.${field}`);
    const idLike = field === 'id' || /Id$/.test(field) || /Ids$/.test(field);
    // FK переводится независимо от имени (`invitedBy`): обе стороны ключа обязаны совпасть типом
    if (!idLike && !isFk) return line;
    const d = data.get(col);
    const clean = d ? d.bad === 0 : false;
    let convert = false;
    if (d && d.bad > 0) convert = false;
    else if (isPk || isFk) convert = true;
    else if (KEEP_TEXT.test(field)) convert = false;
    else if (/@id\b/.test(rest)) convert = clean || isFk;
    else convert = clean;
    if (!convert) return line;
    let newRest = rest;
    if (isPk) newRest = newRest.replace('@default(uuid())', V4_PK.has(name) ? '@default(dbgenerated("gen_random_uuid()"))' : '@default(dbgenerated("uuidv7()"))');
    // @db.Uuid — сразу после типа (перед остальными атрибутами)
    const typed = `${indent}${field}${sp}String${list ?? ''}${opt ?? ''} @db.Uuid ${newRest.trim()}`;
    changed++;
    decisions.push(col);
    return typed.replace(/\s+$/, '');
  });
  return `model ${name} {${lines.join('\n')}}`;
});

console.log(`fields to @db.Uuid: ${changed}`);
if (WRITE && changed) {
  fs.writeFileSync(SCHEMA, out);
  console.log('schema.prisma updated');
} else if (!WRITE) {
  console.log(decisions.slice(0, 20).join('\n'), decisions.length > 20 ? '\n…' : '');
}
