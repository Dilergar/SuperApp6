# Wallet Module — Money Ledger / Accounts / Escrow

REBUILT 2026-05-29 to **bank-grade (real-money-ready) double-entry** as the foundation of "My Wish & Shop". User intent: NOT building a bank, but the wallet must be correct for REAL money — people will top up wallets via bank, pay for services, pay each other (P2P), and buy in the (planned) Marketplace. Payment rails (bank top-up/withdrawal, KYC/AML, FX, chargebacks) are OUT of scope now but the ledger is built so they slot in later. See `mem:project_wish_shop_design`.

## Model (apps/api/prisma/schema.prisma, wallet section)
- **Currency**: one active per issuer (partial unique `WHERE status='active'`), polymorphic issuer (user|workspace). `scale` = ISO-4217-style minor-unit exponent (0 = whole coins, 2 = e.g. tenge); amounts are integer minor units (BigInt). optional `code` for fiat. Rename ≤1×/3mo, retroactive.
- **Account** (chart of accounts): `type` user|issuance|escrow|fee|external, `ownerType` user|workspace|system, `ownerId` (userId/workspaceId; system accounts use currencyId), `balance` (posted, credit-normal), `held` (Σ unresolved pending OUTGOING reservations), `allowNegative` (true only for issuance). Materialized CACHE (truth = journal), row-locked (SELECT…FOR UPDATE) on spend. available = balance − held. `@@unique([currencyId,type,ownerType,ownerId])`.
- **LedgerTransfer** (immutable append-only journal, FK-free, BigSerial PK): one row = move `amount` debitAccount→creditAccount in one currency. `kind`: posted | pending | post_pending | void_pending. `pendingId` links a post/void to its pending. `agreementId` (origin escrow), `idempotencyKey` (unique). NEVER updated/deleted.
- **EscrowAgreement** ("Сделка"): groups holds for ONE source. `refType` task|order, `refId`, `status` open|settled|refunded|cancelled. `@@unique([refType,refId])`. Thin (crowdfunding target/progress NOT here — target = listing price, "collected" = Σ holds).
- **EscrowHold**: one leg per (agreement, payer, beneficiary, currency). `payerUserId`→`beneficiaryUserId`, amount, status active→captured→released, `pendingTransferId` (the freeze) + `postedTransferId` (the payout). Backed by a two-phase transfer.

## Invariants (bank-grade)
- **Double-entry conservation**: per currency, Σ(all account balances) = 0 (issuance goes negative = −circulating). `LedgerService.reconcileCurrency`.
- **Two-phase holds**: freeze = createPending (held += amount, no settlement); capture = postPending (payer→beneficiary, immutable resolving row); release = voidPending. held = Σ unresolved pending, NOT a bare mutable counter.
- **No negative balances** on user wallets. Return-after-payout = collect-back (transfer beneficiary→payer; THROWS if they already spent it) — never a silent negative reverse. (Old play-money "honest negative reverse" is gone.)
- Mint = double-entry issuance→user (not "from nothing"); cap "in hand" (balance ≤ 10M). Burn = user→issuance (un-mint). currency_deleted cascade = void active holds + burn each holder→issuance.

## Services (apps/api/src/modules/wallet/)
- **LedgerService**: getOrCreateUserAccount / getOrCreateIssuanceAccount; mint/burn (own tx ok); transfer (tx, account-based, available-checked, idempotent); createPending/postPending/voidPending (tx, two-phase); getBalance(userId,currencyId); recompute(accountId); reconcileCurrency(currencyId). lock() = FOR UPDATE sorted; append() = insert journal (P2002→null on idem dup).
- **CurrencyService**: lifecycle (create/rename/delete) + wallet views (getWallet/getHistory/getHolders) on the Account model + mint/burn. getHistory shows SETTLED moves (posted+post_pending), derives DTO `entryType` (mint|transfer|reversal|burn|currency_deleted) from kind+memo so the web `LEDGER_ENTRY_LABELS` still works.
- **EscrowService** (domain-agnostic, key = refType+refId): openAgreement / fund / capture (→CapturedLeg[]) / returnToHold / release / releaseAll. fund=createPending, capture=postPending, release=void-or-collect-back, returnToHold=collect-back+re-pending. Idempotent per leg (status guard + unique). Multi-leg: task=1 leg/worker; order=1 leg/payer×currency (crowdfunding=many payers, cross-currency=many currencies).

## Integration & boundaries
- TasksService uses EscrowService synchronously in its own `$transaction` (refType='task'): create→fund (currency resolution + "no currency ⇒ error" gate lives in TasksService.freezeReward), accept→capture+emit `wallet.coins.received`, return→returnToHold, cancel/delete/role-edit→release. The escrow API surface is unchanged from the task POV, so TasksService barely changed.
- Wallet NOT in workspace chokepoint (personal coins ≠ tenant data).
- Migration `20260529040000_escrow_realmoney_ledger` (created via `prisma migrate diff` + `migrate deploy` — `migrate dev` is interactive-only and fails in the agent shell). Dropped ledger_entries/wallet_balances; added accounts/ledger_transfers/escrow_agreements; reshaped escrow_holds; +currencies.scale/code. Keep the manual partial unique index on currencies.

## Verification (all green; not visually browser-tested)
`apps/api/scripts/verify-wallet.cjs` (ledger unit: mint/cap/transfer/idempotency/burn/two-phase/recompute/Σ=0), `verify-escrow.cjs` (task escrow e2e), `verify-ledger-invariants.cjs` (multi-leg + Σ=0 at each step + no-negative + cascade-burn), `verify-burn.cjs`. Seed: `scripts/seed-test-accounts.cjs` (tester1/2/3, Test1234!).

## ⚠️ OPERATIONAL
NEVER run full `tsc --noEmit` on the API (giant Prisma extended-client types OOM → machine hang). Typecheck via `nest build` (one-shot) or the `nest start --watch` watcher. Never raise NODE_OPTIONS max-old-space-size. Prisma `migrate dev` is interactive — in the agent shell use `migrate diff`→file→`migrate deploy`, and `migrate reset` needs PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION (explicit user consent).

## B2B wallet ✅ BUILT (Shop Phase 9, 2026-05-31)
Company currency (issuer=workspace) + TREASURY (workspace holder account via `getOrCreateHolderAccount(ownerType, ownerId)`); `mint`/`burn` take ownerType/ownerId; `getBalanceFor`. `EscrowHold` + `payerType`/`beneficiaryType` (default `'user'` → personal tasks/shop UNTOUCHED) so an escrow leg can involve the treasury. Payroll = treasury→employee posted transfer; company task rewards paid from the treasury (TasksService.freezeReward self-detects via task.workspaceId); company-shop purchases land in the treasury. Owner-only, `/wallet/company/*`, workspace context. Verified `verify-b2b-wallet.cjs` (Σ=0).

## Deferred
Payment rails (bank top-up/withdrawal/KYC/FX/chargebacks), fee accounts (marketplace application fees), dispute object. All slot onto this chart-of-accounts without a rewrite.
