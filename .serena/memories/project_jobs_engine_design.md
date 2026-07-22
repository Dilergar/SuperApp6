# core/jobs — движок фоновых джобов (10-й платформенный), **BUILT v1 2026-07-19 + Волна 1 (уведомления) 2026-07-20** (грилл → стройка; НЕ закоммичено)

Проверено: **verify-jobs.cjs 30/0** + **verify-notify-jobs.cjs 11/0** + регрессии chatter 68/0 · quickactions 20/0 · messenger-task 19/0 · tasks-inbox · messenger 29/0 · order · order-fulfilment · escrow · staff · wallet-паритет через escrow · block-enforcement · calendar-access · b2b-reachability · tasks-access; nest build + shared/web tsc чистые. Единственный ERROR в логах = ожидаемый dead-letter из тестов.

## Зачем (исследование)
7 ручных копий «claim + lease + attempts + dead-letter + крон-редрайв»: VoiceTranscript, плашки Chatter, CallRecording, ScheduledMessage, конвейер Files, token-walker Процессов, Notifications (важное, но без ретраев). EventBus не годится: ack ДО выполнения (at-most-once), emit вне транзакции (dual-write), нет состояния. Эталоны сходятся: очередь в ТОЙ ЖЕ Postgres + transactional enqueueing (River-термин) + FOR UPDATE SKIP LOCKED — Oban (эталонная стейт-машина), River, **Solid Queue (дефолт Rails 8, 20М джобов/день у 37signals на БД без Redis)**, pg-boss, Graphile Worker; Redis-очереди (Sidekiq basic ТЕРЯЕТ джоб при краше, at-least-once = платный super_fetch; BullMQ) — dual-write; Temporal — оверкилл (оркестрацию закрывают Процессы).

## Решения грилла (пользователь; НЕ пересматривать)
1. **Свой тонкий движок** (не pg-boss/Graphile — чужая схема мимо prisma migrate + постановка не композится с Prisma-tx; не BullMQ/Temporal).
2. **EventBus не трогаем**; ПРАВИЛО платформы (в CLAUDE.md): «на шину — только то, что можно потерять; обязательное — в core/jobs».
3. v1 = движок + переезды ScheduledMessage + плашек Chatter. ✅ СДЕЛАНО 2026-07-19.
4. 30 @Cron+withLock не трогаем (личные редрайв-кроны умирают по мере волн; recurring-API = v2).
5. **Уведомления → джобы Волной 1** (выбор пользователя ПРОТИВ моей рекомендации отложить). ✅ СДЕЛАНО 2026-07-20 — см. «Волна 1» ниже.
6. Наблюдаемость: error-лог + событие `job.discarded` + `GET /jobs/stats` (dev-only) + dev-полигон. Админ-UI — когда будет кабинет platform_admin.

## Как построено (файлы)
- `apps/api/src/core/jobs/`: `jobs.registry.ts` (JobsRegistry.register(type, handler, {queue?, maxAttempts?, leaseMs?, backoffBaseMs?}) + `JobDiscardError`) · `jobs.service.ts` (enqueue/cancelByUniqueKey/claim/setLease/complete/fail/reapExpired/fixStrandedQueues/pruneTerminal/stats + нудж setNudger) · `jobs.worker.ts` (поллеры per-queue 1с, wake-нуджи, concurrency per-queue 10, дренаж ≤10с) · `jobs.cron.ts` (reaper ежеминутно + фиксап очередей hourly + ретеншн 04:20) · `jobs.controller.ts` (dev-only: stats + dev/enqueue|by-key|cancel|expire-lease|reap) · `jobs.module.ts` (@Global; dev-тип `jobs.dev.echo` maxAttempts 3, backoffBase 500мс).
- Prisma: модель `Job` (`jobs`), миграция `20260719184500_jobs_engine` руками (`migrate dev` в неинтерактивной среде отказывает → SQL по конвенциям Prisma + `migrate deploy`); партиальные индексы claim/reaper/unique-живых/retention; там же drop chatter lease-колонок + пересоздание `chatter_entries_chat_post_pending_idx (id)`.
- shared: `constants/jobs.ts` (`JOB_LIMITS`), `types/jobs.ts`.
- `main.ts`: **`app.enableShutdownHooks()` ВКЛЮЧЁН** (закрыт кусок хвоста блока 7).

