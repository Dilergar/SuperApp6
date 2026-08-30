# Мессенджер (MessengerModule)

> Сквозная коммуникационная шина экосистемы: DM / группы / КОНТЕКСТНЫЕ чаты (задача/заказ/событие/встреча) + Rich Cards + presence + упоминания + звонки. Server-readable (не E2E). Дизайн — Serena `messenger_module`.

## Модель

- Единый `Chat` (dm|group|context; `workspaceId` для B2B; per-chat `seq` через `Chat.lastSeq`; одна DM-пара = `dmKey`).
- **Доступ — core/access тип `chat`**: DM+группы = прямые tuples `chat#member@user`; контекстные = usersets `chat#member@<task|order|event|office_room>#<role>` → роли сущности = источник истины, снятие = мгновенный **Hard Revoke**. Роли проецируются СИНХРОННО при доменной мутации; EventBus-листенер — идемпотентная подстраховка. Пообъектная ACL-эпоха chat (см. [access_engine.md](access_engine.md)).
- «Прочитано» — указатели `deliveredSeq`/`lastReadSeq` в ChatMember; галочки только в DM. Системные сообщения (`type='system'`, authorId=null) не в непрочитанном.
- Realtime — socket.io (namespace `/messenger`, JWT + tokenEpoch на рукопожатии, комната `user:<id>`, Redis-adapter). WS-типы — в shared, карты событий типизируют gateway И клиентский хук ([contract_boundary.md](contract_boundary.md)).
- Создание чата — АТОМАРНО (чат+tuples+member в одной $transaction; иначе cold-start 403).

## Возможности

- **Вложения** — тип `attachment` (payload `{kind:'attachments', files[]}`, до 10 файлов профилем chat_attachment); файлы линкуются в транзакции сообщения; удаление сообщения снимает связи + осиротевшие файлы автора soft-delete (Telegram-модель). Вложения рендерятся из серверного обогащения `files[].view` (Slack-модель, без N+1).
- **Голосовые** — [voice_engine.md](voice_engine.md): кнопка 🎤 → upload voice_message → attachment-путь; `VoiceMessageBubble` (волна, скорость, «Расшифровать»).
- **Rich Cards** — [rich_cards.md](rich_cards.md): скрепка 📎 (задачи/события/лоты) + «Переслать в чат».
- **Presence**: online/lastSeen (Redis + heartbeat, батч MGET), «печатает…», контекстный статус «На <событие> до HH:MM» (наследует уровень доступа календаря зрителя); приватность `onlineStatusMode` + взаимность; зелёная точка только в DM.
- **Mentions Hub**: @-пикер по имени → токен `@[Имя](userId)` (парсер в shared); security-фильтр «только активные участники чата» (форж чужого id игнорируется); отдельная таблица Mention (`@@unique([messageId, mentionedUserId])` — правка не дублит); лента `/mentions` + бейдж (`GET /mentions/unread-count`).
- **Поиск** — провайдеры message/chat/person в core/search (обрезка по правам в SQL: активный член + `seq>=visibleFromSeq`).
- **Быстрые действия и отложенные** — [quick_actions.md](quick_actions.md); цитата `replyToId` (только из этого чата); отложенные — джоб `messenger.scheduled.fire` (uniqueKey с версией времени; memberIds до транзакции — throwable-шаг после коммита давал до 8 копий).
- **Звонки в чатах** (refType='chat', [calls_engine.md](calls_engine.md)): DM — полноценный дозвон WhatsApp-модели (глобальный `CallsWatcher` в providers: модалка + WebAudio-рингтон на любой странице; ринг-условие: active ∧ участники непусты ∧ меня нет ∧ не я звоню; caller-таймер 45с → «Пропущенный»); группы/контекстные — баннер «Идёт звонок · N» (Telegram); чаты офис-встреч исключены. `call:state` — единый идемпотентный снимок (socket + поллинг `/messenger/calls/active` раз в 12с как страховка at-most-once шины; выборка active идёт ОТ ЧЛЕНСТВА пользователя — пустой ответ = один индексный запрос; снимок кэшируется в Redis 15с). Плашки ТОЛЬКО по завершении («Звонок · N» / «Пропущенный»; идемпотентность `CallSession.summarizedAt` — движковый джоб `calls.session.summarize`, обработчик регистрирует мессенджер; `endedById` не получает «Пропущенный»; длительность = endedAt−firstJoinedAt). Запись → «Журнал звонков» Диктофона.

## Виртуализация ленты (`MessageList.tsx`, react-virtuoso)

В DOM только видимые строки (Telegram-модель). Несущая механика: `firstItemIndex` уменьшается РОВНО на число доклеенных сверху (индекс и данные одним коммитом); засов на `startReached` при монтировании (иначе тянет ВСЮ историю); прижим к низу `followOutput` только когда человек внизу + гашение на 1.2с после перехода к сообщению (`jumpUntilRef`); переход к сообщению — `scrollToIndex` по индексу в массиве (getElementById не годится); отступы на строке; короткая переписка прижата к НИЗУ (`alignToBottom`); подсветка перехода — тень на пузыре (не padding — перемер дёргал бы ленту). Ctrl+F браузера видит только видимые — цена принята (как Telegram Web).

## API (кратко)

`GET /messenger/chats` · dm/group CRUD + members/admins/leave · контекстные get-or-create: `GET /messenger/tasks|orders|events|office-rooms/:id/chat` · `GET/POST …/messages?before=<seq>` · PATCH/DELETE message · `POST …/read` · `GET /messenger/presence?userIds=` · mentions (mentionable, лента, mark-read) · `GET /search…` · quick-actions · scheduled CRUD · `GET /messenger/calls/active`. WS: `message:new|updated|deleted`, `receipt`, `presence:changed`, `typing`, `call:state`; клиент: `message:delivered|read`, `heartbeat`, `typing:start|stop`.

## Ловушки

- `listChats` — unread одним range-SQL; без include всех участников.
- WS: clamp `seq ≤ chat.lastSeq` + пер-сокетный token-bucket.
- ОДИН socket-коннект на вкладку (синглтон); heartbeat паузится на скрытой вкладке.
- `hasMore` дип-линка: история вверх догружается и в чате, открытом по прямой ссылке (сбрасывать не только по клику в списке чатов).

## Проверка

`verify-messenger.cjs`, `-group`, `-socket`, `-task`, `-presence`(в mentions), `verify-mentions.cjs`, `verify-search.cjs`, `verify-quickactions.cjs`, `verify-messenger-calls.cjs`, `verify-call-recording.cjs`, `verify-richcards.cjs`.
