/* eslint-disable */
// Phase 2 e2e: shop catalog + per-showcase sharing (people & Circle Groups), mirroring calendar
// sharing. Asserts the access resolution: a viewer sees a showcase only if shared directly or via a
// Group they belong to; staff see everything. Run (API up): node scripts/verify-shop.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const { RedisService } = require('../dist/shared/redis/redis.service');
const { AccessService } = require('../dist/core/access/access.service');
const { AccessProjectionService } = require('../dist/core/access/access-projection.service');
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
const names = (sc) => (sc || []).map((s) => s.name);

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const u3 = (await prisma.user.findUnique({ where: { phone: P3 }, select: { id: true } })).id;

  // Setup contacts (t1↔t2, t1↔t3) + a Group "Семья" owned by t1 with ONLY t2 in it.
  const linkOf = async (x, y) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    return prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 } });
  };
  const l12 = await linkOf(u1, u2);
  await linkOf(u1, u3);
  let circle = await prisma.circle.findFirst({ where: { ownerId: u1, name: 'Семья (тест)' } });
  if (!circle) circle = await prisma.circle.create({ data: { ownerId: u1, name: 'Семья (тест)' } });
  await prisma.circleMembership.upsert({ where: { circleId_contactLinkId: { circleId: circle.id, contactLinkId: l12.id } }, update: {}, create: { circleId: circle.id, contactLinkId: l12.id } });

  // Membership was seeded via raw Prisma (bypassing the CirclesService projection hook), so
  // mirror it into the access engine the way the reconcile cron would, before the assertions.
  const redis = new RedisService();
  const projection = new AccessProjectionService(prisma, new AccessService(prisma, redis));
  await projection.reconcile();

  let idA, idB;
  try {
    await call('DELETE', '/wallet/currency', t1);
    await call('POST', '/wallet/currency', t1, { name: 'ШопКоин', icon: '🛍️' });

    const a = await call('POST', '/shop/showcases', t1, { name: 'Витрина А' });
    const b = await call('POST', '/shop/showcases', t1, { name: 'Витрина Б' });
    check('создание витрин', a.ok && b.ok, `A=${a.status} B=${b.status}`);
    idA = a.json.data.id; idB = b.json.data.id;

    const la = await call('POST', '/shop/listings', t1, { showcaseId: idA, title: 'Лот А', priceAmount: 100 });
    const lb = await call('POST', '/shop/listings', t1, { showcaseId: idB, title: 'Лот Б', priceAmount: 50 });
    check('создание лотов (со своей валютой)', la.ok && lb.ok, `A=${la.status} B=${lb.status}`);

    // Share А to the Group (t2 is in it); Б to t3 directly.
    const sa = await call('POST', `/shop/showcases/${idA}/shares`, t1, { principalType: 'circle', principalId: circle.id });
    const sb = await call('POST', `/shop/showcases/${idB}/shares`, t1, { principalType: 'user', principalId: u3 });
    check('шеринг А→Группа, Б→человек', sa.ok && sb.ok, `A=${sa.status} B=${sb.status}`);

    // Owner sees both.
    const own = await call('GET', '/shop', t1);
    const ownNames = names(own.json.data.showcases);
    check('владелец видит обе свои тест-витрины', ownNames.includes('Витрина А') && ownNames.includes('Витрина Б'), JSON.stringify(ownNames));

    // t2 (in the Group) sees ONLY А.
    const v2 = await call('GET', `/shop/of/${u1}`, t2);
    const n2 = names(v2.json.data?.showcases);
    check('t2 (Группа) видит только «Витрина А»', n2.length === 1 && n2[0] === 'Витрина А', JSON.stringify(n2));

    // t3 (direct share) sees ONLY Б.
    const v3 = await call('GET', `/shop/of/${u1}`, t3);
    const n3 = names(v3.json.data?.showcases);
    check('t3 (персональный доступ) видит только «Витрина Б»', n3.length === 1 && n3[0] === 'Витрина Б', JSON.stringify(n3));

    // t2 can read А's listings, but is forbidden Б's.
    const okList = await call('GET', `/shop/showcases/${idA}/listings`, t2);
    check('t2 видит лоты «Витрина А»', okList.ok && okList.json.data.length === 1, `status ${okList.status}`);
    const denied = await call('GET', `/shop/showcases/${idB}/listings`, t2);
    check('t2 НЕ имеет доступа к лотам «Витрина Б» (403)', denied.status === 403, `status ${denied.status}`);

    // Staff: make t2 a shop employee → now sees everything as a manager.
    const staff = await call('POST', '/shop/staff', t1, { userId: u2, scope: 'shop' });
    check('назначение сотрудника магазина', staff.ok, `status ${staff.status}`);
    const v2b = await call('GET', `/shop/of/${u1}`, t2);
    const sNames = names(v2b.json.data.showcases);
    check('сотрудник видит обе тест-витрины и canManage', sNames.includes('Витрина А') && sNames.includes('Витрина Б') && v2b.json.data.shop.canManage === true, JSON.stringify({ n: sNames, m: v2b.json.data.shop.canManage }));
  } finally {
    await call('DELETE', '/shop/staff/' + u2 + '?scope=shop', t1).catch(() => {});
    if (idA) await call('DELETE', `/shop/showcases/${idA}`, t1).catch(() => {});
    if (idB) await call('DELETE', `/shop/showcases/${idB}`, t1).catch(() => {});
    await call('DELETE', '/wallet/currency', t1).catch(() => {});
    await prisma.circleMembership.deleteMany({ where: { circleId: circle.id } }).catch(() => {});
    await prisma.circle.delete({ where: { id: circle.id } }).catch(() => {});
    await prisma.$disconnect();
    await redis.getClient().quit().catch(() => {});
  }

  console.log(`\n${fails === 0 ? '✅ SHOP E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
