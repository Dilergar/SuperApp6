/* eslint-disable */
// Звонки в чатах (refType='chat' на движке core/calls) — e2e БЕЗ живого LiveKit:
// токен минтится локально, deleteRoom best-effort, вебхуки подписываем сами (как сервер).
// Матрица canJoin (DM / не-участник / блок / группа / офис-чат), canModerate (DM оба,
// группа owner/admin), activeCall в DTO, GET /messenger/calls/active, итоговые плашки
// «Звонок · N» / «Пропущенный звонок» + уведомление call.missed (шина → поллинг).
// Run: node scripts/verify-messenger-calls.cjs  (API на 3001, сидированные tester1-3)
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const crypto = require('crypto');
const BASE = process.env.API_URL || 'http://localhost:3001/api';
const CREDS = {
  t1: { phone: '+77001234567', password: 'Test1234!' },
  t2: { phone: '+77012345678', password: 'Test1234!' },
  t3: { phone: '+77023456789', password: 'Test1234!' },
};

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? `  (${extra})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, p, { token, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
async function login(creds) {
  const { status, json } = await http('POST', '/auth/login', { body: creds });
  if (status !== 200 && status !== 201) throw new Error(`login failed ${status}`);
  const token = json.data.accessToken;
  const me = await http('GET', '/users/me', { token });
  return { token, id: me.json.data.id };
}

function withPrisma(fn) {
  let PrismaClient;
  try { ({ PrismaClient } = require('@prisma/client')); }
  catch { console.log('  (prisma helper skipped)'); return Promise.resolve(false); }
  const prisma = new PrismaClient();
  return Promise.resolve(fn(prisma)).finally(() => prisma.$disconnect());
}

// Вебхук «от LiveKit»: тело подписываем локальным AccessToken (sha256 в claims)
let signerCache = null;
async function signedWebhook(payload) {
  const body = JSON.stringify(payload);
  const { AccessToken } = require('livekit-server-sdk');
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { ttl: 600 });
  at.sha256 = crypto.createHash('sha256').update(body).digest('base64');
  const jwt = await at.toJwt();
  const res = await fetch(`${BASE}/calls/livekit/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/webhook+json', Authorization: jwt },
    body,
  });
  return res.status;
}
const joinWebhook = (roomName, userId) =>
  signedWebhook({ event: 'participant_joined', id: `evt_${crypto.randomUUID()}`, room: { name: roomName }, participant: { identity: userId } });
const leaveWebhook = (roomName, userId) =>
  signedWebhook({ event: 'participant_left', id: `evt_${crypto.randomUUID()}`, room: { name: roomName }, participant: { identity: userId } });
const finishWebhook = (roomName) =>
  signedWebhook({ event: 'room_finished', id: `evt_${crypto.randomUUID()}`, room: { name: roomName } });

// Плашки летят через шину (Redis Streams) — поллим появление до таймаута
async function waitFor(fn, ms = 6000, step = 300) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}
async function lastSystemEvent(token, chatId) {
  const { json } = await http('GET', `/messenger/chats/${chatId}/messages`, { token });
  const items = json?.data?.items ?? json?.data ?? [];
  const sys = items.filter((m) => m.type === 'system');
  return sys.length ? sys[sys.length - 1]?.payload?.eventType : null;
}

