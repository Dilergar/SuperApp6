# SuperApp6

**SuperApp6** — большая экосистема, закрывающая все жизненные задачи: по сути **«ERP для жизни»**. Один аккаунт, один `user_id` навсегда, десятки сервисов для совместной работы между близкими людьми. В будущем — отдельный раздел **SuperApp6 Business** для компаний. (Идея на стыке суперапп-подхода WeChat и ERP; рынок — Казахстан.)

Примеры сервисов экосистемы (их будут десятки):
- **Задачник** — задачи друг другу (напр. Мама ставит задачу Сыну), подзадачи, сроки, коины.
- **Календарь** — события + задачи из Задачника; шаринг (Сын создал «тренировка 19:00» и поделился с Мамой).
- Чат, Финансы, Jobs Marketplace и т.д. — все «между людьми».

### Circle — приложение-фундамент экосистемы

**Circle** (для пользователя — **«Моё окружение»**) — первый и главный сервис, фундамент, на котором стоят все остальные. Он даёт две вещи:
1. **Добавить человека с ролью как в жизни.** Муж в жизни → добавляешь как «Муж»; коллега → «Коллега». Ровно одна роль на сторону, она же подпись на карточке.
2. **Сгруппировать** людей в свои Группы («Семья», «Родственники», «Коллеги»).

Благодаря Circle любой другой сервис SuperApp6 умеет работать «между людьми»: ставить задачи друг другу, шэрить календари, делиться внутри Группы. Видимость данных карточки тоже настраивается по Группам. Подробности модели — раздел «Окружение (Social Graph)» ниже.

## Дизайн-система

**ОБЯЗАТЕЛЬНО** читать `DESIGN.md` перед созданием/редактированием любого UI-компонента (web + mobile).

Ключевое:
- Светлая тема "скетчбук" — фон `#fdffda` (тёплая бумага), НЕ тёмная тема
- Шрифты: **Epilogue** (заголовки), **Plus Jakarta Sans** (текст)
- Цвета: primary `#c61a1e` (восковой красный), secondary `#326a8b` (голубой карандаш)
- **Запрещено:** 1px бордеры, идеально ровные формы, серые тени, тесная компоновка
- Разделение через цвет фона (surface layers), не через линии
- Асимметрия, текстура бумаги, акварельные wash-эффекты, glassmorphism для навбаров

## Структура проекта

```
SuperApp6/                       # Монорепо (pnpm + Turborepo)
├── apps/
│   ├── api/                     # NestJS бэкенд (модульный монолит)
│   │   ├── src/
│   │   │   ├── core/            # Auth, Users, Roles — всегда загружены
│   │   │   │   ├── auth/        # Регистрация, логин, JWT, refresh tokens
│   │   │   │   ├── users/       # Профиль, сессии, настройки, cardVisibility
│   │   │   │   └── roles/       # Universal Identity: UserRole (user_id, role, context, tenant_id)
│   │   │   ├── modules/         # Функциональные модули (добавляются со временем)
│   │   │   │   ├── contacts/    # ✅ Бэкенд социального графа: ContactLink, приглашения, блоки (обслуживает Окружение)
│   │   │   │   ├── circles/     # ✅ Группы внутри Окружения (Circle + CircleMembership + cardVisibility)
│   │   │   │   ├── notifications/ # ✅ Cross-module лента уведомлений (@Global)
│   │   │   │   ├── tasks/       # ✅ Task Manager: роли (Постановщик/Исполнитель/Соисполнитель/Наблюдатель), Группы, приёмка, дедлайны/повторы, коины-намерение
│   │   │   │   ├── calendar/    # ✅ Календарь (Phase 1–3): события, повторы, напоминания, слой задач, участники+RSVP, шеринг, Smart Match, ресурсы+бронь, drag-and-drop планнер
│   │   │   │   ├── google-calendar/ # ✅ Phase 4: двусторонняя синхра с Google (OAuth + Calendar API, sync-токены, веб-хуки, задачи односторонне)
│   │   │   │   └── workspaces/  # ✅ B2B: организации, членство, приглашения, профиль орг (карточка+анкета+видимость по роли) (роль — в UserRole, @Global)
│   │   │   └── shared/          # Инфраструктура: Database (chokepoint-скоуп), Redis, EventBus, Guards, Interceptors, WorkspaceContext (ALS)
│   │   └── prisma/              # Схема базы данных
│   ├── mobile/                  # React Native + Expo (iOS + Android)
│   │   ├── app/                 # Expo Router (файловая маршрутизация)
│   │   │   ├── (auth)/          # Логин, регистрация
│   │   │   └── (app)/           # Dashboard, Tasks, Calendar, Circles, Profile
│   │   └── src/                 # Stores, API client, hooks
│   └── web/                     # Next.js 15 (веб-версия)
│       └── src/app/             # App Router + Tailwind CSS v4
│           ├── circles/         # ✅ "Моё окружение" + PersonCard.tsx (compact/full modes)
│           ├── calendar/        # ✅ Календарь (Phase 1–3): page.tsx (4 вида + панель-планнер + DnD), EventModal, social.tsx, resources-ui.tsx, TriagePanel.tsx, calendar-dnd.ts, calendar-lib.ts
│           ├── profile/         # ✅ Профиль: layout (сайдбар) + [section]/ роуты (/profile/<секция>)
│           ├── workspaces/      # ✅ Организации (B2B): [id]/ Главная орг + profile/ (6 секций) + members/; CompanyCard; панель на dashboard
│           ├── dashboard/       # Главная + панель «Организации»
│           ├── login/           # Авторизация
│           └── register/        # Регистрация
├── packages/
│   └── shared/                  # Общие типы, Zod-валидация, утилиты
│       └── src/
│           ├── types/           # user, auth, contact, circle, notification, task, calendar, workspace, common
│           ├── validation/      # Zod-схемы: auth, contact, circle, task, calendar, user, workspace
│           ├── utils/           # phone.ts (нормализация), date.ts (относительное время)
│           └── constants/       # roles, modules, contacts, card-visibility, notifications, tasks, calendar, workspaces
├── docker-compose.yml           # PostgreSQL 16 + Redis 7
└── CLAUDE.md                    # Этот файл
```

