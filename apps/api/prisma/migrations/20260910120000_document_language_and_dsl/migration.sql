-- ============================================================
-- Язык бланка + английский DSL шаблонов (docs/i18n_migration.md, трек «бланки и DSL»).
--
-- 1) У организации, бланка и документа появляется ЯЗЫК БУМАГИ. Всё, что уже
--    существует, написано по-русски (константа FORM_LOCALE = 'ru' до этой
--    миграции), поэтому существующие строки получают 'ru', а умолчание для
--    НОВЫХ — государственный язык рынка ('kk').
-- 2) Имена тегов внутри бланков переезжают на английские идентификаторы:
--    «{Организация.БИН}» → «{Organization.Bin}». Переписываются блочные
--    шаблоны, снимки документов, форматы номера и ключи полей формы.
--    Загруженные .docx переписать нельзя — их теги станут неизвестны, и
--    компилятор честно назовёт их автору списком.
-- 3) Основание подписи («действующего на основании Приказа № 12-к от …»)
--    хранится СТРУКТУРОЙ: печатная фраза собирается на выходе, в языке того
--    документа, куда она попадает.
-- ============================================================

-- ---------- 1. Язык ----------
ALTER TABLE "workspaces" ADD COLUMN "document_language" TEXT NOT NULL DEFAULT 'kk';
ALTER TABLE "doc_templates" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'kk';
ALTER TABLE "org_documents" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'kk';

UPDATE "workspaces" SET "document_language" = 'ru';
UPDATE "doc_templates" SET "language" = 'ru';
UPDATE "org_documents" SET "language" = 'ru';

