# Карта связей: документная вертикаль

> Вторая часть [module_graph.md](module_graph.md) — синхронные рёбра Диска, офисных документов, гостевых ссылок, Документооборота, Контрагентов, КЭДО, оргструктуры/адресатов и движков подписи/согласований/шаблонов. Правила связей, DI-токены и carve-outs — в первой части; шина — [event_bus.md](event_bus.md).

## Документы (core/docs)
- `DocsService` → `FilesService` (`replaceContent`, `linkSystemInTx`, `canEditContentVia`/`canViewFile`/`hasLink`, `openRawStream`) + `FilesRefRegistry` (резолверы `document`/`document_version`; canView — ТОЛЬКО явные гранты, иначе кольцо «файл → документ → файл»); → `AccessService` (тип `document`); → `ChatterService` (оживление файла — запись в хронику места + плашка в чат); → `JobsService`/`JobsRegistry` (очередь `docs`). Обратно — только реестр: `MessengerService` и `TasksService` объявили предикат `canEditContent` в своих `FileRefResolver`.

## Диск
- `DriveService`/`DriveTreeService`/`DriveVersionsService` → `FilesService` (`linkSystemInTx` — НАСТОЯЩАЯ связь `drive_node` (дом файла), `copyFile`, `replaceContent`, `systemDeleteFile`, `buildAttachmentViews`) + `FilesRefRegistry` (резолвер `drive_node` с явным `canEditContent` и `scopedPlace` + наблюдатель привязок `registerLinkObserver`); → `AccessService` (`grantSetFor` + grant/revoke; `check()` для типов Диска НЕ используется); → `RolesService`; → `JobsService` (очередь `drive`); → `ChatterService`; → `NotificationsService`; → `ContactsService.assertReachable({personalOnly:true})` + `PersonalGraphRegistry.register('drive')`; → Search/RichCards/QuickActions регистрации. Обратно — только реестр: `MessengerModule` и `TasksModule` импортируют `DriveModule` и регистрируют `DriveRoutingRegistry` (из DM — на личный диск, из сущностей организации — на её).

## Гостевые ссылки
- `DriveTreeService` → `ShareLinksService.revokeAllForRefs` (окончательное удаление узла отзывает ссылки поддерева; корзина — НЕ отзывает); `DocsService.archive` → то же для документа. Обратно — только реестр: `DriveShareLinksProvider` и `DocsShareLinksProvider` регистрируют `{authorizeManage, resolveGuestView}`. Гостевые под-контроллеры потребителей зовут `ShareLinksGuestService.authorizeGuest(пропуск)` и работают системными методами движка файлов.

## Документооборот (modules/documents)
- `DocumentsService` → `DocsService` (оживление/правка офисного файла); → `TemplateRenderService` + `TemplateFieldRegistry` + `PdfRenderService` (генерация из шаблона/конструктора); → `ApprovalsService` (внутренний контур: согласование/ознакомление); → `SignService.createRequest/cancelRequest` (opts `suppressOutcomeNotify` + `guestSigner`); → `CounterpartiesService` (`assertUsable`/`assertContactUsable`; `litesFor`/`contactRefsFor` — батчи DTO); → `ShareLinksService.create/revokeAllForRefs` (автоссылка на `sign_request`); → `SmsOutboundService` (core/verify: служебные SMS со ссылкой); → `FilesService`, `AccessService`, `RolesService`, `ChatterService`, `JobsService`, `NotificationsService`.
- `DocumentsJobs` → `DriveService` (`getOrCreateSpace`/`systemFolder`/`systemEnsureRestricted`/`systemEnsureFolder` — подшивка в закрытый реестр Диска организации); → `DocsRenditionService` (PDF-рендиция); → `DocsService`, `TemplateRenderService`, `PdfRenderService`, `AccessService`, `ChatterService`.
- **Ленивые порты** (ставит `DocumentsModule.onApplicationBootstrap`): `DI_TOKENS.ProcessesService` → `setProcessesService` (запуск маршрута по виду документа); `DI_TOKENS.HrService` → `setHrService` (см. КЭДО).
- Обратно — хуками реестров: `SignRegistry.onActFinished/onRequestExpired/checkGuestCert`; `SignJobs → ApprovalsRegistry.registerSource('sign')`; джоб `DOCUMENTS_FILE_JOB` подшивает штампованную копию.

## Контрагенты
- `CounterpartiesService` → `RolesService` (гейт РОЛЬЮ, не движком прав — прецедент Staff); → `ChatterService`. Провайдеры → `SearchRegistry`, `TemplateFieldRegistry` (реквизиты второй стороны в шаблоны), `RichCardRegistry`. Потребитель — Документооборот; дальше — Счета, Финансы B2B, ЭСФ ([counterparties.md](counterparties.md)).

