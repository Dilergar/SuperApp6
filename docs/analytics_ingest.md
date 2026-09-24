# Аналитика: приём, консьюмер, кроны

> Часть 3 [analytics_engine.md](analytics_engine.md): как событие доходит от клиента и транзакции сервиса до партиции, как считаются роллапы и где ловушки.

Код: `apps/api/src/core/analytics/analytics.controller.ts` (приём), `apps/api/src/core/analytics/analytics.ingest.service.ts` (консьюмер stream + outbox), `apps/api/src/core/analytics/analytics.enrich.ts`, `apps/api/src/core/analytics/analytics.cache.ts`, `apps/api/src/core/analytics/analytics.partitions.ts`, `apps/api/src/core/analytics/analytics.cron.ts`, `apps/api/src/core/analytics/analytics.rollup.service.ts`, `apps/api/src/core/analytics/analytics.jobs.ts`.

## Приём

- `POST /api/v1/analytics/collect` (JWT, `@DeferWorkspaceCheck`, 120/мин **на человека**, тело ≤ 64 КБ) и `POST /api/v1/analytics/collect/anon` (`@Public`, только ключи `anonymous: true`, 30/мин с IP, тело ≤ 32 КБ): батч ≤ 50 событий, конверт и каждое событие — `.strict()`. Корзина лимита авторизованного приёма — `ip + sub` (`personTracker`: `sub` читается из тела токена без проверки подписи, гард JWT идёт следом): организация за одним NAT не делит один потолок на всех сотрудников, а чужой `sub` в поддельном токене не исчерпывает корзину жертвы. Ответ `202 { accepted, dropped }`; отказом отвечают только `400 analytics.payload_too_large` и `429`, прочие ошибки — `dropped` + запись карантина. `ANALYTICS_ENABLED=false` — `202` с `accepted: 0`.
- **Инвариант: на пути HTTP нет ни одного запроса к Postgres.** Валидация по реестру в памяти, одна запись XADD на батч в `superapp:analytics` (`MAXLEN ~ ANALYTICS_STREAM_MAXLEN`). Организация берётся из `X-Workspace-Id` БЕЗ проверки членства (`claimedWorkspaceId`) — её проверяет консьюмер; `activeWorkspaceId` на таких маршрутах не ставится, chokepoint выключен. Сброс при заполнении stream'а: > 80 % отбрасывается `telemetry`, > 95 % — и `product`; серверный путь через outbox не затрагивается.
- Поле личности в теле (`userId`, …) — ошибка схемы. Серверный ключ с HTTP — карантин `server_key_from_client`. `Sec-GPC: 1` — отказ на эти события.
- `POST /analytics/identify {anonymousId}` — склейка (20/мин на человека: пишет в БД и сканирует сырьё анонима; первая побеждает, другой аккаунт → `contested`, дни анонима за 30 дней — в пересчёт). `GET|PATCH /analytics/consent` — тумблер человека (Redis-ключ отказа на 5 минут, факт `analytics.consent.changed` в транзакции).

## Консьюмер

Группа `superapp:analytics-workers` (по консьюмеру на инстанс, `XAUTOCLAIM` зависших > 60 с, `ANALYTICS_CONSUMER_ENABLED`); outbox дренируется раз в секунду `SELECT … FOR UPDATE SKIP LOCKED` + вставка + `DELETE` одной транзакцией; ядовитая пачка разбирается по одной строке, каждая берётся `WHERE id = … FOR UPDATE SKIP LOCKED` (строку держит другой инстанс — она его, идём дальше). Обогащение (членство, тариф) ходит в БД не больше чем 16 запросами разом (`mapLimit`), а не всей пачкой. Конвейер: рубильник (кэш 30 с на инстанс) → строгая схема → редакция значений, похожих на PII (телефон РК, 12 цифр, e-mail → `[redacted]` + счётчик + карантин `pii`) → личность (удалённый или несуществующий аккаунт — прочь; кэш 60 с) → членство в заявленной организации (`RolesService.getRolesInContext`, кэш 60 с) → отказ человека (`product`/`telemetry`) → снимок тарифа (`EntitlementsService.liveSubscriptionOf`: подписка организации или человека, кэш 60 с) → `is_internal` (активный `PlatformStaff` ∪ `ANALYTICS_INTERNAL_PHONE_PREFIXES`) → вставка пачками ≤ 1000 одним параметром `jsonb_to_recordset … ON CONFLICT (event_id, ts) DO NOTHING`. Кольцо 200k последних `event_id` отсекает ретраи до БД. Эффекты вне БД (кольцо, «грязные» дни, счётчики) — только после коммита.

