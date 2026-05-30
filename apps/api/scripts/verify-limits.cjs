/* eslint-disable */
// Phase 7 e2e: stock limit (reserve→sold-out→restore→consume), availability window (before/after →
// 400), FOMO discount (effective price snapshotted on the order), and the auto-archive sweep query.
// Run (API up): node scripts/verify-limits.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', PW = 'Test1234!';
const DAY = 86_400_000;

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}`); return r.json.data.accessToken; };
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
  let curId, scId;
  try {
    await call('DELETE', '/wallet/currency', t1);
    curId = (await call('POST', '/wallet/currency', t1, { name: 'ЛимитКоин', icon: '⏳' })).json.data.id;
    await call('POST', '/wallet/currency/mint', t1, { amount: 1000 });
    const f = await call('POST', '/tasks', t1, { title: 'Аванс', executorId: u2, coinReward: 300 });
    tasks.push(f.json.data.id);
    await call('POST', `/tasks/${f.json.data.id}/submit`, t2);
    await call('POST', `/tasks/${f.json.data.id}/accept`, t1);
    scId = (await call('POST', '/shop/showcases', t1, { name: 'Лимит-витрина' })).json.data.id;
    showcases.push(scId);
    await call('POST', `/shop/showcases/${scId}/shares`, t1, { principalType: 'user', principalId: u2 });

    // ---- Stock: limit 1 → reserve, sold-out, restore on cancel, consume on settle ----
    const stockLot = (await call('POST', '/shop/listings', t1, { showcaseId: scId, title: 'Лимит 1шт', priceAmount: 10, stockLimit: 1 })).json.data;
    const b1 = await call('POST', `/shop/listings/${stockLot.id}/buy`, t2);
    check('1-я покупка резервирует единицу', b1.ok, `status ${b1.status}`);
    const b2 = await call('POST', `/shop/listings/${stockLot.id}/buy`, t2);
    check('2-я покупка при запасе 1 → распродано (400)', b2.status === 400, `status ${b2.status}`);
    await call('POST', `/shop/orders/${b1.json.data.id}/cancel`, t2);
    const b3 = await call('POST', `/shop/listings/${stockLot.id}/buy`, t2);
    check('после отмены единица вернулась → покупка снова возможна', b3.ok, `status ${b3.status}`);
    await call('POST', `/shop/orders/${b3.json.data.id}/confirm`, t1); // settle → consume the unit
    const b4 = await call('POST', `/shop/listings/${stockLot.id}/buy`, t2);
    check('после продажи (settled) запас исчерпан → 400', b4.status === 400, `status ${b4.status}`);

    // ---- Availability window: before start / after end → 400 ----
    const closed = (await call('POST', '/shop/listings', t1, { showcaseId: scId, title: 'Окно прошло', priceAmount: 10, availableUntil: new Date(Date.now() - DAY).toISOString() })).json.data;
    check('покупка после окончания окна → 400', (await call('POST', `/shop/listings/${closed.id}/buy`, t2)).status === 400);
    const soon = (await call('POST', '/shop/listings', t1, { showcaseId: scId, title: 'Окно впереди', priceAmount: 10, availableFrom: new Date(Date.now() + DAY).toISOString() })).json.data;
    check('покупка до начала окна → 400', (await call('POST', `/shop/listings/${soon.id}/buy`, t2)).status === 400);

    // ---- FOMO discount: effective (discounted) price is snapshotted on the order ----
    const disc = (await call('POST', '/shop/listings', t1, { showcaseId: scId, title: 'Скидка 50', priceAmount: 100, discountPercent: 50, discountUntil: new Date(Date.now() + DAY).toISOString() })).json.data;
    check('лот создан со скидкой 50%', disc.discountPercent === 50);
    const t1Before = (await entry(t1, curId)).balance;
    const buyD = await call('POST', `/shop/listings/${disc.id}/buy`, t2);
    check('покупка со скидкой: цена заказа = 50 (не 100)', buyD.ok && buyD.json.data.prices[0].amount === 50, JSON.stringify(buyD.json?.data?.prices));
    check('заморожено 50 (скидочная), не 100', (await entry(t2, curId)).held === 50, JSON.stringify(await entry(t2, curId)));
    await call('POST', `/shop/orders/${buyD.json.data.id}/confirm`, t1);
    check('продавец получил скидочные 50', (await entry(t1, curId)).balance === t1Before + 50, JSON.stringify({ before: t1Before, after: (await entry(t1, curId)).balance }));

    // ---- Auto-archive sweep query: a past-window active lot is selected for archiving ----
    const sweepN = await prisma.listing.updateMany({ where: { status: 'active', availableUntil: { lt: new Date() } }, data: { status: 'archived' } });
    check('сweep-запрос архивирует лоты с истёкшим окном', sweepN.count >= 1, `archived ${sweepN.count}`);
    const closedAfter = await prisma.listing.findUnique({ where: { id: closed.id }, select: { status: true } });
    check('лот с истёкшим окном стал archived', closedAfter.status === 'archived', closedAfter.status);
  } finally {
    const mine = await call('GET', '/shop/orders', t2);
    for (const o of (mine.json?.data || [])) if (o.status === 'pending' || o.status === 'funding') await call('POST', `/shop/orders/${o.id}/cancel`, t2).catch(() => {});
    for (const id of showcases) await call('DELETE', `/shop/showcases/${id}`, t1).catch(() => {});
    for (const id of tasks) await call('DELETE', `/tasks/${id}`, t1).catch(() => {});
    await call('DELETE', '/wallet/currency', t1).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ LIMITS E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
