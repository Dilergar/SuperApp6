# core/jobs — движок фоновых джобов

> Transactional outbox + at-least-once исполнение (модель Oban/River/Solid Queue — свой тонкий движок на Postgres; НЕ pg-boss/BullMQ/Temporal — решения грилла зафиксированы). Правило платформы: **на шину EventBus — только то, что можно потерять; обязательная фоновая работа — сюда, джоб ставится В ТРАНЗАКЦИИ мутации** (коммит = джоб есть, откат = джоба нет).

Код: `apps/api/src/core/jobs/` (`jobs.service.ts` · `jobs.registry.ts` · `jobs.worker.ts` · `jobs.cron.ts` · `jobs.controller.ts`); дефолты — `JOB_LIMITS` в `packages/shared/src/constants/jobs.ts`.

## Модель

Одна таблица `jobs` (`apps/api/prisma/schema.prisma`, модель `Job`): BigInt id; статусы `available | executing | completed | discarded | cancelled` («retryable» видно по attempts>0, «scheduled» по runAt>now); payload — **только id-шки** (правило Sidekiq); `uniqueKey` — идемпотентная постановка (INSERT ON CONFLICT DO NOTHING; уникальность среди ЖИВЫХ — партиальный unique). Партиальные индексы claim-пути/reaper/unique-key/retention — руками в миграции + коммент в схеме.

## Контракт потребителя

```ts
// постановка — В ТРАНЗАКЦИИ доменной мутации
JobsService.enqueue(tx, { type, payload, runAt?, uniqueKey?, maxAttempts?, priority? })
// → { inserted } — по false постановщик, для которого «уже идёт» ≠ «уже учтено»,
//   ставит ПАРНЫЙ догоняющий джоб (образец — пересборка Документов)
JobsService.cancelByUniqueKey(tx|null, type, key)   // отмена невзятого (available); executing добьёт доменный гвард обработчика
JobsRegistry.register(type, handler, { queue?, maxAttempts?, leaseMs?, backoffBaseMs?, queueConcurrency?, onDiscard? })  // в onModuleInit
handler(payload, ctx: { jobId, attempt, maxAttempts })   // ctx.attempt — для логики «последняя попытка» (attempt === maxAttempts)
onDiscard(payload, { jobId, attempts, error })
```

- Параметр `tx` типизирован `Tx | null`. `null` — постановка вне транзакции там, где транзакции нет вовсе (крон, бэкфилл на старте). Для доменной мутации `null` НЕ вариант: джоб «после коммита» теряется при падении между коммитом и постановкой, джоб «до коммита» переживает откат — правило «в транзакции мутации» несущее.
- `queueConcurrency`: 0/отрицательное/NaN → дефолт (`JOB_LIMITS.defaultQueueConcurrency` = 10) + warn (иначе очередь встала бы молча навсегда). Повторный `register` того же типа — warn + перезапись.

**Обработчик ОБЯЗАН**:
- быть идемпотентным (at-least-once);
- делить ошибки на два класса: транзиентная (сеть/БД) → `throw` (движок ретраит с бэкоффом 30с×2^n ±25% джиттера, кап 1ч), ПОСТОЯННАЯ (родитель удалён, доступ отозван, работа потеряла смысл) → `JobDiscardError` ∥ тихий return — иначе джоб жжёт попытки часами и хоронится ложным инцидентом;
- НЕ коммитить доменный клейм до эффектов (падение между клеймом и эффектом = потеря навсегда: повтор видит «уже сделано») — клейм+эффекты в одной транзакции, внешние вызовы после коммита;
- иметь `onDiscard`-хук, если домен держит статус «в работе» (джоб может умереть по аренде МИМО catch — хук пишет терминальный статус, иначе строка виснет в processing навсегда);
- сам держать внутренние таймауты в бюджете `leaseMs` (аренда — не убийца: JS не умеет прервать зависший Promise).

«Не созрело ещё» (данные не готовы) — НЕ throw: тихий выход, работу принесёт вебхук/крон.

## Механика движка

- **Claim** — CTE `FOR UPDATE SKIP LOCKED` пачкой (≤ `claimBatch` 10, только типы с обработчиком на этом инстансе) + `attempts++` при клейме = клейм-токен финальных записей (`setLease`/`complete`/`fail` — под гвардом `(status='executing', attempts)`; поздний зомби-врайт перехваченного джоба — no-op).
- **Воркер** in-process: поллер 1с + нудж ~50мс после enqueue + нудж на освобождение слота; concurrency per-queue (дефолт 10). Cap — свойство ОЧЕРЕДИ = MIN `queueConcurrency` по её типам: тяжёлым типам дают СВОЮ очередь, а не сужают `default`. Очереди: `default`, `media`, `scan`, `voice`, `recording`, `docs`, `drive`, `documents`, `hr`, `sign`, `sign_stamp` (карта ниже).
- **Graceful shutdown**: `enableShutdownHooks` + дренаж in-flight ≤ `shutdownDrainMs` (10с); недожатое вернёт reaper по аренде.
- **Dead-letter**: исчерпание попыток или `JobDiscardError` → `discarded` + `onDiscard`. Error-лог и событие шины **`job.discarded`** (`{jobId, type, attempts, error}`) — ТОЛЬКО при исчерпании/протухании (явный discard = warn, не инцидент). Подписчиков у события нет — прод-наблюдаемость в [roadmap.md](roadmap.md). Текст `last_error` режется до `MAX_ERROR_LEN` (2000).
- **Обслуживание — единственный крон движка** (`JobsCron`, каждый под Redis-локом):
  - reaper `* * * * *` — протухшие аренды: исчерпавшие попытки → `discarded` (+хук, +событие), остальные → `available` с бэкоффом базы ТИПА, пер-строчно под гвардом, ≤ `REAP_BATCH` (500) за прогон. Единственный крон с `runWithoutLock`: недоступный Redis не останавливает восстановление после краша (reaper идемпотентен).
  - фиксап `50 * * * *` — `fixStrandedQueues` двигает available-строки типа, переехавшего в другую очередь (регистрация — источник правды; тип без обработчика на этом инстансе при enqueue ложится в `default`), + `reportUnhandled` (warn по типам без обработчика).
  - ретеншн `20 4 * * *` — `pruneTerminal`: completed 7д / discarded+cancelled 30д, батчами `RETENTION_BATCH` (5000).
