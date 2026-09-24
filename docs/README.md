# SuperApp6 — документация проекта (docs/)

> **Канонический источник правды об архитектуре.** Правила работы и несущие принципы — `/CLAUDE.md`; продуктовое видение — `/PRODUCT.md`; дизайн-система — `/DESIGN.md`. Здесь — детальная архитектура: движки, сервисы, конвенции, ловушки.

## Как пользоваться (AI-агентам и людям)

1. **Перед началом работы**: прочитай этот индекс и файлы, релевантные задаче (не всю папку). Задача про мессенджер → `messenger.md` + движки, которые он использует; новый сервис → `playbook_new_service.md`.
2. **Несоответствие дока и кода** → сообщи пользователю и предложи исправление (кто из двух прав — решается проверкой, не молчаливой правкой дока).
3. **В конце каждого подхода к работе** — актуализируй затронутые доки (и создай новый, если появилась новая тема). Правило синхронизации: изменил архитектуру → обнови docs/ (+CLAUDE.md, если правило несущее).
4. **Стиль доков**: только ТЕКУЩЕЕ состояние + вечные правила и ловушки; без дат и истории изменений (исключение — `roadmap.md`). История — в git и в `archive/`.

## Быстрый роутинг по типу задачи (минимальный набор чтения)

| Задача | Что читать |
|---|---|
| Новый сервис | [playbook_new_service.md](playbook_new_service.md) + [architecture_overview.md](architecture_overview.md) + доки задействованных движков |
| Ручка / логика API | [api_conventions.md](api_conventions.md) + [module_graph.md](module_graph.md) + доменный док |
| UI-страница / компонент | `/DESIGN.md` + [web_conventions.md](web_conventions.md) + доменный док |
| Багфикс «странное поведение» | [platform_gotchas.md](platform_gotchas.md) + раздел «Ловушки» доменного дока |
| Фоновая работа / джоб | [jobs_engine.md](jobs_engine.md) + доменный док |
| Права / доступ / шеринг | [access_engine.md](access_engine.md) + [identity_roles.md](identity_roles.md) + доменный док |
| Кто видит какие ПОЛЯ (маски, скрытое, раскрытие) | [visibility_engine.md](visibility_engine.md) + доменный док |
| Контракт API↔клиенты | [contract_boundary.md](contract_boundary.md) + [testing_verify_suite.md](testing_verify_suite.md) |
| Среда / env / docker | [dev_environment.md](dev_environment.md) + [environment_variables.md](environment_variables.md) |
| Безопасность | [security.md](security.md) (+ [verify_engine.md](verify_engine.md), [sign_engine.md](sign_engine.md)) |
| Текст для человека (любой) | [i18n.md](i18n.md) — строка живёт в каталоге `@superapp/i18n`, а не в коде |

## Правила ведения docs/ (несущие — рассчитаны на рост проекта в десятки раз)

- **Один файл = одна тема.** Нейминг snake_case: сервис — `<name>.md`, движок — `<name>_engine.md`, сквозное — по смыслу (`*_conventions.md`, `*_gotchas.md`).
- **Новый сервис** = +1 файл + 1 строка в этом индексе. **CLAUDE.md при этом НЕ растёт** — его карта пополняется только новыми ДВИЖКАМИ и несущими правилами; список сервисов там — одна строка на сервис.
- **Целевой размер файла ≤ ~15 КБ.** Перерос — тема ДЕЛИТСЯ на два файла (например, `messenger.md` → `messenger.md` + `messenger_calls.md`), а не пухнет: агент должен грузить ровно то, что нужно задаче.
- **Шаблон структуры дока** (единый стиль): `> однострочник-назначение` → Роль/Модель данных → Контракт потребителя / Сервисный API → HTTP API (кратко) → Несущие правила → Ловушки → Веб → Проверка (сьюты) → Связанные доки.
- **Один факт живёт в одном месте**: док ссылается на соседей относительной ссылкой (как [api_conventions.md](api_conventions.md)), а не пересказывает их.
- **Пути кода** в новых доках — полные (`apps/api/src/...`, `packages/shared/src/...`, `apps/web/src/...`); сокращённые префиксы не использовать.
- **Страж `pnpm check:docs`** (`scripts/check-docs.cjs`, шаг CI до сборок): пути в доках существуют; каждый `docs/*.md` есть в этом индексе; каждый `apps/api/src/core/*` и `modules/*` упомянут хотя бы одним доком как `core/<имя>`/`modules/<имя>` (строка «Код: …» под однострочником); env-переменные согласованы между кодом, zod-схемой, доком и `.env.example`; таблица рёбер модулей совпадает с кодом. Новый док или модуль без строки в индексе — красный CI.
- **Рост папки**: пока файлов ≲100 — плоская структура (как сейчас). При перерастании вводятся подпапки (`engines/`, `services/`, `platform/`) ОДНИМ рефакторингом со сквозной правкой всех ссылок — два стиля одновременно не смешивать.

