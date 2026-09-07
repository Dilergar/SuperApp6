-- ============================================================
-- core/notifications (17-й платформенный движок): событие + строка на адресата + журнал доставки.
-- Старая write-only лента `notifications` и отдельная модель `mentions` сливаются в новую модель
-- с переносом данных; обе старые таблицы удаляются в конце этой же миграции.
-- ============================================================

-- ---------- 1. Старая лента уходит в сторону (имена индексов/констрейнтов освобождаются) ----------
ALTER TABLE "notifications" RENAME TO "notifications_legacy";
ALTER TABLE "notifications_legacy" RENAME CONSTRAINT "notifications_pkey" TO "notifications_legacy_pkey";
ALTER TABLE "notifications_legacy" RENAME CONSTRAINT "notifications_user_id_fkey" TO "notifications_legacy_user_id_fkey";
ALTER INDEX IF EXISTS "notifications_dedup_key_key" RENAME TO "notifications_legacy_dedup_key_key";
ALTER INDEX IF EXISTS "notifications_user_id_created_at_id_idx" RENAME TO "notifications_legacy_user_created_idx";
ALTER INDEX IF EXISTS "notifications_user_id_read_at_idx" RENAME TO "notifications_legacy_user_read_idx";
ALTER INDEX IF EXISTS "notifications_created_at_idx" RENAME TO "notifications_legacy_created_idx";

-- ---------- 2. Новые таблицы ----------
CREATE TABLE "notification_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "ref_type" TEXT,
    "ref_id" TEXT,
    "actor_id" TEXT,
    "workspace_id" TEXT,
    "collapse_key" TEXT,
    "idempotency_key" TEXT,
    "action_url" TEXT,
    "reason" TEXT,
    "recipients" JSONB NOT NULL DEFAULT '[]',
    "options" JSONB,
    "snapshot" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "type" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "reason" TEXT,
    "collapse_key" TEXT NOT NULL,
    "collapse_count" INTEGER NOT NULL DEFAULT 1,
    "actor_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seen_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "saved_at" TIMESTAMP(3),
    "snoozed_until" TIMESTAMP(3),
    "sort_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "user_id" TEXT,
    "channel" TEXT NOT NULL,
    "notification_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "skip_reason" TEXT,
    "provider_message_id" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduled_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workspace_notification_policies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_notification_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "subscription" JSONB,
    "user_agent" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_devices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_notification_settings" (
    "user_id" TEXT NOT NULL,
    "quiet_schedule" JSONB,
    "paused_until" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_notification_settings_pkey" PRIMARY KEY ("user_id")
);

