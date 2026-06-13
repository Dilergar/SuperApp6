# SuperApp6

**SuperApp6** — экосистема **B2C + B2B**: «ERP для жизни и бизнеса». Один аккаунт, один `user_id` навсегда — и внутри **100+ сервисов** (целевой масштаб), закрывающих всё, чем человек пользуется в жизни и на работе: задачи, календарь, чат, финансы, магазин, найм, отзывы, оргструктура, умный дом… Рынок — Казахстан; идея на стыке суперапп-подхода WeChat/Kaspi и ERP (Salesforce/Odoo). B2B живёт в том же приложении как организации-арендаторы (workspace, заголовок `X-Workspace-Id`); в будущем — выделенный раздел **SuperApp6 Business**.

Уже работают: Окружение (Circle), Задачник, Календарь (+Google-синхра), Мессенджер, My Wish & Shop, Кошелёк-леджер, Организации (B2B), Сотрудники (B2B), Скины карточек, Процессы (B2B, нодовый канвас — Фаза 1). Все сервисы — «между людьми»: Мама ставит задачу Сыну, Сын шарит тренировку Маме, семья скидывается на подарок.

## Принципы платформы (обязательны для КАЖДОГО нового сервиса)

Сервисов будет 100+, их функции пересекаются и дополняют друг друга — поэтому общая функциональность живёт в **переиспользуемых платформенных движках**, а новый сервис = тонкий модуль + регистрации в движках.

**1. Сначала переиспользуй, потом пиши.** Карта готового (если движка не хватает — он РАСШИРЯЕТСЯ, а не копируется):

| Нужно сервису | Готовый движок |
|---|---|
| Права, шеринг, роли | `core/access` (ReBAC): тип ресурса в схеме + проекция рёбер + способности |
| Интерактивная карточка с кнопками (в чате и не только) | `core/rich-cards`: реестр рендер+действия, перепроверка прав на execute |
| Попасть в глобальный поиск | `core/search`: +1 провайдер — кросс-сервисный поиск «загорается» сам |
| Кнопка в ＋-меню / меню сообщения чата | `core/quick-actions`: +1 регистрация |
| Уведомления | `NotificationsModule` + тип в `NOTIFICATION_REGISTRY` |
| Деньги: оплата, заморозка, сделки | `wallet` (Ledger двойной записи + generic Escrow со своим `refType`) — только синхронно, в одной транзакции |
| Сайд-эффекты между модулями | EventBus (Redis Streams, at-most-once — деньги сюда НЕЛЬЗЯ) |
| B2B-изоляция данных | chokepoint `X-Workspace-Id` ИЛИ явное владение `ownerType+ownerId` + права |
| Проверка «человек доступен» | `ContactsService.assertReachable` — контекстный: личный режим = связь+блок; контекст организации = со-членство по командным ролям trainee+ («рабочий пропуск»; Подрядчик изолирован) |
| Выбор человека/группы в UI | `EntitySelector` (реестр типов в `lib/entities.ts`) |
| Показ человека в UI | `PersonChip`/`PersonAvatar` — см. принцип 2 |

**2. Человек в UI = одна из 5 карточек, ВЕЗДЕ.** `PersonCard` имеет **5 форм-факторов XS/S/M/L/XL** (XS — голый аватар; S — аватар+имя в строку; M — +роль, стандарт пикеров; L — ровные карточки для гридов 100+; XL — полная, с редкостью скина). Любой новый сервис показывает человека ТОЛЬКО через `PersonChip`/`PersonAvatar`, не голым текстом — это несущее продуктовое правило (видимость платных скинов карточек).

**3. Rich Card — где уместно.** Если у сущности нового сервиса есть статусы и действия (заказ, задача, событие, заявка, бронь…) — она обязана уметь рендериться рич-картой через `core/rich-cards`.

**4. AI-ready (видение → правило проектирования уже сейчас).** Почти в каждом сервисе будет профильный AI-ассистент (задачи своего домена), а на главном экране — **SuperAIAgent6**: главный агент, объединяющий и управляющий всеми сервисами и ассистентами. Целевой сценарий: голосовое «поставь задачу Диане, чтобы купила хлеб по дороге домой» → AI находит Диану через Circle (оба в окружении, оба в SuperApp6) и создаёт задачу. Архитектурная модель AI — **гибрид**: ЧТЕНИЕ данных агенту можно напрямую из БД, но СТРОГО через проверки `core/access` (та же видимость, что у самого пользователя — не больше); **ДЕЙСТВИЯ — только через сервисные API/способности** (всё денежное — без исключений). Следствие для каждого нового сервиса: каждая операция должна быть вызываема программно (тонкий контроллер + Zod + capability) — это и есть будущие AI-инструменты сервиса; «AI-инструмент» позже = регистрация в реестре, как rich-cards/quick-actions.

**5. Device-agnostic вход.** Веб, мобильное приложение и будущий **Терминал** — собственная железка ~60×90×10 мм (микрофон, динамик, дисплей) для быстрых голосовых команд AI — все равноправные клиенты ОДНОГО API (`/api/v1`). Плюс датчики (движение, температура и любые другие) для умного дома И бизнеса: будущий сервис-модуль «Умный дом/IoT» с реестром устройств; показания и управление отображаются внутри SuperApp6.

## Дорожная карта (порядок этапов)

1. **Сейчас: новые сервисы** на готовом веб-фундаменте (каждый — через грилл дизайна перед стройкой). ✅ Сделано: **Сотрудники (B2B)** — справочники Должность/Отдел/Филиал + назначения + лестница ролей со Стажёром/Подрядчиком (2026-06-11). Ближайшие кандидаты: **Финансы (семейный бюджет)** — продолжение кошелька и Circle; **Jobs Marketplace** — найм через Universal Identity (системная роль `mystery_shopper` и workspace-роль `contractor` зарезервированы); **Отзывы (B2B)** — агрегатор Kaspi/Google/2GIS (исследование готово — Serena `project_reviews_service`; Kaspi Merchant API — самый простой коннектор); **Додзё** — обучение по должности (статус назначения `training→certified` уже заложен); **Лента новостей (B2B)** — таргетинг по отделу/должности/филиалу (оси уже проецируются в `core/access`). ✅ Начат: **Процессы (нодовый канвас БП, n8n-модель)** — Фаза 1 построена (2026-06-13), дальше фазы 2–6 (одобрения+отделы queue+claim → триггеры+сервисные ноды+сейф кредов → AI-кластер → RAG → KZ-коннекторы; дизайн — Serena `project_process_engine`); «Структура организации» — на этом же канвасе (руководители отделов/филиалов добавятся тогда же). Список открыт.
2. **Mobile** — подготовка (блок 8 архревью: `packages/api-client`, push-пайплайн, design-tokens, upload) + переписать приложение.
3. **AI** — сервисные ассистенты + SuperAIAgent6 c голосом (принцип 4).
4. **Терминал + Умный дом/IoT** — железо проектируется после AI-софта (принцип 5).

