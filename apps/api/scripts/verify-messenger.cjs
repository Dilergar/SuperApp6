// E2E for the Messenger (Phase 1: DM spine). Requires the API running on 3001
// and the three seeded testers. Run: node apps/api/scripts/verify-messenger.cjs
const BASE = process.env.API_URL || 'http://localhost:3001/api';

const CREDS = {
  t1: { phone: '+77001234567', password: 'Test1234!' },
  t2: { phone: '+77012345678', password: 'Test1234!' },
  t3: { phone: '+77023456789', password: 'Test1234!' },
};

async function http(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function login(creds) {
  const { status, json } = await http('POST', '/auth/login', { body: creds });
  if (status !== 200 && status !== 201) throw new Error(`login failed ${status}: ${JSON.stringify(json)}`);
  const token = json.data.accessToken;
  const me = await http('GET', '/users/me', { token });
  const id = me.json?.data?.id;
  if (!id) throw new Error(`/users/me missing id: ${JSON.stringify(me.json)}`);
  return { token, id };
}

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

async function ensureContact(tokenA, tokenB, phoneB) {
  const { json: contacts } = await http('GET', '/contacts', { token: tokenA });
  if ((contacts?.data || []).find((c) => c.phone === phoneB)) return;
  const inv = await http('POST', '/contacts/invitations', {
    token: tokenA,
    body: { toPhone: phoneB, proposedRoleForSender: 'Друг', proposedRoleForRecipient: 'Друг' },
  });
  const invId = inv.json?.data?.id;
  const incoming = await http('GET', '/contacts/invitations/incoming', { token: tokenB });
  const toAccept = (incoming.json?.data || []).find((i) => i.id === invId) || (incoming.json?.data || [])[0];
  if (toAccept) {
    await http('POST', `/contacts/invitations/${toAccept.id}/accept`, {
      token: tokenB, body: { myRole: 'Друг', theirRole: 'Друг' },
    });
  }
}

function withPrisma(fn) {
  let PrismaClient;
  try { ({ PrismaClient } = require('@prisma/client')); }
  catch { console.log('  (prisma helper skipped: @prisma/client not resolvable)'); return Promise.resolve(false); }
  const prisma = new PrismaClient();
  return Promise.resolve(fn(prisma)).finally(() => prisma.$disconnect());
}

// Make the run idempotent: drop a DM (cascade removes members + messages) + its access tuples.
async function resetDm(idA, idB) {
  return withPrisma(async (prisma) => {
    const dmKey = [idA, idB].sort().join(':');
    const chat = await prisma.chat.findUnique({ where: { dmKey } });
    if (chat) {
      await prisma.relationTuple.deleteMany({ where: { resourceType: 'chat', resourceId: chat.id } });
      await prisma.chat.delete({ where: { id: chat.id } });
    }
  });
}

// Guarantee two users are NOT in each other's Окружение, so the 403 path is deterministic
// regardless of what earlier verify scripts linked. Also drops any stale DM between them.
async function unlinkContacts(idA, idB) {
  return withPrisma(async (prisma) => {
    const [a, b] = [idA, idB].sort();
    await prisma.contactLink.deleteMany({ where: { userAId: a, userBId: b } });
    const dmKey = [idA, idB].sort().join(':');
    const chat = await prisma.chat.findUnique({ where: { dmKey } });
    if (chat) {
      await prisma.relationTuple.deleteMany({ where: { resourceType: 'chat', resourceId: chat.id } });
      await prisma.chat.delete({ where: { id: chat.id } });
    }
  });
}

async function main() {
  const t1 = await login(CREDS.t1);
  const t2 = await login(CREDS.t2);
  const t3 = await login(CREDS.t3);
  console.log('logged in 3 testers');

  await ensureContact(t1.token, t2.token, CREDS.t2.phone);
  await resetDm(t1.id, t2.id);

  console.log('\n-- DM lifecycle --');
  let r = await http('POST', '/messenger/chats/dm', { token: t1.token, body: { userId: t2.id } });
  check('openDm ok', r.status === 200 || r.status === 201);
  const chatId = r.json?.data?.id;
  check('chat has id', !!chatId);
  check('chat type=dm', r.json?.data?.type === 'dm');

  r = await http('POST', '/messenger/chats/dm', { token: t1.token, body: { userId: t2.id } });
  check('openDm idempotent (one DM per pair)', r.json?.data?.id === chatId);

  r = await http('POST', '/messenger/chats/dm', { token: t1.token, body: { userId: t1.id } });
  check('cannot DM self (400)', r.status === 400);

  console.log('\n-- send / inbox / unread --');
  r = await http('POST', `/messenger/chats/${chatId}/messages`, { token: t1.token, body: { content: 'Привет!' } });
  check('send ok', r.status === 200 || r.status === 201);
  const msg1 = r.json?.data;
  check('msg seq=1', msg1?.seq === 1);
  check('msg mine=true', msg1?.mine === true);
  check('msg status=sent', msg1?.status === 'sent');

  r = await http('GET', '/messenger/chats', { token: t2.token });
  const t2chat = (r.json?.data || []).find((c) => c.id === chatId);
  check('t2 sees DM in inbox', !!t2chat);
  check('t2 unread=1', t2chat?.unreadCount === 1);
  check('t2 last preview = "Привет!"', t2chat?.lastMessage?.text === 'Привет!');

  r = await http('GET', '/messenger/chats', { token: t1.token });
  const t1chat = (r.json?.data || []).find((c) => c.id === chatId);
  check('t1 sees DM', !!t1chat);
  check('t1 unread=0 (own message)', t1chat?.unreadCount === 0);

  console.log('\n-- read receipts (sent -> delivered -> read) --');
  r = await http('GET', `/messenger/chats/${chatId}/messages`, { token: t2.token });
  check('t2 gets 1 message', Array.isArray(r.json?.data) && r.json.data.length === 1);
  check('t2 message mine=false', r.json?.data?.[0]?.mine === false);

  await http('POST', `/messenger/chats/${chatId}/read`, { token: t2.token, body: { seq: 1 } });
  r = await http('GET', '/messenger/chats', { token: t2.token });
  check('t2 unread cleared', ((r.json?.data || []).find((c) => c.id === chatId)?.unreadCount) === 0);

  r = await http('GET', `/messenger/chats/${chatId}/messages`, { token: t1.token });
  check('t1 message status=read', (r.json?.data || []).find((x) => x.seq === 1)?.status === 'read');

  console.log('\n-- edit / delete --');
  r = await http('PATCH', `/messenger/messages/${msg1.id}`, { token: t1.token, body: { content: 'Привет, как дела?' } });
  check('edit own ok', (r.status === 200 || r.status === 201) && r.json?.data?.content === 'Привет, как дела?');
  check('edit sets editedAt', !!r.json?.data?.editedAt);

  r = await http('PATCH', `/messenger/messages/${msg1.id}`, { token: t2.token, body: { content: 'hack' } });
  check('peer cannot edit (403)', r.status === 403);

  r = await http('POST', `/messenger/chats/${chatId}/messages`, { token: t1.token, body: { content: 'удалю это' } });
  const msg2 = r.json?.data;
  check('msg2 seq=2', msg2?.seq === 2);
  r = await http('DELETE', `/messenger/messages/${msg2.id}`, { token: t1.token });
  check('delete own ok', r.status === 200 || r.status === 201);
  r = await http('GET', `/messenger/chats/${chatId}/messages`, { token: t2.token });
  const del = (r.json?.data || []).find((x) => x.seq === 2);
  check('deleted tombstone (deletedAt set)', !!del?.deletedAt);
  check('deleted content nulled', del?.content === null);

  console.log('\n-- Hard access (non-member) --');
  r = await http('GET', `/messenger/chats/${chatId}`, { token: t3.token });
  check('outsider cannot view chat (403)', r.status === 403);
  r = await http('GET', `/messenger/chats/${chatId}/messages`, { token: t3.token });
  check('outsider cannot read messages (403)', r.status === 403);
  r = await http('POST', `/messenger/chats/${chatId}/messages`, { token: t3.token, body: { content: 'врываюсь' } });
  check('outsider cannot post (403)', r.status === 403);

  console.log('\n-- DM requires Окружение --');
  await unlinkContacts(t1.id, t3.id); // deterministic: ensure t1 & t3 are NOT linked
  r = await http('POST', '/messenger/chats/dm', { token: t1.token, body: { userId: t3.id } });
  check('DM with non-contact forbidden (403)', r.status === 403);

  console.log(`\nRESULT ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
