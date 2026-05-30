/* eslint-disable */
// Phase 6 e2e: crowdfunding (multi-currency, all-or-nothing). A crowdfunded lot is collected jointly
// by several contributors across currencies; the campaign flips to 'pending' only when EVERY goal
// currency is filled; the owner confirms → all legs captured. For a material «с задачей» lot the TOP
// contributor becomes Постановщик and the rest observers. Also asserts: buy() blocked on a crowdfunding
// lot, over-pledge rejected, double-pledge rejected, withdraw refunds. Run (API up): node scripts/verify-crowdfunding.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', P3 = '+77023456789', PW = 'Test1234!';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const u3 = (await prisma.user.findUnique({ where: { phone: P3 }, select: { id: true } })).id;
  const linkOf = async (x, y) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: x } });
  };
  await linkOf(u1, u2); await linkOf(u1, u3); await linkOf(u2, u3);

  const tasks = [], showcases = [];
  let c1Id, c3Id;
  try {
    await call('DELETE', '/wallet/currency', t1);
    c1Id = (await call('POST', '/wallet/currency', t1, { name: 'КраудКоинА', icon: '🅰️' })).json.data.id;
    await call('POST', '/wallet/currency/mint', t1, { amount: 1000 });
    await call('DELETE', '/wallet/currency', t3);
    c3Id = (await call('POST', '/wallet/currency', t3, { name: 'КраудКоинГ', icon: '🌟' })).json.data.id;
    await call('POST', '/wallet/currency/mint', t3, { amount: 1000 });

    // Fund t2: 200 C1 (task from t1) + 50 C3 (task from t3).
    const f1 = await call('POST', '/tasks', t1, { title: 'Аванс C1', executorId: u2, coinReward: 200 });
    tasks.push({ id: f1.json.data.id, t: t1 });
    await call('POST', `/tasks/${f1.json.data.id}/submit`, t2);
    await call('POST', `/tasks/${f1.json.data.id}/accept`, t1);
    const f3 = await call('POST', '/tasks', t3, { title: 'Аванс C3', executorId: u2, coinReward: 50 });
    tasks.push({ id: f3.json.data.id, t: t3 });
    await call('POST', `/tasks/${f3.json.data.id}/submit`, t2);
    await call('POST', `/tasks/${f3.json.data.id}/accept`, t3);
    check('t2 профинансирован (200 C1, 50 C3)', (await entry(t2, c1Id)).balance === 200 && (await entry(t2, c3Id)).balance === 50);

    // Crowdfunding material «с задачей» lot, goal 100 C1 + 50 C3, shared to t2 & t3.
    const scId = (await call('POST', '/shop/showcases', t1, { name: 'Сбор-витрина' })).json.data.id;
    showcases.push(scId);
    await call('POST', `/shop/showcases/${scId}/shares`, t1, { principalType: 'user', principalId: u2 });
    await call('POST', `/shop/showcases/${scId}/shares`, t1, { principalType: 'user', principalId: u3 });
    const lot = (await call('POST', '/shop/listings', t1, {
      showcaseId: scId, title: 'Большой подарок', itemType: 'material', withTask: true, taskDays: 2,
      crowdfunding: true, prices: [{ currencyId: c1Id, amount: 100 }, { currencyId: c3Id, amount: 50 }],
    })).json.data;
    check('краудфандинг-лот создан', lot.crowdfunding === true && lot.prices.length === 2, JSON.stringify({ cf: lot.crowdfunding }));

    // buy() is blocked on a crowdfunding lot.
    const buyTry = await call('POST', `/shop/listings/${lot.id}/buy`, t2);
    check('buy() на краудфандинг-лоте отклонён (400)', buyTry.status === 400, `status ${buyTry.status}`);

    // ---- Scenario A: pledge then withdraw → refund, campaign cancelled ----
    const a1 = await call('POST', `/shop/listings/${lot.id}/contribute`, t2, { contributions: [{ currencyId: c1Id, amount: 40 }] });
    check('вклад создаёт кампанию (funding)', a1.ok && a1.json.data.status === 'funding', `status ${a1.status}/${a1.json?.data?.status}`);
    check('после вклада заморожено 40 C1', (await entry(t2, c1Id)).held === 40, JSON.stringify(await entry(t2, c1Id)));
    const wd = await call('POST', `/shop/orders/${a1.json.data.id}/withdraw`, t2);
    check('отзыв вклада прошёл', wd.ok, `status ${wd.status}`);
    check('после отзыва заморозка 0', (await entry(t2, c1Id)).held === 0, JSON.stringify(await entry(t2, c1Id)));

    // ---- Scenario B: full multi-currency collect → confirm → roles → accept → capture all ----
    const b1 = await call('POST', `/shop/listings/${lot.id}/contribute`, t2, { contributions: [{ currencyId: c1Id, amount: 100 }, { currencyId: c3Id, amount: 20 }] });
    check('t2 вложил 100 C1 + 20 C3 (кампания ещё собирает)', b1.ok && b1.json.data.status === 'funding', `status ${b1.json?.data?.status}`);
    const campaignId = b1.json.data.id;
    check('у t2 заморожено 100 C1 и 20 C3', (await entry(t2, c1Id)).held === 100 && (await entry(t2, c3Id)).held === 20);

    // over-pledge (exceeds remaining 30 C3) and double-pledge are rejected.
    const over = await call('POST', `/shop/listings/${lot.id}/contribute`, t3, { contributions: [{ currencyId: c3Id, amount: 999 }] });
    check('пере-вклад сверх остатка отклонён (400)', over.status === 400, `status ${over.status}`);
    const dbl = await call('POST', `/shop/listings/${lot.id}/contribute`, t2, { contributions: [{ currencyId: c3Id, amount: 5 }] });
    check('повторный вклад того же человека отклонён (400)', dbl.status === 400, `status ${dbl.status}`);

    // t3 fills the rest (30 C3) → campaign funded (pending).
    const b2 = await call('POST', `/shop/listings/${lot.id}/contribute`, t3, { contributions: [{ currencyId: c3Id, amount: 30 }] });
    check('после добора кампания собрана (pending)', b2.ok && b2.json.data.status === 'pending', `status ${b2.json?.data?.status}`);

    // Owner confirms → material «с задачей» → task created (top contributor = Постановщик), money still held.
    const conf = await call('POST', `/shop/orders/${campaignId}/confirm`, t1);
    check('подтверждение → заказ «в работе»', conf.ok && conf.json.data.status === 'confirmed', `status ${conf.json?.data?.status}`);
    check('после подтверждения деньги ещё заморожены', (await entry(t2, c1Id)).held === 100 && (await entry(t3, c3Id)).held === 30);
    const ord = await prisma.order.findUnique({ where: { id: campaignId }, select: { taskId: true } });
    const task = await prisma.task.findUnique({ where: { id: ord.taskId }, include: { participants: true } });
    tasks.push({ id: ord.taskId, t: t2 });
    const exec = task.participants.find((p) => p.role === 'executor');
    const obs = task.participants.find((p) => p.role === 'observer');
    check('топ-вкладчик (t2) — Постановщик задачи', task.creatorId === u2, `creator ${task.creatorId}`);
    check('владелец (t1) — Исполнитель', exec && exec.userId === u1, JSON.stringify(exec));
    check('второй вкладчик (t3) — Наблюдатель', obs && obs.userId === u3, JSON.stringify(obs));

    // Owner delivers (submit), top contributor accepts → task.completed → capture all legs (async).
    await call('POST', `/tasks/${ord.taskId}/submit`, t1);
    await call('POST', `/tasks/${ord.taskId}/accept`, t2);
    let settled = false;
    for (let i = 0; i < 20; i++) {
      const o = await prisma.order.findUnique({ where: { id: campaignId }, select: { status: true } });
      if (o.status === 'settled') { settled = true; break; }
      await sleep(500);
    }
    check('после приёмки кампания списана (settled)', settled);
    check('владелец получил всё (100 C1, 50 C3)', (await entry(t1, c1Id)).balance === 900 && (await entry(t1, c3Id)).balance === 50,
      JSON.stringify({ c1: (await entry(t1, c1Id)).balance, c3: (await entry(t1, c3Id)).balance }));
    check('t2 списано 100 C1 + 20 C3 (held 0)', (await entry(t2, c1Id)).balance === 100 && (await entry(t2, c1Id)).held === 0 && (await entry(t2, c3Id)).balance === 30);
    check('t3 списано 30 C3 (held 0)', (await entry(t3, c3Id)).balance === 920 && (await entry(t3, c3Id)).held === 0, JSON.stringify(await entry(t3, c3Id)));
  } finally {
    // Release any leftover holds, then drop test data.
    for (const tk of [t2, t3]) {
      const mine = await call('GET', '/shop/orders', tk);
      for (const o of (mine.json?.data || [])) if (o.status === 'funding') await call('POST', `/shop/orders/${o.id}/withdraw`, tk).catch(() => {});
    }
    for (const id of showcases) await call('DELETE', `/shop/showcases/${id}`, t1).catch(() => {});
    for (const { id, t } of tasks) await call('DELETE', `/tasks/${id}`, t).catch(() => {});
    await call('DELETE', '/wallet/currency', t1).catch(() => {});
    await call('DELETE', '/wallet/currency', t3).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ CROWDFUNDING E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
