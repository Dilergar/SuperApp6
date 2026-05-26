# Calendar module — design + state (Phases 1–4 BUILT)

Status: **Phases 1–4 BUILT** (May 2026). Web-only. Grilled before each phase. P1–3 verified e2e; **P4 (Google sync) code-complete + typechecks + API boots, but NOT live-tested** (needs Google OAuth creds + real account).

## Phasing
- **P1 core (DONE):** own calendar; events CRUD; RRULE recurrence (this/this_and_following/all via exDates+override rows); per-user multi-reminders (default 24h+30min, materialized queue + cron); all-day, location, color; virtual task layer; overdue pin; 4 views (Month/Week/Day/Agenda); timezone UTC→viewer.
- **P2 social (DONE):** participants+RSVP (one shared event, no copies; pending/accepted/declined/tentative); per-Group (`Circle.calendarVisibility`) + per-person (`CalendarShare.accessLevel`) sharing, levels none<busy<detailed, resolve=MAX (`resolveAccessLevel`), default none; view others as toggleable overlay layers (busy-stripped / detailed); Smart Match (blind free-slot finder among people who granted ≥busy); notifications invited/rsvp/updated/cancelled.
- **P3 advanced (DONE):** Resources + moderated booking; interactive calendar (triage panel + drag-and-drop + event resize).
- **P4 (DONE — Google):** two-way Google Calendar sync via OAuth + Google Calendar API (NOT raw CalDAV — matches Bitrix24/Salesforce). Apple/CalDAV later. Customer-facing booking (tables/stylist) = separate future "Bookings" module on Resource + Jobs Marketplace. Finance "pay" layer waits for Finance.

## P4 — Google Calendar sync (built; module apps/api/src/modules/google-calendar/)
Locked decisions: scope C = two-way Google via OAuth+API (CalDAV is one-way/legacy). Choose calendar at connect, default dedicated "SuperApp6"; own events only two-way; tasks one-way → "SuperApp6 · Задачи" calendar (loop-proof). Sync mechanism = incremental sync-tokens engine + Google webhooks (channels.watch, prod/public-HTTPS) + polling/manual fallback (cron, dev). Conflicts = last-write-wins by update time. Deletions mirror both ways. One Google account/user. Participants NOT pushed as Google attendees (RSVP stays internal). User must register a Google Cloud OAuth app → GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI in .env (empty → integration inert).
Model: `GoogleConnection` (userId unique, googleEmail, accessToken, refreshToken, tokenExpiry, syncCalendarId, tasksCalendarId, syncToken, channelId/resourceId/expiry, lastSyncedAt). `CalendarEvent.googleEventId/googleCalendarId` reused; idempotent upsert by googleEventId absorbs echo; extendedProperties.private.superappEventId tag.
Backend: GoogleCalendarService (oauth flow via `googleapis`, signed state via HMAC(JWT_SECRET); getAuthUrl/handleCallback/getStatus/disconnect/listCalendars/selectCalendar; fullSync/pullIncremental/pushEvent/deleteRemote/exportTasks; registerWatch/handleWebhook/pollAndRenew; toGoogleEvent/fromGoogleEvent mapping, RRULE↔recurrence, all-day end exclusive). Controller `/api/integrations/google/*` (callback+webhook are @Public). GoogleEventsListener on `google.push` (CalendarService emits on create/update/delete). GoogleCalendarCron */15min (Redis lock). Registered in app.module.
Web: calendar/google-ui.tsx GooglePanel (connect/status/calendar-picker/sync-now/disconnect; "not configured" notice if auth-url 400). Toolbar "🔗 Google" button; auto-opens on ?google= redirect.
MVP limits: per-occurrence recurrence exceptions synced at master+EXDATE only (instances skipped inbound); webhooks need public HTTPS (else poll); tokens stored plaintext (encrypt-at-rest TODO). NOT live-tested (no creds).

