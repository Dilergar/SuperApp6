# Карта связей модулей (module graph)

> Кто кого зовёт СИНХРОННО и почему. **Добавил ребро между модулями — опиши его здесь** (точную таблицу рёбер генерирует `pnpm check:docs --write` → [module_graph_edges.md](module_graph_edges.md)). Часть 2, документная вертикаль — [module_graph_documents.md](module_graph_documents.md); шина — [event_bus.md](event_bus.md).

## Правила связей

1. **Синхронно (инъекция сервиса)** — когда нужна атомарность (деньги в одной `$transaction`), консистентное чтение или security-обязательный эффект.
2. **EventBus** — только то, что допустимо потерять; обязательная фоновая работа — `core/jobs` (`enqueue(tx, …)` в транзакции мутации). Подробно — [event_bus.md](event_bus.md).
3. **Циклы** закрываются ленивыми ModuleRef-токенами. Все строковые токены — в манифесте `apps/api/src/shared/di-tokens.ts` (`DI_TOKENS`, 11 шт.: Messenger / Calendar / Shop / Processes / Finances / Office / Staff / Workspaces / RichCards / Documents / Hr). Потребители ссылаются на манифест (опечатка = ошибка компиляции); `AppModule.onApplicationBootstrap` smoke-проверяет резолв КАЖДОГО токена и валит старт при пропаже провайдера. Кто какой токен зовёт — в генерируемой таблице [module_graph_edges.md](module_graph_edges.md) (пометка «токен»).
4. **Движки (`core/*`) не импортируют фичи.** Обратное направление — только реестры (`FilesRefRegistry`, `CallsRefRegistry`, `ChatterRefRegistry`, `CalendarLayersRegistry`, `DriveRoutingRegistry`, `ShareLinksRegistry`, `SignRegistry`, `ApprovalsRegistry`, `TemplateFieldRegistry`, `PersonalGraphRegistry` и т.д.): фича регистрирует резолвер/провайдер в своём `onModuleInit`.
   **Известные нарушения (записанный долг, не норма — [roadmap.md](roadmap.md), «Границы движков»):** семь движков (`approvals`, `auth`, `calls`, `files`, `share-links`, `sign`, `users`) → `modules/notifications` — до появления движка `core/notifications`; `core/users` → `modules/contacts`, `modules/workspaces` — решение не выбрано; `core/rich-cards` → `modules/messenger` (ленивый токен: карточка в чат) — решается вместе с `core/notifications`. Новых рёбер `core/* → modules/*` не добавлять: страж `scripts/check-docs.cjs` знает ровно этот список и роняет CI на любом другом. Точная таблица всех рёбер генерируется из кода — [module_graph_edges.md](module_graph_edges.md).

## Карта синхронных рёбер (по потребителям)

### Auth / Users
- `AuthService` → `VerifyService.consume(tx)` (пропуск SMS-кода в транзакции создания юзера / сброса пароля); → `JobsService.enqueue(tx)` джоба `users.phone.invitations` (активация внешних приглашений по номеру; обработчик — в `core/users`); → `NotificationsService` (прямой `notify` «Пароль изменён» — БЕЗ await на критическом пути: упавшая лента не роняет смену пароля).
- `UsersService` → `VerifyService.consume(tx)` (смена пароля — 1 пропуск; смена номера — 2 пропуска old+new в одной tx); → `ContactsService` + `WorkspacesService` (обработчик джоба `users.phone.invitations`: активация pending-приглашений подтверждённого номера — ребро core→modules, записанный долг); → `FilesService` (аватар); → `AccessProjectionService`; → `NotificationsService`.

### Социальный граф
- `CirclesService` → `ContactsService` — рендер участников группы.
- **Разрыв связи / блок** — `ContactsService` → `PersonalGraphRegistry.fireUnlinked(a, b)` СИНХРОННО в цепочке разрыва → хуки сервисов, выдававших гранты «человеку из окружения»: `finances` (`revokeSharesBetween`), `calendar`, `shop`, `drive`. Реестр — `apps/api/src/modules/contacts/personal-graph.registry.ts`; регистрация — `PersonalGraphRegistry.register('<сервис>', {onUnlinked})` в `onModuleInit` потребителя. DI-токен `FinancesService` в этом пути не участвует. Шина `contact.removed/blocked` (`FinancesEvents`) — второй ремень, ночной `FinancesCron.sweepShares` — третий.

