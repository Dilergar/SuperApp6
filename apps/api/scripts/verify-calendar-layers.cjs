/* eslint-disable */
// Календарь-платформа e2e: реестр слоёв (CalendarLayersRegistry) + значки записей.
// Проверяет: значок события по всему CRUD (создание/правка/наследование в серии),
// слой задач через провайдер, слой платежей (долг «кредит 30-го числа» с мини-значком,
// повтор со значком категории), сводку периода «Платежи: … · после них ≈ …»,
// дефолтные слои без параметра (finance выключен) и 400 на незнакомый слой.
// Данные — только свои, уборка в конце штатными путями. Run (API up):
//   node scripts/verify-calendar-layers.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
// Адрес API переопределяется переменной окружения: два экземпляра на одной машине
// (например, когда :3001 занят чужим дев-сервером) — обычная ситуация при проверке правок.
const BASE = process.env.SA6_API_BASE || 'http://localhost:3001/api';
const P1 = '+77009990001', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };
const range = (t, from, to, layers) =>
  call('GET', `/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}${layers !== undefined ? `&layers=${layers}` : ''}`, t);

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;

  const created = { events: [], taskId: null, ruleId: null, debtId: null };
  try {
    // ---------- 1. Значок события: CRUD ----------
    const evStart = new Date(Date.now() + 26 * 3600e3);
    const evEnd = new Date(+evStart + 3600e3);
    const c1 = await call('POST', '/calendar/events', t1, {
      title: 'Слои: событие со значком', startTime: evStart.toISOString(), endTime: evEnd.toISOString(), icon: 'ph:car',
    });
    check('создание события со значком ph:car', c1.ok && c1.json.data.icon === 'ph:car', `status ${c1.status}, icon=${c1.json?.data?.icon}`);
    const ev1 = c1.json.data.id; created.events.push(ev1);

    const r1 = await range(t1, new Date(), new Date(Date.now() + 5 * 86400e3), 'events');
    const occ1 = (r1.json.data.items || []).find((i) => i.kind === 'event' && i.eventId === ev1);
    check('значок приезжает в выдаче диапазона', occ1?.icon === 'ph:car', JSON.stringify(occ1?.icon));
    check('ответ диапазона несёт метаданные слоёв (layers)', r1.ok && typeof r1.json.data.layers === 'object', `keys=${JSON.stringify(Object.keys(r1.json.data.layers ?? {}))}`);

    const p1 = await call('PATCH', `/calendar/events/${ev1}`, t1, { icon: null });
    check('значок снимается (icon: null)', p1.ok && p1.json.data.icon === null, `icon=${p1.json?.data?.icon}`);
    const p2 = await call('PATCH', `/calendar/events/${ev1}`, t1, { icon: 'nt:1f697' });
    const d1 = await call('GET', `/calendar/events/${ev1}`, t1);
    check('значок меняется на эмодзи Noto', p2.ok && d1.json.data.icon === 'nt:1f697', `icon=${d1.json?.data?.icon}`);

    // ---------- 2. Значок серии: наследование в override ----------
    const serStart = new Date(Date.now() + 30 * 3600e3);
    const c2 = await call('POST', '/calendar/events', t1, {
      title: 'Слои: серия со значком', startTime: serStart.toISOString(), endTime: new Date(+serStart + 1800e3).toISOString(),
      recurrenceRule: 'FREQ=DAILY', icon: 'fl:1f697',
    });
    check('создание ежедневной серии со значком', c2.ok, `status ${c2.status}`);
    const ev2 = c2.json.data.id; created.events.push(ev2);
    const r2 = await range(t1, new Date(), new Date(Date.now() + 4 * 86400e3), 'events');
    const occs = (r2.json.data.items || []).filter((i) => i.kind === 'event' && (i.eventId === ev2 || i.seriesId === ev2));
    check('серия развёрнута (≥3 вхождений)', occs.length >= 3, `count=${occs.length}`);
    check('каждое вхождение несёт значок серии', occs.every((o) => o.icon === 'fl:1f697'), JSON.stringify(occs.map((o) => o.icon)));

    const occ2 = occs[1];
    const pe = await call('PATCH', `/calendar/events/${ev2}`, t1, { title: 'Слои: правленое вхождение', editScope: 'this', occurrenceStart: occ2.occurrenceStart });
    check('правка одного вхождения серии', pe.ok, `status ${pe.status}`);
    if (pe.ok) created.events.push(pe.json.data.id);
    const r3 = await range(t1, new Date(), new Date(Date.now() + 4 * 86400e3), 'events');
    const override = (r3.json.data.items || []).find((i) => i.kind === 'event' && i.title === 'Слои: правленое вхождение');
    check('override унаследовал значок мастера', override?.icon === 'fl:1f697', `icon=${override?.icon}`);

    // ---------- 3. Слой задач через провайдер + дефолтные слои ----------
    const ct = await call('POST', '/tasks', t1, { title: 'Слои: задача в календаре', dueDate: evStart.toISOString() });
    check('создание задачи со сроком', ct.ok, `status ${ct.status}`);
    created.taskId = ct.json?.data?.id ?? null;
    const rDef = await range(t1, new Date(), new Date(Date.now() + 5 * 86400e3)); // БЕЗ layers → serverDefault
    const defTask = (rDef.json.data.items || []).find((i) => i.kind === 'task' && i.taskId === created.taskId);
    check('без layers слой задач работает (реестр, serverDefault)', !!defTask, JSON.stringify((rDef.json.data.items || []).map((i) => i.kind).slice(0, 8)));

    // ---------- 4. Финансы: «кредит 30-го числа» + повтор со значком категории ----------
    const fin = await call('GET', '/finance', t1); // лениво создаёт книгу с сидом
    check('книга Финансов доступна', fin.ok, `status ${fin.status}`);
    const book = await prisma.finBook.findUnique({ where: { ownerType_ownerId: { ownerType: 'user', ownerId: u1 } } });
    const asset = await prisma.finAccount.findFirst({ where: { bookId: book.id, kind: 'asset', archived: false } });
    const category = await prisma.finAccount.findFirst({ where: { bookId: book.id, kind: 'expense', archived: false, icon: { not: null }, parentId: { not: null } } })
      || await prisma.finAccount.findFirst({ where: { bookId: book.id, kind: 'expense', archived: false, icon: { not: null } } });
    check('в книге есть счёт и категория со значком', !!asset && !!category, `asset=${!!asset} category=${!!category}`);

    const cd = await call('POST', '/finance/debts', t1, {
      name: 'Слои: кредит-тест', type: 'installment', monthlyPayment: 250000, months: 6, dueDay: 30, categoryAccountId: category.id,
    });
    check('создание рассрочки с платежом 30-го числа', cd.ok, `status ${cd.status} ${JSON.stringify(cd.json?.message ?? '')}`);
    created.debtId = cd.json?.data?.id ?? null;

    const cr = await call('POST', '/finance/recurring', t1, {
      title: 'Слои: аренда-тест', fromAccountId: asset.id, toAccountId: category.id, amount: 150000, interval: 'monthly', dayOfMonth: 15, autoRecord: false,
    });
    check('создание повтора (15-е число, без авто-записи)', cr.ok, `status ${cr.status} ${JSON.stringify(cr.json?.message ?? '')}`);
    created.ruleId = cr.json?.data?.id ?? null;

    const now = new Date();
    const nmFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const nmTo = new Date(Date.UTC(nmFrom.getUTCFullYear(), nmFrom.getUTCMonth() + 1, 0, 23, 59, 59));
    const rf = await range(t1, nmFrom, nmTo, 'finance');
    const items = rf.json.data.items || [];
    const debtItem = items.find((i) => i.kind === 'finance' && i.title === 'Платёж: Слои: кредит-тест');
    check('платёж по кредиту виден 30-го числа', !!debtItem && new Date(debtItem.start).getUTCDate() === Math.min(30, nmTo.getUTCDate()), debtItem?.start);
    check('платёж несёт поле значка и сумму', !!debtItem && 'icon' in debtItem && debtItem.amount === 250000, `icon=${debtItem?.icon} amount=${debtItem?.amount}`);
    const ruleItem = items.find((i) => i.kind === 'finance' && i.title === 'Слои: аренда-тест');
    check('повтор виден 15-го числа со значком КАТЕГОРИИ', !!ruleItem && ruleItem.icon === category.icon, `icon=${ruleItem?.icon} ожидался=${category.icon}`);

    const summary = rf.json.data.layers?.finance?.summary;
    check('сводка слоя: «Платежи: …»', typeof summary === 'string' && summary.includes('Платежи:'), JSON.stringify(summary));
    check('сводка слоя: «после них ≈ …» (остаток)', typeof summary === 'string' && summary.includes('после них'), JSON.stringify(summary));

    const rDef2 = await range(t1, nmFrom, nmTo); // дефолтные слои — finance выключен
    check('без layers платежи НЕ отдаются (serverDefault=false)', !(rDef2.json.data.items || []).some((i) => i.kind === 'finance'), '');

    // ---------- 5. Незнакомый слой ----------
    const bad = await range(t1, new Date(), new Date(Date.now() + 86400e3), 'habits');
    check('незнакомый слой habits → 400', bad.status === 400, `status ${bad.status}`);
  } finally {
    for (const id of created.events) await call('DELETE', `/calendar/events/${id}`, t1).catch(() => {});
    if (created.taskId) await call('DELETE', `/tasks/${created.taskId}`, t1).catch(() => {});
    if (created.ruleId) await call('DELETE', `/finance/recurring/${created.ruleId}`, t1).catch(() => {});
    if (created.debtId) {
      // Долг = liability-счёт; штатного DELETE у долгов нет — закрываем и архивируем свой ряд.
      await prisma.finAccount.updateMany({ where: { id: created.debtId }, data: { archived: true, debtClosedAt: new Date() } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
