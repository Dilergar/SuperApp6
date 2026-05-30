/* eslint-disable */
// Phase 8 e2e: wishlist. Owner adds a wish + shares the wishlist; a friend (who can see it) copies it
// into a lot in THEIR shop (Listing.sourceWishItemId + the target showcase auto-shared back to the
// owner); buying that lot auto-fulfils the wish. Also asserts wishlist access (403 for the unshared).
// Run (API up): node scripts/verify-wishlist.cjs
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
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}`); return r.json.data.accessToken; };
const names = (sc) => (sc || []).map((s) => s.name);

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
  await linkOf(u1, u2); // owner shares wishlist with friend; friend shares showcase back; funding task

  const tasks = [], showcases = [], wishes = [];
  let c2Id, wishId;
  try {
    // 1. Owner (t1) adds a wish + shares the wishlist with t2.
    const w = await call('POST', '/shop/wishes', t1, { title: 'Блендер', description: 'красный', link: 'shop.kz/blender', itemType: 'material' });
    check('хотелка создана (тип из хотелки)', w.ok && w.json.data.itemType === 'material', `status ${w.status}`);
    wishId = w.json.data.id; wishes.push(wishId);
    const sh = await call('POST', '/shop/wishes/shares', t1, { principalType: 'user', principalId: u2 });
    check('вишлист расшарен t2', sh.ok, `status ${sh.status}`);

    // 2. t2 sees t1's wishlist; t3 (unshared) does not.
    const acc = await call('GET', '/shop/wishlists/accessible', t2);
    check('t2: t1 в списке доступных вишлистов', (acc.json.data || []).some((a) => a.ownerId === u1), JSON.stringify(acc.json.data));
    const seen = await call('GET', `/shop/wishlists/of/${u1}`, t2);
    check('t2 видит хотелку t1', seen.ok && seen.json.data.items.some((it) => it.id === wishId), `status ${seen.status}`);
    const denied = await call('GET', `/shop/wishlists/of/${u1}`, t3);
    check('t3 (без доступа) → 403', denied.status === 403, `status ${denied.status}`);

    // 3. t2 needs a currency to price the lot.
    await call('DELETE', '/wallet/currency', t2);
    c2Id = (await call('POST', '/wallet/currency', t2, { name: 'ДругКоин', icon: '🤝' })).json.data.id;
    await call('POST', '/wallet/currency/mint', t2, { amount: 1000 });

    // 4. t2 copies the wish into a NEW showcase as a 50-coin lot → links to the wish + auto-shares to t1.
    const copy = await call('POST', `/shop/wishes/${wishId}/copy`, t2, { newShowcaseName: 'Wishlist t1', prices: [{ currencyId: c2Id, amount: 50 }] });
    check('копия хотелки → лот в магазине t2', copy.ok && copy.json.data.itemType === 'material', `status ${copy.status}`);
    const listingId = copy.json.data.id;
    showcases.push(copy.json.data.showcaseId);
    const dbListing = await prisma.listing.findUnique({ where: { id: listingId }, select: { sourceWishItemId: true, withTask: true } });
    check('лот связан с хотелкой (sourceWishItemId)', dbListing.sourceWishItemId === wishId, JSON.stringify(dbListing));
    const t1SeesShop = await call('GET', `/shop/of/${u2}`, t1);
    check('витрина авто-расшарена владельцу хотелки (t1 видит магазин t2)', t1SeesShop.ok && names(t1SeesShop.json.data?.showcases).includes('Wishlist t1'), JSON.stringify(names(t1SeesShop.json.data?.showcases)));

    // 5. Fund t1 with t2's currency, then t1 buys the lot; t2 confirms → settled → wish auto-fulfilled.
    const fund = await call('POST', '/tasks', t2, { title: 'Аванс', executorId: u1, coinReward: 100 });
    tasks.push({ id: fund.json.data.id, t: t2 });
    await call('POST', `/tasks/${fund.json.data.id}/submit`, t1);
    await call('POST', `/tasks/${fund.json.data.id}/accept`, t2);
    const buy = await call('POST', `/shop/listings/${listingId}/buy`, t1);
    check('владелец хотелки покупает лот', buy.ok, `status ${buy.status}`);
    const conf = await call('POST', `/shop/orders/${buy.json.data.id}/confirm`, t2);
    check('продавец подтвердил → settled', conf.ok && conf.json.data.status === 'settled', `status ${conf.json?.data?.status}`);
    const after = await call('GET', '/shop/wishes', t1);
    const wAfter = (after.json.data.items || []).find((it) => it.id === wishId);
    check('хотелка авто-исполнена после продажи лота', wAfter && wAfter.status === 'fulfilled', JSON.stringify(wAfter));
  } finally {
    const mine = await call('GET', '/shop/orders', t1);
    for (const o of (mine.json?.data || [])) if (o.status === 'pending') await call('POST', `/shop/orders/${o.id}/cancel`, t1).catch(() => {});
    for (const id of showcases) await call('DELETE', `/shop/showcases/${id}`, t2).catch(() => {});
    for (const id of wishes) await call('DELETE', `/shop/wishes/${id}`, t1).catch(() => {});
    for (const { id, t } of tasks) await call('DELETE', `/tasks/${id}`, t).catch(() => {});
    await call('DELETE', '/wallet/currency', t2).catch(() => {});
    await call('DELETE', `/shop/wishes/shares/user/${u2}`, t1).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ WISHLIST E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
