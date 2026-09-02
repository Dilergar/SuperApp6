# Плейбук: как добавить новый сервис

> Перед стройкой — грилл дизайна (trade-offs + бенчмарки гигантов, спорное — вопросами пользователю). Пункты «регистрация» ниже — это и есть переиспользование движков: новый сервис = тонкий модуль + регистрации, НЕ копипаста чужой логики. Если движка не хватает — он РАСШИРЯЕТСЯ, а не копируется.

## Шаги

1. Папка `apps/api/src/modules/<name>/`: `<name>.module.ts`, `<name>.service.ts`, `<name>.controller.ts` (+ `<name>.events.ts` для подписок на шину, `<name>.cron.ts` под Redis-локом при необходимости).
2. Prisma-модели в `apps/api/prisma/schema.prisma` + миграция (`pnpm db:migrate`). Партиальные уникумы — руками в миграцию + коммент в схеме.
3. `packages/shared`: `types/<name>.ts` + `validation/<name>.ts` (Zod) + `constants/<name>.ts` + экспорт в `index.ts`. DTO ответов — сюда же, и каждый ОБЯЗАН сразу встать на обе стороны провода. Тип входа = `z.infer` рядом со схемой. Страница — `CursorPage<T>`/`OffsetPage<T>`. Полные правила — [contract_boundary.md](contract_boundary.md).
4. Зарегистрировать модуль в `apps/api/src/app.module.ts`.
5. **Чек-лист переиспользования движков** (см. ниже).
6. Веб-страница: RQ-ключи в `lib/queries.ts`, люди — только `PersonChip`/`PersonAvatar`, пикеры — `EntitySelector`, дизайн строго по `/DESIGN.md`, навигация через `AppShell` (+1 строка в `lib/app-nav.ts`), `+1 файл <сервис>/loading.tsx`. Полные правила — [web_conventions.md](web_conventions.md).
7. Verify-скрипт `apps/api/scripts/verify-<name>.cjs` (попадает в CI автоматически) — правила в [testing_verify_suite.md](testing_verify_suite.md).
8. Контроллеры тонкие (Zod parse → сервис); читающие методы объявляют `Promise<Dto из shared>`; страница НЕ расплющивается. Тонкий контроллер = сервис AI-ready.
9. Обновить документацию: релевантные файлы в `docs/` (+ индекс `docs/README.md`; в доке сервиса — строка «Код: `apps/api/src/modules/<name>/`») и CLAUDE.md, если затронуто несущее правило. Новое синхронное ребро между модулями → [module_graph.md](module_graph.md); затем `pnpm check:docs --write` (перегенерирует таблицу рёбер и проверит пути/индекс/env).
10. Мобильный экран — после переписывания mobile (этап 2 дорожной карты).

## Чек-лист переиспользования движков