## P3 locked decisions (all built)
- **Resource = dedicated entity** (Google/Outlook model, NOT pseudo-user). **Booking = a normal CalendarEvent with `resourceId` + `resourceStatus`** (reuses everything). Resource's calendar = events referencing it.
- **Personal only for now** (owner = user); `Resource.workspaceId` reserved (nullable) for future B2B.
- **Who can book:** owner + allow-list (`bookerUserIds` + `bookerCircleIds`, from owner's environment). canBook resolved via direct id or circle membership.
- **Moderated booking:** owner's own booking → `confirmed` immediately; others → `pending` (soft-holds the slot); owner confirms/rejects. "Busy" (= active = pending+confirmed, up to `capacity`) blocks new bookings (409). pending soft-holds (first-come); reject frees.
- **capacity** (default 1; N allows N concurrent active bookings).
- **Resource booking only on non-recurring events** (MVP constraint; recurring+resource → 400).
- **Booking UI = attach resource to an event** (picker in EventModal); management in a "Ресурсы" panel. Notifications `calendar.resource.requested/confirmed/rejected`.
- **Interactive calendar:** left **triage panel** (groups Просрочено/Без даты/Сегодня/Предстоящие; tasks+events). **Drag-and-drop:** drag tasks from panel onto month-day / week-day-slot → set dueDate; drag events+tasks within grid → move; **resize events** in week/day (drag bottom handle → change duration). Recurring instance drag/resize → **prompt this/all-series** (`RecurrenceScopeDialog`). Only own/non-overlay/non-busy items draggable.

## P3 data model (migrations calendar_phase3_resources)
- `Resource`: ownerId, workspaceId?(future), name, type(room|vehicle|equipment|other), capacity, bookerUserIds String[], bookerCircleIds String[]. owner User relation; bookings CalendarEvent[].
- `CalendarEvent` + `resourceId` (FK Resource, onDelete SetNull) + `resourceStatus` (pending|confirmed|rejected|null).

## P3 backend (apps/api/src/modules/calendar)
- `resources.service.ts` (ResourcesService): create/update/remove; list (mine + bookable-by-me, resolves canBook via myMemberCircleIds); schedule(id,from,to); incomingRequests(owner) = pending bookings; prepareBooking(resourceId,booker,start,end,exclude?) → {status,ownerId,name} (canBook + capacity check, throws 403/404/409); confirm/reject (owner, re-checks capacity, emits); emitRequested. Non-recurring enforced by CalendarService.
- `resources.controller.ts` `/api/resources`: GET (list), GET /requests, POST, PATCH/:id, DELETE/:id, GET /:id/schedule, POST /bookings/:eventId/confirm|reject.
- `calendar.service.ts` wired: createEvent/updateEvent handle `resourceId` (prepareBooking → status; time-change re-validates/re-pends; detach via resourceId=null); getRange includes resource name (occurrence carries resourceId/resourceName/resourceStatus, busy-stripped); getEventDetail returns resourceName/isResourceOwner + grants resource-owner access. occurrenceDto/toEventDto carry resource fields.
- CalendarModule: + ResourcesService + ResourcesController.
- notifications.events: calendar.* handler fans recipientIds[] for resource.* too (reused).

## P3 web (apps/web/src/app/calendar)
- `resources-ui.tsx` ResourcesPanel: incoming requests (confirm/reject), my resources CRUD + ResourceForm (name/type/capacity/who-can-book people+groups). Opened via "📦 Ресурсы" toolbar button.
- EventModal: resource picker (bookable list, non-recurring only) + booking status badge + owner confirm/reject; resource info in respond/view.
- `TriagePanel.tsx`: left panel groups + draggable task cards.
- `calendar-dnd.ts`: drag payload (module var) helpers setDrag/getDrag/clearDrag.
- page.tsx: triage panel layout (toggle), DnD handlers (reschedule task, moveEventNow, resizeNow, applyDrop, onDropDay/onDropSlot/onResize), RecurrenceScopeDialog; fetchUndated (GET /tasks filter no dueDate). MonthView day cells + TimeGrid slots are drop targets; event blocks draggable + resize handle (pointer events, 15-min snap); ItemChip draggable.

## Files (shared)
- types/validation/constants calendar.ts: + ResourceType, ResourceBookingStatus, Resource, Create/UpdateResourceRequest, ResourceBooking; event resourceId/resourceStatus (base + occurrence + detail resourceName/isResourceOwner); create/update event resourceId; createResource/updateResource schemas; RESOURCE_TYPE_META, RESOURCE_BOOKING_STATUS_META. notifications: + calendar.resource.requested/confirmed/rejected.

## Verified e2e
P1+P2 (prior). P3 backend: create resource → t2 book → pending → t1 sees request → confirm → confirmed; overlapping book → 409 (capacity); owner own book → confirmed. Web /calendar + /circles compile & serve 200; typecheck api+web clean. NOT visually browser-tested; mobile not built.

## Cross-cutting / follow-ups
- Global `ZodExceptionFilter` (P1) maps ZodError→400.
- Obsolete `addToCalendar` task flag (spawned cleanup).
- Resource booking constrained to non-recurring events (acceptable MVP).
- Drag "all series" sets master start=newStart (shifts anchor) — acceptable Google-like behavior.
