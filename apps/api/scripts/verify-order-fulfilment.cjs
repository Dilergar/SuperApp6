/* eslint-disable */
// Phase 4 e2e: «с задачей» fulfilment. Material «с задачей» → confirm creates a Task (no capture);
// owner delivers (submit) + buyer accepts → order settles (capture). Owner refund of an in-fulfilment
// order. Non-material «с задачей» → capture on confirm + a calendar event. The task.completed →
// order-capture hop is async (EventBus), so we poll. Run (API up): node scripts/verify-order-fulfilment.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', PW = 'Test1234!';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); return r.json.data.accessToken; };
async function entry(token, currencyId) {
  const r = await call('GET', '/wallet', token);
  return (r.json.data || []).find((x) => x.currencyId === currencyId) || { balance: 0, held: 0 };
}

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const [a, b] = u1 < u2 ? [u1, u2] : [u2, u1];
  await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 } });

  const tasks = [], showcases = [];
  let curId, scId;
  try {
    await call('DELETE', '/wallet/currency', t1);
    curId = (await call('POST', '/wallet/currency', t1, { name: 'ФулфилКоин', icon: '🛠️' })).json.data.id;
    await call('POST', '/wallet/currency/mint', t1, { amount: 1000 });
    // Fund buyer with 500 via a rewarded task.
    const ft = await call('POST', '/tasks', t1, { title: 'Аванс', executorId: u2, coinReward: 500 });
    tasks.push(ft.json.data.id);
    await call('POST', `/tasks/${ft.json.data.id}/submit`, t2);
    await call('POST', `/tasks/${ft.json.data.id}/accept`, t1);
    check('покупатель профинансирован (500)', (await entry(t2, curId)).balance === 500);

    scId = (await call('POST', '/shop/showcases', t1, { name: 'Витрина' })).json.data.id;
    showcases.push(scId);
    await call('POST', `/shop/showcases/${scId}/shares`, t1, { principalType: 'user', principalId: u2 });

    // ---- Material «с задачей»: confirm creates a task; capture only on buyer acceptance ----
    const scooter = (await call('POST', '/shop/listings', t1, { showcaseId: scId, title: 'Самокат', priceAmount: 100, itemType: 'material', withTask: true, taskDays: 2 })).json.data;
    const buy1 = await call('POST', `/shop/listings/${scooter.id}/buy`, t2);
    check('материальное «с задачей» теперь покупается', buy1.ok, `status ${buy1.status}`);
    const oid1 = buy1.json.data.id;
    const conf1 = await call('POST', `/shop/orders/${oid1}/confirm`, t1);
    check('подтверждение → заказ «в работе» (не списан)', conf1.ok && conf1.json.data.status === 'confirmed', `status ${conf1.json?.data?.status}`);
    const o1 = await prisma.order.findUnique({ where: { id: oid1 }, select: { taskId: true } });
    check('создана задача на выдачу', !!o1.taskId);
    check('после подтверждения деньги ещё заморожены у покупателя', (await entry(t2, curId)).held === 100, JSON.stringify(await entry(t2, curId)));
    // Owner delivers (submit), buyer accepts (Постановщик) → task.completed → order capture (async).
    await call('POST', `/tasks/${o1.taskId}/submit`, t1);
    await call('POST', `/tasks/${o1.taskId}/accept`, t2);
    let settled = false;
    for (let i = 0; i < 20; i++) {
      const o = await prisma.order.findUnique({ where: { id: oid1 }, select: { status: true } });
      if (o.status === 'settled') { settled = true; break; }
      await sleep(500);
    }
    check('после приёмки покупателем заказ списан (settled)', settled);
    check('у покупателя списано 100 (баланс 400, заморозки нет)', (await entry(t2, curId)).balance === 400 && (await entry(t2, curId)).held === 0, JSON.stringify(await entry(t2, curId)));
    // t1: minted 1000 − 500 advance + 100 scooter = 600
    check('продавец получил 100 (баланс 600)', (await entry(t1, curId)).balance === 600, JSON.stringify(await entry(t1, curId)));

    // ---- Owner refund of an in-fulfilment order ----
    const rollers = (await call('POST', '/shop/listings', t1, { showcaseId: scId, title: 'Ролики', priceAmount: 50, itemType: 'material', withTask: true, taskDays: 2 })).json.data;
    const buy2 = await call('POST', `/shop/listings/${rollers.id}/buy`, t2);
    await call('POST', `/shop/orders/${buy2.json.data.id}/confirm`, t1);
    check('перед возвратом заморожено 50', (await entry(t2, curId)).held === 50);
    const refund = await call('POST', `/shop/orders/${buy2.json.data.id}/refund`, t1);
    check('владелец вернул заказ', refund.ok && refund.json.data.status === 'refunded', `status ${refund.json?.data?.status}`);
    check('после возврата: заморозка 0, баланс 400', (await entry(t2, curId)).held === 0 && (await entry(t2, curId)).balance === 400);
    check('покупатель НЕ может вернуть свой confirmed-заказ через cancel', (await call('POST', `/shop/orders/${buy2.json.data.id}/cancel`, t2)).status === 400);

    // ---- Non-material «с задачей»: capture on confirm + a calendar event ----
    const lesson = (await call('POST', '/shop/listings', t1, { showcaseId: scId, title: 'Урок гитары', priceAmount: 30, itemType: 'nonmaterial', withTask: true, taskDays: 1 })).json.data;
    const buy3 = await call('POST', `/shop/listings/${lesson.id}/buy`, t2);
    const conf3 = await call('POST', `/shop/orders/${buy3.json.data.id}/confirm`, t1);
    check('нематериальное «с задачей» → сразу списано (settled)', conf3.ok && conf3.json.data.status === 'settled', `status ${conf3.json?.data?.status}`);
    check('у покупателя списано 30 (баланс 370)', (await entry(t2, curId)).balance === 370);
    const o3 = await prisma.order.findUnique({ where: { id: buy3.json.data.id }, select: { eventId: true } });
    check('создано событие в календаре (eventId)', !!o3.eventId);
  } finally {
    const mine = await call('GET', '/shop/orders', t2);
    for (const o of (mine.json?.data || [])) if (o.status === 'pending' || o.status === 'confirmed') {
      await call('POST', `/shop/orders/${o.id}/cancel`, t2).catch(() => {});
      await call('POST', `/shop/orders/${o.id}/refund`, t1).catch(() => {});
    }
    for (const id of showcases) await call('DELETE', `/shop/showcases/${id}`, t1).catch(() => {});
    for (const id of tasks) await call('DELETE', `/tasks/${id}`, t1).catch(() => {});
    await call('DELETE', '/wallet/currency', t1).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ FULFILMENT E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
