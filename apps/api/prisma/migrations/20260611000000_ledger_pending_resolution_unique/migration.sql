-- One resolution per pending transfer: a pending can be EITHER posted OR voided, exactly once.
-- DB-level belt for the in-code re-check-after-lock in LedgerService.postPending/voidPending:
-- a concurrent double-settle dies on this index (tx aborts, full rollback) instead of paying twice.
-- Partial index (WHERE) is not representable in schema.prisma — prisma migrate ignores it on diff
-- (same precedent as the crowdfunding partial-unique in 20260531000000_crowdfunding).
CREATE UNIQUE INDEX "ledger_transfers_pending_resolution_key"
  ON "ledger_transfers"("pending_id")
  WHERE "kind" IN ('post_pending', 'void_pending');
