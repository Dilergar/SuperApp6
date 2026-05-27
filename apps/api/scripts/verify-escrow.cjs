/* eslint-disable */
// Phase 3 e2e: the full task-reward escrow over real HTTP between two users.
// Ensures tester1↔tester2 are contacts (direct Prisma), then drives the Tasks API and
// asserts wallet balances at each step. Run: `node scripts/verify-escrow.cjs`
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');

const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567';
const P2 = '+77012345678';
const PW = 'Test1234!';

let fails = 0;
function check(name, ok, extra) {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!ok) fails++;
}
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
async function login(phone) {
  const r = await call('POST', '/auth/login', null, { phone, password: PW });
  if (!r.ok) throw new Error(`login ${phone} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data.accessToken;
}
async function ownBal(token) {
  const r = await call('GET', '/wallet', token);
  const e = (r.json.data || []).find((x) => x.isOwn);
  return e || { balance: 0, held: 0, available: 0 };
}
async function balOf(token, currencyId) {
  const r = await call('GET', '/wallet', token);
  const e = (r.json.data || []).find((x) => x.currencyId === currencyId);
  return e ? e.balance : 0;
}

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1);
  const t2 = await login(P2);
  const u1 = await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } });
  const u2 = await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } });

  // Ensure the two are contacts (canonical userA < userB).
  const [a, b] = u1.id < u2.id ? [u1.id, u2.id] : [u2.id, u1.id];
  await prisma.contactLink.upsert({
    where: { userAId_userBId: { userAId: a, userBId: b } },
    update: {},
    create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1.id },
  });

  const tasks = [];
  try {
    await call('DELETE', '/wallet/currency', t1); // clean slate
    const cur = await call('POST', '/wallet/currency', t1, { name: 'ЭскроуКоин', icon: '🎯' });
    const curId = cur.json.data.id;
    await call('POST', '/wallet/currency/mint', t1, { amount: 1000 });
    check('mint 1000 эмитенту', (await ownBal(t1)).balance === 1000);

    // 1) Create rewarded task → coins frozen
    const t = await call('POST', '/tasks', t1, { title: 'Эскроу-задача', executorId: u2.id, coinReward: 100 });
    check('создание задачи с наградой', t.ok, `status ${t.status}`);
    const taskId = t.json.data.id; tasks.push(taskId);
    let o = await ownBal(t1);
    check('после создания: заморожено 100, доступно 900', o.held === 100 && o.available === 900, JSON.stringify(o));

    // 2) Submit + accept → payout
    await call('POST', `/tasks/${taskId}/submit`, t2);
    const acc = await call('POST', `/tasks/${taskId}/accept`, t1);
    check('приёмка прошла', acc.ok, `status ${acc.status}`);
    o = await ownBal(t1);
    check('после приёмки: баланс 900, заморожено 0', o.balance === 900 && o.held === 0, JSON.stringify(o));
    check('исполнитель получил 100', (await balOf(t2, curId)) === 100, `t2=${await balOf(t2, curId)}`);

    // 3) Return after acceptance → reverse + re-freeze
    const ret = await call('POST', `/tasks/${taskId}/return`, t1);
    check('возврат после приёмки прошёл', ret.ok, `status ${ret.status}`);
    o = await ownBal(t1);
    check('после возврата: баланс 1000, заморожено 100', o.balance === 1000 && o.held === 100, JSON.stringify(o));
    check('у исполнителя списали обратно → 0', (await balOf(t2, curId)) === 0, `t2=${await balOf(t2, curId)}`);

    // 4) Insufficient funds → task creation rejected
    const poor = await call('POST', '/tasks', t1, { title: 'Слишком дорого', executorId: u2.id, coinReward: 100000 });
    check('задача без покрытия отклонена (400)', poor.status === 400, `status ${poor.status}`);

    // 5) Cancel → refund the freeze
    const t3 = await call('POST', '/tasks', t1, { title: 'На отмену', executorId: u2.id, coinReward: 50 });
    const t3Id = t3.json.data.id; tasks.push(t3Id);
    o = await ownBal(t1);
    check('второй hold: заморожено 150, доступно 850', o.held === 150 && o.available === 850, JSON.stringify(o));
    await call('PATCH', `/tasks/${t3Id}`, t1, { status: 'cancelled' });
    o = await ownBal(t1);
    check('после отмены: заморожено снова 100, доступно 900', o.held === 100 && o.available === 900, JSON.stringify(o));
  } finally {
    for (const id of tasks) await call('DELETE', `/tasks/${id}`, t1).catch(() => {});
    await call('DELETE', '/wallet/currency', t1).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ ЭСКРОУ E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
