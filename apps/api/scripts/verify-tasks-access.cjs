/* eslint-disable */
// Phase 3 e2e: task action gates decided by the unified access engine. A task's view/comment gate
// (assertCanView) now runs through access.can('task.view') over projected role tuples (creator +
// participants), with a domain fallback. Asserts a participant can read/comment, an outsider gets 403.
// Run (API up): node scripts/verify-tasks-access.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', P3 = '+77023456789', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const u3 = (await prisma.user.findUnique({ where: { phone: P3 }, select: { id: true } })).id;
  const [a, b] = u1 < u2 ? [u1, u2] : [u2, u1];
  await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 } });

  let taskId;
  try {
    // t1 creates a task with t2 as executor → roles projected (creator t1, executor t2).
    const c = await call('POST', '/tasks', t1, { title: 'Тест доступа задачи', executorId: u2 });
    check('создание задачи (исполнитель t2)', c.ok, `status ${c.status}`);
    taskId = c.json.data.id;

    // Gate (engine task.view → chat.view): creator + participant can read the task chat (messenger
    // contextual chat — TaskComment was removed); outsider 403.
    const c1 = await call('GET', `/messenger/tasks/${taskId}/chat`, t1);
    check('t1 (постановщик) читает чат задачи', c1.ok, `status ${c1.status}`);
    const chatId = c1.json && c1.json.data && c1.json.data.id;
    const c2 = await call('GET', `/messenger/tasks/${taskId}/chat`, t2);
    check('t2 (исполнитель) читает чат задачи', c2.ok, `status ${c2.status}`);
    const post2 = await call('POST', `/messenger/chats/${chatId}/messages`, t2, { content: 'Беру в работу' });
    check('t2 (исполнитель) может комментировать', post2.ok, `status ${post2.status}`);

    const c3 = await call('GET', `/messenger/tasks/${taskId}/chat`, t3);
    check('t3 (посторонний) НЕ имеет доступа к чату (403)', c3.status === 403, `status ${c3.status}`);
    const post3 = await call('POST', `/messenger/chats/${chatId}/messages`, t3, { content: 'я кто?' });
    check('t3 (посторонний) НЕ может комментировать (403)', post3.status === 403, `status ${post3.status}`);
  } finally {
    if (taskId) await call('DELETE', `/tasks/${taskId}`, t1).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ TASKS ACCESS E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
