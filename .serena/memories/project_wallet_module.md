# Wallet Module (Coins / Ledger / Escrow)

Built 2026-05-27 on branch `feat/wallet-ledger`. Replaces the old "coins = display-only intent" in Tasks with a real economy. Grilled via grill-me before building.

## Concept
Each **user** issues exactly ONE personal currency (name + emoji, no ticker) to reward people in their Окружение for tasks. Issuer is **polymorphic** (`issuerType` user|workspace) — company currency is a later phase on the SAME schema (B2B-ready). Balances are DERIVED from an immutable ledger.

## Key product decisions (locked)
- **1 active currency per user** (partial unique index `currencies_active_issuer_key WHERE status='active'` — NOT expressible in schema.prisma; service also guards it). Created explicitly (name+emoji), renamed at most **1×/3 months** (retroactive — everything refs currencyId, name never snapshotted). Delete = soft-delete + cascade-burn all holders to 0; in-flight tasks keep running but lose the reward; active holds released.
- **Mint cap = "in hand"**: own (available + held) ≤ 10,000,000. Since held ⊆ balance, this is just `balance ≤ 10M`. Re-mintable as coins leave (NOT a lifetime cap).
- **Escrow**: post a rewarded task → freeze per-worker; accept → pay; return/cancel → refund. Can't post a rewarded task without the coins (freeze throws → task creation rolls back).
- **Return after acceptance**: reverse the payout (recipient may go **NEGATIVE** — "honest reverse", can't burn-to-dodge) AND re-freeze (task still active → reward stands). Cancel/delete = terminal refund to creator's available.
- **Penalty (coinPenalty)**: dropped this phase (no logic; field dormant).
- **Burn**: holder burns any FOREIGN currency from their balance (irreversible); CANNOT burn own (delete the currency instead). Issuer CANNOT force-take from others (only task-flow reverse). Company clawback (reverse a tx in history) = later phase.
- **Privacy**: a (holder, currency) balance is visible to the holder + the issuer. Surfaced as a badge on the person's card in Окружение ("держит N 🪙"); B2B will show it on Сотрудники cards with a role/position visibility matrix (`Currency.visibilityPolicy` JSON hook, unused now).

## Architecture
- **Immutable ledger** (`LedgerEntry`, append-only, never UPDATE/DELETE). PK = BigInt autoincrement (append-log locality). Amounts BigInt, signed. FK-free on purpose (hot writes; integrity in service).
- **Materialized balance** (`WalletBalance`, unique [accountUserId, currencyId]) = cache, updated in the SAME tx as the ledger insert, row-locked via raw `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` (lock-or-create) before a spend → no double-spend. `available = balance − heldAmount`. Rebuildable via `recompute()`.
- **Escrow** (`EscrowHold`, unique [taskId, participantUserId]) = per-participant state machine active→captured→released; carries currencyId + ledgerTransferId (for reversal).
- **Idempotency**: unique `LedgerEntry.idempotencyKey` (e.g. `cap:{holdId}:out/in`) + EscrowHold status guards → at-least-once events / double clicks can't double-post.
- **Escrow is SYNC + transactional** (NOT EventBus): `TasksService` calls `EscrowService` inside its own `$transaction` (documented direct-call exception, like Auth→Contacts). EventBus only emits `wallet.coins.received` for the notification (after commit).
- **NOT in the workspace chokepoint** (`WORKSPACE_SCOPED_MODELS`) — personal coins don't belong to a tenant; scoped by issuer in-service.

## Files
- `apps/api/prisma/schema.prisma`: models Currency, LedgerEntry, WalletBalance, EscrowHold. Migration `20260526224442_wallet_ledger` (+ manual partial unique index).
- `apps/api/src/modules/wallet/`: `ledger.service.ts` (mint/burn/transfer/reverse/freeze/unfreeze/getBalance/recompute), `currency.service.ts` (currency lifecycle + wallet views + burn), `escrow.service.ts` (holdForWorkers/holdOne/capture/returnToHold/releaseParticipant/releaseAll), `wallet.controller.ts`, `wallet.module.ts` (exports Ledger+Escrow). Registered in app.module before TasksModule. TasksModule imports WalletModule.
- `apps/api/src/modules/tasks/tasks.service.ts`: escrow wired into createTask (hold), acceptWork (capture + emits wallet.coins.received), returnWork (returnToHold), deleteTask + updateTask cancel (releaseAll), applyRoleEdits (add→hold / remove→release), maybeSpawnRecurrence (funds next occurrence or spawns reward-0 if creator can't cover). Reward is locked once workers assigned.
- `packages/shared/src/{types,validation,constants}/wallet.ts` + notification type `wallet.coins.received` + registry entry.
- Web: `apps/web/src/app/profile/WalletSection.tsx` (profile «Кошелёк» section: my currency CRUD/mint, foreign balances + burn 🔥, history, holders) wired into `profile/layout.tsx` + `profile/[section]/page.tsx`. `circles/PersonCard.tsx` compact `myCoins` badge + `circles/page.tsx` fetches /wallet/currency + /holders.

## Endpoints (`/api/wallet/`)
GET `/` (wallet), GET `/history`, GET `/currency`, POST `/currency`, PATCH `/currency`, DELETE `/currency`, POST `/currency/mint`, GET `/currency/holders`, POST `/burn`.

## Verification (all green, NOT visually browser-tested)
- `apps/api/scripts/verify-wallet.cjs` — ledger unit (mint/cap/transfer/idempotency/burn/negative-reverse/freeze/preReserved/recompute).
- HTTP smoke — currency CRUD + cap + rename cooldown + delete cascade.
- `apps/api/scripts/verify-escrow.cjs` — full escrow e2e (freeze→pay→return-reverse→insufficient→cancel-refund) between tester1↔tester2.
- `apps/api/scripts/verify-burn.cjs` — earn-notification + burn foreign + can't-burn-own.
- API boots, web /profile/wallet + /circles compile & 200.

## Deferred (next phases)
Company (workspace) currency + company wallet + history-reverse clawback + role/position visibility matrix; coins-deducted notification on clawback; recurrence reward funding edge polish; BigInt is stored but DTOs serialize as Number (safe < 2^53).

## OPERATIONAL WARNING (Windows / memory)
NEVER run full `tsc --noEmit -p tsconfig.json` on the API — the giant Prisma extended-client types OOM and (with a raised --max-old-space-size) swap-thrash the machine, hanging Docker. Verify the API via `nest build` (one-shot, default heap) or the `nest start --watch` watcher only. Never raise NODE_OPTIONS max-old-space-size.
