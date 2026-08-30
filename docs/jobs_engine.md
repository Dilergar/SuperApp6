# core/jobs — движок фоновых джобов

> Transactional outbox + at-least-once исполнение (модель Oban/River/Solid Queue — свой тонкий движок на Postgres; НЕ pg-boss/BullMQ/Temporal — решения грилла зафиксированы). Правило платформы: **на шину EventBus — только то, что можно потерять; обязательная фоновая работа — сюда, джоб ставится В ТРАНЗАКЦИИ мутации** (коммит = джоб есть, откат = джоба нет).

## Модель

Одна таблица `jobs`: BigInt id; статусы `available | executing | completed | discarded | cancelled` («retryable» видно по attempts>0, «scheduled» по runAt>now); payload — **только id-шки** (правило Sidekiq); `uniqueKey` — идемпотентная постановка (INSERT ON CONFLICT DO NOTHING; уникальность среди ЖИВЫХ — партиальный unique). Партиальные индексы claim-пути/reaper/retention — руками в миграции.

## Контракт потребителя

```ts
// постановка — В ТРАНЗАКЦИИ доменной мутации
JobsService.enqueue(tx, { type, payload, runAt?, uniqueKey?, maxAttempts?, priority? })
// → { inserted } — по false постановщик, для которого «уже идёт» ≠ «уже учтено»,
//   ставит ПАРНЫЙ догоняющий джоб (образец — пересборка Документов)
JobsService.cancelByUniqueKey(tx|null, type, key)   // отмена невзятого
JobsRegistry.register(type, handler, { queue?, maxAttempts?, leaseMs?, backoffBaseMs?, onDiscard? })  // в onModuleInit
```

**Обработчик ОБЯЗАН**:
- быть идемпотентным (at-least-once);
- делить ошибки на два класса: транзиентная (сеть/БД) → `throw` (движок ретраит с бэкоффом 30с×2^n ±джиттер, кап 1ч), ПОСТОЯННАЯ (родитель удалён, доступ отозван, работа потеряла смысл) → `JobDiscardError` ∥ тихий return — иначе джоб жжёт попытки часами и хоронится ложным инцидентом;
- НЕ коммитить доменный клейм до эффектов (падение между клеймом и эффектом = потеря навсегда: повтор видит «уже сделано») — клейм+эффекты в одной транзакции, внешние вызовы после коммита;
- иметь `onDiscard`-хук, если домен держит статус «в работе» (джоб может умереть по аренде МИМО catch — хук пишет терминальный статус, иначе строка виснет в processing навсегда);
- аренда (`leaseMs`) ≥ суммы внутренних таймаутов обработчика.

«Не созрело ещё» (данные не готовы) — НЕ throw: тихий выход, работу принесёт вебхук/крон.

## Механика движка

- **Claim** — CTE `FOR UPDATE SKIP LOCKED` пачкой + `attempts++` при клейме = клейм-токен финальных записей (поздний зомби-врайт перехваченного джоба — no-op).
- **Воркер** in-process: поллер 1с + нудж ~50мс после enqueue + нудж на освобождение слота; concurrency per-queue (дефолт 10; `queueConcurrency` = MIN по типам очереди — тяжёлым типам дают СВОЮ очередь, а не сужают default). Очереди: default, media, scan, voice, docs, drive, recording, documents, hr…
- **Graceful shutdown**: `enableShutdownHooks` + дренаж in-flight ≤10с; недожатое вернёт reaper по аренде.
- **Обслуживание — единственный крон движка** (`JobsCron`): reaper протухших аренд (работает и при недоступном Redis; возвращает с бэкоффом ТИПА, пер-строчно под гвардом), фиксап очередей раз в час, ретеншн (completed 7д / discarded+cancelled 30д).
- **Тип без обработчика** (фича выключена env / тип удалён между деплоями): движок видит и называет (`stats.unhandled` + часовой warn), НЕ пускает в прибор «очередь встала»; авто-чистки НЕТ намеренно (хоронит человек: `purgeUnhandled` — только available).
- `defaultLeaseMs` 300с; время в SQL — только хелпер `ts(d)` (никогда `now()`).

## Дев-наблюдаемость (только development)

`GET /jobs/stats` + полигон `POST /jobs/dev/enqueue|cancel|expire-lease|reap|purge-unhandled` и `GET /jobs/dev/by-key` (тест-тип `jobs.dev.echo`).

## Кто на движке (карта типов)

`chatter.chatpost` (плашки чатов) · `messenger.scheduled.fire` (отложенные; uniqueKey с версией времени `sm:<id>:<sendAtMs>`) · `notifications.dispatch` (создание строк уведомлений) · `files.pipeline` / `files.scan` · `voice.transcribe` · `calls.recording.finalize|deliver` + `calls.session.summarize` · `calendar.reminder.fire` (runAt=fireAt — точность секунды) · `docs.milestone|rendition|text` · `drive.ingest|rollup|copy|photo.index` · `approvals.escalate|resolved|remind|announce` · `documents.generate|pdf|file` (пара стабильных ключей `docGenKey` + снимок входов `contentSnapshot` — два рендера не бегут параллельно, правка во время рендера перезаказывает хвостом) · `sign.stamp` · `hr.action.apply` (runAt=дата вступления) / `hr.batch.run` · `users.phone.invitations` · `jobs.dev.echo`.

Бэкфилл доджобовых строк — onApplicationBootstrap потребителя (сверяется ТОЛЬКО с живыми джобами; uniqueKey дедупит).

## Что НЕ переезжает на движок (осознанно)

Token-walker Процессов (домен со своей семантикой) · ~30 @Cron+withLock ретеншнов/сверок (здоровые кроны) · EventBus (его обработчики неидемпотентны — не переделываем).

## Проверка

`verify-jobs.cjs` (полигон: клеймы, аренды, бэкофф, дедуп, зомби-врайт) + `verify-notify-jobs.cjs` + сьюты потребителей.
