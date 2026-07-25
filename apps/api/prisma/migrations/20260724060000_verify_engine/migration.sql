-- Движок подтверждений core/verify (11-й платформенный): SMS-OTP.
-- users.is_verified (boolean, нигде не выставлялся) → phone_verified_at (timestamp).
-- Grandfather: все СУЩЕСТВУЮЩИЕ аккаунты созданы до движка — считаем их номера
-- подтверждёнными задним числом (= created_at), иначе они «повиснут» неподтверждёнными
-- без пути подтверждения (регистрационный поток для них уже не работает).

-- AlterTable (порядок руками: add → backfill → drop; prisma migrate diff склеивает в один ALTER)
ALTER TABLE "users" ADD COLUMN "phone_verified_at" TIMESTAMP(3);

UPDATE "users" SET "phone_verified_at" = "created_at";

ALTER TABLE "users" DROP COLUMN "is_verified";

-- CreateTable
CREATE TABLE "verify_challenges" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "send_count" INTEGER NOT NULL DEFAULT 1,
    "last_sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "verify_token_hash" TEXT,
    "request_ip" TEXT,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verify_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "verify_challenges_verify_token_hash_key" ON "verify_challenges"("verify_token_hash");

-- CreateIndex
CREATE INDEX "verify_challenges_phone_purpose_created_at_idx" ON "verify_challenges"("phone", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "verify_challenges_created_at_idx" ON "verify_challenges"("created_at");
