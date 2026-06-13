/* eslint-disable */
// Phase 9 e2e: B2B wallet. A company issues its own currency into a TREASURY (workspace account),
// pays an employee, rewards a company task from the treasury, and an employee buys in the company
// shop with the payment going to the treasury. Asserts owner-only access + the Σ=0 invariant.
// Run (API up): node scripts/verify-b2b-wallet.cjs
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
async function call(method, p, token, body, ws) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(ws ? { 'X-Workspace-Id': ws } : {}) };
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}`); return r.json.data.accessToken; };
async function wallet(token, currencyId) {
  const r = await call('GET', '/wallet', token);
  return (r.json.data || []).find((x) => x.currencyId === currencyId) || { balance: 0, held: 0, available: 0 };
}

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const [a, b] = u1 < u2 ? [u1, u2] : [u2, u1];
  await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Коллега', roleBForA: 'Коллега', initiatedBy: u1 } });

  let wsId, cId, scId;
  try {
    // Workspace (t1 = owner) + t2 as a member.
    const ws = await call('POST', '/workspaces', t1, { name: 'ТестКорп ' + Date.now() });
    check('организация создана', ws.ok, `status ${ws.status}`);
    wsId = ws.json.data.id;
    await prisma.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: wsId, userId: u2 } }, update: {}, create: { workspaceId: wsId, userId: u2 } }).catch(async () => {
      // fallback if the unique key name differs
      const exists = await prisma.workspaceMember.findFirst({ where: { workspaceId: wsId, userId: u2 } });
      if (!exists) await prisma.workspaceMember.create({ data: { workspaceId: wsId, userId: u2 } });
    });
    // Роль — источник правды членства («рабочий пропуск» проверяет КОМАНДНЫЕ роли,
    // а не голые member-строки): без роли сотрудник недостижим для задач компании.
    await prisma.userRole.upsert({
      where: { userId_role_context_tenantId: { userId: u2, role: 'staff', context: 'workspace', tenantId: wsId } },
      update: { isActive: true },
      create: { userId: u2, role: 'staff', context: 'workspace', tenantId: wsId, grantedBy: u1 },
    });

    // Company currency + mint into the treasury.
    const cur = await call('POST', '/wallet/company/currency', t1, { name: 'БонусКоин', icon: '🏢' }, wsId);
    check('валюта компании создана', cur.ok, `status ${cur.status}`);
    cId = cur.json.data.id;
    check('не-владелец НЕ управляет кошельком компании (403)', (await call('GET', '/wallet/company', t2, null, wsId)).status === 403);
    await call('POST', '/wallet/company/currency/mint', t1, { amount: 1000 }, wsId);
    const tre0 = await call('GET', '/wallet/company', t1, null, wsId);
    check('казна = 1000 после эмиссии', tre0.json.data.treasury.balance === 1000, JSON.stringify(tre0.json.data.treasury));

    // Pay an employee from the treasury.
    await call('POST', '/wallet/company/pay', t1, { userId: u2, amount: 200 }, wsId);
    const tre1 = await call('GET', '/wallet/company', t1, null, wsId);
    check('после начисления казна = 800', tre1.json.data.treasury.balance === 800, JSON.stringify(tre1.json.data.treasury));
    check('сотрудник получил 200 компанийных коинов', (await wallet(t2, cId)).balance === 200, JSON.stringify(await wallet(t2, cId)));

    // Company task: reward paid from the treasury (payer = workspace).
    const task = await call('POST', '/tasks', t1, { title: 'Задача компании', executorId: u2, coinReward: 50 }, wsId);
    check('задача компании создана', task.ok, `status ${task.status}`);
    const tre2 = await call('GET', '/wallet/company', t1, null, wsId);
    check('награда заморожена в казне (held 50, доступно 750)', tre2.json.data.treasury.held === 50 && tre2.json.data.treasury.available === 750, JSON.stringify(tre2.json.data.treasury));
    await call('POST', `/tasks/${task.json.data.id}/submit`, t2);
    await call('POST', `/tasks/${task.json.data.id}/accept`, t1, null, wsId);
    check('после приёмки сотрудник получил награду (250)', (await wallet(t2, cId)).balance === 250, JSON.stringify(await wallet(t2, cId)));
    const tre3 = await call('GET', '/wallet/company', t1, null, wsId);
    check('казна списала награду (750, held 0)', tre3.json.data.treasury.balance === 750 && tre3.json.data.treasury.held === 0, JSON.stringify(tre3.json.data.treasury));

    // Company shop: a lot priced in the company currency, shared to the employee; buying pays the treasury.
    scId = (await call('POST', '/shop/showcases', t1, { name: 'Витрина компании' }, wsId)).json.data.id;
    const lot = await call('POST', '/shop/listings', t1, { showcaseId: scId, title: 'Мерч', priceAmount: 30 }, wsId);
    check('лот компании оценён в валюте компании', lot.ok && lot.json.data.prices[0]?.currencyId === cId, `status ${lot.status}`);
    const share = await call('POST', `/shop/showcases/${scId}/shares`, t1, { principalType: 'user', principalId: u2 }, wsId);
    check('витрина компании расшарена сотруднику', share.ok, `status ${share.status}`);
    const buy = await call('POST', `/shop/listings/${lot.json.data.id}/buy`, t2);
    check('сотрудник покупает за компанийную валюту', buy.ok, `status ${buy.status}`);
    check('у сотрудника заморожено 30', (await wallet(t2, cId)).held === 30, JSON.stringify(await wallet(t2, cId)));
    const conf = await call('POST', `/shop/orders/${buy.json.data.id}/confirm`, t1, null, wsId);
    check('подтверждение → оплата в казну', conf.ok && conf.json.data.status === 'settled', `status ${conf.status}`);
    check('у сотрудника списано 30 (баланс 220)', (await wallet(t2, cId)).balance === 220 && (await wallet(t2, cId)).held === 0, JSON.stringify(await wallet(t2, cId)));
    const tre4 = await call('GET', '/wallet/company', t1, null, wsId);
    check('казна получила оплату (780)', tre4.json.data.treasury.balance === 780, JSON.stringify(tre4.json.data.treasury));

    // Conservation invariant.
    const net = await prisma.account.aggregate({ where: { currencyId: cId }, _sum: { balance: true } });
    check('инвариант компанийной валюты: Σ счетов = 0', (net._sum.balance ?? 0n) === 0n, `Σ=${net._sum.balance}`);
  } finally {
    if (scId) await call('DELETE', `/shop/showcases/${scId}`, t1, null, wsId).catch(() => {});
    await call('DELETE', '/wallet/company/currency', t1, null, wsId).catch(() => {});
    if (wsId) await call('DELETE', `/workspaces/${wsId}`, t1).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ B2B-WALLET E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
