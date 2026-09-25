# Мессенджер (MessengerModule)

> Сквозная коммуникационная шина экосистемы: DM / группы / КОНТЕКСТНЫЕ чаты (задача/заказ/событие/встреча) + Rich Cards + presence + упоминания + звонки. Server-readable (не E2E). Дизайн — Serena `messenger_module`.

## Модель

- Единый `Chat` (dm|group|context; `workspaceId` для B2B; per-chat `seq` через `Chat.lastSeq`; одна DM-пара = `dmKey`). **`workspaceId` ставится при создании** контекстного чата: задачи — организация задачи, заказа — организация-владелец магазина лота, встречи офиса — её организация (событие календаря — личное): от него зависят Диск для вложений (`chat_message` → Диск организации, DM — всегда личный), организация звонка и проекции поиска, каскад удаления организации (шаг `messenger.workspace-chats`: `purgeChat` — сообщения пачками, права, строка, индекс). Переписка организации старше выбранного ею срока — шаг `messenger.retention` раннера сроков core/lifecycle; сообщения, стёртые любым путём, уносят свои проекции поиска и вложения loose FK.
- **Окончательное удаление чата — одна дверь `purgeChat`** (группа, контекстные чаты задачи/заказа/события/встречи, каскад организации, стирание человека): под заморозкой (сам чат, организация, хранитель автора, запись или класс сообщений) чат не трогается — `'held'` (удаление группы → `409 lifecycle.held`); иначе сообщения пачками под общим замком с привязками своих вложений, строка чата последней с повторной проверкой, права и индекс — после строки. **Правка и удаление сообщения под заморозкой не блокируются**: оригинал уходит в hold store той же транзакцией. Удалённое сообщение — томбстоун: `content` и `payload` NULL (ни текста, ни имени/размера файла); удалённая рич-карточка рисуется пузырём «сообщение удалено».
- **Стирание человека** (шаг `messenger.subject`, [lifecycle_erasure.md](lifecycle_erasure.md)): по выбору в мастере — все его сообщения томбстоунами; личный чат остаётся собеседнику (строка участника — ссылка на томбстоун), а когда стёрты ВСЕ собеседники (или это «Избранное» с самим собой) — удаляется целиком; группа — выход с плашкой (владение — старейшему админу, иначе участнику, без наследника — удаление); контекстный чат — выход без плашки.
- **Доступ — core/access тип `chat`**: DM+группы = прямые tuples `chat#member@user`; контекстные = usersets `chat#member@<task|order|event|office_room>#<role>` → роли сущности = источник истины, снятие = мгновенный **Hard Revoke**. Роли проецируются СИНХРОННО при доменной мутации; EventBus-листенер — идемпотентная подстраховка. Пообъектная ACL-эпоха chat (см. [access_engine.md](access_engine.md)).
- «Прочитано» — указатели `deliveredSeq`/`lastReadSeq` в ChatMember; галочки только в DM. Системные сообщения (`type='system'`, authorId=null) не в непрочитанном.
- Realtime — общий сокет платформы `core/realtime` (namespace `/realtime`, JWT + tokenEpoch на рукопожатии, комната `user:<id>`, Redis-adapter): мессенджер регистрирует relay `messenger.*`, хендлеры delivered/read/heartbeat/typing и presence-хук (`messenger-realtime.provider.ts`); своего gateway нет — [realtime_engine.md](realtime_engine.md). WS-типы — в shared, карты событий типизируют gateway И клиентский хук ([contract_boundary.md](contract_boundary.md)).
- Создание чата — АТОМАРНО (чат+tuples+member в одной $transaction; иначе cold-start 403).

## Возможности

