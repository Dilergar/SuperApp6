# Entitlements Resolver: архитектура движков «кто что может и сколько» в индустрии

Исследование для SuperApp6 (модульный монолит NestJS + Postgres 16 + Redis 7, свой ReBAC-движок, B2C+B2B в одном аккаунте). Факты собраны по документации Stripe, Stigg, Schematic, OpenMeter, Kill Bill, Chargebee, OpenFGA, Unleash, RevenueCat и инженерным материалам 2024–2026.

---

## 1. Канонический датамодель индустрии

За последние три года платформы сошлись на одной форме. Разница между Stigg, Schematic, OpenMeter и Chargebee — в деталях, а не в скелете.

### 1.1 Сущности

```
Feature (реестр возможностей: ключ + ТИП)
   ├─ boolean   — есть/нет                         (calls.recording)
   ├─ config    — числовое/enum значение, не расходуется (tasks.maxOpen = 50)
   ├─ metered   — расходуемый ресурс с периодом    (voice.sttMinutes = 300/мес)
   └─ credit    — общий кошелёк, тратится разными фичами (Orb/Metronome/Lago)
        │
        │  PackageEntitlement (feature + value + resetPeriod + isSoftLimit)
        ▼
PlanVersion ───────────── Plan (free / personal / family / business)
   │  version, status (draft | published | archived), publishedAt
   │
   ├── AddOn — докупаемый пакет, стекается ПОВЕРХ плана, может переопределять лимит
   │
   ▼
Subscription (customer → planVersionId, status, currentPeriodStart/End, seats)
   status: trialing | active | past_due | unpaid | paused | canceled   (модель Stripe)
   │
   ├── PromotionalEntitlement / Override
   │      персональные: подарок, триал, ручной оверрайд; effectiveFrom / expiresAt; source
   │
   └── Grant (для расходуемых: amount, priority, effectiveAt, expiration, recurrence, rollover)
        │
        ▼
UsageCounter / Meter events ──► Balance = Σ(активные гранты) − usage
        │
        ▼
RESOLVER: (subject, context, key) → { hasAccess, value, used, remaining, resetAt, reason, upsell }
```

### 1.2 Что здесь канон, а что вариативно

**Канон — есть у всех:**
- три типа фич: boolean / числовой конфиг / метрируемый (Stigg: boolean, config, metered, enum; Schematic: boolean, trait-based, event-based; OpenMeter: boolean, static, metered);
- разделение **package entitlement** (что план даёт всем подписчикам) и **promotional entitlement / override** (что дано лично клиенту поверх плана);
- план **версионируется**, подписка пришпилена к версии — это и есть grandfathering;
- add-on стекается поверх плана;
- резолв возвращает не только «да/нет», но и текущее использование, остаток и момент сброса.

**Вариативно:** правило слияния источников, наличие грантов с приоритетами, где живёт usage (ClickHouse vs Postgres), где резолвится (SDK-кэш vs API).

### 1.3 Правило слияния — самое ценное, что подсказала индустрия

Schematic формулирует явно: когда у компании есть план + add-on'ы + оверрайды, применяется **наиболее щедрое** значение («the most permissive entitlement applies»); если ничего не разрешилось — падаем на глобальные правила, дефолт `false`.

| Тип | Слияние источников | Пример SuperApp6 |
|---|---|---|
| boolean | `OR` (любой источник дал — есть) | `calls.recording` |
| config (лимит-максимум) | `MAX`, а не сумма | 100 ГБ у организации против 50 ГБ семьи → 100 ГБ |
| metered (расходуемая квота) | **`SUM`** балансов грантов, списание по burn-down | 300 мин STT от плана + 100 подарочных |
| enum | высший ранг по порядку реестра | `support: email < chat < dedicated` |
| override (жёсткий) | перебивает всё, включая `deny` | «выключить фичу этому клиенту» |

Это и есть ответ на «арифметика или приоритеты»: **для лимита-максимума — приоритеты (MAX), для расходуемой квоты — арифметика (SUM)**. Так устроен OpenMeter: несколько грантов складываются в один баланс, а списание идёт детерминированно — сначала грант с бо́льшим приоритетом (0–255, где 0 высший), при равном приоритете — тот, что раньше истекает, при равном сроке — созданный раньше. Гранты поддерживают `expiration`, `recurrence` (например +300 единиц ежедневно поверх месячного периода) и `rollover` с `minRolloverAmount` / `maxRolloverAmount`.

---

## 2. Обзор платформ

