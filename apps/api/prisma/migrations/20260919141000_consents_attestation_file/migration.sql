-- core/consents: файл-отпечаток версии (PDF трёх языков + хэши), отданный на заверение ЭЦП
-- руководителя оператора через core/sign. Колонка не входит в список неизменяемых триггера
-- `consent_versions_guard`: заверение заводится ПОСЛЕ публикации.
ALTER TABLE "consent_versions" ADD COLUMN "attestation_file_id" TEXT;
