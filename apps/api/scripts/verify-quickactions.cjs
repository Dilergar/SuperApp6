/* eslint-disable */
// Phase 7 e2e: Quick Actions registry + reply/quote + scheduled messages ("Напомнить";
// выстрел — джоб core/jobs с runAt=sendAt).
// Covers: GET /quick-actions (scope/permission filter), reply (replyTo preview, cross-chat 400),
// scheduled lifecycle (schedule/list/update/cancel + validation + access), and the job FIRE
// (a due row + hand-inserted job → posted message + author ping, ≤20s).
// Requires API on 3001 + seeded testers. Run: node scripts/verify-quickactions.cjs
const fs = require('fs'), path = require('path');
for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = process.env.API_URL || 'http://localhost:3001/api';
const CREDS = {
  t1: { phone: '+77001234567', password: 'Test1234!' },
  t2: { phone: '+77012345678', password: 'Test1234!' },
  t3: { phone: '+77023456789', password: 'Test1234!' }, // outsider
};
async function http(method, p, { token, body } = {}) {
  const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await res.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t }; }
  return { status: res.status, json: j };
}
async function login(c) { const { json } = await http('POST', '/auth/login', { body: c }); const token = json.data.accessToken; const me = await http('GET', '/users/me', { token }); return { token, id: me.json.data.id }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, extra) => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n}${extra ? '  (' + extra + ')' : ''}`); } };
const send = async (token, chatId, body) => (await http('POST', `/messenger/chats/${chatId}/messages`, { token, body })).json?.data;
const qa = async (token, chatId, scope) => (await http('GET', `/quick-actions?chatId=${chatId}&scope=${scope}`, { token }));
const keys = (r) => (r.json?.data || []).map((a) => a.key);

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(CREDS.t1), t2 = await login(CREDS.t2), t3 = await login(CREDS.t3);
  const link = async (x, y, by) => { const [a, b] = x < y ? [x, y] : [y, x]; await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: by } }); };
  await link(t1.id, t2.id, t1.id);
  console.log('logged in + linked');

  const dm = await http('POST', '/messenger/chats/dm', { token: t1.token, body: { userId: t2.id } });
  const dmId = dm.json?.data?.id;
  check('opened DM t1↔t2', !!dmId);

  console.log('\n-- quick actions registry (scope + permission filter) --');
  let r = await qa(t1.token, dmId, 'composer');
  check('composer menu has task.create', keys(r).includes('task.create'), JSON.stringify(keys(r)));
  check('composer menu has event.create', keys(r).includes('event.create'));
  check('composer menu has message.schedule', keys(r).includes('message.schedule'));
  r = await qa(t1.token, dmId, 'message');
  check('message menu has task.create + message.schedule', keys(r).includes('task.create') && keys(r).includes('message.schedule'));
  check('message menu EXCLUDES event.create (composer-only)', !keys(r).includes('event.create'), JSON.stringify(keys(r)));
  r = await qa(t3.token, dmId, 'composer');
  check('outsider t3 gets 403 on quick-actions', r.status === 403, String(r.status));

  console.log('\n-- reply / quote --');
  const msgA = await send(t1.token, dmId, { content: 'Базовое сообщение для цитаты' });
  const reply = await send(t1.token, dmId, { content: 'Это ответ на сообщение', replyToId: msgA.id });
  check('reply carries replyTo preview (id + text)', reply?.replyTo && reply.replyTo.id === msgA.id && (reply.replyTo.text || '').includes('Базовое'), JSON.stringify(reply?.replyTo));
  const msgs = (await http('GET', `/messenger/chats/${dmId}/messages`, { token: t2.token })).json?.data || [];
  const seen = msgs.find((m) => m.id === reply.id);
  check('getMessages returns the reply preview for the other user', seen?.replyTo?.id === msgA.id, JSON.stringify(seen?.replyTo));
  // cross-chat quote → 400
  const grp = await http('POST', '/messenger/chats/group', { token: t1.token, body: { name: 'Группа для теста цитаты', memberIds: [t2.id] } });
  const grpId = grp.json?.data?.id;
  const msgInG = await send(t1.token, grpId, { content: 'Сообщение в другой группе' });
  const cross = await http('POST', `/messenger/chats/${dmId}/messages`, { token: t1.token, body: { content: 'Цитирую чужой чат', replyToId: msgInG.id } });
  check('cross-chat quote rejected (400)', cross.status === 400, String(cross.status));

  console.log('\n-- scheduled messages: schedule / list / validate / access / update / cancel --');
  const futureIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  let s = await http('POST', `/messenger/chats/${dmId}/scheduled`, { token: t1.token, body: { content: 'Запланированное сообщение', sendAt: futureIso } });
  check('schedule (future) ok', s.status === 200 || s.status === 201, String(s.status));
  const schedId = s.json?.data?.id;
  let list = (await http('GET', `/messenger/chats/${dmId}/scheduled`, { token: t1.token })).json?.data || [];
  check('list shows my pending scheduled message', list.some((x) => x.id === schedId));
  // validation
  const past = await http('POST', `/messenger/chats/${dmId}/scheduled`, { token: t1.token, body: { content: 'В прошлом', sendAt: new Date(Date.now() - 60000).toISOString() } });
  check('schedule in the past → 400', past.status === 400, String(past.status));
  const tooSoon = await http('POST', `/messenger/chats/${dmId}/scheduled`, { token: t1.token, body: { content: 'Слишком скоро', sendAt: new Date(Date.now() + 5000).toISOString() } });
  check('schedule under min lead → 400', tooSoon.status === 400, String(tooSoon.status));
  const t3sched = await http('POST', `/messenger/chats/${dmId}/scheduled`, { token: t3.token, body: { content: 'Чужой', sendAt: futureIso } });
  check('outsider t3 cannot schedule in the DM (403)', t3sched.status === 403, String(t3sched.status));
  // update
  await http('PATCH', `/messenger/scheduled/${schedId}`, { token: t1.token, body: { content: 'Обновлённый текст' } });
  list = (await http('GET', `/messenger/chats/${dmId}/scheduled`, { token: t1.token })).json?.data || [];
  check('update changed the content', list.find((x) => x.id === schedId)?.content === 'Обновлённый текст');
  // cancel
  await http('DELETE', `/messenger/scheduled/${schedId}`, { token: t1.token });
  list = (await http('GET', `/messenger/chats/${dmId}/scheduled`, { token: t1.token })).json?.data || [];
  check('cancel removes it from pending list', !list.some((x) => x.id === schedId));

  console.log('\n-- scheduled fire (джоб core/jobs с runAt=sendAt, до ~20с) --');
  // Строка мимо API = без джоба (доджобовая эра); джоб вставляем руками — ровно то,
  // что делает bootstrap-бэкфилл ScheduledMessageService (uniqueKey с версией времени).
  const token = 'Сработало7' + Date.now();
  const sendAtPast = new Date(Date.now() - 5000);
  const smRow = await prisma.scheduledMessage.create({ data: { chatId: dmId, authorId: t1.id, content: `Напоминание ${token}`, sendAt: sendAtPast, status: 'pending' } });
  await prisma.job.create({ data: { type: 'messenger.scheduled.fire', payload: { scheduledMessageId: smRow.id, sendAtMs: sendAtPast.getTime() }, uniqueKey: `sm:${smRow.id}:${sendAtPast.getTime()}`, maxAttempts: 8 } });
  let fired = false;
  for (let i = 0; i < 10 && !fired; i++) {
    await sleep(2000);
    const m = (await http('GET', `/messenger/chats/${dmId}/messages`, { token: t1.token })).json?.data || [];
    if (m.some((x) => (x.content || '').includes(token))) fired = true;
    else process.stdout.write('.');
  }
  console.log('');
  check('джоб выстрелил due-сообщение в чат', fired);
  if (fired) {
    const row = await prisma.scheduledMessage.findFirst({ where: { chatId: dmId, authorId: t1.id, content: `Напоминание ${token}` } });
    check('scheduled row marked sent (+sentMessageId)', row?.status === 'sent' && !!row.sentMessageId, row?.status);
    await sleep(600);
    const notif = (await http('GET', '/notifications', { token: t1.token })).json;
    const items = notif?.data?.items ?? [];
    check('author got messenger.scheduled.sent notification', items.some((n) => n.type === 'messenger.scheduled.sent'));
  }

  await prisma.$disconnect();
  console.log(`\nRESULT ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
