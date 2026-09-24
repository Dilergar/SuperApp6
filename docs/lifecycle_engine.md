# Жизненный цикл данных (`core/lifecycle`)

> Код: `apps/api/src/core/lifecycle` (`lifecycle.partitions.ts` — партиции журналов, `lifecycle.time-hint.ts` — подсказка времени по id, `lifecycle.cron.ts`, `lifecycle.metrics.ts`, дев-полигон `lifecycle.dev.controller.ts`), миграции `core_lifecycle` + `lifecycle_partition_guards`, роли — `apps/api/scripts/db-roles.sql` (часть 2), реестр политик — `packages/shared/src/lifecycle` (`types.ts`, `registry.ts`, файлы областей `core.ts` · `messenger.ts` · `workspaces.ts` · `personal.ts` · `stores.ts`), страж — `scripts/check-lifecycle.cjs` + ратчет `scripts/lifecycle.cell-readiness.json`, сьют — `apps/api/scripts/verify-lifecycle.cjs`, события журнала — `packages/shared/src/audit/lifecycle.ts`, каталог — `packages/i18n/src/messages/<locale>/lifecycle.json`.

28-й платформенный движок. Отвечает на вопрос **«сколько живут данные, почему, чьи они и что с ними делать при стирании человека и удалении организации»** — для КАЖДОГО хранилища платформы: модели Prisma, сырой таблицы (`analytics.events`, `idem.*`), профиля байтов файлового движка, семейства ключей Redis и производного хранилища вне базы (архивы, экспорты, журнал стираний, бэкапы, логи). Знание «что стирать и в каком порядке» живёт в реестре, а не в порядке строк `purgeWorkspace` (GitLab data dictionary + Meta DELF + Elastic ILM).

## Политика (`LifecyclePolicy`)

| Поле | Смысл |
|---|---|
| `id` / `store` | Имя модели Prisma, либо `table:<схема.таблица>` · `blob:<профиль>` · `redis:<семейство>` · `derived:<имя>` |
| `owner`, `version` | Модуль-владелец; сокращение срока = новая версия + dry-run + «четыре глаза», удлинение свободно |
| `dataClass` | `identity_pii · auth_secret · user_content_private · user_content_shared · tenant_record · legal_record · financial_record · security_audit · operational · analytics_event · derived · ephemeral` |
| `ownerKey` | Ключ «коло»: `user` / `workspace` / `conversation` / `ledger` + колонка, `via` родителя, `polymorphic` (`ownerType + ownerId`), `scoped` (организация, если колонка заполнена, иначе человек), `global` (с причиной) |
| `subjects[]` | Колонки людей в строке и их роль (`owner`, `author`, `recipient`, `participant`, `member`, `employee`, `actor`, …) |
| `legalBasis` | `consent` · `contract` · `legal_obligation{citation}` · `legitimate_interest{reason}` |
| `retention` | `trigger` (`created` · `lastActivity` · `parent` · `event:<имя>`) + `floorDays` (пол закона) · `defaultDays` (ОБЯЗАТЕЛЕН) · `ceilingDays` + `tenantConfigurable` / `userConfigurable` / `entitlementKey` |
| `onSubjectErasure` | `hard_delete{personalOnly?}` · `crypto_shred{keyScope}` · `pseudonymize{fields}` · `redact{fields}` · `retain_legal{citation, untilDays}` · `none{reason}` |
| `onTenantPurge` | `cascade_fk` · `registry_hook{key}` · `batched_delete{column}` · `crypto_shred` · `retain_legal{citation, untilDays}` · `not_applicable` |
| `edges[]` | Граф удаления: `deep` (каскад) · `shallow` (рвётся связь) · `refcount` (файл живёт до последнего места) · `async_delete` / `async_nullify` (строки без FK добирает воркер) |
| `enforcement` | `drop_partition{column, period}` · `batched_delete{column, filter?, handler?}` · `ttl_sweep` · `transient` · `cascade` · `none{reason}` (+ `extraRules`) |
| `holdAware`, `proofEvent`, `pause`, `rootEntity`, `exportable` | Legal hold перекрывает удаление; ключ журнала-доказательства; выключатель; корневая сущность (мягкое скрытие обязательно); что уходит в экспорт |

