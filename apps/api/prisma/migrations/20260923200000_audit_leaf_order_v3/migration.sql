-- ============================================================
-- core/audit: версия корня Меркла 3 — ЧИСЛОВОЙ порядок листьев
-- ============================================================
-- В v1–v2 запрос листьев выбирал `xact::text AS xact, id::text AS id` и сортировал
-- `ORDER BY xact, id`: голое имя Postgres берёт из ВЫХОДНЫХ колонок — порядок был текстовым
-- (999 999 после 1 000 000), а курсор страницы `(xact, id) > (…)` сравнивал числа. Окно больше
-- страницы теряло и дублировало строки, независимая проверка корня расходилась с движком.
-- v3 = формула листа v2 и порядок `(e.xact, e.id)` по колонкам таблицы. Прошлые дайджесты и
-- архивы остаются v1–v2 и проверяются своим прежним запросом (их подписанный корень — по нему).
-- Умолчание колонки не меняется (1 — формула писателя, не знающего версии; код пишет явно).
-- ============================================================

ALTER TABLE "security_digests" DROP CONSTRAINT "security_digests_leaf_version_check";
ALTER TABLE "security_digests" ADD CONSTRAINT "security_digests_leaf_version_check" CHECK ("leaf_version" IN (1, 2, 3));

ALTER TABLE "security_partition_archives" DROP CONSTRAINT "security_partition_archives_leaf_version_check";
ALTER TABLE "security_partition_archives" ADD CONSTRAINT "security_partition_archives_leaf_version_check" CHECK ("leaf_version" IN (1, 2, 3));
