-- ============================================================
-- core/consents — движок согласий (24-й) + учёт действий с ПДн + журнал инцидентов
--
-- Написано руками поверх сгенерированных CREATE TABLE:
-- 1) `pd_action_records` — МЕСЯЧНЫЕ ПАРТИЦИИ по `occurred_at` (прецедент analytics.events,
--    api_access_log): Prisma не выражает PARTITION BY, зеркало в схеме — составной PK.
--    Партиции: текущий месяц и два следующих; дальше — `MonthlyPartitions.ensureAhead()`.
-- 2) Частичные уникумы: одна ЖИВАЯ приёмка на (субъект, версия); один черновик на документ.
-- 3) Триггеры неизменяемости: опубликованная версия документа, запись приёмки,
--    учёт действий и события инцидентов — append-only НА УРОВНЕ БАЗЫ, а не только сервиса.
-- ============================================================

-- AlterTable
ALTER TABLE "users" ADD COLUMN "consent_epoch" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "verify_challenges" ADD COLUMN "context" JSONB;

-- CreateTable
CREATE TABLE "consent_versions" (
    "id" TEXT NOT NULL,
    "document_key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "bodies" JSONB NOT NULL,
    "summaries" JSONB NOT NULL,
    "change_summary" JSONB,
    "hashes" JSONB,
    "manifest_hash" TEXT,
    "prev_manifest_hash" TEXT,
    "material" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3),
    "urgent_reason" TEXT,
    "signature" TEXT,
    "signature_kid" TEXT,
    "signed_at" TIMESTAMP(3),
    "signature_history" JSONB NOT NULL DEFAULT '[]',
    "attestation_sign_request_id" TEXT,
    "activated_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "published_by_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consent_versions_status_check" CHECK ("status" IN ('draft', 'published', 'superseded')),
    -- Не-черновик обязан нести всё доказательство целиком
    CONSTRAINT "consent_versions_published_complete" CHECK (
      "status" = 'draft' OR (
        "hashes" IS NOT NULL AND "manifest_hash" IS NOT NULL AND "effective_from" IS NOT NULL
        AND "signature" IS NOT NULL AND "signature_kid" IS NOT NULL AND "signed_at" IS NOT NULL
        AND "published_at" IS NOT NULL
      )
    )
);

-- CreateTable
CREATE TABLE "consent_acceptances" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "document_key" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL DEFAULT 'self',
    "actor_basis" TEXT,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" TEXT NOT NULL DEFAULT 'web',
    "ip_enc" TEXT,
    "user_agent_enc" TEXT,
    "verify_challenge_id" TEXT,
    "bundle_key" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "consent_acceptances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consent_acceptances_subject_check" CHECK ("subject_type" IN ('user', 'workspace')),
    CONSTRAINT "consent_acceptances_actor_role_check" CHECK ("actor_role" IN ('self', 'guardian', 'org_owner')),
    CONSTRAINT "consent_acceptances_revoke_pair" CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL))
);

-- CreateTable: партиционированная — написано руками
CREATE TABLE "pd_action_records" (
    "id" BIGINT NOT NULL,
    "action_type" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL DEFAULT 'user',
    "subject_id" TEXT NOT NULL,
    "recipient_key" TEXT,
    "cross_border" BOOLEAN NOT NULL DEFAULT false,
    "country" TEXT,
    "basis" TEXT NOT NULL,
    "consent_acceptance_id" TEXT,
    "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "purpose" TEXT NOT NULL,
    "workspace_id" TEXT,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pd_action_records_pkey" PRIMARY KEY ("id", "occurred_at"),
    CONSTRAINT "pd_action_records_type_check" CHECK ("action_type" IN ('transfer', 'cross_border', 'publication', 'consent_term'))
) PARTITION BY RANGE ("occurred_at");

CREATE SEQUENCE "pd_action_records_id_seq" OWNED BY "pd_action_records"."id";
ALTER TABLE "pd_action_records" ALTER COLUMN "id" SET DEFAULT nextval('pd_action_records_id_seq');

DO $$
DECLARE
  m  date;
  hi date;