### Задачи
- `TasksService` → `EscrowService` (эскроу награды в одной транзакции); → `MessengerService` (синхронная проекция участников чата задачи); → `DI_TOKENS.ShopService` (settlement заказа «с задачей» при завершении fulfilment-задачи; `ShopEvents` на `task.completed` — второй ремень); → `DI_TOKENS.ProcessesService` (`onTaskCompleted` при полном принятии задачи-шага; `onTaskCancelled` → процесс в error; шина `task.*` + крон-сверка wait-шагов — идемпотентные подстраховки).

### Календарь (направление ПЕРЕВЁРНУТО)
- Календарь чужие модули НЕ импортирует. `TasksModule`/`FinancesModule` → `CalendarModule`: провайдеры регистрируют слои `tasks`/`finance` в `CalendarLayersRegistry` (onModuleInit). `CalendarService.getRange` идёт по реестру; слой без провайдера тихо пропускается.
- `CalendarService` → `JobsService`/`JobsRegistry` (джоб напоминаний); → `AccessService` (уровни busy/detailed); → `ContactsService.assertReachable` + `PersonalGraphRegistry.register('calendar')`; → `ResourcesService` (брони ресурсов); → `QuickActionRegistry`; → `NotificationsService`.

### Процессы
- `ProcessesService` → `ProcessEngineService`; → `ApprovalsService` (шаг согласования = «Ждут решения»); → `ChatterService`; → `RolesService`.
- `ProcessEngineService` → `TasksService.createTask` (нода «Задача человеку» создаёт настоящую задачу; `skipEnvironmentChecks` — членство движок проверил сам); → `ApprovalsService`; → `NotificationsService` (нода «Уведомить», итоги процесса). Из нод — ленивыми токенами `DI_TOKENS`: Messenger (сообщение/карточка в чат — `process-action-nodes.ts`), RichCards, Staff (аттестация), Workspaces (резолв членов/ролей), Finances (`recordOperationForBook` — книга организации), Documents (`process-document-nodes.ts`: номер, подшивка, приказ из заявления), Hr (`process-hr-nodes.ts`: `hr.apply`, `hr.esutd`), Processes (нода «под-процесс»).
- `ProcessApprovalsProvider` → `ApprovalsRegistry.register` (решение шага возвращается в движок). `ProcessTriggersService` подписывается на шину динамически по каталогу триггеров — [event_bus.md](event_bus.md).

### Финансы
- `FinancesService` → `ContactsService.assertReachable` («на кого»/шеринг) + `PersonalGraphRegistry.register('finances')`; → `NotificationsService` (лимиты, долги, доступ); → `AccessService` (finbook viewer/editor).

### Магазин
- `ShopService` → `TasksService` + `CalendarService` + `EscrowService` (исполнение заказа) — самый связанный модуль.
- `ShopRichCardsProvider` → `MessengerService` (`openDm`/`postRichCard` — карточка заказа в DM), `RichCardsService`, `FilesService`.
- `CardSkinsService` → `LedgerService` (покупка скина).

### Организации / Сотрудники
- `WorkspacesService` → `StaffService` (ростер с назначениями, каскад при увольнении/выходе, назначение «с порога» в одной tx с членством); → `PaymentCardsService` (WalletModule) — основная карта сотрудника батчем (`primaryCardsFor`; расшифровка PAN живёт только в сервисе карт); → `ApprovalsService.releaseUserFromWorkspaceSteps` (`removeMember`/`leaveWorkspace` снимают человека с активных шагов «Ждут решения»); → `DI_TOKENS.OfficeService` (каскад увольнения: участия во встречах + чаты встреч); → `FilesService` (логотип); → `ChatterService` + `ChatterRefRegistry`; → `RolesService`.
- `WorkspaceShareLinksController` → `ShareLinksService` (ссылки организации); `WorkspacesTemplateFieldsProvider` → `TemplateFieldRegistry` (реквизиты организации в шаблоны).

