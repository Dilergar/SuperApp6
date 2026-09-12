# Salesforce как эталон B2B-энтайтлментов: лицензии, права, лимиты

Исследование для проектирования Entitlements Resolver в SuperApp6. Факты сверены по официальной документации Salesforce (Help, Developer Limits and Allocations Quick Reference, Summer '26) и отраслевым источникам 2024–2026.

---

## 1. Модель: сущности и слои

Salesforce гейтит доступ **шестью независимыми плоскостями**. Это ключевая особенность: они не иерархия, а набор условий, каждое из которых должно быть выполнено.

| Слой | Что решает | Где живёт | Продаётся? |
|---|---|---|---|
| **Edition** (издание org) | существует ли фича в этом тенанте вообще + потолки лимитов | свойство org | да, это «тариф организации» |
| **User License** | максимум функциональности для человека; ровно одна на пользователя, обязательна | `UserLicense`, поле на `User` | да, это «место» |
| **Permission Set License (PSL)** | право *получить* дополнительную фичу сверх user-лицензии | `PermissionSetLicense` + `PermissionSetLicenseAssign` | да, аддон |
| **Feature License** | булев переключатель-аддон на пользователе | поля `User.UserPermissionsMarketingUser`, `...KnowledgeUser`, `...SupportUser`, `...OfflineUser` | да, ограничено числом мест |
| **Profile / Permission Set / Permission Set Group** | какое подмножество разрешённого реально выдано человеку | метаданные, назначения | нет — это администрирование |
| **Usage-Based Entitlement** (`TenantUsageEntitlement`) | метрируемые ресурсы с периодом (API-вызовы в месяц, хранилище, Einstein-запросы) | строки таблицы в org | да, покупается объёмом |

Формулировки документации, на которые стоит опереться дословно:

- «User licenses define maximum functionality available to users» — user-лицензия задаёт **потолок**, а не выдачу.
- «Permission set licenses entitle users to access additional features not included in their assigned user license… For users to access additional license functionality, they must both be assigned the permission set license **and** a permission set containing the feature permissions.» Это «правило двух ключей»: **оплачено** (PSL) и **выдано** (permission set) — разные вещи.
- «You can use permission set licenses to grant access, **but not to deny access**» (`PermissionSetLicense`, Object Reference). Вся модель Salesforce — аддитивная.
- «If you assign users permissions via a permission set and they don't have the required licenses, you receive an assignment error» — проверка происходит **в момент назначения**, а не только в рантайме.

Примеры user-лицензий: *Salesforce* (полный CRM), *Salesforce Platform Starter* (10 кастомных объектов) / *Platform Plus* (110), *Platform Login* (оплата за уникальный вход — 50 кредитов на вход), *Identity Only*, *Chatter Free*, а также лицензии Experience Cloud (Customer Community, Customer Community Plus, Partner Community) в двух режимах: **member-based** (именованное место, входов сколько угодно) и **login-based** (пул входов на месяц, **без переноса остатка**, списывается по факту входа). Login-based — редкий в индустрии и очень поучительный пример «квота вместо места» для редко заходящих пользователей.

Отдельная плоскость — **приложение поверх приложения** (B2B2B): ISV-пакет из AppExchange лицензируется через **LMA (License Management App)** в org партнёра. Запись лицензии у подписчика: `sfLma__Seats__c` (число мест; `-1` = site license, доступ всем в org), `Status` (Active / Free / Trial), `ExpirationDate` («Does not expire» по умолчанию), `Licensed Users`, дата установки. Партнёр меняет число мест и дату окончания удалённо (Modify License).

Плюс два инструмента гейтинга уровня кода: **Custom Permissions** (бесплатные булевы флаги, назначаются permission set'ами) и **Feature Parameters** для ISV — про них ниже.

---

## 2. Механика резолва в рантайме

Порядок проверки (условно — «И» между лицензионными плоскостями, «ИЛИ» внутри плоскости прав):

1. **Edition / org preference** — включена ли фича в тенанте. Нет — её UI и метаданных просто не существует.
2. **User License** — допускает ли лицензия человека такую способность (потолок).
3. **PSL / Feature License** — оплачено ли расширение и назначено ли оно **этому** пользователю (места PSL конечны: `TotalLicenses` / `UsedLicenses`).
4. **Permission Set ∪ Permission Set Group ∪ Profile** — объединение (union). «Permission sets are purely additive — they can grant access, but they can never remove or revoke something a user already has.» Единственное вычитание — **Muting Permission Set**, и только внутри своей группы.
5. **Record-level**: sharing (OWD + правила + ручной шеринг) работает по принципу «самое разрешительное побеждает»; пересечение появилось отдельно и поздно — **Restriction Rules** (2021) и Scoping Rules.

Победитель: **любая лицензионная плоскость может запретить (AND), ни одна permission-плоскость не может отобрать (OR)**. Отказ из-за лицензии и отказ из-за прав дают разные ошибки (assignment error против «Insufficient privileges»), но в обоих случаях пользователю не сообщается, *какой именно* лицензии не хватает — главная UX-претензия админов.

Что доступно коду:

- `System.FeatureManagement.checkPermission('namespace__AccessSpecialFeature')` → `Boolean` — проверка кастомного пермишена у текущего пользователя; рекомендация документации — «gate server-side logic… return empty, null, or throw an exception when the permission is missing», т.е. гейт на слое данных, а не только в UI.
- Поля `User.UserPermissionsX` — фиче-лицензии видны в SOQL как булевы колонки.
- `Schema.describeSObjects` / `isAccessible()` — CRUD/FLS.
- SOQL по `PermissionSetLicense` (`MasterLabel, DeveloperName, ExpirationDate, Status, TotalLicenses, UsedLicenses`) и `PermissionSetLicenseAssign` — самообслуживаемая отчётность «кому что выдано».

Для ISV (модель B2B2B, ближе всего к нашему резолверу):

- **LMO-to-Subscriber feature parameters** — значения тарифа, которые вендор выставляет каждому клиенту на записи лицензии; код пакета читает их `FeatureManagement.checkPackageBooleanValue()` / `checkPackageIntegerValue()`.
- **Subscriber-to-LMO** — счётчики потребления, которые код пакета инкрементит `setPackageIntegerValue()` в org клиента, и они утекают вендору.
- Ограничения, важные как урок: **только int, boolean, date** (никакого текста и JSON), максимум **200 параметров** на пакет, синхронизация **до 24 часов**, и нельзя менять параметры в одной транзакции с DML (нужен `@future`, иначе `MIXED_DML_OPERATION`).

---

## 3. Квоты и лимиты: три разных класса

Salesforce строго разделяет три вещи, которые в наивных системах сваливают в одну кучу.

### 3.1 Governor limits — защита мультитенантности, НЕ монетизация

Пер-транзакционные и неотключаемые, одинаковые для всех изданий: 100 SOQL синхронно / 200 асинхронно, 50 000 строк на транзакцию суммарно, 150 DML-операций, 6 МБ heap (12 МБ async), 10 000 мс CPU (60 000 async), 100 коллаутов, таймаут 10 минут. Их **никогда не продают как аддон** — это архитектурная константа платформы.

### 3.2 Daily allocations — пул организации, собранный из надбавок за места

Точная формула из официального Quick Reference:

> **Enterprise Edition / Professional Edition с API:** `100 000 + (число лицензий × вызовов на тип лицензии) + купленные API Call Add-Ons`

Веса по типам лицензий (EE): Salesforce — **1 000**, Salesforce Platform — **1 000**, Lightning Platform One App — **200**, Customer Community — **0**, Customer Community Login — **0**, Customer Community Plus — **200**, Customer Community Plus Login — **10**, Partner Community — **200**, Partner Community Login — **10**, Platform Starter — 200 на участника, Platform Plus — 1 000 на участника, External Identity 25 000 → **70 000** (и далее 750 000 / 4 000 000).

Для **Unlimited / Performance** те же 100 000 базы, но Salesforce и Salesforce Platform весят **5 000**. Developer Edition — плоские **15 000**. Full Sandbox — **5 000 000**.

Ключевые правила учёта, прямо из документа:

- «Limits and allocations are enforced against the aggregate of all API calls made to the org in a 24-hour period. **Limits and allocations are not on a per-user basis.**» Пул общий, скользящее окно 24 часа.
- Есть **резервная полоса**: вызовы с `DebuggingHeader` имеют отдельную аллокацию 1 000/24 ч и «can continue to be made after the total request limit for an org is reached».
- Вызовы от некоторых connected apps (например, мобильного приложения Salesforce) **не считаются**.
- Честная оговорка вендора: «Load, performance, and other system issues can prevent you from using your entire allocation».
- Параллелизм: одновременных входящих запросов **длительностью ≥ 20 секунд** — 25 в production и sandbox, 5 в Developer/Trial; превышение → код исключения `REQUEST_LIMIT_EXCEEDED`, новые запросы не обрабатываются, пока не освободится слот. На запросы короче 20 секунд лимита нет.

### 3.3 Storage — квота как товар

- **Data storage:** 10 ГБ на org (Contact Manager, Group, Professional, Enterprise, Performance, Unlimited) + **20 МБ на пользователя** (PE/EE) или **120 МБ** (Performance/Unlimited). Developer Edition — 5 МБ. Запись считается фиксированными **~2 КБ независимо от числа полей**.
- **File storage:** 10 ГБ на org + **2 ГБ на пользователя** (EE/PE/UE) или 612 МБ (Professional/Contact Manager/Group; 1 ГБ/польз. если в org меньше 10 человек).
- Пересчёт **асинхронный**: «Storage calculations… aren't reflected immediately».

Самое интересное — **асимметрия принуждения**. В sandbox превышение любого из двух пулов жёстко блокирует создание записей и загрузку файлов (`STORAGE_LIMIT_EXCEEDED`). В production лимит данных **намеренно не принуждается жёстко**, «чтобы бизнес-критичные данные продолжали создаваться, несмотря на превышение контрактных лимитов»; файлы блокируются после grace-периода. То есть вендор осознанно выбрал «не ломать бизнес клиента ради выставления счёта».

### 3.4 Метрируемые энтайтлменты как строки данных

`TenantUsageEntitlement` (API 28.0+) — таблица, которую видно в Setup → Company Information. Поля: **Resource** («what your company can use»), **Resource ID**, **Start Date** (самая ранняя из контрактов), **End Date** (самая поздняя), **Frequency** (сбрасывается ежемесячно / однократно до End Date), **Allowance**, **Amount Used** (только production, не sandbox и не trial), **Usage Date**, **Last Updated** (момент снимка). Поля нередактируемые и видны, только если org имеет право на ресурс. Пример живого ресурса — «API Request Limit per Month», агрегат за 30 дней.

Это **готовая форма таблицы энтайтлментов**, которую стоит скопировать почти буквально.

---

## 4. Жизненный цикл: триал → оплата → даунгрейд → истечение

- **Trial org** — 30 дней, продление только по запросу. **Developer Edition** бесплатен бессрочно, но org без логина **180 дней** (раньше было 365) помечается неактивной и ставится в очередь на удаление; приходит письмо с датой, логин обнуляет счётчик.
- **Расширение:** лицензии можно добавить в любой момент (в т.ч. самообслуживанием через Your Account). **Сокращение — только на renewal:** число мест зафиксировано на срок контракта. Асимметрия чисто коммерческая.
- **Освобождение места:** пользователя в Salesforce нельзя удалить, только деактивировать/заморозить (владение записями, Chatter, аудит). Деактивация возвращает лицензию в пул для переназначения, но не меняет счёт.
- **Истечение PSL:** у `PermissionSetLicense` свои `Status` и `ExpirationDate` — аддон может «протухнуть» независимо от базовой лицензии.
- **Неплатёж / окончание подписки — лестница:** первые **30 дней** org деактивирована, но реактивируется самообслуживанием; **31–60 дней** — статус **LOCKED**, только через поддержку; у платных org есть **120-дневный grace в статусе LOCKED**, в течение которого поддержка может сделать выгрузку данных; после — **DELETED**, данные невозвратны.
- **Read-only mode** — это НЕ про деньги: сервисный режим при переезде инстанса, когда «all requests for users in the org (as well as all API requests, integrations, batch jobs) behave in a read-only way». Важная ловушка: штатный Data Export **не работает** в read-only, поэтому выгружаться надо до блокировки.
- **Даунгрейд фичи данные не удаляет:** объекты и записи остаются, исчезает доступ («insufficient privileges»). Так же ведёт себя истечение ISV-лицензии: компоненты пакета становятся недоступны, данные подписчика лежат на месте.

---

## 5. Форма API и UI, которую удобно копировать

**REST `/services/data/vXX.0/limits`** — один вызов возвращает *все* лимиты org в **единообразной форме**:

```json
{ "DailyApiRequests": { "Max": 106200, "Remaining": 105482 },
  "DataStorageMB":    { "Max": 10240,  "Remaining": 9800 },
  "FileStorageMB":    { "Max": 10240,  "Remaining": 9000 },
  "DailyAsyncApexExecutions": { "Max": 250000, "Remaining": 249998 } }
```

Сильные стороны формы: (1) одна пара `Max`/`Remaining` для всего — от хранилища до асинхронных запусков; (2) агрегат в одном запросе, без N ручек; (3) имена ресурсов стабильны и годятся как ключи.

Дополнительно:
- **Заголовок `Sforce-Limit-Info: api-usage=453/100000`** на каждом REST-ответе — счётчик едет вместе с обычным ответом, клиенту не нужен отдельный поход.
- **Apex:** парные методы `Limits.getQueries()` / `Limits.getLimitQueries()` (потрачено/потолок) и `OrgLimits.getAll()` → `OrgLimit.getName() / getValue() / getLimit()`.
- **UI:** Company Information показывает по каждому типу лицензии «сколько всего и сколько занято» плюс таблицу usage-based entitlements; System Overview — API-расход за 24 часа; настраивается письмо ответственному при превышении заданного процента аллокации.

---

## 6. Уроки и антипаттерны

1. **Пять лицензионных плоскостей — главный источник путаницы админов.** Классический вопрос сообщества: «почему я не могу назначить этот permission set?» — ответ «не куплен PSL», но система не называет недостающую лицензию. Урок: **отказ обязан называть причину и способ разблокировки**.
2. **Чисто аддитивная модель загоняет в угол.** Раз нет «запретить», понадобились подпорки: Muting Permission Sets (работают только внутри группы) и Restriction Rules (2021) для записей. Урок: семантику пересечения/запрета закладывать сразу, иначе пришивать больно.
3. **Profiles EOL — самый свежий и самый дорогой урок.** В январе 2023 Salesforce объявил отмену пермишенов в профилях к **Spring '26**, дав экосистеме три года. **6 июня 2026 отмену официально отменили** — из-за фичевых пробелов и сопротивления клиентов; профили продолжают нести пермишены бессрочно. Вывод: **две параллельные модели прав нельзя «выключить потом»** даже с трёхлетним запасом и ресурсами Salesforce.
4. **Коллизия терминов у самого вендора.** В Salesforce «Entitlements» — это **SLA поддержки** (Entitlement, Entitlement Process, Milestones вроде Initial Response Time, Service Contract, Entitlement Template). Лицензирование живёт под словами Licenses, Usage-Based Entitlements, Feature Parameters. Одно слово на две несвязанные подсистемы — вечный источник недопонимания в документации и найме.
5. **Хранилище как основной рычаг монетизации даёт извращённый стимул.** 20 МБ данных на пользователя при цене места породили целую индустрию «выносителей файлов» из Salesforce. Продавать ёмкость в продукте, ценность которого — накопленные данные, значит платить оттоком данных наружу.
6. **Пул из надбавок за места элегантен, но непрозрачен.** Клиент не может посчитать свой лимит в уме (веса разные для 12 типов лицензий) — отсюда обязательность `/limits` и заголовка-счётчика.
7. **Сокращение мест только на renewal** приносит выручку, но создало рынок консультантов по «оптимизации лицензий» и устойчивое раздражение — репутационный минус.
8. **ISV-плоскость намеренно примитивна** (int/bool/date, 200 параметров, синхронизация до 24 часов). Урок от обратного: значения энтайтлментов должны быть простыми скалярами; но 24-часовая задержка допустима только там, где нет денег и безопасности.

---

## 7. Сравнение с Odoo (второй B2B-эталон)

- **Два издания.** Community — LGPL, бесплатна, самохостинг, без пофайлового лицензирования. Enterprise — проприетарный слой поверх того же ядра (Studio, полноценный учёт, мобильные приложения, поддержка и апгрейды между мажорами). Гейтинг тут **бинарный на уровне сборки**, а не на уровне пользователя.
- **Цена — за пользователя в месяц, приложения включены.** Standard ≈ $24,9/польз./мес по промо с продлением около $31; Custom (Enterprise-возможности: студия, мультикомпания, внешний API) ≈ $49 промо / ~$61 далее. Цена **сильно региональная**: от ~$8,95 (Ближний Восток) до ~$76 (США) за то же место — прямой прецедент регионального прайсинга, релевантный для Казахстана. Промо-ставка действует первые 12 месяцев и только на изначально заказанные места.
- **Принуждение — мягкое и «совестливое».** On-premise база периодически связывается с `services.odoo.com` и сверяет число внутренних пользователей с подпиской. При превышении показывается **неблокирующее** сообщение с ежедневным обратным отсчётом; есть **30 дней**, чтобы либо докупить места, либо деактивировать лишних. Не отреагировал — база переходит в **блокирующее** состояние «Database expired». Когда счёт пользователей сходится, предупреждение само исчезает «через несколько дней, при следующей проверке».
- Портальные (внешние) пользователи бесплатны и не считаются — прямой аналог наших «гостей по share-link».

Контраст с Salesforce: Odoo принуждает **числом мест и одним таймером**, без матрицы лицензий; Salesforce — матрицей плоскостей и десятками счётчиков. Odoo-модель радикально проще в реализации и объяснении, но не умеет продавать отдельные фичи разным людям в одной организации.

---

## 8. Рекомендации для SuperApp6

### Копировать

1. **Две ортогональные плоскости: право ≠ оплата.** `core/access` (ReBAC) отвечает на «кому можно», Entitlements Resolver — на «оплачено ли и сколько осталось». Резолв доступа = `access.check() AND entitlements.check()`. Категорически не заводить тарифные факты в ReBAC-кортежи: Salesforce разделил это правильно, и это единственная часть его модели, к которой нет претензий.
2. **Правило двух ключей** для платных возможностей в организации: место оплачено (`seat`) **и** способность выдана человеку. Проверять **и в момент назначения** (дружелюбная ошибка админу: «мест business осталось 0»), **и в рантайме** (план мог истечь между назначением и вызовом).
3. **Пул из базы и надбавок за места**: `quota(org) = base(plan) + Σ(seats × weight(seatType)) + addons`. Формула Salesforce проверена на масштабе и честна к росту клиента. Наши кандидаты на такую формулу: ёмкость Диска, исходящие SMS/уведомления, минуты STT диктофона, AI-вызовы, объём ЭДО.
4. **Форма таблицы `TenantUsageEntitlement`** переносится в схему почти буквально: `resource` (ключ реестра), `scope` (personal | workspace:X), `startAt`, `endAt`, `frequency` (`monthly | once | daily`), `allowance`, `amountUsed`, `lastUsageAt`, `lastAggregatedAt`, `source` (subscription | seat | gift | trial | override), `grantedBy`. Учёт потребления — отдельный счётчик, агрегируемый джобом `core/jobs`, а не пересчёт на лету.
5. **Единая форма ответа `/api/v1/entitlements`**: и булевы фичи, и числовые лимиты в одинаковой оболочке — `{ key, allowed, limit, used, remaining, resetsAt, source, reason, unlock }`. Плюс заголовок-счётчик (аналог `Sforce-Limit-Info`) на тяжёлых ручках (загрузка файлов, отправка SMS, AI) — клиенту не нужен второй поход. Один RQ-ключ = одна форма кэша (наше правило `lib/queries.ts` тут совпадает с удобством).
6. **Резервная полоса при исчерпании квоты.** У Salesforce после исчерпания дневного лимита продолжают работать 1 000 вызовов с `DebuggingHeader`. У нас после исчерпания квоты обязаны продолжать работать: чтение всего, операции кошелька и эскроу, подпись уже начатых документов, охрана труда/HR-события, уведомления о безопасности. Квота гасит **рост**, а не **жизнь**.
7. **Асимметричное принуждение** в духе «production vs sandbox»: жёсткий отказ на расширяющих действиях (новая организация, новый член, новая загрузка), мягкий (баннер + письмо + grace) на бизнес-критичной записи. Ни одна квота не должна ронять закрытие сделки в эскроу или подписание документа.
8. **Отказ обязан нести причину и путь разблокировки** — это ровно та ошибка, за которую ругают Salesforce. Возвращать `details.code` из нашего единого конверта: `quota_exhausted | plan_required | seat_required | trial_expired | region_unavailable`, плюс `unlock: { plan, action, scope }`. Текст — **только ключ каталога i18n**, никаких литералов (правило проекта).
9. **Лестница истечения без потери данных** (наш аналог 30/60/120 Salesforce, для KZ можно 14/30/90): активна → просрочена, но пишет → только чтение платной поверхности с сохранённым экспортом → архив. Данные не удаляются никогда по причине неоплаты; удаление — отдельный, явный, подтверждаемый путь (у нас уже есть `purgeWorkspace` на 90 дней архива — сшить с этой лестницей).
10. **Региональная цена как первоклассный вход резолвера** (пример Odoo: $8,95 против $76 за одно и то же место). Регион — измерение плана, а не «скидка в биллинге».

### Не копировать

1. **Пять лицензионных плоскостей.** Нам хватит трёх: `plan` (личный или организации) × `seat`/`addon` × `override` платформы. Один реестр ключей фич — один резолвер. Модель Salesforce — исторический нарост, а не проект.
2. **Второй механизм прав рядом с существующим.** У нас есть ReBAC-способности; заводить «профили с пермишенами» поверх них нельзя. История с отменой Profiles EOL (три года подготовки и всё равно откат в июне 2026) — прямое доказательство, что параллельную модель прав потом не выключить.
3. **Хранилище как основной рычаг монетизации.** Файлы — то, что держит человека в суперприложении. Щедрый пол по объёму, продавать места, сервисы и косметику; ёмкость — только в старших B2B-тарифах.
4. **«Сократить места только на продлении».** Для казахстанского SMB это токсично. Правильная середина: место возвращается в пул немедленно при исключении сотрудника, деньги пересчитываются на границе периода.
5. **Слово «entitlement» в двух значениях.** Наш язык-источник — английский, поэтому фиксируем сейчас: `entitlement`, `featureKey`, `quota`, `allowance`, `seat`, `grant`, `override` — только про лицензирование. Будущие SLA поддержки называть `serviceLevel`/`sla`, никогда не `entitlement`.
6. **Синхронизацию значений «до 24 часов»** (ISV feature parameters). Мы — модульный монолит: резолв синхронный, кэш — эпоха в Redis по образцу `core/access` (смена плана/мест бампает эпоху). Денежное и охранное гейтится только синхронно, в той же транзакции.
7. **Лимиты, зашитые в код.** Сегодняшние ~38 наборов констант (`TASK_LIMITS`, `FILE_QUOTAS`, `WORKSPACE_LIMITS`) — ровно тот антипаттерн, от которого Salesforce ушёл, вынеся ресурсы в строки `TenantUsageEntitlement`. Константы оставить только как fallback-дефолты реестра, истина — в данных (реестр фич в коде + гранты в БД).

### Специфика SuperApp6, которой у Salesforce нет

- **Один человек — N контекстов.** У Salesforce «пользователь = одна лицензия в одном org», у нас человек одновременно в личном контуре и в нескольких организациях. Значит вход резолвера — **всегда пара `(userId, scope)`**, где `scope = personal | workspace:X`, а ответ скоуп-специфичен. Наследования между скоупами нет: место в организации не делает личный план платным и наоборот.
- **Косметика (скины карточек) видна всем и путешествует с человеком** — это энтайтлмент личного скоупа, и он не должен резолвиться из мест организации. Поле `premiumUntil` превратить в грант `source='purchase', scope='personal'` в общей таблице, иначе появится вторая плоскость (та самая ошибка Salesforce).
- **Семейный план — это мини-организация мест**, а не особый случай: те же `seats`, та же формула пула, детские профили — участники с ограниченным набором способностей. Подарки — грант с `grantedBy` и `expiresAt`.
- **Триал обязан читаться.** Сегодня `Subscription` пишется при регистрации и никем не читается — то есть система уже сейчас находится в состоянии «fail-open». Первым же шагом резолвер должен стать **единственным** читателем плана, а истечение триала — вести в явно спроектированное деградированное состояние, а не в «expired, и дальше как повезёт».

---

## 9. Источники

- [Permission Set Licenses — Salesforce Help](https://help.salesforce.com/s/articleView?id=sf.users_permissionset_licenses_overview.htm&language=en_US&type=5)
- [Salesforce Developer Limits and Allocations Quick Reference (PDF, Summer '26) — API Request Limits and Allocations](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf)
- [API Request Limits and Allocations (HTML)](https://developer.salesforce.com/docs/platform/salesforce-app-limits-cheatsheet/guide/salesforce-app-limits-platform-api.html)
- [Data and File Storage Allocations — Salesforce Help](https://help.salesforce.com/s/articleView?id=sf.overview_storage.htm&language=en_US&type=5)
- [Usage-Based Entitlement Fields — Salesforce Help](https://help.salesforce.com/s/articleView?id=platform.users_usagebased_entitlements_fields.htm&language=en_US&type=5)
- [TenantUsageEntitlement — Object Reference](https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_tenantusageentitlement.htm)
- [PermissionSetLicense — Object Reference](https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_permissionsetlicense.htm)
- [FeatureManagement Class — Apex Reference](https://developer.salesforce.com/docs/atlas.en-us.apexref.meta/apexref/apex_class_System_FeatureManagement.htm)
- [Feature Parameters in Salesforce AppExchange Applications — Beyond The Cloud](https://blog.beyondthecloud.dev/blog/appexchange-feature-parameters)
- [Track Preferences and Activation Metrics with Subscriber-to-LMO Feature Parameters](https://developer.salesforce.com/docs/atlas.en-us.pkg2_dev.meta/pkg2_dev/fma_subscriber_to_lmo.htm)
- [Manage Licenses for Managed Packages (LMA)](https://developer.salesforce.com/docs/atlas.en-us.workbook_lma.meta/workbook_lma/lma_edit_license.htm)
- [API Limits and Monitoring Your API Usage — Salesforce Developers Blog (ноябрь 2024)](https://developer.salesforce.com/blogs/2024/11/api-limits-and-monitoring-your-api-usage)
- [Your Guide to Salesforce License Types — Salesforce Ben](https://www.salesforceben.com/salesforce-licenses/)
- [Salesforce Backtracks on Permission Retirement in Profiles — Salesforce Ben (июнь 2026)](https://www.salesforceben.com/salesforce-backtracks-on-permission-retirement-in-profiles/)
- [Salesforce Cancels the Permissions in Profiles Retirement — Apex Hours](https://www.apexhours.com/salesforce-cancels-the-permissions-in-profiles-retirement/)
- [Complete Guide to Salesforce Entitlements and Milestones in Service Cloud — Salesforce Ben](https://www.salesforceben.com/complete-guide-to-salesforce-entitlements-and-milestones-in-service-cloud/)
- [Developer Org Expiration — Salesforce Help](https://help.salesforce.com/s/articleView?language=en_US&id=sf.admin_de_org_expiration.htm&type=5)
- [Read-Only Mode — Salesforce Help](https://help.salesforce.com/s/articleView?id=sf.setup_maintenance_mode_overview.htm&language=en_US&type=5)
- [What happens to Data after the Salesforce Org is Deactivated, Expired or Locked](https://www.salesforcebolt.com/2021/01/what-happens-to-data-after-salesforce.html)
- [Considerations for Deactivating Users — Salesforce Help](https://help.salesforce.com/s/articleView?language=en_US&id=platform.users_deactivate_considerations.htm&type=5)
- [Ultimate Guide to Salesforce Experience Cloud Licensing — SalesforceCodex](https://salesforcecodex.com/salesforce/ultimate-guide-to-salesforce-experience-cloud-licensing/)
- [Odoo — On-premise database management (Too many users / Database expired)](https://www.odoo.com/documentation/18.0/administration/on_premise.html)
- [Odoo Pricing 2026 — ERP Research](https://www.erpresearch.com/pricing/odoo)
- [Odoo Pricing 2026: Real Cost Per User (179 Countries)](https://oec.sh/odoo-pricing)
- [Salesforce Governor Limits — Apex Hours](https://www.apexhours.com/governor-limits-in-salesforce/)
- [Salesforce Storage Limits: Data vs File — TechParrot](https://techparrot.io/blog/salesforce-storage-limits)