-- ---------- 3. Индексы (обычные — по схеме; партиальные — руками, зеркалятся комментами в schema.prisma) ----------
CREATE INDEX "notification_events_ref_type_ref_id_idx" ON "notification_events"("ref_type", "ref_id");
CREATE INDEX "notification_events_created_at_idx" ON "notification_events"("created_at");
-- Идемпотентность у источника: повтор send с тем же ключом = ON CONFLICT DO NOTHING
CREATE UNIQUE INDEX "notification_events_type_idempotency_key_live" ON "notification_events"("type", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

CREATE INDEX "notifications_user_id_sort_at_id_idx" ON "notifications"("user_id", "sort_at", "id");
CREATE INDEX "notifications_user_id_workspace_id_idx" ON "notifications"("user_id", "workspace_id");
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");
-- Одна ЖИВАЯ (непрочитанная, неархивная) строка на ключ схлопывания у адресата
CREATE UNIQUE INDEX "notifications_user_collapse_live" ON "notifications"("user_id", "collapse_key") WHERE "read_at" IS NULL AND "archived_at" IS NULL;
-- Бейдж = unseen
CREATE INDEX "notifications_user_unseen_idx" ON "notifications"("user_id") WHERE "seen_at" IS NULL;
-- Пробуждение отложенных
CREATE INDEX "notifications_snoozed_idx" ON "notifications"("snoozed_until") WHERE "snoozed_until" IS NOT NULL;

CREATE INDEX "notification_deliveries_user_id_channel_status_scheduled_at_idx" ON "notification_deliveries"("user_id", "channel", "status", "scheduled_at");
CREATE INDEX "notification_deliveries_user_id_created_at_idx" ON "notification_deliveries"("user_id", "created_at");
CREATE INDEX "notification_deliveries_created_at_idx" ON "notification_deliveries"("created_at");
CREATE UNIQUE INDEX "notification_deliveries_event_id_recipient_channel_key" ON "notification_deliveries"("event_id", "recipient", "channel");

CREATE UNIQUE INDEX "notification_preferences_user_id_context_subject_kind_subje_key" ON "notification_preferences"("user_id", "context", "subject_kind", "subject_key", "channel");
CREATE UNIQUE INDEX "workspace_notification_policies_workspace_id_subject_kind_s_key" ON "workspace_notification_policies"("workspace_id", "subject_kind", "subject_key", "channel");
CREATE INDEX "notification_subscriptions_ref_type_ref_id_mode_idx" ON "notification_subscriptions"("ref_type", "ref_id", "mode");
CREATE UNIQUE INDEX "notification_subscriptions_user_id_ref_type_ref_id_key" ON "notification_subscriptions"("user_id", "ref_type", "ref_id");
CREATE INDEX "notification_devices_user_id_idx" ON "notification_devices"("user_id");
CREATE INDEX "notification_devices_last_seen_at_idx" ON "notification_devices"("last_seen_at");
CREATE UNIQUE INDEX "notification_devices_provider_token_key" ON "notification_devices"("provider", "token");

-- ---------- 4. Внешние ключи ----------
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "notification_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "notification_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_notification_policies" ADD CONSTRAINT "workspace_notification_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_subscriptions" ADD CONSTRAINT "notification_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_devices" ADD CONSTRAINT "notification_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_notification_settings" ADD CONSTRAINT "user_notification_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- 5. Перенос данных: старые строки ленты → событие + строка адресата ----------
-- Сервис и приоритет — из реестра на момент миграции (страж check:i18n держит реестр и каталог вместе).
-- Тип, которого в реестре больше нет (share.link.opened.muted и любые сироты), уходит в сервис
-- `system`/normal — строка остаётся читаемой через снимок текста (title/body ложатся в snapshot).
-- seen_at = сейчас: иначе в день релиза у каждого зажёгся бы бейдж на всю накопленную историю.
-- read_at — как был. workspace_id строки — организация из payload, ЕСЛИ адресат её член.
-- `mention.received` из старой ленты НЕ переносится: та же запись живёт в `mentions` с ref на
-- сообщение и своим read_at — берём её оттуда (шаг 6), иначе был бы дубль.
WITH reg(type, service, priority) AS (VALUES
  ('approval.requested','approvals','high'),
  ('approval.due_soon','approvals','high'),
  ('approval.overdue','approvals','high'),
  ('approval.resolved','approvals','normal'),
  ('approval.unassigned','approvals','high'),
  ('calendar.event.invited','calendar','high'),
  ('calendar.event.reminder','calendar','high'),
  ('calendar.event.rsvp','calendar','normal'),
  ('calendar.event.updated','calendar','high'),
  ('calendar.event.cancelled','calendar','high'),
  ('calendar.resource.requested','calendar','high'),
  ('calendar.resource.confirmed','calendar','high'),
  ('calendar.resource.rejected','calendar','high'),
  ('contact.invitation.received','contacts','high'),
  ('contact.invitation.accepted','contacts','normal'),
  ('contact.invitation.rejected','contacts','normal'),
  ('contact.invitation.cancelled','contacts','normal'),
  ('contact.invitation.expired','contacts','normal'),
  ('contact.linked','contacts','normal'),
  ('contact.removed','contacts','normal'),
  ('document.resolved','documents','high'),
  ('document.counterparty_signed','documents','high'),
  ('document.counterparty_declined','documents','high'),
  ('document.internal_declined','documents','high'),
  ('document.external_expired','documents','high'),
  ('drive.shared','drive','high'),
  ('finance.budget.warning','finances','normal'),
  ('finance.budget.exceeded','finances','high'),
  ('finance.debt.payment_due','finances','high'),
  ('finance.debt.paid','finances','normal'),
  ('finance.recurring.due','finances','high'),
  ('finance.recurring.recorded','finances','low'),
  ('finance.book.shared','finances','high'),
  ('hr.action.applied','hr','high'),
  ('hr.action.failed','hr','high'),
  ('hr.action.withdrawn','hr','high'),
  ('hr.esutd.due_soon','hr','critical'),
  ('hr.campaign.assigned','hr','high'),
  ('hr.campaign.reminder','hr','high'),
  ('hr.campaign.done','hr','normal'),
  ('hr.delivery.due','hr','critical'),
  ('hr.probation.ending','hr','high'),
  ('hr.contract.expiring','hr','critical'),
  ('call.missed','messenger','high'),
  ('messenger.scheduled.sent','messenger','normal'),
  ('note.shared','notes','high'),
  ('objects.shifts.published','objects','high'),
  ('objects.shift.changed','objects','high'),
  ('objects.shift.taken','objects','normal'),
  ('office.meeting.invited','office','high'),
  ('process.finished','processes','normal'),
  ('process.failed','processes','high'),
  ('process.step.notify','processes','high'),
  ('process.approval.requested','processes','high'),
  ('process.task.queued','processes','high'),
  ('process.step.overdue','processes','high'),
  ('voice.transcript.ready','recorder','normal'),
  ('voice.transcript.failed','recorder','normal'),
  ('call.recording.ready','recorder','normal'),
  ('call.recording.failed','recorder','normal'),
  ('auth.password.changed','security','critical'),
  ('auth.phone.changed','security','critical'),
  ('files.scan.infected','security','critical'),
  ('share.link.opened','share','low'),
  ('share.link.opened.muted','share','low'),
  ('shop.order.placed','shop','high'),
  ('shop.order.confirmed','shop','high'),
  ('shop.order.rejected','shop','high'),
  ('shop.order.cancelled','shop','normal'),
  ('shop.order.funded','shop','high'),
  ('sign.requested','sign','critical'),
  ('sign.completed','sign','high'),
  ('sign.declined','sign','high'),
  ('staff.head.assigned','staff','high'),
  ('staff.deputy.assigned','staff','high'),
  ('system.welcome','system','low'),
  ('system.announcement','system','normal'),
  ('task.assigned','tasks','high'),
  ('task.submitted','tasks','high'),
  ('task.accepted','tasks','high'),
  ('task.returned','tasks','high'),
  ('task.completed','tasks','normal'),
  ('task.due_soon','tasks','high'),
  ('task.overdue','tasks','high'),
  ('wallet.coins.received','wallet','normal'),
  ('workspace.invitation.received','workspaces','high'),
  ('workspace.invitation.accepted','workspaces','high'),
  ('workspace.invitation.rejected','workspaces','normal'),
  ('workspace.member.removed','workspaces','high'),
  ('workspace.role.changed','workspaces','high'),
  ('workspace.position.assigned','workspaces','high'),
  ('workspace.position.certified','workspaces','high'),
  ('workspace.archive.expiring','workspaces','critical')
),
src AS (
  SELECT
    l."id" AS row_id,
    gen_random_uuid()::text AS ev_id,
    l."user_id",
    l."type",
    COALESCE(r.service, 'system') AS service,
    COALESCE(r.priority, 'normal') AS priority,
    COALESCE(l."payload", '{}'::jsonb) AS payload,
    NULLIF(l."payload"->>'byUserId', l."user_id") AS actor_id,
    l."payload"->>'workspaceId' AS ws_id,
    l."action_url",
    l."dedup_key",
    l."title",
    l."body",
    l."read_at",
    l."created_at"
  FROM "notifications_legacy" l
  LEFT JOIN reg r ON r.type = l."type"
  WHERE l."type" <> 'mention.received'
),
ev AS (
  INSERT INTO "notification_events"
    ("id", "type", "service", "priority", "payload", "actor_id", "workspace_id", "idempotency_key", "action_url", "recipients", "snapshot", "created_at")
  SELECT
    ev_id, "type", service, priority, payload, actor_id, ws_id, "dedup_key", "action_url",
    jsonb_build_array(jsonb_build_object('userId', "user_id")),
    jsonb_build_object('title', "title", 'body', "body"),
    "created_at"
  FROM src
  RETURNING "id"
)
INSERT INTO "notifications"
  ("id", "event_id", "user_id", "workspace_id", "type", "service", "priority", "collapse_key", "collapse_count", "actor_ids",
   "seen_at", "read_at", "sort_at", "created_at", "updated_at")
SELECT
  row_id, ev_id, "user_id",
  CASE
    WHEN ws_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM "user_roles" ur
      WHERE ur."user_id" = src."user_id" AND ur."context" = 'workspace' AND ur."tenant_id" = ws_id AND ur."is_active"
    ) THEN ws_id
    ELSE NULL
  END,
  "type", service, priority, ev_id, 1,
  CASE WHEN actor_id IS NULL THEN ARRAY[]::TEXT[] ELSE ARRAY[actor_id] END,
  (now() AT TIME ZONE 'UTC'), "read_at", "created_at", "created_at", (now() AT TIME ZONE 'UTC')
