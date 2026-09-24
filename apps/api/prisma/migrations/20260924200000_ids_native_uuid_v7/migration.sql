-- Архитектура данных: идентификаторы в нативный uuid (16 байт вместо 36-символьного TEXT) и
-- UUIDv7 по умолчанию на стороне БАЗЫ (сырые INSERT тоже получают v7, часы одни).
-- СГЕНЕРИРОВАНО apps/api/scripts/gen-uuid-migration.cjs по schema.prisma (@db.Uuid) и живой базе.
-- Не-UUID значение в целевой колонке роняет миграцию целиком — данные чистятся ДО, не теряются молча.
SET lock_timeout = '3s';
SET statement_timeout = '600s';

-- 1. Внешние ключи, касающиеся колонок (198) — сброс
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_currency_id_fkey";
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_bot_id_fkey";
ALTER TABLE "approval_decisions" DROP CONSTRAINT "approval_decisions_step_id_fkey";
ALTER TABLE "approval_steps" DROP CONSTRAINT "approval_steps_request_id_fkey";
ALTER TABLE "asset_models" DROP CONSTRAINT "asset_models_workspace_id_fkey";
ALTER TABLE "asset_moves" DROP CONSTRAINT "asset_moves_asset_id_fkey";
ALTER TABLE "asset_moves" DROP CONSTRAINT "asset_moves_workspace_id_fkey";
ALTER TABLE "asset_service_records" DROP CONSTRAINT "asset_service_records_workspace_id_fkey";
ALTER TABLE "asset_service_records" DROP CONSTRAINT "asset_service_records_asset_id_fkey";
ALTER TABLE "asset_service_records" DROP CONSTRAINT "asset_service_records_counterparty_id_fkey";
ALTER TABLE "assets" DROP CONSTRAINT "assets_holding_counterparty_id_fkey";
ALTER TABLE "assets" DROP CONSTRAINT "assets_model_id_fkey";
ALTER TABLE "assets" DROP CONSTRAINT "assets_workspace_id_fkey";
ALTER TABLE "assets" DROP CONSTRAINT "assets_branch_id_fkey";
ALTER TABLE "assets" DROP CONSTRAINT "assets_balance_legal_entity_id_fkey";
ALTER TABLE "assets" DROP CONSTRAINT "assets_parent_asset_id_fkey";
ALTER TABLE "bots" DROP CONSTRAINT "bots_workspace_id_fkey";
ALTER TABLE "bots" DROP CONSTRAINT "bots_user_id_fkey";
ALTER TABLE "calendar_event_reminders" DROP CONSTRAINT "calendar_event_reminders_event_id_fkey";
ALTER TABLE "calendar_events" DROP CONSTRAINT "calendar_events_user_id_fkey";
ALTER TABLE "calendar_events" DROP CONSTRAINT "calendar_events_resource_id_fkey";
ALTER TABLE "calendar_events" DROP CONSTRAINT "calendar_events_recurrence_parent_id_fkey";
ALTER TABLE "call_recording_claims" DROP CONSTRAINT "call_recording_claims_recording_id_fkey";
ALTER TABLE "call_recordings" DROP CONSTRAINT "call_recordings_session_id_fkey";
ALTER TABLE "call_session_participants" DROP CONSTRAINT "call_session_participants_session_id_fkey";
ALTER TABLE "card_skin_instances" DROP CONSTRAINT "card_skin_instances_skin_id_fkey";
ALTER TABLE "card_skin_transfers" DROP CONSTRAINT "card_skin_transfers_instance_id_fkey";
ALTER TABLE "chat_members" DROP CONSTRAINT "chat_members_chat_id_fkey";
ALTER TABLE "chat_members" DROP CONSTRAINT "chat_members_user_id_fkey";
ALTER TABLE "circle_memberships" DROP CONSTRAINT "circle_memberships_contact_link_id_fkey";
ALTER TABLE "circle_memberships" DROP CONSTRAINT "circle_memberships_circle_id_fkey";
ALTER TABLE "circles" DROP CONSTRAINT "circles_owner_id_fkey";
ALTER TABLE "consent_acceptances" DROP CONSTRAINT "consent_acceptances_version_id_fkey";
ALTER TABLE "contact_blocks" DROP CONSTRAINT "contact_blocks_blocked_id_fkey";
ALTER TABLE "contact_blocks" DROP CONSTRAINT "contact_blocks_blocker_id_fkey";
ALTER TABLE "contact_invitations" DROP CONSTRAINT "contact_invitations_to_user_id_fkey";
ALTER TABLE "contact_invitations" DROP CONSTRAINT "contact_invitations_from_user_id_fkey";
ALTER TABLE "contact_links" DROP CONSTRAINT "contact_links_user_b_id_fkey";
ALTER TABLE "contact_links" DROP CONSTRAINT "contact_links_user_a_id_fkey";
ALTER TABLE "counterparties" DROP CONSTRAINT "counterparties_workspace_id_fkey";
ALTER TABLE "counterparty_bank_accounts" DROP CONSTRAINT "counterparty_bank_accounts_counterparty_id_fkey";
ALTER TABLE "counterparty_contacts" DROP CONSTRAINT "counterparty_contacts_counterparty_id_fkey";
ALTER TABLE "crypto_key_versions" DROP CONSTRAINT "crypto_key_versions_key_id_fkey";
ALTER TABLE "doc_campaign_targets" DROP CONSTRAINT "doc_campaign_targets_campaign_id_fkey";
ALTER TABLE "doc_campaigns" DROP CONSTRAINT "doc_campaigns_workspace_id_fkey";
ALTER TABLE "doc_template_library_installs" DROP CONSTRAINT "doc_template_library_installs_workspace_id_fkey";
ALTER TABLE "doc_templates" DROP CONSTRAINT "doc_templates_workspace_id_fkey";
ALTER TABLE "doc_templates" DROP CONSTRAINT "doc_templates_doc_type_id_fkey";
ALTER TABLE "doc_type_counters" DROP CONSTRAINT "doc_type_counters_doc_type_id_fkey";
ALTER TABLE "doc_types" DROP CONSTRAINT "doc_types_workspace_id_fkey";
ALTER TABLE "document_sessions" DROP CONSTRAINT "document_sessions_document_id_fkey";
ALTER TABLE "document_versions" DROP CONSTRAINT "document_versions_document_id_fkey";
ALTER TABLE "drive_node_versions" DROP CONSTRAINT "drive_node_versions_file_id_fkey";
ALTER TABLE "drive_node_versions" DROP CONSTRAINT "drive_node_versions_node_id_fkey";
ALTER TABLE "drive_nodes" DROP CONSTRAINT "drive_nodes_space_id_fkey";
ALTER TABLE "drive_nodes" DROP CONSTRAINT "drive_nodes_file_id_fkey";
ALTER TABLE "drive_nodes" DROP CONSTRAINT "drive_nodes_parent_id_fkey";
ALTER TABLE "drive_photo_buckets" DROP CONSTRAINT "drive_photo_buckets_space_id_fkey";
ALTER TABLE "drive_recents" DROP CONSTRAINT "drive_recents_node_id_fkey";
ALTER TABLE "drive_stars" DROP CONSTRAINT "drive_stars_node_id_fkey";
ALTER TABLE "escrow_holds" DROP CONSTRAINT "escrow_holds_agreement_id_fkey";
ALTER TABLE "event_participants" DROP CONSTRAINT "event_participants_event_id_fkey";
ALTER TABLE "file_links" DROP CONSTRAINT "file_links_file_id_fkey";
ALTER TABLE "file_variants" DROP CONSTRAINT "file_variants_file_id_fkey";
ALTER TABLE "fin_accounts" DROP CONSTRAINT "fin_accounts_book_id_fkey";
ALTER TABLE "fin_accounts" DROP CONSTRAINT "fin_accounts_parent_id_fkey";
ALTER TABLE "fin_budgets" DROP CONSTRAINT "fin_budgets_book_id_fkey";
ALTER TABLE "fin_people" DROP CONSTRAINT "fin_people_book_id_fkey";
ALTER TABLE "fin_recurring_rules" DROP CONSTRAINT "fin_recurring_rules_book_id_fkey";
ALTER TABLE "fin_transactions" DROP CONSTRAINT "fin_transactions_to_account_id_fkey";
ALTER TABLE "fin_transactions" DROP CONSTRAINT "fin_transactions_book_id_fkey";
ALTER TABLE "fin_transactions" DROP CONSTRAINT "fin_transactions_from_account_id_fkey";
ALTER TABLE "google_connections" DROP CONSTRAINT "google_connections_user_id_fkey";
ALTER TABLE "hr_action_batches" DROP CONSTRAINT "hr_action_batches_workspace_id_fkey";
ALTER TABLE "hr_actions" DROP CONSTRAINT "hr_actions_workspace_id_fkey";
ALTER TABLE "hr_employments" DROP CONSTRAINT "hr_employments_legal_entity_id_fkey";
ALTER TABLE "hr_employments" DROP CONSTRAINT "hr_employments_workspace_id_fkey";
ALTER TABLE "hr_esutd_submissions" DROP CONSTRAINT "hr_esutd_submissions_workspace_id_fkey";
ALTER TABLE "legal_entities" DROP CONSTRAINT "legal_entities_workspace_id_fkey";
ALTER TABLE "listing_prices" DROP CONSTRAINT "listing_prices_listing_id_fkey";
ALTER TABLE "listings" DROP CONSTRAINT "listings_showcase_id_fkey";
ALTER TABLE "messages" DROP CONSTRAINT "messages_reply_to_id_fkey";
ALTER TABLE "messages" DROP CONSTRAINT "messages_author_id_fkey";
ALTER TABLE "messages" DROP CONSTRAINT "messages_chat_id_fkey";
ALTER TABLE "note_board_items" DROP CONSTRAINT "note_board_items_note_id_fkey";
ALTER TABLE "note_board_items" DROP CONSTRAINT "note_board_items_space_id_fkey";
ALTER TABLE "note_chunks" DROP CONSTRAINT "note_chunks_space_id_fkey";
ALTER TABLE "note_chunks" DROP CONSTRAINT "note_chunks_note_id_fkey";
ALTER TABLE "note_folders" DROP CONSTRAINT "note_folders_parent_id_fkey";
ALTER TABLE "note_folders" DROP CONSTRAINT "note_folders_space_id_fkey";
ALTER TABLE "note_links" DROP CONSTRAINT "note_links_note_id_fkey";
ALTER TABLE "note_revisions" DROP CONSTRAINT "note_revisions_note_id_fkey";
ALTER TABLE "notes" DROP CONSTRAINT "notes_space_id_fkey";
ALTER TABLE "notes" DROP CONSTRAINT "notes_folder_id_fkey";
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_event_id_fkey";
ALTER TABLE "notification_devices" DROP CONSTRAINT "notification_devices_user_id_fkey";
ALTER TABLE "notification_preferences" DROP CONSTRAINT "notification_preferences_user_id_fkey";
ALTER TABLE "notification_subscriptions" DROP CONSTRAINT "notification_subscriptions_user_id_fkey";
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_user_id_fkey";
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_event_id_fkey";
ALTER TABLE "office_room_participants" DROP CONSTRAINT "office_room_participants_room_id_fkey";
ALTER TABLE "office_rooms" DROP CONSTRAINT "office_rooms_workspace_id_fkey";
ALTER TABLE "order_contributions" DROP CONSTRAINT "order_contributions_order_id_fkey";
ALTER TABLE "order_prices" DROP CONSTRAINT "order_prices_order_id_fkey";
ALTER TABLE "orders" DROP CONSTRAINT "orders_listing_id_fkey";
ALTER TABLE "org_documents" DROP CONSTRAINT "org_documents_template_id_fkey";
ALTER TABLE "org_documents" DROP CONSTRAINT "org_documents_workspace_id_fkey";
ALTER TABLE "org_documents" DROP CONSTRAINT "org_documents_parent_document_id_fkey";
ALTER TABLE "org_documents" DROP CONSTRAINT "org_documents_doc_type_id_fkey";
ALTER TABLE "pd_incident_events" DROP CONSTRAINT "pd_incident_events_incident_id_fkey";
ALTER TABLE "plan_versions" DROP CONSTRAINT "plan_versions_plan_id_fkey";
ALTER TABLE "platform_staff_roles" DROP CONSTRAINT "platform_staff_roles_user_id_fkey";
ALTER TABLE "process_instances" DROP CONSTRAINT "process_instances_definition_id_fkey";
ALTER TABLE "process_instances" DROP CONSTRAINT "process_instances_version_id_fkey";
ALTER TABLE "process_step_runs" DROP CONSTRAINT "process_step_runs_instance_id_fkey";
ALTER TABLE "process_triggers" DROP CONSTRAINT "process_triggers_definition_id_fkey";
ALTER TABLE "process_versions" DROP CONSTRAINT "process_versions_definition_id_fkey";
ALTER TABLE "resources" DROP CONSTRAINT "resources_owner_id_fkey";
ALTER TABLE "scheduled_messages" DROP CONSTRAINT "scheduled_messages_author_id_fkey";
ALTER TABLE "scheduled_messages" DROP CONSTRAINT "scheduled_messages_chat_id_fkey";
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_fkey";
ALTER TABLE "share_link_visits" DROP CONSTRAINT "share_link_visits_guest_id_fkey";
ALTER TABLE "share_link_visits" DROP CONSTRAINT "share_link_visits_link_id_fkey";
ALTER TABLE "shift_attendance" DROP CONSTRAINT "shift_attendance_branch_id_fkey";
ALTER TABLE "shift_attendance" DROP CONSTRAINT "shift_attendance_workspace_id_fkey";
ALTER TABLE "shift_attendance" DROP CONSTRAINT "shift_attendance_shift_id_fkey";
ALTER TABLE "shift_patterns" DROP CONSTRAINT "shift_patterns_workspace_id_fkey";
ALTER TABLE "shift_patterns" DROP CONSTRAINT "shift_patterns_branch_id_fkey";
ALTER TABLE "shift_patterns" DROP CONSTRAINT "shift_patterns_staffing_position_id_fkey";
ALTER TABLE "shift_patterns" DROP CONSTRAINT "shift_patterns_assignment_id_fkey";
ALTER TABLE "shift_templates" DROP CONSTRAINT "shift_templates_workspace_id_fkey";
ALTER TABLE "shift_templates" DROP CONSTRAINT "shift_templates_branch_id_fkey";
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_pattern_id_fkey";
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_branch_id_fkey";
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_position_id_fkey";
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_assignment_id_fkey";
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_workspace_id_fkey";
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_template_id_fkey";
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_staffing_position_id_fkey";
ALTER TABLE "showcases" DROP CONSTRAINT "showcases_shop_id_fkey";
ALTER TABLE "sign_act_events" DROP CONSTRAINT "sign_act_events_act_id_fkey";
ALTER TABLE "sign_acts" DROP CONSTRAINT "sign_acts_request_id_fkey";
ALTER TABLE "sign_qr_sessions" DROP CONSTRAINT "sign_qr_sessions_act_id_fkey";
ALTER TABLE "staff_assignments" DROP CONSTRAINT "staff_assignments_staffing_position_id_fkey";
ALTER TABLE "staff_assignments" DROP CONSTRAINT "staff_assignments_position_id_fkey";
ALTER TABLE "staff_assignments" DROP CONSTRAINT "staff_assignments_branch_id_fkey";
ALTER TABLE "staff_assignments" DROP CONSTRAINT "staff_assignments_workspace_id_fkey";
ALTER TABLE "staff_assignments" DROP CONSTRAINT "staff_assignments_user_id_fkey";
ALTER TABLE "staff_branches" DROP CONSTRAINT "staff_branches_parent_id_fkey";
ALTER TABLE "staff_branches" DROP CONSTRAINT "staff_branches_head_position_id_fkey";
ALTER TABLE "staff_branches" DROP CONSTRAINT "staff_branches_legal_entity_id_fkey";
ALTER TABLE "staff_branches" DROP CONSTRAINT "staff_branches_workspace_id_fkey";
ALTER TABLE "staff_departments" DROP CONSTRAINT "staff_departments_workspace_id_fkey";
ALTER TABLE "staff_departments" DROP CONSTRAINT "staff_departments_parent_id_fkey";
ALTER TABLE "staff_departments" DROP CONSTRAINT "staff_departments_head_position_id_fkey";
ALTER TABLE "staff_deputies" DROP CONSTRAINT "staff_deputies_deputy_user_id_fkey";
ALTER TABLE "staff_deputies" DROP CONSTRAINT "staff_deputies_branch_id_fkey";
ALTER TABLE "staff_deputies" DROP CONSTRAINT "staff_deputies_workspace_id_fkey";
ALTER TABLE "staff_deputies" DROP CONSTRAINT "staff_deputies_deputy_position_id_fkey";
ALTER TABLE "staff_deputies" DROP CONSTRAINT "staff_deputies_position_id_fkey";
ALTER TABLE "staff_positions" DROP CONSTRAINT "staff_positions_workspace_id_fkey";
ALTER TABLE "staff_positions" DROP CONSTRAINT "staff_positions_department_id_fkey";
ALTER TABLE "staff_positions" DROP CONSTRAINT "staff_positions_reports_to_position_id_fkey";
ALTER TABLE "staff_rates" DROP CONSTRAINT "staff_rates_workspace_id_fkey";
ALTER TABLE "staff_rates" DROP CONSTRAINT "staff_rates_staffing_position_id_fkey";
ALTER TABLE "staff_rates" DROP CONSTRAINT "staff_rates_assignment_id_fkey";
ALTER TABLE "staffing_positions" DROP CONSTRAINT "staffing_positions_position_id_fkey";
ALTER TABLE "staffing_positions" DROP CONSTRAINT "staffing_positions_branch_id_fkey";
ALTER TABLE "staffing_positions" DROP CONSTRAINT "staffing_positions_shift_template_id_fkey";
ALTER TABLE "staffing_positions" DROP CONSTRAINT "staffing_positions_workspace_id_fkey";
ALTER TABLE "subject_subscriptions" DROP CONSTRAINT "subject_subscriptions_plan_version_id_fkey";
ALTER TABLE "task_participants" DROP CONSTRAINT "task_participants_user_id_fkey";
ALTER TABLE "task_participants" DROP CONSTRAINT "task_participants_task_id_fkey";
ALTER TABLE "task_tags" DROP CONSTRAINT "task_tags_task_id_fkey";
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_creator_id_fkey";
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_parent_id_fkey";
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_assigned_circle_id_fkey";
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_workspace_id_fkey";
ALTER TABLE "user_devices" DROP CONSTRAINT "user_devices_user_id_fkey";
ALTER TABLE "user_notification_settings" DROP CONSTRAINT "user_notification_settings_user_id_fkey";
ALTER TABLE "user_payment_cards" DROP CONSTRAINT "user_payment_cards_user_id_fkey";
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_user_id_fkey";
ALTER TABLE "visibility_rules" DROP CONSTRAINT "visibility_rules_policy_id_fkey";
ALTER TABLE "voice_transcripts" DROP CONSTRAINT "voice_transcripts_file_id_fkey";
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_endpoint_id_fkey";
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_workspace_id_fkey";
ALTER TABLE "workspace_bank_accounts" DROP CONSTRAINT "workspace_bank_accounts_workspace_id_fkey";
ALTER TABLE "workspace_bank_accounts" DROP CONSTRAINT "workspace_bank_accounts_legal_entity_id_fkey";
ALTER TABLE "workspace_invitations" DROP CONSTRAINT "workspace_invitations_invited_by_fkey";
ALTER TABLE "workspace_invitations" DROP CONSTRAINT "workspace_invitations_workspace_id_fkey";
ALTER TABLE "workspace_invitations" DROP CONSTRAINT "workspace_invitations_position_id_fkey";
ALTER TABLE "workspace_invitations" DROP CONSTRAINT "workspace_invitations_to_user_id_fkey";
ALTER TABLE "workspace_key_policies" DROP CONSTRAINT "workspace_key_policies_workspace_id_fkey";
ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_workspace_id_fkey";
ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_user_id_fkey";
ALTER TABLE "workspace_notification_policies" DROP CONSTRAINT "workspace_notification_policies_workspace_id_fkey";
ALTER TABLE "workspace_visibility_settings" DROP CONSTRAINT "workspace_visibility_settings_workspace_id_fkey";
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_owner_id_fkey";
-- Индексы с COALESCE(id, '') — снимаются и возвращаются как UNIQUE … NULLS NOT DISTINCT
DROP INDEX "staff_branches_parent_name_key";
DROP INDEX "staff_deputies_dedup_key";
DROP INDEX "note_folder_name_uniq";

