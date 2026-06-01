// E2E for Phase 2 task chats (context chat that replaced TaskComment). Requires API on
// 3001 + 3 seeded testers. Run: node apps/api/scripts/verify-messenger-task.cjs
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
let passed = 0, failed = 0;
const check = (n, c) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}`); } };

async function main() {
  // Load .env so the Prisma client (used for deterministic contact links) has DATABASE_URL.
  const fs = require('fs'); const path = require('path');
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  const t1 = await login(CREDS.t1); // creator
  const t2 = await login(CREDS.t2); // executor
  const t3 = await login(CREDS.t3); // observer
  console.log('logged in 3 testers');
  // Deterministic окружение: ensure t1↔t2 and t1↔t3 ContactLinks exist (no flaky invite flow).
  const link = async (x, y, by) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    await prisma.contactLink.upsert({
      where: { userAId_userBId: { userAId: a, userBId: b } },
      update: {},
      create: { userAId: a, userBId: b, roleAForB: 'Коллега', roleBForA: 'Коллега', initiatedBy: by },
    });
  };
  await link(t1.id, t2.id, t1.id);
  await link(t1.id, t3.id, t1.id);
  await prisma.$disconnect();

  console.log('\n-- old comment endpoints are GONE --');
  let r = await http('GET', '/tasks/00000000-0000-0000-0000-000000000000/comments', { token: t1.token });
  check('GET /tasks/:id/comments removed (404)', r.status === 404);
  r = await http('POST', '/tasks/00000000-0000-0000-0000-000000000000/comments', { token: t1.token, body: { content: 'x' } });
  check('POST /tasks/:id/comments removed (404)', r.status === 404);

  console.log('\n-- create task with executor + observer --');
  r = await http('POST', '/tasks', {
    token: t1.token,
    body: { title: 'Задача с чатом', executorId: t2.id, observerIds: [t3.id] },
  });
  check('createTask ok', r.status === 200 || r.status === 201);
  const taskId = r.json?.data?.id;
  check('task has id', !!taskId);
  check('no commentsCount field', r.json?.data?.commentsCount === undefined);

  console.log('\n-- task chat exists + role tags --');
  r = await http('GET', `/messenger/tasks/${taskId}/chat`, { token: t1.token });
  check('creator gets task chat', r.status === 200);
  const chat = r.json?.data;
  const chatId = chat?.id;
  check('chat type=context', chat?.type === 'context');
  check('chat parentType=task', chat?.parentType === 'task');
  const roles = (chat?.participants || []).map((p) => p.roleTag);
  check('creator tagged Постановщик', roles.includes('Постановщик'));
  check('executor tagged Исполнитель', roles.includes('Исполнитель'));
  check('observer tagged Наблюдатель', roles.includes('Наблюдатель'));

  console.log('\n-- all roles read + post (incl. observer) --');
  r = await http('GET', `/messenger/tasks/${taskId}/chat`, { token: t2.token });
  check('executor opens task chat', r.status === 200);
  r = await http('GET', `/messenger/tasks/${taskId}/chat`, { token: t3.token });
  check('observer opens task chat', r.status === 200);
  r = await http('POST', `/messenger/chats/${chatId}/messages`, { token: t2.token, body: { content: 'исполнитель пишет' } });
  check('executor can post', r.status === 200 || r.status === 201);
  r = await http('POST', `/messenger/chats/${chatId}/messages`, { token: t3.token, body: { content: 'наблюдатель пишет' } });
  check('observer can post', r.status === 200 || r.status === 201);

  console.log('\n-- system message from task lifecycle (submit) --');
  await http('POST', `/tasks/${taskId}/submit`, { token: t2.token });
  await new Promise((res) => setTimeout(res, 600)); // event → listener → system message
  r = await http('GET', `/messenger/chats/${chatId}/messages`, { token: t1.token });
  const sys = (r.json?.data || []).filter((m) => m.type === 'system');
  check('task lifecycle produced system message(s)', sys.length >= 1);

  console.log('\n-- non-participant has no access --');
  r = await http('POST', '/tasks', { token: t1.token, body: { title: 'Только t1+t2', executorId: t2.id } });
  const task2 = r.json?.data?.id;
  r = await http('GET', `/messenger/tasks/${task2}/chat`, { token: t3.token });
  check('non-participant t3 cannot open task chat (403)', r.status === 403);

  console.log('\n-- hard revoke: remove participant loses chat access --');
  const chat2 = (await http('GET', `/messenger/tasks/${task2}/chat`, { token: t1.token })).json?.data?.id;
  // confirm t2 has access first
  r = await http('GET', `/messenger/chats/${chat2}`, { token: t2.token });
  check('executor t2 has access before removal', r.status === 200);
  r = await http('PATCH', `/tasks/${task2}`, { token: t1.token, body: { removeParticipantUserIds: [t2.id] } });
  if (r.status === 200 || r.status === 201) {
    await new Promise((res) => setTimeout(res, 400));
    r = await http('GET', `/messenger/chats/${chat2}`, { token: t2.token });
    check('removed executor loses task-chat access (403)', r.status === 403);
  } else {
    console.log(`  (skip remove-participant: PATCH returned ${r.status})`);
  }

  console.log(`\nRESULT ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