| Нужно сервису | Что сделать |
|---|---|
| Права/шеринг/роли | Тип ресурса в `access-schema.ts` + проекция рёбер (+ строка в `EPOCH_FANOUT`; при listObjects — в `LIST_OBJECTS_EXTRA_EXPANSION`) — [access_engine.md](access_engine.md) |
| Массовая выборка под правами | `AccessService.grantSetFor(userId, type)` + СВОЙ SQL-предикат. НЕ `check()` в цикле и НЕ `listObjects` (потолок 10 000 с молчаливой обрезкой). Наследование по дереву материализуется в домене (массив предков + GIN) |
| Сущность со статусами/действиями | Провайдер `core/rich-cards` — [rich_cards.md](rich_cards.md) |
| Попасть в глобальный поиск | +1 провайдер `core/search` — [search_engine.md](search_engine.md) |
| Кнопка в ＋-меню чата | +1 регистрация `core/quick-actions` — [quick_actions.md](quick_actions.md) |
| Файлы/вложения/фото | Профиль `FILE_PROFILES` + `FilesRefRegistry.register(refType, {canView, canAttach, canEditContent?})` + `linkFile`. ⚠️ Методы `system*` (`linkSystemInTx`, `systemDeleteFile`, `ingestLocalFile`, `replaceContent`, `buildSystemDownloadUrl`, `systemRender*`) прав НЕ проверяют — это ОБЯЗАН сделать вызывающий (правило дважды ловилось ревью). [files_engine.md](files_engine.md) |
| Офисный документ (совместная правка) | `core/docs`: оживление `POST /docs/from-file` по команде человека; право правки от места — предикат `canEditContent?` в своём FileRefResolver — [docs_engine.md](docs_engine.md) |
| Записи на сетке календаря | Реестр слоёв: +1 запись `CALENDAR_LAYER_REGISTRY` (shared) + свой kind в union + `CalendarLayersRegistry.register(layer, {provide})` в onModuleInit СВОЕГО модуля (импорт CalendarModule, не наоборот) — [calendar.md](calendar.md) |
| Голос/расшифровка | `VoiceService.requestTranscript(fileId)` (1 файл = 1 транскрипт, доступ = доступ к файлу); короткие команды `transcribeSync` — [voice_engine.md](voice_engine.md) |
| Звонки/конференции | `CallsRefRegistry.register(refType, {canJoin, canModerate, onJoinAuthorized?})`; вход — генерик `POST /calls/token`; запись — `CallsRecordingRegistry.register(refType, {onReady})` — [calls_engine.md](calls_engine.md) |
| Хроника «кто/что/когда + было → стало» | typeKeys в `CHATTER_REGISTRY` (shared) + `ChatterService.log(tx, …)` СИНХРОННО в транзакции мутации (+`diffTracked`) + `ChatterRefRegistry.register(refType, {canView})`; плашки чатов = проекция (chat-sink) — [chatter_engine.md](chatter_engine.md) |
| Уведомления | Типы в `NOTIFICATION_REGISTRY` + ветка в `notifications.map.ts`; слать `NotificationsService.emitEvent(...)`, НЕ голым `events.emit`. Прямой `notify` — когда адресат известен вызывающему — [notifications.md](notifications.md) |
| Деньги: оплата/заморозка/сделки | `wallet` (Ledger двойной записи + generic Escrow со своим refType) — ТОЛЬКО синхронно, в одной транзакции — [wallet_ledger.md](wallet_ledger.md) |
| Фоновая работа (ретраи, отложенный запуск, «обязано случиться») | `core/jobs`: `JobsRegistry.register` + `JobsService.enqueue(tx, …)` В ТРАНЗАКЦИИ мутации; обработчик идемпотентен и делит ошибки на транзиентные (throw) и постоянные (`JobDiscardError`); тяжёлый тип — в СВОЮ очередь — [jobs_engine.md](jobs_engine.md) |
| Сайд-эффекты между модулями | EventBus — только то, что можно потерять — [event_bus.md](event_bus.md) |
| SMS-подтверждение владения номером / step-up | `core/verify`: ключ в `VERIFY_PURPOSES` + start + `consume(tx)` в транзакции действия; веб — кит `components/verify/` — [verify_engine.md](verify_engine.md) |
| Поделиться наружу (человек БЕЗ аккаунта) | `ShareLinksRegistry.register(refType, {authorizeManage, resolveGuestView})` + `<ShareLinkSection/>`. У authorizeManage ДВА отказа: `null` → 404 (посторонний), throw Forbidden → 403 (видит, но не управляет). Гостевые ручки НИКОГДА не отвечают 401 — [share_links_engine.md](share_links_engine.md) |
| Собрать решение (согласовать/подписать/ознакомиться) | `ApprovalsRegistry.register(refType, …)` + `ApprovalsService.create(...)` из своего кода, проверив СВОЁ право. `describeForCreate` ОБЯЗАН проверять право. Ветвления — НЕ сюда, это Процессы. Своя стопка — `registerSource(key, …)` — [approvals_engine.md](approvals_engine.md) |
| Юридически значимая подпись | `SignRegistry.register(refType, {resolveSubject, canRequestSign, …})` + `SignService.createRequest(...)`. resolveSubject отдаёт готовый к печати файл (PDF-отпечаток); уровень задаёт ПОТРЕБИТЕЛЬ — [sign_engine.md](sign_engine.md) |
| Подставить данные в шаблон документа | `TemplateFieldRegistry.register({key, tagPrefix, fields, resolve})`; заполнение `TemplateRenderService.renderForContext` (system-контракт: право проверил вызывающий). Незаполненное = null (отказ списком), осознанно-пустое = '' — [templates_engine.md](templates_engine.md) |
| Исходящий HTTP наружу | Одна из ДВУХ дверей `shared/http` (safeFetch — адрес из данных; trustedFetch — адрес из .env, таймаут обязателен) — [security.md](security.md) |
| Действия «между людьми» | `ContactsService.assertReachable` (для ЛИЧНОГО ресурса — `{personalOnly:true}`); выдал грант человеку из окружения → зарегистрируй `PersonalGraphRegistry.register('<сервис>', {onUnlinked})` — иначе доступ переживёт разрыв связи — [contacts_circles.md](contacts_circles.md) |
| Состав Группы | ТОЛЬКО `ContactsService.resolveCircleMemberIds` (свой обход графа запрещён). Два режима Группы: назначение = СНИМОК участников; аудитория/видимость = живой принципал `circle` в core/access |
| Свои файлы сущности должны попадать на Диск | `DriveRoutingRegistry.register(refType, {resolvePlacement})` (импорт DriveModule, не наоборот) — [drive.md](drive.md) |
| Узнать о привязке любого файла | `FilesRefRegistry.registerLinkObserver(key, {onLinked})` — зовётся внутри транзакции привязки |
| B2B-данные | Chokepoint (workspaceId) или явный ownerType+ownerId + проверка прав — [identity_roles.md](identity_roles.md) |
| Показ человека в UI / пикеры | `PersonChip`/`PersonAvatar` / `EntitySelector` — [web_conventions.md](web_conventions.md) |
| Навигация сервиса (веб) | +1 строка в `lib/app-nav.ts` (AppShell) |
| Значок сущности | `GlyphField`/`Glyph` (веб); из API — ключ реестра иконок |
