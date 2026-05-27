import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { LedgerService } from './ledger.service';

type Tx = Prisma.TransactionClient;
type HoldRow = Prisma.EscrowHoldGetPayload<object>;

/**
 * Task-reward escrow, ONE hold per (task, participant). All methods take the caller's
 * transaction so the freeze/capture/refund is atomic with the task state change. Composes
 * LedgerService primitives; the EscrowHold row is the per-participant state machine
 * (active → captured → released) and carries the currency so refunds need no extra lookup.
 */
@Injectable()
export class EscrowService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Freeze `amountEach` of the creator's own currency for each worker. Resolves the creator's
   * active currency (throws if none) — this is where "no currency ⇒ can't reward" lives.
   * Skips the creator themselves and a zero reward. Throws if funds are insufficient.
   */
  async holdForWorkers(
    tx: Tx,
    input: { taskId: string; creatorUserId: string; workerIds: string[]; amountEach: number },
  ): Promise<void> {
    const { taskId, creatorUserId, amountEach } = input;
    const workers = [...new Set(input.workerIds)].filter((id) => id && id !== creatorUserId);
    if (amountEach <= 0 || workers.length === 0) return;

    const currency = await tx.currency.findFirst({
      where: { issuerType: 'user', issuerId: creatorUserId, status: 'active' },
    });
    if (!currency) {
      throw new BadRequestException('Создайте свою валюту, чтобы назначать награду за задачу');
    }
    for (const participantUserId of workers) {
      await this.holdOne(tx, { taskId, participantUserId, creatorUserId, currencyId: currency.id, amount: amountEach });
    }
  }

  /** Idempotent per (task, participant): freeze the coins + create / re-activate the hold. */
  async holdOne(
    tx: Tx,
    input: { taskId: string; participantUserId: string; creatorUserId: string; currencyId: string; amount: number },
  ): Promise<void> {
    const { taskId, participantUserId, creatorUserId, currencyId, amount } = input;
    if (amount <= 0 || participantUserId === creatorUserId) return;

    const existing = await this.find(tx, { taskId, participantUserId });
    if (existing && existing.status !== 'released') return; // already active or captured

    await this.ledger.freeze(tx, { currencyId, ownerUserId: creatorUserId, amount });
    if (existing) {
      await tx.escrowHold.update({
        where: { id: existing.id },
        data: { status: 'active', amount: BigInt(amount), currencyId, creatorUserId, ledgerTransferId: null },
      });
    } else {
      await tx.escrowHold.create({
        data: { taskId, participantUserId, creatorUserId, currencyId, amount: BigInt(amount), status: 'active' },
      });
    }
  }

  /**
   * Acceptance: pay the participant out of the frozen coins. Returns the paid amount +
   * currency name (for the "you earned coins" notification), or null if there was no hold.
   */
  async capture(
    tx: Tx,
    input: { taskId: string; participantUserId: string },
  ): Promise<{ currencyName: string; amount: number } | null> {
    const hold = await this.find(tx, input);
    if (!hold || hold.status !== 'active') return null;
    const transferId = await this.ledger.transfer(
      {
        currencyId: hold.currencyId,
        fromUserId: hold.creatorUserId,
        toUserId: hold.participantUserId,
        amount: Number(hold.amount),
        taskId: hold.taskId,
        preReserved: true,
        idempotencyKey: `cap:${hold.id}`,
      },
      tx,
    );
    await tx.escrowHold.update({ where: { id: hold.id }, data: { status: 'captured', ledgerTransferId: transferId } });
    const currency = await tx.currency.findUnique({ where: { id: hold.currencyId }, select: { name: true } });
    return { currencyName: currency?.name ?? 'монеты', amount: Number(hold.amount) };
  }

  /**
   * Return for rework: if the participant was already paid, reverse that payout (their balance
   * may go negative) and RE-FREEZE the reward — the task is still active, so the reward stands.
   * If not yet paid (coins still frozen), nothing to do.
   */
  async returnToHold(tx: Tx, input: { taskId: string; participantUserId: string }): Promise<void> {
    const hold = await this.find(tx, input);
    if (!hold || hold.status !== 'captured' || !hold.ledgerTransferId) return;
    await this.ledger.reverse({ transferId: hold.ledgerTransferId, idempotencyKey: `rev:${hold.ledgerTransferId}` }, tx);
    await this.ledger.freeze(tx, { currencyId: hold.currencyId, ownerUserId: hold.creatorUserId, amount: Number(hold.amount) });
    await tx.escrowHold.update({ where: { id: hold.id }, data: { status: 'active', ledgerTransferId: null } });
  }

  /** Terminal refund for one participant (e.g. removed from the task). */
  async releaseParticipant(tx: Tx, input: { taskId: string; participantUserId: string }): Promise<void> {
    const hold = await this.find(tx, input);
    if (hold) await this.releaseHold(tx, hold);
  }

  /** Terminal refund for the whole task (cancel / delete): everything back to creator's available. */
  async releaseAll(tx: Tx, input: { taskId: string }): Promise<void> {
    const holds = await tx.escrowHold.findMany({
      where: { taskId: input.taskId, status: { in: ['active', 'captured'] } },
    });
    for (const hold of holds) await this.releaseHold(tx, hold);
  }

  private async releaseHold(tx: Tx, hold: HoldRow): Promise<void> {
    if (hold.status === 'released') return;
    if (hold.status === 'captured' && hold.ledgerTransferId) {
      await this.ledger.reverse({ transferId: hold.ledgerTransferId, idempotencyKey: `rel:${hold.ledgerTransferId}` }, tx);
    } else if (hold.status === 'active') {
      await this.ledger.unfreeze(tx, { currencyId: hold.currencyId, ownerUserId: hold.creatorUserId, amount: Number(hold.amount) });
    }
    await tx.escrowHold.update({ where: { id: hold.id }, data: { status: 'released', ledgerTransferId: null } });
  }

  private find(tx: Tx, input: { taskId: string; participantUserId: string }): Promise<HoldRow | null> {
    return tx.escrowHold.findUnique({
      where: { taskId_participantUserId: { taskId: input.taskId, participantUserId: input.participantUserId } },
    });
  }
}
