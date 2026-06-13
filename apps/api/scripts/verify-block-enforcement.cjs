/* eslint-disable */
// Arch-review block 6: ContactBlock must be enforced by EVERY "between people" action,
// not only the messenger. t1 blocks t3 → t3 can no longer assign t1 a task, invite t1
// to an event, or DM t1 (and vice versa); unblock restores everything.
// Run (API up + seeded testers): node scripts/verify-block-enforcement.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P3 = '+77023456789', PW = 'Test1234!';

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
  const t1 = await login(P1), t3 = await login(P3);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u3 = (await prisma.user.findUnique({ where: { phone: P3 }, select: { id: true } })).id;
  const [a, b] = u1 < u3 ? [u1, u3] : [u3, u1];
  await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 } });
  // Clean slate: no pre-existing blocks between the pair.
  await prisma.contactBlock.deleteMany({ where: { OR: [{ blockerId: u1, blockedId: u3 }, { blockerId: u3, blockedId: u1 }] } });

  const cleanup = { taskIds: [], eventIds: [] };
  try {
    // Baseline (no block): everything works.
    const task0 = await call('POST', '/tasks', t3, { title: 'block-test-baseline', executorId: u1 });
    check('без блока: t3 ставит задачу t1', task0.ok, `status ${task0.status}`);
    if (task0.ok) cleanup.taskIds.push(task0.json.data.id);

    // t1 blocks t3.
    const blk = await call('POST', '/contacts/blocks', t1, { userId: u3 });
    check('t1 заблокировал t3', blk.ok, `status ${blk.status}`);

    // Blocked: tasks / calendar / DM are all refused — in BOTH directions.
    const task1 = await call('POST', '/tasks', t3, { title: 'block-test-task', executorId: u1 });
    check('блок: t3 НЕ может поставить задачу t1 (403)', task1.status === 403, `status ${task1.status}`);
    if (task1.ok) cleanup.taskIds.push(task1.json.data.id);

    const task2 = await call('POST', '/tasks', t1, { title: 'block-test-task-rev', executorId: u3 });
    check('блок: t1 тоже НЕ может поставить задачу t3 (403)', task2.status === 403, `status ${task2.status}`);
    if (task2.ok) cleanup.taskIds.push(task2.json.data.id);

    const start = new Date(Date.now() + 3600_000).toISOString();
    const end = new Date(Date.now() + 7200_000).toISOString();
    const ev = await call('POST', '/calendar/events', t3, { title: 'block-test-event', startTime: start, endTime: end, participantUserIds: [u1] });
    check('блок: t3 НЕ может позвать t1 в событие (403)', ev.status === 403, `status ${ev.status}`);
    if (ev.ok) cleanup.eventIds.push(ev.json.data.id);

    const dm = await call('POST', '/messenger/chats/dm', t3, { userId: u1 });
    check('блок: t3 НЕ может открыть DM с t1 (403)', dm.status === 403, `status ${dm.status}`);

    // Unblock. NB: blocking REMOVES the ContactLink (product rule), so after unblock the
    // pair must re-connect — restore the link directly to assert the gate opens again.
    const unblk = await call('DELETE', `/contacts/blocks/${u3}`, t1);
    check('t1 разблокировал t3', unblk.ok, `status ${unblk.status}`);
    await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 } });

    const task3 = await call('POST', '/tasks', t3, { title: 'block-test-after', executorId: u1 });
    check('после разблокировки + повторной связи: задача снова ставится', task3.ok, `status ${task3.status}`);
    if (task3.ok) cleanup.taskIds.push(task3.json.data.id);
  } finally {
    for (const id of cleanup.taskIds) await call('DELETE', `/tasks/${id}`, t3).catch(() => {});
    for (const id of cleanup.eventIds) await call('DELETE', `/calendar/events/${id}`, t3).catch(() => {});
    await prisma.contactBlock.deleteMany({ where: { OR: [{ blockerId: u1, blockedId: u3 }, { blockerId: u3, blockedId: u1 }] } });
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ BLOCK ENFORCEMENT E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
