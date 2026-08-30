# Карта связей модулей (module graph)

> Источник правды о том, кто кого зовёт. **Правило: добавил новое синхронное ребро между модулями — добавь его сюда.** Два вида связей: синхронные вызовы (атомарность/консистентность) и EventBus (сайд-эффекты, которые можно потерять).

## Правила связей

1. **Синхронно (инъекция сервиса)** — когда нужна атомарность (деньги в одной `$transaction`), консистентное чтение или security-обязательный эффект.
2. **EventBus** (`shared/events/event-bus.service.ts`, Redis Streams + consumer group, XAUTOCLAIM подбирает зависшие, MAXLEN 100k) — семантика **at-most-once** (ack до выполнения) + emit НЕ транзакционен с БД (dual-write). Следствия:
   - **деньги и обязательные операции на шину не класть** — только синхронно в транзакции;
   - обязательная фоновая работа — `core/jobs` (`enqueue(tx, …)` в транзакции мутации);
   - шина годится для: подстраховок-сверок, плашек-листенеров, google-sync, сигналов другим подсистемам.
3. **Циклы** закрываются ленивыми ModuleRef-токенами. Все строковые токены — в манифесте `apps/api/src/shared/di-tokens.ts` (`DI_TOKENS`, 11 шт.: Messenger / Calendar / Shop / Processes / Finances / Office / Staff / Workspaces / RichCards / Documents / Hr). Потребители ссылаются на манифест (опечатка = ошибка компиляции); `AppModule.onApplicationBootstrap` smoke-проверяет резолв КАЖДОГО токена и валит старт при пропаже провайдера.
4. **Движки (`core/*`) не импортируют фичи.** Обратное направление — только реестры (`FilesRefRegistry`, `CallsRefRegistry`, `ChatterRefRegistry`, `CalendarLayersRegistry`, `DriveRoutingRegistry`, `ShareLinksRegistry`, `SignRegistry`, `ApprovalsRegistry`, `TemplateFieldRegistry`, `PersonalGraphRegistry` и т.д.): фича регистрирует резолвер/провайдер в своём `onModuleInit`.

## Карта синхронных рёбер (по потребителям)

### Auth / Users
- `AuthService` → `ContactsService`, `WorkspacesService` — активация external-приглашений при регистрации; → `VerifyService.consume(tx)` (пропуск SMS-кода в транзакции создания юзера / сброса пароля); → `NotificationsService` (прямой `notify` «Пароль изменён» — БЕЗ await на критическом пути: упавшая лента не роняет смену пароля).
- `UsersService` → `VerifyService.consume(tx)` (смена пароля — 1 пропуск; смена номера — 2 пропуска old+new в одной tx); → `NotificationsService`; → `ContactsService`+`WorkspacesService` (активация pending-приглашений нового номера — джобом `users.phone.invitations`, поставленным в той же tx).

### Социальный граф
- `CirclesService` → `ContactsService` — рендер участников группы.
- `ContactsService` → `DI_TOKENS.FinancesService` — **СИНХРОННЫЙ** отзыв finbook-грантов при удалении связи/блоке (security-обязательный эффект; шина `FinancesEvents` — второй ремень, ночной свип `FinancesCron.sweepShares` — третий).
- `PersonalGraphRegistry` (`modules/contacts/personal-graph.registry.ts`) — обратные хуки: сервис, выдавший грант «человеку из окружения», регистрирует `{onUnlinked(a,b)}`; граф зовёт хуки синхронно при разрыве связи/блоке. Потребители: finances, calendar, shop, drive.

### Задачи
- `TasksService` → `EscrowService` (эскроу награды в одной транзакции); → `MessengerService` (синхронная проекция участников чата задачи); → `DI_TOKENS.ShopService` (settlement заказа «с задачей» при завершении fulfilment-задачи); → `DI_TOKENS.ProcessesService` (`onTaskCompleted` при полном принятии задачи-шага; `onTaskCancelled` → процесс в error; шина `task.*` + крон-сверка wait-шагов — идемпотентные подстраховки).

