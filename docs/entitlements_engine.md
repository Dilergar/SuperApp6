# core/entitlements — тарифы и лимиты (19-й движок)

> ОДИН источник правды «что можно этому человеку / этой организации и сколько»: реестр ключей в shared, планы с версиями, подписки субъектов, гранты, индивидуальные условия (оверрайды) и счётчики квот. Сервисы НЕ хранят потолки в константах и не решают сами — они спрашивают движок (`can`/`limit`/`assertCanCreate`/`consume`) и получают единый отказ `402 Payment Required` с кодом `entitlement.*` и подсказкой «как разблокировать». Денег в движке НЕТ: оплата — будущий потребитель (`source: payment`), сейчас подписки ставит триал и кабинет платформы.

Код: `apps/api/src/core/entitlements/` (`entitlements.service.ts` — фасад для потребителей; `entitlements.resolver.ts` — лестница значений; `entitlements.catalog.service.ts` — планы, версии, публикация; `entitlements.cache.ts` — снимки в Redis + ALS-мемо + пакетное чтение; `entitlements.quota.service.ts` — счётчики; `entitlements.registry.ts` — реестры провайдеров расхода и сверки; `entitlements.lifecycle.ts` — триал/грейс/истечение, джоб-будильник и кроны; `entitlements.controller.ts` — `/entitlements/*`; `entitlements.platform.provider.ts` — команды и панели кабинета; `entitlements.notifications.ts`; `entitlements.dev.ts`). Реестр и типы — `packages/shared/src/entitlements/` (`types.ts`, по файлу на сервис, `plans.ts`, `index.ts`), формы провода — `packages/shared/src/types/entitlements.ts`, Zod — `packages/shared/src/validation/entitlements.ts`.

## Реестр ключей (shared)

`ENTITLEMENT_REGISTRY` собирается `defineEntitlements(...)` из файлов по сервисам. Ключ = `<service>.<name>`, паспорт `EntitlementDef`:

| Поле | Значения | Смысл |
|---|---|---|
| `kind` | `feature` · `limit` · `quota` · `config` | булев доступ · потолок «сколько сущностей» · расходуемый объём за период · число-настройка без потолка (слияние по ранту источника) |
| `carrier` | `container` · `person` | кто НОСИТ значение: container-ключ живёт в контейнере контекста (личное пространство или организация) и между ними НЕ протекает, person-ключ едет с человеком во все контексты (скин карточки) |
| `subjects` | `user` · `workspace` · `family` | у каких субъектов ключ вообще есть |
| `defaultFree` | значение бесплатного плана | `null` у limit/quota = без ограничения; `false` у feature = закрыто |
| `unit` / `period` | `count` · `bytes` · `day` · `month` | единица для форматтеров и период сброса квоты (UTC, лениво) |
| `service` / `labelKey` | сервис из `ENTITLEMENT_SERVICES`, ключ каталога `entitlements.keys.<camel>` | подписи для страницы «Тариф и лимиты» и кабинета |

Первая волна: `workspace.seats` (1000) · `workspaces.maxOwned` (20) · `files.storageBytes` (15 ГБ человек / 100 ГБ организация) · `files.count` (без потолка, счётчик) · `contacts.maxCircles` (50) · `shop.maxShowcases` (50) · `objects.maxPerWorkspace` (2000) · `legalEntities.maxPerWorkspace` (20) · `skins.perGroup` (закрыто) · `notifications.smsPerDay` (500/день). Планы — `PLAN_KEYS`/`PLAN_DEFS` (`free`, `personal`, `family`, `business_free`, `business_basic`, `business_standard`, `business_pro`), триал — `TRIAL_PLAN {user: personal, workspace: business_pro}`, `TRIAL_DAYS = 30`, `GRACE_DAYS = 15`. Значение проверяется `isValidEntitlementValue(def, v)`; сравнение «больше» — `entitlementGreater` (для feature `true > false`, для limit `null` = бесконечность).

Журнал безопасности (сервис `audit`): `audit.retentionDays` (config — окно журнала организации: free 90 / basic 180 / standard 365 / pro 1095; `null` в оверрайде ограничен сроком хранения, сбой чтения — fail-closed к 90), `audit.export` (feature, basic+), `audit.stream` (feature, standard+: подписка на `security.*` вебхуки). Запись событий, сессии, устройства, «Это не я» и заморозка от тарифа не зависят никогда — [audit_engine.md](audit_engine.md).