-- 2. Смена типа (588 колонок): одна ALTER TABLE на таблицу — одна перезапись
ALTER TABLE "accounts"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "currency_id" TYPE uuid USING "currency_id"::uuid;
ALTER TABLE "analytics_dashboards"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "analytics_quarantine"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "analytics_reports"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "api_keys"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "bot_id" TYPE uuid USING "bot_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "family_id" TYPE uuid USING "family_id"::uuid,
  ALTER COLUMN "rotated_from_id" TYPE uuid USING "rotated_from_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "approval_decisions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "step_id" TYPE uuid USING "step_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "sign_act_id" TYPE uuid USING "sign_act_id"::uuid;
ALTER TABLE "approval_requests"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "approval_steps"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "request_id" TYPE uuid USING "request_id"::uuid,
  ALTER COLUMN "awaiting_user_ids" DROP DEFAULT,
  ALTER COLUMN "awaiting_user_ids" TYPE uuid[] USING "awaiting_user_ids"::uuid[];
ALTER TABLE "asset_models"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "asset_moves"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "asset_id" TYPE uuid USING "asset_id"::uuid,
  ALTER COLUMN "from_branch_id" TYPE uuid USING "from_branch_id"::uuid,
  ALTER COLUMN "to_branch_id" TYPE uuid USING "to_branch_id"::uuid,
  ALTER COLUMN "from_parent_asset_id" TYPE uuid USING "from_parent_asset_id"::uuid,
  ALTER COLUMN "to_parent_asset_id" TYPE uuid USING "to_parent_asset_id"::uuid,
  ALTER COLUMN "from_user_id" TYPE uuid USING "from_user_id"::uuid,
  ALTER COLUMN "to_user_id" TYPE uuid USING "to_user_id"::uuid,
  ALTER COLUMN "moved_by_id" TYPE uuid USING "moved_by_id"::uuid;
