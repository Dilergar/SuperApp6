/* eslint-disable */
// Phase 1 e2e: the double-entry ledger invariants on the real flow. Drives the Tasks API to fund a
// MULTI-leg escrow (one task → two workers → two holds under one agreement), captures both, and at
// every step asserts the banking-grade invariants via Prisma:
//   • per-currency Σ(all account balances) = 0   (double-entry conservation; issuance is the counterweight)
//   • no user wallet ever goes negative
//   • held = Σ active-hold amounts on the payer
// Run (API up): node scripts/verify-ledger-invariants.cjs
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
const check = (name, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
async function login(phone) { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; }
async function ownBal(token) { const r = await call('GET', '/wallet', token); return (r.json.data || []).find((x) => x.isOwn) || { balance: 0, held: 0, available: 0 }; }
async function balOf(token, currencyId) { const r = await call('GET', '/wallet', token); const e = (r.json.data || []).find((x) => x.currencyId === currencyId); return e ? e.balance : 0; }

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const u1 = await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } });
  const u2 = await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } });
  const u3 = await prisma.user.findUnique({ where: { phone: P3 }, select: { id: true } });
  // Ensure t1↔t2 and t1↔t3 are contacts (canonical userA < userB).
  for (const other of [u2.id, u3.id]) {
    const [a, b] = u1.id < other ? [u1.id, other] : [other, u1.id];
    await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1.id } });
  }

  const sumAccounts = async (currencyId) => {
    const r = await prisma.account.aggregate({ where: { currencyId }, _sum: { balance: true } });
    return r._sum.balance ?? 0n;
  };
  const minUserBalance = async (currencyId) => {
    const rows = await prisma.account.findMany({ where: { currencyId, type: 'user' }, select: { balance: true } });
    return rows.reduce((m, r) => (r.balance < m ? r.balance : m), 0n);
  };
  const heldOf = async (currencyId, userId) => {
    const a = await prisma.account.findUnique({ where: { currencyId_type_ownerType_ownerId: { currencyId, type: 'user', ownerType: 'user', ownerId: userId } }, select: { held: true } });
    return a ? a.held : 0n;
  };

  const tasks = [];
  let curId;
  try {
    await call('DELETE', '/wallet/currency', t1);
    const cur = await call('POST', '/wallet/currency', t1, { name: 'РеестрКоин', icon: '📒' });
    curId = cur.json.data.id;
    await call('POST', '/wallet/currency/mint', t1, { amount: 1000 });
    check('invariant после эмиссии: Σ счетов = 0', (await sumAccounts(curId)) === 0n, `Σ=${await sumAccounts(curId)}`);

    // Task to TWO workers → two holds (200 frozen) under one agreement.
    const t = await call('POST', '/tasks', t1, { title: 'На двоих', executorId: u2.id, coExecutorIds: [u3.id], coinReward: 100 });
    check('создание задачи на двоих', t.ok, `status ${t.status}`);
    tasks.push(t.json.data.id);
    let o = await ownBal(t1);
    check('заморожено 200 (2×100), доступно 800', o.held === 200 && o.available === 800, JSON.stringify({ held: o.held, available: o.available }));
    check('held в БД = 200', (await heldOf(curId, u1.id)) === 200n);
    check('invariant с активными холдами: Σ = 0', (await sumAccounts(curId)) === 0n, `Σ=${await sumAccounts(curId)}`);

    // Both submit, creator accepts both → both paid.
    await call('POST', `/tasks/${t.json.data.id}/submit`, t2);
    await call('POST', `/tasks/${t.json.data.id}/submit`, t3);
    await call('POST', `/tasks/${t.json.data.id}/accept`, t1, { participantUserId: u2.id });
    await call('POST', `/tasks/${t.json.data.id}/accept`, t1, { participantUserId: u3.id });
    check('t2 получил 100', (await balOf(t2, curId)) === 100);
    check('t3 получил 100', (await balOf(t3, curId)) === 100);
    o = await ownBal(t1);
    check('у создателя 800, заморожено 0', o.balance === 800 && o.held === 0, JSON.stringify({ balance: o.balance, held: o.held }));
    check('invariant после выплат: Σ = 0', (await sumAccounts(curId)) === 0n, `Σ=${await sumAccounts(curId)}`);
    check('нет отрицательных пользовательских балансов', (await minUserBalance(curId)) >= 0n, `min=${await minUserBalance(curId)}`);
  } finally {
    for (const id of tasks) await call('DELETE', `/tasks/${id}`, t1).catch(() => {});
    await call('DELETE', '/wallet/currency', t1).catch(() => {});
    if (curId) {
      check('после удаления валюты: Σ = 0', (await sumAccounts(curId)) === 0n, `Σ=${await sumAccounts(curId)}`);
      const rows = await prisma.account.findMany({ where: { currencyId: curId, type: 'user' }, select: { balance: true } });
      check('после удаления: все кошельки обнулены', rows.every((r) => r.balance === 0n));
    }
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ ИНВАРИАНТЫ РЕЕСТРА ПРОЙДЕНЫ' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
