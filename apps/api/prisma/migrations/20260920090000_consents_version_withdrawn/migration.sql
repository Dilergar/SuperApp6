-- core/consents: статус `withdrawn` — версия опубликована, но отозвана ДО вступления в силу
-- новой публикацией того же документа (срочная правка не должна ждать, пока вступит плановая).
-- Отозванная версия не участвует ни в шлюзе, ни в витрине; её подпись и место в хэш-цепочке остаются.
ALTER TABLE "consent_versions" DROP CONSTRAINT "consent_versions_status_check";
ALTER TABLE "consent_versions" ADD CONSTRAINT "consent_versions_status_check" CHECK ("status" IN ('draft', 'published', 'superseded', 'withdrawn'));
