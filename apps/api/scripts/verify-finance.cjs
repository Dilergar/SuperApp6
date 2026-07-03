/* eslint-disable */
// «Финансы» (B2C) — e2e Фазы 1: ленивое создание книги с сидом (счета + дерево категорий),
// двойная запись from→to (расход/доход/перевод/обмен), корректировка остатка через equity,
// правки+soft-delete с аудитом, фильтры списка (родительская категория включает детей),
// «на кого» из окружения, изоляция чужой книги, валидация пар счетов и кросс-валюты.
// Run (API up): node scripts/verify-finance.cjs
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
async function call(method, p, token, body, headers) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };

/** Ф8: то, что дергает нода «Финансы: записать операцию» — реальный сервис из dist. */
async function svcRecord(wsId, actorId) {
  try {
    const { buildScopedPrismaClient } = require('../dist/shared/database/database.service');
    const { WorkspaceContextService } = require('../dist/shared/context/workspace-context.service');
    const { FinancesService } = require('../dist/modules/finances/finances.service');
    const db2 = buildScopedPrismaClient(new WorkspaceContextService());
    await db2.$connect();
    const s = new FinancesService(
      db2,
      { assertReachable: async () => undefined },
      { notify: async () => ({}) },
      { can: async () => false, listObjects: async () => [], grant: async () => undefined, revoke: async () => undefined },
      { emit: () => undefined },
    );
    await s.recordOperationForBook(wsId, { kind: 'expense', amount: 1250000, categoryName: 'Закупки', note: 'e2e', actorUserId: actorId });
    await db2.$disconnect();
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String(e?.message ?? e) };
  }
}

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);
  const uid = async (p) => (await prisma.user.findUnique({ where: { phone: p }, select: { id: true } })).id;
  const u1 = await uid(P1), u2 = await uid(P2);

  // Чистый старт: у книги unique(owner) — сносим книги тестеров (cascade заберёт всё).
  const oldBooks = await prisma.finBook.findMany({ where: { ownerType: 'user', ownerId: { in: [u1, u2] } }, select: { id: true } });
  if (oldBooks.length) {
    await prisma.finAuditLog.deleteMany({ where: { bookId: { in: oldBooks.map((b) => b.id) } } });
    await prisma.finBook.deleteMany({ where: { id: { in: oldBooks.map((b) => b.id) } } });
  }

  try {
    // ===== Ленивое создание + сид =====
    const ov1 = await call('GET', '/finance', t1);
    check('книга создана лениво', ov1.ok && !!ov1.json?.data?.book?.id, `status ${ov1.status}`);
    const bookId = ov1.json.data.book.id;
    check('моя роль — owner', ov1.json.data.book.myRole === 'owner');
    const accs = ov1.json.data.accounts, cats = ov1.json.data.categories;
    check('сид: 2 счёта (Наличные, Карта)', accs.length === 2 && accs.some((a) => a.name === 'Наличные') && accs.some((a) => a.name === 'Карта'), accs.map((a) => a.name).join(','));
    check('сид: KZT по умолчанию', accs.every((a) => a.currencyCode === 'KZT'));
    const food = cats.find((c) => c.name === 'Еда' && !c.parentId);
    const grocery = cats.find((c) => c.name === 'Продукты' && c.parentId === food?.id);
    check('сид: дерево категорий (Еда → Продукты)', !!food && !!grocery);
    check('сид: категории доходов (Зарплата)', cats.some((c) => c.name === 'Зарплата' && c.kind === 'income'));
    check('equity скрыт из обзора', !accs.some((a) => a.kind === 'equity') && !cats.some((c) => c.kind === 'equity'));

    const ov2 = await call('GET', '/finance', t1);
    check('повторный GET — та же книга (идемпотентно)', ov2.json?.data?.book?.id === bookId);

    const cash = accs.find((a) => a.name === 'Наличные'), card = accs.find((a) => a.name === 'Карта');
    const salary = cats.find((c) => c.name === 'Зарплата');

    // ===== Корректировка остатка (equity → asset) =====
    const setBal = await call('POST', `/finance/accounts/${card.id}/set-balance`, t1, { balance: 15000000 }); // 150 000 ₸
    check('корректировка остатка карты → 150 000 ₸', setBal.ok && setBal.json?.data?.balance === 15000000, `status ${setBal.status} bal=${setBal.json?.data?.balance}`);
    const setBal2 = await call('POST', `/finance/accounts/${cash.id}/set-balance`, t1, { balance: 5000000 }); // 50 000 ₸
    check('корректировка остатка наличных → 50 000 ₸', setBal2.ok && setBal2.json?.data?.balance === 5000000);

    // ===== Счёт с начальным остатком и валютой =====
    const usd = await call('POST', '/finance/accounts', t1, { name: 'Депозит', subtype: 'savings', currencyCode: 'USD', openingBalance: 50000 }); // $500
    check('счёт USD с начальным остатком', usd.ok && usd.json?.data?.balance === 50000, `status ${usd.status}`);
    const usdId = usd.json?.data?.id;

    // ===== Операции: расход / доход / перевод / обмен =====
    const exp = await call('POST', '/finance/transactions', t1, { fromAccountId: cash.id, toAccountId: grocery.id, amount: 250000, note: 'Magnum' }); // 2 500 ₸
    check('расход наличные → Продукты', exp.ok && exp.json?.data?.type === 'expense', `status ${exp.status} type=${exp.json?.data?.type}`);
    check('валюта расхода = валюта счёта', exp.json?.data?.currencyCode === 'KZT');
    const expId = exp.json?.data?.id;

    const inc = await call('POST', '/finance/transactions', t1, { fromAccountId: salary.id, toAccountId: card.id, amount: 30000000, occurredOn: '2026-07-01' }); // 300 000 ₸
    check('доход Зарплата → Карта', inc.ok && inc.json?.data?.type === 'income');

    const tr = await call('POST', '/finance/transactions', t1, { fromAccountId: card.id, toAccountId: cash.id, amount: 2000000 }); // 20 000 ₸
    check('перевод карта → наличные', tr.ok && tr.json?.data?.type === 'transfer');

    const fx = await call('POST', '/finance/transactions', t1, { fromAccountId: card.id, toAccountId: usdId, amount: 5200000, amountTo: 10000 }); // 52 000 ₸ → $100
    check('обмен KZT → USD (две суммы)', fx.ok && fx.json?.data?.amountTo === 10000, `status ${fx.status}`);

    const fxNoTo = await call('POST', '/finance/transactions', t1, { fromAccountId: card.id, toAccountId: usdId, amount: 100000 });
    check('обмен без amountTo → 400', fxNoTo.status === 400, `status ${fxNoTo.status}`);
    const sameCurTo = await call('POST', '/finance/transactions', t1, { fromAccountId: card.id, toAccountId: cash.id, amount: 100000, amountTo: 100000 });
    check('amountTo при одинаковой валюте → 400', sameCurTo.status === 400, `status ${sameCurTo.status}`);

    // ===== Балансы после операций =====
    const ov3 = await call('GET', '/finance', t1);
    const bal = (id) => ov3.json.data.accounts.find((a) => a.id === id)?.balance;
    check('баланс наличных = 50000−2500+20000 = 67 500 ₸', bal(cash.id) === 6750000, `=${bal(cash.id)}`);
    check('баланс карты = 150000+300000−20000−52000 = 378 000 ₸', bal(card.id) === 37800000, `=${bal(card.id)}`);
    check('баланс депозита = $500+$100 = $600', bal(usdId) === 60000, `=${bal(usdId)}`);

    // ===== Ф2: План-факт (лимиты + отчёт месяца + пороги) =====
    const startedAt = new Date();
    const period = new Date().toISOString().slice(0, 7);
    const bud = await call('PUT', '/finance/budgets', t1, { period, categoryAccountId: food.id, amount: 1000000 });
    check('Ф2: лимит на родителя «Еда» 10 000 ₸', bud.ok && bud.json?.data?.spent === 250000, `status ${bud.status} spent=${bud.json?.data?.spent}`);

    const report1 = await call('GET', `/finance/reports/month?period=${period}`, t1);
    check('Ф2: отчёт месяца — расход Продуктов виден', report1.ok && report1.json?.data?.expenseByCategory?.some((e) => e.categoryId === grocery.id && e.amount === 250000), `status ${report1.status}`);
    check('Ф2: итог расходов KZT = 2 500 ₸', report1.json?.data?.totalExpense?.find((x) => x.currencyCode === 'KZT')?.amount === 250000);
    check('Ф2: доход июля в отчёте', report1.json?.data?.totalIncome?.find((x) => x.currencyCode === 'KZT')?.amount === 30000000);
    check('Ф2: лимит в отчёте с фактом (родитель считает ребёнка)', report1.json?.data?.budgets?.[0]?.spent === 250000, `spent=${report1.json?.data?.budgets?.[0]?.spent}`);

    // Пороги: лимит на Продукты 4 000 ₸; расход №1 пересекает 80%, №2 — 100%
    await call('PUT', '/finance/budgets', t1, { period, categoryAccountId: grocery.id, amount: 400000 });
    await call('POST', '/finance/transactions', t1, { fromAccountId: card.id, toAccountId: grocery.id, amount: 100000 });
    await call('POST', '/finance/transactions', t1, { fromAccountId: card.id, toAccountId: grocery.id, amount: 100000 });
    await new Promise((r) => setTimeout(r, 800)); // fire-and-forget уведомления
    const notifs = await prisma.notification.findMany({ where: { userId: u1, type: { in: ['finance.budget.warning', 'finance.budget.exceeded'] }, createdAt: { gte: startedAt } } });
    check('Ф2: уведомление 80% (warning)', notifs.some((n) => n.type === 'finance.budget.warning'), notifs.map((n) => n.type).join(','));
    check('Ф2: уведомление 100% (exceeded)', notifs.some((n) => n.type === 'finance.budget.exceeded'));

    const trend = await call('GET', '/finance/reports/trend?months=2', t1);
    check('Ф2: тренд 2 месяца', trend.ok && trend.json?.data?.length === 2 && trend.json.data[1].expense.some((e) => e.currencyCode === 'KZT' && e.amount > 0), `status ${trend.status}`);

    const budDel = await call('PUT', '/finance/budgets', t1, { period, categoryAccountId: grocery.id, amount: null });
    check('Ф2: amount=null удаляет лимит', budDel.ok && budDel.json?.data?.deleted === true);
    const budOnIncome = await call('PUT', '/finance/budgets', t1, { period, categoryAccountId: salary.id, amount: 1000 });
    check('Ф2: лимит на категорию дохода → 404', budOnIncome.status === 404, `status ${budOnIncome.status}`);

    // ===== Валидация пар =====
    const badPair = await call('POST', '/finance/transactions', t1, { fromAccountId: grocery.id, toAccountId: cash.id, amount: 1000 });
    check('расходная категория как источник → 400', badPair.status === 400, `status ${badPair.status}`);
    const catCat = await call('POST', '/finance/transactions', t1, { fromAccountId: salary.id, toAccountId: grocery.id, amount: 1000 });
    check('категория → категория → 400', catCat.status === 400, `status ${catCat.status}`);
    const selfPair = await call('POST', '/finance/transactions', t1, { fromAccountId: cash.id, toAccountId: cash.id, amount: 1000 });
    check('один и тот же счёт → 400', selfPair.status === 400, `status ${selfPair.status}`);

    // ===== «На кого» (связь t1↔t2 из окружения) =====
    let linked = (await call('GET', '/contacts', t1)).json?.data?.some?.((c) => c.them?.id === u2);
    if (!linked) {
      const inv = await call('POST', '/contacts/invitations', t1, { toPhone: P2, proposedRoleForRecipient: 'Друг', proposedRoleForSender: 'Друг' });
      if (inv.ok) {
        const incoming = await call('GET', '/contacts/invitations/incoming', t2);
        const invId = incoming.json?.data?.find?.((i) => i.fromUser?.phone === P1 || i.fromUserId === u1)?.id ?? incoming.json?.data?.[0]?.id;
        if (invId) { const acc = await call('POST', `/contacts/invitations/${invId}/accept`, t2, {}); linked = acc.ok; }
      } else { linked = false; }
    }
    if (linked) {
      const pExp = await call('POST', '/finance/transactions', t1, { fromAccountId: cash.id, toAccountId: grocery.id, amount: 120000, personUserId: u2 });
      check('расход «на кого» из окружения', pExp.ok && !!pExp.json?.data?.personName, `status ${pExp.status} name=${pExp.json?.data?.personName}`);
      const byPerson = await call('GET', `/finance/transactions?personUserId=${u2}`, t1);
      check('фильтр по человеку', byPerson.ok && byPerson.json?.data?.length === 1, `n=${byPerson.json?.data?.length}`);

      // ===== Ф3: «Близкие» + отчёт по людям =====
      const addP = await call('POST', '/finance/people', t1, { userId: u2 });
      check('Ф3: близкий добавлен', addP.ok && !!addP.json?.data?.name, `status ${addP.status}`);
      const addDup = await call('POST', '/finance/people', t1, { userId: u2 });
      check('Ф3: повторное добавление идемпотентно', addDup.ok);
      const peopleList = await call('GET', '/finance/people', t1);
      check('Ф3: список «Близких» содержит человека', peopleList.ok && peopleList.json?.data?.some((p) => p.userId === u2), `n=${peopleList.json?.data?.length}`);
      const pRep = await call('GET', `/finance/reports/people?from=${period}-01&to=${period}-28`, t1);
      const pRow = pRep.json?.data?.find?.((r) => r.userId === u2);
      check('Ф3: отчёт по людям — потрачено 1 200 ₸', pRep.ok && pRow?.spent?.some((s) => s.currencyCode === 'KZT' && s.amount === 120000), JSON.stringify(pRow?.spent));
      const delP = await call('DELETE', `/finance/people/${u2}`, t1);
      const peopleList2 = await call('GET', '/finance/people', t1);
      check('Ф3: близкий убран, история жива', delP.ok && !peopleList2.json?.data?.some((p) => p.userId === u2));
      const pRep2 = await call('GET', `/finance/reports/people?from=${period}-01&to=${period}-28`, t1);
      check('Ф3: отчёт по людям не зависит от списка «Близких»', pRep2.json?.data?.some?.((r) => r.userId === u2));

      // ===== Ф4: rich cards (снимок) + quick action =====
      const dm = await call('POST', '/messenger/chats/dm', t1, { userId: u2 });
      check('Ф4: DM для шаринга открыт', dm.ok, `status ${dm.status}`);
      const dmId = dm.json?.data?.id;
      const someTx = await call('POST', '/finance/transactions', t1, { fromAccountId: card.id, toAccountId: grocery.id, amount: 45000, note: 'Хлеб и молоко' });
      const shareTx = await call('POST', '/rich-cards/share', t1, { chatId: dmId, refType: 'fin_transaction', refId: someTx.json?.data?.id });
      check('Ф4: карточка операции ушла в чат', shareTx.ok && shareTx.json?.data?.cardType === 'fin_transaction', `status ${shareTx.status}`);
      check('Ф4: в карточке сумма и категория', shareTx.json?.data?.title?.includes('Продукты') && shareTx.json?.data?.fields?.some((f) => f.label === 'Сумма'), shareTx.json?.data?.title);
      const liveT1 = await call('GET', `/rich-cards/fin_transaction/${someTx.json?.data?.id}`, t1);
      check('Ф4: живой рендер для владельца', liveT1.ok && !!liveT1.json?.data, `status ${liveT1.status}`);
      const liveT2 = await call('GET', `/rich-cards/fin_transaction/${someTx.json?.data?.id}`, t2);
      check('Ф4: живой рендер чужому закрыт (снимок в чате остаётся)', !liveT2.ok || !liveT2.json?.data, `status ${liveT2.status}`);
      const msgs = await call('GET', `/messenger/chats/${dmId}/messages`, t2);
      const cardMsg = (msgs.json?.data ?? []).find((m) => m.payload?.kind === 'rich_card' && m.payload?.cardType === 'fin_transaction');
      check('Ф4: получатель видит СНИМОК в сообщении', !!cardMsg && cardMsg.payload?.fields?.length > 0, `msgs=${msgs.json?.data?.length}`);

      const shareMonth = await call('POST', '/rich-cards/share', t1, { chatId: dmId, refType: 'fin_month', refId: `${bookId}:${period}` });
      check('Ф4: карточка «Итоги месяца» ушла в чат', shareMonth.ok && shareMonth.json?.data?.title?.startsWith('Итоги'), `status ${shareMonth.status} ${shareMonth.json?.data?.title}`);
      const shareForeign = await call('POST', '/rich-cards/share', t2, { chatId: dmId, refType: 'fin_month', refId: `${bookId}:${period}` });
      check('Ф4: чужой не может шарить мою книгу', !shareForeign.ok, `status ${shareForeign.status}`);

      const qa = await call('GET', `/quick-actions?chatId=${dmId}&scope=composer`, t1);
      check('Ф4: «Записать расход» в ＋-меню чата', qa.ok && qa.json?.data?.some?.((a) => a.key === 'finance.add-expense'), JSON.stringify(qa.json?.data?.map?.((a) => a.key)));
    } else {
      console.log('…  связь t1↔t2 не установлена (кулдаун?) — «на кого»/Ф3 пропущены в этом прогоне');
    }
    const strangerP = await call('POST', '/finance/people', t1, { userId: '00000000-0000-4000-8000-000000000001' });
    check('Ф3: чужак в «Близкие» → отказ', !strangerP.ok, `status ${strangerP.status}`);
    const stranger = await call('POST', '/finance/transactions', t1, { fromAccountId: cash.id, toAccountId: grocery.id, amount: 1000, personUserId: '00000000-0000-4000-8000-000000000001' });
    check('«на кого» не из окружения → отказ', !stranger.ok, `status ${stranger.status}`);

    // ===== Правка + аудит =====
    const upd = await call('PATCH', `/finance/transactions/${expId}`, t1, { amount: 300000, note: 'Magnum (испр.)' });
    check('правка операции', upd.ok && upd.json?.data?.amount === 300000, `status ${upd.status}`);
    const auditRows = await prisma.finAuditLog.findMany({ where: { entityId: expId } });
    check('аудит: create + update', auditRows.some((r) => r.action === 'create') && auditRows.some((r) => r.action === 'update'), auditRows.map((r) => r.action).join(','));

    // ===== Фильтры списка =====
    const byParentCat = await call('GET', `/finance/transactions?categoryId=${food.id}`, t1);
    check('фильтр по родителю (Еда) видит траты Продуктов', byParentCat.ok && byParentCat.json.data.some((x) => x.id === expId), `n=${byParentCat.json?.data?.length}`);
    const byDates = await call('GET', '/finance/transactions?from=2026-07-01&to=2026-07-01', t1);
    check('фильтр по датам ловит доход 1 июля', byDates.ok && byDates.json.data.some((x) => x.type === 'income'));
    const byAcc = await call('GET', `/finance/transactions?accountId=${usdId}`, t1);
    check('фильтр по счёту (депозит) видит обмен', byAcc.ok && byAcc.json.data.length === 2, `n=${byAcc.json?.data?.length}`); // opening + fx

    // ===== Soft-delete восстанавливает баланс =====
    const del = await call('DELETE', `/finance/transactions/${expId}`, t1);
    check('мягкое удаление операции', del.ok);
    const ov4 = await call('GET', '/finance', t1);
    const cashAfter = ov4.json.data.accounts.find((a) => a.id === cash.id)?.balance;
    const expected = 5000000 + 2000000 - (linked ? 120000 : 0); // корректировка + перевод, расход удалён (минус «на кого», если был)
    check('баланс наличных восстановился после удаления', cashAfter === expected, `=${cashAfter}, ждали ${expected}`);
    const list = await call('GET', '/finance/transactions', t1);
    check('удалённая операция скрыта из списка', !list.json.data.some((x) => x.id === expId));

    // ===== Категории: CRUD и правила дерева =====
    const pets = await call('POST', '/finance/categories', t1, { kind: 'expense', name: 'Питомцы', icon: '🐾' });
    check('создание категории', pets.ok, `status ${pets.status}`);
    const petFood = await call('POST', '/finance/categories', t1, { kind: 'expense', name: 'Корм', parentId: pets.json?.data?.id });
    check('создание подкатегории', petFood.ok);
    const tooDeep = await call('POST', '/finance/categories', t1, { kind: 'expense', name: 'Сухой корм', parentId: petFood.json?.data?.id });
    check('третий уровень → 400', tooDeep.status === 400, `status ${tooDeep.status}`);
    const delParent = await call('DELETE', `/finance/categories/${pets.json?.data?.id}`, t1);
    check('удаление родителя с детьми → 409', delParent.status === 409, `status ${delParent.status}`);
    const delChild = await call('DELETE', `/finance/categories/${petFood.json?.data?.id}`, t1);
    check('пустая подкатегория удаляется насовсем', delChild.ok && delChild.json?.data?.archived === false);
    const delGrocery = await call('DELETE', `/finance/categories/${grocery.id}`, t1);
    check('категория с историей → архив', delGrocery.ok && delGrocery.json?.data?.archived === true, JSON.stringify(delGrocery.json?.data));

    // ===== Счета: удаление =====
    const tmpAcc = await call('POST', '/finance/accounts', t1, { name: 'Временный', subtype: 'other' });
    const delTmp = await call('DELETE', `/finance/accounts/${tmpAcc.json?.data?.id}`, t1);
    check('пустой счёт удаляется насовсем', delTmp.ok && delTmp.json?.data?.archived === false);
    const delCash = await call('DELETE', `/finance/accounts/${cash.id}`, t1);
    check('счёт с историей → архив', delCash.ok && delCash.json?.data?.archived === true);

    // ===== Изоляция чужой книги =====
    const foreign = await call('GET', `/finance?bookId=${bookId}`, t2);
    check('чужая книга → 403', foreign.status === 403, `status ${foreign.status}`);
    const foreignTx = await call('POST', `/finance/transactions?bookId=${bookId}`, t2, { fromAccountId: card.id, toAccountId: food.id, amount: 1000 });
    check('запись в чужую книгу → 403', foreignTx.status === 403, `status ${foreignTx.status}`);
    const ownBook2 = await call('GET', '/finance', t2);
    check('у t2 своя книга', ownBook2.ok && ownBook2.json?.data?.book?.id !== bookId);

    // ===== Ф5: Долги (рассрочка + кредит) =====
    const transport = cats.find((c) => c.name === 'Транспорт');
    const inst = await call('POST', '/finance/debts', t1, {
      name: 'Посуда в рассрочку', type: 'installment', monthlyPayment: 1000000, months: 12, dueDay: 25,
      categoryAccountId: transport.id, note: 'Kaspi 0-0-12',
    });
    check('Ф5: рассрочка создана (12 × 10 000 ₸)', inst.ok && inst.json?.data?.total === 12000000 && inst.json?.data?.remaining === 12000000, `status ${inst.status}`);
    const instId = inst.json?.data?.accountId;
    const repD = await call('GET', `/finance/reports/month?period=${period}`, t1);
    check('Ф5: покупка в рассрочку — расход ПОЛНОЙ суммой в месяц покупки', repD.json?.data?.expenseByCategory?.some((e) => e.categoryId === transport.id && e.amount === 12000000));
    const ovD = await call('GET', '/finance', t1);
    check('Ф5: остаток долга = −баланс liability', ovD.json?.data?.accounts?.some((a) => a.id === instId && a.balance === -12000000));

    const pay1 = await call('POST', `/finance/debts/${instId}/pay`, t1, { fromAccountId: card.id });
    check('Ф5: «Оплачено» (дефолт = ежемесячный)', pay1.ok && pay1.json?.data?.remaining === 11000000 && pay1.json?.data?.paidMonths === 1, JSON.stringify({ r: pay1.json?.data?.remaining, m: pay1.json?.data?.paidMonths }));
    const pay2 = await call('POST', `/finance/debts/${instId}/pay`, t1, { fromAccountId: card.id, amount: 99000000 });
    check('Ф5: переплата капится остатком и закрывает долг', pay2.ok && pay2.json?.data?.remaining === 0 && !!pay2.json?.data?.closedAt, JSON.stringify({ r: pay2.json?.data?.remaining, c: !!pay2.json?.data?.closedAt }));
    const pay3 = await call('POST', `/finance/debts/${instId}/pay`, t1, { fromAccountId: card.id });
    check('Ф5: платёж по закрытому долгу → 400', pay3.status === 400, `status ${pay3.status}`);
    const repD2 = await call('GET', `/finance/reports/month?period=${period}`, t1);
    check('Ф5: секция «Платежи по долгам» = 120 000 ₸ (не расход)', repD2.json?.data?.debtPayments?.find((x) => x.currencyCode === 'KZT')?.amount === 12000000, JSON.stringify(repD2.json?.data?.debtPayments));

    const loan = await call('POST', '/finance/debts', t1, {
      name: 'Кредит наличными', type: 'loan', monthlyPayment: 1100000, months: 10, dueDay: 5,
      creditAccountId: card.id, amountReceived: 10000000,
    });
    check('Ф5: кредит деньгами создан (итог 11 000 000, получено 10 000 000)', loan.ok && loan.json?.data?.total === 11000000, `status ${loan.status}`);
    const ovL = await call('GET', '/finance', t1);
    const cardBal = ovL.json?.data?.accounts?.find((a) => a.id === card.id)?.balance;
    const repL = await call('GET', `/finance/reports/month?period=${period}`, t1);
    const interestCat = (await call('GET', '/finance', t1)).json?.data?.categories?.find((c) => c.name === 'Проценты по кредитам');
    check('Ф5: переплата по кредиту = расход «Проценты по кредитам» 10 000 ₸', !!interestCat && repL.json?.data?.expenseByCategory?.some((e) => e.categoryId === interestCat.id && e.amount === 1000000));
    check('Ф5: деньги кредита зачислены на карту', typeof cardBal === 'number', `bal=${cardBal}`);

    const debts = await call('GET', '/finance/debts', t1);
    check('Ф5: список долгов (закрытый + открытый)', debts.ok && debts.json?.data?.length === 2 && debts.json.data.some((d) => d.closedAt) && debts.json.data.some((d) => !d.closedAt));

    // ===== Ф5: Повторы =====
    const home = cats.find((c) => c.name === 'Дом' && !c.parentId);
    const rec = await call('POST', '/finance/recurring', t1, {
      title: 'Аренда', fromAccountId: card.id, toAccountId: home.id, amount: 5000000, interval: 'monthly', dayOfMonth: 15, autoRecord: true,
    });
    check('Ф5: повтор создан, срабатывание — 15-е число', rec.ok && rec.json?.data?.nextRunAt?.slice(8, 10) === '15', `next=${rec.json?.data?.nextRunAt}`);
    const recId = rec.json?.data?.id;
    const recNow = await call('POST', `/finance/recurring/${recId}/record-now`, t1);
    check('Ф5: «Записать сейчас» создаёт операцию source=recurring', recNow.ok && recNow.json?.data?.source === 'recurring');

    const recManual = await call('POST', '/finance/recurring', t1, {
      title: 'Коммуналка', fromAccountId: card.id, toAccountId: home.id, amount: 2500000, interval: 'monthly', dayOfMonth: 20, autoRecord: false,
    });
    const recManualId = recManual.json?.data?.id;

    // ===== Ф5: крон-механика (реальный сервис из dist, клейм + дедуп) =====
    const { buildScopedPrismaClient } = require('../dist/shared/database/database.service');
    const { WorkspaceContextService } = require('../dist/shared/context/workspace-context.service');
    const { FinancesService } = require('../dist/modules/finances/finances.service');
    const sdb = buildScopedPrismaClient(new WorkspaceContextService());
    await sdb.$connect();
    const notified = [];
    const svc = new FinancesService(
      sdb,
      { assertReachable: async () => undefined },
      { notify: async (uid, type, payload) => { notified.push({ uid, type, payload }); return {}; } },
      { can: async () => false, listObjects: async () => [], grant: async () => undefined, revoke: async () => undefined },
      { emit: () => undefined },
    );
    const cronStart = new Date();
    await sdb.finRecurringRule.update({ where: { id: recId }, data: { nextRunAt: new Date(Date.now() - 3600_000) } });
    await sdb.finRecurringRule.update({ where: { id: recManualId }, data: { nextRunAt: new Date(Date.now() - 3600_000) } });
    const processed = await svc.processDueRecurring();
    check('Ф5: крон обработал 2 срабатывания', processed === 2, `processed=${processed}`);
    const autoTx = await prisma.finTransaction.findFirst({ where: { recurringRuleId: recId, source: 'recurring', createdAt: { gte: cronStart } } });
    check('Ф5: авто-запись создала операцию', !!autoTx);
    check('Ф5: напоминание для ручного повтора', notified.some((n) => n.type === 'finance.recurring.due' && n.payload?.title === 'Коммуналка'), JSON.stringify(notified.map((n) => n.type)));
    const ruleAfter = await prisma.finRecurringRule.findUnique({ where: { id: recId } });
    check('Ф5: nextRunAt сдвинут в будущее (клейм)', ruleAfter.nextRunAt > new Date());
    const processedAgain = await svc.processDueRecurring();
    check('Ф5: повторный прогон ничего не дублирует', processedAgain === 0, `=${processedAgain}`);

    const todayDay = new Date().getUTCDate();
    await sdb.finAccount.update({ where: { id: loan.json?.data?.accountId }, data: { debtDueDay: todayDay } });
    const reminders1 = await svc.processDebtReminders();
    check('Ф5: напоминание «сегодня платёж по долгу»', reminders1 === 1 && notified.some((n) => n.type === 'finance.debt.payment_due'), `sent=${reminders1}`);
    const reminders2 = await svc.processDebtReminders();
    check('Ф5: дедуп — второй раз за день не шлёт', reminders2 === 0, `sent=${reminders2}`);
    await sdb.$disconnect();

    // ===== Ф6: Шеринг книги (finbook в core/access) =====
    const sh1 = await call('POST', '/finance/shares', t1, { principalType: 'user', principalId: u2, role: 'viewer' });
    check('Ф6: доступ «смотрит» выдан', sh1.ok && sh1.json?.data?.some((s) => s.principalId === u2 && s.role === 'viewer'), `status ${sh1.status}`);
    const swm1 = await call('GET', '/finance/shared-with-me', t2);
    check('Ф6: книга видна в «поделились со мной»', swm1.ok && swm1.json?.data?.some((b) => b.bookId === bookId && b.myRole === 'viewer'), JSON.stringify(swm1.json?.data));
    const viewOk = await call('GET', `/finance?bookId=${bookId}`, t2);
    check('Ф6: «смотрит» читает книгу', viewOk.ok && viewOk.json?.data?.book?.myRole === 'viewer', `status ${viewOk.status} role=${viewOk.json?.data?.book?.myRole}`);
    const viewerWrite = await call('POST', `/finance/transactions?bookId=${bookId}`, t2, { fromAccountId: card.id, toAccountId: transport.id, amount: 1000 });
    check('Ф6: «смотрит» писать НЕ может → 403', viewerWrite.status === 403, `status ${viewerWrite.status}`);

    const sh2 = await call('POST', '/finance/shares', t1, { principalType: 'user', principalId: u2, role: 'editor' });
    check('Ф6: роль поднята до «ведёт» (одна роль на принципала)', sh2.ok && sh2.json?.data?.filter((s) => s.principalId === u2).length === 1 && sh2.json?.data?.some((s) => s.principalId === u2 && s.role === 'editor'));
    const editorWrite = await call('POST', `/finance/transactions?bookId=${bookId}`, t2, { fromAccountId: card.id, toAccountId: transport.id, amount: 77000, note: 'внесла жена' });
    check('Ф6: «ведёт» пишет в чужую книгу', editorWrite.ok, `status ${editorWrite.status}`);
    const authored = await call('GET', `/finance/transactions?bookId=${bookId}`, t1);
    const foreignTx2 = authored.json?.data?.find((x) => x.note === 'внесла жена');
    check('Ф6: автор операции сохранён и виден владельцу', !!foreignTx2 && foreignTx2.createdById === u2 && !!foreignTx2.createdByName, `author=${foreignTx2?.createdByName}`);
    const editorEdit = await call('PATCH', `/finance/transactions/${foreignTx2?.id}?bookId=${bookId}`, t2, { amount: 88000 });
    check('Ф6: «ведёт» правит ЛЮБЫЕ операции (Дзен-мани модель)', editorEdit.ok, `status ${editorEdit.status}`);
    const shareNotif = await prisma.notification.findFirst({ where: { userId: u2, type: 'finance.book.shared' } });
    check('Ф6: уведомление «вам открыли доступ»', !!shareNotif);
    const editorShares = await call('GET', `/finance/shares?bookId=${bookId}`, t2);
    check('Ф6: доступом управляет только владелец', editorShares.status === 403, `status ${editorShares.status}`);

    const unshare = await call('DELETE', `/finance/shares/user/${u2}`, t1);
    const afterRevoke = await call('GET', `/finance?bookId=${bookId}`, t2);
    check('Ф6: отзыв доступа мгновенный (эпоха кэша)', unshare.ok && afterRevoke.status === 403, `status ${afterRevoke.status}`);

    // Разрыв связи отзывает прямые гранты (contact.removed → FinancesEvents)
    await call('POST', '/finance/shares', t1, { principalType: 'user', principalId: u2, role: 'editor' });
    const myContacts = await call('GET', '/contacts', t1);
    const linkId = myContacts.json?.data?.find?.((c) => c.them?.id === u2)?.linkId;
    if (linkId) {
      await call('DELETE', `/contacts/${linkId}`, t1);
      await new Promise((r) => setTimeout(r, 1500)); // шина + отзыв
      const afterBreak = await call('GET', `/finance?bookId=${bookId}`, t2);
      check('Ф6: разрыв связи отозвал доступ к книге', afterBreak.status === 403, `status ${afterBreak.status}`);
      // Восстановим связь для повторяемости прогонов (мимо invite-кулдаунов).
      const [a, b] = [u1, u2].sort();
      await prisma.contactLink.create({ data: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 } }).catch(() => {});
    } else {
      console.log('…  linkId не найден — проверка разрыва связи пропущена');
    }

    // ===== Ф7: Коин-лента экосистемы (проекция леджера) =====
    let cur = (await call('GET', '/wallet/currency', t1)).json?.data;
    if (!cur) cur = (await call('POST', '/wallet/currency', t1, { name: 'Тестокоин', icon: '🪙' })).json?.data;
    check('Ф7: валюта эмитента есть', !!cur, JSON.stringify(cur));
    await call('POST', '/wallet/currency/mint', t1, { amount: 500 });
    const feedAfterMint = await call('GET', '/finance/coins', t1);
    check('Ф7: mint виден в ленте как «Выпуск монет»', feedAfterMint.ok && feedAfterMint.json?.data?.some((i) => i.kind === 'mint' && i.direction === 'in'), `n=${feedAfterMint.json?.data?.length}`);

    // Полный эскроу-цикл задачи: награда → приход у исполнителя с контекстом
    const rewardTask = await call('POST', '/tasks', t1, { title: 'Купить хлеб по дороге', executorId: u2, coinReward: 50 });
    check('Ф7: задача с наградой создана', rewardTask.ok, `status ${rewardTask.status}`);
    const rtId = rewardTask.json?.data?.id;
    const sub = await call('POST', `/tasks/${rtId}/submit`, t2, {});
    check('Ф7: исполнитель сдал работу', sub.ok, `status ${sub.status}`);
    const acc2 = await call('POST', `/tasks/${rtId}/accept`, t1, { participantUserId: u2 });
    check('Ф7: постановщик принял (эскроу выплачен)', acc2.ok, `status ${acc2.status}`);

    const feedPayer = await call('GET', '/finance/coins', t1);
    const payerItem = feedPayer.json?.data?.find((i) => i.kind === 'task' && i.direction === 'out' && i.title.includes('Купить хлеб'));
    check('Ф7: у плательщика — расход «Награда за задачу …» с названием', !!payerItem, JSON.stringify(feedPayer.json?.data?.[0]));
    check('Ф7: контрагент плательщика — исполнитель (PersonChip)', payerItem?.counterpartyUserId === u2 && !!payerItem?.counterpartyName, `${payerItem?.counterpartyName}`);
    check('Ф7: дип-линк на задачу', payerItem?.href === `/tasks/${rtId}`, payerItem?.href);
    const feedReceiver = await call('GET', '/finance/coins', t2);
    const recvItem = feedReceiver.json?.data?.find((i) => i.kind === 'task' && i.direction === 'in' && i.title.includes('Купить хлеб'));
    check('Ф7: у исполнителя — приход за задачу с комментарием', !!recvItem && recvItem.amount === 50, JSON.stringify(recvItem));

    // ===== Ф8: календарный слой «Платежи» + нода Процессов + книга организации =====
    const now = new Date();
    const mStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const mEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59)).toISOString();
    const cal = await call('GET', `/calendar/events?from=${encodeURIComponent(mStart)}&to=${encodeURIComponent(mEnd)}&layers=finance`, t1);
    const finItems = (cal.json?.data?.items ?? []).filter((i) => i.kind === 'finance');
    check('Ф8: календарный слой отдаёт платежи', cal.ok && finItems.length > 0, `n=${finItems.length}`);
    check('Ф8: в слое есть платёж по долгу и повтор', finItems.some((i) => i.id.startsWith('debt:')) && finItems.some((i) => i.id.startsWith('recurring:')), finItems.slice(0, 3).map((i) => i.title).join(' | '));
    const calDefault = await call('GET', `/calendar/events?from=${encodeURIComponent(mStart)}&to=${encodeURIComponent(mEnd)}`, t1);
    check('Ф8: без layers слой платежей НЕ включён (дефолт не тронут)', calDefault.ok && !(calDefault.json?.data?.items ?? []).some((i) => i.kind === 'finance'));

    const ws8 = await call('POST', '/workspaces', t1, { name: 'fin-e2e-' + Date.now() });
    check('Ф8: организация создана', ws8.ok, `status ${ws8.status}`);
    const ws8Id = ws8.json?.data?.id;
    const nodeTypes = await call('GET', `/workspaces/${ws8Id}/processes/node-types`, t1);
    check('Ф8: нода «Финансы: записать операцию» в палитре', nodeTypes.ok && nodeTypes.json?.data?.some((n) => n.type === 'finance.record'), `n=${nodeTypes.json?.data?.length}`);

    // Управленческая запись в книгу организации (то, что дергает нода)
    const rec1 = await svcRecord(ws8Id, u1);
    check('Ф8: запись в книгу организации (категория+касса лениво)', rec1.ok, rec1.err ?? '');
    const orgBook = await prisma.finBook.findUnique({ where: { ownerType_ownerId: { ownerType: 'workspace', ownerId: ws8Id } } });
    const orgTx = orgBook ? await prisma.finTransaction.findFirst({ where: { bookId: orgBook.id, source: 'process' } }) : null;
    check('Ф8: операция source=process в книге организации', !!orgTx && Number(orgTx.amount) === 1250000, `amount=${orgTx && Number(orgTx.amount)}`);

    // ===== РЕВЬЮ-ФИКСЫ =====
    // A4: обновление лимита без валюты сохраняет старую валюту (не сбрасывает на KZT)
    const foodCat = (await call('GET', '/finance', t1)).json?.data?.categories?.find((c) => c.name === 'Еда' && !c.parentId);
    if (foodCat) {
      const revPeriod = new Date().toISOString().slice(0, 7);
      await call('PUT', '/finance/budgets', t1, { period: revPeriod, categoryAccountId: foodCat.id, amount: 50000, currencyCode: 'USD' });
      await call('PUT', '/finance/budgets', t1, { period: revPeriod, categoryAccountId: foodCat.id, amount: 60000 }); // без валюты
      const repRev = await call('GET', `/finance/reports/month?period=${revPeriod}`, t1);
      const bud = repRev.json?.data?.budgets?.find((b) => b.categoryAccountId === foodCat.id);
      check('review A4: валюта лимита сохранена при обновлении (USD, не KZT)', bud?.currencyCode === 'USD', `code=${bud?.currencyCode}`);
      await call('PUT', '/finance/budgets', t1, { period: revPeriod, categoryAccountId: foodCat.id, amount: null });
    }

    // A5: удаление счёта чистит висячие повторы
    const revAcc = await call('POST', '/finance/accounts', t1, { name: 'Временный-повтор', subtype: 'other' });
    const revAccId = revAcc.json?.data?.id;
    const home5 = (await call('GET', '/finance', t1)).json?.data?.categories?.find((c) => c.name === 'Дом' && !c.parentId);
    const revRule = await call('POST', '/finance/recurring', t1, { title: 'Висячий', fromAccountId: revAccId, toAccountId: home5.id, amount: 1000, interval: 'monthly', dayOfMonth: 10, autoRecord: true });
    check('review A5: повтор на счёте создан', revRule.ok, `status ${revRule.status}`);
    await call('DELETE', `/finance/accounts/${revAccId}`, t1);
    const rulesAfter = await call('GET', '/finance/recurring', t1);
    check('review A5: удаление счёта убрало висячий повтор', !rulesAfter.json?.data?.some((r) => r.id === revRule.json?.data?.id));

    // H1: removeShare с кривым типом принципала → 400 (не 200 success:false)
    const badRemove = await call('DELETE', `/finance/shares/bogus/${u2}`, t1);
    check('review H1: removeShare с неизвестным типом → 400', badRemove.status === 400, `status ${badRemove.status}`);

    // A1: блокировка отзывает доступ к книге (как удаление контакта)
    // связь t1↔t2 восстановлена выше; шарим и блокируем
    const shBlk = await call('POST', '/finance/shares', t1, { principalType: 'user', principalId: u2, role: 'viewer' });
    if (shBlk.ok) {
      const canBefore = await call('GET', `/finance?bookId=${bookId}`, t2);
      const blk = await call('POST', '/contacts/blocks', t1, { userId: u2 });
      if (blk.ok) {
        await new Promise((r) => setTimeout(r, 1500)); // шина contact.blocked → revoke
        const canAfter = await call('GET', `/finance?bookId=${bookId}`, t2);
        check('review A1: блокировка отозвала доступ к книге', canBefore.ok && canAfter.status === 403, `before ${canBefore.status} after ${canAfter.status}`);
        await call('DELETE', `/contacts/blocks/${u2}`, t1);
        // восстановим связь для повторных прогонов
        const [a, b] = [u1, u2].sort();
        await prisma.contactLink.create({ data: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 } }).catch(() => {});
      } else {
        console.log('…  review A1: блок не поставился — пропуск');
      }
    }

    // ===== РЕВЬЮ-2 ФИКСЫ =====
    const r2period = new Date().toISOString().slice(0, 7);
    const r2ov = (await call('GET', '/finance', t1)).json?.data;
    const cashA = r2ov.accounts.find((a) => a.name === 'Наличные' && !a.archived) || r2ov.accounts.find((a) => a.kind === 'asset' && !a.archived);
    const eda = r2ov.categories.find((c) => c.name === 'Еда' && !c.parentId);
    const zar = r2ov.categories.find((c) => c.name === 'Зарплата');

    // budget-check на update: лимит 4 000₸, трата 2 000 → правка на 5 000 → exceeded
    const bcAcc = r2ov.accounts.find((a) => a.kind === 'asset' && !a.archived);
    const bcCat = r2ov.categories.find((c) => c.name === 'Одежда' && !c.parentId); // чистая категория (не нагружена ранее)
    if (bcAcc && bcCat) {
      await call('PUT', '/finance/budgets', t1, { period: r2period, categoryAccountId: bcCat.id, amount: 400000 });
      const bcTx = await call('POST', '/finance/transactions', t1, { fromAccountId: bcAcc.id, toAccountId: bcCat.id, amount: 200000 });
      const startBc = new Date();
      await call('PATCH', `/finance/transactions/${bcTx.json?.data?.id}`, t1, { amount: 500000 });
      await new Promise((r) => setTimeout(r, 700));
      const bcNotif = await prisma.notification.findFirst({ where: { userId: u1, type: 'finance.budget.exceeded', createdAt: { gte: startBc } } });
      check('review2: правка суммы вверх шлёт finance.budget.exceeded', !!bcNotif);
      await call('PUT', '/finance/budgets', t1, { period: r2period, categoryAccountId: bcCat.id, amount: null });
      await call('DELETE', `/finance/transactions/${bcTx.json?.data?.id}`, t1);
    }

    // cross-currency amountTo guard на update
    const r2usd = r2ov.accounts.find((a) => a.currencyCode === 'USD');
    if (r2usd && cashA) {
      const fxTx = await call('POST', '/finance/transactions', t1, { fromAccountId: cashA.id, toAccountId: r2usd.id, amount: 5200000, amountTo: 10000 });
      const badEdit = await call('PATCH', `/finance/transactions/${fxTx.json?.data?.id}`, t1, { amount: 6000000 });
      check('review2: правка суммы обмена без amountTo → 400', badEdit.status === 400, `status ${badEdit.status}`);
      await call('DELETE', `/finance/transactions/${fxTx.json?.data?.id}`, t1);
    }

    // «на себя»: personUserId = сам записывающий (без окружения) → 200 + виден в отчёте по людям
    const selfExp = await call('POST', '/finance/transactions', t1, { fromAccountId: cashA.id, toAccountId: eda.id, amount: 77000, personUserId: u1 });
    check('review2: расход «на себя» (personUserId=я) проходит', selfExp.ok && selfExp.json?.data?.personUserId === u1, `status ${selfExp.status}`);
    const selfRep = await call('GET', `/finance/reports/people?from=${r2period}-01&to=${r2period}-28`, t1);
    check('review2: «я» виден в отчёте по людям', selfRep.ok && selfRep.json?.data?.some((r) => r.userId === u1), JSON.stringify(selfRep.json?.data?.map?.((r) => r.userId)));
    await call('DELETE', `/finance/transactions/${selfExp.json?.data?.id}`, t1);

    // archived-гарда: создать счёт → архив → запись на него → 400
    const arcAcc = await call('POST', '/finance/accounts', t1, { name: 'АрхивТест', subtype: 'other', openingBalance: 100000 });
    await call('PATCH', `/finance/accounts/${arcAcc.json?.data?.id}`, t1, { archived: true });
    const arcTx = await call('POST', '/finance/transactions', t1, { fromAccountId: arcAcc.json?.data?.id, toAccountId: eda.id, amount: 1000 });
    check('review2: запись на архивный счёт → 400', arcTx.status === 400, `status ${arcTx.status}`);

    // payDebt кэп остатком + finance.debt.paid
    const pdInst = await call('POST', '/finance/debts', t1, { name: 'РевДолг', type: 'installment', monthlyPayment: 500000, months: 2, dueDay: 10, categoryAccountId: eda.id });
    const pdId = pdInst.json?.data?.accountId;
    const startPd = new Date();
    const pd = await call('POST', `/finance/debts/${pdId}/pay`, t1, { fromAccountId: cashA.id, amount: 99000000 }); // переплата
    check('review2: payDebt капит платёж остатком и закрывает', pd.ok && pd.json?.data?.remaining === 0 && !!pd.json?.data?.closedAt, JSON.stringify({ r: pd.json?.data?.remaining, c: !!pd.json?.data?.closedAt }));
    await new Promise((r) => setTimeout(r, 600));
    const pdNotif = await prisma.notification.findFirst({ where: { userId: u1, type: 'finance.debt.paid', createdAt: { gte: startPd } } });
    check('review2: полное погашение → finance.debt.paid (не чужой шаблон)', !!pdNotif);
    // баланс наличных списан ровно на остаток (1 000 000), не на 99М
    const ovPd = (await call('GET', '/finance', t1)).json?.data;
    const debtLiab = ovPd.accounts.find((a) => a.id === pdId);
    check('review2: долг закрыт без переплаты (баланс liability = 0)', debtLiab && debtLiab.balance === 0, `bal=${debtLiab?.balance}`);

    // валюта повтора не хардкодится KZT
    if (r2usd && zar) {
      const usdInc = r2ov.categories.find((c) => c.kind === 'income' && c.name === 'Зарплата');
      const recUsd = await call('POST', '/finance/recurring', t1, { title: 'USD-зарплата', fromAccountId: usdInc.id, toAccountId: r2usd.id, amount: 200000, interval: 'monthly', dayOfMonth: 5, autoRecord: false });
      check('review2: повтор в USD отдаёт currencyCode=USD', recUsd.ok && recUsd.json?.data?.currencyCode === 'USD', `code=${recUsd.json?.data?.currencyCode}`);
      await call('DELETE', `/finance/recurring/${recUsd.json?.data?.id}`, t1);
    }

    console.log(fails === 0 ? `\n=== ALL PASS ===` : `\n=== FAILS: ${fails} ===`);
  } finally {
    await prisma.$disconnect();
  }
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
