# SuperApp6 — Project Overview

**SuperApp6 = экосистема B2C + B2B, «ERP для жизни и бизнеса»**: один аккаунт, один `user_id` навсегда, целевой масштаб — **100+ сервисов** (всё, чем человек пользуется в жизни и на работе). Рынок — Казахстан; стык суперапп-подхода WeChat/Kaspi и ERP (Salesforce/Odoo). B2B — организации-арендаторы в том же приложении (workspace, `X-Workspace-Id`); позже выделенный раздел SuperApp6 Business. Монорепо pnpm + Turborepo.

## Принципы платформы (детально — CLAUDE.md «Принципы платформы»)
1. **Сначала переиспользуй**: общее живёт в платформенных движках, новый сервис = тонкий модуль + регистрации. Движки: `core/access` (ReBAC), `core/rich-cards`, `core/search`, `core/quick-actions`, Notifications, wallet (Ledger+Escrow), EventBus, chokepoint B2B, `assertReachable`, EntitySelector, PersonChip/PersonAvatar. Не хватает движка → расширить, не копировать.
2. **Человек в UI = одна из 5 карточек PersonCard (XS/S/M/L/XL), везде** — `PersonChip`/`PersonAvatar`, не голый текст (видимость платных скинов).
3. **Rich Card где уместно**: сущность со статусами/действиями обязана рендериться рич-картой.
4. **AI-ready**: в каждом сервисе будет профильный AI-ассистент + главный **SuperAIAgent6** (оркестратор, голос: «поставь задачу Диане…» через Circle). Модель — ГИБРИД: чтение AI напрямую из БД, но строго через проверки core/access (видимость пользователя); действия — ТОЛЬКО через сервисные API/способности (деньги — без исключений). Уже сейчас: каждая операция сервиса вызываема программно (тонкий контроллер + Zod + capability).
5. **Device-agnostic**: веб, mobile, будущий Терминал (железка ~60×90×10 мм, микрофон/динамик/дисплей — голосовые команды AI) — клиенты одного API `/api/v1`; датчики (движение/температура/…) для умного дома и бизнеса — будущий модуль «Умный дом/IoT».

## Дорожная карта
1. **Сейчас: новые сервисы** (через грилл): Финансы (семейный бюджет), Jobs Marketplace, Отзывы B2B (Kaspi/Google/2GIS — research готов, см. project_reviews_service в auto-memory), Сотрудники B2B (оргструктура; фундамент в core/access). Список открыт.
2. Mobile (api-client пакет, push, design-tokens, upload + переписать приложение).
3. AI (ассистенты + SuperAIAgent6).
4. Терминал + IoT (железо после AI-софта).
Фоном: хвост блока 7 архревью (helmet/CORS-env/health/Dockerfile) + web-гигиена.

## Архитектура: модульный монолит
- NestJS API (`apps/api`); связи модулей ДВУХ видов: синхронные вызовы (атомарность денег/консистентное чтение — карта рёбер в CLAUDE.md «Модульный монолит», новое ребро → добавить туда) + EventBus (Redis Streams, at-most-once — деньги только синхронно).
- `core/` = auth, users, roles, access, rich-cards, search, quick-actions; `modules/` = notifications, contacts, circles, tasks, calendar, google-calendar, workspaces, wallet, shop, messenger, card-skins; `shared/` = database (chokepoint $extends), redis, events, guards, interceptors, filters (AllExceptionsFilter — единый конверт ошибок), config (env-валидация).
- API-префикс: канонично `/api/v1`, `/api` — legacy-алиас.
- Окружение (Circle) — фундамент: «Контакты» НЕ существует, всё — «Окружение»; одна роль на сторону; Группы со своей cardVisibility; блок удаляет связь; `assertReachable` гейтит все действия «между людьми».
- Хардненинг архревью: блоки 1–6 и 9 выполнены, 7 — частично (см. CLAUDE.md «Известные риски» + memory project_architecture_review).

## Web UI
- React Query с общими ключами (`apps/web/src/lib/queries.ts`: contacts/circles/инвайты) — messenger-стиль тиражирован на /circles и /tasks.
- PersonCard — 5 размеров, токенизирован под скины; Lottie через next/dynamic + IO-гейт.
- Пикеры — EntitySelector; человек — PersonChip/PersonAvatar.

## Инфраструктура
- API: localhost:3001 (`/api/v1`), Web: localhost:3000. GitHub: Dilergar/SuperApp6. CI: .github/workflows/ci.yml (PG+Redis, build, migrate, полный verify-сьют ~30 скриптов).
- 3 тестовых аккаунта: tester1/2/3 (+77001234567 / +77012345678 / +77023456789), пароль Test1234!
- Mobile (Expo) мёртв — переписывается на этапе 2 дорожной карты.
- Windows: tsc только через PowerShell; полный tsc на api НЕ запускать (OOM) — только nest build.