## Сквозные правила и конвенции

| Файл | О чём |
|---|---|
| [architecture_overview.md](architecture_overview.md) | Монорепо, модульный монолит, 26 движков, стек, порты |
| [module_graph.md](module_graph.md) | Карта синхронных рёбер модулей, DI_TOKENS, carve-outs, известные нарушения границ. **Новое ребро → сюда** |
| [module_graph_documents.md](module_graph_documents.md) | Часть 2 карты: Диск, core/docs, ссылки, Документооборот, Контрагенты, КЭДО, подпись |
| [module_graph_edges.md](module_graph_edges.md) | ГЕНЕРИРУЕТСЯ (`pnpm check:docs --write`): точная таблица рёбер из импортов и DI-токенов |
| [event_bus.md](event_bus.md) | EventBus: at-most-once, что нельзя класть на шину, каталог событий и подписчиков |
| [identity_roles.md](identity_roles.md) | Universal Identity, лестница ролей, chokepoint, «рабочий пропуск» |
| [api_conventions.md](api_conventions.md) | /api/v1, конверт ошибок, страницы, queryBoolean, статические пути, троттлинг, гонки |
| [contract_boundary.md](contract_boundary.md) | Граница API↔клиенты: три эшелона, api-client, правила DTO |
| [security.md](security.md) | Auth/tokenEpoch, fail-closed env, две двери исходящего HTTP, заголовки, секреты |
| [web_conventions.md](web_conventions.md) | AppShell, кит UI, PersonChip/EntitySelector, React Query, loading.tsx, виртуализация |
| [i18n.md](i18n.md) | Мультиязычность: язык/регион/пояс, каталоги, render-at-read, коды отказов, стражи и ратчет |
| [i18n_migration.md](i18n_migration.md) | Глоссарий терминов en/kk/ru и порядок перевода сервисов (ратчет) |
| [testing_verify_suite.md](testing_verify_suite.md) | Verify-сьют, аккаунты suite/tester, правила чистоты, CI |
| [dev_environment.md](dev_environment.md) | Команды, порядок сборки, docker-профили, свои образы, ловушки среды |
| [environment_variables.md](environment_variables.md) | Все env-переменные по подсистемам |
| [playbook_new_service.md](playbook_new_service.md) | Пошаговый плейбук нового сервиса + чек-лист движков |
| [platform_gotchas.md](platform_gotchas.md) | Сквозные ловушки (среда, браузерная проверка, код, процесс) |

## Платформенные движки (apps/api/src/core/)