ALTER TABLE "asset_service_records"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "asset_id" TYPE uuid USING "asset_id"::uuid,
  ALTER COLUMN "performed_by_user_id" TYPE uuid USING "performed_by_user_id"::uuid,
  ALTER COLUMN "counterparty_id" TYPE uuid USING "counterparty_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "assets"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "model_id" TYPE uuid USING "model_id"::uuid,
  ALTER COLUMN "branch_id" TYPE uuid USING "branch_id"::uuid,
  ALTER COLUMN "parent_asset_id" TYPE uuid USING "parent_asset_id"::uuid,
  ALTER COLUMN "balance_legal_entity_id" TYPE uuid USING "balance_legal_entity_id"::uuid,
  ALTER COLUMN "holding_counterparty_id" TYPE uuid USING "holding_counterparty_id"::uuid,
  ALTER COLUMN "custodian_user_id" TYPE uuid USING "custodian_user_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "bots"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "responsible_user_id" TYPE uuid USING "responsible_user_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "calendar_event_reminders"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "event_id" TYPE uuid USING "event_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "calendar_events"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "recurrence_parent_id" TYPE uuid USING "recurrence_parent_id"::uuid,
  ALTER COLUMN "resource_id" TYPE uuid USING "resource_id"::uuid;
ALTER TABLE "call_recording_claims"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "recording_id" TYPE uuid USING "recording_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "call_recordings"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "session_id" TYPE uuid USING "session_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "started_by_id" TYPE uuid USING "started_by_id"::uuid,
  ALTER COLUMN "file_id" TYPE uuid USING "file_id"::uuid;
ALTER TABLE "call_session_participants"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "session_id" TYPE uuid USING "session_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "call_sessions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "started_by_id" TYPE uuid USING "started_by_id"::uuid;
ALTER TABLE "card_skin_instances"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "skin_id" TYPE uuid USING "skin_id"::uuid,
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid;
ALTER TABLE "card_skin_transfers"
  ALTER COLUMN "instance_id" TYPE uuid USING "instance_id"::uuid,
  ALTER COLUMN "from_user_id" TYPE uuid USING "from_user_id"::uuid,
  ALTER COLUMN "to_user_id" TYPE uuid USING "to_user_id"::uuid;
ALTER TABLE "card_skins"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "author_id" TYPE uuid USING "author_id"::uuid;
ALTER TABLE "chat_members"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "chat_id" TYPE uuid USING "chat_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "chats"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "parent_id" TYPE uuid USING "parent_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid;
ALTER TABLE "chatter_entries"
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "actor_id" TYPE uuid USING "actor_id"::uuid;
ALTER TABLE "circle_memberships"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "circle_id" TYPE uuid USING "circle_id"::uuid,
  ALTER COLUMN "contact_link_id" TYPE uuid USING "contact_link_id"::uuid;
ALTER TABLE "circles"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid,
  ALTER COLUMN "equipped_skin_instance_id" TYPE uuid USING "equipped_skin_instance_id"::uuid;
ALTER TABLE "consent_acceptances"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "version_id" TYPE uuid USING "version_id"::uuid,
  ALTER COLUMN "actor_user_id" TYPE uuid USING "actor_user_id"::uuid,
  ALTER COLUMN "verify_challenge_id" TYPE uuid USING "verify_challenge_id"::uuid;
ALTER TABLE "consent_versions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "attestation_sign_request_id" TYPE uuid USING "attestation_sign_request_id"::uuid,
  ALTER COLUMN "attestation_file_id" TYPE uuid USING "attestation_file_id"::uuid,
  ALTER COLUMN "published_by_id" TYPE uuid USING "published_by_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "contact_blocks"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "blocker_id" TYPE uuid USING "blocker_id"::uuid,
  ALTER COLUMN "blocked_id" TYPE uuid USING "blocked_id"::uuid;
ALTER TABLE "contact_invitations"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "from_user_id" TYPE uuid USING "from_user_id"::uuid,
  ALTER COLUMN "to_user_id" TYPE uuid USING "to_user_id"::uuid,
  ALTER COLUMN "auto_add_circle_ids" TYPE uuid[] USING "auto_add_circle_ids"::uuid[];
ALTER TABLE "contact_links"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_a_id" TYPE uuid USING "user_a_id"::uuid,
  ALTER COLUMN "user_b_id" TYPE uuid USING "user_b_id"::uuid;
