# core/chatter — движок хроники

> Универсальная лента «кто/что/когда + было → стало» на любой сущности (модель Salesforce Chatter / Odoo mail.thread). Пишется СИНХРОННО в транзакции доменной мутации; хранится вечно (память записи, retention-крона нет осознанно).

## Модель

`ChatterEntry` — полиморфно refType+refId, **FK-free** (хроника переживает сущности), BigInt id = append-log и курсор (в DTO строкой), снапшот `actorName` (переживает удаление аккаунта), `workspaceId` денормализован под журнал, `changes` JSONB `[{field, label, from, to}]` display-ready.

## Контракт

```ts
ChatterService.log(tx, { refType, refId, typeKey, changes?, payload? })   // СИНХРОННО в tx мутации
ChatterService.diffTracked(spec, before, after)   // чистый дифф-хелпер «было → стало»
ChatterService.hasRecent(...)                     // идемпотентность/склейка (по payload-ключу)
ChatterRefRegistry.register(refType, { canView }) // доступ = резолвер потребителя
ChatterRefRegistry.registerChatSink(refType)      // плашки контекстного чата = проекция хроники
```

- Шина для записи НЕ годится: at-most-once + события без old-значений.
- Реестр типов `CHATTER_REGISTRY` (shared) несёт `chatPost`-флаг + шаблоны; `renderChatterText` (поверх общего `interpolateTemplate`) — ЕДИНЫЙ рендер для API-плашки и веб-журнала.
- **Плашки чатов производит джоб `chatter.chatpost`** (core/jobs, ставится В ТОЙ ЖЕ tx, что и запись; uniqueKey `ce:<id>`): идемпотентность — терминал `chatPostedAt` + дедуп мессенджера по `payload.chatterEntryId`; родитель удалён → `JobDiscardError` (не 8 попыток с ложным dead-letter), сама запись живёт (FK-free).
- Даты «было → стало» форматируются ДЕТЕРМИНИРОВАННО в `APP_TIMEZONE`; презентация (суффикс филиала) не запекается в payload — строит `renderChatterText` из raw-полей.

## Потребители (категории журнала)

Задачи (14 typeKeys: жизненный цикл + диффы + состав) · Организации/Сотрудники (`staff.*`, все chatPost:false — HR-события не текут рядовым) · Документы (`org_document.*`) · Диск · Процессы (`process.published_with_warnings` — принятый риск с поимённым списком правил) · Подпись (идемпотентно по `payload.actId`) · Контрагенты · Кадры (`hr.*`, canView manager+|self через `hr_member`) · share-links (`share.link_*`).

## «Журнал организации»

`GET /workspaces/:id/journal?category=` — сводный B2B-аудит (гейт через canView-резолвер `workspace` = manager+; движок доменную ранг-логику не держит). Веб — переиспользуемый `components/chatter/ChronicleFeed.tsx` (день-группы по локальной дате зрителя; актёр `PersonAvatar`, цель `PersonChip`; чипы «было → стало» внутри предложения). Запись категории без чипа-фильтра видна только в общей ленте — новой категории сразу давать чип.

## API

`GET /chatter/:refType/:refId?cursor&limit` → `{items, nextCursor, actors}` (actors — батч USER_LITE для PersonChip).

## Ловушки

- Одна запись на ЗАХОД правки документа (не на каждое автосохранение) + склейка плашки не чаще раза в час (`hasRecent`) — иначе чат превращается в ленту «правил… правил…».
- FinAuditLog НЕ тронут — отдельный compliance-слой с полными before/after (Salesforce тоже разделяет Feed и Field History).

## Проверка

`verify-chatter.cjs`.