- **Вложения** — тип `attachment` (payload `{kind:'attachments', files[]}`, до 10 файлов профилем chat_attachment); файлы линкуются в транзакции сообщения; удаление сообщения снимает связи + осиротевшие файлы автора soft-delete (Telegram-модель). Вложения рендерятся из серверного обогащения `files[].view` (Slack-модель, без N+1).
- **Голосовые** — [voice_engine.md](voice_engine.md): кнопка 🎤 → upload voice_message → attachment-путь; `VoiceMessageBubble` (волна, скорость, «Расшифровать»).
- **Rich Cards** — [rich_cards.md](rich_cards.md): скрепка 📎 (задачи/события/лоты) + «Переслать в чат».
- **Presence**: online/lastSeen (Redis + heartbeat, батч MGET), «печатает…», контекстный статус «На <событие> до HH:MM» (наследует уровень доступа календаря зрителя); кто видит «был в сети» — поле `presence` карточки человека (`core/visibility`, `user.card`): точно / корзиной («недавно», «на этой неделе»…) / никак, по личным правилам человека + взаимность ([visibility_engine.md](visibility_engine.md)); зелёная точка только в DM.
- **Упоминания**: @-пикер по имени → токен `@[Имя](userId)` (парсер в shared); security-фильтр «только активные участники чата» (форж чужого id игнорируется). Отдельной модели нет: упоминание = уведомление `mention.received` движка (`reason: 'mention'`, `ref: chat_message`, `idempotencyKey mention:<messageId>:<userId>` — правка не дублит); вкладка «Упоминания» центра = `GET /notifications?mentions=1`, mute объекта его не глушит. Источники не из чата — `MentionsService.recordMentions({sourceType, sourceId, mentionedUserIds, snippet, actionUrl, workspaceId?})`: вызывающий САМ фильтрует адресатов по праву видеть источник (Заметки — `note`; `recordedMentionees` — по ключам идемпотентности событий).
- **Поиск** — провайдеры message/chat/person в core/search (обрезка по правам в SQL: активный член + `seq>=visibleFromSeq`).
- **Быстрые действия и отложенные** — [quick_actions.md](quick_actions.md); цитата `replyToId` (только из этого чата); отложенные — джоб `messenger.scheduled.fire` (uniqueKey с версией времени; memberIds до транзакции — throwable-шаг после коммита давал до 8 копий).
- **Звонки в чатах** (refType='chat', [calls_engine.md](calls_engine.md)): DM — полноценный дозвон WhatsApp-модели (глобальный `CallsWatcher` в providers: модалка + WebAudio-рингтон на любой странице; ринг-условие: active ∧ участники непусты ∧ меня нет ∧ не я звоню; caller-таймер 45с → «Пропущенный»); группы/контекстные — баннер «Идёт звонок · N» (Telegram); чаты офис-встреч исключены. `call:state` — единый идемпотентный снимок (socket + поллинг `/messenger/calls/active` раз в 12с как страховка at-most-once шины; выборка active идёт ОТ ЧЛЕНСТВА пользователя — пустой ответ = один индексный запрос; снимок кэшируется в Redis 15с). Плашки ТОЛЬКО по завершении («Звонок · N» / «Пропущенный»; идемпотентность `CallSession.summarizedAt` — движковый джоб `calls.session.summarize`, обработчик регистрирует мессенджер; `endedById` не получает «Пропущенный»; длительность = endedAt−firstJoinedAt). Запись → «Журнал звонков» Диктофона.

## Виртуализация ленты (`MessageList.tsx`, react-virtuoso)

В DOM только видимые строки (Telegram-модель). Несущая механика: `firstItemIndex` уменьшается РОВНО на число доклеенных сверху (индекс и данные одним коммитом); засов на `startReached` при монтировании (иначе тянет ВСЮ историю); прижим к низу `followOutput` только когда человек внизу + гашение на 1.2с после перехода к сообщению (`jumpUntilRef`); переход к сообщению — `scrollToIndex` по индексу в массиве (getElementById не годится); отступы на строке; короткая переписка прижата к НИЗУ (`alignToBottom`); подсветка перехода — тень на пузыре (не padding — перемер дёргал бы ленту). Ctrl+F браузера видит только видимые — цена принята (как Telegram Web).

## API (кратко)

