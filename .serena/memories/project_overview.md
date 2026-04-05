# SuperApp6 — Project Overview

SuperApp6 — WeChat-like super-app for Kazakhstan. Монорепо pnpm + Turborepo.

## Архитектура: модульный монолит
- NestJS API (`apps/api`) — модули общаются через EventBus (RxJS), не через прямой импорт
- `core/` = всегда загружены (auth, users, roles)
- `modules/` = функциональные (circles, tasks, calendar) — добавляются со временем
- `shared/` = инфраструктура (database, redis, events, guards, decorators)
- Каждый модуль можно вытащить в микросервис без переписывания

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
- Shared: `packages/shared` = types + Zod validation + constants (roles, modules)
- TypeScript 5.7 strict всюду

## Дизайн-система
Обязательно читать `DESIGN.md`. Ключевое: светлая "скетчбук" тема (`#fdffda` фон), Epilogue + Plus Jakarta Sans, primary `#c61a1e`, secondary `#326a8b`, НЕТ 1px бордеров, асимметрия, paper texture, glassmorphism для нав.