-- ---------- 2. DSL ----------
DO $do$
DECLARE
  tag_pairs text[][] := ARRAY[
    ARRAY['Организация.Юрнаименование','Organization.LegalName'],
    ARRAY['Организация.Название','Organization.Name'],
    ARRAY['Организация.Юрформа','Organization.OrgForm'],
    ARRAY['Организация.Юрадрес','Organization.LegalAddress'],
    ARRAY['Организация.Свидетельство НДС','Organization.VatCertificate'],
    ARRAY['Организация.Директор','Organization.Director'],
    ARRAY['Организация.Основание','Organization.Ground'],
    ARRAY['Организация.БИН','Organization.Bin'],
    ARRAY['Организация.КБе','Organization.Kbe'],
    ARRAY['Организация.ИИК','Organization.Iik'],
    ARRAY['Организация.Банк','Organization.Bank'],
    ARRAY['Организация.БИК','Organization.Bik'],
    ARRAY['Сотрудник.ФИО','Employee.FullName'],
    ARRAY['Сотрудник.Имя','Employee.FirstName'],
    ARRAY['Сотрудник.Фамилия','Employee.LastName'],
    ARRAY['Сотрудник.Отчество','Employee.MiddleName'],
    ARRAY['Сотрудник.Телефон','Employee.Phone'],
    ARRAY['Сотрудник.ИИН','Employee.Iin'],
    ARRAY['Сотрудник.Адрес','Employee.Address'],
    ARRAY['Сотрудник.Дата рождения','Employee.BirthDate'],
    ARRAY['Сотрудник.Номер удостоверения','Employee.IdNumber'],
    ARRAY['Сотрудник.Кем выдано удостоверение','Employee.IdIssuedBy'],
    ARRAY['Сотрудник.Дата выдачи удостоверения','Employee.IdIssuedAt'],
    ARRAY['Сотрудник.Удостоверение','Employee.IdDocument'],
    ARRAY['Сотрудник.Должность','Employee.Position'],
    ARRAY['Сотрудник.Отдел','Employee.Department'],
    ARRAY['Сотрудник.Филиал','Employee.Branch'],
    ARRAY['Сотрудник.Руководитель объекта Должность','Employee.BranchHeadPosition'],
    ARRAY['Сотрудник.Руководитель объекта','Employee.BranchHead'],
    ARRAY['Сотрудник.Руководитель Должность','Employee.ManagerPosition'],
    ARRAY['Сотрудник.Руководитель','Employee.Manager'],
    ARRAY['Документ.Название','Document.Title'],
    ARRAY['Документ.Номер','Document.Number'],
    ARRAY['Документ.Дата','Document.Date'],
    ARRAY['Контрагент.Юрнаименование','Counterparty.LegalName'],
    ARRAY['Контрагент.Название','Counterparty.Name'],
    ARRAY['Контрагент.Юрформа','Counterparty.OrgForm'],
    ARRAY['Контрагент.БИН-ИИН','Counterparty.BinOrIin'],
    ARRAY['Контрагент.БИН','Counterparty.Bin'],
    ARRAY['Контрагент.ИИН','Counterparty.Iin'],
    ARRAY['Контрагент.Юрадрес','Counterparty.LegalAddress'],
    ARRAY['Контрагент.Фактический адрес','Counterparty.ActualAddress'],
    ARRAY['Контрагент.КБе','Counterparty.Kbe'],
    ARRAY['Контрагент.Налоговый режим','Counterparty.TaxRegime'],
    ARRAY['Контрагент.ИИК','Counterparty.Iik'],
    ARRAY['Контрагент.Банк','Counterparty.Bank'],
    ARRAY['Контрагент.БИК','Counterparty.Bik'],
    ARRAY['Контрагент.Свидетельство НДС','Counterparty.VatCertificate'],
    ARRAY['Контрагент.Руководитель','Counterparty.Director'],
    ARRAY['Контрагент.Основание','Counterparty.Ground'],
    ARRAY['Контрагент.Подписант Должность','Counterparty.SignerPosition'],
    ARRAY['Контрагент.Подписант Телефон','Counterparty.SignerPhone'],
    ARRAY['Контрагент.Подписант','Counterparty.Signer'],
    ARRAY['Договор.Номер','Contract.Number'],
    ARRAY['Договор.Дата договора','Contract.Date'],
    ARRAY['Договор.Дата приёма','Contract.StartDate'],
    ARRAY['Договор.Срок','Contract.Term'],
    ARRAY['Договор.Должность','Contract.Position'],
    ARRAY['Договор.Филиал','Contract.Branch'],
    ARRAY['Договор.Оклад','Contract.Salary'],
    ARRAY['Договор.Ставка','Contract.Rate'],
    ARRAY['Договор.График','Contract.Schedule'],
    ARRAY['Договор.Испытание до','Contract.ProbationUntil'],
    ARRAY['Договор.Табельный номер','Contract.PersonnelNumber'],
    ARRAY['Договор.Дата увольнения','Contract.EndDate'],
    ARRAY['Действие.Вид','Action.Kind'],
    ARRAY['Действие.Дата вступления','Action.EffectiveFrom'],
    ARRAY['Действие.Дата окончания','Action.EffectiveTo'],
    ARRAY['Действие.Дней','Action.Days'],
    ARRAY['Действие.Оклад','Action.Salary'],
    ARRAY['Действие.Новая должность','Action.NewPosition'],
    ARRAY['Действие.Новый филиал','Action.NewBranch'],
    ARRAY['Действие.Основание','Action.Ground'],
    ARRAY['Подписант.ФИО','Signer.FullName'],
    ARRAY['Подписант.Должность','Signer.Position']
  ];
  form_pairs text[][] := ARRAY[
    ARRAY['Форма.Период отпуска С','Form.LeavePeriod From'],
    ARRAY['Форма.Период отпуска По','Form.LeavePeriod To'],
    ARRAY['Форма.Период отпуска Дней','Form.LeavePeriod Days'],
    ARRAY['Форма.Период отпуска','Form.LeavePeriod'],
    ARRAY['Форма.Дата увольнения С','Form.DismissalDate From'],
    ARRAY['Форма.Дата увольнения По','Form.DismissalDate To'],
    ARRAY['Форма.Дата увольнения Дней','Form.DismissalDate Days'],
    ARRAY['Форма.Дата увольнения','Form.DismissalDate'],
    ARRAY['Форма.Что меняется С','Form.WhatChanges From'],
    ARRAY['Форма.Что меняется По','Form.WhatChanges To'],
    ARRAY['Форма.Что меняется Дней','Form.WhatChanges Days'],
    ARRAY['Форма.Что меняется','Form.WhatChanges'],
    ARRAY['Форма.Дата изменения С','Form.ChangeDate From'],
    ARRAY['Форма.Дата изменения По','Form.ChangeDate To'],
    ARRAY['Форма.Дата изменения Дней','Form.ChangeDate Days'],
    ARRAY['Форма.Дата изменения','Form.ChangeDate']
  ];
  fmt_pairs text[][] := ARRAY[
    ARRAY['дата:долгая','date:long'],
    ARRAY['прописью:число','words:number'],
    ARRAY['дата','date'],
    ARRAY['прописью','words'],
    ARRAY['число','number']
  ];
  field_pairs text[][] := ARRAY[
    ARRAY['Период отпуска','LeavePeriod'],
    ARRAY['Дата увольнения','DismissalDate'],
    ARRAY['Что меняется','WhatChanges'],
    ARRAY['Дата изменения','ChangeDate']
  ];
  p text[];
