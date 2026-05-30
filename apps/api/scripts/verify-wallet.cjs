/* eslint-disable */
// Phase 1 unit check for the double-entry ledger. Spins up the REAL LedgerService on the extended
// Prisma client (no full Nest boot). Fake UUIDs for owners (the journal is FK-free on accounts).
// Exercises: mint from issuance, emission cap, posted transfer + available check, idempotency,
// burn, two-phase hold (createPending → postPending / voidPending), recompute, and the
// per-currency conservation invariant (Σ account balances = 0). Run: `node scripts/verify-wallet.cjs`
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { buildScopedPrismaClient } = require('../dist/shared/database/database.service');
const { WorkspaceContextService } = require('../dist/shared/context/workspace-context.service');
const { LedgerService } = require('../dist/modules/wallet/ledger.service');

const C = '00000000-0000-4000-8000-00000000c0de';
const A = '00000000-0000-4000-8000-00000000a000';
const B = '00000000-0000-4000-8000-00000000b000';

let fails = 0;
function check(name, ok, extra) {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!ok) fails++;
}
async function expectThrow(name, fn) {
  try {
    await fn();
    check(name, false, 'ожидалась ошибка, но её не было');
  } catch (e) {
    check(name, true, `отклонено: ${String(e.message).slice(0, 50)}`);
  }
}

