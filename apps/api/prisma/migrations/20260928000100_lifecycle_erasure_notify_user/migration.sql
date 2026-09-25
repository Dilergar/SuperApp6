SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Кому сообщить о завершении стирания (Э5): владелец организации на момент архива. Организации
-- к тому времени нет, а человек — есть: уведомление `lifecycle.erasure.completed` уходит ему.
-- Только id (ссылка на человека); стирание самого человека ссылку не ведёт.
ALTER TABLE "lifecycle_erasure_requests" ADD COLUMN "notify_user_id" UUID;

-- Суточный снимок размеров — по ТАБЛИЦЕ (рост за 7 дней в «Хранилище», старейшая строка для
-- отставания сроков), класс данных — колонкой для графика роста по классам. Таблица создана
-- этим же этапом и пуста: ключ и колонки меняются без перезаписи данных.
ALTER TABLE "lifecycle_storage_daily" DROP CONSTRAINT "lifecycle_storage_daily_pkey";
ALTER TABLE "lifecycle_storage_daily" DROP COLUMN "tables";
ALTER TABLE "lifecycle_storage_daily"
  ADD COLUMN "table_name" TEXT NOT NULL,
  ADD COLUMN "policy_id" TEXT,
  ADD COLUMN "oldest_at" TIMESTAMPTZ(3);
ALTER TABLE "lifecycle_storage_daily" ADD CONSTRAINT "lifecycle_storage_daily_pkey" PRIMARY KEY ("day", "table_name");
CREATE INDEX "lifecycle_storage_daily_day_data_class_idx" ON "lifecycle_storage_daily" ("day", "data_class");
