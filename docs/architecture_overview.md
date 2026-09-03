# Архитектура: обзор

> SuperApp6 — экосистема **B2C + B2B** «ERP для жизни и бизнеса»: один аккаунт, один `user_id` навсегда — и внутри 100+ сервисов (целевой масштаб). Рынок — Казахстан; идея на стыке суперапп-подхода WeChat/Kaspi и ERP (Salesforce/Odoo). Видение, пользователи и позиционирование — `/PRODUCT.md`.

## Монорепо (pnpm + Turborepo)

```
apps/
  api/            # NestJS 10 — модульный монолит (порт 3001; Swagger /api/docs только в dev)
    src/core/     #   16 платформенных движков + auth/users/roles (всегда загружены)
    src/modules/  #   функциональные сервисы — тонкие модули поверх движков
    src/shared/   #   Database (chokepoint-скоуп), Redis, EventBus, Guards, фильтры,
                  #   http-двери (safeFetch/trustedFetch), манифест DI_TOKENS
    prisma/       #   схема БД + миграции (prisma migrate; baseline 0_init)
    scripts/      #   verify-*.cjs — e2e-сьют (гоняется в CI) + seed + gc-утилиты
  web/            # Next.js 15 App Router + Tailwind v4 (порт 3000; dev на Turbopack)
  mobile/         # React Native + Expo — МЁРТВ (не компилируется), переписывается на этапе 2
packages/
  shared/         # типы, Zod-схемы, константы, утилиты — ЕДИНСТВЕННОЕ описание провода
  api-client/     # транспорт границы API↔клиенты (axios, single-flight refresh, apiGet<T>…)
infra/
  docs-editor/    # своя обезличенная сборка Collabora Online (WOPI-редактор core/docs)
  sign-verifier/  # своя ПРИВАТНАЯ сборка NCANode + SDK KalkanCrypt (верификатор ЭЦП)
  glyph-pack/     # сборка пака значков (Phosphor + Fluent + Noto)
  pdf-fonts/      # PT Serif для PDF-рендера (казахский алфавит)
docs/             # документация проекта (этот каталог; индекс — README.md)
docker-compose.yml  # PostgreSQL 16 + Redis 7 + опциональные профили (s3, scan, voice, calls, docs, pdf, sign)
```

Корневые документы: `/CLAUDE.md` (конституция — правила работы), `/PRODUCT.md` (продукт), `/DESIGN.md` (дизайн-система), `/docs` (архитектура и справочники).

## Модульный монолит

Каждый сервис — изолированный NestJS-модуль. Связи между модулями двух видов:

1. **Синхронные вызовы** (прямая инъекция сервисов) — там, где нужна атомарность (деньги в одной `$transaction`) или консистентное чтение. Полная карта фактических рёбер, DI-токены и правила — [module_graph.md](module_graph.md). Новое ребро обязано попадать в эту карту.
2. **EventBus** (Redis Streams, consumer group, **at-most-once**) — только сайд-эффекты, которые допустимо потерять. Обязательная фоновая работа идёт через движок `core/jobs` (transactional outbox, at-least-once). Правило платформы: **на шину — только то, что можно потерять; деньги — только синхронно в одной транзакции**.

Зафиксированное решение архитектурного ревью: **микросервисы не нужны** — синхронные деньги в одной транзакции это правильный монолитный выбор (путь Shopify/GitHub). Движок `core/access` не переписывать — модель Zanzibar верна.

## 16 платформенных движков (`apps/api/src/core/`)

`access` · `rich-cards` · `search` · `quick-actions` · `files` · `voice` · `calls` · `chatter` · `jobs` · `verify` · `docs` · `share-links` · `approvals` · `sign` · `templates` · `audiences` — плюс всегда загруженные `auth`/`users`/`roles`. У каждого движка свой файл в docs (`*_engine.md`).