async function main() {
  const db = buildScopedPrismaClient(new WorkspaceContextService());
  await db.$connect();
  const ledger = new LedgerService(db);

  const accId = (owner) =>
    db.account
      .findUnique({ where: { currencyId_type_ownerType_ownerId: { currencyId: C, type: 'user', ownerType: 'user', ownerId: owner } } })
      .then((a) => a && a.id);
  const issuanceBal = async () => {
    const a = await db.account.findFirst({ where: { currencyId: C, type: 'issuance' } });
    return a ? a.balance : 0n;
  };
  const net = async () => (await ledger.reconcileCurrency(C)).net;

  const wipe = async () => {
    await db.ledgerTransfer.deleteMany({ where: { currencyId: C } });
    await db.escrowHold.deleteMany({ where: { currencyId: C } });
    await db.account.deleteMany({ where: { currencyId: C } });
    await db.currency.deleteMany({ where: { id: C } });
  };

  try {
    await wipe();
    await db.currency.create({ data: { id: C, issuerType: 'user', issuerId: A, name: 'ТестКоин', icon: '🪙', scale: 0 } });

    // mint 1000 → A (issuance → A); double-entry, conservation holds
    await ledger.mint({ currencyId: C, ownerId: A, amount: 1000 });
    let a = await ledger.getBalance(A, C);
    check('mint 1000 → A.balance=1000, available=1000', a.balance === 1000 && a.available === 1000, JSON.stringify(a));
    check('issuance = −1000 (источник эмиссии)', (await issuanceBal()) === -1000n);
    check('инвариант после эмиссии: Σ = 0', (await net()) === 0n);

    // emission cap
    await expectThrow('лимит эмиссии 10М срабатывает', () => ledger.mint({ currencyId: C, ownerId: A, amount: 9_999_999 }));

    // posted transfer A→B 300 (accounts resolved inside a tx)
    await db.$transaction(async (t) => {
      const from = (await ledger.getOrCreateUserAccount(t, C, A)).id;
      const to = (await ledger.getOrCreateUserAccount(t, C, B)).id;
      await ledger.transfer(t, { currencyId: C, fromAccountId: from, toAccountId: to, amount: 300 });
    });
    a = await ledger.getBalance(A, C);
    let b = await ledger.getBalance(B, C);
    check('перевод 300 A→B → A=700, B=300', a.balance === 700 && b.balance === 300, `A=${a.balance} B=${b.balance}`);
    check('инвариант после перевода: Σ = 0', (await net()) === 0n);

    // overspend rejected (no negative on user wallet)
    await expectThrow('перевод больше доступного отклонён', () =>
      db.$transaction(async (t) => {
        const from = (await ledger.getOrCreateUserAccount(t, C, A)).id;
        const to = (await ledger.getOrCreateUserAccount(t, C, B)).id;
        await ledger.transfer(t, { currencyId: C, fromAccountId: from, toAccountId: to, amount: 99999 });
      }),
    );

    // idempotency: same key twice applies once (A=650, B=350)
    for (let i = 0; i < 2; i++) {
      await db.$transaction(async (t) => {
        const from = (await ledger.getOrCreateUserAccount(t, C, A)).id;
        const to = (await ledger.getOrCreateUserAccount(t, C, B)).id;
        await ledger.transfer(t, { currencyId: C, fromAccountId: from, toAccountId: to, amount: 50, idempotencyKey: 'idem1' });
      });
    }
    a = await ledger.getBalance(A, C);
    b = await ledger.getBalance(B, C);
    check('идемпотентность: повтор не задвоил → A=650, B=350', a.balance === 650 && b.balance === 350, `A=${a.balance} B=${b.balance}`);

    // burn 100 from B → B=250
    await ledger.burn({ currencyId: C, ownerId: B, amount: 100 });
    b = await ledger.getBalance(B, C);
    check('сжигание 100 у B → B=250', b.balance === 250, `B=${b.balance}`);
    check('инвариант после сжигания: Σ = 0', (await net()) === 0n);

    // two-phase: createPending A→B 100 (held), then postPending settles
    let pendingId;
    await db.$transaction(async (t) => {
      const p = (await ledger.getOrCreateUserAccount(t, C, A)).id;
      const ben = (await ledger.getOrCreateUserAccount(t, C, B)).id;
      pendingId = await ledger.createPending(t, { currencyId: C, payerAccountId: p, beneficiaryAccountId: ben, amount: 100 });
    });
    a = await ledger.getBalance(A, C);
    check('заморозка 100 у A → held=100, available=550', a.held === 100 && a.available === 550, JSON.stringify(a));
    await db.$transaction((t) => ledger.postPending(t, pendingId));
    a = await ledger.getBalance(A, C);
    b = await ledger.getBalance(B, C);
    check('проведение pending → A=550 held=0, B=350', a.balance === 550 && a.held === 0 && b.balance === 350, `A=${JSON.stringify(a)} B=${b.balance}`);
    check('повторное проведение идемпотентно (no-op)', (await db.$transaction((t) => ledger.postPending(t, pendingId))) === null);

    // two-phase void: createPending then voidPending releases the hold
    let pid2;
    await db.$transaction(async (t) => {
      const p = (await ledger.getOrCreateUserAccount(t, C, A)).id;
      const ben = (await ledger.getOrCreateUserAccount(t, C, B)).id;
      pid2 = await ledger.createPending(t, { currencyId: C, payerAccountId: p, beneficiaryAccountId: ben, amount: 100 });
    });
    a = await ledger.getBalance(A, C);
    check('вторая заморозка → held=100', a.held === 100, JSON.stringify(a));
    await db.$transaction((t) => ledger.voidPending(t, pid2));
    a = await ledger.getBalance(A, C);
    check('отмена pending → held=0, balance=550', a.held === 0 && a.balance === 550, JSON.stringify(a));

    // recompute rebuilds the cache from the journal
    const idA = await accId(A);
    await db.$executeRawUnsafe(`UPDATE accounts SET balance = 123456, held = 777 WHERE id = $1`, idA);
    await ledger.recompute(idA);
    a = await ledger.getBalance(A, C);
    check('recompute восстановил из журнала → A=550, held=0', a.balance === 550 && a.held === 0, JSON.stringify(a));

    // journal is append-only: mint + transfer + idem + burn + pending + post + pending2 + void = 8
    const count = await db.ledgerTransfer.count({ where: { currencyId: C } });
    check('журнал append-only: 8 проводок', count === 8, `rows=${count}`);
    check('финальный инвариант: Σ = 0', (await net()) === 0n);
  } finally {
    await wipe();
    await db.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
