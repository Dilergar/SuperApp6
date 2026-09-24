# Жизненный цикл данных (`core/lifecycle`)

> Код: `apps/api/src/core/lifecycle`, реестр политик — `packages/shared/src/lifecycle` (`types.ts`, `registry.ts`, файлы областей `core.ts` · `messenger.ts` · `workspaces.ts` · `personal.ts` · `stores.ts`), страж — `scripts/check-lifecycle.cjs` + ратчет `scripts/lifecycle.cell-readiness.json`, сьют — `apps/api/scripts/verify-lifecycle.cjs`, события журнала — `packages/shared/src/audit/lifecycle.ts`, каталог — `packages/i18n/src/messages/<locale>/lifecycle.json`.

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

## Смоук бута

`LifecycleModule` (`@Global`) на `onApplicationBootstrap` зовёт `lifecycleRegistryProblems()`: хоть одна проблема — старт API падает (как у `core/visibility` и `KeysRoutesAudit`).

## Ловушки

- **Литерал похож на ключ Redis, но им не является** (AAD шифрования `process-cred:`, метаданные декораторов `idempotency:options`): страж сканирует только файлы, работающие с Redis; фрагмент составного ключа (`p:${hmac}`) с односимвольным первым сегментом не считается ключом.
- **Сырой SQL миграций разбирается по порядку операторов**: перевод журнала в партиции (`CREATE → RENAME _old → CREATE … PARTITION BY → DROP _old`) иначе теряет таблицу. Комментарии `--` внутри `CREATE TABLE` вырезаются до разбора.
- **Точка в ключе каталога запрещена** (next-intl делит по точке): `table:analytics.events` живёт в каталоге как `tables.analytics_events` — путь даёт `lifecycleCatalogPath()`.

## Проверка

- `pnpm check:lifecycle` — на срабатывание проверен подсадками: модель без политики, `retain_legal` без нормы, `'30'` вместо числа — красный; после уборки — зелёный.
- `node apps/api/scripts/verify-lifecycle.cjs` — живые сверки с dev-стендом: каждая таблица базы покрыта политикой; каждый FK базы (по `pg_constraint`, правило `ON DELETE`) объявлен ребром нужного вида; каждый ключ живого Redis принадлежит семейству (`SCAN`); у семейств с потолком TTL нет ключей без срока.

## Связанные доки

[audit_engine.md](audit_engine.md) (события `lifecycle.*`, категория `lifecycle`) · [keys_pii.md](keys_pii.md) (`PII_MODELS`, crypto-shredding) · [workspaces.md](workspaces.md) (каскад удаления организации) · [users_profile.md](users_profile.md) (грейс удаления аккаунта) · [jobs_engine.md](jobs_engine.md) · [i18n.md](i18n.md)