**Новый ключ** = один файл сервиса в shared + `defaultFree` + подписи `entitlements.keys.<camel>` в трёх каталогах + `assert*`/`consume` в сервисе + замок/шкала в вебе. Ключ на лету (не из реестра) компилятор не пропустит: `EntitlementKey` — union.

## Модель данных (Prisma)

`Plan` (key, subjectType) → `PlanVersion` (version, status `draft|published|archived`, `entitlements` JSON — только ключи субъекта, отсутствующий ключ = как в бесплатном) · `SubjectSubscription` (subjectType+subjectId, plan, `pinnedVersionId?`, status `trialing|active|past_due|expired|cancelled`, source `trial|manual|migration|payment`, `trialEndsAt`, `currentPeriodEnd`, `graceUntil`, `trialConsumedBy`) · `EntitlementGrant` (ключ, значение, source `gift|trial|family|addon|manual|legacy`, `priority`, `validUntil`, `revokedAt`) · `EntitlementOverride` (ключ, mode `set|unlimited|deny`, value, `validUntil`, `reason`, `createdBy`) · `QuotaCounter` (subject × key × period, `used`, `resetAt`).

Партиальные уникумы (руками в миграции, коммент в схеме): `subject_subscriptions_live_uniq` — одна живая подписка на субъект; `subject_subscriptions_trial_consumer_uniq` — один бизнес-триал на человека (`trial_consumed_by`). Сид миграции: 7 планов с фиксированными id `00000000-0000-4000-8000-00000000000{1..7}`, версии `…010{1..7}` (`business_free`/`free` опубликованы, остальные — черновики по `PLAN_SEED_POLICY`), триалы существующим людям и организациям, перенос счётчиков Диска.

## Лестница значения

`override (живой) → grants (слияние: feature — OR, limit — MAX, quota — SUM, rank — max) → план (закреплённая версия, если она не draft → последняя опубликованная → defaultFree) → defaultFree`. Подписка со статусом `expired|cancelled` = плана нет. Снимок субъекта (`EntitlementSnapshotDto`) несёт `values[key] = {value, used, resetAt, source, sourceKind, sourceUntil, unlock}`, `subscription`, `recentlyEnded` (подписка кончилась ≤ 30 дней назад — для сигнала в шапке). В контексте организации person-ключи читаются у ЧЕЛОВЕКА, остальное — у организации.

**Отсутствие ключа у субъекта ≠ «без ограничения».** `null` у limit/quota означает бесконечность, поэтому спросить личный ключ у организации (или наоборот) — не отказ тарифа, а БАГ ВЫЗЫВАЮЩЕГО: `valueOf`/`can`/`limit`/`assertCanCreate`/`consume`/`release` падают внутренней ошибкой (`assertKeyForSubject` по полю `subjects` реестра), а `POST /entitlements/check` отвечает `allowed: false` с кодом `entitlement.key_not_for_subject`. Частая причина — вызов `can`/`limit` ВНЕ запроса: в джобе и кроне ALS пуст, и `contextSubject()` отдаёт личный субъект — там субъект передают явно.

Кэш: `ent:snap:{catalogEpoch}:{type}:{id}:{subjectEpoch}` в Redis, TTL ≤ 300 с (короче — если ближайший `validUntil`/`resetAt` раньше); эпоха каталога бампается публикацией/архивом версии, эпоха субъекта — любой мутацией его подписки/грантов/оверрайдов/квот. Внутри запроса — ALS-мемо, поэтому три `can()` в одном хендлере = один резолв (отказ в мемо НЕ запоминается: блип БД не залипает до конца запроса). Сокет: relay `entitlements:changed` → веб инвалидирует `entitlementsKey(context)`.

Где снимки спрашивают ДЕСЯТКАМИ (косметика на карточках людей — `personKeysFor`), путь пакетный: `cache.getManyOrCompute` делает два обращения к Redis на всю пачку, а промахи считает ОДИН `computeMany` (четыре запроса на пачку вместо четырёх на человека). Результат ложится в тот же кэш, что и одиночный, — правила слияния не дублируются. Значения версии плана берутся из кэша каталога (`publishedValuesByPlan`), поэтому подмена черновика последней опубликованной не стоит запроса.

## Контракт потребителя

```ts
await ent.assertFeature(subject, 'skins.perGroup');                 // 402 entitlement.feature_locked
await ent.assertCanCreate(tx, subject, 'shop.maxShowcases', 1);     // 402 entitlement.limit_reached — В ТРАНЗАКЦИИ создания
await ent.consume(tx, subject, 'notifications.smsPerDay', 1);       // 402 entitlement.quota_exhausted; release(tx, …) при откате
await ent.assertQuotaHeadroom(subject, 'files.storageBytes', bytes); // до дорогой работы (загрузка), consume — после
const v = await ent.valueOf(subject, key); const ok = await ent.can(subject, key); const lim = await ent.limit(subject, key);
```