ALTER TABLE "counterparties"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "counterparty_bank_accounts"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "counterparty_id" TYPE uuid USING "counterparty_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid;
ALTER TABLE "counterparty_contacts"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "counterparty_id" TYPE uuid USING "counterparty_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid;
ALTER TABLE "crypto_key_versions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "key_id" TYPE uuid USING "key_id"::uuid;
ALTER TABLE "crypto_keys"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "primary_version_id" TYPE uuid USING "primary_version_id"::uuid;
ALTER TABLE "currencies"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "doc_campaign_targets"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "campaign_id" TYPE uuid USING "campaign_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "sign_act_id" TYPE uuid USING "sign_act_id"::uuid;
ALTER TABLE "doc_campaigns"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "org_document_id" TYPE uuid USING "org_document_id"::uuid,
  ALTER COLUMN "subject_file_id" TYPE uuid USING "subject_file_id"::uuid,
  ALTER COLUMN "sign_request_id" TYPE uuid USING "sign_request_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "doc_template_library_installs"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "doc_type_id" TYPE uuid USING "doc_type_id"::uuid,
  ALTER COLUMN "template_id" TYPE uuid USING "template_id"::uuid,
  ALTER COLUMN "process_id" TYPE uuid USING "process_id"::uuid,
  ALTER COLUMN "installed_by_id" TYPE uuid USING "installed_by_id"::uuid;
ALTER TABLE "doc_templates"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "doc_type_id" TYPE uuid USING "doc_type_id"::uuid,
  ALTER COLUMN "document_id" TYPE uuid USING "document_id"::uuid,
  ALTER COLUMN "file_id" TYPE uuid USING "file_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "doc_type_counters"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "doc_type_id" TYPE uuid USING "doc_type_id"::uuid;
ALTER TABLE "doc_types"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid;
ALTER TABLE "document_sessions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "document_id" TYPE uuid USING "document_id"::uuid,
  ALTER COLUMN "participant_ids" DROP DEFAULT,
  ALTER COLUMN "participant_ids" TYPE uuid[] USING "participant_ids"::uuid[];
ALTER TABLE "document_versions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "document_id" TYPE uuid USING "document_id"::uuid,
  ALTER COLUMN "file_id" TYPE uuid USING "file_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid,
  ALTER COLUMN "author_ids" DROP DEFAULT,
  ALTER COLUMN "author_ids" TYPE uuid[] USING "author_ids"::uuid[];
ALTER TABLE "documents"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "file_id" TYPE uuid USING "file_id"::uuid,
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid,
  ALTER COLUMN "last_editor_id" TYPE uuid USING "last_editor_id"::uuid;
ALTER TABLE "drive_node_versions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "node_id" TYPE uuid USING "node_id"::uuid,
  ALTER COLUMN "file_id" TYPE uuid USING "file_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "drive_nodes"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "space_id" TYPE uuid USING "space_id"::uuid,
  ALTER COLUMN "parent_id" TYPE uuid USING "parent_id"::uuid,
  ALTER COLUMN "file_id" TYPE uuid USING "file_id"::uuid,
  ALTER COLUMN "ancestor_ids" DROP DEFAULT,
  ALTER COLUMN "ancestor_ids" TYPE uuid[] USING "ancestor_ids"::uuid[],
  ALTER COLUMN "trashed_root_id" TYPE uuid USING "trashed_root_id"::uuid;
ALTER TABLE "drive_photo_buckets"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "space_id" TYPE uuid USING "space_id"::uuid;
ALTER TABLE "drive_recents"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "node_id" TYPE uuid USING "node_id"::uuid;
ALTER TABLE "drive_spaces"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid,
  ALTER COLUMN "root_id" TYPE uuid USING "root_id"::uuid;
ALTER TABLE "drive_stars"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "node_id" TYPE uuid USING "node_id"::uuid;
ALTER TABLE "entitlement_grants"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "entitlement_overrides"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "escrow_agreements"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "escrow_holds"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "agreement_id" TYPE uuid USING "agreement_id"::uuid,
  ALTER COLUMN "currency_id" TYPE uuid USING "currency_id"::uuid,
  ALTER COLUMN "payer_user_id" TYPE uuid USING "payer_user_id"::uuid,
  ALTER COLUMN "beneficiary_user_id" TYPE uuid USING "beneficiary_user_id"::uuid;
ALTER TABLE "event_participants"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "event_id" TYPE uuid USING "event_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "file_links"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "file_id" TYPE uuid USING "file_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "file_objects"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid,
  ALTER COLUMN "uploader_id" TYPE uuid USING "uploader_id"::uuid;
ALTER TABLE "file_variants"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "file_id" TYPE uuid USING "file_id"::uuid;
ALTER TABLE "fin_accounts"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "book_id" TYPE uuid USING "book_id"::uuid,
  ALTER COLUMN "parent_id" TYPE uuid USING "parent_id"::uuid;
ALTER TABLE "fin_audit_logs"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "book_id" TYPE uuid USING "book_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "fin_books"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid;
ALTER TABLE "fin_budgets"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "book_id" TYPE uuid USING "book_id"::uuid,
  ALTER COLUMN "category_account_id" TYPE uuid USING "category_account_id"::uuid;
ALTER TABLE "fin_people"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "book_id" TYPE uuid USING "book_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "fin_recurring_rules"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "book_id" TYPE uuid USING "book_id"::uuid,
  ALTER COLUMN "from_account_id" TYPE uuid USING "from_account_id"::uuid,
  ALTER COLUMN "to_account_id" TYPE uuid USING "to_account_id"::uuid,
  ALTER COLUMN "person_user_id" TYPE uuid USING "person_user_id"::uuid;
ALTER TABLE "fin_transactions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "book_id" TYPE uuid USING "book_id"::uuid,
  ALTER COLUMN "from_account_id" TYPE uuid USING "from_account_id"::uuid,
  ALTER COLUMN "to_account_id" TYPE uuid USING "to_account_id"::uuid,
  ALTER COLUMN "person_user_id" TYPE uuid USING "person_user_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid,
  ALTER COLUMN "recurring_rule_id" TYPE uuid USING "recurring_rule_id"::uuid;
ALTER TABLE "google_connections"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "hr_action_batches"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "hr_actions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "batch_id" TYPE uuid USING "batch_id"::uuid,
  ALTER COLUMN "employment_id" TYPE uuid USING "employment_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "hr_employments"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "legal_entity_id" TYPE uuid USING "legal_entity_id"::uuid,
  ALTER COLUMN "legal_position_id" TYPE uuid USING "legal_position_id"::uuid,
  ALTER COLUMN "legal_branch_id" TYPE uuid USING "legal_branch_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "hr_esutd_submissions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "hr_action_id" TYPE uuid USING "hr_action_id"::uuid,
  ALTER COLUMN "employment_id" TYPE uuid USING "employment_id"::uuid,
  ALTER COLUMN "submitted_by_id" TYPE uuid USING "submitted_by_id"::uuid;
ALTER TABLE "hr_personal_doc_records"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "org_document_id" TYPE uuid USING "org_document_id"::uuid,
  ALTER COLUMN "file_id" TYPE uuid USING "file_id"::uuid,
  ALTER COLUMN "stamped_file_id" TYPE uuid USING "stamped_file_id"::uuid,
  ALTER COLUMN "sign_request_id" TYPE uuid USING "sign_request_id"::uuid;
ALTER TABLE "hr_work_calendar_days"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "ledger_transfers"
  ALTER COLUMN "currency_id" TYPE uuid USING "currency_id"::uuid,
  ALTER COLUMN "debit_account_id" TYPE uuid USING "debit_account_id"::uuid,
  ALTER COLUMN "credit_account_id" TYPE uuid USING "credit_account_id"::uuid,
  ALTER COLUMN "agreement_id" TYPE uuid USING "agreement_id"::uuid;
ALTER TABLE "legal_entities"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "director_user_id" TYPE uuid USING "director_user_id"::uuid;
ALTER TABLE "listing_prices"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "listing_id" TYPE uuid USING "listing_id"::uuid,
  ALTER COLUMN "currency_id" TYPE uuid USING "currency_id"::uuid;
ALTER TABLE "listings"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "showcase_id" TYPE uuid USING "showcase_id"::uuid,
  ALTER COLUMN "source_wish_item_id" TYPE uuid USING "source_wish_item_id"::uuid;
ALTER TABLE "messages"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "chat_id" TYPE uuid USING "chat_id"::uuid,
  ALTER COLUMN "author_id" TYPE uuid USING "author_id"::uuid,
  ALTER COLUMN "reply_to_id" TYPE uuid USING "reply_to_id"::uuid;
ALTER TABLE "note_board_items"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "space_id" TYPE uuid USING "space_id"::uuid,
  ALTER COLUMN "folder_id" TYPE uuid USING "folder_id"::uuid,
  ALTER COLUMN "note_id" TYPE uuid USING "note_id"::uuid;
ALTER TABLE "note_chunks"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "note_id" TYPE uuid USING "note_id"::uuid,
  ALTER COLUMN "space_id" TYPE uuid USING "space_id"::uuid;
