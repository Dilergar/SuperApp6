import { Injectable } from '@nestjs/common';
import { assertAdultForPayment } from './adult-gate';
import { Prisma } from '@prisma/client';
import { WALLET_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, notFound } from '../../shared/errors/api-error';

type Tx = Prisma.TransactionClient;

interface AccountState {
  id: string;
  balance: bigint;
  held: bigint;
  allowNegative: boolean;
}

/**
 * Double-entry ledger mechanics over a typed chart of accounts — the single source of truth for
 * every balance. It knows nothing about currency ownership rules or escrow policy (those live in
 * the higher-level services); it only moves integer minor units correctly and safely:
 *
 *  - money is never created/destroyed, only moved between accounts; mint comes FROM an issuance
 *    account (which goes negative), so per currency Σ(all account balances) = 0;
 *  - every mutation appends an immutable row to `ledger_transfers` (never updates a row) AND
 *    updates the materialized `accounts` cache (balance + held) inside the SAME transaction;
 *  - the account row is locked (SELECT … FOR UPDATE) before a spend, so concurrent spends can't
 *    both pass the same check (no double-spend);
 *  - holds are TWO-PHASE: `createPending` reserves on the payer (held += amount) with no settlement;
 *    `postPending` settles it (payer → beneficiary); `voidPending` releases it. Each phase is its
 *    own immutable row — a hold is fully auditable, never a bare mutable counter;
 *  - user wallets may NOT go negative; only system accounts (issuance) set allowNegative.
 *
 * Methods that open transactions accept an optional `tx` so callers can compose them; the two-phase
 * primitives always run inside the caller's transaction.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly db: DatabaseService) {}

  private run<T>(tx: Tx | undefined, fn: (t: Tx) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : this.db.$transaction(fn);
  }

  // ============================================================
  // Chart of accounts
  // ============================================================

  /** A holder's wallet account for a currency (liability; no overdraft). Created on first use. */
  getOrCreateUserAccount(tx: Tx, currencyId: string, userId: string) {
    return this.getOrCreateHolderAccount(tx, currencyId, 'user', userId);
  }

  /** A holder's wallet account for ANY owner (a user OR a workspace treasury, B2B P9). No overdraft. */
  getOrCreateHolderAccount(tx: Tx, currencyId: string, ownerType: string, ownerId: string) {
    return this.getOrCreateAccount(tx, {
      currencyId,
      type: 'user',
      ownerType,
      ownerId,
      allowNegative: false,
    });
  }

  /** The currency's issuance account — source of minted coins; goes negative. One per currency. */
  getOrCreateIssuanceAccount(tx: Tx, currencyId: string) {
    return this.getOrCreateAccount(tx, {
      currencyId,
      type: 'issuance',
      ownerType: 'system',
      ownerId: currencyId,
      allowNegative: true,
    });
  }

  private async getOrCreateAccount(
    tx: Tx,
    a: { currencyId: string; type: string; ownerType: string; ownerId: string; allowNegative: boolean },
  ) {
    const key = {
      currencyId_type_ownerType_ownerId: {
        currencyId: a.currencyId,
        type: a.type,
        ownerType: a.ownerType,
        ownerId: a.ownerId,
      },
    };
    const existing = await tx.account.findUnique({ where: key });
    if (existing) return existing;
    try {
      return await tx.account.create({ data: a });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return (await tx.account.findUnique({ where: key }))!; // concurrent create — take the winner
      }
      throw err;
    }
  }

  /** Lock account rows FOR UPDATE in a stable (sorted) order to avoid deadlocks. */
  private async lock(tx: Tx, ids: string[]): Promise<Map<string, AccountState>> {
    const map = new Map<string, AccountState>();
    for (const id of [...new Set(ids)].sort()) {
      const rows = await tx.$queryRaw<Array<{ balance: bigint; held: bigint; allow_negative: boolean }>>(
        Prisma.sql`SELECT balance, held, allow_negative FROM accounts WHERE id = ${id} FOR UPDATE`,
      );
      if (rows.length === 0) throw notFound('wallet.accountNotFound');
      map.set(id, { id, balance: rows[0].balance, held: rows[0].held, allowNegative: rows[0].allow_negative });
    }
    return map;
  }

  private write(tx: Tx, id: string, balance: bigint, held: bigint) {
    return tx.account.update({ where: { id }, data: { balance, held } });
  }

  private toBig(amount: number): bigint {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw badRequest('wallet.amountPositiveInt');
    }
    return BigInt(amount);
  }

  /**
   * Второй ремень идемпотентности, проверка ПОСЛЕ блокировки счетов. Проверки «до»
   * мало: две одновременные проводки с одним ключом обе видят «дубля нет», и вторая
   * падает на уникуме — а конфликт уникума внутри транзакции Postgres абортит её ВСЮ,
   * то есть вместо тихого «уже сделано» человек получал 500. Блокировка счетов — точка
   * сериализации: вторая ждёт коммита первой и (READ COMMITTED) уже видит её проводку.
   */
  private async appliedAlready(tx: Tx, idempotencyKey: string | null | undefined): Promise<bigint | null> {
    if (!idempotencyKey) return null;
    const dup = await tx.ledgerTransfer.findUnique({ where: { idempotencyKey }, select: { id: true } });
    return dup?.id ?? null;
  }

  /** Append an immutable journal row. Returns its id, or null if an idempotency key collided. */
  private async append(
    tx: Tx,
    t: {
      currencyId: string;
      debitAccountId: string;
      creditAccountId: string;
      amount: bigint;
      kind: string;
      pendingId?: bigint | null;
      agreementId?: string | null;
      idempotencyKey?: string | null;
      memo?: string | null;
    },
  ): Promise<bigint | null> {
    try {
      const row = await tx.ledgerTransfer.create({
        data: {
          currencyId: t.currencyId,
          debitAccountId: t.debitAccountId,
          creditAccountId: t.creditAccountId,
          amount: t.amount,
          kind: t.kind,
          pendingId: t.pendingId ?? null,
          agreementId: t.agreementId ?? null,
          idempotencyKey: t.idempotencyKey ?? null,
          memo: t.memo ?? null,
        },
      });
      return row.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return null; // duplicate idempotency key → already applied
      }
      throw err;
    }
  }

  // ============================================================
  // Posted movements
  // ============================================================

  /**
   * Self-emission: a posted transfer issuance → user. Double-entry, so the books always balance and
   * issuance is auditable. Enforces the "in hand" ceiling (a user's own balance ≤ maxInHand).
   * Ownership of the currency is validated by the caller (CurrencyService).
   */
  async mint(
    input: {
      currencyId: string;
      ownerType?: string;
      ownerId: string;
      amount: number;
      /**
       * Откуда ценность. ОБЯЗАТЕЛЬНО для платформенной валюты (`issuerType = platform`) — её
       * чеканка и есть единственная дверь реальных денег на платформу: `real_money` — оплата
       * человеком (платёжный рельс, внешнее пополнение) → проверяется совершеннолетие
       * (`403 payments.minorNotAllowed`); `system` — начисление платформы без денег человека
       * (дев-пополнение, бонус, возврат). Рельс не может «забыть» проверку: без поля чеканка
       * платформенной валюты падает. Семейные и корпоративные коины поля не требуют.
       */
      funding?: 'real_money' | 'system';
      /**
       * Второй ремень идемпотентности (docs/idempotency_engine.md): производный ключ
       * запроса. Переживает строку `idem.keys` (та живёт 7 дней), поэтому повтор
       * перевода даже через месяц не создаёт второй проводки.
       */
      idempotencyKey?: string;
    },
    tx?: Tx,
  ): Promise<void> {
    const amount = this.toBig(input.amount);
    await this.run(tx, async (t) => {
      // Повтор по производному ключу: проводка уже есть — ничего не делаем и не
      // трогаем остатки. Проверка ДО вставки, а не ловля P2002 после: конфликт
      // уникума внутри транзакции Postgres абортит ВСЮ транзакцию вызывающего.
      if (input.idempotencyKey && (await t.ledgerTransfer.findUnique({ where: { idempotencyKey: input.idempotencyKey } }))) return;
      const currency = await t.currency.findUnique({ where: { id: input.currencyId }, select: { issuerType: true } });
      if (currency?.issuerType === 'platform') {
        if (!input.funding) throw new Error('ledger.mint: `funding` is required for the platform currency (real_money | system)');
        if (input.funding === 'real_money' && (input.ownerType ?? 'user') === 'user') await assertAdultForPayment(this.db, input.ownerId);
      }
      const issuance = await this.getOrCreateIssuanceAccount(t, input.currencyId);
      const user = await this.getOrCreateHolderAccount(t, input.currencyId, input.ownerType ?? 'user', input.ownerId);
      const locks = await this.lock(t, [issuance.id, user.id]);
      if ((await this.appliedAlready(t, input.idempotencyKey)) !== null) return;
      const i = locks.get(issuance.id)!;
      const u = locks.get(user.id)!;
      if (u.balance + amount > BigInt(WALLET_LIMITS.maxInHand)) {
        throw badRequest('wallet.mintCap', { max: WALLET_LIMITS.maxInHand });
      }
      await this.append(t, {
        currencyId: input.currencyId,
        debitAccountId: issuance.id,
        creditAccountId: user.id,
        amount,
        kind: 'posted',
        memo: 'mint',
        idempotencyKey: input.idempotencyKey,
      });
      await this.write(t, issuance.id, i.balance - amount, i.held);
      await this.write(t, user.id, u.balance + amount, u.held);
    });
  }

  /** Irreversibly destroy coins from a holder's balance: a posted transfer holder → issuance. */
  async burn(
    input: { currencyId: string; ownerType?: string; ownerId: string; amount: number; idempotencyKey?: string },
    tx?: Tx,
  ): Promise<void> {
    const amount = this.toBig(input.amount);
    await this.run(tx, async (t) => {
      // Повтор по производному ключу: проводка уже есть — ничего не делаем и не
      // трогаем остатки. Проверка ДО вставки, а не ловля P2002 после: конфликт
      // уникума внутри транзакции Postgres абортит ВСЮ транзакцию вызывающего.
      if (input.idempotencyKey && (await t.ledgerTransfer.findUnique({ where: { idempotencyKey: input.idempotencyKey } }))) return;
      const holder = await this.getOrCreateHolderAccount(t, input.currencyId, input.ownerType ?? 'user', input.ownerId);
      const issuance = await this.getOrCreateIssuanceAccount(t, input.currencyId);
      const locks = await this.lock(t, [holder.id, issuance.id]);
      if ((await this.appliedAlready(t, input.idempotencyKey)) !== null) return;
      const h = locks.get(holder.id)!;
      const i = locks.get(issuance.id)!;
      if (h.balance - h.held - amount < 0n) {
        throw badRequest('wallet.burnInsufficient');
      }
      await this.append(t, {
        currencyId: input.currencyId,
        debitAccountId: holder.id,
        creditAccountId: issuance.id,
        amount,
        kind: 'posted',
        memo: 'burn',
        idempotencyKey: input.idempotencyKey,
      });
      await this.write(t, holder.id, h.balance - amount, h.held);
      await this.write(t, issuance.id, i.balance + amount, i.held);
    });
  }

  /**
   * Posted transfer between two accounts. Checks available (balance − held) on the debit side unless
   * that account allows negative. Returns the transfer id (idempotent on idempotencyKey).
   */
  async transfer(
    tx: Tx,
    input: {
      currencyId: string;
      fromAccountId: string;
      toAccountId: string;
      amount: number;
      agreementId?: string | null;
      idempotencyKey?: string;
      memo?: string | null;
    },
  ): Promise<bigint | null> {
    if (input.fromAccountId === input.toAccountId) {
      throw badRequest('wallet.selfTransfer');
    }
    const amount = this.toBig(input.amount);
    if (input.idempotencyKey) {
      const dup = await tx.ledgerTransfer.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (dup) return dup.id;
    }
    const locks = await this.lock(tx, [input.fromAccountId, input.toAccountId]);
    const applied = await this.appliedAlready(tx, input.idempotencyKey);
    if (applied !== null) return applied;
    const from = locks.get(input.fromAccountId)!;
    const to = locks.get(input.toAccountId)!;
    if (!from.allowNegative && from.balance - from.held - amount < 0n) {
      throw badRequest('wallet.insufficientFunds');
    }
    const id = await this.append(tx, {
      currencyId: input.currencyId,
      debitAccountId: from.id,
      creditAccountId: to.id,
      amount,
      kind: 'posted',
      agreementId: input.agreementId,
      idempotencyKey: input.idempotencyKey,
      memo: input.memo,
    });
    if (id === null) {
      // Lost an idempotency race; the winning tx already applied the balances.
      const dup = input.idempotencyKey
        ? await tx.ledgerTransfer.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
        : null;
      return dup?.id ?? null;
    }
    await this.write(tx, from.id, from.balance - amount, from.held);
    await this.write(tx, to.id, to.balance + amount, to.held);
    return id;
  }

  // ============================================================
  // Two-phase holds (authorization → capture / void)
  // ============================================================

  /** Reserve `amount` on the payer account toward the beneficiary (the escrow freeze). */
  async createPending(
    tx: Tx,
    input: {
      currencyId: string;
      payerAccountId: string;
      beneficiaryAccountId: string;
      amount: number;
      agreementId?: string | null;
      memo?: string | null;
    },
  ): Promise<bigint> {
    const amount = this.toBig(input.amount);
    const locks = await this.lock(tx, [input.payerAccountId]);
    const payer = locks.get(input.payerAccountId)!;
    if (!payer.allowNegative && payer.balance - payer.held - amount < 0n) {
      throw badRequest('wallet.insufficientCurrencyBalance');
    }
    const id = await this.append(tx, {
      currencyId: input.currencyId,
      debitAccountId: input.payerAccountId,
      creditAccountId: input.beneficiaryAccountId,
      amount,
      kind: 'pending',
      agreementId: input.agreementId,
      memo: input.memo,
    });
    await this.write(tx, payer.id, payer.balance, payer.held + amount);
    return id!;
  }

  /** Settle a prior pending: move the reserved amount payer → beneficiary. Idempotent. */
  async postPending(tx: Tx, pendingId: bigint): Promise<bigint | null> {
    const pending = await tx.ledgerTransfer.findUnique({ where: { id: pendingId } });
    if (!pending || pending.kind !== 'pending') return null;
    if (await this.isResolved(tx, pendingId)) return null; // cheap pre-check (no locks yet)
    const amount = pending.amount;
    const locks = await this.lock(tx, [pending.debitAccountId, pending.creditAccountId]);
    // Re-check AFTER the payer row lock: a concurrent post/void serialises on that lock, so the
    // loser of the race sees the winner's resolution row here (READ COMMITTED re-reads). Without
    // this, two parallel settles both pass the pre-check → double payout.
    if (await this.isResolved(tx, pendingId)) return null;
    const payer = locks.get(pending.debitAccountId)!;
    const bene = locks.get(pending.creditAccountId)!;
    const id = await this.append(tx, {
      currencyId: pending.currencyId,
      debitAccountId: payer.id,
      creditAccountId: bene.id,
      amount,
      kind: 'post_pending',
      pendingId,
      agreementId: pending.agreementId,
    });
    // Belt: the partial-unique on (pending_id) for resolution kinds makes a second resolution
    // physically impossible — a violation aborts this tx (full rollback, no money moved).
    if (id === null) return null;
    await this.write(tx, payer.id, payer.balance - amount, payer.held - amount);
    await this.write(tx, bene.id, bene.balance + amount, bene.held);
    return id;
  }

  /** Cancel a prior pending: release the reservation back to the payer. Idempotent. */
  async voidPending(tx: Tx, pendingId: bigint): Promise<void> {
    const pending = await tx.ledgerTransfer.findUnique({ where: { id: pendingId } });
    if (!pending || pending.kind !== 'pending') return;
    if (await this.isResolved(tx, pendingId)) return; // cheap pre-check (no locks yet)
    const amount = pending.amount;
    const locks = await this.lock(tx, [pending.debitAccountId]);
    // Re-check AFTER the payer row lock (post/void both lock the payer → fully serialised).
    if (await this.isResolved(tx, pendingId)) return;
    const payer = locks.get(pending.debitAccountId)!;
    const id = await this.append(tx, {
      currencyId: pending.currencyId,
      debitAccountId: pending.debitAccountId,
      creditAccountId: pending.creditAccountId,
      amount,
      kind: 'void_pending',
      pendingId,
    });
    if (id === null) return; // partial-unique belt — already resolved
    const held = payer.held - amount;
    await this.write(tx, payer.id, payer.balance, held < 0n ? 0n : held);
  }

  private async isResolved(tx: Tx, pendingId: bigint): Promise<boolean> {
    const resolved = await tx.ledgerTransfer.findFirst({
      where: { pendingId, kind: { in: ['post_pending', 'void_pending'] } },
      select: { id: true },
    });
    return resolved !== null;
  }

  // ============================================================
  // Reads & reconciliation
  // ============================================================

  getBalance(userId: string, currencyId: string): Promise<{ balance: number; held: number; available: number }> {
    return this.getBalanceFor('user', userId, currencyId);
  }

  /** Materialized balance/held/available for any holder (user OR workspace treasury). */
  async getBalanceFor(
    ownerType: string,
    ownerId: string,
    currencyId: string,
  ): Promise<{ balance: number; held: number; available: number }> {
    const acct = await this.db.account.findUnique({
      where: { currencyId_type_ownerType_ownerId: { currencyId, type: 'user', ownerType, ownerId } },
    });
    const balance = acct?.balance ?? 0n;
    const held = acct?.held ?? 0n;
    return { balance: Number(balance), held: Number(held), available: Number(balance - held) };
  }

  /** Rebuild an account's materialized balance + held from the journal (reconciliation / repair). */
  async recompute(accountId: string): Promise<void> {
    await this.db.$transaction(async (t) => {
      await this.lock(t, [accountId]);
      const credits = await t.ledgerTransfer.aggregate({
        where: { creditAccountId: accountId, kind: { in: ['posted', 'post_pending'] } },
        _sum: { amount: true },
      });
      const debits = await t.ledgerTransfer.aggregate({
        where: { debitAccountId: accountId, kind: { in: ['posted', 'post_pending'] } },
        _sum: { amount: true },
      });
      const balance = (credits._sum.amount ?? 0n) - (debits._sum.amount ?? 0n);

      const pending = await t.ledgerTransfer.aggregate({
        where: { debitAccountId: accountId, kind: 'pending' },
        _sum: { amount: true },
      });
      const resolved = await t.ledgerTransfer.aggregate({
        where: { debitAccountId: accountId, kind: { in: ['post_pending', 'void_pending'] } },
        _sum: { amount: true },
      });
      const held = (pending._sum.amount ?? 0n) - (resolved._sum.amount ?? 0n);

      await this.write(t, accountId, balance, held < 0n ? 0n : held);
    });
  }

  /**
   * Reconciliation invariant: per currency, the sum of every account's posted balance is 0 (money
   * is conserved — issuance is the negative counterweight to all circulating coins). Returns the
   * net per currency; a non-zero value means a leak/bug. Used by e2e and ops checks.
   */
  async reconcileCurrency(currencyId: string): Promise<{ net: bigint; ok: boolean }> {
    const sum = await this.db.account.aggregate({
      where: { currencyId },
      _sum: { balance: true },
    });
    const net = sum._sum.balance ?? 0n;
    return { net, ok: net === 0n };
  }
}