## Ключевые механики / GOTCHAS
- **Идемпотентная постановка = INSERT ON CONFLICT DO NOTHING**, НЕ catch P2002: ошибка констрейнта внутри Postgres-транзакции абортит ВСЮ транзакцию постановщика.
- **Клейм = CTE `WITH picked AS (SELECT … FOR UPDATE SKIP LOCKED) UPDATE … RETURNING`** (первый SKIP LOCKED в кодовой базе). attempts++ при клейме = клейм-токен финальных записей — зомби-врайт перехваченного reaper'ом джоба = no-op (доказано verify).
- Аренда: floor 5 мин в клейме → подъём до leaseMs типа.
- **Нудж НЕ ждёт коммита**: setTimeout ~50мс; некоммиченная строка невидима клейму, хвост добирает поллер 1с. LISTEN/NOTIFY не в v1.
- `fixStrandedQueues` (hourly) чинит строки, чей тип переехал в другую очередь между деплоями.
- JobDiscardError → warn БЕЗ события; исчерпание → error-лог + `job.discarded`.
- Обработчик сам ограничивает своё время бюджетом leaseMs (JS не убивает Promise).
- `createManyAndReturn` (Prisma 6) — id пачки для постановки джобов в той же tx.

## Переезды v1 (2026-07-19)
- **Chatter**: джоб `chatter.chatpost` в tx записи (uniqueKey `ce:<id>`); обработчик → sink.post → терминал chatPostedAt; бэкфилл на bootstrap (окно 24ч, скип при существующем джобе — discarded не переигрываем). УДАЛЕНЫ: drainChatPosts/willChatPost/ChatterCron/lease-колонки/7 вызовов scheduleTaskChatDrain + drainTaskChatPosts (и вызов из shop).
- **ScheduledMessage**: джоб `messenger.scheduled.fire`, runAt=sendAt, **uniqueKey с версией времени `sm:<id>:<sendAtMs>`** (перенос = cancel старого ключа + новый; гонка «правка в момент выстрела» — сверка sendAt в обработчике → no-op). Доменный клейм `{in:[pending,'sending']}` ('sending' = наш упавший заход — продолжаем, at-least-once). Permanent → cancelled + JobDiscardError. maxAttempts 8. УДАЛЁН fireDue-крон; выстрел ≤1–2с после срока.
- verify-chatter секции 12–13 и verify-quickactions fire-секция переписаны (инжект строки мимо API + джоб руками = симуляция бэкфилла).