`GET /messenger/chats` · dm/group CRUD + members/admins/leave · контекстные get-or-create: `GET /messenger/tasks|orders|events|office-rooms/:id/chat` · `GET/POST …/messages?before=<seq>` · PATCH/DELETE message · `POST …/read` · `GET /messenger/presence?userIds=` · `GET /messenger/chats/:id/mentionable` · `GET /search…` · quick-actions · scheduled CRUD · `GET /messenger/calls/active`. WS (`/realtime`): `message:new|updated|deleted`, `receipt`, `presence:changed`, `typing`, `call:state`; клиент: `message:delivered|read`, `heartbeat`, `typing:start|stop`. Канал `chat` уведомлений — системное сообщение `eventType: 'notification'` (перерисовывается `systemText` через `NotificationsRenderer`) либо рич-карта от актора.

## Ловушки

- `listChats` — unread одним range-SQL; без include всех участников.
- WS: clamp `seq ≤ chat.lastSeq` + пер-сокетный token-bucket.
- ОДИН socket-коннект на вкладку (синглтон); heartbeat паузится на скрытой вкладке.
- `hasMore` дип-линка: история вверх догружается и в чате, открытом по прямой ссылке (сбрасывать не только по клику в списке чатов).
- **Системные плашки — проекция хроники, и они переводятся при чтении.** В `payload` едут ДВЕ вещи: `text` — снимок в языке-ИСТОЧНИКЕ (фолбэк для клиента без каталога) и `chatter` — структура записи. Лента (`MessengerService.systemText`) собирает `payload.text` заново в языке запроса — одна точка на выдачу сообщений, превью цитаты и превью чата. `content` системного сообщения остаётся `null` (поиск индексирует только `text`/`attachment`).
- **Плашку сервиса (офис, звонки, офисный документ) ставят через `SystemPlaque`**, а не готовым текстом: продюсер называет `typeKey` записи хроники и её значения, `postPlaque` пишет снимок источника и кладёт `chatterTypeKey` в payload. Имя СОБЫТИЯ шины (`office.room.created`) не совпадает с ключом типа (`office.room_created`) и остаётся в `eventType` — по нему ветвятся клиенты. Готовая строка в аргументе замораживала бы плашку в языке того, кто её поставил.
- **Слово внутри значений — тоже ключ.** Длительность звонка едет `durationKey` + числа, имя файла по умолчанию — `titleKey`: `resolveLabelKeys` разворачивает их в языке ЧИТАТЕЛЯ (и при сборке снимка — в языке источника).
- Заголовок контекстного чата — СНИМОК имени предмета на момент создания чата (задача, встреча): переименование предмета его не двигает. Это поведение платформы, а не недосмотр отдельного сервиса.

## Проверка

`verify-messenger.cjs`, `-group`, `-socket`, `-task`, `-presence`, `verify-mentions.cjs`, `verify-logout-socket.cjs`, `verify-search.cjs`, `verify-quickactions.cjs`, `verify-messenger-calls.cjs`, `verify-call-recording.cjs`, `verify-richcards.cjs`.

## Отправка и повтор

`POST /messenger/chats/:id/messages` (и альбом вложений, и отложенные) объявлены `@Idempotent({ required: true })`: у отправки нет «отменить», и дубль виден всем участникам чата навсегда.

**Ключ повтора = id оптимистичного пузыря** (uuid). Отсюда два следствия:

- подмена temp-пузыря на сохранённое сообщение идёт **по ключу**, а не по содержимому. Именно сверка по тексту мешала раньше показывать temp-пузырь у альбома вложений: подпись бывает пустой. Теперь пузырь есть и у альбома;
- отказ пузырь **не удаляет**. Раньше неотправленное молча исчезало, и человек не знал, дошло оно или нет. Теперь пузырь остаётся как «Не отправлено · Повторить», и повтор уходит С ТЕМ ЖЕ ключом — в чате окажется ровно одно сообщение, сколько бы раз человек ни нажал.

`POST /messenger/chats/:id/read` — наоборот, `@SkipIdempotency('naturally_idempotent')`: «прочитано до seq» летит на каждую прокрутку ленты, это операция «стало так», и строка в `idem.keys` на каждый такой запрос была бы чистым расходом.

Клиентские события аналитики: `messenger.message.send_failed` (с кодом причины и числом авто-повторов транспорта) и `messenger.message.send_retried`. Ни текста, ни адресата в свойствах нет.

Детали — [idempotency_engine.md](idempotency_engine.md).
