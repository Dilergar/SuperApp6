-- DropIndex
DROP INDEX "contact_invitations_to_user_id_status_idx";

-- AlterTable
ALTER TABLE "contact_invitations" ADD COLUMN     "auto_add_circle_ids" TEXT[];

-- CreateIndex
CREATE INDEX "contact_invitations_to_user_id_status_created_at_id_idx" ON "contact_invitations"("to_user_id", "status", "created_at", "id");

-- CreateIndex
CREATE INDEX "contact_invitations_from_user_id_status_created_at_id_idx" ON "contact_invitations"("from_user_id", "status", "created_at", "id");

-- ПАРТИАЛЬНЫЙ UNIQUE (Prisma такие индексы не умеет — дописан руками, зеркалён
-- комментарием в schema.prisma). Все лимиты отправки приглашений (кулдаун 24ч,
-- 30 в сутки, потолок pending) проверялись обычными count/findFirst ВНЕ транзакции,
-- поэтому десяток одновременных POST (глобальный троттлер разрешает 10/сек)
-- проходил их все и создавал десяток приглашений на один номер. Уникальность
-- среди ЖИВЫХ (pending) строк делает гонку невозможной; сервис ловит P2002 → 409.
--
-- Дубли, накопленные до этой миграции, схлопываем: оставляем самое свежее
-- pending на пару (отправитель, номер), остальные помечаем отменёнными —
-- удалять нельзя, на этой истории держатся кулдаун и лимиты.
UPDATE "contact_invitations" ci
SET "status" = 'cancelled', "responded_at" = NOW()
WHERE ci."status" = 'pending'
  AND EXISTS (
    SELECT 1 FROM "contact_invitations" newer
    WHERE newer."from_user_id" = ci."from_user_id"
      AND newer."to_phone" = ci."to_phone"
      AND newer."status" = 'pending'
      AND (newer."created_at" > ci."created_at"
           OR (newer."created_at" = ci."created_at" AND newer."id" > ci."id"))
  );

CREATE UNIQUE INDEX "contact_invitations_one_pending_per_phone"
  ON "contact_invitations" ("from_user_id", "to_phone")
  WHERE "status" = 'pending';