Фоном, не блокируя этапы: хвост блока 7 архревью (прод-минимум) и web-гигиена.

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
│   │   │   │   ├── roles/       # Universal Identity: UserRole (user_id, role, context, tenant_id)
│   │   │   │   ├── access/      # ✅ Единый движок авторизации всех сервисов (ReBAC): отношения + правила + резолвер + проекция + кэш
│   │   │   │   ├── rich-cards/  # ✅ Переиспользуемый реестр интерактивных карточек (рендер+действия) для всех сервисов
│   │   │   │   ├── search/      # ✅ Единый движок поиска (Phase 6): индекс-витрина SearchDocument (FTS+trigram) + реестр провайдеров + проекция; потребитель — мессенджер
│   │   │   │   └── quick-actions/ # ✅ Реестр быстрых действий чата (Phase 7): сервисы регистрируют кнопки ＋-меню/меню-сообщения (Создать задачу/Событие/Напомнить)
│   │   │   ├── modules/         # Функциональные модули (добавляются со временем)
│   │   │   │   ├── contacts/    # ✅ Бэкенд социального графа: ContactLink, приглашения, блоки (обслуживает Окружение)
│   │   │   │   ├── circles/     # ✅ Группы внутри Окружения (Circle + CircleMembership + cardVisibility)
│   │   │   │   ├── notifications/ # ✅ Cross-module лента уведомлений (@Global)
│   │   │   │   ├── tasks/       # ✅ Task Manager: роли (Постановщик/Исполнитель/Соисполнитель/Наблюдатель), Группы, приёмка, дедлайны/повторы, коины-награды (реальный эскроу через wallet/)
│   │   │   │   ├── calendar/    # ✅ Календарь (Phase 1–3): события, повторы, напоминания, слой задач, участники+RSVP, шеринг, Smart Match, ресурсы+бронь, drag-and-drop планнер
│   │   │   │   ├── google-calendar/ # ✅ Phase 4: двусторонняя синхра с Google (OAuth + Calendar API, sync-токены, веб-хуки, задачи односторонне)
│   │   │   │   ├── workspaces/  # ✅ B2B: организации, членство, приглашения (найм всегда в Стажёра), профиль орг (карточка+анкета+видимость по роли) (роль — в UserRole, @Global)
│   │   │   │   ├── staff/       # ✅ Сотрудники (B2B): справочники Должность/Отдел(дерево)/Филиал + назначения (статус training/certified под Додзё), проекция осей в core/access
│   │   │   │   ├── wallet/      # ✅ Денежный реестр банк-грейда (не банк): типизированные счета (Account: user/issuance/…), двойная запись (Σ по валюте = 0), неизменяемый журнал LedgerTransfer, двухфазные переводы (заморозка→провести/отменить), масштаб валюты, обобщённый эскроу (EscrowAgreement+EscrowHold), без минусов на кошельках
│   │   │   │   ├── messenger/   # ✅ Мессенджер (Ф1–7): DM/группы/контекстные чаты (задача/заказ/событие), socket.io-gateway, presence, Mentions Hub, отложенные сообщения
│   │   │   │   ├── shop/        # ✅ My Wish & Shop (Ф2–9): витрины/лоты/заказы/краудфандинг/лимиты/вишлист, эскроу заказов, B2B-магазин
│   │   │   │   ├── card-skins/  # ✅ Скины карточки: CardSkin/CardSkinInstance, платформенная валюта, надевание дефолт+по группам
│   │   │   │   └── processes/   # ✅ Процессы (B2B, Фаза 1): нодовый движок БП — реестр нод (5-й платформенный), компилятор, token-движок, версии+pin, human.task→Задачник
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
│           ├── workspaces/      # ✅ Организации (B2B): [id]/ Главная орг + profile/ (6 секций) + members/ = сервис «Сотрудники» (вкладки Сотрудники|Должности|Отделы|Филиалы|Приглашения) + processes/ = сервис «Процессы» (список+Журнал, канвас-редактор @xyflow/react, карточка инстанса live); CompanyCard; панель на dashboard
│           ├── tasks/           # ✅ Задачи: список со смарт-фильтрами + [id] деталька со встроенным чатом
│           ├── shop/            # ✅ My Wish & Shop: витрины/лоты/заказы/краудфандинг/вишлист
│           ├── messenger/       # ✅ Мессенджер: двухпанельный UI, Rich Cards, presence, поиск, быстрые действия
│           ├── mentions/        # ✅ Лента «упоминания обо мне»
│           ├── dashboard/       # Главная + панель «Организации»
│           ├── login/           # Авторизация
│           └── register/        # Регистрация
├── packages/
│   └── shared/                  # Общие типы, Zod-валидация, утилиты
│       └── src/
│           ├── types/           # по доменам: user, auth, contact, circle, notification, task, calendar, workspace, wallet, shop, messenger, presence, mention, rich-card, quick-action, scheduled-message, search, card-skin, google, common
│           ├── validation/      # Zod-схемы тех же доменов
│           ├── utils/           # phone.ts (нормализация), date.ts (относительное время)
│           └── constants/       # roles, modules, contacts, card-visibility, notifications, tasks, calendar, workspaces, presence, mention, search и др.
├── docker-compose.yml           # PostgreSQL 16 + Redis 7
└── CLAUDE.md                    # Этот файл
```

## Архитектура

### Модульный монолит
Каждый сервис — изолированный NestJS модуль. Связи между модулями — двух видов:

**1. Синхронные вызовы (прямая инъекция сервисов)** — там, где нужна атомарность (деньги в одной `$transaction`) или консистентное чтение. **Карта фактических рёбер (новое ребро → добавить сюда):**
- `AuthService` → `ContactsService`, `WorkspacesService` — активация external-приглашений при регистрации
- `CirclesService` → `ContactsService` — рендер участников группы
- `TasksService` → `EscrowService` (эскроу награды в одной транзакции), → `MessengerService` (синхронная проекция участников чата задачи), → `'ShopService'` (ModuleRef-токен: синхронный settlement заказа «с задачей» при завершении fulfilment-задачи) и → `'ProcessesService'` (ModuleRef-токен: при полном принятии задачи-шага — `onTaskCompleted`; при отмене задачи-шага — `onTaskCancelled`→процесс в error; шина `task.completed`/`task.cancelled`/`task.deleted` + крон-сверка wait-шагов — идемпотентные подстраховки от потерянного сигнала)
- `ProcessEngineService` → `TasksService.createTask` (нода «Задача человеку» создаёт настоящую задачу; `skipEnvironmentChecks` — членство движок проверил сам) и → `NotificationsService` напрямую (нода «Уведомить», итоги процесса)
- `CalendarService` → `TasksService.listForCalendar` (виртуальный слой задач)
- `ShopService` → `TasksService` + `CalendarService` + `EscrowService` (исполнение заказа) — самый связанный модуль
- `CardSkinsService` → `LedgerService` (покупка скина)
- `WorkspacesService` → `StaffService` — ростер с назначениями (`getAssignmentsByUser`), каскад назначений при увольнении/выходе, назначение «с порога» при принятии найма (`createAssignmentTx` в одной транзакции с членством+ролью)
- `MessengerService`/`PresenceService`/`TasksService`/`CalendarService`/`ShopService` → `ContactsService.assertReachable` — единый **контекстный** гейт всех действий «между людьми»: личный режим = «связь есть + нет блока в обе стороны»; в контексте организации (`X-Workspace-Id` в ALS) = со-членство в активном воркспейсе по **командным ролям** (trainee и выше; «рабочий пропуск», Slack/Bitrix24-модель — личное окружение не требуется, личные блоки рабочие артефакты не гасят; DM передаёт `alwaysCheckBlocks` — личка уважает блок и на работе). **«Подрядчик» (contractor) изолирован**: не инициирует через пропуск и не достижим через него — его работа течёт через явные гранты задач/чатов будущих сервисов (Тайный гость/UGC); `MentionsService`/`ScheduledMessageService` → `NotificationsService` напрямую
- Циклы закрыты ленивыми ModuleRef-токенами-строками: `'CalendarService'` (берёт PresenceService), `'MessengerService'` (берёт core/rich-cards) — при переименовании сервисов эти строки ломаются молча, проверять
- Messenger и его листенеры читают чужие таблицы напрямую (`task`/`order`/`calendarEvent`), `core/quick-actions` читает `chat` — для монолита допустимо; это carve-out map на случай будущего выделения сервисов

**2. EventBus (Redis Streams)** — для сайд-эффектов между модулями: уведомления, системные плашки чатов, google-sync, подстраховка проекций access. Семантика — **at-most-once** для хэндлеров (ack до выполнения) → **денежные/обязательные операции на шину не класть, только синхронно**. Соблюдено везде: задачи — эскроу в одной транзакции; заказы «с задачей» — синхронный вызов `ShopService.onFulfillmentDone` при завершении задачи, шина-листенер и sweep `settleCompletedFulfilments` в ShopCron — идемпотентные подстраховки.

### Universal Identity
Один `user_id` — навсегда. Роли не в users-таблице, а в отдельной `user_roles(user_id, role, context, tenant_id)`.
Один человек может быть:
- `user` в `system` (глобальная роль)
- `staff` в `workspace:restaurant-A`
- `contractor` в `workspace:restaurant-B` (внешний исполнитель, Коллаб-модель)
- `owner` в `circle:my-family`

**Лестница workspace-ролей** (одна роль на организацию, `WORKSPACE_ROLE_RANK` в shared): `contractor` < `trainee` (Стажёр) < `staff` (Сотрудник) < `manager` < `admin` < `owner`. Найм ВСЕГДА в `trainee` (приглашение не несёт выбора роли); повышение вручную (позже — бизнес-процессами/Додзё). Админа назначает/снимает только Владелец; админ управляет ролями до Менеджера и не трогает других админов. `contractor` вручную не назначается — только программно сервисами (Тайный гость/UGC); пока это роль без прав и доступов.

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
- Валидация: Zod на входе каждого контроллера; ВСЕ ошибки (ZodError → 400 с полями, HttpException, Prisma P2002/P2025 → 409/404, прочее → 500+лог) — в едином конверте `{success:false, statusCode, message, errors?}` через глобальный `AllExceptionsFilter` (APP_FILTER, `shared/filters/`); whitelist на NestJS уровне

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

## Статус разработки (июнь 2026)

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
- **TasksModule** ✅: Task Manager с ролями (Bitrix24): Постановщик=creator + Исполнитель/Соисполнитель/Наблюдатель в `TaskParticipant` (одна роль на пользователя, своё под-состояние `pending→submitted→accepted/returned`). Назначение из окружения (`assertInEnvironment`; в контексте организации — любому сотруднику по со-членству, «рабочий пропуск»), на себя или на **Группу** (`assignedCircleId` → участники-снимок становятся Соисполнителями, в поле Исполнитель — имя группы). Приёмка пер-участник: задача `done`, когда **все** приняты; самозадача — сразу `done` без проверки. Коины — **реальный эскроу** через WalletModule: заморозка при создании задачи с наградой, выплата исполнителю при приёмке, реверс/рефанд при возврате/отмене (snapshot `rewardCoins` остаётся для отображения). Тайм-менеджер: `dueDate`+`allDay`, `reminderAt`, повторы (`recurrenceRule`; следующий экземпляр спавнится при завершении). `TasksCron` (Redis-лок) шлёт напоминания и сводку просрочек. События `task.*` → `NotificationsEventsListener`. Чат задачи = контекстный чат мессенджера (`TaskComment` удалён). **B2B-готово**: участники ссылаются на `userId`, контекст — `workspaceId` (воркспейс=tenant, НЕ смешиваем с личным окружением)
- **CalendarModule** ✅ (Phase 1+2): **Phase 1** — личный календарь, CRUD, **RRULE-повторы** (`rrule`.js; правка this/this_and_following/all через `exDates`+override-строки), **напоминания** (несколько на событие/участника, дефолт 24ч+30мин; очередь `CalendarEventReminder` + `CalendarCron`/Redis-лок → `calendar.event.reminder`), **виртуальный слой задач** (`TasksService.listForCalendar`, НЕ копирует; просрочка пиннится на «сегодня»), часовые пояса UTC→пояс зрителя. **Phase 2 (соц.)** — **участники + RSVP** (`EventParticipant`: одно общее событие без копий; pending/accepted/declined/tentative; приглашение человека/Группы из окружения; редактирует только создатель; пер-участник напоминания), **шеринг** (уровни none<busy<detailed; группа на `Circle.calendarVisibility` (проецируется в движок) + персональный шеринг (tuples); резолв через движок `core/access` (N+1 наложения устранён, `CalendarShare` удалена); per-event `visibility` inherit/busy/hidden), **просмотр чужих** как слои-люди (busy → «Занят», detailed → полно; участие важнее пассивной видимости), **Smart Match** (свободные окна среди давших ≥busy, «вслепую»). События `calendar.event.invited/rsvp/updated/cancelled`. **Phase 3 (продвинутое)** — **Ресурсы + модерируемая бронь** (`Resource`: владелец-человек, тип, `capacity`, кто бронирует; бронь = событие с `resourceId`+`resourceStatus`, модель Google/Outlook; чужая бронь → заявка владельцу, занятое (active ≥ capacity) → 409, своя → сразу; только разовые события), **интерактив**: панель-планнер слева + **drag-and-drop** (тащишь задачи на сетку → ставит срок; двигаешь/растягиваешь события) + диалог «это/серия» для повторов. События `calendar.resource.requested/confirmed/rejected`. CalDAV — Phase 4. Дизайн — Serena memory `project_calendar_module_design`
- **GoogleCalendarModule** ✅ (Phase 4): двусторонняя синхра с **Google Calendar** через **OAuth 2.0 + Google Calendar API** (не «чистый CalDAV» — так делают Bitrix24/Salesforce). Подключение «Войти через Google» (`access_type=offline`+`prompt=consent`, scope `calendar`), модель `GoogleConnection` (токены, выбранный календарь, syncToken, канал веб-хука). Движок: **инкрементальная синхра** (`events.list` + syncToken, 410→полный ресинк), **веб-хуки** `channels.watch` (прод, публичный HTTPS) + **поллинг/кнопка «Синхронизировать»** (фолбэк, `GoogleCalendarCron`/Redis-лок). Только **свои события** двусторонне с выбранным календарём (дефолт — отдельный «SuperApp6»); **задачи — односторонне** в «SuperApp6 · Задачи». Конфликты — last-write-wins (по времени); **удаления зеркалятся**; участники НЕ выгружаются гостями (RSVP внутри). Маппинг `CalendarEvent.googleEventId`↔Google id (идемпотентный upsert гасит эхо). `CalendarService` шлёт `google.push` на изменения → `GoogleEventsListener`. Креды — в `.env` (`GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`); без них модуль инертен. Apple/CalDAV и мгновенные веб-хуки в проде — дальше. Лимит MVP: пер-экземплярные исключения повторов синкаются на уровне master+EXDATE
- **WorkspacesModule** (`@Global()`) ✅: B2B-организации. CRUD + передача владения + выход; участники (роль из `UserRole`); приглашения по номеру (send/accept/reject/cancel, external-активация при регистрации) — **найм ВСЕГДА в Стажёра** (`trainee`, выбора роли в приглашении НЕТ; опционально `positionId`+`branchId` «с порога» → назначение создаётся при принятии со статусом «стажируется»), приглашать может **manager+** (iiko-модель: управляющий нанимает сам), **без кулдаунов/дневных лимитов** (решение продукта «нанять всех за день»; остался анти-мусорный потолок pending 500). **Роль — единый источник `UserRole`** (`WorkspaceMember` БЕЗ поля role → нет рассинхрона; текстовые position/department УДАЛЕНЫ — теперь сущности StaffModule). **Лестница**: админа назначает/снимает только Владелец, админ не трогает других админов и назначает до Менеджера; `contractor` вручную не назначается. Один владелец + админы. Лимиты — `WORKSPACE_LIMITS`. Reuse `RolesService.hireUser/fireUser`. События `workspace.*` → уведомления. Зарезервирована системная роль `mystery_shopper` (будущий Jobs Marketplace «Тайный гость»). **Профиль организации** (Party-паттерн, зеркало личного `/profile`): поля `description/industry/city/website/contactEmail/contactPhone` + `cardVisibility` на `Workspace` (миграция `workspace_profile_fields`); `serializeWorkspace` отдаёт поля **по роли зрителя** — owner/admin видят всё и `cardVisibility` (для редактирования), сотрудники только включённые поля (остальные → null), сама `cardVisibility` сотрудникам не отдаётся; `tasksCount` через `_count`. `createWorkspace`/`acceptInvitation`/`transferOwnership` атомарны (транзакционный `setSoleWorkspaceRoleTx` + публичный `RolesService.invalidateUserCache`). Подписка — заглушка (без модели)
- **StaffModule (Сотрудники, B2B)** ✅ (2026-06-11): полноценный сервис управления сотрудниками — **справочники-сущности** `StaffDepartment` (Отдел; **дерево** через `parentId`, UI пока плоский список с родителем), `StaffPosition` (Должность; опционально принадлежит отделу), `StaffBranch` (Филиал: имя+адрес) + **назначения** `StaffAssignment` (человек × должность × опц. филиал; несколько на человека; статус `training`→`certified` — фундамент Додзё, переключается manager+ вручную, событие `workspace.position.certified`). **Членство в отделе — ПРОИЗВОДНОЕ от должности** (`Position.departmentId`, модель штатного расписания 1С) — прямого назначения «человек→отдел» нет. **Проекция в `core/access`**: `position#holder@user`, `branch#member@user`, `department#member@user` (**с closure предков** — грант на отдел достаёт сотрудников подотделов; `resyncWorkspaceStaff` на каждую мутацию + `reconcileStaff` в `AccessReconcileCron`), `EPOCH_FANOUT` для трёх осей; роли воркспейса проецируются маппингом `staff|trainee→member`, **`contractor` НЕ проецируется**. **Гейты**: чтение справочников/ростера — команда (role ≥ trainee), запись (CRUD справочников, назначения, аттестация, наём) — **manager+**, роли/увольнение — admin+ (админа — только владелец). **«Подрядчик» (`contractor`, экс-`guest`, Коллаб-модель Bitrix24)**: изолирован — `assertReachable` в ws-контексте требует КОМАНДНЫХ ролей у обеих сторон (подрядчик не инициирует и не достижим через пропуск), не видит ростер/справочники, должности не назначаются; роль выдаётся только программно будущими сервисами (Тайный гость/UGC) — сейчас прав ноль. Увольнение/выход — каскад: назначения + tuples снимаются. Удаление должности/филиала с активными назначениями → 409; смена родителя отдела с циклом → 400; дубль имени → 409 (unique на воркспейс). Миграция `staff_directories`: данные guest→contractor, текстовые должности/отделы членов → сущности+назначения (certified), partial-unique на (ws,user,position) WHERE branch IS NULL. UI `/workspaces/[id]/members` = вкладки **Сотрудники** (фильтры отдел/должность/филиал/роль/имя; ростер — **`StaffPersonCard` гридом 1в1 как «Моё окружение»**: та же карта L, клик → **XL-оверлей** (как в Circle), под телом кнопка «Написать» (DM через рабочий пропуск → `/messenger?chat=`), в углу маленькая «управлять» (manager+) → модалка: роль по лестнице + назначения + увольнение; **бейдж карты = Должность, роль организации на карте НЕ показывается**; кнопка «Аттестовать» из UI убрана по решению продукта — статус training/certified живёт в данных/API под Додзё; подрядчики — отдельной секцией admin+) **| Должности | Отделы | Филиалы | Приглашения** (форма найма — **клон b2c-формы «Добавить в окружение»** 1в1: номер → debounce-lookup `/users/lookup` с именем «Диана Н.» + PersonAvatar → **два блока чипами в стиле `RolePicker`**: «Должность» (выбор одной) + «Филиалы» (выбор НЕСКОЛЬКИХ — сотрудник обслуживает несколько; `WorkspaceInvitation.branchIds` String[], при принятии → назначение на каждый филиал) → подпись «всегда Стажёр»; миграция `invitation_multi_branch` (branchId→branchIds)). **«Видимость в Компаниях»**: новый набор флагов `users.companyCardVisibility` (миграция `user_company_card_visibility`; та же форма `CardVisibility`) — настраивается в `/profile/form` рядом с «Видимостью по умолчанию»; `GET /:id/members` отдаёт `member.card` (поля профиля, маскированные флагами ВЛАДЕЛЬЦА карточки; имя/фамилия/телефон всегда) — карта в ростере наполняется ровно как b2c-карточка в Окружении. **EntitySelector**: типы `department`/`position`/`branch` зарегистрированы в `lib/entities.ts` с workspace-скоупными лоадерами (`loadEntities(type, {workspaceId})`, один HTTP на 3 типа, `EntitySelector` принимает `context`) — будущая Лента/отпуска получают пикеры аудиторий бесплатно. React Query на общих ключах (`workspaceKey/workspaceMembersKey/workspaceStaffKey/workspaceInvitationsKey` в `lib/queries.ts`). Проверено e2e `verify-staff.cjs` (47/0); `verify-b2b-wallet.cjs` фикстура дополнена ролью (пропуск теперь проверяет роли, не голые member-строки). Руководители отделов/филиалов и канвас оргструктуры — позже (вместе с нодовым движком)
- **Chokepoint (изоляция B2B-данных)** ✅: `WorkspaceContextInterceptor` (APP_INTERCEPTOR) читает `X-Workspace-Id`, проверяет членство (fail-closed 403), кладёт активную организацию в `AsyncLocalStorage` (`WorkspaceContextService`). `DatabaseService` — Prisma-клиент через `$extends` (фабрика в `DatabaseModule`), авто-скоупит `workspaceId` на B2B-моделях (`Task`) когда контекст активен; иначе строгий no-op (личные/соц. потоки не затронуты). RLS не используется (app-layer, как Salesforce)
- **AccessModule (`core/access`)** ✅ — единый движок авторизации (**ReBAC**) для всех сервисов; заменил 3 скопированных обхода графа на один. Единая таблица `RelationTuple` (`ресурс#отношение@получатель`, прямой+обратный индексы) + правила на тип ресурса (`access-schema.ts`: примитивы `this`/`computedUserset`/`tupleToUserset`/`union` — наследование витрина←магазин, editor⇒viewer, уровни календаря busy<detailed) + резолвер (`check`/`resolveLevel`/`listObjects` — мемоизация + защита от циклов) + Redis-кэш с глобальной **«эпохой»** (любая запись = INCR → мгновенный отзыв доступа, закрывает «нового врага») + реестр способностей (`access-capabilities.ts` — код проверяет **способность**, не имя роли). Получатели: `user`/`circle`/`workspace_role`/`department`/`position`/`branch`/`public`. Источник правды = **проекция**: доменные таблицы остаются хозяином данных, их доступ-рёбра (членство в Группах, роли воркспейса, `Circle.calendarVisibility`, владение/parent магазина, роли участников задач) зеркалятся в движок (best-effort хуки + diff-сверка `AccessReconcileCron` + бэкфилл `scripts/backfill-access.cjs`). НЕ в chokepoint (cross-cutting, как Wallet). Проверено: `verify-{access,access-projection,shop,calendar-access,tasks-access}.cjs` (all-pass). **Потребители на движке:** Shop, Calendar и проверки видимости/комментов Задач (устранены перф-обрывы из исходного ревью — full-scan магазина и N+1 наложения календаря). Карточки Окружения (B2C) остаются **field-слоем** (доступ = наличие `ContactLink`, видимость полей по Группам — НЕ мигрированы, уже эффективны). **Платформенные персоны** (`platform`: Продавец/Тайный Гость/UGC) — аддитивны: открывают будущие фичи (Маркетплейс/Jobs/UGC), ничего существующего не запирают. **B2B-фундамент → ЖИВОЙ (сервис «Сотрудники» построен 2026-06-11)**: принципалы `department`/`position`/`branch` (три независимые оси) проецируются из `StaffAssignment` (+closure предков отделов, `reconcileStaff` в кроне, `EPOCH_FANOUT` заполнен); `card.full_viewer` (floor Имя+Должность / полная карточка по гранту) — гранты напишет следующая итерация Сотрудников. Чистый шеринг витрин/календаря и staff магазина — **только в движке** (legacy-таблицы `ShowcaseShare`/`CalendarShare` удалены миграцией `access_legacy_cleanup`). 5 понятий «роли» (подпись/участие/персона/роль компании/оргструктура), B2C↔B2B Party-симметрия (Группа≈Отдел). Дизайн — Serena memory `project_access_layer_design`
- **WalletModule** ✅ (банк-грейд денежный реестр — НЕ банк, но корректен под будущие реальные деньги через пополнение из банка): **типизированные счета** `Account` (type user|issuance|escrow|fee|external, ownerType user|workspace|system; `balance`+`held` — кэш с блокировкой строки, истина в журнале; user-кошельки `allowNegative=false`), **двойная запись** в неизменяемом `LedgerTransfer` (kind posted|pending|post_pending|void_pending; mint = перевод issuance→user, не «из ниоткуда» → по валюте Σ всех счетов = 0; сверка `reconcileCurrency`), **двухфазные переводы** (заморозка = `pending` → `post_pending`/`void_pending`; held = Σ незакрытых pending, НЕ мутируемое число), `Currency` (одна активная на эмитента — partial unique; полиморфный эмитент; `scale` — целые мин. единицы, 0 у коинов / 2 у фиата; опц. `code`). Обобщённый **эскроу**: `EscrowAgreement` («Сделка»: refType task|order, refId) + `EscrowHold` (нога payer→beneficiary, active→captured→released поверх двухфазного перевода). `LedgerService` (mint лимит 10М «на руках» / burn / transfer / createPending / postPending / voidPending / recompute / reconcileCurrency), `CurrencyService`, `EscrowService` (fund/capture/returnToHold/release — домен-агностичен, ключ refType+refId). Интеграция в `TasksService` синхронно в транзакции (refType='task': создание→fund, приёмка→capture+`wallet.coins.received`, возврат→collect-back+переморозка **без минуса** (бросает, если исполнитель потратил), отмена/удаление→release). Кошелёк НЕ в chokepoint (личные коины — не данные организации). UI: «Кошелёк» в `/profile` + бейдж «держит N 🪙». B2C + **B2B-кошелёк ✅ (Фаза 9): компанийная валюта (эмитент=workspace) + казна (воркспейс-счёт через `getOrCreateHolderAccount(ownerType)`), начисление сотрудникам (казна→user), награды за задачи компании и покупки в магазине компании — через казну** (`EscrowHold.payerType/beneficiaryType`, дефолт `user` → задачи/личный магазин не затронуты); только owner, в контексте организации (`X-Workspace-Id`). Платёжные рельсы (ввод/вывод/KYC/FX/чарджбеки) — позже, архитектура готова. Проверено e2e (`apps/api/scripts/verify-{wallet,escrow,ledger-invariants,burn,b2b-wallet}.cjs`). Дизайн — Serena memory `project_wallet_module`
- **ShopModule** ✅ (Фаза 2 — каркас «My Wish & Shop», без покупок): `Shop` (1/владелец user|workspace, ленивое создание), `Showcase` (витрина-папка; шеринг людям/Группам — через движок `core/access`), `Listing` (полная схема: тип/«с задачей»+дни/краудфандинг/запас/окно/скидка/статус — пока только CRUD+показ), `ListingPrice` (валюта+сумма, **многострочный** — кросс-валютная цена Ф5). **B2B-изоляция = явное владение (`ownerType`+`ownerId`) + проверка прав, НЕ chokepoint.** Управление, шеринг витрин и staff — через единый движок `core/access` (tuples); владелец/админ воркспейса управляют авто. Цена лота — своя валюта и/или валюты людей из окружения (нет ни одной → 400; компанийная валюта — Фаза 9). UI: плитка «My Wish & Shop» на dashboard + `/shop` (вкладки Shops|Wishlist, витрины слева, карточки лотов справа, переключатель чужих магазинов, модалки товара (мульти-валютный редактор цены)/шеринга/сотрудников + покупка/вкладка «Заказы»). **Покупки+исполнение (Фазы 3–4) ✅**: `Order` в shop + эскроу `refType='order'` (buy→заморозка покупатель→владелец; confirm владельцем/соуправляющим→списание по типу; reject/cancel→возврат; нельзя удалить лот с активным заказом; **материальное «с задачей» (Ф4)** → авто-задача на владельца (Постановщик=покупатель, награда=0), списание при приёмке покупателем (`task.completed`→`onFulfillmentDone`); **нематериальное «с задачей»** → списание + Событие в Календаре; возврат «в работе» владельцем (`/orders/:id/refund`); уведомления `shop.order.*`; проверено `verify-order{,-fulfilment}.cjs`). Весь доступ — через движок `core/access` (legacy `ShowcaseShare` + `UserRole` shop·showcase удалены; владение/parent самозалечиваются). **Кросс-валюта (Фаза 5) ✅**: цена лота = N валют (своя + валюты людей из окружения, эмитент — контакт); цена заказа — снимок `OrderPrice[]` (N ног); `buy` морозит по эскроу-ноге на валюту атомарно (не хватает любой → 400, полный откат), `confirm` списывает все ноги владельцу; `GET /shop/currencies` (своя+контактов) кормит мульти-валютный редактор цены. **Краудфандинг (Фаза 6) ✅**: краудфандинг-лот (флаг `crowdfunding`) собирается вскладчину — одна кампания = `Order` статус `funding`, цель = `OrderPrice[]` (мультивалютная), вклады = `OrderContribution` (нога эскроу на вкладчик×валюту). Всё-или-ничего: `contribute` морозит N ног атомарно (превышение остатка/нет валюты → 400, откат), собрана по ВСЕМ валютам → `pending` → владелец подтверждает → списание всех вкладчиков; `withdraw` отзывает свой вклад (пока `funding`). **Топ-вкладчик → Постановщик** авто-задачи, остальные → Наблюдатели (для события — все участники); `buy()` на краудфандинг-лоте → 400. **Лимиты/время/FOMO (Фаза 7) ✅**: штучный запас (`stockLimit`, атомарный резерв при заказе/кампании, возврат при отмене/возврате/просрочке, оверселл-безопасно), окно продаж (`availableFrom/Until` → 400 вне окна), FOMO-скидка (`discountPercent` до `discountUntil`, эффективная цена = ×(1−%) вниз, фиксируется снимком в заказе/цели; «ограниченное время» в форме → `availableUntil`), `ShopCron` (Redis-лок, 30 мин): авто-архив лотов после окна + авто-возврат просроченных недособранных кампаний (`Order.expiresAt`). **Wishlist (Фаза 8) ✅**: `WishItem` (хотелка: тип материальный/нет + ссылка, БЕЗ цены), вишлист шерится людям/Группам через движок (`wishlist:<owner>#viewer`); любой из окружения, кому виден вишлист, «Добавляет в витрину» → лот в ЕГО магазине с `sourceWishItemId` (цена/краудфандинг/лимиты — его), целевая витрина авто-шерится владельцу хотелки; лот продан/собран → хотелка авто-«исполнено» (+ вручную). **B2B-магазин (Фаза 9) ✅**: магазин компании (`ownerType=workspace`) оценивает лоты в компанийной валюте, витрины шерятся сотрудникам (членам воркспейса), покупки уходят в казну (эскроу beneficiary=казна); «с задачей» в магазине компании пока заблокировано. Проверено `apps/api/scripts/verify-{shop,order,order-fulfilment,crosscurrency,crowdfunding,limits,wishlist,b2b-wallet}.cjs` (резолв доступа по человеку+Группе, 403 на чужой витрине/вишлисте, staff видит всё, кросс-валютная заморозка/списание/откат, краудфандинг сбор/добор/отзыв/роли/списание, лимиты: распродано/окно/скидка/авто-архив, вишлист: доступ/копия→авто-шер/авто-исполнение); nest build + web tsc зелёные, `/shop`→200; визуально в браузере не отсмотрено. Дизайн — Serena memory `project_shop_module`
- **Интеграция auth**: при регистрации `AuthService.register` вызывает `ContactsService.activatePendingInvitationsForNewUser` и `WorkspacesService.activatePendingWorkspaceInvitationsForNewUser` → external приглашения (контакты и организации) получают `toUserId` → создаются уведомления
- **Web UI `/circles`** = "Моё окружение" — единая страница: список людей, панель приглашений (входящие+исходящие), секция «Заблокированные» (раскрывающийся список + разблокировка; блокировка — с карточки человека («блок») и из входящего приглашения («Заблокировать»), с confirm), чипы-Группы (фильтр; при выборе Группы — редактор её видимости), форма добавления по номеру телефона. **Нет отдельной страницы /contacts** — всё в одном месте.
- **Web UI `/tasks`** ✅ — список со смарт-фильтрами (Сегодня/Предстоящие/Просрочено/Мне поставили/Я поставил/На проверке/Все) + форма создания (Себе/Человеку/Группе, пикеры людей из окружения, дедлайн со временем или «весь день», напоминание, повтор, приоритет, награда с подсказкой «каждому по X»). Деталька `/tasks/[id]`: роли с пер-участник статусами, прогресс «N из M», кнопки Взять в работу / Сдать / Принять / Вернуть, чат задачи.
- **Web UI организация** ✅ — вход в организацию → **Главная организации** (`/workspaces/[id]`, зеркало `/dashboard`: шапка + сетка сервисов Сотрудники/Задачи/Календарь + статистика; «Профиль» — вкладка в навбаре, не сервис). **Профиль организации** (`/workspaces/[id]/profile/<секция>`, зеркало личного `/profile`): 6 секций — Карточка/Анкета/Статистика/Подписка/Настройки/Безопасность, сайдбар с гейтингом по роли (manage→owner/admin, security→owner). **Сотрудники** — отдельно в `/workspaces/[id]/members`. `CompanyCard` (compact/full) — карточка компании, у сотрудников показывается в «Организациях» (`WorkspacesPanel`).
- **`GET /api/users/lookup?phone=...`** — поиск пользователя по номеру (форма приглашения). Приватность: фамилия отдаётся **инициалом** («Санжар Н.», Kaspi-стиль, `maskLastName` из shared) + отдельный лимит 30/час против перебора номеров
- **PersonCard** (`apps/web/src/app/circles/PersonCard.tsx`) — карточка человека в стиле скетча: текстурная бумага (#F4F1E8), двойная рамка аватара, бейдж роли, мазки карандашами в углах, grid-сетка. Каждая карточка с уникальным наклоном.
- **Форма приглашения** — поиск по номеру (показывает имя), два RolePicker ("Я" / "Он(а)") с пресетами (Жена, Муж, Мама, Папа, Сын, Дочь, Семья, Родственник, Друг, Коллега, Одноклассник, Однокурсник, Клиент + Свой вариант)
- **InvitationCard** — единый компонент для входящих и исходящих приглашений (имя, телефон, роли "Я: / Имя:", дата истечения, кнопки)
- **Профиль `/profile`** — вложенные роуты App Router: `layout.tsx` (нав + сайдбар, активная секция через `usePathname`) + `[section]/page.tsx` (контент). Раздел живёт в URL (`/profile/<секция>`) → переживает обновление страницы, шарится ссылкой, работает кнопка «Назад». `/profile` → редирект на `/profile/card`. 7 секций: Моя карточка (PersonCard full + тогглы видимости), Моя Анкета (данные), Статистика, Мои роли, Подписка, Настройки (язык/часовой пояс/онлайн-статус), Безопасность (сессии + «Опасная зона»: удаление аккаунта)
- **PersonCard** (`apps/web/src/app/circles/PersonCard.tsx`) — два режима:
  - `compact` — карточка в grid окружения (имя, телефон, город, био, дата рождения, семейное положение, email, соц. сети, роль-бейдж, Группы)
  - `full` — большая карточка в профиле с тогглами приватности (ON/OFF затухание полей)
- **CardSkinsModule** ✅: платформенные косметические скины для PersonCard. Скин=данные (токены+слои рамка/фон/эффект), `CardSkin`(тип)+`CardSkinInstance`(экземпляр: серийник лимиток + история передач `CardSkinTransfer`). Платформенная валюта (`issuerType='platform'`) на Ledger; покупка мгновенная, оверселл-безопасный резерв тиража (трейд/эскроу — позже). Надевание: дефолт всем + на группы (премиум; конфликт=группа выше `sortOrder`; премиум истёк→дефолт). 6 тиров (видны в XL). **PersonCard переписан**: токенизирован (визуал из скин-токенов, не хардкод) + **5 форм-факторов** XS/S/M/L/XL (XS = голый аватар, вдвое меньше, для тесных мест; S = аватар+имя в строку; M = аватар+имя+роль; L = Имя Фамилия + «О себе» (если разрешено) + роль — ровные карточки для 100+; XL = всё подробно + редкость). В «Окружении» дефолт L → клик разворачивает в XL; в `/profile` переключатель всех 5. Анимация: Lottie в XL/L (витринные); лёгкая CSS-анимация в M/S; XS статичный. Строчные размеры (XS/S/M) — компактные inline-чипы (не растягиваются на всю ширину). Эффекты: **реальные Lottie** (`lottie-react`; ассеты в `apps/web/public/skins/`, генератор `apps/web/scripts/gen-lottie-skins.cjs`) с CSS-пресет-фолбэком, `prefers-reduced-motion`-aware, по размеру (XL/L). 3 скина: Цветочный/Мятая бумага/Ретро-неон. UI: `/profile`→«Скины карточки» (магазин/инвентарь/надевание/группы+превью), грид «Окружение» накладывает скин через `/card-skins/resolve`. `authorId` скрыт (ручной, коллабы). Проверено e2e `verify-cardskins.cjs` (23/0) + браузер (покупка/надевание/размеры/резолв, 0 ошибок). **Переиспользуемый движок скин-аватара:** `usePersonSkin`/`PersonAvatar` (`apps/web/src/lib/person-skins.ts` + `messenger-ui.tsx`) — батч+кэш `/card-skins/resolve`; подключён ВЕЗДЕ, где показывается человек (Окружение, профиль-превью, мессенджер: списки чатов/шапка DM/пикеры/поиск/участники групп, упоминания, Задачи: выбор человека+участники). Любой новый «человек» в UI = `<PersonAvatar userId .../>` (голый скин-аватар) или `<PersonChip size userId .../>` (готовая карточка-строка любого размера со скином). Использование: пикеры людей (Задачи, шеринг в Shop, @-дропдаун упоминаний) = карта **M** (компактная строка, avatar 30); инлайн-упоминание в сообщении = карта **S** (avatar 18, подставляется вместо `@имя`); грид Окружения = L→XL. **Принцип (требование продукта):** человек ВЕЗДЕ = одна из 5 карт (`PersonChip`/`PersonAvatar`), НЕ голый текст — ради видимости платных скинов. **Выбор людей/сущностей — единый `EntitySelector`** (`apps/web/src/components/EntitySelector.tsx` + реестр `apps/web/src/lib/entities.ts` + чипы `apps/web/src/app/circles/EntityChip.tsx`): кастом-дропдаун (НЕ нативный `<select>`, туда карту не вставить), реестр типов (user→`PersonChip`, circle→`GroupChip`; department/position/branch — регистрацией позже), мульти+смешанный выбор, на выходе принципалы `{type,id}` для `core/access`. Модель Bitrix `UI.EntitySelector` / Salesforce lookup. Применён **во всех пикерах людей/групп**: Задачи (Исполнитель/Соисполнители/Наблюдатели/Группа), Календарь (участники события, шеринг, Smart Match, доступ к брони ресурса), мессенджер (DM/@-пикер — `ContactPicker`-адаптер над `EntitySelector`; **создание группы и добавление участников — выбор человека ИЛИ Группы в одном поле: Группа разворачивается в участников snapshot'ом по `myCircleIds`, без лишних запросов**; B2B отдел/должность/филиал — после регистрации их loader'ов в `entities.ts`), Shop (шеринг витрин и вишлиста, staff), Workspaces (выплата сотруднику в кошельке организации). Отображения человека → `PersonChip`/`PersonAvatar`: ростер сотрудников, держатели валюты, строка покупателя заказа, приглашения (Dashboard + Окружение). Старые самописные пикеры удалены (PeoplePicker/InvitePicker/ручной список ContactPicker, локальный `Avatar` в Окружении). Остаются нативными `<select>` (вне scope «человек/группа/отдел/должность»): enum-селекты (статус/тип/повтор/напоминание), валюты (отдельный тип `currency` — позже), ресурс/витрина/скин, навигационные переключатели «чей магазин/вишлист смотрю». web tsc зелёный; визуально в браузере не отсмотрено. **Ревью-хардненинг (2026-06-07):** live-обновление скина после надевания (`invalidatePersonSkins` ре-фетчит), фото в `PersonChip` (`avatar`), само-залечивание висячих equip-ссылок, Lottie→CSS фолбэк, токенизация цвета presence/радиуса кольца, ref-замок от двойной покупки, `@@unique([skinId,serial])` (миграция `20260607000000_card_skin_serial_unique`); все отображения человека (список задач/Постановщик/Наблюдатели/организатор события/заявка на бронь/оверлеи чужих календарей) и передача владения орг. доведены до `PersonChip`/`EntitySelector`. Отложено: Lottie-перф в L-гриде. **Политика видимости скина (решение 2026-06-11):** надетый скин виден **всем, кто видит карточку** (окружение, коллеги по организации, будущий маркетплейс) — косметика = публичный статус (модель Telegram Premium/Steam); бывший «дефер F6» закрыт как поведение by design. Скины-на-группу действуют только для личных Групп; идея на будущее — «скин на организацию» (премиум B2B). **Платёжные рельсы (реальная оплата валюты), трейд/подарки/UGC и @username (чип в поле ввода) — позже.** Дизайн — авто-память `project_card_skins`
- **ProcessesModule («Процессы», B2B)** ✅ (Фаза 1, 2026-06-13): нодовый движок бизнес-процессов (решение «строим своё, ничего не встраиваем»: n8n под Sustainable Use License не встраивается, Windmill AGPL, Camunda 7 EOL; механики скопированы клин-рум — дизайн/ресерч в Serena `project_process_engine`). **Реестр нод — 5-й платформенный** (`ProcessNodeRegistry`, паттерн quick-actions): паспорт ноды = декларативный «MCP-описатель» (тип/категория/иконка/`tier` standard|system/типизированные выходы/`fields`-виджеты для UI/Zod-`configSchema`/`auto`-флаг) — одна регистрация кормит палитру, валидацию и будущие AI/MCP-поверхности; system-ноды видны только платформенной роли `platform_admin` (UserRole context='system'). **Документ-канвас — источник правды** (плоские nodes+edges+`form`-анкета, семантические id, именованные config-значения; позиции опциональны), компилятор → исполняемый план в `ProcessVersion.compiled` (модель ComfyUI workflow→prompt; мягкая валидация при сохранении, публикация только при 0 issues + исполнители = действующие члены команды). **Версии — модель Salesforce Flow**: publish = новая версия, активна одна (`currentVersionId`), правка published авто-открывает черновик v+1, запущенные инстансы доживают на своей версии (pin). **Движок — token-walker строками БД** (стиль кошелька): `ProcessInstance` (анкета JSONB, wakeAt) + `ProcessStepRun` (таймстемпы = «секундомер отделов», outcome=порт, taskId, sourceStepId), status-guarded updateMany (двойное продвижение невозможно), Redis-лок на инстанс сериализует толчки, `ProcessesCron` (*/2 мин) добивает зависшее; стоп-краны: ≤500 шагов на инстанс, ≤100 авто-нод за толчок. **Триггер-ноды (вход процесса, модель n8n — доводка 2026-06-14): Запуск вручную (тип-ключ `start`; несёт анкету text/number/boolean/date/select, типизация+required при запуске) · По расписанию · Веб-хук · Событие в SuperApp · Telegram: входящее (сообщение боту → процесс; текст в `{{form.text}}`, ответ нодой Telegram с `chatId={{form.chatId}}` — флагман n8n «сообщение→AI→ответ», 2026-06-14)** · Задача человеку (создаёт НАСТОЯЩУЮ задачу Задачника через `createTask` от имени инициатора — чат/напоминания/приёмка бесплатно; исполнитель **сотрудник|отдел(очередь)|инициатор**; `dueInHours`→SLA; завершение задачи будит токен синхронным хуком + EventBus-подстраховкой; удаление/отмена задачи → инстанс error) · **Одобрение (Ф2)** (согласующий сотрудник|инициатор → ветки approved/rejected; отклонение можно вернуть назад связью-петлёй; `dueInHours`→SLA; уведомление+кнопки на инстансе/в «Входящих») · Если (сравнение поля анкеты, ветки true/false) · **Развилка/Слияние (Ф2.5)** (fork/join: развилка спавнит токен на каждое ребро `main`; слияние ждёт все ветки = число входящих рёбер, срабатывает один раз — мульти-токенный движок) · **Пауза (Ф2)** (ждёт N минут/часов/дней, добивается кроном-таймером) · Уведомить (инициатор|сотрудник) · **HTTP-запрос (Ф3)** (внешний REST для Kaspi/1С/любого API; подстановки в URL/теле, заголовки, креды из сейфа, SSRF-защита, выходы success/error) · **AI (Ф4)** (LLM-шаг по API — Anthropic/OpenAI/совместимый; свой провайдер/модель/системный+пользовательский промпт/температура на КАЖДОЙ ноде — модель ComfyUI; ключ = bearer-кред из сейфа; подстановки `{{steps.<нода>.output...}}` дают доступ к результатам прошлых шагов; результат в `output.text`; выходы success/error) · **AI-Агент (Ф4.5, cluster-модель n8n)** (мозг-оркестратор: снизу ТИПИЗИРОВАННЫМИ ПОРТАМИ подключаются отдельные под-ноды — **Модель** (обязательно), **Память** (опц.), **Инструменты** (сколько угодно); агент сам решает, какие инструменты звать; tool-calling-цикл; **агента можно подключить инструментом к другому агенту** через выход `astool` → оркестратор→специалисты, рекурсия с лимитом глубины 3; итог в `output.text`) · **Под-ноды AI (Ф4.5)**: **Модель** (Claude/GPT, переиспользуется несколькими агентами) · **Память** (диалог по ключу сессии в Redis, помнит между запусками) · **Инструменты агента = сами ноды действий** (модель n8n: один узел = действие И инструмент; слияние 2026-06-14): отдельных под-нод «Инструмент: …» БОЛЬШЕ НЕТ — ноды **HTTP-запрос / Уведомить / Telegram** работают и в потоке, и как инструмент агента (выход `astool` → вход `ai_tool` агента); `ai.tool.http/notify/telegram` удалены · **Коннекторы KZ (Ф6, категория integration, пресеты поверх HTTP)**: **Telegram** (sendMessage ботом, токен @BotFather) · **WhatsApp** (Cloud API, текст в 24ч-окне) · **SMS (Mobizon)** (sendSmsMessage, apiKey) · **Kaspi Магазин** (заказы: получить новые/принять/завершить, X-Auth-Token из кабинета; вебхуков нет → опрос по расписанию + нода) · **1С (OData)** (чтение/создание объектов опубликованной базы, Basic-auth, SSRF=база публична); все с подстановками, кред из сейфа, выходы success/error · Конец. Подстановки `{{form.x}}`/`{{initiator.name}}` — path-lookup без eval. **Гейты — лестница ролей (модель Staff)**: читает/запускает команда (trainee+, Подрядчик изолирован), редактирует/публикует/архивирует manager+, `visibility='admins'` («процессы для разработчиков») скрывает от не-админов; инстансы: manager+ видит все, рядовой — свои запуски + где он исполнитель; отмена (инициатор|manager+) каскадно отменяет открытые задачи; архив блокируется бегущими (409). Ф1 ограничения: один токен (на порт — одно ребро, параллель в Ф2), анкета заполняется только на старте, событийных/расписанных триггеров нет (Ф3). UI `/workspaces/[id]/processes`: список+Журнал (live-обновление) → **полноэкранный канвас-редактор на @xyflow/react** (модель n8n: канвас на весь экран под навбаром, плавающие сворачиваемая палитра + NDV-панель конфигурации из `fields`-паспорта; **flow-state = источник правды во время правки** — `applyNodeChanges`/`applyEdgeChanges`, документ собирается лишь при сохранении → драг плавный, без мерцания; **жесты n8n**: drag-нода-из-палитры (`screenToFlowPosition`), провод-в-пустоту→пикер «добавить и связать» (`onConnectEnd`), даблклик→настройки, миникарта, snap-сетка, авто-раскладка BFS, стрелки рёбер; защита `beforeunload`+Ctrl+S; EntitySelector исполнителя (options=члены орг.); модалка запуска — по анкете ОПУБЛИКОВАННОЙ версии `startForm`) → карточка инстанса (read-only канвас со статусами/таймингом на нодах + бейдж попыток `×N` для циклов, лента шагов с PersonChip и «→ задача», анкета, отмена; автообновление 4с, канвас не пересобирается без смены статусов). **Ф2 — человеческие процессы (2026-06-13):** **задачи на отдел = очередь+claim** (модель Camunda candidate-group: шаг без задачи/исполнителя `departmentId`+`activated`, члены отдела (проекция `department#member` core/access, с closure подотделов) видят в **«Входящие»**, первый забирает → создаётся реальная задача, конкурентный claim проигрывает на status-guard'е и гасит лишнюю задачу) · **Одобрение** (approve/reject endpoint, решает назначенный согласующий, петля-возврат при отклонении) · **Пауза** (`deadlineAt`-таймер, добивает крон) · **SLA**: `dueInHours` на человеческих шагах → `deadlineAt`; крон шлёт **эскалацию** просрочки инициатору+исполнителю (дедуп `escalatedAt`) · **«Входящие»** (`GET /inbox`: claimable задачи моих отделов + одобрения на мне) · **отчёт «время по шагам/отделам»** (`GET /:defId/report`, manager+: avg/max/раз по нодам + среднее время процесса — «секундомер отделов»). Новый `activated`-флаг разделяет «нода ещё не отработала side-effect» (kick перезапускает) от «ждёт человека/времени» (спит). Web: вкладки **Процессы|Входящие|Журнал|Аналитика**; кнопки Одобрить/Отклонить/Забрать на инстансе и в инбоксе; бейджи отдела/дедлайна/просрочки на шагах. **Ф2.5 (2026-06-13):** **параллель** — движок стал мульти-токенным (`adjacency: port→[targets]`, kick обрабатывает ВСЕ готовые шаги за проход, не останавливается на первом ожидании); fork (`multiOut`) спавнит токен на каждое ребро, join (`join`+compiler-`joinExpected`=in-degree) копит прибытия (`joinArrivals`, депозит будит шаг `activated=false`), срабатывает один раз; структурный fork/join (все ветки доходят до слияния), maxSteps-стоп-кран от циклов. **Переназначение** активного шага-задачи (manager+, `reassignExecutorTrusted` в Задачнике — снимает старого, ставит нового, награда переморожена). **Ф3 — триггеры+интеграции (2026-06-13):** запуск не только вручную — **событие платформы** (`ProcessTriggerRouter` слушает EventBus: принят сотрудник/назначена должность/аттестован/задача создана/завершена; workspace резолвится по payload или по сущности; payload→анкета), **расписание** (интервал часы/дни, `nextRunAt`+крон с claim-защитой от двойного запуска), **внешний вебхук** (публичный `POST /api/processes/webhook/:token`, тело→анкета). `ProcessInstance.triggerType` (manual|event|schedule|webhook); запуск «от имени» `runAsUserId`. **Сейф кредов** (`ProcessCredential`, AES-256-GCM, ключ из JWT_SECRET; типы header|bearer|basic; секрет наружу НЕ отдаётся) — HTTP-нода берёт креды отсюда. Триггеры/креды — manager+. Уведомления `process.finished/failed/step.notify/approval.requested/task.queued/step.overdue` (категория processes); события `process.started/finished/failed/cancelled` на шине. **Ф4 — AI-кластер (2026-06-13):** подключение ИИ по API без SDK (чистый fetch к Anthropic Messages / OpenAI Chat — `process-ai-client.ts`: текст + tool-calling для обоих провайдеров). Нода «AI» = разные модели/промпты на одном канвасе (ComfyUI-стиль); «AI-Агент» = оркестратор с курируемыми инструментами (n8n-стиль). Ключи API — **bearer-креды из сейфа Ф3** (не env, мульти-тенантно). Контекст ноды расширен `{{steps.<nodeId>.output...}}` (результаты завершённых шагов → промпты; объект→JSON). kick-лок поднят до 200с (агент-цикл дольше; защита от задвоения дорогого LLM). AI-ноды auto, на ошибку (нет ключа/сети) → ветка `error` (процесс не падает). **Ф4.5 (n8n cluster-агент, построено 2026-06-13):** агент переписан под n8n-модель типизированных портов. Документ-ребро получило `toPort`; паспорт ноды — `inputs[]` (типы main/ai_model/ai_memory/ai_tool) + `subNode`/`tool`. Компилятор разделяет потоковые рёбра (main↔main → adjacency) и подключения под-нод (ai_*↔ai_* → `attachments`), проверяет совместимость типов портов, требует у агента ровно 1 Модель/≤1 Память, под-ноды должны быть подключены, под-агент (через `astool`) — провайдер (не в потоке). Движок `buildAgentCluster` резолвит Модель (ключ из сейфа)/Память (Redis-замыкания load/append по ключу сессии)/Инструменты (под-ноды-инструменты + под-агенты рекурсивно, глубина ≤3) и кладёт в `ctx.cluster`; `runAgentWithCluster` (память + llmAgentLoop) переиспользуется и для под-агентов. Холст: цветные типизированные порты (Модель фиолет/Память бирюза/Инструменты янтарь), `isValidConnection` запрещает несовместимые соединения, подключения под-нод — пунктирные цветные рёбра снизу. e2e: кластер компилируется+выполняется, агент-без-модели→ошибка, агент-как-инструмент (оркестратор+специалист) компилируется; браузер: сборка как на скриншоте n8n. Простая нода «AI» (`ai.generate`, модель в конфиге) осталась для быстрых LLM-шагов. Отложено: расширение набора инструментов агента (создание задач/событий — через реестр, как Принцип 4); сервис-ноды message/calendar (Ф3.5). Отложено в Ф3.5: сервис-ноды внутренних модулей (сообщение в чат/событие календаря — у них свои env-проверки; внутренние действия пока через ноды Задача/Уведомить/Одобрение). **Ф6 — KZ-коннекторы построены 2026-06-13** (Telegram/WhatsApp/SMS/Kaspi/1С OData; чистый fetch + сейф кредов; e2e: Telegram-нода реально дёргает API и уходит в error на фейк-токене, Kaspi-операции; полный verify-сьют зелёный). Отложено: **Halyk ePay** (OAuth+договор эквайринга — пока через HTTP-ноду), **Email SMTP** (нужна nodemailer-зависимость — через HTTP/API-провайдера), Kaspi Pay (партнёрский договор+VPN), полноценный polling-триггер (сейчас Kaspi опрашивается процессом по schedule-триггеру). **Ф5 (RAG, pgvector «база знаний») — НЕ построена, делается позже (по решению пользователя строить Ф6 раньше Ф5).** Проверено e2e `verify-processes.cjs` (60/0: + отмена задачи-шага→процесс error, стена admins на правку/публикацию/валидацию, ревью-фиксы) + регрессии tasks-access/order/order-fulfilment/wallet/staff/messenger-task зелёные + браузер (полноэкранный канвас, драг без мерцания — DOM ноды не пересоздаётся, 0 ошибок консоли). **Ревью (3 агента) выполнено 2026-06-13:** потерянный сигнал завершения задачи (sync-хук упал + at-most-once шина потеряла) — крон-сверка wait-шагов с их задачами (done/cancelled/deleted); `task.cancelled` событие+хук→процесс в error; advance/cancel/fail берут инстанс ПЕРВЫМ замком (нет дедлока и осиротевших active-шагов); компенсация задачи-сироты если инстанс отменили во время её создания; стена `admins` enforced на edit/publish/validate/archive/журнал; runtime-проверка членства в нодах (уволенный после публикации не получит задачу/уведомление); кэш планов с потолком 100; компилятор запрещает self-loop и рёбра в Старт; own-property рендер подстановок; status-guard на `recomputeStatus` (нет дубль-settlement). **UX-доводка 2026-06-14 (триггеры = ноды, n8n-модель; verify-processes 60+/0 + браузер):** фиксированный «Старт» убран — вход процесса теперь триггер-нода (`start`=«Запуск вручную»/`trigger.schedule`/`trigger.webhook`/`trigger.event`; категория `trigger`, без входа, можно несколько, удаляется; публикация требует ≥1 триггера). Авто-триггеры зеркалятся в `ProcessTrigger` ПРИ публикации (`syncTriggersOnPublish`, ключ `config.nodeId`, стабильный webhook-токен), движок `startInstance({entryNodeId})` стартует токен со сработавшего триггера; старый CRUD `:defId/triggers` + вкладка триггеров удалены. Правая панель открывается по клику на ноду (не вечно открыта); анкета запуска редактируется ВНУТРИ ноды «Запуск вручную»; настройки процесса — за кнопкой «⚙ Настройки»; поле «Заметка (стикер)» убрано. **Telegram чат-триггер построен 2026-06-14** (`trigger.telegram`: входящее сообщение боту → процесс; приёмник `POST /api/processes/webhook/telegram/:token` парсит апдейт → `{{form.text/chatId/fromName}}`, авто-`setWebhook` при публикации best-effort; send-нода `kz.telegram` уже была → петля trigger.telegram→ai.agent→kz.telegram). Отложены (новый код): внутренний DM (нужна send-нода `service.message`) + WhatsApp-входящий (вебхук Meta); инфра n8n (IMAP/MQTT/файлы) не нужны KZ-бизнесу. Фазы 2–6 — см. дорожную карту
- **Хардненинг (архревью, блоки 1–6)** ✅ — выполнено 2026-06-11, весь verify-сьют (28 скриптов) зелёный:
  - **Деньги:** `postPending`/`voidPending` перепроверяют `isResolved` ПОСЛЕ row-лока + partial-unique на `pending_id WHERE kind IN ('post_pending','void_pending')` (миграция `ledger_pending_resolution_unique`) — двойная выплата невозможна; status-guarded `updateMany` во всех переходах заказов/приёмки (`acceptWork`, `confirmOrder`, `rejectOrder`, `cancelOrder`, `refundOrder`, `withdraw` (FOR UPDATE на кампанию), `expireCampaigns`, `onFulfillmentDone`); settlement «с задачей» — синхронно из `TasksService.settleLinkedOrder` + sweep `settleCompletedFulfilments` в ShopCron (шина — подстраховка); `withLock` с owner-токеном (Lua compare-and-del; лок не «крадётся»), `fireDue` клеймит строки `pending→sending` (+восстановление зависших); бронь ресурса — capacity-check + запись в одной транзакции под `FOR UPDATE` строки ресурса (createEvent/updateEvent/confirm).
  - **Страховка:** CI `.github/workflows/ci.yml` (PG16+Redis7 service-контейнеры → build shared+api → migrate deploy → web tsc → старт API → seed → полный verify-сьют); env-валидация zod в bootstrap (`shared/config/env.validation.ts`: whitelist NODE_ENV — опечатка не запускается; в production обязателен REDIS_URL и JWT_SECRET ≥32); **secure-by-default** — троттлинг выключен ТОЛЬКО при NODE_ENV development/test, Swagger только в development; Redis error-listener + warn на фолбэк; `WalletCron` — ночной Σ=0-чек всех валют (ошибка в лог).
  - **core/access перф:** эпоха кэша per-resourceType (`EPOCH_FANOUT` в `access-schema.ts`; неизвестный тип → глобальная — safe-by-default) — задачи/чаты больше не сбрасывают весь ACL-кэш; отложенный re-bump через 2с после tx-коммита (закрыто окно stale-ACL); `listObjects` — BFS волнами одним IN-запросом + прунинг по типам (`GENERIC_PRINCIPALS` + `LIST_OBJECTS_EXTRA_EXPANSION`) + общий memo-контекст верификации кандидатов; `resyncTaskRoles` → applyDiff (нет revoke-grant окна, ноль бампов при пустом диффе).
  - **Горячие пути:** `listChats` — unread одним range-SQL (`seq > GREATEST(last_read_seq, visible_from_seq-1)`, O(непрочитанного)) и без include всех участников (`_count` + только DM-peer); календарь — `recurrenceEndsAt` (materialized конец серии; фильтры в getRange/overlay/busy/getCurrentEvent/topUpReminders; бэкфилл `backfill-recurrence-ends.cjs`); `/tasks` — `priorityRank Int` (сортировка high>low починена); дубль-индексы дропнуты (`messages` chatId+seq, `user_roles` userId, `contact_invitations` ×2, `escrow_agreements` refType+refId — миграция `hotpath_perf`); WS — clamp `seq ≤ chat.lastSeq` + пер-сокетный token-bucket (typing 60/мин, heartbeat 12/мин, receipts 120/мин).
  - **Сессии/realtime:** single-flight refresh в web (`lib/api.ts`: Web Locks + re-read localStorage для мульти-таб) и mobile (`src/lib/api.ts`) — параллельные 401 больше не ротируют refresh наперегонки; socket — `auth` как функция (свежий токен на каждом reconnect) + `onReconnect` инвалидирует чаты/открытый диалог; `logout-all`/удаление аккаунта эмитят `auth.sessions.revoked` → gateway рвёт живые сокеты (`disconnectSockets`, кластерно через Redis-adapter).
  - **Блокировки:** единый `ContactsService.assertReachable(ownerId, ids, msg?, opts?)` — связь + отсутствие блока в обе стороны, батчем; гейт у tasks/calendar/shop/messenger (4 копии `assertInEnvironment` делегируют). Блок по-прежнему удаляет ContactLink (продуктовое правило). **«Рабочий пропуск» (2026-06-11, находка 4 ревью Circle):** в контексте организации гейт проверяет со-членство в воркспейсе вместо личного окружения; блоки рабочие действия (задачи/события/групповые чаты) НЕ гасят, DM — гасят всегда (`opts.alwaysCheckBlocks`). Проверено `verify-b2b-reachability.cjs` (13/0).
  - **Новые verify:** `verify-logout-socket.cjs` (разрыв сокета при logout-all), `verify-block-enforcement.cjs` (блок гасит задачи/события/DM в обе стороны); `verify-tasks-access.cjs` починен (чат задачи → messenger-эндпоинты).
  - **API-контракт (блок 7, частично):** `/api/v1` — канонический префикс (rewrite-алиас в `main.ts`: `/api` остаётся рабочим legacy-путём; web/mobile клиенты ходят на v1; Google-callback работает по обоим путям); `AllExceptionsFilter` (`shared/filters/all-exceptions.filter.ts`, APP_FILTER) — ВСЕ ошибки в одном конверте `{success:false, statusCode, message, errors?}`: Zod → 400 с полями, HttpException → как есть, Prisma P2002/P2025 → 409/404, прочее → 500+лог (`ZodExceptionFilter` удалён — поглощён).
  - **Web-гигиена (блок 9):** см. пункт 9 в «Известные риски» — общие RQ-ключи (`lib/queries.ts`), `/circles` и `/tasks` на React Query, `invalidateEntities` подключён, Lottie через dynamic+IO-гейт, композер чата вынесен (memo), dashboard на `next/link`.
- **3 тестовых аккаунта**: tester1 (+77001234567), tester2 (+77012345678), tester3 (+77023456789) — пароль: Test1234!

### Безопасность
- JWT_SECRET обязателен — приложение не запускается без него
- Refresh token: SHA-256 (детерминированный хеш для поиска по равенству; bcrypt тут не годится — рандомная соль не даёт совпадения при lookup). Refresh-JWT несёт уникальный `jti` → два логина в одну секунду не дают коллизию на unique `session.token`
- Rate limiting: `ThrottlerGuard` зарегистрирован как APP_GUARD, счётчики в Redis (`RedisThrottlerStorage`, общие на инстансы). `@Throttle` на login/register (5/15мин) и приглашениях (10/мин) нацелен на сконфигурированный троттлер `long`. **Secure-by-default:** выключен ТОЛЬКО при явном `NODE_ENV` development/test (частые логины при разработке); любое другое значение (включая опечатку) = полная защита, а env-валидация при старте вообще не пустит неизвестный NODE_ENV
- Env-валидация при старте (`shared/config/env.validation.ts`, zod, fail-fast до запуска Nest): NODE_ENV из whitelist, DATABASE_URL/JWT_SECRET обязательны, в production обязателен REDIS_URL (иначе тихий фолбэк на localhost) и JWT_SECRET ≥ 32 символов
- XSS: Zod `.refine()` запрещает `<>` в именах, ролях, био, сообщениях
- Пароль: минимум 8 символов, заглавная + строчная + цифра + спецсимвол
- Приглашения: TTL 30 дней, resend cooldown 24ч, история не-pending приглашений хранится 30 дней (`CONTACT_LIMITS.nonPendingRetentionDays`) — на ней держатся кулдаун, лимит 30/сутки и resend; просроченные скрываются из списков сразу (фильтр `expiresAt`, не дожидаясь крона). Cron'ы под Redis-локом (выполняет один инстанс): `ContactsCron` (ежечасно помечает просроченные + удаляет не-pending старше ретеншна), `NotificationsCron` (ежедневно удаляет уведомления старше `NOTIFICATION_LIMITS.retentionDays`), `TasksCron` (напоминания о дедлайнах каждые 10 мин + ежедневная сводка просрочек)
- Удаление аккаунта: `DELETE /users/me` (требует пароль) — мягкое удаление с **грейс-периодом 30 дней**. Ставит `deletionScheduledAt`, отзывает сессии, блокирует вход (`login` + `JwtStrategy`). Вход в течение 30 дней = авто-восстановление (`login` чистит метку). `AccountCron` (ежедневно, Redis-лок) по истечении грейса вызывает `anonymizeAccount`: PII стёрт, номер освобождён, `deletedAt` терминально. Регистрация на номер в грейсе → 409 с подсказкой «войдите, чтобы восстановить». Общие данные (задачи/воркспейсы) сохраняются. `ACCOUNT_GRACE_DAYS` в `users.service.ts`
- Миграции БД: под `prisma migrate` (baseline `0_init` в `prisma/migrations/`); `db push` заменён на `migrate dev`/`migrate deploy`
- Concurrent accept: P2002 handler предотвращает дубли ContactLink
- Strict Zod: `.strict()` на socialLinks и `cardVisibilityObjectSchema` (общий, `validation/card-visibility.ts`) — используется в `/users/me` и `/circles`; произвольные поля отклоняются
- Error Boundary (providers.tsx): ловит render-ошибки, показывает fallback с кнопкой перезагрузки
- Фронт типы импортируются из `@superapp/shared`, не дублируются

### Что ещё не протестировано
- Calendar Phase 1–3 — бэкенд проверен end-to-end (повторы, экземпляры, слой задач, участники+RSVP, шеринг busy/detailed, Smart Match, ресурсы: бронь→заявка→подтверждение→блок вместимости); веб `/calendar` и `/circles` компилируются и отдают 200, но визуально в браузере ещё не отсмотрены (включая drag-and-drop планнер)
- Calendar Phase 4 (Google-синхра) — код собран и типизируется, API стартует, роуты `/integrations/google/*` замаплены, `status`/`auth-url` корректны без кредов; **живой OAuth + двусторонняя синхра НЕ протестированы** — нужны `GOOGLE_CLIENT_ID/SECRET` (регистрация OAuth-приложения в Google Cloud) + реальный Google-аккаунт. Веб-хуки требуют публичного HTTPS (в локалке — поллинг/кнопка)
- Expo mobile app — не запускался и устарел до неработоспособности: написан против контрактов самого начала проекта — не компилируется (импорт удалённого `CIRCLE_ROLE_SUGGESTIONS`), экран календаря падает на актуальном ответе API (`{items}` вместо массива), задачи шлют запрещённый `status:'done'`. Решение архревью: переписать поверх подготовительных ходов (см. «Известные риски», блок 8)

### Известные риски и фикс-план (архитектурное ревью, июнь 2026)

Полное ревью по 6 направлениям (связность модулей, БД/запросы, безопасность, веб, mobile, движки core). Фундамент подтверждён: модульный монолит + core-движки — верный выбор, дыр авторизации (IDOR) и SQL-инъекций не найдено, кошелёк — сильнейшая подсистема. Детали с file:line — auto-memory и Serena memory `project_architecture_review`. **Блоки 1–6 выполнены (2026-06-11)** — текущее состояние в «Хардненинг (архревью, блоки 1–6)» раздела «Что работает». Остаются:

7. **Прод-минимум (частично выполнен):** сделано — **`/api/v1`** (канонический префикс; `/api` — legacy-алиас через rewrite в `main.ts`; web/mobile клиенты на v1) и **`AllExceptionsFilter`** (единый конверт ошибок). Остаётся: helmet, CORS из env (сейчас захардкожен localhost в `main.ts`), `/health`, `enableShutdownHooks`, Dockerfile API, verification-токен Google-вебхука.
8. **Mobile-подготовка** (текущее приложение переписать — см. «Что ещё не протестировано»): `packages/api-client` (TokenStorage-инъекция web/RN, single-flight refresh, `X-Workspace-Id`, перенос messenger-api/entities/person-skins/query-хуков — контрактный дрейф становится невозможным); push-пайплайн (модель DeviceToken + `POST /users/me/devices` + Expo Push в `notify` по `pushByDefault` — инфры доставки сейчас НЕТ); `packages/design-tokens` (палитра живёт только в CSS веба, mobile захардкожен в чужую тёмную тему) + платформо-нейтральные поля в `CardSkinTokens` (сейчас CSS-строки) + абсолютные `effectUrl`; upload-модуль (эндпоинтов загрузки файлов нет вообще — avatar только URL); мобильные роуты зеркалят веб-пути → `actionUrl` уведомлений работает как deep link. После подготовки mobile ≈ 50–55% новой работы (в основном UI — модель Bluesky).
9. **Web-гигиена (выполнен 2026-06-11, остатки ниже):** сделано — общие RQ-ключи в `apps/web/src/lib/queries.ts` (`['contacts']`, `['circles']`, инвайты, кошелёк-бейдж; переиспользуются между страницами); `/circles` полностью на React Query с точечной инвалидацией (вместо fetchAll-шторма 6+ запросов после каждого клика); `/tasks` список на RQ; календарный `fetchMeta` — параллельно + meId из стора + contacts/circles через общий кэш; `invalidateEntities('user'/'circle')` вызывается при accept-инвайта/удалении связи/создании-удалении группы (пикеры видят новых людей без F5); `lottie-react` через `next/dynamic` + IntersectionObserver-гейт (анимация монтируется только у карточек в вьюпорте — закрыт отложенный F2); `Conversation.tsx` — композер вынесен в memo-компонент со своим draft (кейстрок больше НЕ ререндерит баблы) + `MessageBubble` под `React.memo` со стабильными хэндлерами; плитки dashboard на `next/link`. **Остатки:** `shop/page.tsx` всё ещё на старом useState-стиле (70 useState — переводить при следующей работе над магазином); виртуализация истории чата (react-virtuoso) — при росте; распил >800-строчных файлов — по ходу.

**Решения ревью (НЕ делать):** микросервисы не нужны — синхронные деньги в одной транзакции это правильный монолитный выбор (Shopify/GitHub-путь); access-движок не переписывать — модель Zanzibar верна, нужны 2 оптимизации из блока 3; SSR на вебе не нужен (приложение за логином).

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

## Как добавить новый сервис (плейбук)

> Перед стройкой — грилл дизайна. Пункты «регистрация» ниже — это и есть переиспользование движков (Принцип 1): новый сервис = тонкий модуль + регистрации, НЕ копипаста чужой логики.

1. Папка `apps/api/src/modules/<name>/`: `<name>.module.ts`, `<name>.service.ts`, `<name>.controller.ts` (+ `<name>.events.ts` для подписок на шину, `<name>.cron.ts` под Redis-локом при необходимости)
2. Prisma-модели в `apps/api/prisma/schema.prisma` + миграция (`pnpm db:migrate`)
3. `packages/shared`: `types/<name>.ts` + `validation/<name>.ts` (Zod) + `constants/<name>.ts` + экспорт в `index.ts`; определение модуля в `constants/modules.ts`
4. Зарегистрировать модуль в `apps/api/src/app.module.ts`
5. **Чек-лист переиспользования движков:**
   - права/шеринг/роли → тип ресурса в `access-schema.ts` + проекция рёбер (+ строка в `EPOCH_FANOUT`, при listObjects — в `LIST_OBJECTS_EXTRA_EXPANSION`)
   - сущность со статусами/действиями → провайдер `core/rich-cards`
   - искабельный контент → провайдер `core/search`
   - действие из чата → регистрация `core/quick-actions`
   - уведомления → типы в `NOTIFICATION_REGISTRY`, события `<name>.*` на EventBus
   - деньги → `EscrowService` со своим `refType`, синхронно в одной транзакции (НЕ через шину)
   - действия «между людьми» → `ContactsService.assertReachable` (связь + блок)
   - Группа (Circle) в сервисе — два режима, не смешивать: **назначение/приглашение** (задача на группу, звать группу на событие, чат из группы) = разворачивать в **снимок** участников на момент действия; **аудитория/видимость** (шеринг календаря/витрины/вишлиста, скины) = **живой** принципал `circle` в движке `core/access` (вступил в группу → сразу видит, вышел → сразу нет)
   - B2B-данные → chokepoint (`workspaceId`) или явный `ownerType+ownerId` + проверка прав
   - новое синхронное ребро между модулями → добавить в карту «Модульный монолит» этого файла
6. Веб-страница: React Query с общими ключами (`apps/web/src/lib/queries.ts`), люди — ТОЛЬКО `PersonChip`/`PersonAvatar` (5 карточек), пикеры — `EntitySelector`, дизайн — строго по `DESIGN.md`
7. Verify-скрипт `apps/api/scripts/verify-<name>.cjs` — попадает в CI автоматически
8. Контроллеры — тонкие (Zod parse → сервис): это же делает сервис AI-ready (Принцип 4)
9. Обновить CLAUDE.md + Serena memory + auto-memory (три уровня синхронны)
10. Мобильный экран — после переписывания mobile (этап 2 дорожной карты)

## API Endpoints (MVP)

> **Префикс:** канонический — **`/api/v1/...`** (rewrite-алиас в `main.ts`; нативные клиенты пиняются на v1, будущий ломающий v2 сможет сосуществовать). `/api/...` без версии — поддерживаемый legacy-путь (verify-скрипты, старые ссылки). Пути ниже записаны без версии для краткости.

### Auth (`/api/auth/`)
- `POST /register` — регистрация (phone, password, firstName, lastName?, dateOfBirth?)
- `POST /login` — вход (phone, password) → tokens
- `POST /refresh` — обновить токены
- `POST /logout` — выход (отзыв refresh token)
- `POST /logout-all` — выход со всех устройств

### Users (`/api/users/`)
- `GET /me` — профиль (все поля: bio, city, email, maritalStatus, socialLinks, onlineStatusMode, **cardVisibility** (одиночная, видимость по умолчанию) + **companyCardVisibility** («Видимость в Компаниях» — что видят коллеги в ростере «Сотрудники»), roles, counts, subscription)
- `PATCH /me` — обновить профиль (все поля + `cardVisibility`/`companyCardVisibility` как одиночные `CardVisibility` + Zod-валидация через `updateProfileSchema`)
- `GET /me/sessions` — активные сессии
- `DELETE /me/sessions/:id` — завершить конкретную сессию
- `DELETE /me` — запланировать удаление аккаунта (требует пароль). Грейс-период 30 дней: вход блокируется, но логин в течение 30 дней восстанавливает аккаунт; по истечении `AccountCron` безвозвратно анонимизирует (PII стирается, номер освобождается). Задачи/комментарии/воркспейсы сохраняются
- `GET /lookup?phone=...` — поиск пользователя по номеру (для формы приглашения); фамилия маскируется до инициала («Санжар Н.»), лимит 30/час

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
> Роли как в Bitrix24: **Постановщик** (creator) + **Исполнитель/Соисполнитель/Наблюдатель** (`TaskParticipant`, по одной роли на пользователя, своё под-состояние). Назначение — из окружения, на себя или на **Группу**. Приёмка пер-участник. Коины — **реальный эскроу** (см. Wallet): заморозка при создании, выплата при приёмке, возврат/отмена — рефанд.
- `GET /` — список; смарт-листы `smartList` (today/upcoming/overdue/assigned_to_me/created_by_me/on_review) + фильтры status, priority, role, search, pagination
- `POST /` — создать (`executorId` | `assignedCircleId`, `coExecutorIds`, `observerIds`, `dueDate`+`allDay`, `reminderAt`, `recurrenceRule`, `coinReward`)
- `GET /:id` — задача с участниками, прогрессом и подзадачами
- `PATCH /:id` — обновить (поля; роли/награда — только Постановщик; `status`: in_progress/cancelled)
- `DELETE /:id` — удалить (только Постановщик)
- `POST /:id/submit` — сдать свою работу (самозадача → сразу «Готово»)
- `POST /:id/accept` — принять работу участника (Постановщик; body `{ participantUserId? }`)
- `POST /:id/return` — вернуть в работу (Постановщик; body `{ participantUserId? }`)
- Чат задачи — через мессенджер: `GET /messenger/tasks/:taskId/chat` (эндпоинты `/comments` удалены вместе с `TaskComment`)

### Calendar (`/api/calendar/`) ✅
> Phase 1+2. Задачи — **виртуальный слой** (не копируются). Шеринг уровневый (Нет/Занят/Детально) по Группам (`Circle.calendarVisibility`) и персонально — решает движок `core/access` (резолв = MAX). Участники = одно общее событие + `EventParticipant` (без копий).
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
> Организация = арендатор (B2B). Личная жизнь = соц. граф (`workspaceId=null`), не организация. Роль участника — **единый источник** `UserRole(context=workspace, tenantId=workspaceId)`. Лестница: `contractor < trainee < staff < manager < admin < owner`. Один владелец + админы. Найм по номеру: приглашение (**всегда в Стажёра**, без выбора роли; опц. должность+филиал «с порога») → принятие (активация при регистрации, как в Окружении). Доступ — проверка членства/роли в сервисе (как у contacts/circles).
- `GET /` — мои организации (для переключателя; `myRole`, `membersCount` + видимые поля карточки по роли — для `CompanyCard` в «Организациях»)
- `POST /` — создать (создатель → `owner`)
- `GET /invitations/incoming` — мои входящие приглашения (карточки на dashboard; `positionName`/`branchName` для подписи)
- `POST /invitations/:invId/accept` | `/reject` — ответить (accept → членство + роль `trainee` + авто-назначение должности из приглашения)
- `GET /:id` — организация (моя роль + поля профиля/карточки с видимостью по роли: owner/admin видят всё и `cardVisibility`, сотрудники — только включённые поля; `membersCount`, `tasksCount`)
- `PATCH /:id` — обновить (admin+): name/logo + поля профиля (description/industry/city/website/contactEmail/contactPhone) + `cardVisibility` (`updateWorkspaceProfileSchema`) · `DELETE /:id` — деактивировать (владелец)
- `POST /:id/transfer` — передать владение · `POST /:id/leave` — выйти (не владелец; каскад назначений)
- `GET /:id/members` — ростер (роль из UserRole + `assignments[]` из StaffModule; закрыт от Подрядчика)
- `PATCH /:id/members/:userId` — сменить роль `{role}` (admin+; админа — только владелец; админ не трогает админов; contractor/owner вручную нельзя) · `DELETE /:id/members/:userId` — уволить (admin+; админа — только владелец; каскад назначений+tuples)
- `POST /:id/invitations` — нанять по номеру `{phone, positionId?, branchIds?[], message?}` (**manager+**, без кулдаунов; несколько филиалов → назначение на каждый при принятии) · `GET /:id/invitations` — исходящие (manager+) · `POST /:id/invitations/:invId/cancel` — отменить (manager+)

### Staff — Сотрудники: справочники и назначения (`/api/workspaces/:id/staff/`) ✅
> Справочники организации + назначения должностей. Чтение — команда (роль ≥ `trainee`; Подрядчик → 403), запись — **manager+**. Каждая операция — тонкий контроллер + Zod (AI-ready). Мутации проецируют рёбра в `core/access` (`position#holder`/`branch#member`/`department#member`+closure предков).
- `GET /` — справочники одним ответом: отделы (+`membersCount`/`positionsCount`), должности (+отдел, `holdersCount`), филиалы (+`membersCount`)
- `POST /departments` `{name, parentId?}` · `PATCH /departments/:depId` `{name?, parentId?, sortOrder?}` (цикл в дереве → 400) · `DELETE /departments/:depId` (должности отцепляются, подотделы → в корень)
- `POST /positions` `{name, departmentId?, description?}` · `PATCH /positions/:posId` · `DELETE /positions/:posId` (есть назначения → 409)
- `POST /branches` `{name, address?, note?}` · `PATCH /branches/:brId` · `DELETE /branches/:brId` (есть люди → 409)
- `POST /members/:userId/assignments` `{positionId, branchId?, status?}` — назначить должность (дубль → 409; Подрядчику → 400; событие `workspace.position.assigned`)
- `PATCH /assignments/:assignmentId` `{branchId?, status?}` — перевод между филиалами / **аттестация** `training→certified` (событие `workspace.position.certified`; Додзё позже дергает этот же путь)
- `DELETE /assignments/:assignmentId` — снять назначение

**Chokepoint (авто-скоуп по организации):** заголовок `X-Workspace-Id` → `WorkspaceContextInterceptor` проверяет членство (fail-closed 403) и кладёт активную организацию в `AsyncLocalStorage`; расширенный Prisma-клиент (`DatabaseService` через `$extends`) авто-добавляет `workspaceId` к запросам B2B-моделей (сейчас `Task`). Без заголовка — личный режим (строгий no-op). RLS не используется (как у Salesforce — защита на уровне приложения).

### Wallet — денежный реестр, счета, эскроу (`/api/wallet/`) ✅
> **Банк-грейд реестр (НЕ банк):** типизированные счета `Account` (user/issuance/escrow/fee/external; `balance`+`held` — кэш с блокировкой строки, истина в журнале), **двойная запись** в неизменяемом `LedgerTransfer` (mint = issuance→user → по валюте Σ счетов = 0; никогда не UPDATE), **двухфазные переводы** (заморозка = `pending` → `post_pending`/`void_pending`; held = Σ незакрытых pending), масштаб валюты (`Currency.scale`, целые мин. единицы), **без минусов** на user-кошельках. Эмитент полиморфен (user|workspace). Каждый выпускает ОДНУ личную валюту (имя+эмодзи) для награды за задачи и покупок; реальные деньги (пополнение из банка через внешний счёт) — на той же схеме позже. Лимит эмиссии: «на руках» ≤ 10 млн.
- `GET /` — мой кошелёк (все валюты с балансами, своя первой) · `GET /history` — история транзакций (курсор)
- `GET /currency` — моя валюта (или null) · `POST /currency` — создать · `PATCH /currency` — переименовать (1×/3 мес, ретроспективно) · `DELETE /currency` — удалить (каскадно сгорает у всех держателей; задачи живут без награды)
- `POST /currency/mint` — выпустить себе (лимит 10М «на руках») · `GET /currency/holders` — держатели моей валюты (видно только эмитенту)
- `POST /burn` — сжечь чужую валюту со своего баланса (необратимо; свою сжечь нельзя — только удалить целиком)
- **Компания (B2B, Фаза 9) ✅** — в контексте организации (`X-Workspace-Id`), только owner: `GET /company` (валюта + баланс казны) · `POST /company/currency` · `PATCH /company/currency` · `DELETE /company/currency` · `POST /company/currency/mint` (выпуск в **казну** = воркспейс-счёт) · `POST /company/pay {userId,amount}` (казна→сотрудник) · `GET /company/holders`. Эскроу обобщён: payer/beneficiary могут быть казной (`EscrowHold.payerType/beneficiaryType`, дефолт `user`) — награды за задачи компании платятся из казны, покупки в магазине компании уходят в казну. Проверено `verify-b2b-wallet.cjs` (Σ=0)

**Эскроу с Задачником** (синхронно, в одной транзакции `TasksService`↔`EscrowService` — не через EventBus): `EscrowAgreement`(refType='task', refId=taskId) + `EscrowHold` на исполнителя поверх двухфазного перевода. Создание задачи с наградой → **fund** (pending payer=создатель→beneficiary=исполнитель; нет монет/валюты → откат). Приёмка → **capture** (post_pending — выплата + `wallet.coins.received`). Возврат после приёмки → **collect-back** (вернуть с баланса исполнителя, **БЕЗ минуса** — бросает, если он уже потратил) + переморозка. Отмена/удаление → **release** (void незакрытого / возврат). Идемпотентность через статусы холдов + `idempotencyKey` переводов. Кошелёк НЕ в chokepoint. `EscrowService` домен-агностичен (ключ refType+refId) — тот же движок переиспользуют заказы Маркетплейса (мультивалюта = N ног, краудфандинг = N плательщиков на одну Сделку). Дизайн — Serena memory `project_wallet_module`.

### Messenger — мессенджер (`/api/messenger/`) ✅ (Фазы 1–7 — все в скоупе готовы)
> **Сквозная коммуникационная шина** экосистемы + встраиваемые контекстные чаты + интерактивные Rich Cards. Единый `Chat` (dm|group|context). Доступ — через движок `core/access` (`chat`: `viewer=union(this,computed(member))`): DM+группы = прямые tuples `chat#member@user`; контекстные (задача/заказ/событие) = usersets `chat#member@<task|order|event>#<role>` → роли сущности = источник истины, снятие = мгновенный **Hard Revoke**. Realtime — **socket.io** (namespace `/messenger`, JWT, комната `user:<id>`, Redis-adapter). «Прочитано» — указатель в `ChatMember` (`deliveredSeq`+`lastReadSeq`); галочки только в DM. Server-readable (не E2E). Системные сообщения (`type='system'`, `authorId=null`) НЕ в непрочитанном. B2B-готово (`Chat.workspaceId`). Per-chat `seq` через `Chat.lastSeq`. **Роли проецируются СИНХРОННО при доменной мутации** (TasksService/ShopService/getOrderChat/getEventChat), EventBus-листенер — идемпотентная подстраховка. Дизайн/фазы — Serena memory `messenger_module`.
> **Ф1 (DM):** личные диалоги (из Окружения; в контексте организации — с любым сотрудником по «рабочему пропуску», но блок уважается всегда (`alwaysCheckBlocks`); одна пара = `Chat.dmKey`, блок скрывает), галочки, ред./удал. **Ф2 (группы+задачи):** ad-hoc групповые чаты (owner|admin|member, добавление из Окружения, полная история, управление), чат задачи (заменил `TaskComment`), системные плашки, теги ролей. **Ф3 (контекст+Rich Cards):** чат заказа (`order` ресурс; обычный — по кнопке, краудфандинг — авто со вкладчиками) и чат события (`event` ресурс; организатор+участники); лот — БЕЗ чата (кнопка «Поговорить» → DM с продавцом + карточка товара); **Rich Cards** — переиспользуемый модуль `core/rich-cards` (реестр `тип→рендер` + `действие→обработчик+способность`, один эндпоинт execute с перепроверкой прав, карточка обновляется на месте; путь Slack Block Kit / MS Adaptive Cards); скрепка 📎 в чате + «Переслать в чат» на страницах задач/событий/лотов. **Ф4 (присутствие):** онлайн/оффлайн + «был(а) в сети» (Redis presence-ключ + heartbeat, мультиинстанс), «печатает…» (везде, в группах мультиимя), **контекстный статус** «На <событие> до HH:MM» из календаря (наследует уровень доступа календаря зрителя: detailed=с названием, busy=«Занят», none=скрыт). Приватность: `onlineStatusMode` (всем/контактам/никому) + взаимность (скрыл свой → не видишь чужой); зелёная точка — только в DM. `GET /messenger/presence?userIds=` (на зрителя), socket `presence:changed`/`typing` + клиент `heartbeat`/`typing:start|stop`. **Ф5 (Mentions Hub):** @-упоминание = **пикер по имени → токен `@[Имя](userId)`** в тексте (у пользователей нет @-ника; парсер/токен в `@superapp/shared`). Запись — best-effort при `sendMessage`/`editMessage`: парс → **security-фильтр «только активные участники чата»** (форж чужого id игнорируется) → дроп себя → отдельная таблица `Mention` (`@@unique([messageId, mentionedUserId])` → правка не дублит, ре-edit нотифит только НОВЫХ) → уведомление `mention.received`. Лента «упоминания обо мне» (курсор, `unreadCount`), mark-read (скоуп на себя; пусто = все). Источник-агностично (`sourceType` messenger|task|calendar|listing — пока продюсит только messenger). Веб: @-автокомплит в композере, чипы упоминаний (свои — primary, чужие — secondary), страница `/mentions` (лента + бейдж + «Прочитать все» + дип-линк), бейдж в навбаре; клик по чат-упоминанию → `/messenger?chat=&msg=` со скроллом-к-сообщению + флэш.
- `GET /messenger/chats` · `POST /messenger/chats/dm` `{userId}` · `POST /messenger/chats/group` `{name,memberIds}` · `GET/PATCH/DELETE /messenger/chats/:id` · `POST /messenger/chats/:id/members` · `DELETE /messenger/chats/:id/members/:userId` · `POST /messenger/chats/:id/leave` · `POST /messenger/chats/:id/admins/:userId` `{admin}`
- `GET /messenger/tasks/:taskId/chat` · `GET /messenger/orders/:orderId/chat` · `GET /messenger/events/:eventId/chat` — get-or-create контекстный чат (доступ по `*.view`)
- `GET /messenger/chats/:id/messages?before=<seq>` · `POST .../messages` `{content}` · `PATCH /messenger/messages/:id` · `DELETE /messenger/messages/:id` · `POST /messenger/chats/:id/read` `{seq}`
- **Rich Cards** (`/api/rich-cards/`): `GET /:refType/:refId` — живая карточка для зрителя (кнопки фильтруются по правам+статусу) · `POST /:actionKey/execute` `{ref,payload?}` — выполнить (перепроверка способности → обновлённая карточка) · `POST /share` `{chatId,refType,refId}` — кинуть карточку в чат. Ключи: order.confirm/reject/cancel/refund, listing.buy/talk, crowdfunding.contribute/withdraw, task.accept/return/take, event.rsvp_accept/decline/tentative
- `GET /messenger/presence?userIds=a,b,c` — присутствие на зрителя (online/lastSeen/contextual с учётом приватности+уровня календаря)
- **Mentions Hub (Ф5):** `GET /messenger/chats/:id/mentionable?q=` — участники чата для @-пикера (кроме себя, по `chat.view`) · `GET /mentions?cursor=` — лента «обо мне» (+`unreadCount`, `nextCursor`) · `POST /mentions/mark-read` `{ids?}` (пусто = все). Уведомление `mention.received`
- **Поиск (Ф6, движок `core/search`):** `GET /search?q=` — глобальный сгруппированный (Чаты/Люди/Сообщения) · `GET /search?q=&chatId=` — поиск-в-чате (постранично) · `GET /search?q=&type=&cursor=` — страница одного типа. Обрезка по правам, FTS+trigram, дип-линк `/messenger?chat=&msg=`
- **Быстрые действия + отложенные (Ф7, движок `core/quick-actions`):** `GET /quick-actions?chatId=&scope=composer|message` — кнопки ＋-меню/меню-сообщения (по правам+типу чата). Цитата: `POST .../messages {content, replyToId?}` (только из этого чата) → `replyTo` в `ChatMessage`. Отложенные: `GET/POST /messenger/chats/:id/scheduled` · `PATCH/DELETE /messenger/scheduled/:id` (крон раз в минуту шлёт от автора + пинг `messenger.scheduled.sent`)
- WebSocket (`/messenger`): сервер→клиент `message:new`/`message:updated`/`message:deleted`/`receipt`/`presence:changed`/`typing`; клиент→сервер `message:delivered`/`message:read`/`heartbeat`/`typing:start`/`typing:stop`
- Web: `/messenger` (двухпанельный, группы+управление, контекстные чаты, Rich Card-виджеты с кнопками + «Поделиться» + 📎-пикер, системные плашки, **онлайн-точка/«печатает»/контекст в шапке**), чат встроен в задачу; на `/shop` — «Поговорить» на лоте + «Обсудить» на заказе; присутствие — в списке чатов, шапке диалога, карточке Окружения. Проверено e2e: `verify-messenger.cjs` 29/0 · `-socket` 10/0 · `-group` 31/0 · `-task` 19/0 · `verify-richcards.cjs` 29/0 · `verify-messenger-presence.cjs` 16/0 (online/offline, typing, контекст busy/detailed, приватность+взаимность, lastSeen) · `verify-mentions.cjs` 18/0 (пикер=участники, security-фильтр форжа, нотиф, дедуп правки, mark-read скоуп, дип-линк) · `verify-search.cjs` 22/0 (индексация send/edit/delete, FTS-словоформы, чаты/люди, **обрезка по правам** + visibleFromSeq, область-в-чате, дип-линк, recency-пагинация, центрированный сниппет, опечатки trigram) · `verify-quickactions.cjs` 20/0 (реестр+права+scope, цитата+кросс-чат 400, отложенные: план/список/валидация/доступ/правка/отмена + **крон реально отправил** + пинг автору); web tsc чист; браузер (2 сессии) — «печатает»↔«в сети» + зелёная точка, 0 ошибок консоли. **Веб фаз 5–7 (упоминания, поиск, быстрые действия) визуально в браузере НЕ отсмотрен** (расширение Chrome не подключено; код вычитан, payload’ы сверены, типизируется).
> **Ф6 (Поиск):** единый движок `core/search` (переиспользуемый, как `core/access`/`rich-cards`; @Global, НЕ в chokepoint). Индекс-витрина `SearchDocument` = проекция доменных таблиц (хуки send/edit/delete + крон-сверка + бэкфилл `scripts/backfill-search.cjs`); Postgres FTS `tsvector('russian')` (словоформы) + `pg_trgm` GIN (опечатки/имена/подстроки; без `unaccent` — он ломал бы каз. буквы). Реестр провайдеров (индексные/живые). Мессенджер подключил: `message` (индекс; обрезка по активному ChatMember + `seq>=visibleFromSeq` в SQL), `chat`+`person` (живые запросы по членству/окружению). Глобальный режим = relevance + лимит на тип; in-chat/страница = recency keyset. Сниппет центрируется на совпадении; типо-порог `word_similarity` 0.4 (через `SET LOCAL`). Будущие сервисы (Задачи/Календарь/Вишлист/Маркетплейс) добавляются провайдером — глобальный кросс-сервисный поиск «загорится» сам.
> **Ф7 (Быстрые действия и отложенные сообщения):** вместо слэш-команд — кнопки (как у гигантов), через переиспользуемый реестр `core/quick-actions` (сервисы регистрируют действие {ключ,ярлык,иконка,scope,право}; меню «＋» и меню сообщения строятся из реестра по правам+типу чата; форма = модалка, результат = Rich Card). Действия: **Создать задачу** (Задачник; из сообщения → в описание), **Событие** (Календарь), **Напомнить = отложенное сообщение** (мессенджер; `ScheduledMessage` + крон шлёт от автора + пинг). **Цитата/ответ** — нативная (`Message.replyToId`, только из этого чата, клик-переход с подсветкой). Бенчмарк: Slack Shortcuts / Teams message-actions. Будущие сервисы добавляют кнопку одной регистрацией.
> **Все фазы мессенджера в скоупе (1–7) завершены** (решение 2026-06-01: делаем только 6 и 7; ~~8 Центр уведомлений~~/~~9 вложения~~/~~10 mobile~~ — вне хвоста мессенджера). Чистка кодовой базы выполнена, фикс-план архревью закрыт (блоки 1–6, 9; хвост 7 — фоном); текущий приоритет — **новые сервисы** (см. «Дорожная карта»). Грилл был перед каждой фазой.

### My Wish & Shop — магазин/витрины/заказы (`/api/shop/`) ✅ (Фазы 2–9, все фазы)
> Каталог + покупка с эскроу. 1 магазин на владельца (user|workspace, лениво). Витрины (`Showcase`) шерятся по людям/Группам Circle — решает движок `core/access` (как Календарь). B2B — явное владение + проверка прав (НЕ chokepoint). Управление и staff — тоже через движок. **Цена лота — кросс-валютная (Ф5): N строк в своей валюте и/или валютах людей из окружения** (нет ни одной → 400).
- `GET /` — мой магазин + витрины · `GET /accessible` — чужие магазины, доступные мне (переключатель) · `GET /of/:ownerId` — магазин человека (только доступные витрины) · `GET /currencies` — валюты для цены лота (своя + валюты контактов из окружения)
- `POST /showcases` · `PATCH /showcases/:id` · `DELETE /showcases/:id` · `GET /showcases/:id/listings` — товары витрины (с учётом доступа)
- `POST /showcases/:id/shares` (principalType user|circle) · `DELETE /showcases/:id/shares/:principalType/:principalId`
- `POST /listings` · `PATCH /listings/:id` · `DELETE /listings/:id` — цена: `prices:[{currencyId,amount}]` (кросс-валюта) или `priceAmount` (быстрый ввод в своей валюте); update заменяет всю цену
- `GET /staff` · `POST /staff` (scope shop|showcase) · `DELETE /staff/:userId?scope=&showcaseId=`
- **Заказы (Фазы 3–5):** `POST /listings/:id/buy` (покупатель с `showcase.view` + держит ВСЕ валюты цены; морозит N эскроу-ног атомарно — не хватает любой → 400, полный откат) · `GET /orders` (мои) · `GET /orders/incoming` (на мои витрины) · `POST /orders/:id/confirm` (списывает все ноги владельцу по типу; материальное «с задачей» → создаёт задачу, списание при приёмке покупателем) | `/reject` | `/cancel` (покупатель) | `/refund` (владелец — вернуть «в работе»). Эскроу `refType='order'`, одна нога на валюту (payer=покупатель→beneficiary=владелец); цена заказа — снимок `OrderPrice[]`; материальное «с задачей»→Задачник, нематериальное→Календарь
- **Краудфандинг (Фаза 6):** `POST /listings/:id/contribute` (вклад `contributions:[{currencyId,amount}]` — найти/создать кампанию, заморозить N ног; превышение остатка/нет валюты → 400) · `POST /orders/:id/withdraw` (отозвать свой вклад, пока `funding`) · `GET /orders/:id` (деталь: прогресс по валютам + вкладчики). Кампания = `Order` `crowdfunding`+статус `funding`→`pending` (собрана по всем валютам)→`confirm`; **топ-вкладчик = Постановщик** авто-задачи, остальные = Наблюдатели (событие — всем); `buy()` на краудфандинг-лоте → 400
- **Лимиты/время/FOMO (Фаза 7):** на тех же `buy`/`contribute` — штучный запас `stockLimit` (атомарный резерв, оверселл-безопасно), окно `availableFrom`/`availableUntil` (вне окна → 400), FOMO `discountPercent`/`discountUntil` (эффективная цена ×(1−%) вниз — в снимке заказа/цели). `ShopCron` (Redis-лок, каждые 30 мин) авто-архивирует лоты после окна и возвращает просроченные недособранные кампании (`Order.expiresAt`). Новых эндпоинтов нет — поля лота задаются в `POST/PATCH /listings`
- **Wishlist (Фаза 8):** `GET/POST /wishes` · `PATCH/DELETE /wishes/:id` · `POST /wishes/:id/fulfill` (вручную) · `POST /wishes/:id/copy` (чужую хотелку → лот в моей витрине: `showcaseId` или `newShowcaseName` + `prices`/`crowdfunding`/лимиты; авто-шер витрины владельцу хотелки) · `POST /wishes/shares` + `DELETE /wishes/shares/:type/:id` (шеринг вишлиста, как витрины) · `GET /wishlists/accessible` · `GET /wishlists/of/:ownerId`. Хотелка (`WishItem`: тип+ссылка, без цены) auto-«исполнено» когда лот с `sourceWishItemId` завершается

### Card Skins — скины карточки (`/api/card-skins/`) ✅
> Платформенная косметика для PersonCard. **Скин = ДАННЫЕ** (токены оформления + слои: рамка/фон/эффект). `CardSkin` (тип: токены, редкость, цена, тираж/окно) + `CardSkinInstance` (экземпляр — «реальная вещь»: серийник у лимиток, `CardSkinTransfer` история передач под будущий трейд). Покупка — за **платформенную валюту** (`Currency.issuerType='platform'`, лениво создаётся) через двойную запись Ledger (покупатель→системный счёт платформы, Σ=0), мгновенно (эскроу — позже, для трейда). Резерв тиража оверселл-безопасен (атомарный `UPDATE ... WHERE minted < supply`). **Надевание:** один дефолтный скин всем (даже бесплатно) + разные скины на группы (**премиум**; конфликт → группа выше по `sortOrder`; премиум истёк → дефолт, настройки сохраняются). 6 тиров (редкость видна только в XL). Эффекты — встроенные CSS-пресеты (`tokens.effectPreset`: petals/neonGlow/sparkle), Lottie через `effectUrl` — позже; уважается `prefers-reduced-motion`. `authorId` скрыт в UI (ручной, для коллабов). 3 стартовых скина (`scripts/seed-card-skins.cjs`): Цветочный/Мятая бумага/Ретро-неон. НЕ в chokepoint (личная косметика). Проверено e2e (`verify-cardskins.cjs` 23/0: покупка, серийник, распродано, премиум-гейт, резолв по группам+конфликт+откат, Σ=0) + браузер.
- `GET /catalog` — каталог (доступность/владение/остаток тиража) · `GET /wallet` · `POST /wallet/topup {amount}` (ТЕСТ-пополнение; реальная оплата позже)
- `POST /:skinId/buy` — купить (списывает валюту, выдаёт экземпляр+серийник) · `GET /inventory`
- `GET /equip` · `PUT /equip/default {instanceId|null}` · `PUT /equip/group {circleId, instanceId|null}` (премиум)
- `GET /resolve?userIds=a,b,c` — скины, видимые зрителем на карточках людей (слой для грида «Окружение»)

### Processes — бизнес-процессы на канвасе (`/api/workspaces/:id/processes/`) ✅ (Фаза 1)
> Нодовый движок БП. Документ-канвас (nodes+edges+анкета) — источник правды; публикация компилирует в план; запущенный инстанс прикноплен к версии. Чтение/запуск — команда (trainee+), правка — manager+, `visibility='admins'` — только admin+. Каждая операция — тонкий контроллер + Zod (AI-ready).
- `GET /` — процессы организации (фильтр видимости) · `POST /` — создать (manager+; черновик Старт→Конец)
- `GET /node-types` — палитра нод (паспорта: outputs+fields+tier; system-ноды — только `platform_admin`)
- `GET /:defId` — документ последней версии + мягкая валидация (issues) + versions · `PATCH /:defId` — имя/описание/`visibility`
- `PUT /:defId/document` — сохранить канвас (правка published → авто-черновик v+1; возвращает issues) · `POST /:defId/validate`
- `POST /:defId/publish` — опубликовать (0 issues + исполнители-члены; активна одна версия) · `DELETE /:defId` — архив (бегущие → 409)
- `POST /:defId/start` `{input}` — запустить (анкета типизируется/required по форме версии) → инстанс
- `GET /:defId/report` — отчёт «время по шагам/отделам» (manager+; avg/max/раз по нодам + среднее время процесса)
- `GET /inbox` — мои «Входящие»: задачи моих отделов в очереди (забрать) + одобрения на мне
- `GET /instances?definitionId&status` — журнал (manager+ все; рядовой — свои+где исполнитель) · `GET /instances/:instId` — шаги/тайминг/канвас версии · `POST /instances/:instId/cancel` — отмена (инициатор|manager+; открытые задачи отменяются)
- `POST /instances/:instId/steps/:stepId/claim` — забрать задачу отдела из очереди (член отдела) → создаётся задача · `POST /instances/:instId/steps/:stepId/decide` `{decision}` — решение по одобрению · `POST /instances/:instId/steps/:stepId/reassign` `{userId}` — переназначить исполнителя (manager+)
- **Ф3:** `GET/POST /:defId/triggers` · `PATCH/DELETE /:defId/triggers/:trigId` — триггеры событие/расписание/вебхук (manager+) · `GET/POST /credentials` · `DELETE /credentials/:credId` — сейф кредов (manager+, без секретов) · `POST /processes/webhook/:token` (**@Public**) — внешний вебхук-триггер (тело→анкета) · `POST /processes/webhook/telegram/:token` (**@Public**) — приёмник Telegram-апдейтов (сообщение боту → процесс; всегда 200)
> Связь с Задачником: нода «Задача человеку» создаёт реальную задачу; полное принятие → `TasksService` синхронно дергает `'ProcessesService'.onTaskCompleted` (ModuleRef-токен, как `'ShopService'`) + EventBus-листенер и `ProcessesCron` (Redis-лок, */2 мин) — идемпотентные подстраховки.

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
