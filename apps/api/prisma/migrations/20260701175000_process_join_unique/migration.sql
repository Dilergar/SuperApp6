-- Race-safe join deposit (A3): at most ONE active join row per (instance, node).
-- Concurrent deposits from parallel branches (or a lock-TTL-expiry edge) that both try
-- to CREATE the join row collide here — the loser gets P2002, the engine catches it and
-- re-runs the arrival increment instead of splitting arrivals across two rows (which
-- would hang the join forever). Loops still work: only ACTIVE join rows are constrained,
-- a completed join can be re-entered.
-- Partial index (WHERE) is not representable in schema.prisma — prisma migrate ignores it
-- on diff (same precedent as ledger_pending_resolution_unique / crowdfunding).
CREATE UNIQUE INDEX "process_step_runs_active_join_key"
  ON "process_step_runs"("instance_id", "node_id")
  WHERE "node_type" = 'parallel.join' AND "status" = 'active';
