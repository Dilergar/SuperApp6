/* eslint-disable */
// B2B reachability — «рабочий пропуск» (Circle review 2026-06-11, finding 4).
// In a workspace context (X-Workspace-Id) the unified gate assertReachable switches from
// "personal Окружение + blocks" to "co-membership in the active workspace":
//   - boss can assign tasks / invite to events / open DM with an employee who is NOT
//     in their personal Окружение (Slack/Bitrix24 model);
//   - personal blocks do NOT gate work artifacts (tasks/events), but DM respects them
//     even at work (hybrid decision);
//   - workspace context requires MEMBERSHIP: even a personal contact who is not an
//     employee is unreachable there;
//   - personal context (no header) is untouched: no link → 403.
// Run (API up + seeded testers): node scripts/verify-b2b-reachability.cjs
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
async function call(method, p, token, body, headers) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const uid = async (p) => (await prisma.user.findUnique({ where: { phone: p }, select: { id: true } })).id;
  const u1 = await uid(P1), u2 = await uid(P2), u3 = await uid(P3);
  const [a, b] = u1 < u2 ? [u1, u2] : [u2, u1];

  const restoreLink = () => prisma.contactLink.upsert({
    where: { userAId_userBId: { userAId: a, userBId: b } },
    update: {},
    create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 },
  });
  // Make sure tester3 IS a personal contact of tester1 (to prove that the work pass
  // still requires MEMBERSHIP, not personal links).
  const [a13, b13] = u1 < u3 ? [u1, u3] : [u3, u1];
  await prisma.contactLink.upsert({
    where: { userAId_userBId: { userAId: a13, userBId: b13 } },
    update: {},
    create: { userAId: a13, userBId: b13, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 },
  });

  // Clean slate: t2 NOT in t1's personal Окружение, no blocks between them.
  await prisma.contactBlock.deleteMany({ where: { OR: [{ blockerId: u1, blockedId: u2 }, { blockerId: u2, blockedId: u1 }] } });
  await prisma.contactLink.deleteMany({ where: { userAId: a, userBId: b } });

  const cleanup = { wsId: null, taskIds: [], eventId: null };
  try {
    // ===== Fixture: org with t1 = owner, t2 = employee =====
    const ws = await call('POST', '/workspaces', t1, { name: 'b2b-reach-e2e' });
    check('организация создана', ws.ok, `status ${ws.status}`);
    const wsId = ws.json.data.id; cleanup.wsId = wsId;
    const WS = { 'X-Workspace-Id': wsId };

    const inv = await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: P2 });
    check('сотрудник приглашён', inv.ok, `status ${inv.status}`);
    const myInvs = await call('GET', '/workspaces/invitations/incoming', t2);
    const wsInv = (myInvs.json?.data ?? []).find((i) => i.workspaceId === wsId || i.workspace?.id === wsId);
    check('приглашение видно сотруднику', !!wsInv);
    const acc = await call('POST', `/workspaces/invitations/${wsInv?.id}/accept`, t2);
    check('сотрудник принял (членство есть, личной связи НЕТ)', acc.ok, `status ${acc.status}`);

    // ===== Personal context untouched =====
    const persTask = await call('POST', '/tasks', t1, { title: 'b2b-e2e личная', executorId: u2 });
    check('без контекста орг.: задача не-контакту → 403', persTask.status === 403, `status ${persTask.status}`);

    // ===== Work pass: tasks =====
    const wsTask = await call('POST', '/tasks', t1, { title: 'b2b-e2e задача', executorId: u2 }, WS);
    check('в контексте орг.: задача сотруднику-не-контакту → ок', wsTask.ok, `status ${wsTask.status}: ${wsTask.json?.message}`);
    if (wsTask.ok) cleanup.taskIds.push(wsTask.json.data.id);

    // ===== Work pass: calendar invite =====
    const start = new Date(Date.now() + 3600_000).toISOString();
    const end = new Date(Date.now() + 7200_000).toISOString();
    const ev = await call('POST', '/calendar/events', t1, { title: 'b2b-e2e встреча', startTime: start, endTime: end, participantUserIds: [u2] }, WS);
    check('в контексте орг.: встреча с сотрудником → ок', ev.ok, `status ${ev.status}: ${ev.json?.message}`);
    cleanup.eventId = ev.ok ? ev.json.data.id : null;

    // ===== Work pass: DM =====
    const dm = await call('POST', '/messenger/chats/dm', t1, { userId: u2 }, WS);
    check('в контексте орг.: DM сотруднику → ок', dm.ok, `status ${dm.status}: ${dm.json?.message}`);

    // ===== Membership required: personal contact ≠ employee =====
    const outsider = await call('POST', '/tasks', t1, { title: 'b2b-e2e чужой', executorId: u3 }, WS);
    check('в контексте орг.: личный контакт НЕ сотрудник → 403', outsider.status === 403, `status ${outsider.status}`);

    // ===== Hybrid blocks: work artifacts ignore, DM respects =====
    const blk = await call('POST', '/contacts/blocks', t2, { userId: u1 });
    check('сотрудник заблокировал владельца (лично)', blk.ok, `status ${blk.status}`);

    const taskBlocked = await call('POST', '/tasks', t1, { title: 'b2b-e2e после блока', executorId: u2 }, WS);
    check('блок НЕ мешает рабочей задаче', taskBlocked.ok, `status ${taskBlocked.status}: ${taskBlocked.json?.message}`);
    if (taskBlocked.ok) cleanup.taskIds.push(taskBlocked.json.data.id);

    const dmBlocked = await call('POST', '/messenger/chats/dm', t1, { userId: u2 }, WS);
    check('но DM при блоке → 403 даже на работе', dmBlocked.status === 403, `status ${dmBlocked.status}`);

    const unb = await call('DELETE', `/contacts/blocks/${u1}`, t2);
    check('разблокировка', unb.ok, `status ${unb.status}`);
  } finally {
    for (const id of cleanup.taskIds) await call('DELETE', `/tasks/${id}`, t1, null, { 'X-Workspace-Id': cleanup.wsId }).catch(() => {});
    if (cleanup.eventId) await call('DELETE', `/calendar/events/${cleanup.eventId}`, t1).catch(() => {});
    if (cleanup.wsId) await call('DELETE', `/workspaces/${cleanup.wsId}`, t1).catch(() => {});
    await prisma.contactBlock.deleteMany({ where: { OR: [{ blockerId: u1, blockedId: u2 }, { blockerId: u2, blockedId: u1 }] } }).catch(() => {});
    await restoreLink().catch(() => {}); // testers stay linked for other scripts
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ B2B REACHABILITY (РАБОЧИЙ ПРОПУСК) ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
