-- Блочный конструктор документов: шаблон может быть собран в вебе (kind='builder'),
-- документ несёт СНИМОК блоков (правка шаблона не меняет поданное).

ALTER TABLE "doc_templates" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'docx';
ALTER TABLE "doc_templates" ADD COLUMN "builder_doc" JSONB;

ALTER TABLE "org_documents" ADD COLUMN "builder_doc" JSONB;
