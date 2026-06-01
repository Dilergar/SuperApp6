-- Phase 6: unified search index (core/search engine).
-- A denormalized, permission-trimmed "витрина" mirroring searchable domain items.
-- FTS via a generated tsvector ('russian' config — gives word-form stemming the user
-- asked for; safe for KZ/EN, which simply aren't stemmed) + pg_trgm GIN for typo/
-- substring/name matching (language-agnostic). unaccent is intentionally NOT used — it
-- would wrongly fold distinct Kazakh letters (ә, ғ, қ, ң, ө, ұ, ү, һ, і).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE "search_documents" (
    "id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "title" TEXT,
    "body" TEXT,
    "url" TEXT NOT NULL,
    "chat_id" TEXT,
    "seq" INTEGER,
    "author_id" TEXT,
    "item_created_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "search_documents_pkey" PRIMARY KEY ("id")
);

-- Generated full-text vector (immutable expression: constant 'russian' config + coalesce).
ALTER TABLE "search_documents"
    ADD COLUMN "search_vector" tsvector
    GENERATED ALWAYS AS (
        to_tsvector('russian', coalesce("title", '') || ' ' || coalesce("body", ''))
    ) STORED;

CREATE UNIQUE INDEX "search_documents_source_type_source_id_key" ON "search_documents"("source_type", "source_id");
CREATE INDEX "search_documents_source_type_idx" ON "search_documents"("source_type");
CREATE INDEX "search_documents_chat_id_idx" ON "search_documents"("chat_id");

-- FTS index (word-form / ranking).
CREATE INDEX "search_documents_search_vector_idx" ON "search_documents" USING GIN ("search_vector");

-- Trigram indexes (typos / substrings / names; language-agnostic).
CREATE INDEX "search_documents_title_trgm_idx" ON "search_documents" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "search_documents_body_trgm_idx" ON "search_documents" USING GIN ("body" gin_trgm_ops);
