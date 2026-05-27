/* eslint-disable */
// Phase 4a: earn-notification + burn over real HTTP. Run: `node scripts/verify-burn.cjs`
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', PW = 'Test1234!';
let fails = 0;
const check = (n, ok, x) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${x ? `  (${x})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => (await call('POST', '/auth/login', null, { phone, password: PW })).json.data.accessToken;
const balOf = async (token, cid) => { const r = await call('GET', '/wallet', token); const e = (r.json.data || []).find((x) => x.currencyId === cid); return e ? e.balance : 0; };

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);
  const u1 = await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } });
  const u2 = await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } });
  const [a, b] = u1.id < u2.id ? [u1.id, u2.id] : [u2.id, u1.id];
  await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1.id } });

  let taskId, curId;
  try {
    await call('DELETE', '/wallet/currency', t1);
    curId = (await call('POST', '/wallet/currency', t1, { name: 'БёрнКоин', icon: '🔥' })).json.data.id;
    await call('POST', '/wallet/currency/mint', t1, { amount: 500 });
    const t = await call('POST', '/tasks', t1, { title: 'За монеты', executorId: u2.id, coinReward: 100 });
    taskId = t.json.data.id;
    await call('POST', `/tasks/${taskId}/submit`, t2);
    await call('POST', `/tasks/${taskId}/accept`, t1);
    check('исполнитель получил 100', (await balOf(t2, curId)) === 100, `t2=${await balOf(t2, curId)}`);

    const notif = await call('GET', '/notifications', t2);
    check('уведомление «вы заработали» создано', JSON.stringify(notif.json).includes('wallet.coins.received'));

    const burn = await call('POST', '/wallet/burn', t2, { currencyId: curId, amount: 40 });
    check('сжигание 40 прошло', burn.ok, `status ${burn.status}`);
    check('баланс после сжигания = 60', (await balOf(t2, curId)) === 60, `t2=${await balOf(t2, curId)}`);

    const burnOwn = await call('POST', '/wallet/burn', t1, { currencyId: curId, amount: 10 });
    check('сжечь свою валюту запрещено (400)', burnOwn.status === 400, `status ${burnOwn.status}`);
  } finally {
    if (taskId) await call('DELETE', `/tasks/${taskId}`, t1).catch(() => {});
    await call('DELETE', '/wallet/currency', t1).catch(() => {});
    await prisma.$disconnect();
  }
  console.log(`\n${fails === 0 ? '✅ BURN + NOTIF ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