Несущий принцип: **сначала переиспользуй, потом пиши** — новый сервис это тонкий модуль + регистрации в движках, а не копия чужой логики. Если движка не хватает — он РАСШИРЯЕТСЯ, а не копируется. Пошагово — [playbook_new_service.md](playbook_new_service.md).

## Изоляция и идентичность

- **Universal Identity**: один `user_id` навсегда; роли не в users-таблице, а в `user_roles(user_id, role, context, tenant_id)` — [identity_roles.md](identity_roles.md).
- **B2B-изоляция** — ровно два законных пути: chokepoint `X-Workspace-Id` (interceptor → AsyncLocalStorage → авто-скоуп Prisma) ИЛИ явное владение `ownerType+ownerId` + проверка прав. RLS не используется (защита на уровне приложения, как у Salesforce).
- **Права** — единый движок ReBAC `core/access`; код проверяет **способности**, не имена ролей — [access_engine.md](access_engine.md).

## Граница API ↔ клиенты

Одна форма провода = один тип в `@superapp/shared`, стоящий на обеих сторонах; клиенты ходят только через хелперы `@superapp/api-client`; обходные пути запрещены ESLint-стражами. Полные правила — [contract_boundary.md](contract_boundary.md).

## Клиенты (device-agnostic)

Веб, мобильное приложение (этап 2) и будущий Терминал (собственная железка для голосовых AI-команд) — равноправные клиенты ОДНОГО API `/api/v1`. Сегодня живой клиент один — веб; пока нативного приложения нет, **мобильный веб обязан работать** (375px без горизонтального скролла).

## AI-ready (правило проектирования уже сейчас)

Каждая операция каждого сервиса должна быть вызываема программно: тонкий контроллер + Zod + способность. Это будущие AI-инструменты сервисов (профильные ассистенты + SuperAIAgent6). Модель AI — гибрид: ЧТЕНИЕ напрямую из БД строго через `core/access` (видимость как у пользователя, не больше), ДЕЙСТВИЯ — только через сервисные API (денежное — без исключений).

## Стек

| Слой | Технология | Версия |
|------|-----------|--------|
| Runtime | Node.js | 22.x (CI; engines ≥20) |
| Package Manager | pnpm | 9.x |
| Monorepo | Turborepo | 2.x |
| Backend | NestJS | 10.x |
| ORM | Prisma | 6.x |
| Database | PostgreSQL | 16 |
| Cache/шина | Redis | 7 |
| Web | Next.js | 15.x |
| CSS | Tailwind CSS | 4.x |
| State | Zustand | 5.x |
| Data Fetching | TanStack React Query | 5.x |
| Виртуализация списков | react-virtuoso | 4.x |
| Validation | Zod | 3.x |
| Language | TypeScript | 5.7 |
| Mobile (этап 2) | React Native + Expo | 0.76 / SDK 52 |

## Порты (dev)

| Что | Порт | Как поднять |
|-----|------|-------------|
| API | 3001 | `pnpm dev` / `npx nest start --watch` |
| Web | 3000 | `pnpm dev` / `npx next dev` |
| PostgreSQL 16 | 5432 | `docker compose up -d` |
| Redis 7 | 6379 | `docker compose up -d` |
| Collabora (редактор документов) | 9980 | `docker compose --profile docs up -d` |
| Gotenberg (PDF-рендер) | 3030 | `docker compose --profile pdf up -d` |
| NCANode (верификатор ЭЦП) | 14579 | `docker compose --profile sign up -d` |
| Whisper STT | 9000 | `docker compose --profile voice up -d` |
| LiveKit SFU | 7880 / 7881 / 7882udp | `docker compose --profile calls up -d` |
| ClamAV | 3310 | `docker compose --profile scan up -d` |
| SeaweedFS (S3) | 8333 | `docker compose --profile s3 up -d` |

Команды, порядок сборки и ловушки среды — [dev_environment.md](dev_environment.md).
