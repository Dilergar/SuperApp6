# Календарь (CalendarModule + GoogleCalendarModule)

> Личный+социальный календарь И «календарь-платформа»: чужие сервисы показывают свои записи на общей сетке одной регистрацией слоя.

## Ядро

- CRUD + **RRULE-повторы** (rrule.js; правка this/this_and_following/all через exDates+override; `recurrenceEndsAt` — материализованный конец серии для фильтров).
- **Напоминания**: несколько на событие/участника (дефолт 24ч+30мин); выстрел — джоб `calendar.reminder.fire` с runAt=fireAt (точность секунды; клейм sentAt + постановка уведомления одной tx).
- **Участники + RSVP** (`EventParticipant`: одно общее событие без копий; приглашение человека/Группы; редактирует только создатель).
- **Шеринг уровнями** none<busy<detailed: группа (`Circle.calendarVisibility` — живой принципал, проецируется в core/access) + персональный (tuples); per-event `visibility` inherit/busy/hidden; резолв = MAX через движок. Просмотр чужих — слои-люди (`include=<userIds>`); Smart Match — свободные окна среди давших ≥busy.
- **Ресурсы + модерируемая бронь** (`Resource`: владелец, capacity, кто бронирует — `bookerUserIds`/`bookerCircleIds` с гейтом): бронь = событие с resourceId; чужая → заявка владельцу, занято (active ≥ capacity) → 409 (capacity-check + запись в одной tx под FOR UPDATE); только разовые события.
- DnD-планнер: перетаскивание задач на сетку (срок) и событий (время) — `PATCH /tasks/:id` и `PATCH /calendar/events/:id`.
- Часовые пояса: UTC → пояс зрителя.

## Реестр слоёв (несущая механика платформы)

Подключение сервиса к сетке = 3 шага, календарь потребителей поимённо НЕ знает:
1. Запись в `CALENDAR_LAYER_REGISTRY` (shared: ярлык/иконка/тон тумблера/`serverDefault`) — из него же строится enum валидации и панель тумблеров веба;
2. Свой `kind` в union `CalendarItem` (поля — надмножество `CalendarLayerItemBase`: kind/id/title/start/end?/allDay?/icon?/color?/href?; НОВЫЙ слой обязан отдавать id);
3. `CalendarLayersRegistry.register(layer, {provide(userId, from, to)})` в onModuleInit СВОЕГО модуля (импортирует CalendarModule, не наоборот).

Слои виртуальные (ничего не копируется); слой без провайдера тихо пропускается; незнакомый kind веб рисует запасным чипом. Значок записи — ДАННЫЕ (Glyph), не хардкод по виду. Опциональный `summary` слоя → чип-сводка в шапке (пример: «Платежи: 45 000 ₸ · после них ≈ 120 000 ₸» — Payday View). Подключены: tasks, finance; следующий кандидат — привычки.

## Google-синхра (GoogleCalendarModule)

OAuth 2.0 + Calendar API (модель Bitrix24/Salesforce, не «чистый CalDAV»). `GoogleConnection` (токены, выбранный календарь, syncToken, канал вебхука). Инкрементальная синхра (events.list + syncToken, 410→полный ресинк); вебхуки channels.watch (прод) + поллинг/кнопка (фолбэк); свои события двусторонне, задачи односторонне; конфликты last-write-wins; удаления зеркалятся; участники не выгружаются. Маппинг `googleEventId` идемпотентен (гасит эхо). Без `GOOGLE_*` модуль инертен. Лимит: пер-экземплярные исключения повторов — на уровне master+EXDATE. ⚠️ Live OAuth не тестирован (нужны креды) — [roadmap.md](roadmap.md).

## API (кратко)

`GET /calendar/events?from&to&layers=&include=` → `{items, layers?}` (незнакомый ключ слоя → 400) · CRUD events (+editScope/occurrenceStart) · participants/rsvp/reminders · shares/shared-with-me/smart-match · `/resources` (+schedule, requests, confirm/reject) · `/integrations/google/*`.

## Веб (`/calendar`)

5 видов (месяц/неделя/день/повестка/год) + мини-месяц + панель-планнер + DnD + модалка дня «+N ещё» (кнопка!); клавиши t/m/w/d/a/y/c/←/→ — сверяются И `e.code`, И `e.key` (русская раскладка даёт `key='ь'`, экранные клавиатуры не заполняют code); память слоёв в localStorage (читать только в useEffect); месяц схлопывает 2+ платежа дня в агрегат.

## Проверка

`verify-calendar-access.cjs`, `verify-calendar-layers.cjs`, `verify-calendar-reminders.cjs`.