- `assertCanCreate` считает факт своим SQL (`countFor` из реестра потребителя) под `pg_advisory_xact_lock(hash(subject, key))` — два параллельных «создать» не проскочат потолок. Отказ ДО эффектов и в той же транзакции.
- Квоты: `INSERT … ON CONFLICT DO NOTHING` + условный `UPDATE used = used + delta WHERE used + delta <= limit`; период сбрасывается лениво по `resetAt` (UTC). `quotaState` — для шкал. Расходуемый эффект, который может не случиться (SMS через шлюз), берёт квоту РЕЗЕРВОМ до эффекта и возвращает `release` на КАЖДОМ пути неуспеха — иначе сбой и каждый ретрей джоба сжигали бы платную квоту, ничего не доставив.
- Сверка (`QuotaReconcileProvider` → `quota.set`) ставит и окно периода: строка, созданная сверкой без `period_end`, уже никогда не сбросилась бы лениво — периодическая квота осталась бы исчерпанной навсегда.
- Отказ — ТОЛЬКО `paymentRequired(code, { unlock })` (`shared/errors/api-error.ts`): `details.code ∈ entitlement.feature_locked | limit_reached | quota_exhausted | plan_expired | seat_required | entitlement.key_not_for_subject`, `details.unlock = { by: 'self' | 'workspace_owner', plan }` — веб показывает замок и «кому идти». Никаких 403 за тариф. `by` учитывает РОЛЬ зрителя: владельцу и админу организации замок говорит «доступно на ступени X» (`self`), рядовому сотруднику — «решает владелец».
- Числа в тексте отказа уезжают МАШИННЫМИ: байты — параметрами `usedBytes`/`valueBytes`, и «4,1 ГБ» собирает фильтр отказов в языке запроса (конвенция `<имя>Bytes` — [i18n.md](i18n.md)). Сервис строку не печёт: он не знает, кто и на каком языке прочтёт отказ.
- Возврат сущности ИЗ АРХИВА — то же самое, что создание: провайдеры расхода считают только ЖИВЫЕ строки (`archivedAt: null`, `isActive: true`, `status: 'ready'`), поэтому `restore` обязан вызвать `assertCanCreate` (объекты — на всё оживающее поддерево). Иначе архив был бы обходом тарифа: закрыть 2000, создать 2000, вернуть закрытые.
- Методы движка прав НЕ проверяют — субъект подставляет вызывающий (`contextSubject()` из chokepoint или явно).

Потребители первой волны: `WorkspacesService` (`workspaces.maxOwned` при создании и восстановлении, `workspace.seats` при приглашении и принятии — `WorkspacesEntitlementsProvider`), `FilesService` (`files.storageBytes` до загрузки + `consume` после, `release` при удалении; `files.count`; `FilesCron` сверяет счётчики), `CirclesService`, `ShopService`, `ObjectsService` (создание и возврат поддерева из архива), `LegalEntitiesService` (создание и возврат из архива), `CardSkinsService` (`skins.perGroup` — раньше `premiumUntil`), `NotificationsDelivery` (`notifications.smsPerDay` резервом с возвратом), `AuthService` (триал при регистрации), `UsersService` и `WorkspacesService.purgeWorkspace` (`forgetSubject`). Реестры движка регистрируют сами модули: `UsageProviderRegistry.register(key, { count })` — «сколько ЖИВЫХ уже есть» (обязан уметь читать через `tx`), `QuotaReconcileRegistry.register(key, { reconcile })` — ночная сверка счётчиков с фактом.

## Жизненный цикл

`startTrial(tx, subject, { consumedBy })` — сырой `INSERT … ON CONFLICT DO NOTHING RETURNING id` (второй бизнес-триал того же человека молча не создаётся; Prisma-`create` с P2002 внутри чужой транзакции ОБРУШИЛ бы её — `25P02`). `scheduleExpiry` ставит ОДИН тип джоба-будильника `entitlements.expiry` (`{kind: 'subscription'|'grant'|'override', id}`) на ближайший срок; `uniqueKey` несёт метку времени, поэтому сдвиг срока = новый будильник, а обработчик идемпотентен и перечитывает строку. `active` с истёкшим `currentPeriodEnd` → `past_due` до `graceUntil` (15 дней, значения ещё действуют) → `expired`. Переходы — status-guarded `updateMany`.