### Календарь (направление ПЕРЕВЁРНУТО)
- Календарь чужие модули НЕ импортирует. `TasksModule`/`FinancesModule` → `CalendarModule`: провайдеры регистрируют слои `tasks`/`finance` в `CalendarLayersRegistry` (onModuleInit). `CalendarService.getRange` идёт по реестру; слой без провайдера тихо пропускается.

### Процессы
- `ProcessEngineService` → `TasksService.createTask` (нода «Задача человеку» создаёт настоящую задачу; `skipEnvironmentChecks` — членство движок проверил сам); → `NotificationsService` (нода «Уведомить», итоги процесса).
- Нода «Финансы: записать операцию» → `DI_TOKENS.FinancesService` (`recordOperationForBook` — книга организации, лениво).

### Финансы
- `FinancesService` → `ContactsService.assertReachable` («на кого»/шеринг); → `NotificationsService` (лимиты, долги, доступ); → `AccessService` (finbook viewer/editor).

### Магазин
- `ShopService` → `TasksService` + `CalendarService` + `EscrowService` (исполнение заказа) — самый связанный модуль.
- `CardSkinsService` → `LedgerService` (покупка скина).

### Организации / Сотрудники
- `WorkspacesService` → `StaffService` (ростер с назначениями, каскад при увольнении/выходе, назначение «с порога» в одной tx с членством); → `PaymentCardsService` (WalletModule) — основная карта сотрудника батчем (`primaryCardsFor`; расшифровка PAN живёт только в сервисе карт).

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

### Документы (core/docs)
- `DocsService` → `FilesService` (`replaceContent`, `linkSystemInTx`, `canEditContentVia`/`canViewFile`/`hasLink`, `openRawStream`) + `FilesRefRegistry` (резолверы `document`/`document_version`; canView — ТОЛЬКО явные гранты, иначе кольцо «файл → документ → файл»); → `AccessService` (тип `document`); → `ChatterService` (оживление файла — запись в хронику места + плашка в чат); → `JobsService`/`JobsRegistry` (очередь `docs`). Обратно — только реестр: `MessengerService` и `TasksService` объявили предикат `canEditContent` в своих `FileRefResolver`.

### Диск
- `DriveService`/`DriveTreeService`/`DriveVersionsService` → `FilesService` (`linkSystemInTx` — НАСТОЯЩАЯ связь `drive_node` (дом файла), `copyFile`, `replaceContent`, `systemDeleteFile`, `buildAttachmentViews`) + `FilesRefRegistry` (резолвер `drive_node` с явным `canEditContent` + наблюдатель привязок `registerLinkObserver`); → `AccessService` (`grantSetFor` + grant/revoke; `check()` для типов Диска НЕ используется); → `RolesService`; → `JobsService` (очередь `drive`); → `ChatterService`; → `NotificationsService`; → `ContactsService.assertReachable({personalOnly:true})` + `PersonalGraphRegistry.register('drive')`; → Search/RichCards/QuickActions регистрации. Обратно — только реестр: `MessengerModule` и `TasksModule` импортируют `DriveModule` и регистрируют `DriveRoutingRegistry` (из DM — на личный диск, из сущностей организации — на её).

### Гостевые ссылки
- `DriveTreeService` → `ShareLinksService.revokeAllForRefs` (окончательное удаление узла отзывает ссылки поддерева; корзина — НЕ отзывает); `DocsService.archive` → то же для документа. Обратно — только реестр: `DriveShareLinksProvider` и `DocsShareLinksProvider` регистрируют `{authorizeManage, resolveGuestView}`. Гостевые под-контроллеры потребителей зовут `ShareLinksGuestService.authorizeGuest(пропуск)` и работают системными методами движка файлов.