| Платформа | Модель | Резолв | Usage / метеринг | Оверрайды на клиента | Версии планов |
|---|---|---|---|---|---|
| **Stripe Entitlements** | `Feature{name, lookup_key ≤ 80 симв.}` → `ProductFeature` (привязка к Product) → `ActiveEntitlement{id, feature, lookup_key, livemode}`. **Только boolean** | Вебхук `entitlements.active_entitlement_summary.updated` + `GET /v1/entitlements/active_entitlements?customer=`. Stripe сам рекомендует «persist these entitlements internally for faster resolution» | Отдельная подсистема Billing Meters: meter events, до 10 000 событий/с через meter event stream (до 100 000/с в v2), агрегация асинхронная и eventually consistent. С entitlements не связана | Нет: привязка к продукту, не к клиенту | Нет версий. Изменение набора фич продукта для существующих подписок применяется **со следующего billing period** |
| **Stigg** | boolean / config / metered / enum; Plan (free/paid/custom) + AddOn; package vs promotional entitlements; reset period month/week/day/hour | SDK с **in-memory кэшем**; инвалидация опросом (по умолчанию **30 с**) либо WebSocket-стримом (только backend SDK); глобальная fallback-стратегия + пофичевая; оффлайн — проверки работают, метеринг откладывается до возврата связи | Клиент шлёт посчитанный usage либо сырые события, Stigg агрегирует мерами | Promotional entitlements — независимы от плана | Явное версионирование: номер с 0, статусы draft/published/archived, клон → правка → publish; старые подписчики остаются на своей версии |
| **Schematic** | Company (ровно один план + add-on'ы) / User; features boolean / trait-based / event-based; Flag — рантайм-гейт, всегда boolean, ключ общий с фичей | `check` **без контекста в рантайме**: платформа хранит план, трейты, аллокации и usage компании и сама считает правила по приоритету | `track`-событие = метеринг и продуктовая аналитика в одном вызове | Company overrides; «most permissive wins», затем глобальные правила, дефолт false | Планы версионируются автоматически; новые версии не затрагивают действующих подписчиков |
| **Chargebee** | Feature + entitlement на уровне item price | API | — | `entitlement_overrides` на уровне подписки / item price / charge-item, с `expires_at`; после истечения запись пропадает из выдачи и удаляется в течение 12 ч | Через версии item price |
| **OpenMeter (OSS)** | metered / static (JSON-конфиг) / boolean; `usagePeriod` (DAY/WEEK/MONTH), `isSoftLimit`, `preserveOverageAtReset`, `anchor` | `GET /entitlements/{id}/value` → `{hasAccess, balance, usage, overage, config}` | CloudEvents → Kafka → ClickHouse, гранулярность агрегации 1 минута; Postgres для конфигурации и подписок; Redis опционально для дедупликации | Гранты на конкретного subject | — (каталог отдельно) |
| **Kill Bill (OSS)** | Каталог XML: Product (BASE / ADD_ON / STANDALONE) → Plan → Phases (TRIAL / DISCOUNT / FIXEDTERM / EVERGREEN) → billing period и цены по валютам; price lists; usage CONSUMABLE / CAPACITY, IN_ARREAR | Подписка знает свою версию каталога | Тиры по блокам | Pricing overrides на подписке | **Эталон**: новый каталог с `effectiveDate`; существующие подписки автоматически остаются на старой версии; `effectiveDateForExistingSubscriptions` — отложенное применение к старым |
| **Lago (OSS, AGPL)** | Plans + charges, wallets / prepaid credits, progressive billing; Postgres с `pg_partman` для партиций событий | API | до ~15 000 событий/с | Wallets, overrides | Версии планов |
| **Orb / Metronome** | Кредиты и коммиты: prepaid credits, auto-top-up, expiration policies, real-time balance | Orb — реальная проверка баланса перед действием; Lago/Metronome — invoice-driven, овередж всплывает постфактум | Событийный метеринг | Sales-granted credits | Контракты |
| **LaunchDarkly / Unleash / Flagsmith** | Флаги + таргетинг: activation strategies, constraints, **segments** (переиспользуемый набор constraints), context fields, stickiness | SDK со стримом | Нет | Таргетинг на конкретный аккаунт | Нет версий-контрактов |
| **OpenFGA / SpiceDB** | ReBAC-кортежи | `check(user, relation, object)` | Нет | Кортежами | Нет |
| **RevenueCat** (мобильный эталон) | Entitlement identifier + Offerings | `CustomerInfo` кэшируется на устройстве, `getCustomerInfo()` в большинстве случаев синхронен; **Offline Entitlements**: при недоступности серверов SDK верифицирует покупки локально и временно выдаёт entitlement; Offerings имеют низкий TTL и не переживают перезапуск приложения | — | — | — |

**Вывод по Stripe отдельно.** Stripe Entitlements — это boolean-метаданные, приклеенные к биллинговым объектам: нет числовых лимитов, нет счётчиков, привязка к продукту, а не к клиенту, нет оверрайдов и grandfathering; вебхук несёт максимум 10 записей (остальное — по `entitlements.url`) и асинхронен, то есть сразу после апгрейда бэкенд ещё видит старое состояние. Для SuperApp6 это значит: **биллинг-провайдер не может быть источником истины по entitlements**; он источник события «оплачено / подписка изменилась».

---

## 3. Permission vs entitlement: граница и порядок проверки

Два ортогональных вопроса:

- **Permission (ReBAC, наш `core/access`)** — «имеет ли ЭТОТ субъект отношение к ЭТОМУ объекту». Безопасность данных. Отказ постоянный: `403` / `404`.
- **Entitlement** — «оплачено ли это на тарифе субъекта или организации». Коммерческий доступ. Отказ **разрешим деньгами**: `402`.

Stigg формулирует границу так: авторизация — про организационную безопасность данных, entitlements — про коммерческий доступ; лимиты использования авторизация не поддерживает нативно, а JWT-подход не отражает изменения в реальном времени (купили места — нужно немедленно).

**Можно ли смоделировать entitlement в ReBAC?** Формально да, OpenFGA даёт готовую модель:

```
type feature
  relations
    define associated_plan: [plan]
    define access: [user] or subscriber from associated_plan
type plan
  relations
    define subscriber: [organization]
```

с проверкой `check(user:anne, access, feature:issues)`. Но это работает только для boolean и только пока планов немного: числа, квоты, периоды, овередж, приоритеты грантов в кортежи не ложатся. Практическая ловушка именно для SuperApp6: наш кэш прав построен на эпохах, и если втянуть туда тариф, **любое биллинговое событие будет инвалидировать кэш ПРАВ целиком**. Держать раздельно.

**Порядок проверки.** Мультитенантные руководства советуют ставить entitlement первым — он дешевле (кэш, без БД). Но ответ клиенту обязан приоритезировать permission:

1. Контекст (`X-Workspace-Id` → ALS).
2. `access.can(subject, capability, resource)` — нет права: `403/404`, **и никакого предложения апгрейда** (иначе человек заплатит и всё равно не получит доступ).
3. `entitlements.assert(subject, context, key)` — не оплачено: `402` + upsell-подсказка.
4. Бизнес-логика; резервирование квоты **до** сайд-эффекта.
5. `consume(tx, …)` в той же транзакции мутации.

Дешёвый entitlement-чек по снимку можно выполнить раньше ради быстрого выхода, но если провалились обе проверки — наружу идёт permission-отказ. Коды в нашем едином конверте различаются жёстко: `access.forbidden` против `entitlement.feature_locked` / `entitlement.limit_reached` / `entitlement.quota_exhausted`.

---

## 4. Резолв на масштабе: кэш, снимки, инвалидация, JWT, контекст, слияние

### 4.1 Где вычислять

Индустрия однозначна: **авторитетная запись entitlement должна быть строго консистентной** — чтение, вернувшее старый план сразу после апгрейда, нарушает продуктовый контракт, поэтому eventually consistent хранилище для источника истины исключается; кэши при этом допускают более слабые гарантии. Практическая раскладка по слоям:

| Слой | Хранилище | Латентность | Инвалидация |
|---|---|---|---|
| Снимок entitlements | in-process / Redis, TTL ~60 с | < 0.1 мс | **явно по биллинговому событию**, TTL — только страховка |
| Rate-счётчики | Redis `INCRBY`, окно через TTL | < 2 мс | истекают сами |
| Лимит-максимум (сколько объектов) | Postgres `COUNT` в скоупе тенанта | 3–10 мс | авторитет |
| Квоты (расходуемые) | Postgres счётчик с дельтами | — | ночная сверка |

Целевые числа из тех же источников: p99 проверки < 5 мс; hit-rate кэша > 95 %; дрейф счётчика против источника < 0.1 % (ночная сверка); окно устаревания после даунгрейда < 5 секунд; полный путь «оплата → доступ» < 30 секунд (≤ 5 с биллинг, ≤ 10 с событие и инвалидация). Из SDK-мира: Stigg опрашивает раз в 30 с по умолчанию, бэкенд-SDK держит WebSocket, и после операции, меняющей подписку или usage, кэш рекомендуется обновить немедленно, не дожидаясь опроса.

### 4.2 JWT — нет

Консенсус 2025–2026: **JWT несёт identity, а не права и не entitlements**. Причины: невозможность отзыва без внешнего состояния (что убивает смысл stateless), рост размера токена при попытке уместить перечни, протухание (купили места — токен старый). Правильный компромисс уже реализован у нас в виде `tokenEpoch`: в токене живёт **версия/эпоха**, а не содержимое. Снимок отдаётся отдельной ручкой и пушится в сокет.

### 4.3 Контекстный ключ кэша

```
ent:v{catalogVersion}:{ctx}:{subjectId}:e{subjectEpoch}
   ctx = "p"          личный контекст     (subjectId = userId)
   ctx = "w:{wsId}"   организация         (план берётся у организации, место — у пользователя)
```

`catalogVersion` в ключе даёт бесплатную массовую инвалидацию при публикации новой версии каталога — не нужно обходить ключи. `subjectEpoch` бампается при: оплате, смене плана, выдаче/отзыве гранта, истечении, входе/выходе из организации, изменении состава семьи.

TTL снимка = `min(базовый TTL, expiresAt − now)`, где `expiresAt` — ближайший момент протухания чего-либо внутри снимка. Иначе снимок переживёт истечение подарка.

### 4.4 Массовая проверка

Тот же принцип, что у нас уже действует для прав (`grantSetFor` вместо `check()` в цикле): **резолвим снимок один раз за запрос** (кладём в ALS), дальше «заперт ли объект» — чистая функция над снимком в памяти. Для списка из 100 объектов не должно быть 100 обращений ни в Redis, ни в БД.

### 4.5 Слияние источников (grant stacking)

```
value(key) =
  1. default из реестра (= free-план)
  2. ⊕ значения PlanVersion подписки субъекта (с учётом статуса подписки)
  3. ⊕ значения активных AddOn
  4. ⊕ активные Grant (validFrom ≤ now < validUntil): подарки, триалы, семья, промо
  5. ⊕ жёсткий Override платформы (set / unlimited / deny) — перебивает всё
```

где `⊕` зависит от типа ключа: `OR` для boolean, `MAX` для лимита, `SUM` для квоты, «высший ранг» для enum.

Прямой ответ на вопрос задания («организация даёт 100 ГБ, семья +50, подарок +30 дней»): это **три разных типа**, и мерить их одной арифметикой нельзя. 100 ГБ и 50 ГБ — лимиты-максимумы одного ключа в разных контекстах: внутри контекста берётся `MAX`, а контексты вообще не смешиваются (личный диск и диск организации — разные субъекты, иначе течёт B2B-изоляция). «+30 дней премиума» — не значение, а **грант с `validUntil`**, поднимающий уровень на срок. «+100 минут STT» — единственный случай правомерной суммы, и там же нужен burn-down по приоритету.

### 4.6 Истечение: по времени при чтении, крон — только будильник

Правда должна быть **вычисляемой**: снимок считается на `now`, гранты с `validUntil <= now` в сумму не попадают. Крон не нужен для корректности. Но нужен для трёх вещей:

1. бампнуть эпоху ровно в момент истечения (иначе Redis-снимок живёт до TTL);
2. послать уведомление («премиум кончается через 3 дня», «квота на 80 %»);
3. материальные последствия (перевести подписку в `canceled`, запустить приведение к лимитам).

Значит: `core/jobs` ставит отложенный джоб на `validUntil` в той же транзакции, где создаётся грант — ровно как мы уже делаем `enqueue(tx, …)`.

### 4.7 Grace period и dunning

Модель статусов Stripe стоит копировать целиком: `trialing → active → past_due → unpaid → canceled`. Рекомендация Stripe — **не снимать доступ в `past_due`** (в этот момент идут Smart Retries), снимать в `unpaid`, когда попытки исчерпаны. У резолвера это отдельные режимы:

| Статус | Что отдаёт резолвер |
|---|---|
| `trialing` | как `active`, но источник помечен `trial` (видно в аналитике и в UI) |
| `active` | полный набор плана |
| `past_due` / `grace` | boolean-фичи живы, **расширение запрещено**: лимиты-максимумы не дают создавать новое, расходуемые квоты — только остаток без пополнения |
| `unpaid` / `suspended` | free-дефолт + режим read-only по превышенным лимитам |
| `canceled` | free-дефолт |

---

## 5. Лимиты и квоты

### 5.1 Четыре (пять) типа — и почему их нельзя путать

| Тип | Вопрос | Как считается | Где проверяется |
|---|---|---|---|
| **feature** (boolean) | «доступна ли возможность» | — | на входе в фичу |
| **limit** (максимум сущностей) | «до 5 витрин», «20 организаций» | `COUNT` живых объектов | только при СОЗДАНИИ |
| **quota** (расходуемое) | «15 ГБ», «300 мин STT/мес» | счётчик с дельтами | при создании и при удалении (возврат) |
| **rate** (в единицу времени) | «100 запросов/мин» | Redis-окно | на каждом запросе |
| **config/enum** | «какой уровень поддержки» | — | в логике |

Ключевая разница limit и quota: **limit проверяется только на росте** (превысивший после даунгрейда не наказывается задним числом — он просто не может создать новое), **quota расходуется и возвращается**.

### 5.2 Атомарность «проверить и увеличить» в Postgres

Не нужен ни advisory lock, ни `SELECT FOR UPDATE`. Одного стейтмента достаточно, потому что условие детерминировано, а `UPDATE` на READ COMMITTED перечитывает строку после снятия блокировки:

```sql
UPDATE quota_counter
   SET used = used + :delta, updated_at = now()
 WHERE subject_type = :st AND subject_id = :sid AND key = :key
   AND used + :delta <= :limit          -- :limit приходит ИЗ РЕЗОЛВЕРА, не из колонки
RETURNING used;
```

Ноль возвращённых строк = отказ (`entitlement.quota_exhausted`). Критично: **лимит передаётся параметром из резолвера**, а не хранится колонкой рядом со счётчиком — иначе получаем классический plan drift (счётчик помнит старый лимит после апгрейда).

Возврат ресурса — `used = GREATEST(used - :delta, 0)`.

**Ленивый сброс периода без крона** (месячная квота) — тем же стейтментом:

```sql
UPDATE quota_counter
   SET used = CASE WHEN period_end <= now() THEN :delta ELSE used + :delta END,
       period_start = CASE WHEN period_end <= now() THEN :newStart ELSE period_start END,
       period_end   = CASE WHEN period_end <= now() THEN :newEnd   ELSE period_end   END
 WHERE key = :key AND subject_id = :sid
   AND (CASE WHEN period_end <= now() THEN 0 ELSE used END) + :delta <= :limit
RETURNING used, period_end;
```

Счётчик и сам сайд-эффект — в **одной транзакции** (у нас Postgres, это бесплатно; именно так уже работают `wallet`, `chatter.log(tx)` и `jobs.enqueue(tx)`). Порядок железный: контекст → права → entitlement → резервирование квоты → эффект. **Проверка после эффекта — гонка**, при которой два конкурентных запроса оба проходят по устаревшему чтению.

Для лимита-максимума на небольших объёмах `COUNT` в скоупе тенанта в той же транзакции авторитетнее счётчика (3–10 мс) и не дрейфует; счётчик нужен там, где `COUNT` дорог (файлы, сообщения). Для строго уникальных вещей («не больше одной активной подписки») второй эшелон — частичный уникальный индекс.

Для `rate` — Redis `INCRBY` с TTL-окном (< 2 мс); хеш-тег `quota:{tenant_id}:dimension` держит все измерения одного тенанта в одном слоте кластера, чтобы откат был локальным.

### 5.3 Периоды: календарь или billing cycle

Практика расходится, и это продуктовое решение, а не техническое. GitHub Copilot сбрасывает квоту запросов **1-го числа календарного месяца**, независимо от даты подписки; кредиты Copilot и Claude привязаны к **billing cycle** и не переносятся. OpenMeter советует делать `usagePeriod` совпадающим с биллинговым циклом и даёт `anchor` для выравнивания. Компромисс, который используют почти все: **billing-cycle якорь для платных квот, календарный месяц для бесплатных** (у free-подписки нет цикла). В счётчике хранить `period_start/period_end` явно — тогда смена якоря не требует миграции данных.

### 5.4 Soft / hard / overage

- **Hard limit**: отказ на мутации, `402`, состояния не меняем. Применять к местам, платным ёмкостям, деньгам.
- **Soft limit**: действие пропускаем, идемпотентно пишем событие овереджа, возвращаем `200` с предупреждением в конверте. Применять к хранилищу и API-вызовам.
- **Overage с доплатой**: событие идёт в леджер (у нас — `wallet`), идемпотентность по ключу обязательна, иначе ретрай удваивает списание.
- **Fail-closed**: если счётчик недоступен, операцию, зависящую от квоты, отклоняем. Исключение — rate-лимит, где допустима деградация до консервативного кэшированного значения ради доступности. Fail-open недопустим: авария хранилища превращается в неограниченное бесплатное потребление.

### 5.5 Даунгрейд и режим read-only

Два подхода, оба живые:

- **Google Drive**: при превышении диск переходит в **read-only** — вход, просмотр, скачивание и шеринг работают, создание/редактирование/сохранение — нет, почта продолжает работать. Технически это флаг состояния подписки `overQuota` + проверка при каждой ЗАПИСИ (не при чтении).
- **Dropbox**: останавливает синхронизацию; на бесплатном тарифе может удалять давно не менявшиеся файлы. Для нас неприемлемо — молчаливое удаление данных.

Инженерная рекомендация: **никогда не выбирать молча, что удалить**. Правильный паттерн — при даунгрейде сравнить новые лимиты с фактическим потреблением заранее и показать человеку экран «что нужно освободить», применяя смену только после приведения в соответствие, либо переводя в read-only с явным объяснением.

---

## 6. Каталог планов: код или БД

### 6.1 Компромисс, к которому пришли все

| | Каталог в коде | Каталог в БД |
|---|---|---|
| Плюсы | компиляторная проверка ключей, ревью через PR, детерминированный деплой, версия = git | горячее изменение без релиза, кастомные корпоративные планы, аудит правок, A/B цен |
| Минусы | любая ценовая правка = релиз; продажи не могут выдать корп-условия | нет компилятора, нужен свой редактор и валидация, риск дрейфа |

**Гибрид — норма отрасли:** реестр **КЛЮЧЕЙ и их типов** живёт в коде (типизированный, компилятор + линтер), а **ЗНАЧЕНИЯ** (какой план что даёт) — в БД с версионированием. Именно так устроены Stigg и Schematic: фичи объявляются как контракт, а пакеты редактируются в интерфейсе.

### 6.2 Версии и grandfathering

Эталон — Kill Bill: новый каталог получает `effectiveDate`, существующие подписки **автоматически остаются на своей версии**, а `effectiveDateForExistingSubscriptions` даёт отложенное применение новых цен к старым подписчикам (период уведомления). Stigg описывает тот же механизм через номера версий: клон текущей версии в draft → правки → publish (новая помечается latest, старая архивируется), существующие клиенты остаются на своей. Schematic версионирует планы автоматически с тем же следствием.

Ключевой вывод: **подписка ссылается на `plan_version_id`, а не на `plan_id`**. Grandfathering тогда не требует ни одной строки кода и ни одного `if legacy`. Миграция старых — три стандартные стратегии: немедленно, в конце текущего цикла, вручную по выбору клиента (плюс вариант «grace period на переход по старой цене»).

Важный нюанс для метеринга: при grandfathering овередж старого подписчика должен считаться по **старой** цене — то есть usage-записи тоже должны знать версию.

### 6.3 Регионы и цены

Цена отделена от entitlement: в Kill Bill это price lists с ценами по валютам, в Stigg — отдельная ось. Правило: **entitlement не зависит от региона**; если фича недоступна в стране по закону — это не entitlement, а отдельная ось `availability` (feature availability), её нельзя купить. Для Казахстана это существенно: ЭЦП/ЭДО-функции регулируются, и их отсутствие не должно выглядеть как «купите Pro».

### 6.4 Ключи фич

Форма `service.feature` / `service.limitName`: `tasks.maxOpen`, `files.storageBytes`, `calls.recording`, `voice.sttMinutes`, `workspaces.maxOwned`. Реестр объявляет по каждому ключу: тип (`feature|limit|quota|rate|config`), единицу, правило слияния, период сброса, область (`user|workspace|both`) и **дефолт free-плана**. Компиляторная проверка — через union-тип, выведенный из const-объекта; линтер запрещает строковый литерал ключа вне реестра (у нас уже есть ровно такая практика для i18n-ключей).

---

## 7. Форма API, коды отказов, upsell, AI

### 7.1 Снимок целиком, а не точечные вопросы

При 100+ сервисах точечные проверки по сети не масштабируются, и UI всё равно нужно рисовать locked-состояния пачкой. Отсюда:

```
GET /api/v1/me/entitlements?context=personal | workspace:{id}

{
  "catalogVersion": 37,
  "resolvedAt": "...", "expiresAt": "...",      // ближайшее протухание
  "plan": { "key": "business", "version": 4, "status": "active", "periodEnd": "..." },
  "features": { "calls.recording": true, "docs.wopi": false },
  "limits":   { "tasks.maxOpen": { "value": 500, "used": 143 } },
  "quotas":   { "files.storageBytes": { "limit": 107374182400, "used": 41203392111,
                                        "resetAt": null, "soft": true } },
  "sources":  [ { "key":"files.storageBytes", "from":"plan" },
                { "key":"voice.sttMinutes", "from":"gift", "validUntil":"..." } ]
}
```

Плюс `POST /api/v1/entitlements/check` с батчем ключей — для AI-агента и для серверных модулей: агент должен уметь спросить «что мне сейчас можно» одним вызовом, а не пробовать действия наугад. Stripe, кстати, тоже советует держать entitlements у себя, а не ходить к нему на каждый чек.

### 7.2 Коды отказа

Индустрия сходится: **402** — «блокирует деньги, решаемо оплатой», **403** — постоянный отказ по правам, **429** — превышение частоты. Многие сервисы исторически отдают 403 на исчерпание кредитов, и это заставляет клиентов парсить текст ошибки — ровно то, чего мы избегаем единым конвертом.

```json
{ "error": { "message": "<переведено сервером>",
  "details": { "code": "entitlement.limit_reached",
    "key": "tasks.maxOpen", "value": 50, "used": 50, "contextType": "personal",
    "upsell": { "plan": "personal", "featureKey": "tasks.maxOpen", "newValue": 500 } } } }
```

Набор кодов: `entitlement.feature_locked`, `entitlement.limit_reached`, `entitlement.quota_exhausted`, `entitlement.plan_expired`, `entitlement.seat_required`, `entitlement.region_unavailable` (последний — без upsell). Для rate добавляем `Retry-After`.

### 7.3 Мобильный оффлайн

Эталон — RevenueCat: `CustomerInfo` кэшируется на устройстве и отдаётся синхронно; при недоступности серверов включаются Offline Entitlements — доступ выдаётся временно на основании локально верифицированных покупок; витрина тарифов (Offerings) имеет низкий TTL и требует отдельного кэширования приложением. Для нас: снимок с `expiresAt` и ETag, клиент рисует по нему UI, сервер **всегда** перепроверяет на мутации; метеринг, накопленный оффлайн, отправляется идемпотентно по возвращении связи (как у Stigg).

### 7.4 Наблюдаемость = продуктовая аналитика

Счётчик отказов `entitlement_denied_total{key, reason, plan, context}` — это не только SRE-метрика, это **основной сигнал для ценообразования**: в какой лимит люди упираются чаще всего. Schematic вообще объединяет метеринг и аналитику в один вызов `track`. Дополнительно мониторить: hit-rate кэша (> 95 %), дрейф счётчиков против источника (< 0.1 %, ночная сверка), число fail-open-отказов (должно быть 0), окно устаревания после даунгрейда (< 5 с).

---

## 8. Антипаттерны и уроки

1. **`if (plan === 'pro')` по коду.** Разбросанная по хендлерам логика тарифа: аудит невозможен, продукт/поддержка не знают, что кому доступно, любая ценовая правка — релиз. Лечение: резолвить один раз в объект данных, каталог правится как данные.
2. **Двойной источник истины биллинг ↔ продукт.** Расхождение ключей между метаданными Stripe, измерениями метеринга и ключами гейтинга названо «корнем большинства инцидентов вида „мы выставили счёт, но так и не ограничили"». Ключ должен быть один и тот же во всех трёх местах.
3. **Проверка после сайд-эффекта.** Классическая гонка на квотах: два конкурентных запроса читают старое значение и оба проходят. Резервировать атомарно ДО работы, откатывать вместе с транзакцией.
4. **Кэш без явной инвалидации по биллинговому событию.** Даёт оба худших исхода сразу: «я заплатил, а лимит не снялся» и «даунгрейднутый держит премиум весь TTL». TTL — страховка, не механизм.
5. **Entitlements в JWT.** Протухание, невозможность отзыва, распухание токена.
6. **Слияние permissions и entitlements в одном движке.** Разные жизненные циклы инвалидации, разные коды ответа, разные владельцы.
7. **Fail-open при недоступности счётчика.** Авария хранилища = бесплатное безлимитное потребление.
8. **Молчаливый выбор, что удалить при даунгрейде.** Гарантированный тикет в поддержку; правильно — показать человеку и ждать его решения.
9. **Флаги релиза вместо entitlements.** Флаг можно поменять ad hoc, а entitlement — контракт; у флагов нет метеринга, нет синхронизации с подпиской, и они не предназначены для продаж и поддержки. (LaunchDarkly сама предлагает такой сценарий, но признаёт ручную проводку и накопление мусора.)
10. **Хардкод лимитов в клиенте.** Обходится прямым вызовом API; клиент только рисует, решает сервер.
11. **Отсутствие версий плана.** Любая ценовая правка задевает действующих клиентов — юридический и репутационный риск.
12. **Нет счётчика отказов.** Продукт лишён данных о том, какой лимит реально продаёт.
13. **Stripe как источник истины по фичам.** Boolean-only, вебхук ≤ 10 записей, асинхронность, изменения набора фич продукта применяются только со следующего периода.

---

## 9. Рекомендуемая архитектура для SuperApp6

### 9.1 Место в платформе

Новый движок `core/entitlements` (19-й). По нашим правилам он **не импортирует фичи**; сервисы объявляют свои ключи в `EntitlementKeyRegistry` (обратное направление — через реестр, как у всех движков).

### 9.2 Реестр ключей (код, `packages/shared/src/entitlements/<service>.ts`)

```ts
defineEntitlement({
  key: 'files.storageBytes',
  kind: 'quota',                 // feature | limit | quota | rate | config
  unit: 'bytes',
  merge: 'sum',                  // or | max | sum | rank
  scope: 'both',                 // user | workspace | both
  resetPeriod: null,             // null | 'month' | 'day' ...
  defaultFree: 15 * 1024 ** 3,   // <- сегодняшняя константа FILE_QUOTAS
  softLimit: true,
  labelKey: 'entitlements.files.storageBytes',   // подпись — только ключ каталога i18n
});
```

Компилятор выводит union ключей; линт-страж запрещает читать `*_LIMITS` напрямую вне реестра (по образцу наших существующих стражей).

### 9.3 Таблицы (Prisma)

| Таблица | Назначение | Ключевые поля |
|---|---|---|
| `Plan` | план | `key`, `kind (personal\|family\|business)`, `status` |
| `PlanVersion` | **версия плана — неизменяемая** | `planId`, `version`, `status(draft\|published\|archived)`, `publishedAt`, `entitlements JSONB {key: value}` |
| `SubjectSubscription` | подписка субъекта | `subjectType(user\|workspace)`, `subjectId`, `planVersionId`, `status`, `currentPeriodStart/End`, `seats`, `cancelAt`, `source` |
| `EntitlementGrant` | **единый слой «сверху»** | `subjectType/Id`, `key`, `kind`, `value` или `amount`, `priority`, `source(gift\|promo\|trial\|family\|addon\|manual\|legacy)`, `effectiveFrom`, `validUntil`, `consumed`, `idempotencyKey UNIQUE` |
| `EntitlementOverride` | жёсткий оверрайд платформы | `set` / `unlimited` / `deny`, `validUntil`, `reason` |
| `QuotaCounter` | расходуемые | `subjectType/Id`, `key`, `periodStart`, `periodEnd`, `used`, `UNIQUE(subject, key)` |

`EntitlementGrant` — это то место, куда естественно ложатся **все** перечисленные в задании источники: подарки, триалы, семейный план, add-on'ы, ручные оверрайды продаж, миграционные «grandfathered» надбавки. Не нужно пяти механизмов — нужен один с полем `source`, приоритетом и сроком.

`QuotaCounter` — обобщение существующего `FileQuotaUsage` (дельта в транзакции + ночная сверка) на все ключи: механика уже доказана в бою, меняется только ключ.

### 9.4 Алгоритм резолва (чистая функция, без БД внутри)

```
resolve(subject, context, now) -> Snapshot
  1. base   = defaults из реестра (free-план)
  2. plan   = PlanVersion.entitlements активной подписки субъекта контекста
              (личный: подписка пользователя; организация: подписка организации)
  3. addons = активные AddOn-гранты
  4. grants = EntitlementGrant, где effectiveFrom <= now < validUntil
  5. merge по kind: or | max | sum | rank
  6. overrides: set / unlimited / deny — последними, перебивают всё
  7. модификатор статуса подписки (past_due -> запрет расширения, unpaid -> free)
  8. expiresAt = min(всех validUntil, periodEnd, ближайшего reset)
```

**Изоляция B2C/B2B (несущее правило):** личные гранты пользователя НЕ протекают в организацию, а entitlements организации применяются ко всем её членам, имеющим место (seat), и не влияют на личный контекст. Исключение — ключи, явно помеченные `scope: 'both'`. Иначе один пользователь с личным Pro «озолотит» все организации, где он состоит.

### 9.5 Кэш и инвалидация

- Redis-снимок по ключу `ent:v{catalogVersion}:{ctx}:{subjectId}:e{epoch}`, TTL = `min(300 с, expiresAt − now)`.
- ALS-кэш на время запроса: резолв один раз, дальше чистая функция (для списков из 100 объектов — обязательно).
- Бамп эпохи субъекта при: оплате, смене плана, гранте/отзыве, истечении (через джоб-будильник), входе/выходе из организации, изменении состава семьи. Механика эпох у нас уже есть в `core/access` — берём её, но **счётчик эпох отдельный**, чтобы биллинг не сбрасывал кэш прав.
- Push изменения снимка в `core/realtime` (`registerRelay`) — чтобы UI снял замок мгновенно после оплаты, а не по TTL. Целевое окно «оплата → доступ» < 30 с, «даунгрейд → запрет» < 5 с.

### 9.6 Точки интеграции

```ts
// контроллер
await access.can(actor, 'task.create', project);         // 403/404
entitlements.assert(snapshot, 'tasks.maxOpen', { used }); // 402 + upsell

// сервис, внутри prisma.$transaction
await entitlements.consume(tx, subject, 'files.storageBytes', +bytes, idempotencyKey);
await chatter.log(tx, ...);
await jobs.enqueue(tx, ...);
```

`consume(tx, …)` — один `UPDATE ... RETURNING` в **той же** транзакции мутации; ноль строк = `throw paymentRequired('entitlement.quota_exhausted')`. Никакого Redis для расходуемых квот: расходуемое приравнивается к деньгам и живёт в Postgres. Redis — только для `rate`.

Уведомления о приближении к лимиту (80 %) — через `core/notifications` из того же `consume`, идемпотентно (одно уведомление на период).

### 9.7 Миграция с захардкоженных констант

Ключевой приём, снимающий риск: **константы становятся `defaultFree` в реестре**.

1. Завести реестр, перенести значения всех ~38 наборов констант в `defaultFree`. Движок начинает отвечать ровно теми же числами — поведение не меняется, ничего не ломается.
2. Заменять прямые чтения констант на `limit('…')` / `can('…')` по одному сервису за подход (тот же ритм, что мы держим с i18n).
3. Наполнить `PlanVersion.entitlements` значениями платных планов. Free остаётся дефолтом реестра — его можно вообще не хранить в БД.
4. Перенос текущих данных: `Subscription.plan/status/expiresAt` → `SubjectSubscription`; `Subscription.giftedBy` → `EntitlementGrant(source='gift')`; `premiumUntil` скинов → `EntitlementGrant(key='skins.premium', source='legacy', validUntil=premiumUntil)` — grandfathering без единой строки `if legacy`.
5. `FileQuotaUsage` → `QuotaCounter` (данные переносятся 1:1, добавляется `key` и период).
6. Страж: линтер запрещает импорт старых констант вне реестра; проверить его подсадкой нарушения.

Соответствие ключей: `FILE_QUOTAS` → `files.storageBytes` (quota, soft); `WORKSPACE_LIMITS` 20 организаций → `workspaces.maxOwned` (limit), 1000 членов → `workspaces.maxMembers` (limit, субъект — организация); `TASK_LIMITS` → `tasks.*`; `NOTE_LIMITS` → `notes.*`.

### 9.8 Каталог: код или БД — для нас

Значения планов — в БД (`PlanVersion`), потому что казахстанский рынок потребует корпоративных условий и быстрых ценовых экспериментов. Ключи и типы — в коде. Публикация версии = insert новой `PlanVersion` + бамп `catalogVersion` (одна строка кэш-ключа инвалидирует всё). Правка опубликованной версии запрещена на уровне схемы — только новая версия.

---

## 10. Источники

- Stripe: [Entitlements](https://docs.stripe.com/billing/entitlements), [Active Entitlement object](https://docs.stripe.com/api/entitlements/active-entitlement/object), [Feature API](https://docs.stripe.com/api/entitlements/feature), [Meter events](https://docs.stripe.com/api/billing/meter-event), [How subscriptions work](https://docs.stripe.com/billing/subscriptions/overview)
- Stigg: [Core concepts](https://docs.stigg.io/documentation/getting-started/core-concepts), [Local caching and fallback strategy](https://docs.stigg.io/documentation/high-availability-and-scale/local-caching-and-fallback-strategy), [Plan versioning guide](https://www.stigg.io/blog-posts/an-engineers-step-by-step-guide-to-plan-versioning), [Feature gating](https://www.stigg.io/blog-posts/feature-gating), [Shortcomings of plan identifiers, authorization & feature flags](https://dev.to/getstigg/how-to-gate-end-user-access-to-features-shortcomings-of-plan-identifiers-authorization-feature-flags-38dh)
- Schematic: [Concepts](https://docs.schematichq.com/developer_resources/concepts), [What is Schematic](https://docs.schematichq.com/what-is-schematic), [Feature flag management for SaaS monetization](https://schematichq.com/blog/feature-flag-management)
- OpenMeter: [Entitlement](https://openmeter.io/docs/billing/entitlements/entitlement), [Grant](https://openmeter.io/docs/billing/entitlements/grant), [GitHub repo](https://github.com/openmeterio/openmeter), [ClickHouse case study](https://clickhouse.com/blog/openmeter-real-time-usage-based-billing-powered-by-clickhouse-cloud)
- Kill Bill: [Subscription & catalog user guide](https://docs.killbill.io/latest/userguide_subscription.html), [Catalog versioning and pricing overrides](https://blog.killbill.io/blog/subscription-product-catalog-versioning-price-changes-and-pricing-overrides/)
- Chargebee: [Entitlement overrides API](https://apidocs.chargebee.com/docs/api/entitlement_overrides), [Scheduling entitlement overrides](https://www.chargebee.com/docs/billing/2.0/entitlements/scheduling-entitlements-overrides)
- Lago: [GitHub](https://github.com/getlago/lago), [Clone Slack's fair per-seat pricing](https://getlago.com/blog/clone-slacks-fair-per-seat-pricing-in-a-simple-way)
- OpenFGA: [Modeling entitlements](https://openfga.dev/docs/modeling/advanced/entitlements)
- Unleash: [Segments](https://docs.getunleash.io/concepts/segments), [Activation strategies](https://docs.getunleash.io/concepts/activation-strategies), [Unleash context](https://docs.getunleash.io/concepts/unleash-context)
- LaunchDarkly: [How to manage entitlements with feature flags](https://launchdarkly.com/blog/how-to-manage-entitlements-with-feature-flags/)
- RevenueCat: [Offline entitlements](https://www.revenuecat.com/blog/engineering/introducing-offline-entitlements), [Caching](https://www.revenuecat.com/docs/test-and-launch/debugging/caching), [CustomerInfo](https://www.revenuecat.com/docs/customers/customer-info)
- Архитектурные разборы: [Subscription & plan enforcement (multi-tenant SaaS hub)](https://www.multi-tenant-saas.com/tenant-billing-usage-metering/subscription-and-plan-enforcement/), [Building an entitlement layer that enforces your pricing tiers](https://saasdash.ai/blog/entitlement-enforcement-architecture-pricing), [Your Stripe webhook is not your entitlement system](https://dev.to/joshmsn/your-stripe-webhook-is-not-your-entitlement-system-883), [Stripe entitlements break the moment you need real usage control](https://dev.to/andrewp629/stripe-entitlements-break-the-moment-you-need-real-usage-control-5e0f)
- Атомарность и гонки в Postgres: [Preventing race conditions with SELECT FOR UPDATE](https://on-systems.tech/blog/128-preventing-read-committed-sql-concurrency-errors/), [Handling race conditions in PostgreSQL](https://oneuptime.com/blog/post/2026-01-25-postgresql-race-conditions/view), [Advisory locks](https://dteather.com/blogs/postgres-advisory-locks/)
- Квоты и режим read-only: [Google Drive read-only при превышении](https://uit.stanford.edu/service/gsuite/drive/read-only), [Dropbox over quota](https://help.dropbox.com/storage-space/over-quota)
- JWT и протухание прав: [Stale JWT claims in authorization (Cerbos)](https://www.cerbos.dev/blog/how-to-look-up-identity-attributes-at-decision-time), [How to use JWTs for authorization (Permit.io)](https://www.permit.io/blog/how-to-use-jwts-for-authorization-best-practices-and-common-mistakes)
- Места и справедливый биллинг: [Slack Fair Billing Policy](https://slack.com/help/articles/218915077-Slacks-Fair-Billing-Policy), [Notion members and billing](https://www.notion.com/help/members-and-billing)
- Версионирование и grandfathering: [Zuora: SaaS pricing iteration & legacy plans](https://www.zuora.com/guides/saas-pricing-iteration-versioning/)
- Коды ответа: [HTTP 402 Payment Required (Abstract API)](https://www.abstractapi.com/guides/http-status-codes/402)
