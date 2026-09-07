# core/realtime — движок realtime (18-й)

> ОДИН сокет платформы: socket.io namespace `/realtime`, handshake-авторизация с паритетом HTTP (подпись + срок + отзыв сессии + удалённый аккаунт через `SessionValidatorService.verifyAccessToken`), личные комнаты `user:<id>`, Redis-адаптер (`apps/api/src/redis-io.adapter.ts` — рассылка в комнаты доходит до всех инстансов), разрыв при `auth.sessions.revoked`. Что слать и что принимать — знают фичи через реестр; движок фичи не импортирует.

Код: `apps/api/src/core/realtime/` (`realtime.gateway.ts`, `realtime.registry.ts`, `realtime.service.ts`, `realtime.module.ts`). Формы событий — `packages/shared/src/types/realtime.ts` (`RealtimeServerToClientEvents = Messenger… & Notification…`, `RealtimeClientToServerEvents`) — ими типизированы И gateway (`Server<C2S, S2C>`), И клиентский синглтон. Клиент — `apps/web/src/lib/realtime/useRealtime.ts` (один коннект на вкладку, `auth` как функция — свежий токен на каждый reconnect, heartbeat с visibility-гейтом, `onReconnect`); `useMessengerSocket` — тонкая обёртка с прежним API.

## Реестр

```ts
RealtimeRegistry.registerRelay(busPattern, map: ({type, payload}) => RelayEmit | RelayEmit[] | null)  // событие шины → {rooms, name, payload}
RealtimeRegistry.registerHandler(clientEvent, { handler(ctx: {socket, userId}, data), rateLimit?: {limit, windowMs} })
RealtimeRegistry.registerConnectionHook({ onConnect?, onDisconnect? })
RealtimeService.emitToUsers(userIds, name, payload) / emitToRooms(rooms, name, payload)
```

Подписки на шину гейтвей открывает в `onApplicationBootstrap` (регистрации фич идут в их `onModuleInit`). Клиентские события ловятся `socket.onAny` и роутятся по реестру; пер-сокетный token-bucket (`rateLimit`) — WS минует HTTP-троттлер.

## Кто зарегистрирован

| Кто | Relay (шина → сокет) | Хендлеры (клиент → сервер) | Хуки |
|---|---|---|---|
| Мессенджер (`modules/messenger/messenger-realtime.provider.ts`) | `messenger.*` → `message:new|updated|deleted`, `receipt`, `call:state` (в комнаты `memberUserIds`), `presence:changed` (в `audienceIds`) | `message:delivered`, `message:read` (120/мин), `heartbeat` (12/мин), `typing:start|stop` (60/мин; `socket.to(...)` — мимо печатающего) | presence `onConnect/onDisconnect` + фанаут изменения |
| Уведомления (`core/notifications/notifications-realtime.provider.ts`) | `notifications.created` → `notification:new` каждому адресату (свой notificationId/контекст); `notifications.counts` → `notification:counts` | — | — |

## Несущие правила

- На шину — только то, что можно потерять: relay — at-most-once, клиент перечитывает `counts`/голову ленты/чаты на `onReconnect`.
- Один клиентский синглтон на вкладку: несколько подписчиков (мессенджер, уведомления, звонки) делят соединение; последний размонтированный подписчик или логаут гасят его.
- ЕДИНСТВЕННЫЙ каст канала — в `emitRaw` гейтвея; формы enforced на emit-САЙТАХ фич (литералы объявлены `Ws*`-типами).
- Сбой хука соединения (presence мессенджера ходит в Redis) ловится ПО-ХУКУ: рвать из-за него сокет значило бы оставить человека и без ленты сообщений, и без уведомлений.
- Origin'ы — общий список с HTTP-CORS и `frame-ancestors` (`shared/config/web-origins.ts`), и берутся ФУНКЦИЕЙ: декоратор gateway вычисляется при импорте файла, массив зафиксировал бы только адреса разработки, без `WEB_URL`.
- Сокет авторизуется только на рукопожатии → отзыв сессии рвёт живые сокеты (`disconnectSockets` уходит через Redis-адаптер на все инстансы), а повторное рукопожатие отозванным токеном отбивается `tokenEpoch`.

## Проверка

`verify-messenger-socket.cjs` (доставка, квитанции, отказ плохому токену) · `verify-messenger-presence.cjs` · `verify-logout-socket.cjs` (разрыв при logout-all, отказ отозванному токену, свежий токен подключается) · `verify-realtime.cjs` (`notification:new` приходит адресату и не актору, `notification:counts` после seen, `message:new` мессенджера тем же сокетом) · seen в одной вкладке гасит бейдж в другой — браузерная проверка ([notifications_engine.md](notifications_engine.md)).

## Связанные доки

[messenger.md](messenger.md) · [notifications_engine.md](notifications_engine.md) · [event_bus.md](event_bus.md) · [security.md](security.md) · [contract_boundary.md](contract_boundary.md)
