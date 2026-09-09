# Виртуальный офис (OfficeModule, B2B)

> B2B-видеовстречи (v1 — аналог Google Meet), первый потребитель core/calls. Path-based изоляция (паттерн staff): вся команда trainee+ (Подрядчик изолирован).

## Модель

- **`OfficeRoom`** — встреча-ссылка ≠ созвон-сессия: `room_finished` закрывает СОЗВОН, встреча живёт (новый вход = новая сессия) до «Завершить» (host ∥ manager+) или `OfficeCron` (4ч без созвона). Создание мгновенное (создатель = host в `OfficeRoomParticipant`).
- Приглашения — только члены ws (чужаки/Подрядчик молча отсеяны) + уведомление с actionUrl.
- Вход в звонок — генерик движка: `POST /calls/token {refType:'office_room', refId}`; резолвер: canJoin = команда trainee+, canModerate = host ∥ manager+, `onJoinAuthorized` — синхронная материализация участника.
- **Чат встречи = контекстный чат мессенджера** (`parentType='office_room'`; переживает завершение — дом будущих транскрипций/протоколов); usersets `chat#member@office_room#host|participant`; `OfficeSystemListener` — плашки (создана/приглашены/завершена/звонок; пер-участник плашек НЕТ осознанно).
- **Имя по умолчанию** («Meeting ДД.ММ ЧЧ:ММ») ложится в БД в языке ИСТОЧНИКА, а зрителю отдаётся ПЕРЕРИСОВАННЫМ (`OfficeService.displayName` сравнивает с автоименем той же минуты — приём `DriveService.displayName`). Своё имя человека не трогается. Заголовок ЧАТА встречи — обычный снимок контекстного чата (как у задачи) и при смене языка не меняется.
- Rich card `office_room` (живой счёт «Идёт сейчас · N», href = присоединиться); access-тип office_room {host, participant, viewer} + diff-проекция.
- Carve-out: офис читает `call_sessions`/`call_session_participants` напрямую (живой блок «Идут сейчас»).

## API

`GET /workspaces/:id/office` (активные + live-стек аватаров; поллинг) · `GET /history` (cursor) · `POST /rooms` · `GET /rooms/:roomId` · `POST /rooms/:roomId/invite|end`.

## Веб

`/workspaces/[id]/office`: список «Идут сейчас» + История; `[roomId]` — prejoin → грид тайлов/screenshare + панель Участники|Чат (кит движка `components/calls/`); завершённая встреча = заголовок + живой чат; dynamic ssr:false.

Неймспейсы: `office` и `calls` кладёт область организации, а комната встречи — единственное место вне мессенджера со встроенным `Conversation`, поэтому у неё свой `layout.tsx` с `['office','calls','messenger','circles']` (вложенный провайдер ЗАМЕНЯЕТ сообщения, а не дополняет их).

## Дальше

Ф2 Discord-режим (постоянные комнаты kind='channel' — зарезервирован, live-присутствие, stage-права) · Ф3 транскрипт встречи → протокол.

## Проверка

`verify-office.cjs`, `verify-office-fire-revoke.cjs`.
