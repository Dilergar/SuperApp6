# core/access — движок авторизации (ReBAC)

> Единый движок прав всех сервисов (модель Zanzibar). Одна таблица отношений + правила на тип ресурса + резолвер + кэш с эпохами + реестр способностей. Код проверяет **способность**, не имя роли.

## Модель

- **`RelationTuple`** — `ресурс#отношение@получатель` (прямой + обратный индексы). Получатели: `user` / `circle` / `workspace_role` / `department` / `position` / `branch` / `public`.
- **Правила на тип** — `access-schema.ts`: примитивы `this` / `computedUserset` / `tupleToUserset` / `union` (наследование витрина←магазин, editor⇒viewer, уровни календаря busy<detailed).
- **Резолвер** — `check` / `resolveLevel` / `listObjects` (мемоизация + защита от циклов; BFS волнами одним IN-запросом + прунинг `GENERIC_PRINCIPALS` + `LIST_OBJECTS_EXTRA_EXPANSION`).
- **Реестр способностей** — `access-capabilities.ts`.
- **Кэш Redis с эпохами**: глобальная + per-type (`EPOCH_FANOUT`; неизвестный тип → глобальная — safe-by-default) + **пообъектная для `chat`** (мутации task/order/event/office_room бампают эпохи только зависимых чатов реверс-lookup'ом; сбой lookup → фолбэк на тип-эпоху, Hard Revoke не ослабляется). Любая запись = INCR → мгновенный отзыв. Отложенный re-bump через 2с после tx-коммита закрывает окно stale-ACL.

## Источник правды = ПРОЕКЦИЯ

Доменные таблицы остаются хозяином данных; их доступ-рёбра (членство в Группах, роли воркспейса, `Circle.calendarVisibility`, владение/parent магазина, роли участников задач, оси Staff) **зеркалятся** в движок: best-effort хуки при мутациях + diff-сверка `AccessReconcileCron` + бэкфилл `scripts/backfill-access.cjs`. Проекции — диффные (`applyDiff`: нет revoke-then-grant окна, ноль бампов при пустом диффе).

Оси Staff: `position#holder@user`, `branch#member@user`, `department#member@user` **с closure предков** (грант на отдел достаёт сотрудников подотделов). Роли воркспейса проецируются маппингом `staff|trainee→member`; `contractor` НЕ проецируется.

## Два читающих пути (выбор несущий)

1. **`check()` / `resolveLevel`** — точечная проверка одного объекта (кэшируется по эпохам).
2. **`grantSetFor(userId, resourceType)`** — массовая выборка под правами (список/поиск/лента): отдаёт принципалы (с развёрнутой лестницей ролей) и выданные id; потребитель подставляет их ОДНИМ условием в свой SQL. **НЕ `check()` в цикле** (N проверок на страницу) и **НЕ `listObjects`** (потолок MAX_VISITED=10 000 с молчаливой обрезкой).
3. **`principalsOf(userId)`** — «кто этот человек» отдельно от «что ему выдано» (первая половина grantSetFor; используют approvals-снимки, departmentCoworkerIds Документов).

У типов, читаемых ТОЛЬКО через grantSetFor (Диск, doc_template), пустой `EPOCH_FANOUT` и нет способности — кэшируемый check() по ним не зовётся.

## Правила подключения нового типа

- Тип в `ACCESS_SCHEMA` + строка в `EPOCH_FANOUT` (+ `LIST_OBJECTS_EXTRA_EXPANSION`, если тип достижим из listObjects).
- **Гранты не-user принципалам писать с `subjectRelation`** (`principalSubjectRelation`) — без отношения выдача отделу/должности/филиалу молча не работает.
- Лестницы ролей — `ROLE_LADDERS` (принципал `workspace#manager` разворачивает owner/admin сам).
- Наследование по СВОЕМУ дереву движок не считает — материализуется в домене (массив предков + GIN, одно условие в SQL; паттерн Диска и closure отделов). Рекурсия `arrow('parent', …)` отвергнута (десятки запросов на промах + сброс кэша всей платформы).
- Выдал грант «человеку из окружения» → зарегистрируй отзыв в `PersonalGraphRegistry` (иначе доступ переживёт разрыв связи).
- Удаление группы снимает и рёбра, где она ПОЛУЧАТЕЛЬ гранта (`revokeSubject`).

## Кто НЕ в движке (осознанно)

- Карточки Окружения (B2C) — field-слой: доступ = наличие ContactLink, видимость полей по Группам.
- Файлы — доступ наследуется от привязанной сущности через `FilesRefRegistry` (родитель = источник истины; тип file в схему не добавлен).
- Гости share-links — не принципалы: строка ссылки И ЕСТЬ грант.
- Контрагенты — гейт РОЛЬЮ (прецедент Staff).

## Проверка

`verify-access.cjs`, `verify-access-projection.cjs`, `verify-tasks-access.cjs`, `verify-calendar-access.cjs`, `verify-circle-access-revoke.cjs` + сьюты потребителей.