ALTER TABLE "note_folders"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "space_id" TYPE uuid USING "space_id"::uuid,
  ALTER COLUMN "parent_id" TYPE uuid USING "parent_id"::uuid,
  ALTER COLUMN "ancestor_ids" DROP DEFAULT,
  ALTER COLUMN "ancestor_ids" TYPE uuid[] USING "ancestor_ids"::uuid[],
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "note_links"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "note_id" TYPE uuid USING "note_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "note_revisions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "note_id" TYPE uuid USING "note_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "note_spaces"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid;
ALTER TABLE "notes"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "space_id" TYPE uuid USING "space_id"::uuid,
  ALTER COLUMN "folder_id" TYPE uuid USING "folder_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid,
  ALTER COLUMN "updated_by_id" TYPE uuid USING "updated_by_id"::uuid;
ALTER TABLE "notification_deliveries"
  ALTER COLUMN "event_id" TYPE uuid USING "event_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "notification_id" TYPE uuid USING "notification_id"::uuid;
ALTER TABLE "notification_devices"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "notification_events"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "actor_id" TYPE uuid USING "actor_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid;
ALTER TABLE "notification_preferences"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "notification_subscriptions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "notifications"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "event_id" TYPE uuid USING "event_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "actor_ids" DROP DEFAULT,
  ALTER COLUMN "actor_ids" TYPE uuid[] USING "actor_ids"::uuid[];
ALTER TABLE "office_room_participants"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "room_id" TYPE uuid USING "room_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "office_rooms"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "order_contributions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "order_id" TYPE uuid USING "order_id"::uuid,
  ALTER COLUMN "contributor_id" TYPE uuid USING "contributor_id"::uuid,
  ALTER COLUMN "currency_id" TYPE uuid USING "currency_id"::uuid;
ALTER TABLE "order_prices"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "order_id" TYPE uuid USING "order_id"::uuid,
  ALTER COLUMN "currency_id" TYPE uuid USING "currency_id"::uuid;
ALTER TABLE "orders"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "listing_id" TYPE uuid USING "listing_id"::uuid,
  ALTER COLUMN "showcase_id" TYPE uuid USING "showcase_id"::uuid,
  ALTER COLUMN "shop_id" TYPE uuid USING "shop_id"::uuid,
  ALTER COLUMN "buyer_id" TYPE uuid USING "buyer_id"::uuid,
  ALTER COLUMN "seller_id" TYPE uuid USING "seller_id"::uuid,
  ALTER COLUMN "task_id" TYPE uuid USING "task_id"::uuid;
ALTER TABLE "org_documents"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "doc_type_id" TYPE uuid USING "doc_type_id"::uuid,
  ALTER COLUMN "template_id" TYPE uuid USING "template_id"::uuid,
  ALTER COLUMN "subject_user_id" TYPE uuid USING "subject_user_id"::uuid,
  ALTER COLUMN "counterparty_id" TYPE uuid USING "counterparty_id"::uuid,
  ALTER COLUMN "counterparty_contact_id" TYPE uuid USING "counterparty_contact_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid,
  ALTER COLUMN "document_id" TYPE uuid USING "document_id"::uuid,
  ALTER COLUMN "file_id" TYPE uuid USING "file_id"::uuid,
  ALTER COLUMN "pdf_file_id" TYPE uuid USING "pdf_file_id"::uuid,
  ALTER COLUMN "approval_request_id" TYPE uuid USING "approval_request_id"::uuid,
  ALTER COLUMN "process_instance_id" TYPE uuid USING "process_instance_id"::uuid,
  ALTER COLUMN "parent_document_id" TYPE uuid USING "parent_document_id"::uuid,
  ALTER COLUMN "hr_action_id" TYPE uuid USING "hr_action_id"::uuid,
  ALTER COLUMN "registry_node_id" TYPE uuid USING "registry_node_id"::uuid,
  ALTER COLUMN "personal_node_id" TYPE uuid USING "personal_node_id"::uuid;
ALTER TABLE "pd_incident_events"
  ALTER COLUMN "incident_id" TYPE uuid USING "incident_id"::uuid,
  ALTER COLUMN "actor_user_id" TYPE uuid USING "actor_user_id"::uuid;
ALTER TABLE "pd_incidents"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "actor_user_id" TYPE uuid USING "actor_user_id"::uuid;
ALTER TABLE "plan_versions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "plan_id" TYPE uuid USING "plan_id"::uuid;
ALTER TABLE "plans"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "platform_command_requests"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "actor_id" TYPE uuid USING "actor_id"::uuid,
  ALTER COLUMN "approval_id" TYPE uuid USING "approval_id"::uuid,
  ALTER COLUMN "executed_audit_id" TYPE uuid USING "executed_audit_id"::uuid;
ALTER TABLE "platform_sessions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "platform_staff"
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "platform_staff_roles"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "process_credentials"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "process_definitions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "current_version_id" TYPE uuid USING "current_version_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "process_instances"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "definition_id" TYPE uuid USING "definition_id"::uuid,
  ALTER COLUMN "version_id" TYPE uuid USING "version_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "started_by_id" TYPE uuid USING "started_by_id"::uuid;
ALTER TABLE "process_step_runs"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "instance_id" TYPE uuid USING "instance_id"::uuid,
  ALTER COLUMN "task_id" TYPE uuid USING "task_id"::uuid,
  ALTER COLUMN "source_step_id" TYPE uuid USING "source_step_id"::uuid,
  ALTER COLUMN "department_id" TYPE uuid USING "department_id"::uuid,
  ALTER COLUMN "claimed_by_id" TYPE uuid USING "claimed_by_id"::uuid;
ALTER TABLE "process_triggers"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "definition_id" TYPE uuid USING "definition_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "process_versions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "definition_id" TYPE uuid USING "definition_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "quota_counters"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "relation_tuples"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "resources"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "booker_user_ids" TYPE uuid[] USING "booker_user_ids"::uuid[],
  ALTER COLUMN "booker_circle_ids" TYPE uuid[] USING "booker_circle_ids"::uuid[];
ALTER TABLE "scheduled_messages"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "chat_id" TYPE uuid USING "chat_id"::uuid,
  ALTER COLUMN "author_id" TYPE uuid USING "author_id"::uuid,
  ALTER COLUMN "reply_to_id" TYPE uuid USING "reply_to_id"::uuid,
  ALTER COLUMN "sent_message_id" TYPE uuid USING "sent_message_id"::uuid;
ALTER TABLE "search_documents"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "chat_id" TYPE uuid USING "chat_id"::uuid,
  ALTER COLUMN "author_id" TYPE uuid USING "author_id"::uuid;
ALTER TABLE "security_alerts"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "security_digests"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "sessions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "family_id" TYPE uuid USING "family_id"::uuid,
  ALTER COLUMN "replaced_by_id" TYPE uuid USING "replaced_by_id"::uuid;
ALTER TABLE "share_link_guests"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid;
ALTER TABLE "share_link_visits"
  ALTER COLUMN "link_id" TYPE uuid USING "link_id"::uuid,
  ALTER COLUMN "guest_id" TYPE uuid USING "guest_id"::uuid;
ALTER TABLE "share_links"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid,
  ALTER COLUMN "revoked_by_id" TYPE uuid USING "revoked_by_id"::uuid;
ALTER TABLE "shift_attendance"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "branch_id" TYPE uuid USING "branch_id"::uuid,
  ALTER COLUMN "shift_id" TYPE uuid USING "shift_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "marked_by_id" TYPE uuid USING "marked_by_id"::uuid;
ALTER TABLE "shift_patterns"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "branch_id" TYPE uuid USING "branch_id"::uuid,
  ALTER COLUMN "assignment_id" TYPE uuid USING "assignment_id"::uuid,
  ALTER COLUMN "staffing_position_id" TYPE uuid USING "staffing_position_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "shift_templates"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "branch_id" TYPE uuid USING "branch_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "shifts"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "branch_id" TYPE uuid USING "branch_id"::uuid,
  ALTER COLUMN "staffing_position_id" TYPE uuid USING "staffing_position_id"::uuid,
  ALTER COLUMN "position_id" TYPE uuid USING "position_id"::uuid,
  ALTER COLUMN "assignment_id" TYPE uuid USING "assignment_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "template_id" TYPE uuid USING "template_id"::uuid,
  ALTER COLUMN "pattern_id" TYPE uuid USING "pattern_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "shops"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid;
ALTER TABLE "showcases"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "shop_id" TYPE uuid USING "shop_id"::uuid;
ALTER TABLE "sign_act_events"
  ALTER COLUMN "act_id" TYPE uuid USING "act_id"::uuid;
ALTER TABLE "sign_acts"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "request_id" TYPE uuid USING "request_id"::uuid,
  ALTER COLUMN "signer_user_id" TYPE uuid USING "signer_user_id"::uuid,
  ALTER COLUMN "signer_guest_id" TYPE uuid USING "signer_guest_id"::uuid,
  ALTER COLUMN "cms_file_id" TYPE uuid USING "cms_file_id"::uuid,
  ALTER COLUMN "ocsp_file_id" TYPE uuid USING "ocsp_file_id"::uuid,
  ALTER COLUMN "tsp_file_id" TYPE uuid USING "tsp_file_id"::uuid,
  ALTER COLUMN "verify_challenge_id" TYPE uuid USING "verify_challenge_id"::uuid;