## Волна 1 — уведомления (2026-07-20)
- **`NotificationsService.emitEvent(type, payload, emittedBy)`** = `events.emit` (шина остаётся сигналом остальным листенерам: плашки/google-sync/подстраховки) + джоб `notifications.dispatch` для типов из `MAPPED_EVENT_TYPES`. Замена голого emit на **~40 сайтах 6 сервисов** (contacts 7, tasks 10 вкл. wallet.coins.received, calendar 4 вкл. хелпер notifyParticipants, workspaces 6, staff 2, shop 11 одним replace_all) — каждому сервису инъектирован NotificationsService (@Global). Пара «событие+уведомление» не может разъехаться; для in-tx outbox точечно есть `enqueueForEvent(tx, …)`.
- **`notifications.map.ts`** — чистая карта «событие → цели» (32 типа: contact.* 7, task.* 7, calendar.* 5, workspace.* 7, wallet 1, shop 5), портирована 1:1 из удалённого `NotificationsEventsListener` (вкл. contact.linked с пер-адресатным otherName, скип актора byUserId, actionUrl-правила).
- **`NotificationsDispatch`** регистрирует обработчик: цели → `notify(…, {dedupKey: 'j<jobId>:<userId>:<type>'})`.
- **`Notification.dedupKey`** + `@unique` (миграция `notifications_dedup`; в PG NULL'ы в unique НЕ конфликтуют — partial не нужен, обычный @unique в Prisma-схеме); `notify()` при dedupKey — raw INSERT ON CONFLICT DO NOTHING (возвращает null; id = randomUUID() в JS — raw мимо Prisma-дефолта uuid()). Ретрай после частичного фанаута не дублит (доказано verify: completed-джоб возвращён в available → перегнан attempt 2 → строка одна).
- Прямые `notify()`-вызовы (mentions/finances/office/recorder/scheduled/files-scan/chat-calls/processes) — НЕ трогали (они не через шину и не теряются так, как терялся листенер).
- Уведомления теперь доезжают асинхронно (≤~1–2с, нудж+поллер) — все существующие verify это пережили без правок.

## Волны 2–5 (2026-07-22) — ВСЕ СДЕЛАНЫ И ПРОВЕРЕНЫ
Прогон после ревью: verify-jobs 30/0 · notify-jobs 11/0 · **calendar-reminders ALL PASS (новый)** · files ALL PASS · **files-scan ALL PASS с ЖИВЫМ ClamAV** · voice ALL PASS · call-recording 17/17 · messenger-calls 26/26 · calls · office ✅ · chatter 68/0 · quickactions 20/0 · files-consumers · + 8 широких регрессий (calendar-access, messenger 29/0, messenger-task 19/0, tasks-inbox, order-fulfilment, block-enforcement, b2b-reachability, mentions 18/0). Ноль ERROR в логе, nest build + web tsc чистые.

- **Расширение движка:** `queueConcurrency` (cap — свойство ОЧЕРЕДИ = MIN по её типам ⇒ тяжёлым дают СВОЮ очередь, а не сужают 'default'; валидируется — 0/NaN раньше давали вечно вставшую очередь) + **`onDiscard`-хук**: джоб может умереть ПО АРЕНДЕ, минуя catch обработчика (reaper хоронит чистым SQL), и без хука доменная строка навсегда зависала бы в processing/ingesting/pending.
- **В2 Files:** `files.pipeline` (очередь 'media', cap 3, аренда 15 мин — обработчик ЖДЁТ mediaSemaphore внутри аренды) + `files.scan` (аренда 5 мин — обязательна: дефолт 60с при socket-таймауте clamd 120с = гарантированный двойной скан). Оба ставятся В ТРАНЗАКЦИИ `complete()`/`ingestLocalFile()`. `run()` бросает. Умерли handleVariantRetry/handleScanRetry/retryPending/Redis-лок. `mediaSemaphore` ОСТАВЛЕН (делит с voice, вкл. синхронный `/voice/stt`).
- **В3 Voice:** `voice.transcribe` ('voice', cap 2, аренда 60 мин). Клейм принимает `queued|processing`; **клейм-токен — МОНОТОННЫЙ `attempts` СТРОКИ, не ctx.attempt** (у нового джоба того же файла ctx.attempt снова 1 → зомби затёр бы свежий результат). Колонка `lease_until` дропнута (миграция `voice_jobs`).
- **В4 Calls:** `calls.recording.finalize` **двухрежимный** — снимок egress приносит payload (вебхук/крон) ЛИБО обработчик сам опрашивает LiveKit (бэкфилл). Это не украшение: verify сидит ФЕЙКОВЫЙ egressId, которого в LiveKit нет, и самоопрос на вебхучном пути сломал бы тест. `calls.recording.deliver` — на каждого клейманта; claim-эндпоинт ставит его ВСЕГДА (а не только на ready), иначе клеймант, попавший в окно ready-транзакции, не получал бы запись. `calls.session.summarize` — **ставит core/calls в tx закрытия сессии, обработчик регистрирует МЕССЕНДЖЕР**; `endedById` в payload, т.к. в БД не хранится. Отклонение от плана: «+5мин джоб-страховка на start()» ОТВЕРГНУТА (uniqueKey «первый выигрывает» → вебхук не подтянул бы срок вперёд = +5 мин задержки на КАЖДОЙ записи) — вместо неё слим-ветка в живущем `CallsCron`, которая ставит джоб.
- **В5 Calendar:** `calendar.reminder.fire`, `runAt=fireAt` (секунды вместо окна 5 мин). Клейм `sentAt` И `notifications.enqueueForEvent(tx)` в ОДНОЙ транзакции (fire-and-forget `emitEvent` терял бы уведомление уже ПОСЛЕ клейма). Защита от протухших — В ОБРАБОТЧИКЕ (`REMINDER_MAX_LATENESS_MS` 2ч), а не в выборке: иначе ремонт после простоя высыпал бы залп «через 30 минут» о прошедших встречах. `materializeRemindersFor` перечитывает id после `createMany` (**`createManyAndReturn`+`skipDuplicates` ненадёжен**) + батч-предзапрос живых джобов. Строки и джобы — осознанный dual-write (обернуть ~3750 вставок часовой серии в одну tx = гарантированный таймаут Prisma), поэтому `repairReminderJobs()` зовётся и на старте, и из ежедневного topUp-крона.

## Ревью-хардненинг (6 агентов, 2026-07-22) — что реально ловилось
1. **`ctx.attempt` как токен СТРОКИ** — самая частая ошибка волн. У Calls была P1: `attempts < ctx.attempt` означал, что НОВЫЙ джоб (ctx.attempt=1) никогда не заклеймит запись с attempts≥1 → вечное `ingesting`, горящий индикатор «● Запись», заблокированная новая запись. Правило: **токен должен быть монотонным счётчиком СТРОКИ** (`increment: 1` + read-back), ctx.attempt годится только для решения «последняя ли это попытка».
2. **Бэкфилл, сверяющийся с ЛЮБЫМ джобом** (включая discarded) — «сдались один раз = не чиним никогда». Правило: сверять только с ЖИВЫМИ (`status in available|executing`), а от повторов безнадёжного защищаться ТЕРМИНАЛЬНЫМ ДОМЕННЫМ статусом через `onDiscard`. Бонус: с этим предикатом запрос попадает в partial-unique `jobs_unique_key_live` (без него — seq-scan, а ночной calendar-topUp дёргает его на каждую серию).
3. **`now()` в SQL движка** — колонки `timestamp` БЕЗ таймзоны, Prisma пишет UTC, `now()` даёт timestamptz → при session TimeZone ≠ UTC (реальный KZ-сервер) reaper перезапускал бы ВСЕ идущие джобы каждую минуту. Дремало только потому, что локальный контейнер в UTC. Всё время — параметрами-Date.
4. Прочее закрытое: `setLease` без клейм-токена (укорачивал аренду ЧУЖОГО захода); пустой ответ clamd классифицировался терминально (а это обрыв при MaxQueue = транзиент); ретеншн одним мега-DELETE → батчами; сбой Redis ронял reaper unhandled-rejection'ом; окна ретраев были минуты против десятков минут у убитых кронов.

**Осознанно НЕ чинилось (пре-существующее, вне миграции):** `editSingleOccurrence` не чистит напоминания мастера (дубль напоминания), `splitSeries` не переносит участников, неотправленные напоминания не чистятся ретеншном, `postSummaryPlaque` клеймит `summarizedAt` ДО поста (сбой поста = потерянная плашка), гонка правки времени у `messenger.scheduled.fire`. Записано в ревью-отчётах, ждёт отдельного захода.

## Дорожная карта дальше
Push-доставка (mobile-этап) = новый потребитель, а не 8-я копия. Token-walker Процессов НЕ переезжает. 30 @Cron+withLock остаются (ретеншны/сверки — здоровые кроны). recurring-API движка = v2. Непокрытое тестами (знать при следующем заходе): пер-очередные cap'ы, бэкфиллы всех потребителей, dead-letter новых типов, реальный reaper-переклейм для новых потребителей.
