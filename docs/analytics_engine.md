# core/analytics — продуктовая аналитика (21-й движок)

> Как пользуются приложением: воронки, активность, удержание, сервисы, тарифы. Реестр событий — код в shared, приём без единого обращения к БД на пути запроса, сырьё в партициях PostgreSQL, роллапы джобами, отчёты в Кабинете платформы. Приём и консьюмер — [analytics_ingest.md](analytics_ingest.md); метрики, язык запросов и UI — [analytics_reports.md](analytics_reports.md).

Код: `apps/api/src/core/analytics/` (`analytics.service.ts` — `track`/склейка/согласие/забвение, `analytics.controller.ts` — приём, `analytics.ingest.service.ts` — консьюмер, `analytics.query.service.ts` — отчёты, `analytics.platform.provider.ts` — кабинет, `analytics.module.ts` со смоуком реестра). Реестр — `packages/shared/src/analytics/`, Zod — `packages/shared/src/validation/analytics.ts`, DTO — `packages/shared/src/types/analytics.ts`. SDK — `packages/analytics/`. Миграции — `apps/api/prisma/migrations/20260913090000_core_analytics/`, `apps/api/prisma/migrations/20260913120000_analytics_rollup_internal/`.

## Почему свой движок

Закон РК № 94-V ст. 12 требует хранить персональные данные граждан РК на территории РК, а псевдонимный `user_id` — тоже персональные данные; PostHog self-host — это Kafka + ClickHouse + plugin-server, для малой команды без поддержки. Поэтому всё живёт в том же PostgreSQL и Redis, исходящего HTTP у движка нет. **ClickHouse — сайдкар-тир позже, по триггерам**: > 3000 событий/с на приёме, p95 дашборда > 1,5 с, > 15 % CPU БД на аналитике. Путь: двойная запись 2 недели → переключение отчётов через отдельную реализацию исполнителя `AnalyticsQueryService`. TimescaleDB отклонён (лицензия TSL).

## Модель данных

- **Сырьё — схема `analytics`** (сырой SQL миграции; Prisma сравнивает только `public` и партиций не видит): `analytics.events` `PARTITION BY RANGE (ts)` по месяцу, партиция `analytics.events_YYYY_MM`. `ts` = `occurred_at`, клампнутое в `[received_at − 7 д, received_at + 1 ч]` (`time_corrected`). Колонки личности (`user_id`, `anonymous_id`, `workspace_id`, `owner_type` 0 личное · 1 организация · 2 аноним), сессия/устройство/`login_sid`, **снимок тарифа** (`plan_key`, `plan_version`), `role`, платформа и грубые признаки устройства (`device_class`, `os`, `browser` — сам UA не хранится), `locale`, `tz`, `country` (NULL — легальной GeoIP-базы нет, IP не хранится), шаблон `route`, `ref_type/ref_id`, `props jsonb`, `sample_rate`, `is_internal`, версии схемы и конвейера. Индексы родителя: `UNIQUE (event_id, ts)`, BRIN `ts`, `(event_key, ts)`, частичные `(user_id, ts)`, `(workspace_id, ts)`, `anonymous_id`.
- `analytics.outbox (id, payload jsonb, created_at)` — серверные события, записанные в транзакции доменной мутации.
- `public`: `AnalyticsIdentityLink` (аноним → аккаунт, первая привязка побеждает, `contested`), `AnalyticsEventOverride` (рубильник `live|blocked`), `AnalyticsQuarantine` (`unique (event_key, reason)`, только имена и типы полей, TTL 30 дней), роллапы `AnalyticsRollupEventDay` / `AnalyticsRollupActorDay` / `AnalyticsRollupSessionDay` (день — в `APP_TIMEZONE`, измерение `internal`), `AnalyticsReport`, `AnalyticsDashboard`, `User.analyticsOptOut`.
- Уникумы роллапов с NULL-измерениями — `UNIQUE … NULLS NOT DISTINCT`, руками в миграции. `prisma migrate diff --from-schema-datasource … --to-schema-datamodel …` показывает ровно эти три индекса как «лишние» — ожидаемый дрейф, не чинить.
- Ретенция: сырьё и `rollup_actor_day` — `ANALYTICS_RAW_RETENTION_DAYS` (партиции сбрасываются целиком), прочие роллапы вечны.

