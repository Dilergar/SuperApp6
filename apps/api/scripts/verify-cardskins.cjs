/* eslint-disable */
// Card Skins e2e: top-up platform currency, buy (unlimited + serial + sold-out), equip default,
// premium gate on per-group equip, viewer resolution (group override → default), group-priority
// conflict, premium lapse fallback, ownership guard, and the Σ=0 ledger invariant.
// Run (API up, after seed-card-skins): node scripts/verify-cardskins.cjs
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
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}`); return r.json.data.accessToken; };
const bal = async (t) => (await call('GET', '/card-skins/wallet', t)).json.data.balance;

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const [a, b] = u1 < u2 ? [u1, u2] : [u2, u1];
  await prisma.contactLink.upsert({
    where: { userAId_userBId: { userAId: a, userBId: b } },
    update: {},
    create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 },
  });
  const link = await prisma.contactLink.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } }, select: { id: true } });

  // Clean any prior test state for u1.
  const resetU1 = () => prisma.user.update({ where: { id: u1 }, data: { defaultSkinInstanceId: null, premiumUntil: null } });
  const cleanup = async () => {
    await resetU1().catch(() => {});
    const circles = await prisma.circle.findMany({ where: { ownerId: u1, name: { startsWith: 'SKIN_TEST' } }, select: { id: true } });
    for (const c of circles) await prisma.circleMembership.deleteMany({ where: { circleId: c.id } }).catch(() => {});
    await prisma.circle.deleteMany({ where: { ownerId: u1, name: { startsWith: 'SKIN_TEST' } } }).catch(() => {});
    await prisma.cardSkinInstance.deleteMany({ where: { ownerId: u1 } }).catch(() => {});
    await prisma.cardSkin.deleteMany({ where: { name: { startsWith: 'SKIN_TEST' } } }).catch(() => {});
  };
  await cleanup();

  try {
    // --- Wallet top-up (test) ---
    const before = await bal(t1);
    await call('POST', '/card-skins/wallet/topup', t1, { amount: 5000 });
    const b0 = await bal(t1);
    check('тест-пополнение валюты (+5000)', b0 - before === 5000, `delta ${b0 - before}`);

    // --- Catalog ---
    const cat = (await call('GET', '/card-skins/catalog', t1)).json.data;
    const floral = cat.find((s) => s.name === 'Цветочный');
    const paper = cat.find((s) => s.name === 'Мятая бумага');
    const neon = cat.find((s) => s.name === 'Ретро-неон');
    check('каталог содержит 3 сид-скина', !!floral && !!paper && !!neon, `n=${cat.length}`);
    check('Цветочный: безлимитный, доступен, не куплен', floral && floral.supply === null && floral.available && floral.owned === false);
    check('Ретро-неон: лимит 500', neon && neon.supply === 500);

    // --- Buy (unlimited → no serial) ---
    const buyFloral = await call('POST', `/card-skins/${floral.id}/buy`, t1);
    check('покупка Цветочного', buyFloral.ok, `status ${buyFloral.status}`);
    check('безлимитный → без серийника', buyFloral.json?.data?.serial === null, `serial ${buyFloral.json?.data?.serial}`);
    const floralInst = buyFloral.json.data.id;
    const b1 = await bal(t1);
    check('списано 400 за Цветочный', b0 - b1 === 400, `delta ${b0 - b1}`);

    const buyPaper = await call('POST', `/card-skins/${paper.id}/buy`, t1);
    const paperInst = buyPaper.json.data.id;
    check('списано 150 за Мятую бумагу', b1 - (await bal(t1)) === 150);
    check('каталог: Цветочный теперь owned', (await call('GET', '/card-skins/catalog', t1)).json.data.find((s) => s.id === floral.id).owned === true);

    // --- Inventory ---
    const inv = (await call('GET', '/card-skins/inventory', t1)).json.data;
    check('инвентарь содержит купленные скины', inv.some((i) => i.id === floralInst) && inv.some((i) => i.id === paperInst));

    // --- Serial + sold-out on a dedicated limited test skin (supply 2) ---
    const limited = await prisma.cardSkin.create({
      data: { name: 'SKIN_TEST_LIMITED', rarity: 'legendary', priceAmount: 0n, supply: 2, tokens: floral.tokens, status: 'active' },
    });
    const s1 = await call('POST', `/card-skins/${limited.id}/buy`, t1);
    const s2 = await call('POST', `/card-skins/${limited.id}/buy`, t1);
    check('лимитка: серийник #1 у первой копии', s1.json?.data?.serial === 1, `serial ${s1.json?.data?.serial}`);
    check('лимитка: серийник #2 у второй копии', s2.json?.data?.serial === 2, `serial ${s2.json?.data?.serial}`);
    const s3 = await call('POST', `/card-skins/${limited.id}/buy`, t1);
    check('распродано → 400', s3.status === 400, `status ${s3.status}`);
    check('сообщение про распродажу', /распродан/i.test(JSON.stringify(s3.json)), JSON.stringify(s3.json?.message || s3.json));

    // --- Unlimited test skin C for the conflict (distinct from default/other group) ---
    const skinC = await prisma.cardSkin.create({
      data: { name: 'SKIN_TEST_C', rarity: 'common', priceAmount: 0n, supply: null, tokens: paper.tokens, status: 'active' },
    });
    const instC = (await call('POST', `/card-skins/${skinC.id}/buy`, t1)).json.data.id;

    // --- Equip default = paper, resolve sees it (default applies regardless of premium) ---
    const eqD = await call('PUT', '/card-skins/equip/default', t1, { instanceId: paperInst });
    check('надет дефолтный скин', eqD.ok && eqD.json.data.defaultInstanceId === paperInst, `status ${eqD.status}`);
    let res = (await call('GET', `/card-skins/resolve?userIds=${u1}`, t2)).json.data;
    check('зритель видит дефолтный скин владельца', res[u1] && res[u1].id === paper.id, JSON.stringify(res[u1]?.id));

    // --- Ownership guard: viewer cannot equip owner's instance ---
    check("чужой скин нельзя надеть (403)", (await call('PUT', '/card-skins/equip/default', t2, { instanceId: floralInst })).status === 403);

    // --- Per-group equip is premium-gated ---
    const g1 = await prisma.circle.create({ data: { ownerId: u1, name: 'SKIN_TEST_G1', sortOrder: 10 } });
    await prisma.circleMembership.create({ data: { circleId: g1.id, contactLinkId: link.id } });
    check('без премиума скин на группу → 403',
      (await call('PUT', '/card-skins/equip/group', t1, { circleId: g1.id, instanceId: floralInst })).status === 403);

    // Grant premium → per-group equip works.
    await prisma.user.update({ where: { id: u1 }, data: { premiumUntil: new Date(Date.now() + 864e5) } });
    const eqG1 = await call('PUT', '/card-skins/equip/group', t1, { circleId: g1.id, instanceId: floralInst });
    check('с премиумом скин на группу надет', eqG1.ok && eqG1.json.data.perGroup.some((p) => p.circleId === g1.id && p.instanceId === floralInst), `status ${eqG1.status}`);
    res = (await call('GET', `/card-skins/resolve?userIds=${u1}`, t2)).json.data;
    check('зритель видит групповой скин (переопределяет дефолт)', res[u1] && res[u1].id === floral.id, JSON.stringify(res[u1]?.id));

    // --- Group-priority conflict: smaller sortOrder wins ---
    const g2 = await prisma.circle.create({ data: { ownerId: u1, name: 'SKIN_TEST_G2', sortOrder: 0 } });
    await prisma.circleMembership.create({ data: { circleId: g2.id, contactLinkId: link.id } });
    await call('PUT', '/card-skins/equip/group', t1, { circleId: g2.id, instanceId: instC });
    res = (await call('GET', `/card-skins/resolve?userIds=${u1}`, t2)).json.data;
    check('конфликт групп: выигрывает группа выше (sortOrder меньше)', res[u1] && res[u1].id === skinC.id, JSON.stringify(res[u1]?.id));

    // --- Premium lapse → per-group overrides ignored → default ---
    await prisma.user.update({ where: { id: u1 }, data: { premiumUntil: new Date(Date.now() - 864e5) } });
    res = (await call('GET', `/card-skins/resolve?userIds=${u1}`, t2)).json.data;
    check('после истечения премиума → дефолтный скин', res[u1] && res[u1].id === paper.id, JSON.stringify(res[u1]?.id));

    // --- Conservation invariant for the platform currency ---
    const cur = await prisma.currency.findFirst({ where: { issuerType: 'platform', issuerId: 'platform', status: 'active' }, select: { id: true } });
    const net = await prisma.account.aggregate({ where: { currencyId: cur.id }, _sum: { balance: true } });
    check('инвариант платформенной валюты: Σ счетов = 0', (net._sum.balance ?? 0n) === 0n, `Σ=${net._sum.balance}`);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ CARD-SKINS E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