ALTER TABLE "sign_qr_sessions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "act_id" TYPE uuid USING "act_id"::uuid;
ALTER TABLE "sign_requests"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "subject_file_id" TYPE uuid USING "subject_file_id"::uuid,
  ALTER COLUMN "approval_step_id" TYPE uuid USING "approval_step_id"::uuid,
  ALTER COLUMN "stamped_file_id" TYPE uuid USING "stamped_file_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "staff_assignments"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "position_id" TYPE uuid USING "position_id"::uuid,
  ALTER COLUMN "branch_id" TYPE uuid USING "branch_id"::uuid,
  ALTER COLUMN "staffing_position_id" TYPE uuid USING "staffing_position_id"::uuid;
ALTER TABLE "staff_branches"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "head_position_id" TYPE uuid USING "head_position_id"::uuid,
  ALTER COLUMN "parent_id" TYPE uuid USING "parent_id"::uuid,
  ALTER COLUMN "legal_entity_id" TYPE uuid USING "legal_entity_id"::uuid,
  ALTER COLUMN "ancestor_ids" DROP DEFAULT,
  ALTER COLUMN "ancestor_ids" TYPE uuid[] USING "ancestor_ids"::uuid[];
ALTER TABLE "staff_departments"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "parent_id" TYPE uuid USING "parent_id"::uuid,
  ALTER COLUMN "head_position_id" TYPE uuid USING "head_position_id"::uuid;
ALTER TABLE "staff_deputies"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "position_id" TYPE uuid USING "position_id"::uuid,
  ALTER COLUMN "branch_id" TYPE uuid USING "branch_id"::uuid,
  ALTER COLUMN "deputy_position_id" TYPE uuid USING "deputy_position_id"::uuid,
  ALTER COLUMN "deputy_user_id" TYPE uuid USING "deputy_user_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "staff_positions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "department_id" TYPE uuid USING "department_id"::uuid,
  ALTER COLUMN "reports_to_position_id" TYPE uuid USING "reports_to_position_id"::uuid;
ALTER TABLE "staff_rates"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "staffing_position_id" TYPE uuid USING "staffing_position_id"::uuid,
  ALTER COLUMN "assignment_id" TYPE uuid USING "assignment_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "staffing_positions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "branch_id" TYPE uuid USING "branch_id"::uuid,
  ALTER COLUMN "position_id" TYPE uuid USING "position_id"::uuid,
  ALTER COLUMN "shift_template_id" TYPE uuid USING "shift_template_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "subject_subscriptions"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "plan_version_id" TYPE uuid USING "plan_version_id"::uuid;
ALTER TABLE "task_participants"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "task_id" TYPE uuid USING "task_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "gift_reward_id" TYPE uuid USING "gift_reward_id"::uuid;
ALTER TABLE "task_tags"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "task_id" TYPE uuid USING "task_id"::uuid;
ALTER TABLE "tasks"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "creator_id" TYPE uuid USING "creator_id"::uuid,
  ALTER COLUMN "assigned_circle_id" TYPE uuid USING "assigned_circle_id"::uuid,
  ALTER COLUMN "parent_id" TYPE uuid USING "parent_id"::uuid,
  ALTER COLUMN "gift_reward_id" TYPE uuid USING "gift_reward_id"::uuid,
  ALTER COLUMN "recurrence_parent_id" TYPE uuid USING "recurrence_parent_id"::uuid,
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid;
ALTER TABLE "user_devices"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "user_notification_settings"
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "user_payment_cards"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "user_roles"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid,
  ALTER COLUMN "tenant_id" TYPE uuid USING "tenant_id"::uuid;
ALTER TABLE "users"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "default_skin_instance_id" TYPE uuid USING "default_skin_instance_id"::uuid;
ALTER TABLE "verify_challenges"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "visibility_policies"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid,
  ALTER COLUMN "published_by_id" TYPE uuid USING "published_by_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "visibility_rules"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "policy_id" TYPE uuid USING "policy_id"::uuid;
ALTER TABLE "voice_recordings"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid,
  ALTER COLUMN "call_recording_id" TYPE uuid USING "call_recording_id"::uuid;
ALTER TABLE "voice_transcripts"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "file_id" TYPE uuid USING "file_id"::uuid,
  ALTER COLUMN "requested_by_id" TYPE uuid USING "requested_by_id"::uuid;
ALTER TABLE "webhook_deliveries"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "endpoint_id" TYPE uuid USING "endpoint_id"::uuid;
ALTER TABLE "webhook_endpoints"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "created_by_id" TYPE uuid USING "created_by_id"::uuid;
ALTER TABLE "wish_items"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid;
ALTER TABLE "workspace_bank_accounts"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "legal_entity_id" TYPE uuid USING "legal_entity_id"::uuid;
ALTER TABLE "workspace_invitations"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "invited_by" TYPE uuid USING "invited_by"::uuid,
  ALTER COLUMN "to_user_id" TYPE uuid USING "to_user_id"::uuid,
  ALTER COLUMN "position_id" TYPE uuid USING "position_id"::uuid,
  ALTER COLUMN "branch_ids" TYPE uuid[] USING "branch_ids"::uuid[];
ALTER TABLE "workspace_key_policies"
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid;
ALTER TABLE "workspace_members"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "workspace_notification_policies"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid;
ALTER TABLE "workspace_visibility_settings"
  ALTER COLUMN "workspace_id" TYPE uuid USING "workspace_id"::uuid,
  ALTER COLUMN "updated_by_id" TYPE uuid USING "updated_by_id"::uuid;
ALTER TABLE "workspaces"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT uuidv7(),
  ALTER COLUMN "owner_id" TYPE uuid USING "owner_id"::uuid;

-- 3. Умолчания массивов — обратно, уже в uuid[]
ALTER TABLE "approval_steps" ALTER COLUMN "awaiting_user_ids" SET DEFAULT ARRAY[]::uuid[];
ALTER TABLE "document_sessions" ALTER COLUMN "participant_ids" SET DEFAULT ARRAY[]::uuid[];
ALTER TABLE "document_versions" ALTER COLUMN "author_ids" SET DEFAULT ARRAY[]::uuid[];
ALTER TABLE "drive_nodes" ALTER COLUMN "ancestor_ids" SET DEFAULT ARRAY[]::uuid[];
ALTER TABLE "note_folders" ALTER COLUMN "ancestor_ids" SET DEFAULT ARRAY[]::uuid[];
ALTER TABLE "notifications" ALTER COLUMN "actor_ids" SET DEFAULT ARRAY[]::uuid[];
ALTER TABLE "staff_branches" ALTER COLUMN "ancestor_ids" SET DEFAULT '{}'::uuid[];

-- 3b. Уникальность «пустой родитель = один» — NULLS NOT DISTINCT вместо COALESCE(id, '')
CREATE UNIQUE INDEX staff_branches_parent_name_key ON public.staff_branches USING btree (workspace_id, parent_id, name) NULLS NOT DISTINCT WHERE (archived_at IS NULL);
CREATE UNIQUE INDEX staff_deputies_dedup_key ON public.staff_deputies USING btree (position_id, branch_id, deputy_position_id, deputy_user_id, COALESCE(starts_on, '0001-01-01'::date), COALESCE(ends_on, '9999-12-31'::date)) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX note_folder_name_uniq ON public.note_folders USING btree (space_id, parent_id, name_key) NULLS NOT DISTINCT WHERE (deleted_at IS NULL);