### ЭДО (внешний контур Документооборота)
- `DocumentsService` → `CounterpartiesService` (`assertUsable`/`assertContactUsable`; `litesFor`/`contactRefsFor` — батчи DTO); → `SignService.createRequest` (opts `suppressOutcomeNotify` + `guestSigner`) и `cancelRequest`; → `ShareLinksService.create/revokeAllForRefs` (автоссылка на `sign_request`); → `SmsOutboundService` (core/verify: служебные SMS со ссылкой). Обратно — хуками реестра: `SignRegistry.onActFinished/onRequestExpired/checkGuestCert`; `SignJobs → ApprovalsRegistry.registerSource('sign')`; джоб `DOCUMENTS_FILE_JOB` подшивает штампованную копию.

### КЭДО (HR)
- `HrService`/`HrActionsService` → `StaffService` (факт-назначения, синхронизация при переводе); → `WorkspacesService` (увольнение с `alsoRemoveMembership`); → `DocumentsService` (`systemCreateForHrAction`/`systemCancelForHrAction` — приказ производен от действия); → `SignProtocolService` (протоколы в ZIP); → `FilesService` (`linkSystemInTx` `personal_doc`, `buildSystemDownloadUrl`, `openRawStream`); → `ApprovalsService.releaseUserFromWorkspaceSteps` (увольнение снимает человека с шагов; зовут и `WorkspacesService.removeMember/leaveWorkspace`); → `JobsService` (джобы `hr.action.apply`, `hr.batch.run`, очередь `hr`); → `TasksService` (задача кадровику «издать приказ об отмене»).
- **Направление документы↔кадры — ленивый порт `HrPort`** (`DocumentsService.setHrService` на bootstrap, `DI_TOKENS.HrService`): документы зовут `onDocumentSubmitted/Withdrawn/Cancelled/Resolved/ActFinished/Delivered/Acknowledged`; нода `hr.apply` — `onRouteReachedApply`. **Порт токена ОБЯЗАН покрывать все методы, которые ждут ноды** (`HrService implements HrPort, HrNodesPort` — проверяет компилятор).
- Кампании: `DocCampaignsService` → `SignService.createRequest` (`neverExpires`+`noInitialActs`) + `systemEnsureActs`. Обратно — реестрами: `ApprovalsRegistry.registerSource('hr_campaign')`, `ApprovalRefProvider.onDecided`, `FilesRefRegistry` `personal_doc` (`blocksDeletion: true`), `TemplateFieldRegistry`, `ChatterRefRegistry.register('hr_member')`.

### Хроника / Джобы (движки как потребители друг друга)
- `TasksService`/`WorkspacesService`/`StaffService` → `ChatterService.log(tx,…)` — синхронно в транзакции мутации; мессенджер регистрирует chat-sink (`ChatterChatSink` → `registerChatSink('task')`); плашки чатов производит джоб `chatter.chatpost` (core/jobs), поставленный в той же tx; `ChatterService` → `RolesService` (гейт журнала).
- `ChatterService` → `JobsService.enqueue(tx)`; `ScheduledMessageService` → `enqueue(tx)` + `register('messenger.scheduled.fire')`; `NotificationsDispatch` → `register('notifications.dispatch')`; ~40 сайтов 6 модулей (contacts/tasks/calendar/workspaces/staff/shop) → `NotificationsService.emitEvent` (шина + джоб).

## Carve-out map (допустимые прямые чтения чужих таблиц)

Для монолита допустимо; список — граница будущего выделения сервисов:
- Messenger и его листенеры читают `task` / `order` / `calendarEvent` напрямую.
- `core/quick-actions` читает `chat`.
- Office и `OfficeRichCardsProvider` читают `call_sessions` / `call_session_participants` (живой счётчик).
- Мессенджер читает `officeRoom` (чат/roleLabels).

## Проверка

Смоук DI-токенов — на bootstrap (валит старт при пропаже провайдера). Рёбра покрыты сьютами соответствующих модулей ([testing_verify_suite.md](testing_verify_suite.md)).
