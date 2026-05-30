/* eslint-disable */
// Phase 3 e2e: purchase with escrow over real HTTP. Funds a buyer with the seller's coins (via a
// rewarded task), then drives buy → freeze → confirm/reject/cancel and asserts wallet balances +
// guards (insufficient funds, can't-delete-with-active-order, material «с задачей» blocked).
// Run (API up): node scripts/verify-order.cjs
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
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };
async function entry(token, currencyId) {
  const r = await call('GET', '/wallet', token);
  return (r.json.data || []).find((x) => x.currencyId === currencyId) || { balance: 0, held: 0, available: 0 };
}

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const [a, b] = u1 < u2 ? [u1, u2] : [u2, u1];
  await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 } });

  const tasks = [], showcases = [];
  let curId;
  try {
    // Seller currency + fund the buyer with 300 of it via a rewarded task.
    await call('DELETE', '/wallet/currency', t1);
    curId = (await call('POST', '/wallet/currency', t1, { name: 'ЗаказКоин', icon: '🛒' })).json.data.id;
    await call('POST', '/wallet/currency/mint', t1, { amount: 1000 });
    const task = await call('POST', '/tasks', t1, { title: 'Дать денег', executorId: u2, coinReward: 300 });
    tasks.push(task.json.data.id);
    await call('POST', `/tasks/${task.json.data.id}/submit`, t2);
    await call('POST', `/tasks/${task.json.data.id}/accept`, t1);
    check('покупатель получил 300 коинов продавца', (await entry(t2, curId)).balance === 300, JSON.stringify(await entry(t2, curId)));

    // Showcase + instant listing, shared to the buyer.
    const sc = await call('POST', '/shop/showcases', t1, { name: 'Подарки' });
    showcases.push(sc.json.data.id);
    const rollers = (await call('POST', '/shop/listings', t1, { showcaseId: sc.json.data.id, title: 'Ролики', priceAmount: 100 })).json.data;
    const book = (await call('POST', '/shop/listings', t1, { showcaseId: sc.json.data.id, title: 'Книга', priceAmount: 50 })).json.data;
    await call('POST', `/shop/showcases/${sc.json.data.id}/shares`, t1, { principalType: 'user', principalId: u2 });

    // Buy → freeze
    const buy1 = await call('POST', `/shop/listings/${rollers.id}/buy`, t2);
    check('покупка → заказ создан', buy1.ok && buy1.json.data.status === 'pending', `status ${buy1.status}`);
    let e2 = await entry(t2, curId);
    check('у покупателя заморожено 100, доступно 200', e2.held === 100 && e2.available === 200, JSON.stringify(e2));

    // Seller confirm → capture
    const conf = await call('POST', `/shop/orders/${buy1.json.data.id}/confirm`, t1);
    check('подтверждение прошло', conf.ok && conf.json.data.status === 'settled', `status ${conf.status}`);
    e2 = await entry(t2, curId);
    check('после подтверждения: у покупателя 200, заморозки нет', e2.balance === 200 && e2.held === 0, JSON.stringify(e2));
    check('продавец получил оплату (баланс 800)', (await entry(t1, curId)).balance === 800, JSON.stringify(await entry(t1, curId)));

    // Reject → refund
    const buy2 = await call('POST', `/shop/listings/${book.id}/buy`, t2);
    check('заморозка 50 после 2-й покупки', (await entry(t2, curId)).held === 50);
    await call('POST', `/shop/orders/${buy2.json.data.id}/reject`, t1);
    check('после отклонения: возврат (заморозка 0, баланс 200)', (await entry(t2, curId)).held === 0 && (await entry(t2, curId)).balance === 200);

    // Buyer cancel → refund
    const buy3 = await call('POST', `/shop/listings/${book.id}/buy`, t2);
    check('заморозка 50 после 3-й покупки', (await entry(t2, curId)).held === 50);
    const cancel = await call('POST', `/shop/orders/${buy3.json.data.id}/cancel`, t2);
    check('покупатель отменил свой заказ', cancel.ok && cancel.json.data.status === 'cancelled', `status ${cancel.status}`);
    check('после отмены: заморозка 0', (await entry(t2, curId)).held === 0);

    // Insufficient funds → 400
    const pricey = (await call('POST', '/shop/listings', t1, { showcaseId: sc.json.data.id, title: 'Дорогое', priceAmount: 99999 })).json.data;
    const poor = await call('POST', `/shop/listings/${pricey.id}/buy`, t2);
    check('покупка без средств отклонена (400)', poor.status === 400, `status ${poor.status}`);

    // Can't delete a listing with an active order
    const buy4 = await call('POST', `/shop/listings/${book.id}/buy`, t2);
    const delBlocked = await call('DELETE', `/shop/listings/${book.id}`, t1);
    check('нельзя удалить лот с активным заказом (400)', delBlocked.status === 400, `status ${delBlocked.status}`);
    await call('POST', `/shop/orders/${buy4.json.data.id}/cancel`, t2); // clear it
    const delOk = await call('DELETE', `/shop/listings/${book.id}`, t1);
    check('после отмены заказа лот удаляется', delOk.ok, `status ${delOk.status}`);

    // Material «с задачей» is buyable since Phase 4 (creates a pending order; cleaned up below)
    const withTask = (await call('POST', '/shop/listings', t1, { showcaseId: sc.json.data.id, title: 'Выдать самокат', priceAmount: 20, itemType: 'material', withTask: true, taskDays: 3 })).json.data;
    const wtBuy = await call('POST', `/shop/listings/${withTask.id}/buy`, t2);
    check('материальное «с задачей» теперь покупается (Фаза 4, 201)', wtBuy.ok, `status ${wtBuy.status}`);
  } finally {
    // Release any leftover holds by deleting the currency, then drop catalog + task + contacts.
    const mine = await call('GET', '/shop/orders', t2);
    for (const o of (mine.json?.data || [])) if (o.status === 'pending') await call('POST', `/shop/orders/${o.id}/cancel`, t2).catch(() => {});
    for (const id of showcases) await call('DELETE', `/shop/showcases/${id}`, t1).catch(() => {});
    for (const id of tasks) await call('DELETE', `/tasks/${id}`, t1).catch(() => {});
    await call('DELETE', '/wallet/currency', t1).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ ORDER E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