## Архитектура

### Модульный монолит
Каждый сервис — изолированный NestJS модуль. Модули общаются через **EventBus** (на Redis Streams — события доходят между инстансами), не через прямой импорт. Документированные исключения: `AuthService`→`ContactsService` (активация приглашений при регистрации) и `CirclesService`→`ContactsService` (рендер участников группы) — прямые вызовы внутри одного bounded-context.

### Universal Identity
Один `user_id` — навсегда. Роли не в users-таблице, а в отдельной `user_roles(user_id, role, context, tenant_id)`.
Один человек может быть:
- `user` в `system` (глобальная роль)
- `staff` в `workspace:restaurant-A`
- `guest` в `workspace:restaurant-B`
- `owner` в `circle:my-family`

При найме через Jobs Marketplace — не создаётся новый пользователь, просто добавляется запись в `user_roles`. При увольнении — `isActive = false`.

Файлы: `apps/api/src/core/roles/` (RolesService, RolesModule), `apps/api/src/shared/guards/roles.guard.ts`, `apps/api/src/shared/decorators/roles.decorator.ts`

### Окружение (Social Graph) — фундаментальный модуль

Это и есть **приложение-фундамент Circle** (см. «Circle — приложение-фундамент экосистемы» выше). На нём строятся Задачник, Календарь, Чат, Финансы, Jobs Marketplace — любой сервис, где нужно действие «между людьми» (поставить задачу, расшарить календарь). Поэтому модель здесь — несущая; менять её осторожно.

> **ВАЖНО:** Слово "Контакты" НЕ используется в UI и документации. Для пользователя всё — это **"Окружение"**. Бэкенд-модули `contacts/` и `circles/` — это внутренняя реализация.

**Окружение** — у каждого пользователя одно. Это плоский список всех людей с подтверждённой двусторонней связью; у каждого ровно одна роль на сторону. Группы (Семья, Родственники, Коллеги) — пользователь создаёт их сам; по Группам настраивается видимость карточки.

**Flow:** Ввести номер → выбрать свою роль и его роль → отправить приглашение → получатель принимает/отклоняет → оба видят друг друга в своих окружениях → каждый сам раскладывает по Группам.

**Ключевые сущности (Prisma):**
- `ContactLink` — подтверждённая связь между двумя пользователями. Отображается как "человек в окружении".
  - Канонический порядок: `userAId < userBId` (лексикографически), чтобы `@@unique([userAId, userBId])` работал независимо от того, кто инициировал.
  - **Одна роль на сторону** (асимметрично): `roleAForB` (роль, которую A дал B, напр. "Жена") и `roleBForA` (роль B для A, напр. "Муж"). Prisma-поля `roleAForB`/`roleBForA` через `@map("label_a_for_b")`/`@map("label_b_for_a")` (DB-колонки сохранены — данные не теряются при миграции). Роль показывается на карточке. **Нет** `relationshipType` и **нет** отдельных «меток» — это убрано как лишнее.
  - `initiatedBy`: user_id того, кто отправил приглашение (для аудита).
  - Удаление — двустороннее: удаление строки убирает связь для обоих.
- `ContactInvitation` — pending запрос на добавление в окружение.
  - `toUserId` nullable: `null` когда номер ещё не зарегистрирован в SuperApp6 (external invitation).
  - При регистрации нового пользователя: `AuthService.register` вызывает `ContactsService.activatePendingInvitationsForNewUser(userId, phone)` → все invitation с этим phone получают `toUserId = newUser.id` и приглашающий видит активацию через уведомление.
  - `proposedRoleForSender` / `proposedRoleForRecipient` (Prisma `@map` на старые `proposed_label_*` колонки) — инвайтер предлагает обе роли; получатель может переписать (`myRole`/`theirRole`) при accept.
  - Status: pending → accepted / rejected / cancelled / expired. TTL 30 дней (см. `CONTACT_LIMITS.invitationTtlDays`).
  - **Нет rejection reason** (решение product-а).
  - Отмена, повторная отправка (с cooldown 24ч), блокировка — поддерживаются.
- `ContactBlock` — односторонний блок (A блокирует B не означает, что B блокирует A).
- `Circle` — **Группа** внутри окружения владельца ("Семья", "Родственники", "Коллеги"), которую он создаёт и называет сам. Несёт `cardVisibility` (JSONB) — что видят люди из этой Группы. У каждого пользователя свои Группы.
- `CircleMembership` — M2M между Circle и ContactLink (ручное членство). Один и тот же ContactLink может лежать в Группах обеих сторон независимо.

