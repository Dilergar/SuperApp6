-- core/visibility R9: «Доступ к контактным данным» для интеграций. Без флага бот и ключ API
-- видят поля не выше класса `internal`; с флагом — ещё `contact` (телефон/e-mail клиента).
-- `confidential/restricted/secret` ключу не открываются никогда. Флаг бота копируется в его
-- ключи (один источник — бот, как у скоупов); у личного ключа организации — свой.
ALTER TABLE "bots" ADD COLUMN "contact_access" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "api_keys" ADD COLUMN "contact_access" BOOLEAN NOT NULL DEFAULT false;

-- Бывшая B2B-способность `card.view_full` снята: поля карточки решает движок видимости.
-- Рёбер `card#full_viewer` в живой базе нет, уборка — страховка для стендов.
DELETE FROM "relation_tuples" WHERE "resource_type" = 'card' AND "relation" = 'full_viewer';
