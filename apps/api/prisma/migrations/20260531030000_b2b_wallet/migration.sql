-- Phase 9 (B2B wallet): an escrow leg's payer/beneficiary can be a company TREASURY (workspace
-- account), not just a user — company task rewards (treasury → employee) and company-shop purchases
-- (employee → treasury). Default 'user' keeps every existing leg (tasks, personal shop) unchanged.
-- (Account.owner_type='workspace' and Currency.issuer_type='workspace' already exist from earlier.)
ALTER TABLE "escrow_holds" ADD COLUMN "payer_type" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "escrow_holds" ADD COLUMN "beneficiary_type" TEXT NOT NULL DEFAULT 'user';