-- 4. Внешние ключи — обратно теми же определениями (198)
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_id_fkey" FOREIGN KEY (currency_id) REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_bot_id_fkey" FOREIGN KEY (bot_id) REFERENCES bots(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_step_id_fkey" FOREIGN KEY (step_id) REFERENCES approval_steps(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_request_id_fkey" FOREIGN KEY (request_id) REFERENCES approval_requests(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "asset_models" ADD CONSTRAINT "asset_models_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "asset_moves" ADD CONSTRAINT "asset_moves_asset_id_fkey" FOREIGN KEY (asset_id) REFERENCES assets(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "asset_moves" ADD CONSTRAINT "asset_moves_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "asset_service_records" ADD CONSTRAINT "asset_service_records_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "asset_service_records" ADD CONSTRAINT "asset_service_records_asset_id_fkey" FOREIGN KEY (asset_id) REFERENCES assets(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "asset_service_records" ADD CONSTRAINT "asset_service_records_counterparty_id_fkey" FOREIGN KEY (counterparty_id) REFERENCES counterparties(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "assets" ADD CONSTRAINT "assets_holding_counterparty_id_fkey" FOREIGN KEY (holding_counterparty_id) REFERENCES counterparties(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "assets" ADD CONSTRAINT "assets_model_id_fkey" FOREIGN KEY (model_id) REFERENCES asset_models(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_branch_id_fkey" FOREIGN KEY (branch_id) REFERENCES staff_branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "assets" ADD CONSTRAINT "assets_balance_legal_entity_id_fkey" FOREIGN KEY (balance_legal_entity_id) REFERENCES legal_entities(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "assets" ADD CONSTRAINT "assets_parent_asset_id_fkey" FOREIGN KEY (parent_asset_id) REFERENCES assets(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "bots" ADD CONSTRAINT "bots_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "bots" ADD CONSTRAINT "bots_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "calendar_event_reminders" ADD CONSTRAINT "calendar_event_reminders_event_id_fkey" FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_resource_id_fkey" FOREIGN KEY (resource_id) REFERENCES resources(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_recurrence_parent_id_fkey" FOREIGN KEY (recurrence_parent_id) REFERENCES calendar_events(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "call_recording_claims" ADD CONSTRAINT "call_recording_claims_recording_id_fkey" FOREIGN KEY (recording_id) REFERENCES call_recordings(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_session_id_fkey" FOREIGN KEY (session_id) REFERENCES call_sessions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "call_session_participants" ADD CONSTRAINT "call_session_participants_session_id_fkey" FOREIGN KEY (session_id) REFERENCES call_sessions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "card_skin_instances" ADD CONSTRAINT "card_skin_instances_skin_id_fkey" FOREIGN KEY (skin_id) REFERENCES card_skins(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "card_skin_transfers" ADD CONSTRAINT "card_skin_transfers_instance_id_fkey" FOREIGN KEY (instance_id) REFERENCES card_skin_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_chat_id_fkey" FOREIGN KEY (chat_id) REFERENCES chats(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "circle_memberships" ADD CONSTRAINT "circle_memberships_contact_link_id_fkey" FOREIGN KEY (contact_link_id) REFERENCES contact_links(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "circle_memberships" ADD CONSTRAINT "circle_memberships_circle_id_fkey" FOREIGN KEY (circle_id) REFERENCES circles(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "circles" ADD CONSTRAINT "circles_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "consent_acceptances" ADD CONSTRAINT "consent_acceptances_version_id_fkey" FOREIGN KEY (version_id) REFERENCES consent_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "contact_blocks" ADD CONSTRAINT "contact_blocks_blocked_id_fkey" FOREIGN KEY (blocked_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "contact_blocks" ADD CONSTRAINT "contact_blocks_blocker_id_fkey" FOREIGN KEY (blocker_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "contact_invitations" ADD CONSTRAINT "contact_invitations_to_user_id_fkey" FOREIGN KEY (to_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "contact_invitations" ADD CONSTRAINT "contact_invitations_from_user_id_fkey" FOREIGN KEY (from_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "contact_links" ADD CONSTRAINT "contact_links_user_b_id_fkey" FOREIGN KEY (user_b_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "contact_links" ADD CONSTRAINT "contact_links_user_a_id_fkey" FOREIGN KEY (user_a_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "counterparty_bank_accounts" ADD CONSTRAINT "counterparty_bank_accounts_counterparty_id_fkey" FOREIGN KEY (counterparty_id) REFERENCES counterparties(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "counterparty_contacts" ADD CONSTRAINT "counterparty_contacts_counterparty_id_fkey" FOREIGN KEY (counterparty_id) REFERENCES counterparties(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "crypto_key_versions" ADD CONSTRAINT "crypto_key_versions_key_id_fkey" FOREIGN KEY (key_id) REFERENCES crypto_keys(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "doc_campaign_targets" ADD CONSTRAINT "doc_campaign_targets_campaign_id_fkey" FOREIGN KEY (campaign_id) REFERENCES doc_campaigns(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "doc_campaigns" ADD CONSTRAINT "doc_campaigns_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "doc_template_library_installs" ADD CONSTRAINT "doc_template_library_installs_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "doc_templates" ADD CONSTRAINT "doc_templates_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "doc_templates" ADD CONSTRAINT "doc_templates_doc_type_id_fkey" FOREIGN KEY (doc_type_id) REFERENCES doc_types(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "doc_type_counters" ADD CONSTRAINT "doc_type_counters_doc_type_id_fkey" FOREIGN KEY (doc_type_id) REFERENCES doc_types(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "doc_types" ADD CONSTRAINT "doc_types_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "document_sessions" ADD CONSTRAINT "document_sessions_document_id_fkey" FOREIGN KEY (document_id) REFERENCES documents(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY (document_id) REFERENCES documents(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "drive_node_versions" ADD CONSTRAINT "drive_node_versions_file_id_fkey" FOREIGN KEY (file_id) REFERENCES file_objects(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "drive_node_versions" ADD CONSTRAINT "drive_node_versions_node_id_fkey" FOREIGN KEY (node_id) REFERENCES drive_nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_space_id_fkey" FOREIGN KEY (space_id) REFERENCES drive_spaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_file_id_fkey" FOREIGN KEY (file_id) REFERENCES file_objects(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_parent_id_fkey" FOREIGN KEY (parent_id) REFERENCES drive_nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "drive_photo_buckets" ADD CONSTRAINT "drive_photo_buckets_space_id_fkey" FOREIGN KEY (space_id) REFERENCES drive_spaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "drive_recents" ADD CONSTRAINT "drive_recents_node_id_fkey" FOREIGN KEY (node_id) REFERENCES drive_nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "drive_stars" ADD CONSTRAINT "drive_stars_node_id_fkey" FOREIGN KEY (node_id) REFERENCES drive_nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "escrow_holds" ADD CONSTRAINT "escrow_holds_agreement_id_fkey" FOREIGN KEY (agreement_id) REFERENCES escrow_agreements(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_event_id_fkey" FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "file_links" ADD CONSTRAINT "file_links_file_id_fkey" FOREIGN KEY (file_id) REFERENCES file_objects(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "file_variants" ADD CONSTRAINT "file_variants_file_id_fkey" FOREIGN KEY (file_id) REFERENCES file_objects(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "fin_accounts" ADD CONSTRAINT "fin_accounts_book_id_fkey" FOREIGN KEY (book_id) REFERENCES fin_books(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "fin_accounts" ADD CONSTRAINT "fin_accounts_parent_id_fkey" FOREIGN KEY (parent_id) REFERENCES fin_accounts(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "fin_budgets" ADD CONSTRAINT "fin_budgets_book_id_fkey" FOREIGN KEY (book_id) REFERENCES fin_books(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "fin_people" ADD CONSTRAINT "fin_people_book_id_fkey" FOREIGN KEY (book_id) REFERENCES fin_books(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "fin_recurring_rules" ADD CONSTRAINT "fin_recurring_rules_book_id_fkey" FOREIGN KEY (book_id) REFERENCES fin_books(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_to_account_id_fkey" FOREIGN KEY (to_account_id) REFERENCES fin_accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_book_id_fkey" FOREIGN KEY (book_id) REFERENCES fin_books(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_from_account_id_fkey" FOREIGN KEY (from_account_id) REFERENCES fin_accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "hr_action_batches" ADD CONSTRAINT "hr_action_batches_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "hr_actions" ADD CONSTRAINT "hr_actions_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "hr_employments" ADD CONSTRAINT "hr_employments_legal_entity_id_fkey" FOREIGN KEY (legal_entity_id) REFERENCES legal_entities(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "hr_employments" ADD CONSTRAINT "hr_employments_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "hr_esutd_submissions" ADD CONSTRAINT "hr_esutd_submissions_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "listing_prices" ADD CONSTRAINT "listing_prices_listing_id_fkey" FOREIGN KEY (listing_id) REFERENCES listings(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "listings" ADD CONSTRAINT "listings_showcase_id_fkey" FOREIGN KEY (showcase_id) REFERENCES showcases(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_fkey" FOREIGN KEY (author_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_fkey" FOREIGN KEY (chat_id) REFERENCES chats(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "note_board_items" ADD CONSTRAINT "note_board_items_note_id_fkey" FOREIGN KEY (note_id) REFERENCES notes(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "note_board_items" ADD CONSTRAINT "note_board_items_space_id_fkey" FOREIGN KEY (space_id) REFERENCES note_spaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "note_chunks" ADD CONSTRAINT "note_chunks_space_id_fkey" FOREIGN KEY (space_id) REFERENCES note_spaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "note_chunks" ADD CONSTRAINT "note_chunks_note_id_fkey" FOREIGN KEY (note_id) REFERENCES notes(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "note_folders" ADD CONSTRAINT "note_folders_parent_id_fkey" FOREIGN KEY (parent_id) REFERENCES note_folders(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "note_folders" ADD CONSTRAINT "note_folders_space_id_fkey" FOREIGN KEY (space_id) REFERENCES note_spaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_note_id_fkey" FOREIGN KEY (note_id) REFERENCES notes(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_note_id_fkey" FOREIGN KEY (note_id) REFERENCES notes(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "notes" ADD CONSTRAINT "notes_space_id_fkey" FOREIGN KEY (space_id) REFERENCES note_spaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "notes" ADD CONSTRAINT "notes_folder_id_fkey" FOREIGN KEY (folder_id) REFERENCES note_folders(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_id_fkey" FOREIGN KEY (event_id) REFERENCES notification_events(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "notification_devices" ADD CONSTRAINT "notification_devices_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "notification_subscriptions" ADD CONSTRAINT "notification_subscriptions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_fkey" FOREIGN KEY (event_id) REFERENCES notification_events(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "office_room_participants" ADD CONSTRAINT "office_room_participants_room_id_fkey" FOREIGN KEY (room_id) REFERENCES office_rooms(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "office_rooms" ADD CONSTRAINT "office_rooms_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "order_contributions" ADD CONSTRAINT "order_contributions_order_id_fkey" FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "order_prices" ADD CONSTRAINT "order_prices_order_id_fkey" FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_listing_id_fkey" FOREIGN KEY (listing_id) REFERENCES listings(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "org_documents" ADD CONSTRAINT "org_documents_template_id_fkey" FOREIGN KEY (template_id) REFERENCES doc_templates(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "org_documents" ADD CONSTRAINT "org_documents_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "org_documents" ADD CONSTRAINT "org_documents_parent_document_id_fkey" FOREIGN KEY (parent_document_id) REFERENCES org_documents(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "org_documents" ADD CONSTRAINT "org_documents_doc_type_id_fkey" FOREIGN KEY (doc_type_id) REFERENCES doc_types(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "pd_incident_events" ADD CONSTRAINT "pd_incident_events_incident_id_fkey" FOREIGN KEY (incident_id) REFERENCES pd_incidents(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_fkey" FOREIGN KEY (plan_id) REFERENCES plans(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "platform_staff_roles" ADD CONSTRAINT "platform_staff_roles_user_id_fkey" FOREIGN KEY (user_id) REFERENCES platform_staff(user_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_definition_id_fkey" FOREIGN KEY (definition_id) REFERENCES process_definitions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_version_id_fkey" FOREIGN KEY (version_id) REFERENCES process_versions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "process_step_runs" ADD CONSTRAINT "process_step_runs_instance_id_fkey" FOREIGN KEY (instance_id) REFERENCES process_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "process_triggers" ADD CONSTRAINT "process_triggers_definition_id_fkey" FOREIGN KEY (definition_id) REFERENCES process_definitions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "process_versions" ADD CONSTRAINT "process_versions_definition_id_fkey" FOREIGN KEY (definition_id) REFERENCES process_definitions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "resources" ADD CONSTRAINT "resources_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_author_id_fkey" FOREIGN KEY (author_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_chat_id_fkey" FOREIGN KEY (chat_id) REFERENCES chats(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "share_link_visits" ADD CONSTRAINT "share_link_visits_guest_id_fkey" FOREIGN KEY (guest_id) REFERENCES share_link_guests(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "share_link_visits" ADD CONSTRAINT "share_link_visits_link_id_fkey" FOREIGN KEY (link_id) REFERENCES share_links(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "shift_attendance" ADD CONSTRAINT "shift_attendance_branch_id_fkey" FOREIGN KEY (branch_id) REFERENCES staff_branches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "shift_attendance" ADD CONSTRAINT "shift_attendance_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "shift_attendance" ADD CONSTRAINT "shift_attendance_shift_id_fkey" FOREIGN KEY (shift_id) REFERENCES shifts(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_branch_id_fkey" FOREIGN KEY (branch_id) REFERENCES staff_branches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_staffing_position_id_fkey" FOREIGN KEY (staffing_position_id) REFERENCES staffing_positions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_assignment_id_fkey" FOREIGN KEY (assignment_id) REFERENCES staff_assignments(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_branch_id_fkey" FOREIGN KEY (branch_id) REFERENCES staff_branches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_pattern_id_fkey" FOREIGN KEY (pattern_id) REFERENCES shift_patterns(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_id_fkey" FOREIGN KEY (branch_id) REFERENCES staff_branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_position_id_fkey" FOREIGN KEY (position_id) REFERENCES staff_positions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_assignment_id_fkey" FOREIGN KEY (assignment_id) REFERENCES staff_assignments(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_template_id_fkey" FOREIGN KEY (template_id) REFERENCES shift_templates(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_staffing_position_id_fkey" FOREIGN KEY (staffing_position_id) REFERENCES staffing_positions(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "showcases" ADD CONSTRAINT "showcases_shop_id_fkey" FOREIGN KEY (shop_id) REFERENCES shops(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "sign_act_events" ADD CONSTRAINT "sign_act_events_act_id_fkey" FOREIGN KEY (act_id) REFERENCES sign_acts(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "sign_acts" ADD CONSTRAINT "sign_acts_request_id_fkey" FOREIGN KEY (request_id) REFERENCES sign_requests(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "sign_qr_sessions" ADD CONSTRAINT "sign_qr_sessions_act_id_fkey" FOREIGN KEY (act_id) REFERENCES sign_acts(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_staffing_position_id_fkey" FOREIGN KEY (staffing_position_id) REFERENCES staffing_positions(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_position_id_fkey" FOREIGN KEY (position_id) REFERENCES staff_positions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_branch_id_fkey" FOREIGN KEY (branch_id) REFERENCES staff_branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_branches" ADD CONSTRAINT "staff_branches_parent_id_fkey" FOREIGN KEY (parent_id) REFERENCES staff_branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "staff_branches" ADD CONSTRAINT "staff_branches_head_position_id_fkey" FOREIGN KEY (head_position_id) REFERENCES staff_positions(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "staff_branches" ADD CONSTRAINT "staff_branches_legal_entity_id_fkey" FOREIGN KEY (legal_entity_id) REFERENCES legal_entities(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "staff_branches" ADD CONSTRAINT "staff_branches_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_departments" ADD CONSTRAINT "staff_departments_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_departments" ADD CONSTRAINT "staff_departments_parent_id_fkey" FOREIGN KEY (parent_id) REFERENCES staff_departments(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "staff_departments" ADD CONSTRAINT "staff_departments_head_position_id_fkey" FOREIGN KEY (head_position_id) REFERENCES staff_positions(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_deputy_user_id_fkey" FOREIGN KEY (deputy_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_branch_id_fkey" FOREIGN KEY (branch_id) REFERENCES staff_branches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_deputy_position_id_fkey" FOREIGN KEY (deputy_position_id) REFERENCES staff_positions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_position_id_fkey" FOREIGN KEY (position_id) REFERENCES staff_positions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_positions" ADD CONSTRAINT "staff_positions_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_positions" ADD CONSTRAINT "staff_positions_department_id_fkey" FOREIGN KEY (department_id) REFERENCES staff_departments(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "staff_positions" ADD CONSTRAINT "staff_positions_reports_to_position_id_fkey" FOREIGN KEY (reports_to_position_id) REFERENCES staff_positions(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "staff_rates" ADD CONSTRAINT "staff_rates_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_rates" ADD CONSTRAINT "staff_rates_staffing_position_id_fkey" FOREIGN KEY (staffing_position_id) REFERENCES staffing_positions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staff_rates" ADD CONSTRAINT "staff_rates_assignment_id_fkey" FOREIGN KEY (assignment_id) REFERENCES staff_assignments(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_position_id_fkey" FOREIGN KEY (position_id) REFERENCES staff_positions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_branch_id_fkey" FOREIGN KEY (branch_id) REFERENCES staff_branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_shift_template_id_fkey" FOREIGN KEY (shift_template_id) REFERENCES shift_templates(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "subject_subscriptions" ADD CONSTRAINT "subject_subscriptions_plan_version_id_fkey" FOREIGN KEY (plan_version_id) REFERENCES plan_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "task_participants" ADD CONSTRAINT "task_participants_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "task_participants" ADD CONSTRAINT "task_participants_task_id_fkey" FOREIGN KEY (task_id) REFERENCES tasks(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_task_id_fkey" FOREIGN KEY (task_id) REFERENCES tasks(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_creator_id_fkey" FOREIGN KEY (creator_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_fkey" FOREIGN KEY (parent_id) REFERENCES tasks(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_circle_id_fkey" FOREIGN KEY (assigned_circle_id) REFERENCES circles(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "user_notification_settings" ADD CONSTRAINT "user_notification_settings_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "user_payment_cards" ADD CONSTRAINT "user_payment_cards_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "visibility_rules" ADD CONSTRAINT "visibility_rules_policy_id_fkey" FOREIGN KEY (policy_id) REFERENCES visibility_policies(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "voice_transcripts" ADD CONSTRAINT "voice_transcripts_file_id_fkey" FOREIGN KEY (file_id) REFERENCES file_objects(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "workspace_bank_accounts" ADD CONSTRAINT "workspace_bank_accounts_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "workspace_bank_accounts" ADD CONSTRAINT "workspace_bank_accounts_legal_entity_id_fkey" FOREIGN KEY (legal_entity_id) REFERENCES legal_entities(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_fkey" FOREIGN KEY (invited_by) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_position_id_fkey" FOREIGN KEY (position_id) REFERENCES staff_positions(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_to_user_id_fkey" FOREIGN KEY (to_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "workspace_key_policies" ADD CONSTRAINT "workspace_key_policies_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "workspace_notification_policies" ADD CONSTRAINT "workspace_notification_policies_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "workspace_visibility_settings" ADD CONSTRAINT "workspace_visibility_settings_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