## Реестр событий

Файл на область: `packages/shared/src/analytics/platform.ts` (навигация, вход, организации, тарифы, уведомления, ссылки, сама аналитика), `tasks.ts`, `messenger.ts`, `calendar.ts`; слияние и хелперы — `index.ts`, словарь — `types.ts`, маршруты — `routes.ts`. Ключ — `<область>.<объект>.<действие>`; область (`ANALYTICS_AREAS`) = первый сегмент. Декларация: `service`, `source` (`server` | `client` | `both`), `class` (`business` — факт сервиса, пишется всегда · `product` — действие, уважает отказ · `telemetry` — фон), `qualifying` (считается активностью), `anonymous` (разрешён до входа), `props` — СТРОГАЯ Zod-схема плоских примитивов из строительных блоков (`noProps`, `propCode`, `propRoute`, `propCount`, enum/boolean), `version`, `status` (`live` · `planned` — объявлен заранее, отправителя ещё нет, принимается как live · `deprecated` · `blocked` — отбрасывается), `sample`. Слова — `analytics.events.<ключ>.title|description` в трёх каталогах.

**Правило источника:** «это произошло?» — сервер из транзакции мутации; «увидел/попытался?» — клиент. Имена не пересекаются — двойного счёта нет. **Новое событие** = декларация в файле области + две строки в трёх каталогах + вызов `track`; `pnpm check:analytics` сверяет каталоги, запрещённые слова в именах свойств (`ANALYTICS_DENY_PROP_WORDS`: phone, iin, bin, email, name, iban, card, token, address, text, body, title — по словам camelCase), владельца ключа, то, что серверный ключ не ОТПРАВЛЯЕТСЯ из клиентов (`track('<ключ>'`), что ключ `planned` ещё нигде не отправляется (начали слать — перевести в `live`) и что у ключа `live` отправка есть (иначе предупреждение: событие не придёт никогда); потолок живых ключей 150. Тот же набор правил — смоук `analyticsRegistryProblems()` на бутстрапе API (громкий отказ старта).

`routeTemplateOf(pathname)` вырезает UUID, числа и токены (`/tasks/:id`, `/s/:token`); `serviceOfRoute(template)` — таблица префиксов → область (новый раздел веба = +1 строка, иначе он в `other`). Сервер пересобирает шаблон сам, не доверяя SDK.

## Контракт сервиса

```ts
analytics.track(tx | null, 'tasks.task.created', { hasAssignee, hasDue, hasReward, contextType }, { userId, workspaceId, ref: { type: 'task', id } });
```

Ключ и свойства проверяет компилятор (`AnalyticsServerEventKey`, `AnalyticsPropsOf<K>`). С `tx` — строка в `analytics.outbox` В ТОЙ ЖЕ транзакции (откат мутации = события нет; сеть в транзакцию не попадает). Без `tx` — буфер 50 мс → XADD: там, где мутация уже закоммичена или транзакции нет, и для отказов 402 (`denial` бросает исключение и откатывает транзакцию вызывающего). `userId` по умолчанию — из контекста запроса, `workspaceId` — только проверенный chokepoint'ом (`activeWorkspaceId`), `null` — личное. Предпросмотр команды кабинета (`DryRun`) — `track` молчит. Сессия и устройство серверного события — из заголовков `X-Analytics-Session` / `X-Analytics-Device` (кладёт `WorkspaceContextInterceptor` в `WorkspaceContext.client`; только uuid). Модуль `@Global` — импорт в потребителе не нужен.

