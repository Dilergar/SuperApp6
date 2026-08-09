-- AlterTable
ALTER TABLE "approval_decisions" ADD COLUMN     "sign_act_id" TEXT;

-- AlterTable
ALTER TABLE "approval_steps" ADD COLUMN     "required_signature_kind" TEXT;

-- AlterTable
ALTER TABLE "doc_types" ADD COLUMN     "signature_level" TEXT NOT NULL DEFAULT 'none';

-- CreateTable
CREATE TABLE "sign_requests" (
    "id" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "ref_title" TEXT NOT NULL,
    "ref_icon" TEXT,
    "workspace_id" TEXT,
    "subject_file_id" TEXT NOT NULL,
    "subject_sha256" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "methods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approval_step_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "sign_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign_acts" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "signer_type" TEXT NOT NULL,
    "signer_user_id" TEXT,
    "signer_guest_id" TEXT,
    "signer_name" TEXT NOT NULL,
    "signer_phone" TEXT,
    "method" TEXT,
    "level" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "subject_sha256" TEXT NOT NULL,
    "cms_file_id" TEXT,
    "cms_sha256" TEXT,
    "cert_subject_cn" TEXT,
    "cert_subject_iin" TEXT,
    "cert_subject_bin" TEXT,
    "cert_serial" TEXT,
    "cert_issuer_cn" TEXT,
    "cert_not_before" TIMESTAMP(3),
    "cert_not_after" TIMESTAMP(3),
    "chain_valid" BOOLEAN,
    "ocsp_status" TEXT,
    "ocsp_at" TIMESTAMP(3),
    "ocsp_file_id" TEXT,
    "tsp_at" TIMESTAMP(3),
    "tsp_serial" TEXT,
    "tsp_file_id" TEXT,
    "verify_challenge_id" TEXT,
    "consent_text" TEXT,
    "consent_version" TEXT,
    "signed_at" TIMESTAMP(3),
    "decline_reason" TEXT,
    "failure_code" TEXT,
    "check_token" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_acts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign_act_events" (
    "id" BIGSERIAL NOT NULL,
    "act_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,
    "data" JSONB,

    CONSTRAINT "sign_act_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign_qr_sessions" (
    "id" TEXT NOT NULL,
    "act_id" TEXT NOT NULL,
    "data_token" TEXT NOT NULL,
    "sign_token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "procedure_id" TEXT,
    "claimed_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_qr_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sign_requests_ref_type_ref_id_idx" ON "sign_requests"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "sign_requests_workspace_id_status_created_at_idx" ON "sign_requests"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "sign_requests_subject_sha256_idx" ON "sign_requests"("subject_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "sign_acts_check_token_key" ON "sign_acts"("check_token");

-- CreateIndex
CREATE INDEX "sign_acts_request_id_idx" ON "sign_acts"("request_id");

-- CreateIndex
CREATE INDEX "sign_acts_signer_user_id_signed_at_idx" ON "sign_acts"("signer_user_id", "signed_at");

-- CreateIndex
CREATE INDEX "sign_acts_cert_subject_iin_idx" ON "sign_acts"("cert_subject_iin");

-- CreateIndex
CREATE INDEX "sign_acts_status_created_at_idx" ON "sign_acts"("status", "created_at");

-- CreateIndex
CREATE INDEX "sign_act_events_act_id_id_idx" ON "sign_act_events"("act_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sign_qr_sessions_data_token_key" ON "sign_qr_sessions"("data_token");

-- CreateIndex
CREATE UNIQUE INDEX "sign_qr_sessions_sign_token_key" ON "sign_qr_sessions"("sign_token");

-- CreateIndex
CREATE INDEX "sign_qr_sessions_act_id_idx" ON "sign_qr_sessions"("act_id");

-- CreateIndex
CREATE INDEX "sign_qr_sessions_status_expires_at_idx" ON "sign_qr_sessions"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "sign_acts" ADD CONSTRAINT "sign_acts_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "sign_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign_act_events" ADD CONSTRAINT "sign_act_events_act_id_fkey" FOREIGN KEY ("act_id") REFERENCES "sign_acts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- ПАРТИАЛЬНЫЕ УНИКАЛЬНЫЕ ИНДЕКСЫ — РУКАМИ
-- Prisma их не выражает (прецеденты: approvals_origin_unique, call_sessions,
-- document_sessions). Оба закрывают гонки, которые проверкой в приложении
-- принципиально не закрываются.
-- ============================================================

-- «Одна живая заявка на подпись на один шаг маршрута».
--
-- Заявка заводится ЛЕНИВО: она нужна только тогда, когда до шага реально дошли,
-- и её создаёт первый же подписант, открывший экран подписания. Двое адресатов
-- шага «нужен каждый», нажавших «Подписать» одновременно, без индекса завели бы
-- две заявки на один шаг — с РАЗНЫМИ заморозками предмета, то есть подписали бы
-- формально разные документы. Индекс делает ленивое создание идемпотентным.
CREATE UNIQUE INDEX IF NOT EXISTS "sign_requests_one_active_per_step"
  ON "sign_requests" ("approval_step_id")
  WHERE "status" = 'pending' AND "approval_step_id" IS NOT NULL;

-- «Один человек — одна ЖИВАЯ подпись на заявку».
--
-- Отказавшийся (declined) и не прошедший проверку (failed) в условие не входят
-- намеренно: отказ — законный конец акта, но человек может вернуться (маршрут
-- вернули на доработку и прислали снова), а провалившаяся проверка ключа обязана
-- допускать вторую попытку — иначе одна опечатка в NCALayer навсегда лишала бы
-- человека возможности подписать.
CREATE UNIQUE INDEX IF NOT EXISTS "sign_acts_one_live_per_signer"
  ON "sign_acts" ("request_id", "signer_user_id")
  WHERE "status" IN ('pending', 'signed') AND "signer_user_id" IS NOT NULL;

-- То же для ВНЕШНЕГО подписанта: личность гостя — запись ShareLinkGuest, и
-- повторный заход того же человека по той же ссылке не должен плодить акты.
CREATE UNIQUE INDEX IF NOT EXISTS "sign_acts_one_live_per_guest"
  ON "sign_acts" ("request_id", "signer_guest_id")
  WHERE "status" IN ('pending', 'signed') AND "signer_guest_id" IS NOT NULL;
