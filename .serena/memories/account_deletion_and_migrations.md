# Account deletion (30-day grace) + DB migrations (May 2026)

## Account deletion — soft-delete with a 30-day recoverable GRACE period
Two-stage soft-delete on `User`:
- `deletionScheduledAt DateTime?` — user requested deletion; account is in the recoverable grace window. Login via token is blocked, but logging in restores it.
- `deletedAt DateTime?` — terminal; set by the cron after the grace window. Account is permanently anonymized, login blocked forever.
- `ACCOUNT_GRACE_DAYS = 30` (exported from `users.service.ts`).

Flow & methods (all in `UsersService`):
- `scheduleDeletion(userId, password)` — verifies password, sets `deletionScheduledAt`, revokes sessions. **No data destroyed yet.** Returns `{ scheduled, gracePeriodDays }`. Called by `DELETE /users/me` (body `{ password }`).
- Login during grace = auto-restore: `AuthService.login` clears `deletionScheduledAt` if set (after password check) and returns `{ ...tokens, restored: true }`. Terminal `deletedAt` → login throws.
- `restoreAccount(userId)` — clears `deletionScheduledAt` (also usable standalone).
- `JwtStrategy.validate` blocks BOTH `deletedAt` and `deletionScheduledAt` (pending account is "gone" until restored via login).
- `register`: if the phone belongs to a pending account (`deletionScheduledAt` set, `deletedAt` null) → 409 "Войдите, чтобы восстановить". (A terminal account has phone=`deleted:<id>`, so its real phone is free → normal register.)
- `AccountCron` (`core/users/account.cron.ts`, daily 03:15, Redis-locked) → `findExpiredDeletions(ACCOUNT_GRACE_DAYS)` → `anonymizeAccount(id)` for each.
- `anonymizeAccount(userId)` — the actual scrub (one `$transaction`): bilateral-delete contact links, cancel pending invitations, delete blocks, delete owned circles, revoke sessions, deactivate roles, cancel subscription, then scrub PII (firstName→"Удалённый пользователь", lastName/email/avatar/bio/city/dob/maritalStatus/socialLinks/cardVisibility cleared, **phone→`deleted:<id>`** freeing the real number, password→random hash, deletionScheduledAt→null, deletedAt→now). **Tasks/comments/workspaces KEPT.** Busts profile cache of the user + all former contacts.

Re-registration semantics: within 30 days → phone still taken by the pending account → register blocked with restore hint (logging in restores). After 30 days (cron ran) → phone freed → register creates a brand-new account (old data stays attributed to "Удалённый пользователь").

Web UI: `/profile` → «Безопасность» → «Опасная зона» → «Удалить аккаунт» button → modal (password confirm) → `DELETE /users/me` → logout + redirect `/login?deleted=1`. Login page shows a recovery hint when `?deleted=1`.

Verified end-to-end: schedule→200, old token→401, register-in-grace→409+hint, login-in-grace→200 restored=true, profile after restore→200 with data intact.

## DB migrations — `db push` → `prisma migrate`
- Baselined existing DB: `prisma/migrations/0_init/migration.sql` via `prisma migrate diff --from-empty --to-schema-datamodel ... --script`, then `prisma migrate resolve --applied 0_init`. `migrate status` = up to date.
- Workflow: `pnpm db:migrate` (migrate dev) for schema changes; `prisma migrate deploy` for setup. **Do NOT use `db push`** (diverges from migration history).
- Windows: `prisma generate` can EPERM if the API (nest --watch) holds `query_engine-windows.dll.node`. Stop the API FIRST — and kill it by the **port-3001 owner PID** (`Get-NetTCPConnection -LocalPort 3001`), NOT by matching 'nest' in the command line (the HTTP child's command line lacks 'nest', survives, and causes EADDRINUSE on the next start).
