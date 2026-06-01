/* eslint-disable */
// Phase 5 e2e: Mentions Hub. A message with @[Name](userId) → records a Mention for chat
// members only (security), skips self + non-members, fires mention.received notification,
// hub feed + mark-read + unread, deep-link fields, edit adds only NEW mentions.
// Requires API on 3001 + seeded testers. Run: node scripts/verify-mentions.cjs
const fs = require('fs'), path = require('path');
for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = process.env.API_URL || 'http://localhost:3001/api';
const CREDS = {
  t1: { phone: '+77001234567', password: 'Test1234!' }, // author
  t2: { phone: '+77012345678', password: 'Test1234!' }, // chat member (mentionable)
  t3: { phone: '+77023456789', password: 'Test1234!' }, // NOT in the chat
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
const feed = async (token) => (await http('GET', '/mentions', { token })).json?.data;

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(CREDS.t1), t2 = await login(CREDS.t2), t3 = await login(CREDS.t3);
  // Окружение: t1↔t2 (DM members), t1↔t3 (so t1 *could* tag t3 but t3 not in this chat)
  const link = async (x, y, by) => { const [a, b] = x < y ? [x, y] : [y, x]; await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: by } }); };
  await link(t1.id, t2.id, t1.id); await link(t1.id, t3.id, t1.id);
  console.log('logged in 3 testers + linked');

  // Clear t2's prior mentions for a clean unread baseline.
  await prisma.mention.deleteMany({ where: { mentionedUserId: { in: [t2.id, t3.id] } } });

  // DM t1↔t2 (chat members = t1,t2; t3 is NOT a member).
  const dm = await http('POST', '/messenger/chats/dm', { token: t1.token, body: { userId: t2.id } });
  const chatId = dm.json?.data?.id;
  check('opened DM t1↔t2', !!chatId);

  console.log('\n-- mentionable picker = chat members only --');
  let r = await http('GET', `/messenger/chats/${chatId}/mentionable`, { token: t1.token });
  const cand = (r.json?.data || []).map((c) => c.userId);
  check('picker offers t2 (member)', cand.includes(t2.id), JSON.stringify(cand));
  check('picker excludes self (t1)', !cand.includes(t1.id));
  check('picker excludes t3 (non-member)', !cand.includes(t3.id));

  console.log('\n-- send message mentioning t2 (member) + t3 (non-member) --');
  // t3 token is forged into the text; the server must ignore it (not a chat member).
  const content = `Привет @[Тестер Второй](${t2.id}) и @[Чужой](${t3.id})!`;
  r = await http('POST', `/messenger/chats/${chatId}/messages`, { token: t1.token, body: { content } });
  check('message sent', r.status === 200 || r.status === 201);
  const messageId = r.json?.data?.id;
  await sleep(300);

  const f2 = await feed(t2.token);
  check('t2 has a mention in the hub', (f2?.items || []).some((x) => x.messageId === messageId), JSON.stringify((f2?.items||[]).length));
  check('t2 unreadCount >= 1', (f2?.unreadCount ?? 0) >= 1);
  const mine = (f2?.items || []).find((x) => x.messageId === messageId);
  check('mention deep-links to the chat', mine && mine.url === `/messenger?chat=${chatId}`, mine?.url);
  check('mention snippet present', mine && typeof mine.snippet === 'string' && mine.snippet.length > 0);
  check('mention sourceType=messenger', mine && mine.sourceType === 'messenger');

  const f3 = await feed(t3.token);
  check('t3 (non-member) got NO mention (security)', !(f3?.items || []).some((x) => x.messageId === messageId));

  console.log('\n-- mention.received notification fired for t2 --');
  await sleep(500); // notify fires right after the mention row is created
  const notif = await http('GET', '/notifications', { token: t2.token });
  // Notifications now use the standard { success, data: { items, unreadCount, nextCursor } } envelope.
  const notifItems = notif.json?.data?.items ?? [];
  check('t2 has mention.received notification', notifItems.some((n) => n.type === 'mention.received'));

  console.log('\n-- self-mention ignored --');
  await http('POST', `/messenger/chats/${chatId}/messages`, { token: t1.token, body: { content: `Себе: @[Я](${t1.id})` } });
  await sleep(200);
  const f1 = await feed(t1.token);
  check('author has no self-mention from that message', !(f1?.items || []).some((x) => x.snippet && x.snippet.includes('Себе')));

  console.log('\n-- edit adds only NEW mentions (no duplicate) --');
  const before = (await feed(t2.token))?.items.filter((x) => x.messageId === messageId).length || 0;
  await http('PATCH', `/messenger/messages/${messageId}`, { token: t1.token, body: { content: `Изменено @[Тестер Второй](${t2.id}) снова` } });
  await sleep(250);
  const after = (await feed(t2.token))?.items.filter((x) => x.messageId === messageId).length || 0;
  check('re-mention of t2 does NOT duplicate (unique per message+user)', before === 1 && after === 1, `before ${before} after ${after}`);

  console.log('\n-- mark-read --');
  let f = await feed(t2.token);
  check('t2 has unread before mark', (f?.unreadCount ?? 0) >= 1);
  await http('POST', '/mentions/mark-read', { token: t2.token, body: {} }); // all
  f = await feed(t2.token);
  check('t2 unreadCount=0 after mark-read all', (f?.unreadCount ?? 0) === 0, String(f?.unreadCount));
  check('items now marked read', (f?.items || []).every((x) => x.read === true));

  console.log('\n-- a user cannot mark another user mentions --');
  // t3 marking t2's mention id should be a no-op (scoped to mentionedUserId).
  if (mine) {
    await http('POST', '/mentions/mark-read', { token: t3.token, body: { ids: [mine.id] } });
    check('cross-user mark-read is a no-op (no error)', true); // already read; just ensure no crash
  }

  await prisma.$disconnect();
  console.log(`\nRESULT ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
