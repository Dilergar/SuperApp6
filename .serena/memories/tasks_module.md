# Tasks module (Task Manager) — built May 2026

Bitrix24-style task manager + TickTick time-manager. Design was locked via the grill-me skill before building (see auto-memory `project_tasks_module_design`).

## Data model (Prisma)
- **Task**: title, description, status (`todo|in_progress|on_review|done|cancelled`), priority, `dueDate`+`allDay`+`startDate`, `creatorId` (Постановщик), `assignedCircleId` (group label — set ⇒ group task), `parentId` (subtasks self-relation), `coinReward`/`coinPenalty`/`giftRewardId` (display-only intent), `reminderAt`+`reminderSentAt`, `recurrenceRule`+`recurrenceParentId`, `workspaceId` (B2B tenant key). Calendar link via existing `CalendarEvent.taskId`.
- **TaskParticipant** (new): `(taskId, userId, role)` unique per user. `role` = `executor|co_executor|observer` (Постановщик is NOT a participant — it's `Task.creatorId`). Per-participant `status` (`pending→submitted→accepted/returned`) + `submittedAt/acceptedAt/returnedAt` + `rewardCoins` snapshot + `giftRewardId`. `@@unique([taskId,userId])`, indexes `[userId,status]`, `[taskId,role]`.
- Migration `20260523224236_tasks_roles_participants` (dropped old `assignee_id`). NOTE: a prior baseline migration `20260524000000_account_deletion_scheduled_at` (idempotent `ADD COLUMN IF NOT EXISTS`) was added + `migrate resolve --applied` to reconcile pre-existing drift without data loss.

## Roles & assignment (decisions)
- One responsible **Исполнитель** per individual task; **Соисполнители**/**Наблюдатели** are N. Self-task = no participants, no acceptance.
- Assignment validated against the social graph: `TasksService.assertInEnvironment(ownerId, ids)` checks a `ContactLink` exists (canonical `userA<userB`); members of an `assignedCircleId` come from the owner's own Circle so they're contacts by definition.
- **Group task = ONE task, one chat** (NOT fan-out). `assignedCircleId` set, members snapshotted as `co_executor` participants, each with own status. Исполнитель field shows the group name. Progress = accepted/total. Whole task `done` only when ALL workers accepted. Coins shown "каждому по X".
- **Acceptance for all tasks from others**: executor `submit` → `on_review` → creator `accept` (→done when all accepted) or `return` (→in_progress). Self-task / creator-is-executor auto-accepts.

## API (`/api/tasks`)
CRUD + `POST /:id/submit`, `/:id/accept`, `/:id/return` (body `{participantUserId?}`), `/:id/comments` (chat, all roles). List supports `smartList` (today/upcoming/overdue/assigned_to_me/created_by_me/on_review) + role/status/priority/search filters. Controller parses Zod schemas from `@superapp/shared` (`createTaskSchema` is `.strict()` + refine: can't set both executorId and assignedCircleId).

## Events / cron
- `TasksService` emits `task.assigned|submitted|accepted|returned|completed|commented` with `{ recipientIds, taskTitle, byUserId?, byName? }`. `NotificationsEventsListener.handleTaskEvent` is generic: notifies each `recipientId` (skips the actor) with `actionUrl=/tasks/:id`. Registry types added in `@superapp/shared/constants/notifications`.
- `TasksCron` (Redis-locked): `dispatchDueReminders` every 10 min (idempotent via `reminderSentAt`), `dispatchOverdue` daily 09:00 (24h look-back window so each task flagged once). Recurrence spawns next instance on completion (`maybeSpawnRecurrence`).

## Shared package
`types/task.ts` (Task, TaskParticipant, TaskRole, ParticipantStatus, ViewerTaskRole, TaskSmartList, request types), `validation/task.ts` (Zod + XSS `noHtml` refine + `.strict()`), `constants/tasks.ts` (TASK_ROLE_LABELS, TASK_STATUS_META, TASK_PRIORITY_META, PARTICIPANT_STATUS_META, TASK_RECURRENCE_PRESETS, TASK_REMINDER_PRESETS, TASK_LIMITS).

## Web
`/tasks` (list + smart-list chips + create form with self/person/group assignment, people pickers from `/contacts` using `contact.them.id`, deadline/reminder/recurrence/priority/reward) and `/tasks/[id]` (roles, per-participant progress, submit/accept/return/start buttons, chat). Manual `useState`/`useEffect` + `api` (axios), sketchbook CSS classes — matches `/circles`. Dashboard already links `/tasks`.

## Verified end-to-end (smoke)
Self-task→done; assign to contact→submit→accept→done; assign to stranger→403; group task (1 task + per-participant, progress N/M)→done when all accepted.

## Not built (by design)
Real coin wallet/escrow (waits for the Store/Магазин подарков), gift rewards (`giftRewardId` reserved), B2B workspace assignment (schema ready via `workspaceId`/`userId`), Kanban/calendar views, mobile screens, real-time chat.