| Файл | Движок |
|---|---|
| [access_engine.md](access_engine.md) | ReBAC-авторизация: tuples, проекции, эпохи, grantSetFor |
| [rich_cards.md](rich_cards.md) | Интерактивные карточки (рендер+действия) |
| [search_engine.md](search_engine.md) | Кросс-сервисный поиск (FTS+trigram, обрезка по правам в SQL) |
| [quick_actions.md](quick_actions.md) | Кнопки ＋-меню/меню сообщения чата |
| [files_engine.md](files_engine.md) | Файлы: FileObject+FileLink, драйверы local/s3, конвейер, антивирус |
| [voice_engine.md](voice_engine.md) | STT-транскрипция (1 файл = 1 транскрипт, whisper/mock) |
| [calls_engine.md](calls_engine.md) | Звонки (LiveKit SFU), запись, устойчивость к слабой сети |
| [chatter_engine.md](chatter_engine.md) | Хроника «кто/что/когда + было → стало», плашки чатов |
| [jobs_engine.md](jobs_engine.md) | Фоновые джобы (transactional outbox, at-least-once) |
| [verify_engine.md](verify_engine.md) | SMS-OTP: verifyToken, step-up, анти-абьюз, SmsOutbound |
| [docs_engine.md](docs_engine.md) | Офисные документы (WOPI-хост, своя сборка Collabora) |
| [share_links_engine.md](share_links_engine.md) | Гостевые ссылки наружу + личность гостя |
| [approvals_engine.md](approvals_engine.md) | Согласования «Ждут решения»: шаги, снимки адресатов, стопка |
| [sign_engine.md](sign_engine.md) | Электронная подпись (ЭЦП НУЦ РК + ПЭП), вечные доказательства |
| [templates_engine.md](templates_engine.md) | Заполнение шаблонов: свой docx-драйвер, builder→PDF, реестр полей |
| [audiences_engine.md](audiences_engine.md) | Адресаты: единый словарь (человек/Группа/команда/оси/относительные), якоря, разворот в людей |
| [notifications_engine.md](notifications_engine.md) | Уведомления: событие + строка на адресата + журнал доставки, реестр типов по сервисам, каналы in-app/push/SMS/chat, предпочтения, политика организации, тишина |
| [realtime_engine.md](realtime_engine.md) | Один сокет платформы `/realtime`: комнаты `user:<id>`, реестр relay/хендлеров/хуков, Redis-адаптер |
| [entitlements_engine.md](entitlements_engine.md) | Тарифы и лимиты (`core/entitlements`): реестр ключей в shared, планы с версиями, подписки/триал/грейс, гранты, оверрайды, квоты, `402 entitlement.*`, страница «Тариф и лимиты» |
| [platform_console.md](platform_console.md) | Кабинет платформы (`core/platform`): сотрудники ≠ user_roles, токен `aud: platform`, гард deny-by-default, реестр команд с журналом/идемпотентностью/step-up/«четыре глаза», поиск и карточка 360 с масками PII |
| [analytics_engine.md](analytics_engine.md) | Продуктовая аналитика (`core/analytics`): реестр событий в shared, приём без БД на пути запроса (stream + outbox), партиции PostgreSQL, консьюмер, склейка личности, согласие, забвение, стражи |
| [analytics_ingest.md](analytics_ingest.md) | Аналитика, часть 3: приём (`/analytics/collect`), консьюмер stream + outbox, конвейер обогащения, роллапы и кроны, ловушки сырого SQL |
| [analytics_reports.md](analytics_reports.md) | Аналитика, часть 2: семантика метрик, язык запросов и исполнитель, k-анонимность, отчёты и дашборды, раздел Кабинета, SDK клиента |
| [keys_engine.md](keys_engine.md) | Движок ключей (`core/keys`, 22-й): корень и keystore, envelope с AAD, слепые индексы, HMAC, Ed25519-подпись токенов и JWKS, ротации без разлогина, заморозка и crypto-shredding, журнал append-only, команды кабинета |
| [keys_api_access.md](keys_api_access.md) | Ключи API и боты: принципал-бот (теневой `users.kind='bot'`), личные ключи, формат `sa6_…`, скоупы и `KeyScopeGuard`, контекст организации в ключе, step-up, реестр/политика/каскады, раздел «Интеграции и ключи» |
| [keys_pii.md](keys_pii.md) | Шифрование ПДн: Prisma-расширение dual-write `_enc/_bi`, режим `KEYS_PII_READ_MODE`, backfill, учёт чтений `pii.read`, дроп открытых колонок |
| [consents_engine.md](consents_engine.md) | Движок согласий (`core/consents`, 24-й): документы платформы версиями (контент в БД, хэш-цепочка, подпись платформы), записи приёмки как доказательство, пакеты регистрации и создания организации, шлюз новой версии (эпохи в кэше сессии, мягкий шлюз организаций), учёт действий с ПДн, журнал инцидентов, «Мои данные», `/legal` |
| [legal_kz.md](legal_kz.md) | Правовая карта РК: норма → механизм (ЗоПД, Правила № 179/НҚ, Цифровой кодекс, ГК ст. 22, закон о платежах), реквизиты оператора, долги (СКЗИ, резидентность хостинга, вычитка юристом) |
| [account_enforcement.md](account_enforcement.md) | Блокировки аккаунтов — решено, не построено: лестница состояний, уведомление без раскрытия алгоритма, апелляция 10 рабочих дней, деньги/скины/бонусы, улики после удаления |
| [webhooks_engine.md](webhooks_engine.md) | Исходящие вебхуки (`core/webhooks`, 23-й): реестр событий в shared, `emit(tx)`, Standard Webhooks (HMAC/Ed25519, ротация двумя подписями), доставка с ретраями и автоотключением, пинг и аудит битой подписью |
| [idempotency_engine.md](idempotency_engine.md) | Идемпотентность повторов (`core/idempotency`, 25-й): ключ повтора на мутациях, отметка «эффект закоммичен» в бизнес-транзакции, снимок ответа под KEK владельца, «входящий ящик» ровно-одного-раза, производные ключи вниз по стеку, страж объявлений на буте |
| [audit_engine.md](audit_engine.md) | Журнал аудита безопасности (`core/audit`, 26-й): единый поток событий с тремя зрителями (человек / организация / платформа), реестр в shared, запись в транзакции факта, append-only в БД (триггеры ENABLE ALWAYS + роль-владелец), защита входа, сессии-семейства, cooling, заморозка и «Это не я», журнал и экспорт организации, SIEM-стрим, дайджесты Меркла, архив, детекции |
| [visibility_engine.md](visibility_engine.md) | Правила видимости полей (`core/visibility`, 27-й): реестр типов записей в shared, личное поле решает человек, служебное — организация матрицей, провод `Guarded<T>`, маски только на сервере, потолки класса поля и бота/ключа, раскрытие одной записи под SMS, «четыре глаза», находимость по номеру, семь чокпойнтов, страж ответа и канарейки |

