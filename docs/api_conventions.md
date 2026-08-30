# Конвенции API (NestJS)

> Правила, обязательные для КАЖДОЙ ручки и каждого сервиса `apps/api`. Нарушение любого из них уже стоило продакшн-бага — они несущие, не рекомендательные.
>
> Конвенция путей в доках: `shared/...` без префикса пакета = `apps/api/src/shared/...`; пакет типов границы — всегда полный `packages/shared/...`.

## Префикс и версия

- Канонический префикс — **`/api/v1/...`** (rewrite-алиас в `main.ts`: `/api/...` остаётся рабочим legacy-путём). Нативные клиенты пиняются на v1; будущий ломающий v2 сможет сосуществовать.

## Единый конверт ответов и ошибок

- Успех: `{ success: true, data: … }`.
- ВСЕ ошибки — через глобальный `AllExceptionsFilter` (APP_FILTER, `shared/filters/all-exceptions.filter.ts`) в конверте `{ success: false, statusCode, message, errors?, details? }`:
  - ZodError → 400 с полями; HttpException → как есть; Prisma P2002/P2025 → 409/404; прочее → 500 + лог;
  - `details` — машиночитаемые коды (`details.code`, `resendInSec`, `attemptsLeft`); клиент ветвится по коду, НЕ по русскому тексту;
  - при наличии `resendInSec` на 429 ставится заголовок `Retry-After`;
  - явный `errors` из тела исключения пробрасывается (не терять список «что именно не так»).

## Страницы (пагинация)

- Две формы на всю платформу: `CursorPage<T> {items, nextCursor}` и `OffsetPage<T> {items, meta}` (`packages/shared/src/types/common.ts`).
- **Страница едет в `data` ЦЕЛЬНОЙ**: `{ success: true, data: page }`. Расплющивать (`data: page.items` + `nextCursor` рядом) ЗАПРЕЩЕНО — клиент вынужден собирать её обратно своим типом, который не проверяет никто.
- Поле списка всегда `items`, никогда `data`.
- Keyset-курсор с тай-брейком по `id` (пачка строк с одинаковым временем не должна перепрыгиваться); BigInt id в DTO — ВСЕГДА строкой.

## Контроллеры и сервисы

- Контроллер тонкий: `Zod parse → сервис`. Это же делает сервис AI-ready (операция вызываема программно).
- Читающие методы сервиса объявляют `Promise<Dto из shared>`; Date/BigInt сериализуются в строку В СЕРВИСЕ (аннотация типа заставит компилятор это потребовать). Контроллер поля НЕ переименовывает.
- Тип входа НЕ пишется рукой — `export type XxxInput = z.infer<typeof xxxSchema>` рядом со схемой в `packages/shared/src/validation/`. Внутренний вызывающий, строящий вход руками, проходит через ТУ ЖЕ схему (`schema.parse({…})`) — чтобы получить те же умолчания.

## Валидация query

- **Флаг в query-строке — только `queryBoolean`** (`packages/shared/src/validation/query.ts`), НИКОГДА `z.coerce.boolean()`: строка `'false'` непустая → истинна, и ручка молча отвечает наоборот. Принимаются `true/false`, `1/0`, `yes/no`; пустая строка = «не задано».

## Маршруты

- **Статические пути объявлять ДО параметрических `:id`** — иначе Nest ищет сущность с идентификатором «inbox»/«mine»/«available-templates» (ловушка ловилась трижды: approvals, share-links, documents).
- Catch-all `:documentId` съедает следующие слова пути — вложенные под-ресурсы с конфликтом имён выносить на свою базу (прецедент: `doc-campaigns` вместо `documents/campaigns`).

## Троттлинг

- Глобальный `ThrottlerGuard` (APP_GUARD) + Redis-хранилище (общее на инстансы, 1 Lua-вызов на троттлер): 10/сек short, 50/10сек medium, 200/мин long. `@Throttle` точечно (login/register 5/15мин и т.д.).
- **Secure-by-default**: выключен ТОЛЬКО при явном `NODE_ENV=development|test`; опечатка и отсутствие переменной = полная защита. То же — Swagger (только development).
- `@Public()` + `@SkipThrottle` — для вебхуков и WOPI (у контейнера один IP на всех); подпись вебхука проверяется по СЫРОМУ телу (точечный `express.raw` в main.ts до body-parser). Auth — глобальный APP_GUARD: без `@Public()` каждая новая ручка защищена автоматически ([security.md](security.md)).

## Мутации и гонки

- Переходы состояний — **status-guarded `updateMany`** (двойное продвижение невозможно), критичные секции — `FOR UPDATE` строки-якоря, идемпотентность — уникальные индексы, а не проверки в приложении.
- **Партиальные уникумы Prisma не выражает** — дописывать руками в миграцию и зеркалить комментом в `schema.prisma` (иначе `migrate dev` их молча дропнет; то же с generated tsvector/GIN).
- Время в сыром SQL — только через хелперы (`shared/database/sql-time.ts` → `utcTs()`; в jobs — `ts(d)`), голые `now()`/параметр-Date запрещены: колонки `timestamp` без пояса + `timestamptz`-параметр = доворот поясом сессии. Страж пояса сессии — в `DatabaseModule` (warn при TimeZone ≠ UTC).

## Zod и XSS

- Zod на входе каждого контроллера; `.strict()` на объектных схемах; `.refine()` запрещает `<>` в именах/ролях/био/сообщениях.

## Прочее

- Миграции — только `prisma migrate dev` / `migrate deploy`; `db push` ЗАПРЕЩЁН (разойдётся с историей миграций).
- Redis: кэш профилей (5 мин), сессии, шина, rate-limit счётчики, distributed-lock для крон (`RedisService.withLock` с owner-токеном — Lua compare-and-del).
- Кроны — под Redis-локом (выполняет один инстанс); ретеншны — батчами по индексу.

## Связанные доки

[contract_boundary.md](contract_boundary.md) · [security.md](security.md) · [jobs_engine.md](jobs_engine.md) (фоновая работа) · [module_graph.md](module_graph.md) (EventBus).