Точки v1: вход (`register` в транзакции, `login`, сброс пароля), организации (создание, приглашение, принятие, архив), тарифы (`entitlements.access.denied` в `denial`, старт/смена/окончание подписки — `setSubscription`, `startTrial`, `EntitlementsLifecycle`), прочтение уведомлений, открытие ссылки наружу (гостевой факт без личности), Задачник (создание, сдача, приёмка, завершение без приёмки), Мессенджер (чаты всех видов, сообщения без содержимого), Календарь (событие, ответ на приглашение). Остальные сервисы подключаются по одному за подход.

**Забвение** — на ОБОИХ путях удаления: `forgetUser(tx, userId)` в транзакции анонимизации аккаунта (`UsersService`), `forgetWorkspace(id, deadline)` — шаг `analytics.workspace` каскада организации (core/lifecycle; роллапы — пачками, не одним DELETE). Агрегаты с измерением субъекта удаляются сразу, сырьё — джобами `analytics.user.erase` / `analytics.workspace.erase` батчами по `(event_id, ts)` в два прохода (второй через 10 минут догоняет события, летевшие в очереди; id анонимов первый проход передаёт второму в payload и удаляет склейки сразу — «вернувшийся человек — новый»). Команда кабинета `analytics.user.forget` — тот же путь.

## Безопасность и приватность

IP и сырой UA не хранятся; свободного текста в свойствах нет (allow-list + страж + редакция); личность — только из JWT, членство в организации проверяет консьюмер; `workspace_id` — измерение каждого роллапа и предикат каждого запроса, чтение — только через `AnalyticsQueryService` (транзакция `READ ONLY` с `statement_timeout`); k-анонимность разбиений по организации и тарифу (`ANALYTICS_K_ANON`); отказ человека и `Sec-GPC` применяются на сервере; панели 360 — отдельная способность + общий бюджет просмотров + журнал чтений, лент по человеку нет; аналитика ≠ аудит (правда «кто/что/когда» — `core/chatter`). Сквозное — [security.md](security.md), кабинет — [platform_console.md](platform_console.md).

## Env

`ANALYTICS_ENABLED`, `ANALYTICS_CONSUMER_ENABLED`, `ANALYTICS_RAW_RETENTION_DAYS`, `ANALYTICS_STREAM_MAXLEN`, `ANALYTICS_K_ANON`, `ANALYTICS_INTERNAL_PHONE_PREFIXES`, `ANALYTICS_READ_DATABASE_URL`, `ANALYTICS_QUERY_TIMEOUT_MS` — [environment_variables.md](environment_variables.md).

## Проверка

`node apps/api/scripts/verify-analytics.cjs` (suite1 — владелец кабинета): приём и личность из JWT, поле личности в теле, неизвестный и серверный ключи, рубильник, редакция PII, анонимная ручка и оспоренная склейка, отказ человека против business-факта с сессией из заголовка, дедуп ретрая, роллап и все виды запросов, k-анонимность, фоновая воронка, каталог и качество, панель «Активность», отчёты и дашборды, забвение командой, партиции. Стражи: `pnpm check:analytics`, смоук реестра на бутстрапе, компилятор (ключ вне реестра в `track` не собирается).

## Связанные доки

[analytics_ingest.md](analytics_ingest.md) · [analytics_reports.md](analytics_reports.md) · [platform_console.md](platform_console.md) · [jobs_engine.md](jobs_engine.md) · [entitlements_engine.md](entitlements_engine.md) · [security.md](security.md) · [contract_boundary.md](contract_boundary.md)

## Отказ человека — согласие вида `analytics`

Своей двери записи отказа у аналитики нет: правда — движок согласий ([consents_engine.md](consents_engine.md), вид `analytics`, режим opt-out), `users.analyticsOptOut` — её ЗЕРКАЛО, которое читает приём событий. `ConsentsService` ставит зеркало в транзакции приёмки/отзыва через `AnalyticsService.applyOptOut(tx, …)` и после коммита зовёт `publishOptOut` (кэш Redis). `GET /analytics/consent` остался для SDK; `PATCH` удалён. Область `consents` и события `consents.*` — `packages/shared/src/analytics/consents.ts`.