BEGIN
  FOR m IN
    SELECT (date_trunc('month', (now() AT TIME ZONE 'UTC')) + make_interval(months => i))::date FROM generate_series(0, 2) AS i
  LOOP
    hi := (m + interval '1 month')::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "pd_action_records" FOR VALUES FROM (%L) TO (%L)',
      'pd_action_records_' || to_char(m, 'YYYY_MM'), m::timestamp, hi::timestamp
    );
    EXECUTE format('ALTER TABLE %I SET (autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)', 'pd_action_records_' || to_char(m, 'YYYY_MM'));
  END LOOP;
END $$;

-- CreateTable
CREATE TABLE "pd_incidents" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "scope" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "affected_estimate" INTEGER,
    "detected_at" TIMESTAMP(3) NOT NULL,
    "notify_deadline_at" TIMESTAMP(3) NOT NULL,
    "authority_notified_at" TIMESTAMP(3),
    "subjects_notified_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "deadline_alerted_at" TIMESTAMP(3),
    "actor_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pd_incidents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pd_incidents_status_check" CHECK ("status" IN ('open', 'authority_notified', 'subjects_notified', 'closed'))
);

-- CreateTable
CREATE TABLE "pd_incident_events" (
    "id" BIGSERIAL NOT NULL,
    "incident_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT,
    "actor_user_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pd_incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consent_versions_document_key_status_effective_from_idx" ON "consent_versions"("document_key", "status", "effective_from");
CREATE INDEX "consent_versions_signature_kid_idx" ON "consent_versions"("signature_kid");
CREATE UNIQUE INDEX "consent_versions_document_key_version_key" ON "consent_versions"("document_key", "version");
-- Частичный уникум (руками): один черновик на документ
CREATE UNIQUE INDEX "consent_versions_one_draft" ON "consent_versions"("document_key") WHERE "status" = 'draft';

-- CreateIndex
CREATE INDEX "consent_acceptances_subject_type_subject_id_document_key_ac_idx" ON "consent_acceptances"("subject_type", "subject_id", "document_key", "accepted_at");
CREATE INDEX "consent_acceptances_version_id_revoked_at_idx" ON "consent_acceptances"("version_id", "revoked_at");
CREATE INDEX "consent_acceptances_actor_user_id_idx" ON "consent_acceptances"("actor_user_id");
-- Частичный уникум (руками): одна ЖИВАЯ приёмка на (субъект, версия). Отозванные строки
-- в уникальность не входят — «маркетинг вкл → выкл → вкл» даёт три строки, живая одна.
CREATE UNIQUE INDEX "consent_acceptances_live_uq" ON "consent_acceptances"("subject_type", "subject_id", "version_id") WHERE "revoked_at" IS NULL;

-- CreateIndex: индексы родителя наследуются каждой партицией
CREATE INDEX "pd_action_records_subject_type_subject_id_occurred_at_idx" ON "pd_action_records"("subject_type", "subject_id", "occurred_at");
CREATE INDEX "pd_action_records_recipient_key_occurred_at_idx" ON "pd_action_records"("recipient_key", "occurred_at");
CREATE INDEX "pd_action_records_occurred_at_idx" ON "pd_action_records"("occurred_at");

-- CreateIndex
CREATE INDEX "pd_incidents_status_notify_deadline_at_idx" ON "pd_incidents"("status", "notify_deadline_at");
CREATE INDEX "pd_incident_events_incident_id_occurred_at_idx" ON "pd_incident_events"("incident_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "consent_acceptances" ADD CONSTRAINT "consent_acceptances_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "consent_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pd_incident_events" ADD CONSTRAINT "pd_incident_events_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "pd_incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- Неизменяемость на уровне базы
-- ============================================================

-- Версия документа: черновик правится свободно; у опубликованной меняются ТОЛЬКО статус
-- (published → superseded), подпись (перезаверение при компрометации ключа), заверение ЭЦП
-- и отметка активации. Текст, хэши, манифест, дата вступления — никогда: ручная подмена
-- в базе упирается в триггер, а обход триггера суперпользователем — в проверку подписи.
CREATE OR REPLACE FUNCTION consent_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'draft' THEN
      RAISE EXCEPTION 'consent_versions: a published version cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW."status" = 'draft' THEN
    RAISE EXCEPTION 'consent_versions: a published version cannot return to draft';
  END IF;
  IF NEW."document_key" IS DISTINCT FROM OLD."document_key"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."bodies" IS DISTINCT FROM OLD."bodies"
     OR NEW."summaries" IS DISTINCT FROM OLD."summaries"
     OR NEW."change_summary" IS DISTINCT FROM OLD."change_summary"
     OR NEW."hashes" IS DISTINCT FROM OLD."hashes"
     OR NEW."manifest_hash" IS DISTINCT FROM OLD."manifest_hash"
     OR NEW."prev_manifest_hash" IS DISTINCT FROM OLD."prev_manifest_hash"
     OR NEW."material" IS DISTINCT FROM OLD."material"
     OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
     OR NEW."urgent_reason" IS DISTINCT FROM OLD."urgent_reason"
     OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
     OR NEW."published_by_id" IS DISTINCT FROM OLD."published_by_id"
  THEN
    RAISE EXCEPTION 'consent_versions: a published version is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "consent_versions_guard"
  BEFORE UPDATE OR DELETE ON "consent_versions"
  FOR EACH ROW EXECUTE FUNCTION consent_versions_guard();

-- Запись приёмки: DELETE запрещён; UPDATE — только однократный отзыв.
CREATE OR REPLACE FUNCTION consent_acceptances_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent_acceptances is append-only (proof of consent)';
  END IF;
  -- Отзыв однократен; перешивка шифротекста IP/UA после ротации ключа допустима и у отозванной строки
  IF OLD."revoked_at" IS NOT NULL AND (NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" OR NEW."revoked_reason" IS DISTINCT FROM OLD."revoked_reason") THEN
    RAISE EXCEPTION 'consent_acceptances: a revoked acceptance is final';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."subject_type" IS DISTINCT FROM OLD."subject_type"
     OR NEW."subject_id" IS DISTINCT FROM OLD."subject_id"
     OR NEW."document_key" IS DISTINCT FROM OLD."document_key"
     OR NEW."version_id" IS DISTINCT FROM OLD."version_id"
     OR NEW."locale" IS DISTINCT FROM OLD."locale"
     OR NEW."content_hash" IS DISTINCT FROM OLD."content_hash"
     OR NEW."actor_user_id" IS DISTINCT FROM OLD."actor_user_id"
     OR NEW."actor_role" IS DISTINCT FROM OLD."actor_role"
     OR NEW."actor_basis" IS DISTINCT FROM OLD."actor_basis"
     OR NEW."accepted_at" IS DISTINCT FROM OLD."accepted_at"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."verify_challenge_id" IS DISTINCT FROM OLD."verify_challenge_id"
     OR NEW."bundle_key" IS DISTINCT FROM OLD."bundle_key"
  THEN
    RAISE EXCEPTION 'consent_acceptances: only revocation may change an acceptance';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "consent_acceptances_guard"
  BEFORE UPDATE OR DELETE ON "consent_acceptances"
  FOR EACH ROW EXECUTE FUNCTION consent_acceptances_guard();

-- `ip_enc`/`user_agent_enc` в списке неизменяемых НЕТ намеренно: перешивка envelope после
-- ротации платформенного KEK переписывает шифротекст (открытый текст тот же).

CREATE OR REPLACE FUNCTION consents_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'this table is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "consent_acceptances_no_truncate"
  BEFORE TRUNCATE ON "consent_acceptances"
  FOR EACH STATEMENT EXECUTE FUNCTION consents_append_only();

CREATE TRIGGER "consent_versions_no_truncate"
  BEFORE TRUNCATE ON "consent_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION consents_append_only();

-- Учёт действий с ПДн: строки не правятся и не удаляются (ретеншн — сбросом партиции целиком).
CREATE TRIGGER "pd_action_records_immutable"
  BEFORE UPDATE OR DELETE ON "pd_action_records"
  FOR EACH ROW EXECUTE FUNCTION consents_append_only();

-- События инцидентов — append-only.
CREATE TRIGGER "pd_incident_events_immutable"
  BEFORE UPDATE OR DELETE ON "pd_incident_events"
  FOR EACH ROW EXECUTE FUNCTION consents_append_only();

CREATE TRIGGER "pd_incident_events_no_truncate"
  BEFORE TRUNCATE ON "pd_incident_events"
  FOR EACH STATEMENT EXECUTE FUNCTION consents_append_only();
