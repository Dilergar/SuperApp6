-- «Видимость в Компаниях»: пер-полевые флаги карточки для коллег по организации
-- (ростер «Сотрудники»). null = дефолты из shared/constants/card-visibility.
ALTER TABLE "users" ADD COLUMN "company_card_visibility" JSONB;