### «Между людьми» — единый гейт
- `MessengerService` / `PresenceService` / `TasksService` / `CalendarService` / `ShopService` → `ContactsService.assertReachable` — контекстный гейт: личный режим = связь + нет блока в обе стороны; контекст организации = со-членство по командным ролям trainee+ («рабочий пропуск»; DM передаёт `alwaysCheckBlocks`). «Подрядчик» (contractor) изолирован. `{personalOnly:true}` — для ЛИЧНЫХ ресурсов (книга, календарь, витрина, вишлист). `filterReachable` — не бросающая версия для фоновых путей.
- `MentionsService` / `ScheduledMessageService` → `NotificationsService` напрямую.

### Файлы и их потребители
- `MessengerService` / `ShopService` / `TasksService` → `FilesService` + `FilesRefRegistry` — вложения: регистрация refType-резолвера в onModuleInit (`chat_message`/`listing`/`task`), линковка `linkFile`/`linkManyInTx`, чтение `listLinked`; `FilesScanHook` → `NotificationsService` (заражённый файл).

### Офис / Звонки
- `OfficeService` → `CallsService`/`CallsRefRegistry` (резолвер `office_room`: canJoin=команда trainee+, canModerate=host∥manager+, `onJoinAuthorized` — синхронная материализация участника); → `MessengerService` (чат встречи); → `NotificationsService`. Carve-out: офис читает таблицы движка `call_sessions`/`call_session_participants` напрямую («идёт сейчас»), мессенджер читает `officeRoom`; `OfficeSystemListener` в мессенджере слушает `office.room.*` + `call.session.*` → системные плашки.
- `MessengerService` → `CallsRefRegistry.register('chat')` (DM-дозвон, группы-баннеры) и → `CallsService.getActiveForRefs/listActiveByRefType` (activeCall в DTO чатов — от чатов пользователя, не всей платформы); `ChatCallsListener` слушает `call.*` с фильтром `refType==='chat'` → `call:state` + плашки итогов.
- `CallsRecordingService` (core/calls) → `FilesService.ingestLocalFile` (headless-инжест файла записи) и → `NotificationsService`; `RecorderService` → `CallsRecordingRegistry.register('chat')` — доставка записи звонка каждому клейманту в Диктофон.

### Голос
- `VoiceService` (core/voice) → `FilesService` (`getMeta` — доступ, `openRawStream`/`localPathFor` — байты, `listLinksOfFile` — привязки в payload событий).
- `RecorderService` → `FilesService`/`FilesRefRegistry` (refType `voice_recording`) и → `VoiceService` (`getStatusesForFiles`, `deleteForReapedFiles`); `RecorderEvents` → `NotificationsService`.

### Хроника / Джобы (движки как потребители друг друга)
- `TasksService`/`WorkspacesService`/`StaffService` → `ChatterService.log(tx,…)` — синхронно в транзакции мутации; мессенджер регистрирует chat-sink (`ChatterChatSink` → `registerChatSink('task')`); плашки чатов производит джоб `chatter.chatpost` (core/jobs), поставленный в той же tx; `ChatterService` → `RolesService` (гейт журнала).
- `ChatterService` → `JobsService.enqueue(tx)`; `ScheduledMessageService` → `enqueue(tx)` + `register('messenger.scheduled.fire')`; `NotificationsDispatch` → `register('notifications.dispatch')`; ~40 сайтов 6 модулей (contacts/tasks/calendar/workspaces/staff/shop) → `NotificationsService.emitEvent` (шина + джоб). Рёбра движков подписи/ссылок/согласований/шаблонов — [module_graph_documents.md](module_graph_documents.md).

## Carve-out map (допустимые прямые чтения чужих таблиц)

Для монолита допустимо; список — граница будущего выделения сервисов:
- Messenger и его листенеры читают `task` / `order` / `calendarEvent` напрямую.
- `core/quick-actions` читает `chat`.
- Office и `OfficeRichCardsProvider` читают `call_sessions` / `call_session_participants` (живой счётчик); мессенджер читает те же таблицы для `activeCall` чатов (`chat-calls.listener.ts`, `messenger.service.ts`).
- Мессенджер читает `officeRoom` (чат/roleLabels).

## Проверка

Смоук DI-токенов — на bootstrap (валит старт при пропаже провайдера). Рёбра покрыты сьютами соответствующих модулей ([testing_verify_suite.md](testing_verify_suite.md)). Сверка карты с кодом — `pnpm check:docs`: генерирует [module_graph_edges.md](module_graph_edges.md) из импортов и роняет CI на новом ребре движок → фича.
