# SuperApp6 — Project Overview

SuperApp6 — WeChat-like super-app for Kazakhstan. Монорепо pnpm + Turborepo.

## Архитектура: модульный монолит
- NestJS API (`apps/api`) — модули общаются через EventBus (RxJS), не через прямой импорт
- `core/` = всегда загружены (auth, users, roles)
- `modules/` = функциональные (notifications, contacts, circles, tasks, calendar) — все Phase 4-5 модули ✅ DONE
- `shared/` = инфраструктура (database, redis, events, guards, decorators)
- Каждый модуль можно вытащить в микросервис без переписывания

## Окружение (Social Graph) — КЛЮЧЕВОЕ РЕШЕНИЕ
> **"Контакты" как отдельная сущность НЕ СУЩЕСТВУЕТ для пользователя.** Всё — "Окружение".

- **Окружение** = у каждого пользователя одно. Плоский список всех людей с подтверждённой двусторонней связью.
- **Папки** (Семья, Друзья, Коллеги...) = опциональная группировка внутри Окружения. Шаблоны + пользовательские названия.
- **Flow:** Ввести номер → выбрать роли (из шаблонов или вручную) → отправить → принять → карточки появляются в окружениях обоих → каждый сам раскладывает по папкам.
- Бэкенд: два модуля `contacts/` (связи, приглашения, блоки) + `circles/` (папки) — это внутренняя реализация.
- Фронт: единая страница `/circles` = "Моё окружение" — люди + приглашения + папки-чипы. **Нет отдельной /contacts страницы.**
- Prisma: ContactLink (связь), ContactInvitation (приглашение), ContactBlock (блок), Circle (папка), CircleMembership (M2M).
- Card visibility: всегда firstName/lastName/phone + per-field JSONB через `resolveCardVisibility()`.

## Universal Identity
Один `user_id` навсегда. Роли НЕ в users-таблице, а в отдельной `user_roles(user_id, role, context, tenant_id, is_active)`.
- `context` = "system" | "workspace" | "circle"
- `tenant_id` nullable (system-роли без тенанта)
- Один человек: `user@system` + `staff@workspace:A` + `owner@circle:family`
- При найме — новая запись в user_roles, НЕ новый user
- При увольнении — `is_active = false`, не delete
- `RolesService` (Redis-кешированный) + `@Roles()` декоратор + `RolesGuard`
- `JwtAuthGuard` зарегистрирован глобально как `APP_GUARD` в `app.module.ts`

## Stack
- Node 22, pnpm 9, Turborepo 2
- Backend: NestJS 10 + Prisma 6 + PostgreSQL 16 + Redis 7
- Web: Next.js 15 + Tailwind v4 + Zustand 5 + React Query 5
- Mobile: React Native + Expo SDK 52 + Expo Router 4 (НЕ запускался ни разу)
- Shared: `packages/shared` = types + Zod validation + constants
- TypeScript 5.7 strict всюду

## Дизайн-система
Обязательно читать `DESIGN.md`. Светлая "скетчбук" тема (`#fdffda` фон), Epilogue + Plus Jakarta Sans, primary `#c61a1e`, secondary `#326a8b`, НЕТ 1px бордеров, асимметрия, paper texture, glassmorphism.

## Текущий статус (2026-04-08)
- Phase 1-5 backend ✅ DONE (закоммичено и запушено)
- Phase 6 web UI ✅ IN PROGRESS: `/circles` = "Моё окружение" готов
- 3 тестовых аккаунта: tester1/2/3, пароль Test1234!
- API: localhost:3001, Web: localhost:3000
- **GitHub:** https://github.com/Dilergar/SuperApp6
- **Docker Hub:** Dilergar
