import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { LedgerService } from './ledger.service';

type Tx = Prisma.TransactionClient;
type HoldRow = Prisma.EscrowHoldGetPayload<object>;
type AgreementRow = Prisma.EscrowAgreementGetPayload<object>;

/** Identifies the source an escrow agreement is for (a task, a marketplace order, …). */
export interface EscrowRef {
  refType: string; // 'task' | 'order'
  refId: string;
}

/** A leg paid out by `capture`, returned for "you received coins" notifications. */
export interface CapturedLeg {
  beneficiaryUserId: string;
  currencyId: string;
  currencyName: string;
  amount: number;
}

/**
 * Generic escrow over the double-entry ledger. An EscrowAgreement ("Сделка") groups the per-leg
 * EscrowHold rows for ONE source; Tasks and Commerce are its two clients (refType discriminates).
 * Each hold is backed by a TWO-PHASE ledger transfer:
 *
 *   fund         — `createPending` payer → beneficiary (reserves the payer's coins; no settlement).
 *   capture      — `postPending` settles the payout (payer → beneficiary).
 *   release      — `voidPending` (still held) or collect-back (already paid) — terminal refund.
 *   returnToHold — collect the payout back and re-freeze (rework; the source is still active).
 *
 * No balance ever goes negative: a return/refund after payout collects from the beneficiary's
 * available balance (throws if they already spent it — you can't claw back spent funds). Every
 * method takes the caller's transaction so the money move is atomic with the source's state change.
 * Domain-agnostic: a task funds one leg per worker (single payer = creator, single currency); a
 * marketplace order funds one leg per payer × currency (crowdfunding = many payers; cross-currency
 * price = many currencies; beneficiary = the seller).
 */