FROM src;

-- ---------- 6. Перенос упоминаний: Mention → событие mention.received с ref на сообщение/источник ----------
-- Непрочитанные остаются unseen (seen_at = read_at): человек их ещё не видел.
WITH src AS (
  SELECT
    m."id" AS row_id,
    gen_random_uuid()::text AS ev_id,
    m."mentioned_user_id",
    m."mentioner_user_id",
    m."source_type",
    m."source_id",
    m."chat_id",
    m."message_id",
    m."snippet",
    m."read_at",
    m."created_at",
    NULLIF(TRIM(COALESCE(u."first_name", '') || ' ' || COALESCE(u."last_name", '')), '') AS mentioner_name,
    CASE
      WHEN m."message_id" IS NOT NULL THEN 'chat_message'
      WHEN m."source_type" = 'messenger' THEN 'chat'
      ELSE m."source_type"
    END AS ref_type,
    COALESCE(m."message_id", m."source_id") AS ref_id,
    CASE m."source_type"
      WHEN 'messenger' THEN '/messenger?chat=' || COALESCE(m."chat_id", m."source_id") || CASE WHEN m."message_id" IS NOT NULL THEN '&msg=' || m."message_id" ELSE '' END
      WHEN 'task' THEN '/tasks/' || m."source_id"
      WHEN 'calendar' THEN '/calendar?event=' || m."source_id"
      WHEN 'listing' THEN '/shop?listing=' || m."source_id"
      WHEN 'note' THEN '/notes/' || m."source_id"
      ELSE '/'
    END AS href,
    c."workspace_id" AS ws_id
  FROM "mentions" m
  LEFT JOIN "users" u ON u."id" = m."mentioner_user_id"
  LEFT JOIN "chats" c ON c."id" = m."chat_id"
),
ev AS (
  INSERT INTO "notification_events"
    ("id", "type", "service", "priority", "payload", "ref_type", "ref_id", "actor_id", "workspace_id", "idempotency_key", "action_url", "reason", "recipients", "created_at")
  SELECT
    ev_id, 'mention.received', 'messenger', 'high',
    jsonb_strip_nulls(jsonb_build_object(
      'mentionerName', COALESCE(mentioner_name, ''),
      'snippet', COALESCE(snippet, ''),
      'chatId', chat_id, 'messageId', message_id, 'sourceType', source_type, 'sourceId', source_id
    )),
    ref_type, ref_id, mentioner_user_id, ws_id,
    'mention:' || COALESCE(message_id, source_type || ':' || source_id) || ':' || mentioned_user_id,
    href, 'mention',
    jsonb_build_array(jsonb_build_object('userId', mentioned_user_id)),
    created_at
  FROM src
  RETURNING "id"
)
INSERT INTO "notifications"
  ("id", "event_id", "user_id", "workspace_id", "type", "service", "priority", "reason", "collapse_key", "collapse_count", "actor_ids",
   "seen_at", "read_at", "sort_at", "created_at", "updated_at")
SELECT
  row_id, ev_id, mentioned_user_id,
  CASE
    WHEN ws_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM "user_roles" ur
      WHERE ur."user_id" = src.mentioned_user_id AND ur."context" = 'workspace' AND ur."tenant_id" = ws_id AND ur."is_active"
    ) THEN ws_id
    ELSE NULL
  END,
  'mention.received', 'messenger', 'high', 'mention', ev_id, 1, ARRAY[mentioner_user_id],
  read_at, read_at, created_at, created_at, (now() AT TIME ZONE 'UTC')
FROM src;

-- ---------- 7. Старые таблицы больше не нужны ----------
DROP TABLE "notifications_legacy";
DROP TABLE "mentions";
