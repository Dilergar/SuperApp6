# Scaling & Infra Hardening (May 2026)

Horizontal-scaling + correctness pass on the API. Key facts:

## EventBus — now Redis Streams (was in-memory Subject)
- `apps/api/src/shared/events/event-bus.service.ts`: backed by Redis Stream `superapp:events` + consumer group `superapp:workers`.
- `emit()` = XADD (capped MAXLEN ~10000, fire-and-forget). Each instance runs ONE consumer (competing consumers → every event handled by exactly ONE instance, no duplicate side-effects). Consumer re-publishes onto a local RxJS Subject, so `on()`/`onPattern()` are unchanged → listeners (`notifications.events.ts`, `calendar.events.ts`) untouched.
- Dedicated ioredis connection (`getClient().duplicate({ maxRetriesPerRequest: null })`) for the blocking XREADGROUP. Consumer started in `onApplicationBootstrap` (after listeners subscribed). XAUTOCLAIM reclaims messages stranded by a crashed instance.

## Auth
- Refresh token hashing: bcrypt → **SHA-256** (`auth.service.ts` `hashToken`). bcrypt's random salt made `findUnique({where:{token}})` never match → refresh & logout were 100% broken. SHA-256 is deterministic → lookup works.

## Rate limiting
- `ThrottlerGuard` registered as APP_GUARD in `app.module.ts` (was missing → @Throttle was inert).
- `RedisThrottlerStorage` (`shared/throttler/redis-throttler.storage.ts`) — counters shared across instances (atomic INCR+PEXPIRE via Lua; ttl/blockDuration in ms, timeToExpire/timeToBlockExpire in s). Wired via `ThrottlerModule.forRootAsync`.
- Throttlers named `short`/`medium`/`long` (no `default`). `@Throttle` on login/register/sendInvitation now targets `long` (was `default` = a no-op).

## Crons — distributed lock
- `RedisService.withLock(key, ttlMs, fn)` (SET NX PX) so a cron runs on ONE instance.
- `ContactsCron` (hourly invitation cleanup) and new `NotificationsCron` (`notifications.cron.ts`, daily 03:30, deletes notifications older than `NOTIFICATION_LIMITS.retentionDays`=90 via `NotificationsService.cleanupOld`).

## Profile cache invalidation
- `RedisService.invalidateUserProfile(userId)` busts `user:{id}:profile`. Called on: accept invitation (both users), delete contact (both), block (both), circle create/delete (owner), and in `RolesService.assignRole/revokeRole` (now also busts `:profile`, previously only `:roles`).

## DB indexes (schema.prisma)
- ContactLink: `[userAId,confirmedAt]`+`[userBId,confirmedAt]` (cover the hot env-list OR + sort); dropped single `[userAId]`/`[userBId]`.
- Notification: `[userId,createdAt,id]` (keyset). ContactInvitation: `[fromUserId,toPhone,status]` + `[status,expiresAt]`. Subscription: `[status,expiresAt]`. Dropped redundant `@@index` on `User.phone` & `Session.token` (already @unique).

## Pagination / over-fetch
- `ContactsService.listContacts(userId, cursor?)` → `{ items, nextCursor }` (keyset on confirmedAt,id; page size `CONTACT_LIMITS.contactsPageSize`=100). Controller `GET /contacts` returns `{ success, data: items, nextCursor }` — `data` stays an array (web backward-compatible); web loads all pages in a loop.
- New `listContactsByLinkIds(userId, linkIds)` — `CirclesService.getCircle` uses it instead of loading the whole environment.
- Invitation/block lists got `take` caps.