@Injectable()
export class EscrowService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  /** Find-or-create the agreement for a source. Idempotent (safe under concurrent opens). */
  async openAgreement(tx: Tx, ref: EscrowRef): Promise<AgreementRow> {
    const existing = await tx.escrowAgreement.findUnique({
      where: { refType_refId: { refType: ref.refType, refId: ref.refId } },
    });
    if (existing) return existing;
    try {
      return await tx.escrowAgreement.create({
        data: { refType: ref.refType, refId: ref.refId },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return (await tx.escrowAgreement.findUnique({
          where: { refType_refId: { refType: ref.refType, refId: ref.refId } },
        }))!;
      }
      throw err;
    }
  }

  /**
   * Freeze `amount` of the payer's currency toward (beneficiary, currency) under the source's
   * agreement (a pending ledger transfer). Idempotent per (agreement, payer, beneficiary, currency):
   * an existing non-released leg is left untouched, a released leg is re-activated. Skips a zero
   * amount and self-funding. Throws (via the ledger) if the payer's available balance is insufficient.
   */
  async fund(
    tx: Tx,
    input: EscrowRef & {
      payerUserId: string;
      payerType?: string; // 'user' (default) | 'workspace' treasury (B2B P9)
      beneficiaryUserId: string;
      beneficiaryType?: string; // 'user' (default) | 'workspace' treasury (B2B P9)
      currencyId: string;
      amount: number;
    },
  ): Promise<void> {
    const payerType = input.payerType ?? 'user';
    const beneficiaryType = input.beneficiaryType ?? 'user';
    if (input.amount <= 0 || (input.payerUserId === input.beneficiaryUserId && payerType === beneficiaryType)) return;
    const agreement = await this.openAgreement(tx, input);
    const existing = await this.findLeg(tx, agreement.id, input);
    if (existing && existing.status !== 'released') return; // already active or captured

    const payerAcct = await this.ledger.getOrCreateHolderAccount(tx, input.currencyId, payerType, input.payerUserId);
    const beneAcct = await this.ledger.getOrCreateHolderAccount(tx, input.currencyId, beneficiaryType, input.beneficiaryUserId);
    const pendingId = await this.ledger.createPending(tx, {
      currencyId: input.currencyId,
      payerAccountId: payerAcct.id,
      beneficiaryAccountId: beneAcct.id,
      amount: input.amount,
      agreementId: agreement.id,
    });

    if (existing) {
      await tx.escrowHold.update({
        where: { id: existing.id },
        data: { status: 'active', amount: BigInt(input.amount), payerType, beneficiaryType, pendingTransferId: pendingId, postedTransferId: null },
      });
    } else {
      await tx.escrowHold.create({
        data: {
          agreementId: agreement.id,
          currencyId: input.currencyId,
          payerUserId: input.payerUserId,
          payerType,
          beneficiaryUserId: input.beneficiaryUserId,
          beneficiaryType,
          amount: BigInt(input.amount),
          status: 'active',
          pendingTransferId: pendingId,
        },
      });
    }
  }

  /**
   * Pay out matching ACTIVE legs (settle their pending transfer). Filter by `beneficiaryUserId` to
   * capture one party (a task accepts one worker at a time); omit it to capture every active leg at
   * once (an order settles fully). Returns the captured legs for notifications.
   */
  async capture(
    tx: Tx,
    input: EscrowRef & { beneficiaryUserId?: string },
  ): Promise<CapturedLeg[]> {
    const holds = await this.legs(tx, input, 'active');
    if (holds.length === 0) return [];

    const captured: CapturedLeg[] = [];
    const nameCache = new Map<string, string>();
    for (const hold of holds) {
      if (!hold.pendingTransferId) continue;
      const postedId = await this.ledger.postPending(tx, hold.pendingTransferId);
      await tx.escrowHold.update({
        where: { id: hold.id },
        data: { status: 'captured', postedTransferId: postedId },
      });
      captured.push({
        beneficiaryUserId: hold.beneficiaryUserId,
        currencyId: hold.currencyId,
        currencyName: await this.currencyName(tx, hold.currencyId, nameCache),
        amount: Number(hold.amount),
      });
    }
    return captured;
  }

  /**
   * Rework: collect the payout of matching CAPTURED legs back (beneficiary → payer) and re-freeze —
   * the source is still active, so the reward / price stands. No-op for legs not yet captured.
   * Throws if a beneficiary has already spent the coins (no negative balances).
   */
  async returnToHold(
    tx: Tx,
    input: EscrowRef & { beneficiaryUserId?: string },
  ): Promise<void> {
    const holds = await this.legs(tx, input, 'captured');
    for (const hold of holds) {
      await this.collectBack(tx, hold);
      const payerAcct = await this.ledger.getOrCreateHolderAccount(tx, hold.currencyId, hold.payerType, hold.payerUserId);
      const beneAcct = await this.ledger.getOrCreateHolderAccount(tx, hold.currencyId, hold.beneficiaryType, hold.beneficiaryUserId);
      const pendingId = await this.ledger.createPending(tx, {
        currencyId: hold.currencyId,
        payerAccountId: payerAcct.id,
        beneficiaryAccountId: beneAcct.id,
        amount: Number(hold.amount),
        agreementId: hold.agreementId,
      });
      await tx.escrowHold.update({
        where: { id: hold.id },
        data: { status: 'active', pendingTransferId: pendingId, postedTransferId: null },
      });
    }
  }

  /**
   * Terminal refund of matching legs: void the pending if still held, or collect the payout back if
   * already captured. Filter by beneficiary and/or payer (one worker removed, one contributor's
   * stake returned); omit both to refund every leg of the agreement (cancel / delete / reject).
   */
  async release(
    tx: Tx,
    input: EscrowRef & { beneficiaryUserId?: string; payerUserId?: string },
  ): Promise<void> {
    const agreement = await this.find(tx, input);
    if (!agreement) return;
    const where: Prisma.EscrowHoldWhereInput = {
      agreementId: agreement.id,
      status: { in: ['active', 'captured'] },
    };
    if (input.beneficiaryUserId) where.beneficiaryUserId = input.beneficiaryUserId;
    if (input.payerUserId) where.payerUserId = input.payerUserId;
    const holds = await tx.escrowHold.findMany({ where });
    for (const hold of holds) await this.releaseHold(tx, hold);
  }

  /** Terminal refund for the whole agreement (cancel / delete). */
  async releaseAll(tx: Tx, ref: EscrowRef): Promise<void> {
    await this.release(tx, ref);
  }

  // ============================================================
  // Internals
  // ============================================================

  private async releaseHold(tx: Tx, hold: HoldRow): Promise<void> {
    if (hold.status === 'released') return;
    if (hold.status === 'active' && hold.pendingTransferId) {
      await this.ledger.voidPending(tx, hold.pendingTransferId);
    } else if (hold.status === 'captured') {
      await this.collectBack(tx, hold);
    }
    await tx.escrowHold.update({ where: { id: hold.id }, data: { status: 'released' } });
  }

  /** Move a captured payout back beneficiary → payer (no negatives: throws if already spent). */
  private async collectBack(tx: Tx, hold: HoldRow): Promise<void> {
    const payerAcct = await this.ledger.getOrCreateHolderAccount(tx, hold.currencyId, hold.payerType, hold.payerUserId);
    const beneAcct = await this.ledger.getOrCreateHolderAccount(tx, hold.currencyId, hold.beneficiaryType, hold.beneficiaryUserId);
    await this.ledger.transfer(tx, {
      currencyId: hold.currencyId,
      fromAccountId: beneAcct.id,
      toAccountId: payerAcct.id,
      amount: Number(hold.amount),
      agreementId: hold.agreementId,
      idempotencyKey: `collect:${hold.id}:${hold.postedTransferId ?? '0'}`,
      memo: 'escrow return',
    });
  }

  private find(tx: Tx, ref: EscrowRef): Promise<AgreementRow | null> {
    return tx.escrowAgreement.findUnique({
      where: { refType_refId: { refType: ref.refType, refId: ref.refId } },
    });
  }

  private async legs(
    tx: Tx,
    input: EscrowRef & { beneficiaryUserId?: string },
    status: 'active' | 'captured',
  ): Promise<HoldRow[]> {
    const agreement = await this.find(tx, input);
    if (!agreement) return [];
    const where: Prisma.EscrowHoldWhereInput = { agreementId: agreement.id, status };
    if (input.beneficiaryUserId) where.beneficiaryUserId = input.beneficiaryUserId;
    return tx.escrowHold.findMany({ where });
  }

  private findLeg(
    tx: Tx,
    agreementId: string,
    leg: { payerUserId: string; beneficiaryUserId: string; currencyId: string },
  ): Promise<HoldRow | null> {
    return tx.escrowHold.findUnique({
      where: {
        agreementId_payerUserId_beneficiaryUserId_currencyId: {
          agreementId,
          payerUserId: leg.payerUserId,
          beneficiaryUserId: leg.beneficiaryUserId,
          currencyId: leg.currencyId,
        },
      },
    });
  }

  private async currencyName(tx: Tx, currencyId: string, cache: Map<string, string>): Promise<string> {
    const cached = cache.get(currencyId);
    if (cached !== undefined) return cached;
    const c = await tx.currency.findUnique({ where: { id: currencyId }, select: { name: true } });
    const name = c?.name ?? 'монеты';
    cache.set(currencyId, name);
    return name;
  }
}