- **Тип без обработчика** (фича выключена env / тип удалён между деплоями): строка бессмертна (claim, фиксап — по реестру; ретеншн — только терминальные). Движок видит и называет (`stats.unhandled` + часовой warn), НЕ пускает в прибор «очередь встала»; авто-чистки НЕТ намеренно. Хоронит человек: `purgeUnhandled(type)` → `cancelled` + finishedAt (заберёт ретеншн); только `available` (executing может исполнять сосед); бросает, если тип ЗАРЕГИСТРИРОВАН на этом инстансе.
- Время в сыром SQL — только `utcTs()` (`apps/api/src/shared/database/sql-time.ts`; в `jobs.service.ts` — локальный алиас `ts`), никогда `now()`/голый параметр-Date — [api_conventions.md](api_conventions.md).

## Ловушки

- **Новая NOT NULL-колонка в `jobs` ОБЯЗАНА иметь DEFAULT** (или быть вписана в INSERT): `enqueue` с `uniqueKey` делает сырой INSERT с перечислением колонок (иначе не выразить `ON CONFLICT DO NOTHING`), и без DEFAULT он падает ВНУТРИ ЧУЖИХ доменных транзакций — постановка идёт в них.
- **`CLAIM_LEASE_FLOOR_SEC` (300, `jobs.service.ts`) = `JOB_LIMITS.defaultLeaseMs`** намеренно: claim ставит пол аренды, воркер сразу поднимает до `leaseMs` типа. Будь дефолт меньше пола, `setLease` СОКРАЩАЛ бы аренду, и фанаут-обработчик без своего потолка, залезший за неё, переклеймивался бы reaper'ом вторым заходом параллельно. Меняешь одно — меняй оба.
- Партиальные индексы Prisma не выражает — `migrate dev` без ручного SQL в миграции их молча дропнет.
- `enqueue` внутри транзакции не знает момента коммита: нудж уходит с задержкой, некоммиченная строка невидима клейму — хвост подбирает поллер.

## Дев-наблюдаемость (только development)

`GET /jobs/stats` + полигон `POST /jobs/dev/enqueue|cancel|expire-lease|reap|purge-unhandled` и `GET /jobs/dev/by-key` (тест-тип `jobs.dev.echo`), `apps/api/src/core/jobs/jobs.controller.ts`.

## Кто на движке (карта типов)

Тип → очередь (cap, если сужен). Константы типов живут у владельца (`*.constants.ts` / `*.job-names.ts` / сам сервис), не в движке.

- `default`: `chatter.chatpost` (плашки чатов; onDiscard) · `messenger.scheduled.fire` (uniqueKey с версией времени `sm:<id>:<sendAtMs>`; onDiscard) · `notifications.dispatch` · `calls.recording.deliver` · `calls.session.summarize` (ставит core/calls, обработчик регистрирует МЕССЕНДЖЕР) · `calendar.reminder.fire` (runAt=fireAt — точность секунды) · `approvals.remind|escalate|resolved|announce` · `users.phone.invitations` · `jobs.dev.echo`.
- `media` (3): `files.pipeline` · `scan` (3): `files.scan` · `voice` (2): `voice.transcribe` · `recording` (2): `calls.recording.finalize`.
- `docs` (`DOCS_LIMITS.queueConcurrency`): `docs.milestone|rendition|text` (константы `DOCS_JOB_TYPES`, `packages/shared/src/constants/documents.ts`).
- `drive` (4): `drive.ingest|rollup|copy|photo.index`.
- `documents` (3): `documents.generate|pdf|file` (пара стабильных ключей `docGenKey` + снимок входов `contentSnapshot` — два рендера не бегут параллельно, правка во время рендера перезаказывает хвостом) · `documents.campaign.run` (`apps/api/src/modules/documents/doc-campaigns.service.ts`).
- `hr`: `hr.action.apply` (runAt=дата вступления) · `hr.batch.run`.
- `sign`: `sign.requested` · `sign.act.finished` · `sign.request.expired`; `sign_stamp` (2): `sign.stamp` (тяжёлый pdf-lib — своя очередь) — `apps/api/src/core/sign/sign.jobs.ts`.

Бэкфилл доджобовых строк — onApplicationBootstrap потребителя (сверяется ТОЛЬКО с живыми джобами; uniqueKey дедупит).

## Что НЕ переезжает на движок (осознанно)

Token-walker Процессов (домен со своей семантикой) · ~30 @Cron+withLock ретеншнов/сверок (здоровые кроны) · EventBus (его обработчики неидемпотентны — не переделываем).

## Проверка

`apps/api/scripts/verify-jobs.cjs` (полигон: клеймы, аренды, бэкофф, дедуп, зомби-врайт) + `verify-notify-jobs.cjs` + сьюты потребителей.
