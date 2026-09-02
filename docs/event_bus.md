# EventBus — шина событий

> `apps/api/src/shared/events/event-bus.service.ts`: Redis Streams + consumer group; `emit(type, payload, emittedBy)`, подписка `on('<type>')` / `onPattern('<prefix>.*')` (RxJS Observable). **Семантика at-most-once**: ack до выполнения обработчика, `XAUTOCLAIM` подбирает зависшие, `MAXLEN 100k`. Emit НЕ транзакционен с БД (dual-write). Синхронные рёбра модулей — [module_graph.md](module_graph.md).

## Правила

- **На шину — только то, что можно потерять**: плашки-листенеры, подстраховки-сверки, google-sync, сигналы сокету, вторые ремни. Деньги, security-эффекты (отзыв доступа) и обязательная фоновая работа — НЕ сюда: синхронно в транзакции либо `core/jobs` (`enqueue(tx, …)`, transactional outbox, at-least-once) — [jobs_engine.md](jobs_engine.md).
- Второй ремень к синхронному пути — законная роль шины: `FinancesEvents` на `contact.removed/blocked` дублирует хук `PersonalGraphRegistry`; `ShopEvents` на `task.completed` дублирует токен `ShopService`; `ProcessesEvents` на `task.*` дублирует токен `ProcessesService`.
- Уведомления людям — только `NotificationsService.emitEvent(type, …)`: он публикует событие на шину И ставит джоб доставки; голый `events.emit` для уведомлений запрещён — [notifications.md](notifications.md). Типы таких событий = `NOTIFICATION_REGISTRY` (shared).
- Сбой Redis best-effort: подписчик не превращает ошибку в unhandled rejection и не останавливает фоновую работу ([platform_gotchas.md](platform_gotchas.md)).
- Подписчик обязан быть идемпотентным: событие может прийти после того, как синхронный путь уже всё сделал, а может не прийти вовсе.

## Каталог событий (кто эмитит → темы)

| Подсистема | Темы |
|---|---|
| Auth (`core/auth`, `core/users`) | `auth.sessions.revoked` — logout / смена пароля / отзыв сессии: гасит сокеты |
| Окружение (`modules/contacts`) | `contact.removed`, `contact.blocked` |
| Задачи (`modules/tasks`) | `task.completed`, `task.deleted`, `task.cancelled` (+ типы уведомлений через `emitEvent`) |
| Календарь (`modules/calendar`) | `calendar.event.created / updated / cancelled / invited / rsvp / participant_removed / reminder` |
| Мессенджер (`modules/messenger`) | `messenger.message.created / updated / deleted`, `messenger.receipt`, `messenger.presence.changed`, `messenger.call.state`, `messenger.scheduled.sent` |
| Магазин (`modules/shop`) | `shop.order.placed / funded / confirmed / cancelled / rejected` |
| Файлы (`core/files`) | `file.uploaded`, `file.ready`, `file.variant.created`, `file.deleted`, `file.scan.infected` |
| Звонки (`core/calls`) | `call.session.started`, `call.participant.joined / left`, `call.recording.started / stopped / ready / failed` |
| Голос (`core/voice`) | `voice.transcript.ready / failed` |
| Документы (`core/docs`) | `docs.document.created` |
| Офис (`modules/office`) | `office.room.created / invited / ended` |
| Google (`modules/google-calendar`) | `google.push` — вебхук → инкрементальный синк |
| Джобы (`core/jobs`) | `job.discarded` — dead-letter; подписчиков нет (прод-наблюдаемость — [roadmap.md](roadmap.md)) |

Точный список в любой момент: `grep -rn "events.emit(" apps/api/src`; события `emitEvent` берут тип из `NOTIFICATION_REGISTRY`.

## Подписчики

| Подписчик | Слушает | Делает |
|---|---|---|
| `apps/api/src/modules/messenger/messenger.gateway.ts` | `messenger.*`, `auth.sessions.revoked` | Сокет: доставка в комнаты, отключение отозванных сессий |
| `apps/api/src/modules/messenger/calendar-system.listener.ts` | `calendar.event.*` | Системные плашки в чатах событий |
| `apps/api/src/modules/messenger/chat-calls.listener.ts` | `call.session.*`, `call.participant.*`, `call.recording.*` (фильтр `refType === 'chat'`) | `call:state` в сокет + плашки итогов звонка |
| `apps/api/src/modules/messenger/office-system.listener.ts` | `office.room.*`, `call.session.*` | Плашки встреч офиса |
| `apps/api/src/modules/messenger/order-system.listener.ts` | `shop.order.*` | Плашки заказов в чатах |
| `apps/api/src/modules/messenger/docs-system.listener.ts` | `docs.document.*` | Плашка «файл оживлён в документ» в чате места |
| `apps/api/src/modules/finances/finances.events.ts` | `contact.removed`, `contact.blocked` | Второй ремень отзыва finbook-грантов |
| `apps/api/src/modules/shop/shop.events.ts` | `task.*` → `task.completed` | Второй ремень `onFulfillmentDone` |
| `apps/api/src/modules/processes/processes.events.ts` | `task.completed`, `task.cancelled`, `task.deleted` | Подстраховка `onTaskCompleted / Cancelled / Deleted` шага-задачи |
| `apps/api/src/modules/processes/process-triggers.service.ts` | динамически — темы из каталога триггеров опубликованных процессов | Запуск экземпляра процесса по событию |
| `apps/api/src/modules/recorder/recorder.events.ts` | `voice.transcript.*` | Уведомление о готовой расшифровке |
| `apps/api/src/modules/google-calendar/google.events.ts` | `google.push` | Инкрементальный синк календаря |

## Ловушки

- `onPattern('call.session.*')` слушают ДВА листенера мессенджера (звонки чатов и офис) — фильтр по `refType` обязателен в каждом, иначе плашка задвоится.
- Emit до коммита `$transaction` — подписчик читает БД раньше коммита; эмитить после транзакции либо перечитывать с допуском «ещё нет».
- Новая тема = строка в каталоге, новый подписчик = строка в таблице: без этого следующий разработчик не найдёт, кто реагирует на событие.

## Связанные доки

[module_graph.md](module_graph.md) · [jobs_engine.md](jobs_engine.md) · [notifications.md](notifications.md) · [platform_gotchas.md](platform_gotchas.md)
