-- AlterTable
ALTER TABLE "sign_requests" ADD COLUMN     "stamped_file_id" TEXT,
ADD COLUMN     "stamped_sha256" TEXT,
ADD COLUMN     "suppress_outcome_notify" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "sign_requests_stamped_sha256_idx" ON "sign_requests"("stamped_sha256");

-- РУКАМИ (Prisma не выражает партиальный UNIQUE, комментарий-зеркало в schema.prisma):
-- одна живая СВОБОДНАЯ заявка (без шага маршрута) на предмет. Повторная отправка
-- контрагенту при уже идущем подписании невозможна даже в гонке двух вкладок —
-- вторую INSERT отбивает индекс (P2002), а не проверка в приложении.
-- Кадровым шаговым заявкам не мешает: у них approval_step_id NOT NULL и свой
-- per-step уникум из миграции sign_engine.
CREATE UNIQUE INDEX "sign_requests_one_active_freeform"
  ON "sign_requests" ("ref_type", "ref_id")
  WHERE "status" = 'pending' AND "approval_step_id" IS NULL;
