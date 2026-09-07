/* eslint-disable */
// E2E: упоминания как уведомления движка core/notifications. Сообщение с @[Name](userId) →
// событие `mention.received` (reason=mention, ref=chat_message) только участникам чата
// (security: чужой id в тексте игнорируется), без самоупоминания; правка сообщения не
// дублирует (idempotencyKey mention:<messageId>:<userId>); вкладка «Упоминания» =
// `GET /notifications?mentions=1`; прочитать — `POST /notifications/read`.
// Requires API on 3001 + suite accounts. Run: node apps/api/scripts/verify-mentions.cjs
const { SUITE, call, login, makeChecker } = require('./_lib.cjs');
const { PrismaClient } = require('@prisma/client');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function feed(token) {
  return (await call('GET', '/notifications?mentions=1&limit=50', token)).json?.data;
}
async function waitFor(fn, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(400);
  }
}

async function main() {
  const { check, finish } = makeChecker();
  const prisma = new PrismaClient();
  const t1 = await login(SUITE.p1), t2 = await login(SUITE.p2), t3 = await login(SUITE.p3);
  const link = async (x, y, by) => { const [a, b] = x < y ? [x, y] : [y, x]; await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: by } }); };
  await link(t1.id, t2.id, t1.id); await link(t1.id, t3.id, t1.id);
  console.log('logged in 3 suite accounts + linked');

  const dm = await call('POST', '/messenger/chats/dm', t1.token, { userId: t2.id });
  const chatId = dm.json?.data?.id;
  check('opened DM t1↔t2', !!chatId);
  const stamp = Date.now();

  console.log('\n-- mentionable picker = chat members only --');
  let r = await call('GET', `/messenger/chats/${chatId}/mentionable`, t1.token);
  const cand = (r.json?.data || []).map((c) => c.userId);
  check('picker offers t2 (member)', cand.includes(t2.id), JSON.stringify(cand));
  check('picker excludes self (t1)', !cand.includes(t1.id));
  check('picker excludes t3 (non-member)', !cand.includes(t3.id));

  console.log('\n-- send message mentioning t2 (member) + t3 (non-member) --');
  const content = `Привет @[Тестер Второй](${t2.id}) и @[Чужой](${t3.id})! ${stamp}`;
  r = await call('POST', `/messenger/chats/${chatId}/messages`, t1.token, { content });
  check('message sent', r.status === 200 || r.status === 201);
  const messageId = r.json?.data?.id;

  const mine = await waitFor(async () => (await feed(t2.token))?.items?.find((x) => x.payload?.messageId === messageId) ?? null);
  check('t2 has the mention in «Упоминания» (mentions=1)', !!mine, 'не появилось за 10с');
  check('row: reason=mention, ref=chat_message', mine?.reason === 'mention' && mine?.ref?.type === 'chat_message' && mine?.ref?.id === messageId);
  check('deep link ведёт в чат к сообщению', mine?.href === `/messenger?chat=${chatId}&msg=${messageId}`, mine?.href);
  check('snippet present', typeof mine?.payload?.snippet === 'string' && mine.payload.snippet.length > 0);
  check('актор — автор сообщения', mine?.actorId === t1.id);
  const f3 = await feed(t3.token);
  check('t3 (non-member) got NO mention (security)', !(f3?.items || []).some((x) => x.payload?.messageId === messageId));

  console.log('\n-- self-mention ignored --');
  await call('POST', `/messenger/chats/${chatId}/messages`, t1.token, { content: `Себе: @[Я](${t1.id}) ${stamp}` });
  await sleep(800);
  const f1 = await feed(t1.token);
  check('author has no self-mention', !(f1?.items || []).some((x) => x.payload?.snippet && x.payload.snippet.includes(`Себе: @[Я](${t1.id}) ${stamp}`)));

  console.log('\n-- edit adds only NEW mentions (no duplicate) --');
  const countFor = async () => ((await feed(t2.token))?.items || []).filter((x) => x.payload?.messageId === messageId).length;
  const before = await countFor();
  await call('PATCH', `/messenger/messages/${messageId}`, t1.token, { content: `Изменено @[Тестер Второй](${t2.id}) снова ${stamp}` });
  await sleep(1200);
  const after = await countFor();
  check('re-mention of t2 does NOT duplicate (idempotencyKey per message+user)', before === 1 && after === 1, `before ${before} after ${after}`);
  const events = await prisma.notificationEvent.count({ where: { type: 'mention.received', idempotencyKey: `mention:${messageId}:${t2.id}` } });
  check('событие одно (ключ mention:<messageId>:<userId>)', events === 1, String(events));

  console.log('\n-- read --');
  const unreadBefore = (await call('GET', '/notifications?mentions=1&state=unread', t2.token)).json?.data?.items?.length ?? 0;
  check('t2 has unread mention before read', unreadBefore >= 1);
  r = await call('POST', '/notifications/read', t2.token, { ids: [mine.id] });
  check('read ok', r.ok && r.json?.data?.updated === 1);
  const unreadAfter = ((await call('GET', '/notifications?mentions=1&state=unread', t2.token)).json?.data?.items || []).some((x) => x.id === mine.id);
  check('mention no longer unread', !unreadAfter);

  console.log('\n-- a user cannot touch another user mention --');
  r = await call('POST', `/notifications/${mine.id}/archive`, t3.token);
  check('cross-user archive → 404', r.status === 404, String(r.status));

  await prisma.notificationEvent.deleteMany({ where: { type: 'mention.received', refId: messageId } }).catch(() => undefined);
  await prisma.$disconnect();
  finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
