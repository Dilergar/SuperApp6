/* eslint-disable */
// Phase 6 e2e: unified search (messenger consumer). Covers: message indexing on send,
// Russian word-form (FTS stem) match, chat-title + person (live) search, PERMISSION TRIM
// (non-member can't find a chat's messages), visibleFromSeq (no history before join),
// in-chat scope, edit re-indexes, delete de-indexes, deep-link fields, grouped shape.
// Requires API on 3001 + seeded testers. Run: node scripts/verify-search.cjs
const fs = require('fs'), path = require('path');
for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = process.env.API_URL || 'http://localhost:3001/api';
const CREDS = {
  t1: { phone: '+77001234567', password: 'Test1234!' }, // author / searcher / member
  t2: { phone: '+77012345678', password: 'Test1234!' }, // DM peer + group member
  t3: { phone: '+77023456789', password: 'Test1234!' }, // outsider, later late-joiner
};
async function http(method, p, { token, body } = {}) {
  const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await res.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t }; }
  return { status: res.status, json: j };
}
async function login(c) {
  const { json } = await http('POST', '/auth/login', { body: c });
  const token = json.data.accessToken;
  const me = await http('GET', '/users/me', { token });
  const d = me.json.data;
  return { token, id: d.id, name: [d.firstName, d.lastName].filter(Boolean).join(' ').trim() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, extra) => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n}${extra ? '  (' + extra + ')' : ''}`); } };

const sendMsg = async (token, chatId, content) => (await http('POST', `/messenger/chats/${chatId}/messages`, { token, body: { content } })).json?.data;
const global = async (token, q) => (await http('GET', `/search?q=${encodeURIComponent(q)}`, { token })).json?.data;
const inChat = async (token, chatId, q) => (await http('GET', `/search?q=${encodeURIComponent(q)}&chatId=${chatId}`, { token })).json?.data;
const groupItems = (data, type) => (data?.groups || []).find((g) => g.type === type)?.items || [];
const msgIds = (data) => groupItems(data, 'message').map((i) => i.messageId);

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(CREDS.t1), t2 = await login(CREDS.t2), t3 = await login(CREDS.t3);
  const link = async (x, y, by) => { const [a, b] = x < y ? [x, y] : [y, x]; await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: by } }); };
  await link(t1.id, t2.id, t1.id); await link(t1.id, t3.id, t1.id);
  console.log('logged in 3 testers + linked');

  // DM t1↔t2.
  const dm = await http('POST', '/messenger/chats/dm', { token: t1.token, body: { userId: t2.id } });
  const dmId = dm.json?.data?.id;
  check('opened DM t1↔t2', !!dmId);

  const dmA = await sendMsg(t1.token, dmId, 'Снял квартиры возле метро');     // FTS stem test
  const dmB = await sendMsg(t1.token, dmId, 'Кодовое слово арбузник');         // edit test
  const dmC = await sendMsg(t1.token, dmId, 'Черновик чернобривец удалить');   // delete test
  await sleep(150);

  // Group (ad-hoc) by t1 with t2; t3 added LATER (visibleFromSeq test).
  const grp = await http('POST', '/messenger/chats/group', { token: t1.token, body: { name: 'Отпускпланнер Турция', memberIds: [t2.id] } });
  const grpId = grp.json?.data?.id;
  check('created group chat', !!grpId);
  const grpOld = await sendMsg(t1.token, grpId, 'Старыйплан позвонить агенту'); // before t3 joins
  await sleep(120);

  console.log('\n-- projection + FTS word-form (Russian stem) --');
  let d = await global(t1.token, 'оплата'); // not present → should not surface dmA
  d = await global(t1.token, 'квартира');   // doc has "квартиры" → stem "квартир"
  check('FTS stem: "квартира" finds "квартиры"', msgIds(d).includes(dmA.id), JSON.stringify(msgIds(d)));
  check('global result is grouped (has groups[])', Array.isArray(d?.groups) && d.totalCount > 0);

  console.log('\n-- deep-link fields on a message hit --');
  const hit = groupItems(d, 'message').find((i) => i.messageId === dmA.id);
  check('message hit has chatId+messageId', hit && hit.chatId === dmId && hit.messageId === dmA.id);
  check('message hit url = /messenger?chat=&msg=', hit && hit.url === `/messenger?chat=${dmId}&msg=${dmA.id}`, hit?.url);

  console.log('\n-- chat-title search (live) --');
  d = await global(t1.token, 'Отпускпланнер');
  check('chat title "Отпускпланнер" finds the group', groupItems(d, 'chat').some((i) => i.id === grpId));

  console.log('\n-- person search (live, окружение) --');
  const needle = (t2.name || '').slice(0, 4);
  d = await global(t1.token, needle || 'Тест');
  check('person search finds t2 by name', groupItems(d, 'person').some((i) => i.id === t2.id), `needle="${needle}"`);

  console.log('\n-- PERMISSION TRIM: outsider t3 can\'t find DM messages --');
  d = await global(t3.token, 'квартира');
  check('t3 does NOT find t1↔t2 DM message', !msgIds(d).includes(dmA.id));
  d = await global(t3.token, 'Отпускпланнер');
  check('t3 (non-member) does NOT find the group by title', !groupItems(d, 'chat').some((i) => i.id === grpId));

  console.log('\n-- in-chat scope --');
  // grpOld word is in the GROUP, not the DM → in-chat DM search must not find it.
  d = await inChat(t1.token, dmId, 'Старыйплан');
  check('in-chat DM search excludes a group message', !d.items.some((i) => i.messageId === grpOld.id));
  d = await inChat(t1.token, dmId, 'квартира');
  check('in-chat DM search finds the DM message', d.items.some((i) => i.messageId === dmA.id));

  console.log('\n-- visibleFromSeq: search visibility == chat (getMessages) visibility --');
  await http('POST', `/messenger/chats/${grpId}/members`, { token: t1.token, body: { userIds: [t3.id] } });
  const grpNew = await sendMsg(t1.token, grpId, 'Новыйплан уникальнаястрока маршрут');
  await sleep(150);
  // Added members currently join with FULL history (visibleFromSeq=0); search must mirror that.
  d = await inChat(t3.token, grpId, 'Старыйплан');
  check('new member sees full history by default (finds pre-join msg, like getMessages)', d.items.some((i) => i.messageId === grpOld.id), JSON.stringify(d.items.map((i) => i.messageId)));
  // Now set a history floor directly and confirm search hides everything below it (the SQL clause).
  await prisma.chatMember.updateMany({ where: { chatId: grpId, userId: t3.id }, data: { visibleFromSeq: grpNew.seq } });
  d = await inChat(t3.token, grpId, 'Старыйплан');
  check('member does NOT find a message below visibleFromSeq', !d.items.some((i) => i.messageId === grpOld.id), JSON.stringify(d.items.map((i) => i.messageId)));
  d = await inChat(t3.token, grpId, 'уникальнаястрока');
  check('member finds a message at/above visibleFromSeq', d.items.some((i) => i.messageId === grpNew.id), JSON.stringify(d.items.map((i) => i.messageId)));

  console.log('\n-- edit re-indexes --');
  await http('PATCH', `/messenger/messages/${dmB.id}`, { token: t1.token, body: { content: 'Кодовое слово дынямир' } });
  await sleep(150);
  check('old word "арбузник" no longer finds the message', !msgIds(await global(t1.token, 'арбузник')).includes(dmB.id));
  check('new word "дынямир" finds the edited message', msgIds(await global(t1.token, 'дынямир')).includes(dmB.id));

  console.log('\n-- delete de-indexes --');
  await http('DELETE', `/messenger/messages/${dmC.id}`, { token: t1.token });
  await sleep(150);
  check('deleted message is no longer findable', !msgIds(await global(t1.token, 'чернобривец')).includes(dmC.id));

  console.log('\n-- review fixes: recency paging order + centered snippet + typo tolerance --');
  const recA = await sendMsg(t1.token, dmId, 'Хронотест первый ранний');
  await sleep(80);
  const recB = await sendMsg(t1.token, dmId, 'Хронотест второй поздний');
  await sleep(150);
  let pg = await inChat(t1.token, dmId, 'Хронотест');
  const idxA = pg.items.findIndex((i) => i.messageId === recA.id);
  const idxB = pg.items.findIndex((i) => i.messageId === recB.id);
  check('in-chat page is recency-ordered (newer first)', idxA >= 0 && idxB >= 0 && idxB < idxA, `B@${idxB} A@${idxA}`);

  const longBody = 'старт ' + 'фоновыйтекст '.repeat(20) + 'ключевоеслово ' + 'ещёфон '.repeat(20) + 'конец';
  const longMsg = await sendMsg(t1.token, dmId, longBody);
  await sleep(150);
  pg = await inChat(t1.token, dmId, 'ключевоеслово');
  const lh = pg.items.find((i) => i.messageId === longMsg.id);
  check('snippet centered on the match (starts with …, contains term)', !!lh && lh.snippet.startsWith('…') && lh.snippet.includes('ключевоеслово'), lh && lh.snippet.slice(0, 50));

  const typoMsg = await sendMsg(t1.token, dmId, 'Обсудим программирование завтра');
  await sleep(150);
  const typo = await global(t1.token, 'программирвание'); // transposed typo, no exact/stem match
  check('typo query finds the message (trigram, threshold 0.4)', msgIds(typo).includes(typoMsg.id), JSON.stringify(msgIds(typo)));

  console.log('\n-- short query rejected (min length) --');
  const short = await http('GET', '/search?q=a', { token: t1.token });
  check('1-char query → 400', short.status === 400, String(short.status));

  await prisma.$disconnect();
  console.log(`\nRESULT ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
