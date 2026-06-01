// E2E for Phase 2 group chats (ad-hoc, WhatsApp/Bitrix style). Requires the API on 3001
// + the 3 seeded testers. Run: node apps/api/scripts/verify-messenger-group.cjs
const BASE = process.env.API_URL || 'http://localhost:3001/api';
const CREDS = {
  t1: { phone: '+77001234567', password: 'Test1234!' },
  t2: { phone: '+77012345678', password: 'Test1234!' },
  t3: { phone: '+77023456789', password: 'Test1234!' },
};

async function http(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
async function login(creds) {
  const { json } = await http('POST', '/auth/login', { body: creds });
  const token = json.data.accessToken;
  const me = await http('GET', '/users/me', { token });
  return { token, id: me.json.data.id };
}
async function ensureContact(tokenA, tokenB, phoneB) {
  const { json: contacts } = await http('GET', '/contacts', { token: tokenA });
  if ((contacts?.data || []).find((c) => c.phone === phoneB)) return;
  const inv = await http('POST', '/contacts/invitations', {
    token: tokenA, body: { toPhone: phoneB, proposedRoleForSender: 'Друг', proposedRoleForRecipient: 'Друг' },
  });
  const invId = inv.json?.data?.id;
  const incoming = await http('GET', '/contacts/invitations/incoming', { token: tokenB });
  const acc = (incoming.json?.data || []).find((i) => i.id === invId) || (incoming.json?.data || [])[0];
  if (acc) await http('POST', `/contacts/invitations/${acc.id}/accept`, { token: tokenB, body: { myRole: 'Друг', theirRole: 'Друг' } });
}

let passed = 0, failed = 0;
const check = (n, c) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}`); } };

async function main() {
  const t1 = await login(CREDS.t1);
  const t2 = await login(CREDS.t2);
  const t3 = await login(CREDS.t3);
  console.log('logged in 3 testers');
  await ensureContact(t1.token, t2.token, CREDS.t2.phone);
  await ensureContact(t1.token, t3.token, CREDS.t3.phone);

  console.log('\n-- create group --');
  let r = await http('POST', '/messenger/chats/group', { token: t1.token, body: { name: 'Тест Группа', memberIds: [t2.id] } });
  check('createGroup ok', r.status === 200 || r.status === 201);
  const gid = r.json?.data?.id;
  check('group has id', !!gid);
  check('type=group', r.json?.data?.type === 'group');
  check('title set', r.json?.data?.title === 'Тест Группа');
  check('creator is owner', r.json?.data?.myRole === 'owner');
  check('createdById = t1', r.json?.data?.createdById === t1.id);
  check('2 participants (t1+t2)', (r.json?.data?.participants || []).length === 2);

  console.log('\n-- post + members see it --');
  r = await http('POST', `/messenger/chats/${gid}/messages`, { token: t1.token, body: { content: 'Привет, группа!' } });
  check('owner can post', r.status === 200 || r.status === 201);
  r = await http('GET', `/messenger/chats/${gid}/messages`, { token: t2.token });
  check('t2 can read group (member)', r.status === 200);
  check('t2 sees the message', (r.json?.data || []).some((m) => m.content === 'Привет, группа!'));
  r = await http('POST', `/messenger/chats/${gid}/messages`, { token: t2.token, body: { content: 'И тебе привет!' } });
  check('member can post', r.status === 200 || r.status === 201);

  console.log('\n-- outsider (t3) has no access --');
  r = await http('GET', `/messenger/chats/${gid}`, { token: t3.token });
  check('t3 cannot view group (403)', r.status === 403);
  r = await http('POST', `/messenger/chats/${gid}/messages`, { token: t3.token, body: { content: 'врываюсь' } });
  check('t3 cannot post (403)', r.status === 403);

  console.log('\n-- add member sees FULL history (Bitrix/Slack-style) --');
  r = await http('POST', `/messenger/chats/${gid}/members`, { token: t1.token, body: { userIds: [t3.id] } });
  check('owner adds t3', r.status === 200 || r.status === 201);
  r = await http('POST', `/messenger/chats/${gid}/messages`, { token: t1.token, body: { content: 'после добавления t3' } });
  r = await http('GET', `/messenger/chats/${gid}/messages`, { token: t3.token });
  const t3msgs = r.json?.data || [];
  check('t3 now has access', r.status === 200);
  check('t3 DOES see pre-join "Привет, группа!" (full history)', t3msgs.some((m) => m.content === 'Привет, группа!'));
  check('t3 DOES see post-join message', t3msgs.some((m) => m.content === 'после добавления t3'));

  console.log('\n-- admin management --');
  r = await http('POST', `/messenger/chats/${gid}/admins/${t2.id}`, { token: t1.token, body: { admin: true } });
  check('owner promotes t2 to admin', r.status === 200 || r.status === 201);
  r = await http('POST', `/messenger/chats/${gid}/members`, { token: t2.token, body: { userIds: [] } });
  check('admin passes manage gate (400 empty list, not 403)', r.status === 400);
  r = await http('PATCH', `/messenger/chats/${gid}`, { token: t3.token, body: { title: 'Хакнуто' } });
  check('plain member cannot rename (403)', r.status === 403);
  r = await http('PATCH', `/messenger/chats/${gid}`, { token: t1.token, body: { title: 'Наша Группа' } });
  check('owner renames ok', (r.status === 200 || r.status === 201) && r.json?.data?.title === 'Наша Группа');

  console.log('\n-- remove member = hard revoke --');
  r = await http('DELETE', `/messenger/chats/${gid}/members/${t3.id}`, { token: t1.token });
  check('owner removes t3', r.status === 200 || r.status === 201);
  r = await http('GET', `/messenger/chats/${gid}`, { token: t3.token });
  check('removed t3 loses access (403)', r.status === 403);

  console.log('\n-- leave --');
  r = await http('POST', `/messenger/chats/${gid}/leave`, { token: t2.token });
  check('admin t2 can leave', r.status === 200 || r.status === 201);
  r = await http('GET', `/messenger/chats/${gid}`, { token: t2.token });
  check('left t2 loses access (403)', r.status === 403);
  r = await http('POST', `/messenger/chats/${gid}/leave`, { token: t1.token });
  check('owner cannot leave (400)', r.status === 400);

  console.log('\n-- system messages present, not counted as unread --');
  r = await http('GET', `/messenger/chats/${gid}/messages`, { token: t1.token });
  const sys = (r.json?.data || []).filter((m) => m.type === 'system');
  check('has system messages (>=3: created/added/renamed/removed)', sys.length >= 3);
  r = await http('GET', '/messenger/chats', { token: t1.token });
  const g = (r.json?.data || []).find((c) => c.id === gid);
  check('owner group unread=0 (system not counted)', g?.unreadCount === 0);
  check('group shows memberCount', typeof g?.memberCount === 'number');

  console.log('\n-- delete group --');
  r = await http('DELETE', `/messenger/chats/${gid}`, { token: t1.token });
  check('owner deletes group', r.status === 200 || r.status === 201);
  r = await http('GET', `/messenger/chats/${gid}`, { token: t1.token });
  check('group gone (403/404)', r.status === 403 || r.status === 404);

  console.log(`\nRESULT ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