**Карточка контакта (card visibility) — видимость ПО ГРУППАМ:**
- Всегда видны: `firstName`, `lastName`, `phone`, `role` (роль, которую дала противоположная сторона).
- Видимость остальных полей (dateOfBirth, age, onlineStatus, maritalStatus, city, bio, email, socialLinks, extras) настраивается **на каждую Группу** (`Circle.cardVisibility` JSONB). Зритель в нескольких Группах владельца → **объединение** (`mergeVisibilities`: поле видно, если разрешено хоть в одной его Группе). Зритель ни в одной Группе → **видимость по умолчанию** = `users.card_visibility` (одиночная `CardVisibility`).
- Резолв при просмотре: `ContactsService.resolveVisibilityForViewer(ownerId, link.memberships, owner.card_visibility)` — Группы владельца тянутся одним `findMany` в `listContacts` (без N+1).
- `@superapp/shared/constants/card-visibility.ts`: `DEFAULT_CARD_VISIBILITY`, `resolveCardVisibility`, `mergeVisibilities`. `cardVisibilityObjectSchema` вынесен в `validation/card-visibility.ts` (используется и для `/users/me`, и для `/circles`).
- Профиль `/profile`: вкладка **«Моя карточка»** — read-only `PersonCard` + селектор «как видит Группа X / По умолчанию»; вкладка **«Моя Анкета»** — данные + тумблеры «Видимость по умолчанию». Видимость каждой Группы редактируется на странице **«Моё окружение»** (выбрал Группу → редактор флагов, debounced `PATCH /circles/:id { cardVisibility }`).
- Отвергнуто (не возвращаться): «6 авто-категорий relationshipType» и «системная папка Незнакомец?». Та же форма политики «сегмент → видимость» переносится на B2B/маркетплейс через Universal Identity (ключ позже = `UserRole.role`; рассылки — через существующий NotificationsModule).

**Notifications** — отдельный модуль, cross-cutting concern для всех сервисов:
- `Notification` — generic строка (userId, type, title, body, payload JSON, actionUrl, readAt).
- Типы — dot-namespaced (`contact.invitation.received`, `task.assigned`, `calendar.event.reminder` и т.д.), реестр в `@superapp/shared/constants/notifications.ts` → `NOTIFICATION_REGISTRY` с шаблонами title/body/icon и флагом pushByDefault.
- ContactsService эмитит события на EventBus (`contact.invitation.sent`, `contact.invitation.accepted` и т.д.), NotificationsEventsListener подписывается и создаёт строки в таблице. Так же смогут подписываться PushService, AnalyticsService в будущем.

### Ключевые паттерны
- **EventBus**: на Redis Streams + consumer group (`shared/events/event-bus.service.ts`) — событие пересекает инстансы и обрабатывается ровно одним (competing consumers); XAUTOCLAIM подбирает «зависшие» после падения инстанса. `emit/on/onPattern` поверх локального RxJS Subject. contact.* → NotificationsListener создаёт уведомления; calendar.event.reminder → уведомления (календарь читает задачи как **виртуальный слой**, НЕ копирует события)
- **@superapp/shared**: все типы и валидация в одном пакете, используется API + mobile + web
- **JWT auth**: access token (15 мин) + refresh token (30 дн), ротация при обновлении, system role в payload
- **Prisma ORM**: типобезопасные запросы, автогенерация TypeScript типов из схемы БД
- **Redis**: кэш профилей (5 мин, инвалидируется при изменении контактов/ролей/групп), сессии, шина событий (Streams), общее хранилище счётчиков rate-limit, distributed-lock для cron (`RedisService.withLock`)
- **Zustand + React Query**: стейт-менеджмент (auth) + серверные данные (задачи, события)
- **Web auth**: `useAuthStore` (`apps/web/src/lib/stores/auth.ts`) — единственный источник правды, токены в localStorage но только через store. Защищённые страницы используют `useRequireAuth` hook (`apps/web/src/lib/hooks/useRequireAuth.ts`), не копипастят логику. Детали — в Serena memory `web_auth_pattern`.

### Безопасность
- Пароли: bcrypt (12 раундов)
- Refresh tokens: SHA-256 хеш в БД (детерминированный — ищется по равенству на unique-колонке), ротируются при каждом refresh
- Rate limiting: глобальный `ThrottlerGuard` (APP_GUARD) + Redis-хранилище счётчиков (общее на все инстансы): 10/сек short, 50/10сек medium, 200/мин long
- CORS: ограничен списком доменов
- Валидация: Zod на входе каждого контроллера (ZodError → 400 через глобальный `ZodExceptionFilter`, APP_FILTER — `shared/filters/`), whitelist на NestJS уровне

## Команды

> **ВАЖНО (Windows):** tsc НЕ работает из Git Bash на Windows — команды сборки нужно запускать через PowerShell.
> Используй: `powershell -Command "cd path; command"`
> PowerShell ExecutionPolicy уже настроен: `RemoteSigned`

```bash
# 1. Запустить инфраструктуру (PostgreSQL + Redis)
docker compose up -d

# 2. Установить зависимости
pnpm install

# 3. Собрать shared пакет (ОБЯЗАТЕЛЬНО перед запуском API)
cd packages/shared && pnpm build   # или: powershell -Command "cd packages/shared; npx tsc"

# 4. Сгенерировать Prisma клиент и применить миграции
cd apps/api && pnpm db:generate && npx prisma migrate deploy
#    Изменил схему в разработке → pnpm db:migrate (prisma migrate dev: создаёт+применяет миграцию).
#    БД под управлением prisma migrate (история в prisma/migrations/, baseline 0_init).
#    ВАЖНО: db push больше НЕ использовать — разойдётся с миграциями.

# 5. Запустить все приложения одновременно
pnpm dev

# Запустить отдельно (через PowerShell на Windows):
powershell -Command "cd apps/api; npx nest start --watch"   # API → http://localhost:3001
powershell -Command "cd apps/web; npx next dev"              # Web → http://localhost:3000
cd apps/mobile && pnpm dev                                   # Expo dev server

# Swagger API документация (только dev):
# http://localhost:3001/api/docs

# Prisma Studio (UI для БД):
cd apps/api && pnpm db:studio
```

## Статус разработки (апрель 2026)

