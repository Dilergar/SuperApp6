# Unified Search Engine (core/search) — Phase 6, 2026-06-01

Reusable, cross-service search engine. Same architectural pattern as `core/access` & `core/rich-cards`: one @Global engine, feature services register providers + project their items; engine stays domain-agnostic (no core→feature import). NOT in the chokepoint (cross-cutting). Benchmarked Salesforce SOSL / Microsoft Search connectors / Slack / Notion → all use a unified permission-trimmed index + per-source providers, NOT live cross-table JOINs.

## Decision (user, 2026-06-01)
Build the engine NOW but wire ONLY messenger this phase. Other services (Tasks/Calendar/Wishlist/Marketplace) add a provider each later → a GLOBAL cross-service search (dashboard, filters) "lights up" automatically. Engine text choice locked: "умный + опечатки" = Postgres FTS (`tsvector('russian')` word-form stemming) + `pg_trgm` (typos/substrings/names, language-agnostic for KZ/EN). NO `unaccent` (it's STABLE not IMMUTABLE → illegal in a GENERATED column, AND it wrongly folds distinct Kazakh letters ә/ғ/қ/ң/ө/ұ/ү/һ/і).

## Files (apps/api/src/core/search/)
- search.module.ts (@Global; provides SearchRegistry, SearchProjectionService, SearchService, SearchReconcileCron; controller SearchController) — registered in app.module after RichCardsModule.
- search.types.ts — SearchProvider {type,label,search(viewerId,q,opts),reconcile?}; SearchProviderOpts {limit, mode:'global'|'page', chatId?, cursor?}.
- search.registry.ts — register/get/all/types(); insertion order = global group order.
- search-projection.service.ts — generic upsert(doc)/remove(type,id)/removeByChat(chatId) on db.searchDocument.
- search.service.ts — global(viewerId,q) [per-type cap, relevance, hasMore] + page(viewerId,q,type,{chatId,cursor}) [flat, keyset].
- search.controller.ts — GET /search: q-only→global; +chatId→in-chat message page; +type→single-type page.
- search-reconcile.cron.ts — nightly Redis-lock; calls each provider.reconcile() (bounded repair).

## Schema (prisma) — SearchDocument @@map("search_documents")
id, sourceType, sourceId (@@unique[sourceType,sourceId]), workspaceId?, title?, body?, url, chatId?, seq?, authorId?, itemCreatedAt (entity ts, drives recency), createdAt, updatedAt, searchVector Unsupported("tsvector")? (GENERATED in raw SQL, Prisma never writes it). @@index sourceType, chatId. Migration 20260601160000_search: CREATE EXTENSION pg_trgm; generated `to_tsvector('russian', coalesce(title,'')||' '||coalesce(body,''))` STORED; GIN on search_vector + trigram GIN (gin_trgm_ops) on title & body.

## How a NEW service plugs in (the contract)
1. Add a provider implementing SearchProvider; register it in your module's OnModuleInit via the @Global SearchRegistry (inject it). type = a SEARCH_SOURCE_TYPES value (add to @superapp/shared/constants/search.ts: SEARCH_SOURCE_TYPES + the types/validation enums, rebuild shared).
2. INDEXED provider: on create/update/delete of your entity, call SearchProjectionService.upsert({sourceType, sourceId, title/body, url, itemCreatedAt, + your access keys}) / remove(). Add a backfill in scripts + a bounded reconcile(). PERMISSION-TRIM in your provider's search() — either via core/access can()/listObjects, or a SQL JOIN to your membership table (messenger does the latter). NEVER return rows the viewer can't see.
3. LIVE provider (small per-user sets like окружение): skip the index, query your table directly in search().
4. Global cross-service search needs no engine change — it runs all registered providers.

## Messenger consumer (reference impl)
apps/api/src/modules/messenger/messenger-search.service.ts: chat+person LIVE, message INDEXED. message SQL trims by active chat_members JOIN + seq>=visible_from_seq (== getMessages visibility). global=relevance (ts_rank*4 + word_similarity), page=recency keyset (item_created_at,source_id; cursor `<iso>_<id>`). Snippet centered on match. Typo: `<%` op with `SET LOCAL pg_trgm.word_similarity_threshold=0.4` inside a $transaction([$executeRaw SET LOCAL, $queryRaw query]). Hooks in MessengerService sendMessage/editMessage/deleteMessage (best-effort, awaited) + removeChat in deleteGroup/deleteTaskChat/deleteOrderChat/deleteEventChat.

## Shared (@superapp/shared)
constants/search.ts (SEARCH_SOURCE_TYPES, SEARCH_LIMITS{minQueryLength2,maxQueryLength100,perTypeLimit8,pageSize30}), types/search.ts (SearchSourceType, SearchResultItem, SearchGroup, GlobalSearchResults, SearchResultPage), validation/search.ts (searchQuerySchema {q,type?,chatId?,cursor?}).

## Web
GlobalSearch.tsx (bar above ChatList, grouped results replace list), Conversation in-chat 🔍 (searchInChat + ↑↓, reuses flashId/scroll + auto-load-older to reach a match). lib/messenger-api: searchGlobal/searchInChat.

## Verified
verify-search.cjs 22/0. nest build + web tsc clean. NOT committed (working tree). NOT browser-smoked (Chrome extension off this session).

## GOTCHAS
- 'russian' FTS config present on docker pg16 (migrate deploy succeeded). Coined/foreign words pass through unstemmed (still matched by trigram). 
- OFFSET avoided; page mode uses recency keyset (stable under concurrent inserts).
- Generated tsvector expression MUST be immutable → only constant config + coalesce; no unaccent/no stable funcs.
- Orphan index rows after a chat delete are harmless (message SQL JOINs chats/chat_members → filtered) but removeByChat cleans them anyway.