Три крона движка (Redis-лок, один инстанс): `04:15` предупреждения «пробный кончается» за 7 и за 1 день (одно на рубеж, `idempotencyKey` с рубежом); `04:35` второй ремень — живые подписки с прошедшим сроком, у которых будильник потерялся; `04:50` сверка расходуемых квот с фактом (провайдеры владельцев данных; в dev — `POST /entitlements/dev/reconcile`).

`forgetSubject(tx, subject)` чистит полиморфные строки субъекта (FK у них нет) — С ОДНИМ исключением: строка потраченного бизнес-триала организации (`trial_consumed_by`) не значение, а ЖУРНАЛ «этот человек свой пробный период уже получил», и она переживает purge в статусе `cancelled`. Удали её вместе с организацией — и цепочка «архив → 90 дней → purge → новая организация» выдавала бы владельцу новый триал бесконечно. Удаление аккаунта чистит всё, включая личную подписку: регистрация заново = новый человек и новый триал (осознанно).

## Уведомления

Реестр `packages/shared/src/notifications/entitlements.ts` (сервис `entitlements`, order 85): `entitlement.trial.ending` · `entitlement.trial.expired` · `entitlement.subscription.grace` · `entitlement.subscription.expired` · `entitlement.quota.threshold` (80 %) · `entitlement.quota.exhausted` · `entitlement.seats.exhausted`. Адресат — сам человек или владелец/админы организации (`roles`-фильтр адресатов); deep link — `NotificationRefRegistry` (`entitlement` → страница «Тариф и лимиты»). Объёмы в payload — `<имя>Bytes` числом (рендер собирает «4,1 ГБ» в языке адресата — [notifications_engine.md](notifications_engine.md)).

## API и веб

`GET /entitlements/me` — снимок контекста (`X-Workspace-Id`). ЗНАЧЕНИЯ и расход организации уезжают любому её члену (шкала места на Диске организации нужна всем), а коммерческая карточка — `subscription` и `recentlyEnded` — ТОЛЬКО владельцу и админу: роль берётся из чокпоинта (ALS), гейт живёт в `snapshot()`. Кабинет платформы и фон ходят мимо гейта через `systemSnapshot()` (`system*`-метод: прав не проверяет, права проверил исполнитель команд).

`POST /entitlements/check` `{items: [{key, delta?}]}` — батч для UI и AI до действия (до 50 элементов; расход и ступень считаются один раз на ключ, даже если ключ спрошен несколько раз с разными `delta`). Dev-полигон (только development/test): `dev/shift-subscription`, `dev/shift-grant`, `dev/run-expiry`, `dev/run-trial-warnings`, `dev/reconcile`, `dev/bump`, `dev/consume`, `dev/release`, `GET dev/raw`. Кабинет платформы — `GET /platform/entitlements/catalog`, `GET /platform/entitlements/subjects/:type/:id` и команды `entitlements.*` ([platform_console.md](platform_console.md)). Правки кабинета живут по трём правилам движка: **срок обязателен** у ручного гранта и у оверрайда (бессрочная привилегия переживает причину, по которой её выдали — продление = новый грант); **субъект узнаёт** о каждой правке (`entitlement.support.changed` шлётся в ТОЙ ЖЕ транзакции, что и правка: откат команды или предпросмотр уносят и уведомление; кто из сотрудников правил — наружу не едет); **последнюю опубликованную версию плана не архивируют**, пока по плану есть живые подписки (`409 entitlement.planLastPublished`): подписка на черновике читает значения последней опубликованной, и проверка «пришита ли к этой версии» таких подписчиков не видит — они молча упали бы на `defaultFree`.

Веб: `lib/entitlements-api.ts` + ключи `entitlementsRootKey`/`entitlementsKey(context)` в `lib/queries.ts`; хуки `useEntitlements(workspaceId?, enabled)`, `useEntitlement(key)`, `useEntitlementGate(key)` (замок до действия), `useEntitlementDenied()` (перевод 402 в тост со ссылкой «Тариф»); кит `components/entitlements/`: `EntitlementGauge` (tick-шкала «7 из 20»), `EntitlementLock` (замок с `unlock`), `PlanAndLimits` (страница «Тариф и лимиты»: `/profile/subscription`, `/workspaces/:id/profile/subscription`); `PlanSignal` в шапке организации и панели дашборда — только для trialing/past_due/recentlyEnded. Неймспейс `entitlements` обязан быть в `ServiceMessages` КАЖДОГО layout, где живут эти компоненты — вложенный layout ЗАМЕНЯЕТ словарь, а не дополняет ([i18n.md](i18n.md)).

