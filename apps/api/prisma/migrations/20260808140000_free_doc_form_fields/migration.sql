-- Поля СВОБОДНОГО документа (без шаблона): объявление живёт на самом документе,
-- у документа по шаблону форма остаётся свойством шаблона (formFields = NULL).
ALTER TABLE "org_documents" ADD COLUMN "form_fields" JSONB;
