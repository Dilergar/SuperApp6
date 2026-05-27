import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { WALLET_LIMITS } from '@superapp/shared';
import type { LedgerEntryType } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';

type Tx = Prisma.TransactionClient;

interface BalanceRow {
  balance: bigint;
  held: bigint;
}

/**
 * Low-level mechanics of the immutable ledger — the single source of truth for every
 * balance. Knows nothing about currencies' ownership rules, tasks or escrow policy (those
 * live in the higher-level services); it only moves integers correctly and safely:
 *
 *  - every mutation appends to `ledger_entries` (never updates a row) AND updates the
 *    materialized `wallet_balances` cache inside the SAME transaction;
 *  - the balance row is locked (INSERT … ON CONFLICT … = lock-or-create) before reads on a
 *    spend, so concurrent spends can't both pass the same check (no double-spend);
 *  - amounts are BigInt; balances may go negative (reversal of already-burned coins).
 *
 * Methods accept an optional `tx` so a caller (e.g. the task-escrow flow) can compose them
 * inside its own transaction; without it, each call opens its own.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly db: DatabaseService) {}

  private run<T>(tx: Tx | undefined, fn: (t: Tx) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : this.db.$transaction(fn);
  }

  /** Lock-or-create the (account, currency) balance row; returns its current values. */
  private async lockBalance(
    tx: Tx,
    accountUserId: string,
    currencyId: string,
  ): Promise<BalanceRow> {
    const rows = await tx.$queryRaw<Array<{ balance: bigint; held_amount: bigint }>>(Prisma.sql`
      INSERT INTO wallet_balances (id, account_user_id, currency_id, balance, held_amount, updated_at)
      VALUES (${randomUUID()}, ${accountUserId}, ${currencyId}, 0, 0, now())
      ON CONFLICT (account_user_id, currency_id)
      DO UPDATE SET updated_at = now()
      RETURNING balance, held_amount
    `);
    return { balance: rows[0].balance, held: rows[0].held_amount };
  }

  private async writeBalance(
    tx: Tx,
    accountUserId: string,
    currencyId: string,
    balance: bigint,
    held: bigint,
  ): Promise<void> {
    await tx.walletBalance.update({
      where: { accountUserId_currencyId: { accountUserId, currencyId } },
      data: { balance, heldAmount: held },
    });
  }

  /** Append one immutable journal line. Returns false if an idempotency key collided. */
  private async postEntry(
    tx: Tx,
    e: {
      currencyId: string;
      accountUserId: string;
      amount: bigint;
      entryType: LedgerEntryType;
      transferId?: string | null;
      taskId?: string | null;
      idempotencyKey?: string | null;
      memo?: string | null;
    },
  ): Promise<boolean> {
    try {
      await tx.ledgerEntry.create({
        data: {
          currencyId: e.currencyId,
          accountUserId: e.accountUserId,
          amount: e.amount,
          entryType: e.entryType,
          transferId: e.transferId ?? null,
          taskId: e.taskId ?? null,
          idempotencyKey: e.idempotencyKey ?? null,
          memo: e.memo ?? null,
        },
      });
      return true;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return false; // duplicate idempotency key → already applied
      }
      throw err;
    }
  }

  private toBig(amount: number): bigint {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Сумма должна быть целым числом больше 0');
    }
    return BigInt(amount);
  }

  // ============================================================
  // Primitives
  // ============================================================

  /**
   * Self-emission. Enforces the "in hand" ceiling: an issuer's own balance (which equals
   * available + held, since held coins are a subset of the balance) may not exceed maxInHand.
   * Ownership of the currency is validated by the caller (CurrencyService).
   */
  async mint(
    input: { currencyId: string; ownerUserId: string; amount: number },
    tx?: Tx,
  ): Promise<void> {
    const amount = this.toBig(input.amount);
    await this.run(tx, async (t) => {
      const bal = await this.lockBalance(t, input.ownerUserId, input.currencyId);
      const next = bal.balance + amount;
      if (next > BigInt(WALLET_LIMITS.maxInHand)) {
        throw new BadRequestException(
          `Лимит эмиссии: «на руках» не может быть больше ${WALLET_LIMITS.maxInHand} монет`,
        );
      }
      await this.postEntry(t, {
        currencyId: input.currencyId,
        accountUserId: input.ownerUserId,
        amount,
        entryType: 'mint',
      });
      await this.writeBalance(t, input.ownerUserId, input.currencyId, next, bal.held);
    });
  }

  /** Irreversibly destroy coins from a holder's available balance. */
  async burn(
    input: { currencyId: string; holderUserId: string; amount: number },
    tx?: Tx,
  ): Promise<void> {
    const amount = this.toBig(input.amount);
    await this.run(tx, async (t) => {
      const bal = await this.lockBalance(t, input.holderUserId, input.currencyId);
      const available = bal.balance - bal.held;
      if (amount > available) {
        throw new BadRequestException('Недостаточно монет для сжигания');
      }
      await this.postEntry(t, {
        currencyId: input.currencyId,
        accountUserId: input.holderUserId,
        amount: -amount,
        entryType: 'burn',
      });
      await this.writeBalance(
        t,
        input.holderUserId,
        input.currencyId,
        bal.balance - amount,
        bal.held,
      );
    });
  }

  /**
   * Move coins between two users (two journal legs sharing a transferId). Generic primitive:
   *  - `preReserved` (escrow capture): the coins were already frozen on the sender, so we
   *    draw them from `held` and skip the available check;
   *  - otherwise (future P2P): the sender's available balance is checked.
   * Returns the transferId so the caller can later reverse it.
   */
  async transfer(
    input: {
      currencyId: string;
      fromUserId: string;
      toUserId: string;
      amount: number;
      taskId?: string | null;
      preReserved?: boolean;
      idempotencyKey?: string;
    },
    tx?: Tx,
  ): Promise<string> {
    if (input.fromUserId === input.toUserId) {
      throw new BadRequestException('Нельзя перевести самому себе');
    }
    const amount = this.toBig(input.amount);
    const transferId = randomUUID();
    await this.run(tx, async (t) => {
      if (input.idempotencyKey) {
        const dup = await t.ledgerEntry.findUnique({
          where: { idempotencyKey: `${input.idempotencyKey}:out` },
        });
        if (dup) return; // already applied
      }
      // Lock both rows in a stable (sorted) order to avoid deadlocks.
      const locks = new Map<string, BalanceRow>();
      for (const uid of [input.fromUserId, input.toUserId].sort()) {
        locks.set(uid, await this.lockBalance(t, uid, input.currencyId));
      }
      const from = locks.get(input.fromUserId)!;
      const to = locks.get(input.toUserId)!;

      if (input.preReserved) {
        await this.writeBalance(
          t,
          input.fromUserId,
          input.currencyId,
          from.balance - amount,
          from.held - amount,
        );
      } else {
        if (amount > from.balance - from.held) {
          throw new BadRequestException('Недостаточно монет');
        }
        await this.writeBalance(
          t,
          input.fromUserId,
          input.currencyId,
          from.balance - amount,
          from.held,
        );
      }
      await this.writeBalance(
        t,
        input.toUserId,
        input.currencyId,
        to.balance + amount,
        to.held,
      );

      await this.postEntry(t, {
        currencyId: input.currencyId,
        accountUserId: input.fromUserId,
        amount: -amount,
        entryType: 'transfer',
        transferId,
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:out` : null,
      });
      await this.postEntry(t, {
        currencyId: input.currencyId,
        accountUserId: input.toUserId,
        amount,
        entryType: 'transfer',
        transferId,
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:in` : null,
      });
    });
    return transferId;
  }

  /**
   * Reverse a prior transfer (e.g. a task returned after acceptance): post opposite legs.
   * The recipient's balance may go negative if they already burned the coins — that is by
   * design (they can't escape the reversal by burning).
   */
  async reverse(
    input: { transferId: string; idempotencyKey?: string; memo?: string },
    tx?: Tx,
  ): Promise<void> {
    await this.run(tx, async (t) => {
      if (input.idempotencyKey) {
        const dup = await t.ledgerEntry.findUnique({
          where: { idempotencyKey: `${input.idempotencyKey}:rev0` },
        });
        if (dup) return; // already reversed
      }
      const legs = await t.ledgerEntry.findMany({
        where: { transferId: input.transferId, entryType: 'transfer' },
        orderBy: { id: 'asc' },
      });
      if (legs.length === 0) {
        throw new NotFoundException('Транзакция для возврата не найдена');
      }
      const newTransferId = randomUUID();
      let i = 0;
      for (const leg of legs) {
        const bal = await this.lockBalance(t, leg.accountUserId, leg.currencyId);
        await this.writeBalance(
          t,
          leg.accountUserId,
          leg.currencyId,
          bal.balance - leg.amount, // flip the original delta
          bal.held,
        );
        await this.postEntry(t, {
          currencyId: leg.currencyId,
          accountUserId: leg.accountUserId,
          amount: -leg.amount,
          entryType: 'reversal',
          transferId: newTransferId,
          taskId: leg.taskId,
          memo: input.memo ?? `reversal of ${input.transferId}`,
          idempotencyKey: input.idempotencyKey
            ? `${input.idempotencyKey}:rev${i}`
            : null,
        });
        i += 1;
      }
    });
  }

  // ============================================================
  // Escrow primitives (held balance, no ownership change)
  // ============================================================

  /**
   * Reserve `amount` of the owner's coins (available → held). No ledger entry: ownership
   * doesn't change, the coins are just earmarked. Throws if available is insufficient — this
   * is what makes "can't post a rewarded task without the coins" hold. Always called in a tx.
   */
  async freeze(
    tx: Tx,
    input: { currencyId: string; ownerUserId: string; amount: number },
  ): Promise<void> {
    const amount = this.toBig(input.amount);
    const bal = await this.lockBalance(tx, input.ownerUserId, input.currencyId);
    if (amount > bal.balance - bal.held) {
      throw new BadRequestException('Недостаточно монет на балансе валюты');
    }
    await this.writeBalance(tx, input.ownerUserId, input.currencyId, bal.balance, bal.held + amount);
  }

  /** Release a reservation (held → available). No ledger entry. Always called in a tx. */
  async unfreeze(
    tx: Tx,
    input: { currencyId: string; ownerUserId: string; amount: number },
  ): Promise<void> {
    const amount = this.toBig(input.amount);
    const bal = await this.lockBalance(tx, input.ownerUserId, input.currencyId);
    const held = bal.held - amount;
    await this.writeBalance(tx, input.ownerUserId, input.currencyId, bal.balance, held < 0n ? 0n : held);
  }

  // ============================================================
  // Reads & reconciliation
  // ============================================================

  async getBalance(
    accountUserId: string,
    currencyId: string,
  ): Promise<{ balance: number; held: number; available: number }> {
    const row = await this.db.walletBalance.findUnique({
      where: { accountUserId_currencyId: { accountUserId, currencyId } },
    });
    const balance = row?.balance ?? 0n;
    const held = row?.heldAmount ?? 0n;
    return {
      balance: Number(balance),
      held: Number(held),
      available: Number(balance - held),
    };
  }

  /** Rebuild the materialized balance from the journal — the cache is always re-derivable. */
  async recompute(accountUserId: string, currencyId: string): Promise<void> {
    await this.db.$transaction(async (t) => {
      await this.lockBalance(t, accountUserId, currencyId);
      const sum = await t.ledgerEntry.aggregate({
        where: { accountUserId, currencyId },
        _sum: { amount: true },
      });
      const holds = await t.escrowHold.aggregate({
        where: { creatorUserId: accountUserId, currencyId, status: 'active' },
        _sum: { amount: true },
      });
      await this.writeBalance(
        t,
        accountUserId,
        currencyId,
        sum._sum.amount ?? 0n,
        holds._sum.amount ?? 0n,
      );
    });
  }
}