BEGIN
  -- Пути чипов: заменяется ТОЛЬКО значение в кавычках, а не текст абзаца
  FOREACH p SLICE 1 IN ARRAY (form_pairs || tag_pairs) LOOP
    UPDATE "doc_templates"
       SET "builder_doc" = replace("builder_doc"::text, '"' || p[1] || '"', '"' || p[2] || '"')::jsonb
     WHERE "builder_doc"::text LIKE '%"' || p[1] || '"%';
    UPDATE "org_documents"
       SET "builder_doc" = replace("builder_doc"::text, '"' || p[1] || '"', '"' || p[2] || '"')::jsonb
     WHERE "builder_doc"::text LIKE '%"' || p[1] || '"%';
  END LOOP;

  -- Имена форматов чипа
  FOREACH p SLICE 1 IN ARRAY fmt_pairs LOOP
    UPDATE "doc_templates"
       SET "builder_doc" = replace("builder_doc"::text, '"format": "' || p[1] || '"', '"format": "' || p[2] || '"')::jsonb
     WHERE "builder_doc"::text LIKE '%"format": "' || p[1] || '"%';
    UPDATE "org_documents"
       SET "builder_doc" = replace("builder_doc"::text, '"format": "' || p[1] || '"', '"format": "' || p[2] || '"')::jsonb
     WHERE "builder_doc"::text LIKE '%"format": "' || p[1] || '"%';
  END LOOP;

  -- Ключи полей формы подачи (библиотечные бланки ТК РК)
  FOREACH p SLICE 1 IN ARRAY field_pairs LOOP
    UPDATE "doc_templates"
       SET "fields" = replace("fields"::text, '"key": "' || p[1] || '"', '"key": "' || p[2] || '"')::jsonb
     WHERE "fields"::text LIKE '%"key": "' || p[1] || '"%';
    UPDATE "org_documents"
       SET "form_fields" = replace("form_fields"::text, '"key": "' || p[1] || '"', '"key": "' || p[2] || '"')::jsonb
     WHERE "form_fields"::text LIKE '%"key": "' || p[1] || '"%';
    -- Значения формы лежат под ключом-именем поля
    UPDATE "org_documents"
       SET "fields" = replace("fields"::text, '"' || p[1] || '": ', '"' || p[2] || '": ')::jsonb
     WHERE "fields"::text LIKE '%"' || p[1] || '": %';
  END LOOP;
END
$do$;

-- Плейсхолдеры формата номера вида
UPDATE "doc_types"
   SET "number_format" = replace(replace(replace("number_format", '{ГГГГ}', '{YYYY}'), '{ГГ}', '{YY}'), '{ММ}', '{MM}')
 WHERE "number_format" LIKE '%{Г%' OR "number_format" LIKE '%{М%';

-- ---------- 3. Основание подписи структурой ----------
ALTER TABLE "legal_entities" ADD COLUMN "sign_basis_kind" TEXT;
ALTER TABLE "legal_entities" ADD COLUMN "sign_basis_number" TEXT;
ALTER TABLE "legal_entities" ADD COLUMN "sign_basis_date" DATE;
ALTER TABLE "legal_entities" ADD COLUMN "sign_basis_text" TEXT;
ALTER TABLE "counterparties" ADD COLUMN "sign_basis_kind" TEXT;
ALTER TABLE "counterparties" ADD COLUMN "sign_basis_number" TEXT;
ALTER TABLE "counterparties" ADD COLUMN "sign_basis_date" DATE;
ALTER TABLE "counterparties" ADD COLUMN "sign_basis_text" TEXT;

DO $do$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['legal_entities','counterparties'] LOOP
    -- Виды без деталей: строка совпадает с печатным словосочетанием каталога (ru)
    EXECUTE format($f$
      UPDATE %1$I SET sign_basis_kind = 'ustav' WHERE btrim(sign_basis) = 'Устава';
      UPDATE %1$I SET sign_basis_kind = 'svid_ip' WHERE btrim(sign_basis) = 'Свидетельства о регистрации ИП';
      UPDATE %1$I SET sign_basis_kind = 'polozhenie' WHERE btrim(sign_basis) = 'Положения';
      UPDATE %1$I SET sign_basis_kind = 'doverennost',
                      sign_basis_number = nullif(substring(sign_basis from '№ ([^ ]+)'), ''),
                      sign_basis_date = to_date(substring(sign_basis from 'от (\d{1,2}\.\d{1,2}\.\d{4})'), 'DD.MM.YYYY')
        WHERE sign_basis LIKE 'Доверенности%%';
      UPDATE %1$I SET sign_basis_kind = 'prikaz',
                      sign_basis_number = nullif(substring(sign_basis from '№ ([^ ]+)'), ''),
                      sign_basis_date = to_date(substring(sign_basis from 'от (\d{1,2}\.\d{1,2}\.\d{4})'), 'DD.MM.YYYY')
        WHERE sign_basis LIKE 'Приказа%%';
      -- Остальное набрано руками: сохраняется целиком в «Свой вариант»
      UPDATE %1$I SET sign_basis_kind = 'custom', sign_basis_text = sign_basis
        WHERE sign_basis IS NOT NULL AND btrim(sign_basis) <> '' AND sign_basis_kind IS NULL;
    $f$, tbl);
  END LOOP;
END
$do$;

ALTER TABLE "legal_entities" DROP COLUMN "sign_basis";
ALTER TABLE "counterparties" DROP COLUMN "sign_basis";
