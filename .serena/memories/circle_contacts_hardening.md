# Circle / Contacts hardening (2026-06-11)

Current state after the Circle foundation review — ALL 5 findings fixed & verified same day.

## «Рабочий пропуск» — context-aware reachability (finding 4)
- `ContactsService.assertReachable(ownerId, ids, msg?, opts?)` is now CONTEXT-AWARE: it injects `WorkspaceContextService` (@Global, ALS). When `activeWorkspaceId` is set (X-Workspace-Id verified fail-closed by WorkspaceContextInterceptor): reachability = co-membership in that workspace (`workspaceMember` rows; membership = row exists, no isActive flag) — personal Окружение NOT required (Slack/Bitrix24 model). No workspace context → old behavior (ContactLink + blocks both ways).
- Hybrid blocks decision (user-approved): personal blocks do NOT gate work artifacts (tasks/events/group chats) in workspace context; DM respects blocks ALWAYS — messenger `openDm` passes `{ alwaysCheckBlocks: true }`; block check extracted to private `assertNotBlocked`.
- DM with coworker decision: allowed in workspace context (user-approved). One global DM thread per pair (dmKey) — no per-workspace DM split.
- Tasks/Calendar delegates unchanged (gate auto-detects context). Shop keeps its own ownerType-keyed branch (resource-keyed, not header-keyed — correct for shares).
- Web today sends X-Workspace-Id only on workspace pages (e.g. company wallet `cfg headers`); org-context UI plumbing for tasks/calendar/messenger comes with the «Сотрудники» service.
- Verified: `verify-b2b-reachability.cjs` 13/0 (no-header task to non-contact → 403; with header: task/event/DM to employee-non-contact OK; personal contact who is NOT a member → 403 in ws ctx; after employee blocks owner: work task still OK, DM → 403). Regression green: block-enforcement, circle-access-revoke, contacts-hardening, tasks-access, messenger (29/0), calendar-access, shop.

## Skins visibility policy (user decision 2026-06-11)
Equipped skin is visible to EVERYONE who sees the card (окружение, coworkers, future marketplace) — cosmetics = public status (Telegram Premium/Steam model). Former deferred issue F6 («resolve leaks default skin to non-contacts») is CLOSED as by-design; zero code change. Per-group skins remain personal-Groups-only. Future premium idea (recorded, not built): «скин на организацию». B2B card fields for coworkers-non-contacts: floor = Имя+Фамилия+Должность (roster already via PersonChip); per-org visibility settings + `card.full_viewer` grants belong to the future «Сотрудники» service.

## Invitation anti-spam (finding 2)
- `cleanupInvitations()` retains non-pending rows `CONTACT_LIMITS.nonPendingRetentionDays` (30d, delete by updatedAt age) instead of hourly wipe — the 24h resend cooldown, 30/day limit and `resendInvitation` all read this history.
- `listIncoming/OutgoingInvitations` filter `expiresAt > now`.

## Phone lookup privacy (finding 3)
- `GET /users/lookup?phone` masks lastName to initial («Санжар Н.») via `maskLastName` (`packages/shared/src/utils/name.ts`) + dedicated `@Throttle({ long: { limit: 30, ttl: 1h } })`. Blocked-list entries masked too (`ContactBlockRecord.blockedLastName/-Avatar`).

## Blocks UI (finding 5)
- `/circles`: collapsible «Заблокированные» section (PersonChip S + Разблокировать, shown when count>0), block buttons on person card («блок») and incoming invitation («Заблокировать»), confirm dialogs, RQ invalidation via shared keys (`blocksKey` in lib/queries.ts).

## Finding 1 (earlier same day)
- `deleteContact`/`blockUser`/`anonymizeAccount` revoke `circle:<id>#member@user` tuples synchronously (`revokeMembershipTuples`); verify-circle-access-revoke 19/0.

Verification suite: `verify-contacts-hardening.cjs` 22/0, `verify-b2b-reachability.cjs` 13/0 — both in CI glob. Browser-verified /circles (blocked section, masked lookup, unblock; 0 console errors).