Нормы права — коды `LIFECYCLE_CITATIONS` (текст нормы — каталог `lifecycle.citations.<код>`, не код). Классы и пресеты — `LIFECYCLE_DATA_CLASSES`, `LIFECYCLE_RETENTION_PRESETS` («Вечно · 1 год · 90 · 30 · 7 · 1 день»), `LIFECYCLE_CHAT_TIMER_PRESETS` (1 · 7 · 30).

## Несущие правила

1. **Пустое поле срока = хранить + красный CI.** `retention.defaultDays` обязателен; урок Google / UniSuper 2024 — пустой параметр стал сроком и удалил облако.
2. **Длительность — только целые сутки в полях `*Days` или `'forever'`.** Строка `'30'` — ошибка (урок pg_partman #811: `'10'` = 10 секунд). `floorDays ≤ defaultDays ≤ ceilingDays`.
3. **Приоритет** (`resolveLifecycleRetention`): legal hold > пол закона > стирание субъекта > потолок > умолчание; несколько «хранить» — побеждает длиннее, несколько «удалить» — короче. Коридор организации — `lifecycleCorridor(policy, planCeiling)`: [пол; min(потолок политики, потолок тарифа)].
4. **«По закону» — только с нормой.** `legal_obligation` и `retain_legal` без кода из `LIFECYCLE_CITATIONS` — красный CI.
5. **Hold обязателен** у классов `legal_record`, `tenant_record`, `user_content_*` (`holdAware: false` запрещён).
6. **Всё, что не `global`, достижимо** из корней `User`, `Workspace`, `Chat` по рёбрам (DELF); у политики с `enforcement: cascade` есть входящее `deep`/`refcount`/`async_delete` ребро — иначе её никто не удалит.
7. **FK схемы = ребро удаления.** Каждый внешний ключ объявлен ребром родителя: `Cascade`/`Restrict` (и умолчание обязательной связи) → `deep`, `SetNull` (и умолчание необязательной) → `shallow`. Новый FK без решения о каскаде — красный CI.
8. **ПДн стираются.** Модель из `PII_MODELS` не может иметь `onSubjectErasure: none`. ПДн третьих лиц в записях организации (контрагенты, счета) стираются уничтожением KEK организации (`crypto_shred`).
9. **След человека по id не трогается** (`BY_REFERENCE`): строка `User` остаётся томбстоуном, `PersonChip` рисует «Удалённый пользователь». Псевдонимизация — только для КОПИЙ ПДн (`ChatterEntry.actorName`, `NotificationEvent.snapshot`, подписи шагов решений).
10. **B2C и B2B в одной таблице** — `ownerKey: scoped`; стирание человека `hard_delete{personalOnly}` уносит личные строки, строки организации остаются.

## Страж `pnpm check:lifecycle` (шаг CI до сборок)

`scripts/check-lifecycle.cjs`, ~1–2 с, без сборки (реестр транспилируется на лету): самопроверка реестра (`lifecycleRegistryProblems()` — тот же код, что смоук бута); покрытие (каждая модель `schema.prisma`, сырая таблица миграций — с учётом `RENAME`/`DROP` по порядку операторов, профиль `FILE_PROFILES`, литерал ключа у вызова Redis); колонки политик существуют; FK ↔ рёбра; `PII_MODELS`; `drop_partition` → таблица партиционирована по этой колонке и PK её содержит; `batched_delete` → индекс ведёт колонкой времени, владельца, FK на родителя или колонкой фильтра; `rootEntity` → мягкое скрытие (`deletedAt` / `trashedAt` / `hiddenAt`); каталоги `lifecycle.*` в en/kk/ru без сирот; каждый `handler` и `registry_hook` зарегистрирован в `apps/api/src`; манифест `CANARY_STORES` = реестр; поля политики — только известные (опечатка `retentionDays` = молчаливое «хранить»).

**Ратчет готовности к ячейкам** `scripts/lifecycle.cell-readiness.json` — только сокращается: индексы P-моделей, не ведущие ключом владельца; FK между разными владельцами (кроме `global`); `int4` PK (Basecamp 2018); `findMany` без `take` в методах сервисов, возвращающих списки. Новый пункт — исправить код; `--write` только сокращает файл.

Отложенные пункты стройки — объект `PENDING` в начале стража: у каждой строки этап, строка уходит вместе с этапом.

## Партиции журналов (`LifecyclePartitions`)

Одна дверь для ВСЕХ партиционированных журналов: `analytics.events` и `api_access_log`, `notification_deliveries` и `webhook_deliveries` (месяц), `idem.responses` и `lifecycle_deleted_rows` (день). Правило родителя — строка `lifecycle_partition_specs` (пишет только миграция): колонка, период, **пол срока**, требование архива, класс данных, hold-aware, «очередь» (`require_processed`), вперёд, lz4-колонки, ENABLE ALWAYS-триггеры листа. `security_events` — под своими функциями `core/audit`; здоровье считается и для него.

- **DDL — только SECURITY DEFINER-функции владельца данных** (`sa6_data_owner`): `lifecycle_ensure_partition(parent, at)` = `CREATE (LIKE родитель)` + CHECK границ + `ATTACH` (SHARE UPDATE EXCLUSIVE на родителя — вставки идут; `PARTITION OF` взял бы ACCESS EXCLUSIVE), DEFAULT-партиция запрещена, `lock_timeout 2 с` атрибутом функции; `lifecycle_drop_partition(parent, leaf)` — граница из каталога (`relpartbound`), **пол срока, архив, заморозки, необработанная очередь проверяет БАЗА**, оборванный `DETACH … CONCURRENTLY` доводится `FINALIZE`, затем DETACH + DROP; `lifecycle_analyze_partitioned(parent)`. Роль приложения таблиц не владеет.
- **Движок-владелец объявляет своё** — `LifecyclePartitions.register(parent, { retentionMs?, onDropped? })` (аналитика: срок из окружения + сброс кэша «первого события»; идемпотентность: TTL снимков в часах); `forParent(parent)` отдаёт ручку `ensureFor / ensureAhead / list / dropExpired` (адаптеры `AnalyticsPartitions`, `IdempotencyPartitions`, `KeysUsageCron.partitions`).
- **Срок сброса** = max(срок владельца или `defaultDays` реестра, пол правила, `floorDays` реестра, самый длинный срок организаций у `tenantConfigurable`); ≤ 12 сбросов за прогон; каждый лист — своя попытка (5 повторов при таймауте блокировки, потом пропуск и метрика).
- **Горячий путь**: вставка в период без листа → `isMissingPartition` → `ensureFor` → повтор один раз (фанаут уведомлений, слив журнала ключей, сырьё аналитики; снимок идемпотентности без листа молча пропускается).
- **Ночь** (`LifecycleCron`, 01:40 по Алматы, Redis-лок): вперёд, сброс по сроку, `ANALYZE` родителей (автовакуум родителей не анализирует), здоровье → метрики; здоровье ещё и каждые 6 часов. Бут доделывает «вперёд». Метрики: `lifecycle_partitions_ahead{parent}` (алерт < 2), `lifecycle_partitions_detach_pending`, `lifecycle_partitions_total`, `lifecycle_partitions_dropped_total`, `lifecycle_partition_maintenance_errors_total{parent,op}`.
- **Поиск по одному id** в партиционированной таблице — только с подсказкой времени: `byIdWithTimeHint(id)` (UUIDv7 → окно ± 1 ч; иной версии — без окна). Доставки вебхуков ставят `created_at` из времени id; доставки уведомлений — момент СОБЫТИЯ (детерминирован → уникум `(event, recipient, channel, created_at)` жив и на ретрае в другом месяце; джоб доставки несёт `at` — точный ключ партиции).

## Роли, append-only, событийный триггер

`db-roles.sql` (часть 2, суперпользователем после `migrate deploy`): `sa6_data_owner` владеет партиционированными журналами (родители + листья), деньгами (`ledger_transfers`, `escrow_*`, `card_skin_transfers`, `fin_audit_logs`) и таблицами движка, где удаление = подлог (`lifecycle_holds`, `lifecycle_erasure_journal`, `lifecycle_hold_store`, `lifecycle_hold_extractions`, правила и архивы партиций); роль приложения — только DML через родителя (листья — SELECT, дефолт-привилегии новых листьев). `sa6_migrate` (член владельца: ALTER можно), `sa6_readonly` (`pg_read_all_data`), `sa6_backup` (`pg_read_all_data`, REPLICATION, функции бэкапа) — все NOLOGIN, вход выдаёт эксплуатация. **Событийный триггер `lifecycle_guard_drop`** (`sql_drop`): DROP TABLE / DROP COLUMN / DROP SCHEMA CASCADE защищённой таблицы или листа зарегистрированного родителя — только от `sa6_data_owner` / `sa6_audit_owner` (т.е. изнутри их функций); осознанно — `SET ROLE sa6_data_owner`; аварийно — `ALTER EVENT TRIGGER lifecycle_guard_drop DISABLE`.

Триггеры миграции (ENABLE ALWAYS — работают и при `session_replication_role = replica`): леджер — UPDATE/DELETE/TRUNCATE запрещены (исправление — встречной проводкой); история скинов и журнал книги финансов — UPDATE запрещён, DELETE — только когда родителя уже нет (каскад/purge владельца); эскроу — удаления нет, у договора меняется только статус, у удержания — не меняются стороны и договор; заморозка — меняются только поля снятия, TRUNCATE запрещён; журнал стираний — меняется только `exported_at`.

## Корзина корневых сущностей

`rootEntity` реестра обязан иметь мягкое скрытие. Задачи, события календаря, записи Диктофона — `deletedAt` + корзина 30 дней по образцу Заметок и Диска: `POST …/:id/trash` → `POST …/:id/restore` → `DELETE …/:id` навсегда **только из корзины** (`400 <сервис>.trashFirst`), `GET …/trash`; каждый путь чтения — `deletedAt: null`; частичный индекс `(deleted_at) WHERE deleted_at IS NOT NULL`; авточистка через 30 дней — кронами сервисов (в Э3 — раннер purge по хукам `tasks.trash` / `calendar.trash` / `recorder.trash`). Детали — [tasks.md](tasks.md), [calendar.md](calendar.md), [recorder.md](recorder.md). Веб — общий `components/trash/TrashTable`.

## Хранение

Очередь джобов — `fillfactor=80`, автовакуум по порогу; сессии — `fillfactor=85`; леджер — `autovacuum_freeze_min_age=0` + BRIN по `created_at`; lz4 — `notes.content`, `process_versions.document|compiled`, `consent_versions.bodies`, `messages.payload`, `notification_events.payload`, тело доставки вебхука; BRIN по времени у журналов доставок и `api_access_log`. Индексы под раннер purge (`sessions.revoked_at`, `platform_command_requests.created_at`, время у таблиц движка) — страж `check:lifecycle` требует, чтобы индекс вёл колонкой времени/владельца/фильтра. Выполненные джобы живут сутки, перестройка индексов очереди — раз в неделю ([jobs_engine.md](jobs_engine.md)).

## Смоук бута

`LifecycleModule` (`@Global`) на `onApplicationBootstrap` зовёт `lifecycleRegistryProblems()`: хоть одна проблема — старт API падает (как у `core/visibility` и `KeysRoutesAudit`).

## Ловушки

- **`DETACH … CONCURRENTLY` из функции невозможен** (PostgreSQL: «cannot be executed from a function»), а DDL журналов — только функциями владельца. Поэтому сброс — обычный DETACH под `lock_timeout 2 с` с повторами; а вот `DETACH … FINALIZE` из функции работает (проверено на PG18) — зависший detach функция доводит сама.
- **`SET LOCAL` внутри функции утекает в транзакцию вызывающего** — таймаут блокировки задаётся атрибутом функции (`SET lock_timeout = '2s'`), он откатывается при выходе.
- **ENABLE ALWAYS не наследуется листом при ATTACH** (сам триггер клонируется) — функция включает его на листе по списку правила; TRUNCATE листа — мимо родителя, поэтому свой BEFORE TRUNCATE.
- **Лист чужой роли функция не сбросит** («must be owner»): листья заводит только `lifecycle_ensure_partition`; сьюты тоже (`verify-analytics`).
- **Кэш правил** — 5 минут на процесс; промах в горячем пути перечитывает один раз, здоровье и ночной прогон читают свежими.
- **Сторожевая строка на uuid-колонке** (`{ id: '__none__' }`) падает P2023; «ничего» — `{ id: { in: [] } }`. Агрегата `max(uuid)` в PostgreSQL нет. Не-uuid от клиента → `404 db.notFound` ([api_conventions.md](api_conventions.md)).
- **Отмена события раньше не доходила никому**: удаление стирало строку до фанаута, резолвер права видеть отсеивал всех. С корзиной строка жива — резолвер события пропускает организатора и участников и для события в корзине.

- **Литерал похож на ключ Redis, но им не является** (AAD шифрования `process-cred:`, метаданные декораторов `idempotency:options`): страж сканирует только файлы, работающие с Redis; фрагмент составного ключа (`p:${hmac}`) с односимвольным первым сегментом не считается ключом.
- **Сырой SQL миграций разбирается по порядку операторов**: перевод журнала в партиции (`CREATE → RENAME _old → CREATE … PARTITION BY → DROP _old`) иначе теряет таблицу. Комментарии `--` внутри `CREATE TABLE` вырезаются до разбора.
- **Точка в ключе каталога запрещена** (next-intl делит по точке): `table:analytics.events` живёт в каталоге как `tables.analytics_events` — путь даёт `lifecycleCatalogPath()`.

## Проверка

- `pnpm check:lifecycle` — на срабатывание проверен подсадками: модель без политики, `retain_legal` без нормы, `'30'` вместо числа — красный; после уборки — зелёный.
- `node apps/api/scripts/verify-partitions.cjs` — функции владельца на пробном родителе `lc_probe.events` (своя схема; разрушительное — в откатываемых транзакциях): ATTACH без ACCESS EXCLUSIVE (проба `pg_locks`), вставка не мешает заводить месяц, идемпотентность, владелец листа, lz4, снятый CHECK, запрет DEFAULT, пол срока, чужое имя, «detach pending» → FINALIZE, заморозка платформы/организации и отметка извлечения, очередь с необработанной строкой, событийный триггер (DROP листа, DROP COLUMN, осознанный DROP от владельца), append-only денег и заморозок, реальные родители (вперёд ≥ 3, нет DEFAULT и зависших detach, правило = реестр), время доставок, дев-ручки здоровья и обслуживания.
- `node apps/api/scripts/verify-trash.cjs` — корзина задач (поддерево, скрытие у всех, счётчики, календарь, «навсегда») и событий (отмена доходит участнику, напоминания сняты, восстановление); корзина записей — `verify-voice.cjs`, возврат заморозки награды — `verify-escrow.cjs`.
- `node apps/api/scripts/verify-lifecycle.cjs` — живые сверки с dev-стендом: каждая таблица базы покрыта политикой; каждый FK базы (по `pg_constraint`, правило `ON DELETE`) объявлен ребром нужного вида; каждый ключ живого Redis принадлежит семейству (`SCAN`); у семейств с потолком TTL нет ключей без срока.

## Связанные доки

[audit_engine.md](audit_engine.md) (события `lifecycle.*`, категория `lifecycle`) · [keys_pii.md](keys_pii.md) (`PII_MODELS`, crypto-shredding) · [workspaces.md](workspaces.md) (каскад удаления организации) · [users_profile.md](users_profile.md) (грейс удаления аккаунта) · [jobs_engine.md](jobs_engine.md) · [i18n.md](i18n.md)
