-- Настройки гостевой ссылки одной волной: скачивание, уведомления об открытии
-- с предохранителем и смена адреса без пересоздания.

-- Скачивание. Не защита от копирования (байты и так у гостя в браузере) — убирает
-- кнопки и отдаёт превью вместо оригинала, как «Disable download» у Google Drive.
ALTER TABLE "share_links" ADD COLUMN "allow_download" BOOLEAN NOT NULL DEFAULT true;

-- Уведомления об открытии. По умолчанию ВКЛ: частый случай — «отправил документ
-- человеку», там уведомление и есть смысл. Массовую ссылку гасит предохранитель:
-- сутки считаем, после потолка молчим до следующего дня. Крон не нужен — день лежит
-- в строке и сбрасывается первым открытием следующих суток.
ALTER TABLE "share_links" ADD COLUMN "notify_on_open" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "share_links" ADD COLUMN "notify_day" DATE;
ALTER TABLE "share_links" ADD COLUMN "notify_count" INTEGER NOT NULL DEFAULT 0;

-- Смена адреса. Гостевой пропуск подписан по linkId, а не по токену, поэтому без
-- поколения смена адреса не отрезала бы уже открывшего ссылку — то есть ровно того,
-- ради кого адрес и меняют.
ALTER TABLE "share_links" ADD COLUMN "session_epoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "share_links" ADD COLUMN "token_rotated_at" TIMESTAMP(3);

-- Страница «Мои ссылки»: свои ссылки, новые сверху.
DROP INDEX IF EXISTS "share_links_created_by_id_idx";
CREATE INDEX "share_links_created_by_id_created_at_idx" ON "share_links"("created_by_id", "created_at");
