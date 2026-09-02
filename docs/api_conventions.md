# Конвенции API (NestJS)

> Правила, обязательные для КАЖДОЙ ручки и каждого сервиса `apps/api`. Нарушение любого из них уже стоило продакшн-бага — они несущие, не рекомендательные.
>
> Конвенция путей в доках: `shared/...` без префикса пакета = `apps/api/src/shared/...`; пакет типов границы — всегда полный `packages/shared/...`.

## Префикс и версия

- Канонический префикс — **`/api/v1/...`**; `/api/...` остаётся рабочим legacy-путём. Нативные клиенты пиняются на v1; будущий ломающий v2 сможет сосуществовать.
- Механика (`apps/api/src/main.ts`): middleware переписывает `req.url` `/api/v1/…` → `/api/…` ДО роутинга, дальше `setGlobalPrefix('api')`. Следствие: сырые `app.use('/api/…')` (raw-body, заголовки) пишутся БЕЗ `v1` и покрывают оба префикса.

## Единый конверт ответов и ошибок

- Успех: `{ success: true, data: … }`.
- ВСЕ ошибки — через глобальный `AllExceptionsFilter` (APP_FILTER, `shared/filters/all-exceptions.filter.ts`) в конверте `{ success: false, statusCode, message, errors?, details? }` — форма провода `ApiError` (`packages/shared/src/types/common.ts`):
  - ZodError → 400 с полями; HttpException → как есть; Prisma P2002/P2025 → 409/404; прочее → 500 + лог;
  - `details` — машиночитаемые коды (`details.code`, `resendInSec`, `attemptsLeft`); клиент ветвится по коду, НЕ по русскому тексту;
  - при наличии `resendInSec` на 429 ставится заголовок `Retry-After`;
  - явный `errors` из тела исключения пробрасывается (не терять список «что именно не так»); `message: string[]` длиной >1 без явного `errors` → `errors: [{message}]`, `message` = первый элемент;
  - не-HTTP контексты (WS/RPC) фильтр пробрасывает как есть — у гейтвеев своя обработка.

## Страницы (пагинация)

- Две формы на всю платформу: `CursorPage<T> {items, nextCursor}` и `OffsetPage<T> {items, meta}` (`packages/shared/src/types/common.ts`).
- **Страница едет в `data` ЦЕЛЬНОЙ**: `{ success: true, data: page }`. Расплющивать (`data: page.items` + `nextCursor` рядом) ЗАПРЕЩЕНО — клиент вынужден собирать её обратно своим типом, который не проверяет никто.
- Поле списка всегда `items`, никогда `data`.
- Keyset-курсор с тай-брейком по `id` (пачка строк с одинаковым временем не должна перепрыгиваться); BigInt id в DTO — ВСЕГДА строкой.

## Контроллеры и сервисы

- Контроллер тонкий: `Zod parse → сервис`. Это же делает сервис AI-ready (операция вызываема программно).
- Читающие методы сервиса объявляют `Promise<Dto из shared>`; Date/BigInt сериализуются в строку В СЕРВИСЕ (аннотация типа заставит компилятор это потребовать). Контроллер поля НЕ переименовывает.
- Тип входа НЕ пишется рукой — `export type XxxInput = z.infer<typeof xxxSchema>` рядом со схемой в `packages/shared/src/validation/`. Внутренний вызывающий, строящий вход руками, проходит через ТУ ЖЕ схему (`schema.parse({…})`) — чтобы получить те же умолчания.
- **Вход — ТОЛЬКО Zod из shared** (`@Body() body: unknown` → `schema.parse`). Глобальный `ValidationPipe({whitelist, forbidNonWhitelisted, transform})` в `main.ts` при таком входе инертен — он работает лишь по class-validator-DTO. DTO на class-validator НЕ заводить: пакет есть в зависимостях, в `apps/api/src` не используется, второй валидатор = два источника правды формы провода.

## Валидация query

- **Флаг в query-строке — только `queryBoolean`** (`packages/shared/src/validation/query.ts`), НИКОГДА `z.coerce.boolean()`: строка `'false'` непустая → истинна, и ручка молча отвечает наоборот. Принимаются `true/false`, `1/0`, `yes/no`; пустая строка → `undefined` («не задано»), поэтому поле схемы — `.optional()`.

## Маршруты