Ошибки: нет партиции → партиция создаётся и вставка повторяется; ошибка ДАННЫХ (SQLSTATE 22/23) — пачка разбирается по строке, виновная уходит в карантин; всё прочее (связь, класс 42 — баг кода) — без ack/без удаления из outbox: событие ждёт исправления, а не хоронится.

## Кроны и джобы

`analytics.cron.ts`: каждые 10 минут — роллап «сегодня» и «грязных» дней (набор Redis `analytics:dirty-days`); ночью 02:10 — ретенция `rollup_actor_day` батчами, уборка карантина, пересчёт последних 7 дней. Джобы очереди `analytics` (параллельность 2):

- `analytics.rollup.day` (`uniqueKey rollup:<день>`) — день целиком: DELETE + INSERT трёх роллапов под `pg_advisory_xact_lock` дня, из временной таблицы, с ретро-склейкой анонимов по неоспоренной связи;
- `analytics.report.run` (`uniqueKey report:<hash>`) — воронка длиннее 90 дней, результат — в ключ кэша запроса;
- `analytics.user.erase` / `analytics.workspace.erase` (`uniqueKey erase:<тип>:<id>:<проход>`) — два прохода, второй через 10 минут.

Пересчёт диапазона вручную — команда кабинета `analytics.rollup.rebuild` (предпросмотр показывает число дней).

## Ловушки

- **Массив из одних NULL Prisma передаёт как `integer[]`**: параллельные массивы `unnest($1::uuid[], …)` падают на колонке, где в пачке все значения пусты. Пачка — одним `jsonb_to_recordset` с явным списком колонок.
- **Число в сыром SQL приходит `bigint`**: `make_interval(days => $1)` и `date - $1` без `::int` — «function does not exist».
- **`ctid` у партиционированной таблицы не уникален** — удаление адресуется парой `(event_id, ts)`.
- **Класс 42 — не «ядовитая строка»**: баг приведения типов, принятый за ошибку данных, хоронил бы валидные события в карантин.
- Партиции сырья (вперёд на буте и ночью, сброс старше `ANALYTICS_RAW_RETENTION_DAYS`) обслуживает `core/lifecycle` функциями владельца данных ([lifecycle_engine.md](lifecycle_engine.md)); `AnalyticsPartitions` — тонкий адаптер: срок из окружения и сброс кэша «первого события» `analytics:first-event` (он без TTL) вместе с самой старой партицией.
- `SET TRANSACTION READ ONLY` обязан быть первым оператором транзакции.
- `pg_advisory_xact_lock` возвращает `void` — Prisma не десериализует: `::text`.
- Параметры автовакуума у партиционированного родителя не ставятся — только на каждую партицию.
- Литеральный NUL-символ в исходнике (разделитель ключа карты) делает файл «бинарным» для ripgrep и graphify — разделители только печатные.
- Рубильник действует сразу на инстансе, исполнившем команду (`invalidateOverrides`), и через ≤ 30 секунд на соседних (кэш консьюмера на инстанс).
- Нет партиции ВНУТРИ транзакции outbox: после ошибки транзакция уже абортирована (25P02), партиция создаётся отдельным соединением, а пачка проходит следующим тиком — одна строка в логе, не потеря. На пути stream'а (вне транзакции) вставка повторяется сразу.

## Проверка

`node apps/api/scripts/verify-analytics.cjs`; dev-ручки кабинета (только development, `analytics.manage`) синхронно прогоняют конвейер: `POST /platform/analytics/dev/drain` (stream + outbox), `…/dev/rollup` (день), `…/dev/partitions`.

## Связанные доки

[analytics_engine.md](analytics_engine.md) · [analytics_reports.md](analytics_reports.md) · [jobs_engine.md](jobs_engine.md) · [event_bus.md](event_bus.md)
