# SuperApp6

SuperApp6 — одно приложение, один аккаунт, всё что нужно. Суперапп для Казахстана (аналог WeChat).

## Структура проекта

```
SuperApp6/                       # Монорепо (pnpm + Turborepo)
├── apps/
│   ├── api/                     # NestJS бэкенд (модульный монолит)
│   │   ├── src/
│   │   │   ├── core/            # Auth, Users — всегда загружены
│   │   │   │   ├── auth/        # Регистрация, логин, JWT, refresh tokens
│   │   │   │   └── users/       # Профиль, сессии, настройки
│   │   │   ├── modules/         # Функциональные модули (добавляются со временем)
│   │   │   │   ├── circles/     # Окружение — контакты с ролями (жена, мама, друг)
│   │   │   │   ├── tasks/       # Задачи, подзадачи, назначение, коины
│   │   │   │   └── calendar/    # Календарь, интеграция Google, шаринг
│   │   │   └── shared/          # Инфраструктура: Database, Redis, EventBus, Guards
│   │   └── prisma/              # Схема базы данных
│   ├── mobile/                  # React Native + Expo (iOS + Android)
│   │   ├── app/                 # Expo Router (файловая маршрутизация)
│   │   │   ├── (auth)/          # Логин, регистрация
│   │   │   └── (app)/           # Dashboard, Tasks, Calendar, Circles, Profile
│   │   └── src/                 # Stores, API client, hooks
│   └── web/                     # Next.js 15 (веб-версия)
│       └── src/app/             # App Router + Tailwind CSS v4
├── packages/
│   └── shared/                  # Общие типы, Zod-валидация, утилиты
│       └── src/
│           ├── types/           # User, Auth, Task, Calendar, Circle, Workspace
│           ├── validation/      # Zod-схемы для всех DTO
│           ├── utils/           # phone.ts (нормализация), date.ts (относительное время)
│           └── constants/       # Роли, права, реестр модулей
├── docker-compose.yml           # PostgreSQL 16 + Redis 7
└── CLAUDE.md                    # Этот файл
```

## Архитектура

### Модульный монолит
Каждый сервис — изолированный NestJS модуль. Модули общаются через **EventBus**, не через прямой импорт. Любой модуль можно вытащить в микросервис позже без переписывания.

### Ключевые паттерны
- **EventBus**: task.created → calendar автоматически создаёт событие; task.completed → коины начисляются
- **@superapp/shared**: все типы и валидация в одном пакете, используется API + mobile + web
- **JWT auth**: access token (15 мин) + refresh token (30 дн), ротация при обновлении
- **Prisma ORM**: типобезопасные запросы, автогенерация TypeScript типов из схемы БД
- **Redis**: кэш профилей (5 мин), управление сессиями, будущий pub/sub для реалтайма
- **Zustand + React Query**: стейт-менеджмент (auth) + серверные данные (задачи, события)

### Безопасность
- Пароли: bcrypt (12 раундов)
- Refresh tokens: хешируются перед сохранением в БД, ротируются при каждом refresh
- Rate limiting: 10 req/sec short, 50 req/10sec medium, 200 req/min long
- CORS: ограничен списком доменов
- Валидация: Zod на входе каждого контроллера, whitelist на NestJS уровне

## Команды

```bash
# 1. Запустить инфраструктуру (PostgreSQL + Redis)
docker compose up -d

# 2. Установить зависимости
pnpm install

# 3. Сгенерировать Prisma клиент и создать таблицы
cd apps/api && pnpm db:generate && pnpm db:push

# 4. Запустить все приложения одновременно
pnpm dev

# Запустить отдельно:
cd apps/api && pnpm dev      # API → http://localhost:3001
cd apps/web && pnpm dev      # Web → http://localhost:3000
cd apps/mobile && pnpm dev   # Expo dev server

# Swagger API документация (только dev):
# http://localhost:3001/api/docs

# Prisma Studio (UI для БД):
cd apps/api && pnpm db:studio
```

## Как добавить новый модуль (сервис)

1. Создать папку `apps/api/src/modules/<name>/`
2. Создать файлы: `<name>.module.ts`, `<name>.service.ts`, `<name>.controller.ts`
3. (опционально) `<name>.events.ts` для подписки на события других модулей
4. Добавить Prisma модели в `apps/api/prisma/schema.prisma`
5. Добавить типы в `packages/shared/src/types/<name>.ts`
6. Добавить валидацию в `packages/shared/src/validation/<name>.ts`
7. Зарегистрировать модуль в `apps/api/src/app.module.ts`
8. Добавить определение модуля в `packages/shared/src/constants/modules.ts`
9. Добавить экран в `apps/mobile/app/(app)/<name>.tsx`
10. Добавить экспорт в `packages/shared/src/index.ts`

## API Endpoints (MVP)

### Auth (`/api/auth/`)
- `POST /register` — регистрация (phone, password, firstName)
- `POST /login` — вход (phone, password) → tokens
- `POST /refresh` — обновить токены
- `POST /logout` — выход (отзыв refresh token)
- `POST /logout-all` — выход со всех устройств

### Users (`/api/users/`)
- `GET /me` — профиль текущего пользователя
- `PATCH /me` — обновить профиль
- `GET /me/sessions` — активные сессии

### Circles (`/api/circles/`)
- `GET /` — все окружения пользователя
- `POST /` — создать окружение
- `GET /contacts` — все контакты из всех окружений
- `GET /:id` — окружение с участниками
- `POST /:id/members` — добавить участника
- `PATCH /members/:id` — обновить роль/имя
- `DELETE /members/:id` — удалить участника
- `DELETE /:id` — удалить окружение

### Tasks (`/api/tasks/`)
- `GET /` — список задач (фильтры: status, priority, assignee, search, pagination)
- `POST /` — создать задачу
- `GET /:id` — задача с подзадачами
- `PATCH /:id` — обновить задачу
- `DELETE /:id` — удалить задачу
- `GET /:id/comments` — комментарии
- `POST /:id/comments` — добавить комментарий

### Calendar (`/api/calendar/`)
- `GET /events?from=...&to=...` — события за период
- `POST /events` — создать событие
- `PATCH /events/:id` — обновить
- `DELETE /events/:id` — удалить
- `GET /shares` — кому расшарен календарь
- `POST /shares` — расшарить
- `DELETE /shares/:userId` — убрать доступ

## Стек технологий

| Слой | Технология | Версия |
|------|-----------|--------|
| Runtime | Node.js | 22.x |
| Package Manager | pnpm | 9.x |
| Monorepo | Turborepo | 2.x |
| Backend | NestJS | 10.x |
| ORM | Prisma | 6.x |
| Database | PostgreSQL | 16 |
| Cache | Redis | 7 |
| Mobile | React Native + Expo | 0.76 / SDK 52 |
| Mobile Router | Expo Router | 4.x |
| Web | Next.js | 15.x |
| CSS | Tailwind CSS | 4.x |
| State | Zustand | 5.x |
| Data Fetching | TanStack React Query | 5.x |
| Validation | Zod | 3.x |
| Language | TypeScript | 5.7 |

## Переменные окружения

Файл `apps/api/.env`:
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string
- `JWT_SECRET` — секрет для JWT подписи (менять в проде!)
- `JWT_EXPIRES_IN` — время жизни access token (default: 15m)
- `JWT_REFRESH_EXPIRES_IN` — время жизни refresh token (default: 30d)
- `PORT` — порт API (default: 3001)
- `NODE_ENV` — окружение (development/production)