- **Статические пути объявлять ДО параметрических `:id`** — иначе Nest ищет сущность с идентификатором «inbox»/«mine»/«available-templates» (ловушка ловилась трижды: approvals, share-links, documents).
- Catch-all `:documentId` съедает следующие слова пути — вложенные под-ресурсы с конфликтом имён выносить на свою базу (прецедент: `doc-campaigns` вместо `documents/campaigns`).
- **Сырое тело** — регистрируется в `main.ts` ДО body-parser'а (Nest вешает json-парсер в `app.listen`) через `app.use('/api/<путь>', …)` без `v1`. Два пути: `express.raw` на `/api/calls/livekit/webhook` (подпись по сырому телу, потолок 64kb — @Public без JWT) и `wopiRawBodyMiddleware` на `/api/wopi/files` (байты документа потоком на диск, не в память). Новый маршрут с сырым телом — там же, тем же способом.
- **Байты в iframe** — маршрут выдачи байтов, который открывается во фрейме (PDF-просмотрщик гостевой `/s/`), ОБЯЗАН быть в `FRAMEABLE_BYTE_PATHS` (`main.ts`: `/api/files/raw/`, `/api/public-files/`): там helmet-XFO снимается и ставится адресный `frame-ancestors`. Иначе рамка молча пустая (200 OK + `net::ERR_BLOCKED_BY_RESPONSE`). Снимать frameguard глобально нельзя — он закрывает одно-кликовые денежные действия от кликджекинга.

## Троттлинг

- Глобальный `ThrottlerGuard` (APP_GUARD) + `RedisThrottlerStorage` (`shared/throttler/redis-throttler.storage.ts`; общее на инстансы, 1 Lua-вызов на троттлер): 10/сек short, 50/10сек medium, 200/мин long. Единицы: `ttl`/`blockDuration` приходят в МИЛЛИСЕКУНДАХ, `timeToExpire`/`timeToBlockExpire` отдаются в СЕКУНДАХ (зеркало дефолтного хранилища).
- `@Throttle({ long: { limit, ttl } })` точечно — стоит у auth (login/register 5/15мин), users, verify, calls, files, voice, contacts, sign (+guest), share-links-guest, drive-guest. Новая ручка с деньгами/SMS/гостевым доступом — с точечным лимитом.
- **Secure-by-default**: выключен ТОЛЬКО при явном `NODE_ENV=development|test`; опечатка и отсутствие переменной = полная защита. То же — Swagger (только development) и dev-полигон джобов.
- `@Public()` + `@SkipThrottle` — для вебхуков и WOPI (у контейнера один IP на всех). Auth — глобальный APP_GUARD: без `@Public()` каждая новая ручка защищена автоматически ([security.md](security.md)).

## Окружение

- Предикаты `isDevEnv()` / `isProdEnv()` (`shared/config/env.validation.ts`) читают СЫРОЙ `process.env`, а не результат zod: у `NODE_ENV` в схеме стоит `.default('development')`, и сверка по разобранному значению означала бы «забыли переменную в контейнере ⇒ дев-окружение» — открытый Swagger, включённый dev-полигон джобов, выключенный троттлер. Записывать разобранный дефолт обратно в `process.env` НЕЛЬЗЯ по той же причине.

## Мутации и гонки

- Переходы состояний — **status-guarded `updateMany`** (двойное продвижение невозможно), критичные секции — `FOR UPDATE` строки-якоря, идемпотентность — уникальные индексы, а не проверки в приложении.
- **Партиальные уникумы Prisma не выражает** — дописывать руками в миграцию и зеркалить комментом в `schema.prisma` (иначе `migrate dev` их молча дропнет; то же с generated tsvector/GIN).
- Время в сыром SQL — только через хелпер `utcTs()` (`shared/database/sql-time.ts`; в `core/jobs/jobs.service.ts` он же под локальным алиасом `ts`), голые `now()`/параметр-Date запрещены: колонки `timestamp` без пояса + `timestamptz`-параметр = доворот поясом сессии. Страж пояса сессии — в `DatabaseModule` (warn при TimeZone ≠ UTC).

## Zod и XSS

- Zod на входе каждого контроллера; `.strict()` на объектных схемах; `.refine()` запрещает `<>` в именах/ролях/био/сообщениях.

## Прочее

- Миграции — только `prisma migrate dev` / `migrate deploy`; `db push` ЗАПРЕЩЁН (разойдётся с историей миграций).
- Redis: кэш профилей (5 мин), сессии, шина, rate-limit счётчики, distributed-lock для крон (`RedisService.withLock(key, ttlMs, fn)` с owner-токеном — Lua compare-and-del). **При занятом локе `withLock` возвращает `null` БЕЗ исключения** — вызывающий обязан различать `null` («сосед уже работает») и результат `fn`; исключение = сам Redis недоступен. Лок не заменяет клейм строк: переживший TTL прогон пойдёт параллельно с соседом.
- Кроны — под Redis-локом (выполняет один инстанс); ретеншны — батчами по индексу.

## Связанные доки

[contract_boundary.md](contract_boundary.md) · [security.md](security.md) · [jobs_engine.md](jobs_engine.md) (фоновая работа) · [module_graph.md](module_graph.md) (EventBus).