## КЭДО (HR)
- `HrService`/`HrActionsService` → `StaffService` (факт-назначения, синхронизация при переводе); → `WorkspacesService.removeMember` (увольнение с `alsoRemoveMembership`; через него же снимаются шаги «Ждут решения» — прямого ребра к `ApprovalsService` у КЭДО нет; юридическое увольнение без снятия членства шаги не трогает); → `DocumentsService` (`systemCreateForHrAction`/`systemCancelForHrAction` — приказ производен от действия); → `SignProtocolService` (протоколы в ZIP); → `FilesService` (`linkSystemInTx` `personal_doc`, `buildSystemDownloadUrl`, `openRawStream`); → `JobsService` (джобы `hr.action.apply`, `hr.batch.run`, очередь `hr`); → `TasksService` (задача кадровику «издать приказ об отмене»).
- `HrLibraryService` → `ProcessesService` (`createDefinition`/`validateDefinition`/`publish` — маршрут бланка библиотеки создаётся как определение Процессов); → `DocumentsService`; → `ChatterService`.
- **Направление документы↔кадры — ленивый порт `HrPort`** (`DocumentsService.setHrService` на bootstrap, `DI_TOKENS.HrService`): документы зовут `onDocumentSubmitted/Withdrawn/Cancelled/Resolved/ActFinished/Delivered/Acknowledged`; нода `hr.apply` — `onRouteReachedApply`. **Порт токена ОБЯЗАН покрывать все методы, которые ждут ноды** (`HrService implements HrPort, HrNodesPort` — проверяет компилятор).
- Кампании: `DocCampaignsService` → `AudiencesService.resolve` (аудитория) + `SignService.createRequest` (`neverExpires`+`noInitialActs`) + `systemEnsureActs`. `HrActionsService` → `AudiencesService.resolve` (аудитория массовых действий) + `StaffService.assignPositionSystem/removeAssignmentSystem/ensureDefaultBranch` (синхронизация факта из джоба). Обратно — реестрами: `ApprovalsRegistry.registerSource('hr_campaign')`, `ApprovalRefProvider.onDecided`, `FilesRefRegistry` `personal_doc` (`blocksDeletion: true`), `TemplateFieldRegistry`, `ChatterRefRegistry.register('hr_member')`.

## Оргструктура и адресаты
- **Оргструктура** (внутри `StaffModule`, ноль новых рёбер модулей): `OrgService`/`StaffService` → `OrgGraphService` (снимок + Redis-кэш) → `OrgRightsService` → `AccessService.grantSetFor` (области). `StaffRegistriesProvider` → `AudiencesRegistry` (относительные адресаты `manager_of`/`subordinates_of`/`branch_head_of` — единственный вход «кто мой руководитель» для чужих сервисов) + `SearchRegistry` (`org_unit`); `StaffTemplateFieldsProvider` → `TemplateFieldRegistry` + `OrgGraphService` (поля «Руководитель»). `ContactsAudiencesProvider` → `AudiencesRegistry` (`circle` через `resolveCircleMemberIds`).
- **core/audiences** (16-й движок) как потребитель: `ApprovalsService`/`ApprovalsJobs` (снимок адресатов, эскалация вверх), `DocCampaignsService`, `HrActionsService`, `DriveShareService` (подписи), ноды Процессов (`human.task` через `getService`) → `AudiencesService`. Сам движок читает только `relationTuple`/`user_roles` — рёбер к фичам нет.

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

## Движки вертикали как потребители движков (core → core)
- `SignService` → `FilesService` (предмет/CMS/штамп — профили доказательств), `VerifyService` (код ПЭП), `JobsService` (очереди `sign`, `sign_stamp`), `ApprovalsService` (акт подписанта = шаг «Ждут решения»; источник `sign` регистрирует `SignJobs`); `SignProtocolService` → `PdfRenderService` (core/templates); `SignShareLinksProvider` → `ShareLinksRegistry` + `RolesService`; `SignGuestController` → `ShareLinksGuestService` + `FilesService`.
- `ShareLinksService` → `ChatterService` (хроника выдачи/отзыва); `ShareLinksGuestService` → `VerifyService` (личность гостя по SMS).
- `ApprovalsService` → `AudiencesService` (снимок адресатов при активации — единый словарь, относительные адресаты, владелец-фолбэк), `AccessService`, `JobsService`; `ApprovalsJobs` → `AudiencesService` (эскалация вверх — `manager_of`); `ApprovalsRichCardProvider` → `RichCardRegistry`.
- `TemplateRenderService` → `FilesService` (файл шаблона / результата).
- Рёбра движков к `modules/notifications` — записанный долг ([module_graph.md](module_graph.md), §4).

## Связанные доки

[module_graph.md](module_graph.md) · [drive.md](drive.md) · [docs_engine.md](docs_engine.md) · [share_links_engine.md](share_links_engine.md) · [documents_service.md](documents_service.md) · [counterparties.md](counterparties.md) · [hr_kedo.md](hr_kedo.md) · [sign_engine.md](sign_engine.md) · [approvals_engine.md](approvals_engine.md) · [templates_engine.md](templates_engine.md)
