# Задачник (TasksModule)

> Task Manager с ролями Bitrix24: Постановщик (creator) + Исполнитель/Соисполнитель/Наблюдатель (`TaskParticipant` — одна роль на пользователя, своё под-состояние `pending→submitted→accepted/returned`). Коины-награды — РЕАЛЬНЫЙ эскроу кошелька.

## Модель

- Назначение из окружения (`assertReachable`; в организации — любому сотруднику по рабочему пропуску), на себя или на **Группу** (`assignedCircleId` → участники-СНИМОК становятся Соисполнителями).
- Приёмка пер-участник: задача `done`, когда ВСЕ приняты; самозадача — сразу done.
- **Эскроу наград** (синхронно в одной транзакции с WalletModule, refType='task'): создание с наградой → fund (заморозка), приёмка → capture + `wallet.coins.received`, возврат после приёмки → collect-back БЕЗ минуса (бросает, если исполнитель потратил) + переморозка, отмена / в корзину → release (подзадачи — тоже: прежнее удаление их заморозки забывало навсегда).
- Тайм-менеджер: `dueDate`+`allDay`, `reminderAt`, повторы `recurrenceRule` (следующий экземпляр при завершении; `filterReachable` на повторах). Семантика overdue — Todoist: задача «весь день» на сегодня не просрочена до конца дня. Доставку напоминаний и ежедневную сводку просрочек делает `TasksCron` (каждые 10 мин / раз в день, Redis-лок) — НЕ джоб core/jobs (в отличие от напоминаний календаря).
- **GTD Входящие**: quick-add одной строкой → настоящая Task с `inbox=true`; назначение срока/исполнителя снимает inbox (clarify).
- `priorityRank Int` — сортировка high>low.
- Чат задачи = контекстный чат мессенджера (`TaskComment` удалён; ручки /comments не существуют).
- B2B: участники по userId, контекст — `workspaceId` (chokepoint-модель).
- Вложения: `FilesRefRegistry` refType='task' (view/attach = создатель∥участник; `canEditContent` объявлен ЯВНО); `attachmentFileIds` при создании линкуются в tx.
- Хроника: 16 typeKeys `task.*` в CHATTER_REGISTRY (14 своих: жизненный цикл + диффы срок/приоритет/награда/название + состав; +2 документных `task.document_created/edited` пишет core/docs); плашки в чат — проекция.
- Календарь: слой `tasks` через CalendarLayersRegistry (виртуальный, НЕ копирует; просрочка пиннится на «сегодня»).
- Процессы: нода «Задача человеку» создаёт настоящую задачу; полное принятие → синхронный `onTaskCompleted` (+ шина и крон-сверка как подстраховки); `reassignExecutorTrusted` — переназначение с переморозкой награды.

## API (кратко)

`GET /tasks` (smartList: inbox/today/upcoming/overdue/assigned_to_me/created_by_me/on_review + фильтры) · `GET /tasks/stats` (1 raw-запрос COUNT FILTER — бейджи сайдбара) · `POST /tasks` · `GET/PATCH /tasks/:id` · `POST /tasks/:id/submit|accept|return` (body `{participantUserId?}`) · **корзина**: `POST /tasks/:id/trash|restore`, `GET /tasks/trash`, `DELETE /tasks/:id` — навсегда и только из корзины (`400 task.trashFirst`) · чат — `GET /messenger/tasks/:taskId/chat`.

## Веб (`/tasks`, «Задачи 2.0»)

Сайдбар-каркас с бейджами-счётчиками (поллинг stats 60с); разделы-URL: Обзор · Входящие (инлайн-разбор) · today/overdue/upcoming/assigned/delegated/review · all (поиск+чипы+пагинация) · done · `[id]` деталька с чатом. Универсальный `TaskListSection`.

## Ловушки

- Предикат видимости — индексируемый (id-IN / raw-UNION), не `OR(владелец, EXISTS)`.
- Настоящий эскроу делает удаление/отмену задач денежной операцией — все переходы status-guarded.
- **Корзина** (30 дней, `deletedAt`, по образцу Заметок и Диска): в корзину — только постановщик; задача уходит вместе с подзадачами (один момент `deletedAt`), скрывается у ВСЕХ — карточка 404, списки, счётчики, слой календаря, рич-карта, резолвер уведомлений, вложения и хроника (`visibilityWhere` и каждый `findUnique` — `deletedAt: null`); заморозки наград возвращаются в транзакции скрытия, поле награды обнуляется — восстановленная задача честно без награды; процесс, ждущий задачу, получает `task.deleted` (ночной свип процессов считает задачу в корзине удалённой — сигнал шины мог потеряться). Хроника `task.trashed` / `task.restored` уходит и плашкой в чат задачи. Восстановление — поддерево того же момента; подзадача при родителе в корзине одна не возвращается (`400 task.restoreParentFirst`). Права, вложения и чат живут до окончательного удаления; «навсегда» — строка (подзадачи каскадом FK), вложения, кортежи прав, чаты поддерева. Старше 30 дней — навсегда кроном `tasks.cron` (`TASK_LIMITS.trashRetentionDays`). Веб — раздел «Корзина» (`/tasks/trash`, общий `TrashTable`).

## Проверка

`verify-tasks-access.cjs`, `verify-tasks-inbox.cjs`, `verify-messenger-task.cjs`, `verify-escrow.cjs`.