## Сервисы (apps/api/src/modules/)

| Файл | Сервис |
|---|---|
| [users_profile.md](users_profile.md) | Профиль и аккаунт человека: анкета, реквизиты, сессии, грейс удаления |
| [contacts_circles.md](contacts_circles.md) | Окружение (Circle) — социальный граф, фундамент |
| [tasks.md](tasks.md) | Задачник (роли Bitrix24, эскроу наград, GTD-инбокс) |
| [calendar.md](calendar.md) | Календарь + реестр слоёв + Google-синхра + ресурсы |
| [messenger.md](messenger.md) | Мессенджер: чаты, presence, звонки, виртуализация, упоминания как уведомления |
| [wallet_ledger.md](wallet_ledger.md) | Кошелёк-леджер: двойная запись, эскроу, карты, B2B-казна |
| [card_skins.md](card_skins.md) | Скины карточек (косметика, платформенная валюта) |
| [workspaces.md](workspaces.md) | Организации: приглашения, профиль, реквизиты, архив 90 дней |
| [staff.md](staff.md) | Сотрудники: должности/отделы/объекты, назначения, проекции осей |
| [org_structure.md](org_structure.md) | Орг. структура: вертикаль на графе должностей и объектов, заместители, области, API |
| [org_structure_resolve.md](org_structure_resolve.md) | Вывод вертикали: снимок с кэшем, `managerOf` / `holdersForPosition` / инверсия команды, циклы |
| [org_structure_web.md](org_structure_web.md) | Орг. структура (веб): канвас, мастер, «Вне структуры», мобильное дерево, профиль |
| [shop.md](shop.md) | My Wish & Shop: витрины, заказы, краудфандинг, вишлист |
| [processes.md](processes.md) | Процессы: нодовый канвас, token-движок, AI-кластер, KZ-коннекторы |
| [finance.md](finance.md) | Финансы B2C: редактируемая двойная запись, лимиты, долги, шеринг |
| [recorder.md](recorder.md) | Диктофон + «Журнал звонков» |
| [office.md](office.md) | Виртуальный офис (встречи-ссылки, чат встречи) |
| [drive.md](drive.md) | Диск (OmniDrive): дерево поверх файлов, закрытые папки, фото |
| [documents_service.md](documents_service.md) | Документооборот: виды/шаблоны/карточки, конструктор, ЭДО, кампании |
| [counterparties.md](counterparties.md) | Контрагенты: единый справочник внешних сторон |
| [objects.md](objects.md) | Объекты: дерево площадок, права, порты-хаб |
| [objects_shifts.md](objects_shifts.md) | Часть 2: смены (план/факт, пропускная, табель) |
| [objects_assets.md](objects_assets.md) | Часть 3: оборудование (модели, журналы) |
| [objects_staffing.md](objects_staffing.md) | Часть 4: штатка (единицы, назначения, ставки) |
| [legal_entities.md](legal_entities.md) | Юрлица: ТОО/ИП, реквизиты, счета, сторона договора |
| [hr_kedo.md](hr_kedo.md) | КЭДО: трудовые карточки, кадровые действия, ЕСУТД, «Мои документы» |
| [notes.md](notes.md) | Заметки: пространства и папки, права и шеринг по модели Диска, доска как вид на раздел (Alt+N на любой странице), название = первая строка, история версий |
| [notes_format.md](notes_format.md) | Формат заметки: `NoteDoc`, белый список схем ссылки, Markdown-диалект, экстракторы и чанкер под RAG |

## Статус и планы

| Файл | О чём |
|---|---|
| [roadmap.md](roadmap.md) | Этапы, что построено, кандидаты, техдолг, внешние блокеры |
| [gap_analysis_v2.md](gap_analysis_v2.md) | Детальный gap-анализ с чек-боксами (живой план) |
| [archive/claude-md-2026-08-30.md](archive/claude-md-2026-08-30.md) | Архив: полный CLAUDE.md до реструктуризации (не обновляется) |
