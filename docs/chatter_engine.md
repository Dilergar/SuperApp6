# core/chatter — движок хроники

> Универсальная лента «кто/что/когда + было → стало» на любой сущности (модель Salesforce Chatter / Odoo mail.thread). Пишется СИНХРОННО в транзакции доменной мутации; хранится вечно (память записи, retention-крона нет осознанно).

## Модель

`ChatterEntry` — полиморфно refType+refId, **FK-free** (хроника переживает сущности), BigInt id = append-log и курсор (в DTO строкой), снапшот `actorName` (переживает удаление аккаунта), `workspaceId` денормализован под журнал, `changes` JSONB `[{field, label, from, to, raw?}]`.

`label` и `from/to` — СНАПШОТЫ на момент записи (фолбэк). `raw` — сырые значения (`{from, to, kind: 'text'|'date'|'datetime'|'number'}`): дата, записанная как «03.09.2026», навсегда останется этим текстом, а ISO-строка рядом переформатируется под язык и пояс читателя. `kind` может зависеть от строки — у срока задачи это «дата» при `allDay` и «дата+время» иначе.

## Контракт

```ts
ChatterService.log(tx, { refType, refId, typeKey, changes?, payload? })   // СИНХРОННО в tx мутации
ChatterService.diffTracked(spec, before, after)   // чистый дифф-хелпер «было → стало»
ChatterService.hasRecent(...)                     // идемпотентность/склейка (по payload-ключу)
ChatterRefRegistry.register(refType, { canView }) // доступ = резолвер потребителя
ChatterRefRegistry.registerChatSink(refType)      // плашки контекстного чата = проекция хроники
```

- Шина для записи НЕ годится: at-most-once + события без old-значений.
- Реестр типов `CHATTER_REGISTRY` (shared) несёт СМЫСЛ: иконку, категорию журнала, флаг `chatPost`. ШАБЛОНЫ живут в каталоге `chatter.type.<typeKey>` (`@superapp/i18n`), рендер — `renderChatter(t, typeKey, entry)`. Текст собирается ПРИ ЧТЕНИИ в языке зрителя, поэтому накопленная за годы хроника переводится вместе с каталогом ([i18n.md](i18n.md)).
- **Плашки чатов производит джоб `chatter.chatpost`** (core/jobs, ставится В ТОЙ ЖЕ tx, что и запись; uniqueKey `ce:<id>`): идемпотентность — терминал `chatPostedAt` + дедуп мессенджера по `payload.chatterEntryId`; родитель удалён → `JobDiscardError` (не 8 попыток с ложным dead-letter), сама запись живёт (FK-free).
- Даты «было → стало» форматируются ДЕТЕРМИНИРОВАННО в `APP_TIMEZONE`; презентация (суффикс филиала) не запекается в payload — строит `renderChatter` из raw-полей.
- DTO несёт И готовый `text` (плоский рендер в языке запроса), И структуру: веб рисует своё (чипы людей поверх `text`), mobile и AI берут готовую строку. Подписи полей — `chatter.fields.<refType>.<field>`, снапшот `label` работает фолбэком для ещё не переведённых типов.

## Потребители (категории журнала)

Задачи (14 typeKeys: жизненный цикл + диффы + состав) · Организации/Сотрудники (`staff.*`, все chatPost:false — HR-события не текут рядовым; оргструктура — `staff.head_set`/`branch_head_set`/`reports_to_set`/`position_moved`/`deputy_opened`/`deputy_closed`/`primary_changed`/`default_branch_changed`) · Документы (`org_document.*`) · Диск · Процессы (`process.published_with_warnings` — принятый риск с поимённым списком правил) · Подпись (идемпотентно по `payload.actId`) · Контрагенты · Кадры (`hr.*`, canView manager+|self через `hr_member`) · share-links (`share.link_*`).

## «Журнал организации»

`GET /workspaces/:id/journal?category=` — сводный B2B-аудит (гейт через canView-резолвер `workspace` = manager+; движок доменную ранг-логику не держит). Веб — переиспользуемый `components/chatter/ChronicleFeed.tsx` (день-группы по локальной дате зрителя; актёр `PersonAvatar`, цель `PersonChip`; чипы «было → стало» внутри предложения). Запись категории без чипа-фильтра видна только в общей ленте — новой категории сразу давать чип.

## API

`GET /chatter/:refType/:refId?cursor&limit` → `{items, nextCursor, actors}` (actors — батч USER_LITE для PersonChip).

## Ловушки

- Одна запись на ЗАХОД правки документа (не на каждое автосохранение) + склейка плашки не чаще раза в час (`hasRecent`) — иначе чат превращается в ленту «правил… правил…».
- FinAuditLog НЕ тронут — отдельный compliance-слой с полными before/after (Salesforce тоже разделяет Feed и Field History).
- `ChatterTrackSpec.raw` НЕ заменяет `format`, а дополняет: старые записи (без `raw`) обязаны читаться, и фолбэк на display-строки — их единственный путь.

## Проверка

`verify-chatter.cjs`, `verify-i18n.cjs` (текст записи и плашки в языке запроса).
