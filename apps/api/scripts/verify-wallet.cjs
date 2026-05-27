/* eslint-disable */
// One-off functional check for Phase 1 (ledger core). Spins up the REAL LedgerService on
// the extended Prisma client (no full Nest boot — lighter). Uses fixed fake UUIDs (the
// ledger is FK-free) and cleans up after itself. Run: `node scripts/verify-wallet.cjs`
const fs = require('fs');
const path = require('path');

// Load apps/api/.env into process.env (PrismaClient reads process.env at runtime).
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

  const wipe = async () => {
    await db.ledgerEntry.deleteMany({ where: { currencyId: C } });
    await db.escrowHold.deleteMany({ where: { currencyId: C } });
    await db.walletBalance.deleteMany({ where: { currencyId: C } });
    await db.currency.deleteMany({ where: { id: C } });
  };

  try {
    await wipe();
    await db.currency.create({
      data: { id: C, issuerType: 'user', issuerId: A, name: 'ТестКоин', icon: '🪙' },
    });

    // A2 — mint 1000 to issuer A
    await ledger.mint({ currencyId: C, ownerUserId: A, amount: 1000 });
    let a = await ledger.getBalance(A, C);
    check('mint 1000 → A.balance=1000, available=1000', a.balance === 1000 && a.available === 1000, JSON.stringify(a));

    // A3 — emission cap (1000 + 9_999_999 > 10_000_000)
    await expectThrow('лимит эмиссии 10М срабатывает', () =>
      ledger.mint({ currencyId: C, ownerUserId: A, amount: 9_999_999 }),
    );

    // A4 — transfer 300 A→B (generic, available-checked)
    const t1 = await ledger.transfer({ currencyId: C, fromUserId: A, toUserId: B, amount: 300 });
    a = await ledger.getBalance(A, C);
    let b = await ledger.getBalance(B, C);
    check('перевод 300 A→B → A=700, B=300', a.balance === 700 && b.balance === 300, `A=${a.balance} B=${b.balance}`);

    // A5 — overspend rejected
    await expectThrow('перевод больше доступного отклонён', () =>
      ledger.transfer({ currencyId: C, fromUserId: A, toUserId: B, amount: 99999 }),
    );

    // A6 — idempotency: same key twice applies once
    await ledger.transfer({ currencyId: C, fromUserId: A, toUserId: B, amount: 50, idempotencyKey: 'idem1' });
    await ledger.transfer({ currencyId: C, fromUserId: A, toUserId: B, amount: 50, idempotencyKey: 'idem1' });
    a = await ledger.getBalance(A, C);
    b = await ledger.getBalance(B, C);
    check('идемпотентность: повтор не задвоил → A=650, B=350', a.balance === 650 && b.balance === 350, `A=${a.balance} B=${b.balance}`);

    // A7 — burn 100 from B
    await ledger.burn({ currencyId: C, holderUserId: B, amount: 100 });
    b = await ledger.getBalance(B, C);
    check('сжигание 100 у B → B=250', b.balance === 250, `B=${b.balance}`);

    // A8 — reverse the A4 transfer (300): A +300, B −300 → B goes NEGATIVE
    await ledger.reverse({ transferId: t1 });
    a = await ledger.getBalance(A, C);
    b = await ledger.getBalance(B, C);
    check('возврат после сжигания → A=950, B=-50 (минус разрешён)', a.balance === 950 && b.balance === -50, `A=${a.balance} B=${b.balance}`);

    // A9 — preReserved capture: simulate a hold on A, then transfer preReserved
    await db.$executeRawUnsafe(
      `UPDATE wallet_balances SET held_amount = 100 WHERE account_user_id = $1 AND currency_id = $2`,
      A, C,
    );
    await db.escrowHold.create({
      data: { currencyId: C, taskId: '00000000-0000-4000-8000-00000000d001', participantUserId: B, creatorUserId: A, amount: 100, status: 'active' },
    });
    a = await ledger.getBalance(A, C);
    check('заморозка 100 у A → available=850 (balance 950 − held 100)', a.held === 100 && a.available === 850, JSON.stringify(a));
    await ledger.transfer({ currencyId: C, fromUserId: A, toUserId: B, amount: 100, preReserved: true });
    a = await ledger.getBalance(A, C);
    b = await ledger.getBalance(B, C);
    check('capture preReserved → A balance=850 held=0, B=50', a.balance === 850 && a.held === 0 && b.balance === 50, `A=${JSON.stringify(a)} B=${b.balance}`);

    // A10 — recompute rebuilds the cache from the journal (corrupt then fix)
    await db.$executeRawUnsafe(
      `UPDATE wallet_balances SET balance = 123456 WHERE account_user_id = $1 AND currency_id = $2`,
      A, C,
    );
    await db.escrowHold.updateMany({ where: { currencyId: C }, data: { status: 'captured' } }); // no active holds → held should recompute to 0
    await ledger.recompute(A, C);
    a = await ledger.getBalance(A, C);
    check('recompute восстановил баланс из журнала → A=850, held=0', a.balance === 850 && a.held === 0, JSON.stringify(a));

    // Ledger immutability sanity: count entries (mint + 2×t1 + 2×idem + burn + 2×reverse + 2×capture = 10)
    const entryCount = await db.ledgerEntry.count({ where: { currencyId: C } });
    check('журнал append-only: накоплены проводки', entryCount === 10, `entries=${entryCount}`);
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