## Проверка

`node apps/api/scripts/verify-entitlements.cjs`: снимок free/триал, `assertCanCreate` под потолком и через `override`, гонка двух созданий на пороге, квота Диска (`consume`/`release`/сверка), квота SMS с ленивым сбросом и возвратом единицы, `402` с кодом и `unlock`, person-ключ в контексте организации, гранты (слияние, просрочка), триал организации → истечение → `expired` + уведомление владельцу, **роль-гейт** (владелец видит подписку и `unlock.by=self`, рядовой член — только значения и `unlock.by=workspace_owner`), **ключ не для субъекта** (`entitlement.key_not_for_subject` в обе стороны), **возврат из архива на потолке → 402**.

Не покрыто сьютом (проверяется подсадкой вручную): ветка возврата SMS-бюджета при отказе шлюза — mock-драйвер в dev всегда успешен.

**Правила видимости (`core/visibility`).** Ключи: `visibility.orgAudiences` (адресаты оргструктуры в матрице — отдел / должность / объект), `visibility.revealDelegation` (делегирование раскрытия руководителю), `visibility.explain` («Проверить сотрудника»), `visibility.presets` (готовые наборы), потолок `visibility.maxRules` (правил в политике; жёсткий предел платформы — 5000), квота `visibility.revealsPerDay` (раскрытий в сутки на человека, 100 — антискрейпинг, едет с человеком). Базовая видимость (роли, личные настройки, раскрытие одной записи, «четыре глаза») тарифом не закрывается: безопасность данных не продаётся — [visibility_engine.md](visibility_engine.md).

## Ловушки

- Второй `startTrial` в транзакции регистрации — только сырым `INSERT … ON CONFLICT`: любой P2002 внутри `$transaction` вызывающего = откат всего.
- Потолок читается ВСЕГДА из движка — константа `*_LIMITS.max*` в shared удалена; осталась только валидация формы (`nameMaxLength` и т.п.).
- Отсутствие ключа у субъекта читается как «без ограничения», если не проверить применимость: `null` у limit/quota = бесконечность. Поэтому вход резолва — fail-closed (`assertKeyForSubject`), а `check` отвечает `key_not_for_subject`, а не «можно».
- Провайдер расхода считает ЖИВЫЕ строки; значит каждый путь ВОЗВРАТА из архива обязан звать `assertCanCreate` (правило действует только во всех путях).
- Квота, взятая до эффекта, который может не случиться, обязана возвращаться на всех путях неуспеха — включая ретрей джоба.
- `quota.set` (сверка) без окна периода = счётчик, который не сбросится никогда. Проверка на срабатывание: строка с `period_end = NULL` доходит до потолка и остаётся в `402` навсегда, с окном в прошлом — `consume` сбрасывает её в `used = 1`.
- Черновик версии не действует, даже если закреплён у подписки: лестница берёт последнюю опубликованную; нет опубликованных → бесплатные значения.
- **Платные ступени пока ЧЕРНОВИКИ, и это меняет смысл сегодняшнего триала:** миграционные подписки пришиты к v1 `personal`/`business_pro`, которые не опубликованы, поэтому «пробный период» отдаёт значения свободной ступени, а шапка при этом честно пишет «осталось N дней» и по истечении пришлёт «действуют значения бесплатного тарифа». Перед публикацией версий сверить сетку: `workspace.seats` имеет `defaultFree: 1000`, а сиды платных ступеней — 5/50/250, то есть публикация `business_basic` СРЕЖЕТ места каждой миграционной организации, а `unlockPlanFor` по местам не находит ни одной ступени выше свободной (`unlock.plan: null`). Решение продукта (поднять сиды или опустить `defaultFree`) принимается вместе с публикацией.
- Кэш по эпохам: любая ручная правка строк в БД без бампа эпохи живёт до 5 минут — в dev есть `dev/bump` и `dev/reconcile`.

## Связанные доки

[platform_console.md](platform_console.md) (команды, каталог, субъекты) · [notifications_engine.md](notifications_engine.md) · [jobs_engine.md](jobs_engine.md) · [api_conventions.md](api_conventions.md) (402) · [web_conventions.md](web_conventions.md) · [files_engine.md](files_engine.md) · [workspaces.md](workspaces.md).
