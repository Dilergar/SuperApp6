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
| Контракт API↔клиенты | [contract_boundary.md](contract_boundary.md) + [testing_verify_suite.md](testing_verify_suite.md) |
| Среда / env / docker | [dev_environment.md](dev_environment.md) + [environment_variables.md](environment_variables.md) |
| Безопасность | [security.md](security.md) (+ [verify_engine.md](verify_engine.md), [sign_engine.md](sign_engine.md)) |

## Правила ведения docs/ (несущие — рассчитаны на рост проекта в десятки раз)

- **Один файл = одна тема.** Нейминг snake_case: сервис — `<name>.md`, движок — `<name>_engine.md`, сквозное — по смыслу (`*_conventions.md`, `*_gotchas.md`).
- **Новый сервис** = +1 файл + 1 строка в этом индексе. **CLAUDE.md при этом НЕ растёт** — его карта пополняется только новыми ДВИЖКАМИ и несущими правилами; список сервисов там — одна строка на сервис.
- **Целевой размер файла ≤ ~15 КБ.** Перерос — тема ДЕЛИТСЯ на два файла (например, `messenger.md` → `messenger.md` + `messenger_calls.md`), а не пухнет: агент должен грузить ровно то, что нужно задаче.
- **Шаблон структуры дока** (единый стиль): `> однострочник-назначение` → Роль/Модель данных → Контракт потребителя / Сервисный API → HTTP API (кратко) → Несущие правила → Ловушки → Веб → Проверка (сьюты) → Связанные доки.
- **Один факт живёт в одном месте**: док ссылается на соседей относительной ссылкой (как [api_conventions.md](api_conventions.md)), а не пересказывает их.
- **Пути кода** в новых доках — полные (`apps/api/src/...`, `packages/shared/src/...`, `apps/web/src/...`); сокращённые префиксы не использовать.
- **Рост папки**: пока файлов ≲100 — плоская структура (как сейчас). При перерастании вводятся подпапки (`engines/`, `services/`, `platform/`) ОДНИМ рефакторингом со сквозной правкой всех ссылок — два стиля одновременно не смешивать.

## Сквозные правила и конвенции

| Файл | О чём |
|---|---|
| [architecture_overview.md](architecture_overview.md) | Монорепо, модульный монолит, 15 движков, стек, порты |
| [module_graph.md](module_graph.md) | Карта синхронных рёбер модулей, DI_TOKENS, EventBus, carve-outs. **Новое ребро → сюда** |
| [identity_roles.md](identity_roles.md) | Universal Identity, лестница ролей, chokepoint, «рабочий пропуск» |
| [api_conventions.md](api_conventions.md) | /api/v1, конверт ошибок, страницы, queryBoolean, статические пути, троттлинг, гонки |
| [contract_boundary.md](contract_boundary.md) | Граница API↔клиенты: три эшелона, api-client, правила DTO |
| [security.md](security.md) | Auth/tokenEpoch, fail-closed env, две двери исходящего HTTP, заголовки, секреты |
| [web_conventions.md](web_conventions.md) | AppShell, кит UI, PersonChip/EntitySelector, React Query, loading.tsx, виртуализация |
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

## Сервисы (apps/api/src/modules/)

| Файл | Сервис |
|---|---|
| [users_profile.md](users_profile.md) | Профиль и аккаунт человека: анкета, реквизиты, сессии, грейс удаления |
| [contacts_circles.md](contacts_circles.md) | Окружение (Circle) — социальный граф, фундамент |
| [notifications.md](notifications.md) | Уведомления: реестр, emitEvent, карта доставки |
| [tasks.md](tasks.md) | Задачник (роли Bitrix24, эскроу наград, GTD-инбокс) |
| [calendar.md](calendar.md) | Календарь + реестр слоёв + Google-синхра + ресурсы |
| [messenger.md](messenger.md) | Мессенджер: DM/группы/контекстные чаты, presence, звонки, виртуализация |
| [wallet_ledger.md](wallet_ledger.md) | Кошелёк-леджер: двойная запись, эскроу, карты, B2B-казна |
| [card_skins.md](card_skins.md) | Скины карточек (косметика, платформенная валюта) |
| [workspaces.md](workspaces.md) | Организации: приглашения, профиль, реквизиты, архив 90 дней |
| [staff.md](staff.md) | Сотрудники: должности/отделы/филиалы, назначения, проекции осей |
| [shop.md](shop.md) | My Wish & Shop: витрины, заказы, краудфандинг, вишлист |
| [processes.md](processes.md) | Процессы: нодовый канвас, token-движок, AI-кластер, KZ-коннекторы |
| [finance.md](finance.md) | Финансы B2C: редактируемая двойная запись, лимиты, долги, шеринг |
| [recorder.md](recorder.md) | Диктофон + «Журнал звонков» |
| [office.md](office.md) | Виртуальный офис (встречи-ссылки, чат встречи) |
| [drive.md](drive.md) | Диск (OmniDrive): дерево поверх файлов, закрытые папки, фото |
| [documents_service.md](documents_service.md) | Документооборот: виды/шаблоны/карточки, конструктор, ЭДО, кампании |
| [counterparties.md](counterparties.md) | Контрагенты: единый справочник внешних сторон |
| [hr_kedo.md](hr_kedo.md) | КЭДО: трудовые карточки, кадровые действия, ЕСУТД, «Мои документы» |

## Статус и планы

| Файл | О чём |
|---|---|
| [roadmap.md](roadmap.md) | Этапы, что построено, кандидаты, техдолг, внешние блокеры |
| [gap_analysis_v2.md](gap_analysis_v2.md) | Детальный gap-анализ с чек-боксами (живой план) |
| [archive/claude-md-2026-08-30.md](archive/claude-md-2026-08-30.md) | Архив: полный CLAUDE.md до реструктуризации (не обновляется) |