### Что работает ✅
- Docker: PostgreSQL 16 (порт 5432) + Redis 7 (порт 6379)
- NestJS API: запущен на порту 3001, Swagger на /api/docs
- Next.js Web: запущен на порту 3000
- Auth: register (phone, password, firstName, **lastName?, dateOfBirth?**), login, refresh, logout — работает
- `GET /api/users/me` — возвращает профиль с ролями, **dateOfBirth, cardVisibility (одиночная, видимость по умолчанию / без группы), contactsCount, circlesCount, workspacesCount**
- Universal Identity: таблица `user_roles(user_id, role, context, tenant_id)`, RolesService, @Roles guard
- JwtAuthGuard зарегистрирован глобально как APP_GUARD
- GitHub репозиторий: `Dilergar/SuperApp6`
- **Web auth foundation:** `useAuthStore` (Zustand) + `useRequireAuth` hook + авто-гидратация в `Providers`. Страницы login/register/dashboard используют store
- **Форма /register** принимает lastName + dateOfBirth (оба опциональны)
- **@superapp/shared** полностью переписан под новый social graph: types, validation, constants
- **NotificationsModule** (`@Global()`): `notify(userId, type, payload)` с шаблонами из `NOTIFICATION_REGISTRY`, cursor-пагинация, mark-read. `NotificationsEventsListener` подписан на EventBus: `contact.*`, `task.*`, `calendar.*`, `workspace.*`
- **ContactsModule** (`@Global()`): бэкенд социального графа — invitation lifecycle (send/accept/reject/cancel/resend), каноническое упорядочение `userA<userB`, throttling через `CONTACT_LIMITS`, блокировки, bilateral delete, me/them mapping с `resolveCardVisibilityForRole` (видимость по роли связи). `activatePendingInvitationsForNewUser` вызывается из `AuthService.register`
- **CirclesModule**: CRUD папок внутри окружения (Circle), `addMember`/`removeMember` через CircleMembership M2M, reorder, лимиты из `CONTACT_LIMITS`
- **TasksModule** ✅: Task Manager с ролями (Bitrix24): Постановщик=creator + Исполнитель/Соисполнитель/Наблюдатель в `TaskParticipant` (одна роль на пользователя, своё под-состояние `pending→submitted→accepted/returned`). Назначение из окружения (`assertInEnvironment`), на себя или на **Группу** (`assignedCircleId` → участники-снимок становятся Соисполнителями, в поле Исполнитель — имя группы). Приёмка пер-участник: задача `done`, когда **все** приняты; самозадача — сразу `done` без проверки. Коины — **намерение** (snapshot `rewardCoins`, баланс не двигается; настоящий кошелёк придёт с Магазином). Тайм-менеджер: `dueDate`+`allDay`, `reminderAt`, повторы (`recurrenceRule`; следующий экземпляр спавнится при завершении). `TasksCron` (Redis-лок) шлёт напоминания и сводку просрочек. События `task.*` → `NotificationsEventsListener`. Чат = `TaskComment` (все роли). **B2B-готово**: участники ссылаются на `userId`, контекст — `workspaceId` (воркспейс=tenant, НЕ смешиваем с личным окружением)
- **CalendarModule** ✅ (Phase 1+2): **Phase 1** — личный календарь, CRUD, **RRULE-повторы** (`rrule`.js; правка this/this_and_following/all через `exDates`+override-строки), **напоминания** (несколько на событие/участника, дефолт 24ч+30мин; очередь `CalendarEventReminder` + `CalendarCron`/Redis-лок → `calendar.event.reminder`), **виртуальный слой задач** (`TasksService.listForCalendar`, НЕ копирует; просрочка пиннится на «сегодня»), часовые пояса UTC→пояс зрителя. **Phase 2 (соц.)** — **участники + RSVP** (`EventParticipant`: одно общее событие без копий; pending/accepted/declined/tentative; приглашение человека/Группы из окружения; редактирует только создатель; пер-участник напоминания), **шеринг** (уровни none<busy<detailed; группа на `Circle.calendarVisibility` + персона на `CalendarShare.accessLevel`; резолв = MAX через `resolveAccessLevel`; per-event `visibility` inherit/busy/hidden), **просмотр чужих** как слои-люди (busy → «Занят», detailed → полно; участие важнее пассивной видимости), **Smart Match** (свободные окна среди давших ≥busy, «вслепую»). События `calendar.event.invited/rsvp/updated/cancelled`. **Phase 3 (продвинутое)** — **Ресурсы + модерируемая бронь** (`Resource`: владелец-человек, тип, `capacity`, кто бронирует; бронь = событие с `resourceId`+`resourceStatus`, модель Google/Outlook; чужая бронь → заявка владельцу, занятое (active ≥ capacity) → 409, своя → сразу; только разовые события), **интерактив**: панель-планнер слева + **drag-and-drop** (тащишь задачи на сетку → ставит срок; двигаешь/растягиваешь события) + диалог «это/серия» для повторов. События `calendar.resource.requested/confirmed/rejected`. CalDAV — Phase 4. Дизайн — Serena memory `project_calendar_module_design`
- **GoogleCalendarModule** ✅ (Phase 4): двусторонняя синхра с **Google Calendar** через **OAuth 2.0 + Google Calendar API** (не «чистый CalDAV» — так делают Bitrix24/Salesforce). Подключение «Войти через Google» (`access_type=offline`+`prompt=consent`, scope `calendar`), модель `GoogleConnection` (токены, выбранный календарь, syncToken, канал веб-хука). Движок: **инкрементальная синхра** (`events.list` + syncToken, 410→полный ресинк), **веб-хуки** `channels.watch` (прод, публичный HTTPS) + **поллинг/кнопка «Синхронизировать»** (фолбэк, `GoogleCalendarCron`/Redis-лок). Только **свои события** двусторонне с выбранным календарём (дефолт — отдельный «SuperApp6»); **задачи — односторонне** в «SuperApp6 · Задачи». Конфликты — last-write-wins (по времени); **удаления зеркалятся**; участники НЕ выгружаются гостями (RSVP внутри). Маппинг `CalendarEvent.googleEventId`↔Google id (идемпотентный upsert гасит эхо). `CalendarService` шлёт `google.push` на изменения → `GoogleEventsListener`. Креды — в `.env` (`GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`); без них модуль инертен. Apple/CalDAV и мгновенные веб-хуки в проде — дальше. Лимит MVP: пер-экземплярные исключения повторов синкаются на уровне master+EXDATE
- **WorkspacesModule** (`@Global()`) ✅: B2B-организации. CRUD + передача владения + выход; участники (роль из `UserRole`, должность/отдел в `WorkspaceMember`); приглашения по номеру (send/accept/reject/cancel, external-активация при регистрации). **Роль — единый источник `UserRole`** (`WorkspaceMember` БЕЗ поля role → нет рассинхрона). Один владелец + админы. Лимиты — `WORKSPACE_LIMITS`. Reuse `RolesService.hireUser/fireUser`. События `workspace.*` → уведомления. Зарезервирована системная роль `mystery_shopper` (будущий Jobs Marketplace «Тайный гость»). **Профиль организации** (Party-паттерн, зеркало личного `/profile`): поля `description/industry/city/website/contactEmail/contactPhone` + `cardVisibility` на `Workspace` (миграция `workspace_profile_fields`); `serializeWorkspace` отдаёт поля **по роли зрителя** — owner/admin видят всё и `cardVisibility` (для редактирования), сотрудники только включённые поля (остальные → null), сама `cardVisibility` сотрудникам не отдаётся; `tasksCount` через `_count`. `createWorkspace`/`acceptInvitation`/`transferOwnership` атомарны (транзакционный `setSoleWorkspaceRoleTx` + публичный `RolesService.invalidateUserCache`). Подписка — заглушка (без модели)
- **Chokepoint (изоляция B2B-данных)** ✅: `WorkspaceContextInterceptor` (APP_INTERCEPTOR) читает `X-Workspace-Id`, проверяет членство (fail-closed 403), кладёт активную организацию в `AsyncLocalStorage` (`WorkspaceContextService`). `DatabaseService` — Prisma-клиент через `$extends` (фабрика в `DatabaseModule`), авто-скоупит `workspaceId` на B2B-моделях (`Task`) когда контекст активен; иначе строгий no-op (личные/соц. потоки не затронуты). RLS не используется (app-layer, как Salesforce)
- **Интеграция auth**: при регистрации `AuthService.register` вызывает `ContactsService.activatePendingInvitationsForNewUser` и `WorkspacesService.activatePendingWorkspaceInvitationsForNewUser` → external приглашения (контакты и организации) получают `toUserId` → создаются уведомления
- **Web UI `/circles`** = "Моё окружение" — единая страница: список людей, панель приглашений (входящие+исходящие), чипы-Группы (фильтр; при выборе Группы — редактор её видимости), форма добавления по номеру телефона. **Нет отдельной страницы /contacts** — всё в одном месте.
- **Web UI `/tasks`** ✅ — список со смарт-фильтрами (Сегодня/Предстоящие/Просрочено/Мне поставили/Я поставил/На проверке/Все) + форма создания (Себе/Человеку/Группе, пикеры людей из окружения, дедлайн со временем или «весь день», напоминание, повтор, приоритет, награда с подсказкой «каждому по X»). Деталька `/tasks/[id]`: роли с пер-участник статусами, прогресс «N из M», кнопки Взять в работу / Сдать / Принять / Вернуть, чат задачи.
- **Web UI организация** ✅ — вход в организацию → **Главная организации** (`/workspaces/[id]`, зеркало `/dashboard`: шапка + сетка сервисов Сотрудники/Задачи/Календарь + статистика; «Профиль» — вкладка в навбаре, не сервис). **Профиль организации** (`/workspaces/[id]/profile/<секция>`, зеркало личного `/profile`): 6 секций — Карточка/Анкета/Статистика/Подписка/Настройки/Безопасность, сайдбар с гейтингом по роли (manage→owner/admin, security→owner). **Сотрудники** — отдельно в `/workspaces/[id]/members`. `CompanyCard` (compact/full) — карточка компании, у сотрудников показывается в «Организациях» (`WorkspacesPanel`).
- **`GET /api/users/lookup?phone=...`** — поиск пользователя по номеру (используется формой приглашения для показа имени)
- **PersonCard** (`apps/web/src/app/circles/PersonCard.tsx`) — карточка человека в стиле скетча: текстурная бумага (#F4F1E8), двойная рамка аватара, бейдж роли, мазки карандашами в углах, grid-сетка. Каждая карточка с уникальным наклоном.
- **Форма приглашения** — поиск по номеру (показывает имя), два RolePicker ("Я" / "Он(а)") с пресетами (Жена, Муж, Мама, Папа, Сын, Дочь, Семья, Родственник, Друг, Коллега, Одноклассник, Однокурсник, Клиент + Свой вариант)
- **InvitationCard** — единый компонент для входящих и исходящих приглашений (имя, телефон, роли "Я: / Имя:", дата истечения, кнопки)
- **Профиль `/profile`** — вложенные роуты App Router: `layout.tsx` (нав + сайдбар, активная секция через `usePathname`) + `[section]/page.tsx` (контент). Раздел живёт в URL (`/profile/<секция>`) → переживает обновление страницы, шарится ссылкой, работает кнопка «Назад». `/profile` → редирект на `/profile/card`. 7 секций: Моя карточка (PersonCard full + тогглы видимости), Моя Анкета (данные), Статистика, Мои роли, Подписка, Настройки (язык/часовой пояс/онлайн-статус), Безопасность (сессии + «Опасная зона»: удаление аккаунта)
- **PersonCard** (`apps/web/src/app/circles/PersonCard.tsx`) — два режима:
  - `compact` — карточка в grid окружения (имя, телефон, город, био, дата рождения, семейное положение, email, соц. сети, роль-бейдж, Группы)
  - `full` — большая карточка в профиле с тогглами приватности (ON/OFF затухание полей)
- **3 тестовых аккаунта**: tester1 (+77001234567), tester2 (+77012345678), tester3 (+77023456789) — пароль: Test1234!

### Безопасность
- JWT_SECRET обязателен — приложение не запускается без него
- Refresh token: SHA-256 (детерминированный хеш для поиска по равенству; bcrypt тут не годится — рандомная соль не даёт совпадения при lookup). Refresh-JWT несёт уникальный `jti` → два логина в одну секунду не дают коллизию на unique `session.token`
- Rate limiting: `ThrottlerGuard` зарегистрирован как APP_GUARD, счётчики в Redis (`RedisThrottlerStorage`, общие на инстансы). `@Throttle` на login/register (5/15мин) и приглашениях (10/мин) нацелен на сконфигурированный троттлер `long` (ключ `default` не существовал — был no-op). **Включается только в production** (`skipIf` по `NODE_ENV` в `app.module.ts`) — в dev выключен, чтобы частые логины при разработке не упирались в лимит
- XSS: Zod `.refine()` запрещает `<>` в именах, ролях, био, сообщениях
- Пароль: минимум 8 символов, заглавная + строчная + цифра + спецсимвол
- Приглашения: TTL 30 дней, resend cooldown 24ч. Cron'ы под Redis-локом (выполняет один инстанс): `ContactsCron` (ежечасно чистит приглашения), `NotificationsCron` (ежедневно удаляет уведомления старше `NOTIFICATION_LIMITS.retentionDays`), `TasksCron` (напоминания о дедлайнах каждые 10 мин + ежедневная сводка просрочек)
- Удаление аккаунта: `DELETE /users/me` (требует пароль) — мягкое удаление с **грейс-периодом 30 дней**. Ставит `deletionScheduledAt`, отзывает сессии, блокирует вход (`login` + `JwtStrategy`). Вход в течение 30 дней = авто-восстановление (`login` чистит метку). `AccountCron` (ежедневно, Redis-лок) по истечении грейса вызывает `anonymizeAccount`: PII стёрт, номер освобождён, `deletedAt` терминально. Регистрация на номер в грейсе → 409 с подсказкой «войдите, чтобы восстановить». Общие данные (задачи/воркспейсы) сохраняются. `ACCOUNT_GRACE_DAYS` в `users.service.ts`
- Миграции БД: под `prisma migrate` (baseline `0_init` в `prisma/migrations/`); `db push` заменён на `migrate dev`/`migrate deploy`
- Concurrent accept: P2002 handler предотвращает дубли ContactLink
- Strict Zod: `.strict()` на socialLinks и `cardVisibilityObjectSchema` (общий, `validation/card-visibility.ts`) — используется в `/users/me` и `/circles`; произвольные поля отклоняются
- Error Boundary (providers.tsx): ловит render-ошибки, показывает fallback с кнопкой перезагрузки
- Фронт типы импортируются из `@superapp/shared`, не дублируются

### Что ещё не протестировано
- Calendar Phase 1–3 — бэкенд проверен end-to-end (повторы, экземпляры, слой задач, участники+RSVP, шеринг busy/detailed, Smart Match, ресурсы: бронь→заявка→подтверждение→блок вместимости); веб `/calendar` и `/circles` компилируются и отдают 200, но визуально в браузере ещё не отсмотрены (включая drag-and-drop планнер)
- Calendar Phase 4 (Google-синхра) — код собран и типизируется, API стартует, роуты `/integrations/google/*` замаплены, `status`/`auth-url` корректны без кредов; **живой OAuth + двусторонняя синхра НЕ протестированы** — нужны `GOOGLE_CLIENT_ID/SECRET` (регистрация OAuth-приложения в Google Cloud) + реальный Google-аккаунт. Веб-хуки требуют публичного HTTPS (в локалке — поллинг/кнопка)
- Expo mobile app — не запускался

### MCP серверы
- **GitHub MCP**: подключён (файл `.mcp.json` в корне проекта, в `.gitignore`)
- **Serena MCP**: подключён (LSP-инструменты для навигации по коду) — см. раздел ниже
- ~~PostgreSQL MCP~~: удалён (пакет `@modelcontextprotocol/server-postgres` deprecated). Для работы с БД — Prisma Studio или `docker exec -it superapp6-db psql -U superapp -d superapp6`

## Serena MCP — обязательно использовать

**Serena** — MCP-сервер с IDE-возможностями через LSP. Подключён в `.mcp.json`, работает с project-путём `SuperApp6`. После перезапуска Claude Code появляются инструменты `mcp__serena__*`.

### Когда использовать Serena ВМЕСТО Read/Grep/Edit

- **Навигация по символам** → `find_symbol`, `get_symbols_overview` вместо `Read` всего файла
- **Поиск использований** → `find_referencing_symbols` вместо `Grep`
- **Правка функции/класса** → `replace_symbol_body`, `insert_after_symbol` вместо `Edit`
- **Обзор файла** → `get_symbols_overview` (outline) вместо чтения 300+ строк

### Когда оставлять Read/Edit

- Короткие файлы (<50 строк): конфиги, `.env`, `package.json`, markdown
- Файлы без символов: CSS, JSON, YAML
- Когда нужен контекст вокруг кода (комментарии, импорты)

### Serena Memory — обновлять как CLAUDE.md

У Serena есть собственная память проекта (`write_memory`, `read_memory`, `list_memories`). Она хранит контекст между сессиями **внутри репозитория** (папка `.serena/memories/`).

**ПРАВИЛО:** после любых значимых правок в архитектуре / API / моделях БД — обновлять:
1. `CLAUDE.md` — человекочитаемая документация проекта
2. **Serena memory** — через `mcp__serena__write_memory` (ключевые факты: структура модулей, соглашения, решения)
3. `~/.claude/.../memory/MEMORY.md` — персональная auto-memory Claude Code

Три уровня документации должны быть синхронизированы. Если меняется схема Prisma, добавляется модуль, меняется auth — обновить все три.

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
- `POST /register` — регистрация (phone, password, firstName, lastName?, dateOfBirth?)
- `POST /login` — вход (phone, password) → tokens
- `POST /refresh` — обновить токены
- `POST /logout` — выход (отзыв refresh token)
- `POST /logout-all` — выход со всех устройств

### Users (`/api/users/`)
- `GET /me` — профиль (все поля: bio, city, email, maritalStatus, socialLinks, onlineStatusMode, **cardVisibility** (одиночная, видимость по умолчанию), roles, counts, subscription)
- `PATCH /me` — обновить профиль (все поля + `cardVisibility` как одиночная `CardVisibility` + Zod-валидация через `updateProfileSchema`)
- `GET /me/sessions` — активные сессии
- `DELETE /me/sessions/:id` — завершить конкретную сессию
- `DELETE /me` — запланировать удаление аккаунта (требует пароль). Грейс-период 30 дней: вход блокируется, но логин в течение 30 дней восстанавливает аккаунт; по истечении `AccountCron` безвозвратно анонимизирует (PII стирается, номер освобождается). Задачи/комментарии/воркспейсы сохраняются
- `GET /lookup?phone=...` — поиск пользователя по номеру (для формы приглашения)

### Окружение — Social Graph (`/api/contacts/`) ✅
> UI: единая страница `/circles` = "Моё окружение". Бэкенд: два модуля contacts + circles.

**Люди (ContactLink):**
- `GET /contacts/` — все люди в моём окружении (`myRole`, `theirRole`, `myCircleIds`; видимость по Группам зрителя)
- `GET /contacts/:linkId` — карточка человека (с учётом видимости по Группам)
- `PATCH /contacts/:linkId` — обновить свою роль (`myRole`)
- `DELETE /contacts/:linkId` — удалить из окружения (bilateral)

**Приглашения:**
- `POST /contacts/invitations` — отправить приглашение (toPhone, proposedRoleForRecipient?, proposedRoleForSender?, message?)
- `GET /contacts/invitations/incoming` — входящие pending
- `GET /contacts/invitations/outgoing` — исходящие pending
- `POST /contacts/invitations/:id/accept` — принять
- `POST /contacts/invitations/:id/reject` — отклонить
- `POST /contacts/invitations/:id/cancel` — отменить (отправитель)
- `POST /contacts/invitations/:id/resend` — повторная отправка (cooldown 24ч)

**Блокировки:**
- `GET /contacts/blocks` — список моих блоков
- `POST /contacts/blocks` — заблокировать
- `DELETE /contacts/blocks/:userId` — разблокировать

### Группы внутри Окружения (`/api/circles/`) ✅
- `GET /circles/` — мои группы (с membersCount и `cardVisibility`)
- `POST /circles/` — создать группу (name, icon?, color?)
- `GET /circles/:id` — группа с участниками
- `PATCH /circles/:id` — обновить name/icon/color/sortOrder + **`cardVisibility`** (видимость группы)
- `DELETE /circles/:id` — удалить группу (связи между людьми сохраняются)
- `POST /circles/:id/members` — добавить человека в группу
- `DELETE /circles/:id/members/:linkId` — убрать из группы
- `POST /circles/reorder` — изменить порядок групп

### Notifications (`/api/notifications/`) ✅
- `GET /` — лента уведомлений (cursor pagination, возвращает unreadCount)
- `POST /mark-read` — отметить прочитанными (массив id или пусто = все)
- `DELETE /:id` — удалить уведомление

### Tasks (`/api/tasks/`) ✅
> Роли как в Bitrix24: **Постановщик** (creator) + **Исполнитель/Соисполнитель/Наблюдатель** (`TaskParticipant`, по одной роли на пользователя, своё под-состояние). Назначение — из окружения, на себя или на **Группу**. Приёмка пер-участник. Коины — пока намерение.
- `GET /` — список; смарт-листы `smartList` (today/upcoming/overdue/assigned_to_me/created_by_me/on_review) + фильтры status, priority, role, search, pagination
- `POST /` — создать (`executorId` | `assignedCircleId`, `coExecutorIds`, `observerIds`, `dueDate`+`allDay`, `reminderAt`, `recurrenceRule`, `coinReward`)
- `GET /:id` — задача с участниками, прогрессом и подзадачами
- `PATCH /:id` — обновить (поля; роли/награда — только Постановщик; `status`: in_progress/cancelled)
- `DELETE /:id` — удалить (только Постановщик)
- `POST /:id/submit` — сдать свою работу (самозадача → сразу «Готово»)
- `POST /:id/accept` — принять работу участника (Постановщик; body `{ participantUserId? }`)
- `POST /:id/return` — вернуть в работу (Постановщик; body `{ participantUserId? }`)
- `GET /:id/comments` — чат задачи
- `POST /:id/comments` — написать в чат (доступно всем ролям)

### Calendar (`/api/calendar/`) ✅
> Phase 1+2. Задачи — **виртуальный слой** (не копируются). Шеринг уровневый: Нет/Занят/Детально по Группам (`Circle.calendarVisibility`) и персонально (`CalendarShare.accessLevel`), резолв = MAX. Участники = одно общее событие + `EventParticipant` (без копий).
- `GET /events?from&to&layers=events,tasks&include=<userIds>` — раскрытые события (RRULE) + слой задач + overlay чужих календарей (busy→«Занят», detailed→полно). `{ items: CalendarItem[] }` (kind: event|task)
- `GET /events/:id` — детали с участниками (доступ: владелец/участник/detailed-зритель)
- `POST /events` — создать (… + `participantUserIds?`/`participantCircleId?`)
- `PATCH /events/:id` — обновить; серии: `editScope` (this|this_and_following|all) + `occurrenceStart` (только создатель)
- `DELETE /events/:id?editScope=&occurrenceStart=` — удалить событие/экземпляр
- `POST /events/:id/participants` — пригласить (человек/Группа) · `DELETE /events/:id/participants/:userId` — убрать/выйти
- `POST /events/:id/rsvp` — ответить (accepted|declined|tentative) · `POST /events/:id/reminders` — мои напоминания
- `GET /shares` · `POST /shares` (busy|detailed) · `DELETE /shares/:userId` — персональный доступ
- `GET /shared-with-me` — чьи календари мне доступны (для слоёв) · `POST /smart-match` — подбор общих свободных окон (среди давших ≥busy)

### Resources — бронь ресурсов (`/api/resources/`) ✅
> Phase 3. Ресурс = общая вещь (переговорка/машина) со своим расписанием; владелец — человек (`workspaceId` зарезервирован под B2B). Бронь = событие с `resourceId` (прикрепляется в форме события). Модерация: чужая бронь → заявка владельцу (мягко держит слот), занятое (active ≥ capacity) → 409, своя бронь владельца → сразу. Только разовые события.
- `GET /` — мои ресурсы + доступные мне для брони (`isOwner`, `canBook`)
- `POST /` — создать · `PATCH /:id` · `DELETE /:id` (владелец)
- `GET /:id/schedule?from&to` — расписание ресурса · `GET /requests` — входящие заявки на мои ресурсы
- `POST /bookings/:eventId/confirm` | `/reject` — подтвердить/отклонить (владелец)
> Перетаскивание в планнере переиспользует `PATCH /tasks/:id` (срок) и `PATCH /calendar/events/:id` (время/`editScope`).

### Google Calendar — синхра (`/api/integrations/google/`) ✅
> Phase 4. Двусторонняя синхра с Google (OAuth + Calendar API). Без `GOOGLE_*` в `.env` модуль инертен (`auth-url`→400). `callback`/`webhook` — `@Public()`.
- `GET /status` — статус (email, календарь, последняя синхра) · `GET /auth-url` — ссылка OAuth-согласия
- `GET /callback` (public) — обмен кода → токены → создание «SuperApp6»/«SuperApp6 · Задачи» → полная синхра → редирект в веб
- `GET /calendars` · `POST /select-calendar` (`__new__` = создать) — выбор календаря для синхры
- `POST /sync` — синхронизировать сейчас · `DELETE /` — отключить
- `POST /webhook` (public) — приёмник push-уведомлений Google (`channels.watch`)
> Синхра: свои события двусторонне; задачи односторонне; конфликты last-write-wins; удаления зеркалятся; участники не выгружаются. `CalendarService` эмитит `google.push` → `GoogleEventsListener`.

### Workspaces — B2B организации (`/api/workspaces/`) ✅
> Организация = арендатор (B2B). Личная жизнь = соц. граф (`workspaceId=null`), не организация. Роль участника — **единый источник** `UserRole(context=workspace, tenantId=workspaceId)`; `WorkspaceMember` хранит только должность/отдел. Один владелец + админы. Найм по номеру: приглашение → принятие (активация при регистрации, как в Окружении). Доступ — проверка членства/роли в сервисе (как у contacts/circles).
- `GET /` — мои организации (для переключателя; `myRole`, `membersCount` + видимые поля карточки по роли — для `CompanyCard` в «Организациях»)
- `POST /` — создать (создатель → `owner`)
- `GET /invitations/incoming` — мои входящие приглашения (карточки на dashboard)
- `POST /invitations/:invId/accept` | `/reject` — ответить
- `GET /:id` — организация (моя роль + поля профиля/карточки с видимостью по роли: owner/admin видят всё и `cardVisibility`, сотрудники — только включённые поля; `membersCount`, `tasksCount`)
- `PATCH /:id` — обновить (admin+): name/logo + поля профиля (description/industry/city/website/contactEmail/contactPhone) + `cardVisibility` (`updateWorkspaceProfileSchema`) · `DELETE /:id` — деактивировать (владелец)
- `POST /:id/transfer` — передать владение · `POST /:id/leave` — выйти (не владелец)
- `GET /:id/members` — сотрудники (роль из UserRole + должность/отдел)
- `PATCH /:id/members/:userId` — сменить роль/должность (admin+) · `DELETE /:id/members/:userId` — уволить (admin+)
- `POST /:id/invitations` — пригласить по номеру (admin+) · `GET /:id/invitations` — исходящие · `POST /:id/invitations/:invId/cancel` — отменить

**Chokepoint (авто-скоуп по организации):** заголовок `X-Workspace-Id` → `WorkspaceContextInterceptor` проверяет членство (fail-closed 403) и кладёт активную организацию в `AsyncLocalStorage`; расширенный Prisma-клиент (`DatabaseService` через `$extends`) авто-добавляет `workspaceId` к запросам B2B-моделей (сейчас `Task`). Без заголовка — личный режим (строгий no-op). RLS не используется (как у Salesforce — защита на уровне приложения).

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
- `WEB_URL` — базовый URL веб-приложения (для редиректа после OAuth; default `http://localhost:3000`)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` — OAuth Google Calendar (Phase 4). Пусто → интеграция выключена. Регистрация: Google Cloud Console → Calendar API → OAuth client (Web), redirect = `http://localhost:3001/api/integrations/google/callback`
- `GOOGLE_WEBHOOK_URL` — публичный HTTPS для мгновенных push-уведомлений (опционально; в локалке пусто → поллинг)
