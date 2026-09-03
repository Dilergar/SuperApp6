# Уведомления (NotificationsModule)

> Cross-cutting лента уведомлений всех сервисов (@Global). Generic-строка `Notification` (userId, type, title, body, payload, actionUrl, readAt, dedupKey).

## Реестр и доставка

- Типы — dot-namespaced (`contact.invitation.received`, `task.assigned`…), реестр `NOTIFICATION_REGISTRY` (shared) с шаблонами title/body/icon и флагом pushByDefault (push-доставки пока НЕТ — mobile-этап).
- **Два пути создания**:
  1. **`NotificationsService.emitEvent(type, payload, emittedBy)`** — доменное событие: уходит на шину (сигнал другим листенерам) И ставит джоб **`notifications.dispatch`** (core/jobs), который надёжно (at-least-once) создаёт строки по карте **`notifications.map.ts`** («кому что» — в одном месте; ~32 типа событий, чистая функция). Эмиттеры: contacts, tasks, calendar, workspaces, staff (в т.ч. оргструктура: `staff.head.assigned` держателям руководящей должности, `staff.deputy.assigned` заму — адресаты списком `payload.userIds`), shop (~40 сайтов). Постановка джоба ЖДЁТСЯ (`await`) — потеря уведомления на SIGTERM недопустима.
  2. **Прямой `notify(userId, type, payload, {actionUrl?, dedupKey?})`** — когда адресат известен вызывающему: mentions, finances, office, recorder, scheduled, files-scan, drive, share-links, hr. Прямой notify на критическом пути — без await (упавшая лента не роняет действие).
- **Идемпотентность** at-least-once — `dedupKey` (`j<jobId>:<userId>:<type>`) + unique (ON CONFLICT DO NOTHING): ретрай после частичного фанаута не дублит строки.
- Правило нового сервиса: тип в реестр + ветка в карту; слать `emitEvent`, НЕ голым `events.emit`.

## API

`GET /notifications` (cursor, unreadCount) · `POST /notifications/mark-read` (массив id или пусто = все) · `DELETE /notifications/:id`. Ретеншн — крон (батчами по индексу).

## actionUrl = будущий deep link

Мобильные роуты будут зеркалить веб-пути — `actionUrl` работает как deep link. Адрес обязан вести на СУЩЕСТВУЮЩУЮ страницу (уведомления в 404 — прецедент был; адреса собирать общими хелперами shared, напр. `approvalHref`).

## Веб

Колокольчик топбара — сквозной (без скоупа контекста). Центра уведомлений на вебе пока НЕТ — критичные предупреждения дублируются видимым местом (пример: жирная строка архива организации).

## Проверка

`verify-notify-jobs.cjs` + сьюты эмиттеров.
