/* eslint-disable */
// Phase 5 e2e: cross-currency pricing. A lot is priced in TWO currencies — the owner's own + a
// currency issued by someone in the owner's окружение (a contact). Buying freezes one escrow leg
// per currency atomically (all-or-nothing); confirm captures every leg to the owner. Also asserts
// the /shop/currencies picker (own + contacts') and the atomic rollback when the buyer lacks one
// currency. Run (API up): node scripts/verify-crosscurrency.cjs
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
async function entry(token, currencyId) {
  const r = await call('GET', '/wallet', token);
  return (r.json.data || []).find((x) => x.currencyId === currencyId) || { balance: 0, held: 0, available: 0 };
}

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const u3 = (await prisma.user.findUnique({ where: { phone: P3 }, select: { id: true } })).id;
  const linkOf = async (x, y) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: x } });
  };
  await linkOf(u1, u2); // owner shares the showcase with the buyer
  await linkOf(u1, u3); // owner may price in the contact's (u3's) currency
  await linkOf(u2, u3); // u3 can fund the buyer with u3's currency via a rewarded task

  const tasks = [], showcases = [];
  let c1Id, c3Id;
  try {
    // Owner currency C1 (АльфаКоин) + contact currency C3 (ГаммаКоин, issued by u3).
    await call('DELETE', '/wallet/currency', t1);
    c1Id = (await call('POST', '/wallet/currency', t1, { name: 'АльфаКоин', icon: '🅰️' })).json.data.id;
    await call('POST', '/wallet/currency/mint', t1, { amount: 1000 });
    await call('DELETE', '/wallet/currency', t3);
    c3Id = (await call('POST', '/wallet/currency', t3, { name: 'ГаммаКоин', icon: '🌟' })).json.data.id;
    await call('POST', '/wallet/currency/mint', t3, { amount: 1000 });

    // Fund the buyer: 300 C1 (task from u1) + 200 C3 (task from u3).
    const fund1 = await call('POST', '/tasks', t1, { title: 'Аванс C1', executorId: u2, coinReward: 300 });
    tasks.push({ id: fund1.json.data.id, t: t1 });
    await call('POST', `/tasks/${fund1.json.data.id}/submit`, t2);
    await call('POST', `/tasks/${fund1.json.data.id}/accept`, t1);
    const fund3 = await call('POST', '/tasks', t3, { title: 'Аванс C3', executorId: u2, coinReward: 200 });
    tasks.push({ id: fund3.json.data.id, t: t3 });
    await call('POST', `/tasks/${fund3.json.data.id}/submit`, t2);
    await call('POST', `/tasks/${fund3.json.data.id}/accept`, t3);
    check('покупатель профинансирован: 300 C1 и 200 C3', (await entry(t2, c1Id)).balance === 300 && (await entry(t2, c3Id)).balance === 200,
      JSON.stringify({ c1: await entry(t2, c1Id), c3: await entry(t2, c3Id) }));

    // /shop/currencies (as owner) = own currency + the contact's currency.
    const curs = (await call('GET', '/shop/currencies', t1)).json.data;
    const ownEntry = curs.find((c) => c.id === c1Id);
    const contactEntry = curs.find((c) => c.id === c3Id);
    check('/shop/currencies: своя валюта помечена isOwn', !!ownEntry && ownEntry.isOwn === true, JSON.stringify(ownEntry));
    check('/shop/currencies: валюта контакта (u3) доступна', !!contactEntry && contactEntry.issuerId === u3 && contactEntry.isOwn === false, JSON.stringify(contactEntry));

    // Showcase + cross-currency listing (100 C1 + 50 C3), shared to the buyer.
    const scId = (await call('POST', '/shop/showcases', t1, { name: 'Кросс-витрина' })).json.data.id;
    showcases.push(scId);
    await call('POST', `/shop/showcases/${scId}/shares`, t1, { principalType: 'user', principalId: u2 });
    const listing = (await call('POST', '/shop/listings', t1, { showcaseId: scId, title: 'Кросс-лот', prices: [{ currencyId: c1Id, amount: 100 }, { currencyId: c3Id, amount: 50 }] })).json.data;
    check('лот создан с двумя валютами в цене', listing && listing.prices.length === 2, JSON.stringify(listing?.prices));

    // Reject a price in a currency outside the окружение would be a 400 — sanity: pricing in a
    // random uuid currency fails.
    const bad = await call('POST', '/shop/listings', t1, { showcaseId: scId, title: 'Плохая цена', prices: [{ currencyId: '00000000-0000-0000-0000-000000000000', amount: 10 }] });
    check('цена в чужой/несуществующей валюте отклонена (400)', bad.status === 400, `status ${bad.status}`);

    // Buy → freeze BOTH legs.
    const buy = await call('POST', `/shop/listings/${listing.id}/buy`, t2);
    check('кросс-валютная покупка создаёт заказ с 2 строками цены', buy.ok && buy.json.data.prices.length === 2, `status ${buy.status}`);
    const oid = buy.json.data.id;
    check('заморожено 100 C1 и 50 C3', (await entry(t2, c1Id)).held === 100 && (await entry(t2, c3Id)).held === 50,
      JSON.stringify({ c1: await entry(t2, c1Id), c3: await entry(t2, c3Id) }));

    // Confirm → capture BOTH legs to the owner.
    const conf = await call('POST', `/shop/orders/${oid}/confirm`, t1);
    check('подтверждение → settled', conf.ok && conf.json.data.status === 'settled', `status ${conf.status}`);
    check('у покупателя списаны обе валюты (C1: 200/0, C3: 150/0)',
      (await entry(t2, c1Id)).balance === 200 && (await entry(t2, c1Id)).held === 0 &&
      (await entry(t2, c3Id)).balance === 150 && (await entry(t2, c3Id)).held === 0,
      JSON.stringify({ c1: await entry(t2, c1Id), c3: await entry(t2, c3Id) }));
    check('владелец получил обе валюты (C1: 800, C3: 50)', (await entry(t1, c1Id)).balance === 800 && (await entry(t1, c3Id)).balance === 50,
      JSON.stringify({ c1: await entry(t1, c1Id), c3: await entry(t1, c3Id) }));

    // All-or-nothing: a lot needing more C3 than the buyer holds → 400, and NOTHING is frozen.
    const pricey = (await call('POST', '/shop/listings', t1, { showcaseId: scId, title: 'Дорогой кросс', prices: [{ currencyId: c1Id, amount: 100 }, { currencyId: c3Id, amount: 99999 }] })).json.data;
    const poor = await call('POST', `/shop/listings/${pricey.id}/buy`, t2);
    check('кросс-покупка без одной валюты отклонена (400)', poor.status === 400, `status ${poor.status}`);
    check('атомарный откат: ни C1, ни C3 не заморожены', (await entry(t2, c1Id)).held === 0 && (await entry(t2, c3Id)).held === 0,
      JSON.stringify({ c1: await entry(t2, c1Id), c3: await entry(t2, c3Id) }));
  } finally {
    const mine = await call('GET', '/shop/orders', t2);
    for (const o of (mine.json?.data || [])) if (o.status === 'pending') await call('POST', `/shop/orders/${o.id}/cancel`, t2).catch(() => {});
    for (const id of showcases) await call('DELETE', `/shop/showcases/${id}`, t1).catch(() => {});
    for (const { id, t } of tasks) await call('DELETE', `/tasks/${id}`, t).catch(() => {});
    await call('DELETE', '/wallet/currency', t1).catch(() => {});
    await call('DELETE', '/wallet/currency', t3).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ CROSS-CURRENCY E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