async function main() {
  console.log('== verify-messenger-calls ==');
  const t1 = await login(CREDS.t1), t2 = await login(CREDS.t2), t3 = await login(CREDS.t3);

  const status = await http('GET', '/calls/status', { token: t1.token });
  check('GET /calls/status отвечает (+recordingEnabled поле)', status.status === 200 && typeof status.json?.data?.recordingEnabled === 'boolean');
  if (!status.json?.data?.enabled) {
    console.log('\nLIVEKIT_* не заданы — остальные проверки SKIP.');
    process.exit(failed === 0 ? 0 : 1);
  }

  // ---------- Подготовка: контакты t1-t2, DM, чистка хвостов прошлых прогонов ----------
  await withPrisma(async (p) => {
    await p.callSession.updateMany({ where: { refType: 'chat', status: 'active' }, data: { status: 'ended', endedAt: new Date() } });
    // Контакт t1↔t2 напрямую (инвайт-флоу имеет кулдауны; канонический порядок userA<userB)
    const [a, b] = [t1.id, t2.id].sort();
    await p.contactLink.upsert({
      where: { userAId_userBId: { userAId: a, userBId: b } },
      update: {},
      create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: t1.id },
    });
  });

  const dm = await http('POST', '/messenger/chats/dm', { token: t1.token, body: { userId: t2.id } });
  check('DM t1-t2 открыт', dm.status === 200 || dm.status === 201, `status ${dm.status}`);
  const dmId = dm.json.data.id;
  // DM виден в инбоксе только с сообщением — нужен для проверки activeCall в listChats
  await http('POST', `/messenger/chats/${dmId}/messages`, { token: t1.token, body: { content: 'проверка звонков' } });

  // ---------- 1. canJoin: DM участник / не-участник ----------
  const tok1 = await http('POST', '/calls/token', { token: t1.token, body: { refType: 'chat', refId: dmId } });
  check('t1 (участник DM) получает токен', tok1.status === 201 || tok1.status === 200, `status ${tok1.status} ${JSON.stringify(tok1.json)}`);
  const sessionId = tok1.json?.data?.sessionId;
  const roomName = tok1.json?.data?.roomName;
  check('DM: участник — модератор (трубка = конец для обоих)', tok1.json?.data?.moderator === true);

  const tok2 = await http('POST', '/calls/token', { token: t2.token, body: { refType: 'chat', refId: dmId } });
  check('t2 входит в ТУ ЖЕ сессию (get-or-create)', tok2.json?.data?.sessionId === sessionId);

  const tok3 = await http('POST', '/calls/token', { token: t3.token, body: { refType: 'chat', refId: dmId } });
  check('t3 (не участник чата) → 403', tok3.status === 403, `status ${tok3.status}`);

  // ---------- 2. activeCall в DTO + watcher-эндпоинт ----------
  const list1 = await http('GET', '/messenger/chats', { token: t1.token });
  const dmRow = (list1.json?.data ?? []).find((c) => c.id === dmId);
  check('listChats: activeCall.sessionId у DM', dmRow?.activeCall?.sessionId === sessionId, JSON.stringify(dmRow?.activeCall));
  const watcher2 = await http('GET', '/messenger/calls/active', { token: t2.token });
  const wItem = (watcher2.json?.data?.items ?? []).find((i) => i.chatId === dmId);
  check('GET /messenger/calls/active у t2 видит звонок + имя звонящего', !!wItem && typeof wItem.startedByName === 'string', JSON.stringify(wItem));
  const watcher3 = await http('GET', '/messenger/calls/active', { token: t3.token });
  check('watcher t3 (чужой) звонок НЕ видит', !(watcher3.json?.data?.items ?? []).some((i) => i.chatId === dmId));

  // ---------- 3. participant-вебхуки → participantUserIds ----------
  check('вебхук participant_joined(t1) → 200', (await joinWebhook(roomName, t1.id)) === 200);
  const withJoined = await waitFor(async () => {
    const d = await http('GET', `/messenger/chats/${dmId}`, { token: t1.token });
    const ids = d.json?.data?.activeCall?.participantUserIds ?? [];
    return ids.includes(t1.id) ? ids : null;
  });
  check('getChatDetail: participantUserIds содержит t1 (ринг-условие)', !!withJoined);

  // ---------- 4. «Пропущенный»: t2 отклоняет (endSession, DM-модератор), сам не подключался ----------
  const decline = await http('POST', `/calls/rooms/${sessionId}/end`, { token: t2.token });
  check('t2 (DM-модератор) завершает звонок «Отклонить»', decline.status === 201 || decline.status === 200, `status ${decline.status}`);
  const missedEvt = await waitFor(async () => (await lastSystemEvent(t1.token, dmId)) === 'call.missed');
  check('плашка «Пропущенный звонок» в DM', !!missedEvt);
  const afterEnd = await http('GET', `/messenger/chats/${dmId}`, { token: t1.token });
  check('activeCall погашен после завершения', !afterEnd.json?.data?.activeCall);

  // ---------- 4б. Уведомление call.missed — у ВТОРОЙ стороны, когда ЗВОНЯЩИЙ сам отменил ----------
  // Правило продукта: нажавший «Отклонить» (endedById) «Пропущенный» НЕ получает — поэтому
  // в сценарии 4 уведомления t2 быть не должно (старый чек проходил на НЕсвежих строках
  // прошлых прогонов). Честный сценарий: t1 позвонил, не дождался и отменил → t2 получает.
  const sinceMissed = Date.now();
  const tokM = await http('POST', '/calls/token', { token: t1.token, body: { refType: 'chat', refId: dmId } });
  const roomM = tokM.json?.data?.roomName;
  const sesM = tokM.json?.data?.sessionId;
  await joinWebhook(roomM, t1.id);
  await http('POST', `/calls/rooms/${sesM}/end`, { token: t1.token });
  const notifM = await waitFor(async () => {
    const n = await http('GET', '/notifications', { token: t2.token });
    return (
      (n.json?.data?.items ?? []).find(
        (x) => x.type === 'call.missed' && new Date(x.createdAt).getTime() >= sinceMissed - 10_000,
      ) ?? null
    );
  });
  check('уведомление call.missed у t2 (звонящий отменил дозвон)', !!notifM);

  // ---------- 5. Состоявшийся звонок → плашка «Звонок · N» ----------
  const tokA = await http('POST', '/calls/token', { token: t1.token, body: { refType: 'chat', refId: dmId } });
  const room2 = tokA.json?.data?.roomName;
  await joinWebhook(room2, t1.id);
  await joinWebhook(room2, t2.id);
  await finishWebhook(room2);
  const endedEvt = await waitFor(async () => (await lastSystemEvent(t1.token, dmId)) === 'call.ended');
  check('плашка «Звонок · N» после room_finished (оба были)', !!endedEvt);

  // ---------- 6. Группа: любой участник входит, модерирует owner/admin ----------
  const grp = await http('POST', '/messenger/chats/group', { token: t1.token, body: { name: 'Звонки тест', memberIds: [t2.id] } });
  const grpId = grp.json?.data?.id;
  check('группа создана', !!grpId, JSON.stringify(grp.json));
  const gTok2 = await http('POST', '/calls/token', { token: t2.token, body: { refType: 'chat', refId: grpId } });
  check('группа: рядовой участник входит, но НЕ модератор', (gTok2.status === 201 || gTok2.status === 200) && gTok2.json?.data?.moderator === false, JSON.stringify(gTok2.json?.data));
  const gSess = gTok2.json?.data?.sessionId;
  const gEnd2 = await http('POST', `/calls/rooms/${gSess}/end`, { token: t2.token });
  check('группа: рядовой НЕ может завершить для всех → 403', gEnd2.status === 403, `status ${gEnd2.status}`);
  const gTok1 = await http('POST', '/calls/token', { token: t1.token, body: { refType: 'chat', refId: grpId } });
  check('группа: owner — модератор', gTok1.json?.data?.moderator === true);
  await joinWebhook(gTok1.json?.data?.roomName, t1.id);
  const gEnd1 = await http('POST', `/calls/rooms/${gSess}/end`, { token: t1.token });
  check('группа: owner завершает для всех', gEnd1.status === 201 || gEnd1.status === 200, `status ${gEnd1.status}`);

  // ---------- 7. Блок гасит DM-звонок ----------
  await withPrisma(async (p) => {
    const [a, b] = [t1.id, t3.id].sort();
    await p.contactLink.upsert({
      where: { userAId_userBId: { userAId: a, userBId: b } },
      update: {},
      create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: t1.id },
    });
  });
  const dm13 = await http('POST', '/messenger/chats/dm', { token: t1.token, body: { userId: t3.id } });
  const dm13Id = dm13.json?.data?.id;
  check('DM t1-t3 открыт', !!dm13Id, JSON.stringify(dm13.json));
  const blk = await http('POST', '/contacts/blocks', { token: t1.token, body: { userId: t3.id } });
  check('t1 блокирует t3', blk.status === 200 || blk.status === 201, `status ${blk.status}`);
  const blockedTok = await http('POST', '/calls/token', { token: t1.token, body: { refType: 'chat', refId: dm13Id } });
  check('блок → звонок в DM невозможен (обе стороны)', blockedTok.status === 403, `status ${blockedTok.status}`);
  const blockedTok3 = await http('POST', '/calls/token', { token: t3.token, body: { refType: 'chat', refId: dm13Id } });
  check('блок → и заблокированный не позвонит', blockedTok3.status === 403, `status ${blockedTok3.status}`);
  await http('DELETE', `/contacts/blocks/${t3.id}`, { token: t1.token });

  // ---------- 8. Чат офис-встречи исключён (у сущности свой звонок) ----------
  const officeChatId = crypto.randomUUID();
  await withPrisma(async (p) => {
    await p.chat.create({
      data: {
        id: officeChatId, type: 'context', parentType: 'office_room', parentId: crypto.randomUUID(),
        title: 'Встреча-тест', members: { create: [{ userId: t1.id }] },
      },
    });
  });
  const offTok = await http('POST', '/calls/token', { token: t1.token, body: { refType: 'chat', refId: officeChatId } });
  check('чат офис-встречи → 403 (звонок у сущности office_room)', offTok.status === 403, `status ${offTok.status}`);
  await withPrisma(async (p) => { await p.chat.delete({ where: { id: officeChatId } }).catch(() => undefined); });

  console.log(failed === 0 ? `\nALL PASS (${passed})` : `\nFAILS: ${failed} (passed ${passed})`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
