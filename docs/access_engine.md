# core/access — движок авторизации (ReBAC)

> Единый движок прав всех сервисов (модель Zanzibar). Одна таблица отношений + правила на тип ресурса + резолвер + кэш с эпохами + реестр способностей. Код проверяет **способность**, не имя роли.

## Модель

- **`RelationTuple`** — `ресурс#отношение@получатель` (прямой + обратный индексы). Типы получателей (принципалов): `user` / `circle` (Группа) / `workspace` / `department` / `position` / `branch` / `public`. **Роль организации — это принципал `workspace` с отношением-ролью**: грант «всем менеджерам» пишется как `@workspace:<id>#manager`, «всей команде» — `#member`; лестница `owner > admin > manager > member` (`ROLE_LADDERS`) разворачивается движком. Отдельного типа «роль воркспейса» нет.
- **Правила на тип** — `apps/api/src/core/access/access-schema.ts`: примитивы `this` / `computedUserset` / `tupleToUserset` / `union` (наследование витрина←магазин, editor⇒viewer, уровни календаря busy<detailed).
- **Резолвер** — `can(subject, capability, resourceId)` (проверка СПОСОБНОСТИ из реестра — основной вызов потребителей) / `check` (сырое отношение) / `resolveLevel` / `listObjects` (мемоизация + защита от циклов, `MAX_DEPTH 24`, `MAX_VISITED 10 000`; BFS волнами одним IN-запросом + прунинг `GENERIC_PRINCIPALS` + `LIST_OBJECTS_EXTRA_EXPANSION`).
- **Реестр способностей** — `access-capabilities.ts` (ключ способности → тип ресурса + отношение).
- **Кэш Redis с эпохами** (`CACHE_TTL_SECONDS = 600`): глобальная + per-type (`EPOCH_FANOUT`; тип без строки → глобальная эпоха — safe-by-default, но каждая его мутация сбрасывает кэш всей платформы) + **пообъектная для `chat`** (`OBJECT_EPOCH_TYPES`; мутации `task/order/event/office_room/workspace` — `CHAT_PARENT_SUBJECT_TYPES` — бампают эпохи только зависимых чатов реверс-lookup'ом; сбой lookup → фолбэк на тип-эпоху, Hard Revoke не ослабляется). Любая запись = INCR → мгновенный отзыв. Мутации с `tx` (`grant/grantMany/revoke/revokeResource/revokeSubject/revokeByIds`) делают отложенный re-bump через 2с после коммита — закрывает окно stale-ACL.

## Источник правды = ПРОЕКЦИЯ

Доменные таблицы остаются хозяином данных; их доступ-рёбра **зеркалятся** в движок (`access-projection.service.ts`): членство в Группах, роли воркспейса, `Circle.calendarVisibility`, владение/parent магазина, роли участников задач / заказов / событий / комнат офиса (`resyncTaskRoles/OrderRoles/EventRoles/OfficeRoomRoles` + `*Deleted`), оси Staff. Хуки best-effort (`safe()` — ошибка проекции не роняет доменную мутацию) + diff-сверка `AccessReconcileCron` (ежедневно 04:00: `reconcile` + бэкфилл магазинов/календаря + задач за окно 25ч; полный бэкфилл задач — только скрипт `apps/api/scripts/backfill-access.cjs`). Проекции — диффные (`applyDiff`: нет revoke-then-grant окна, ноль бампов при пустом диффе).

Оси Staff: `position#holder@user`, `branch#member@user`, `department#member@user` **с closure предков** (грант на отдел достаёт сотрудников подотделов), `department#head@user` (голова отдела — на отдел и всех ПОТОМКОВ, closure ВНИЗ, + `member` предков), `branch#head@user` (держатели руководящей должности объекта, работающие В ЭТОМ объекте). **Диф проекции сужен по отношению и user-субъекту**: проекция владеет только `position: holder`, `branch: member|head`, `department: member|head` — явное делегирование `department#manager` и гранты Группам переживают resync (без сужения первое чужое ребро стиралось бы после каждой мутации Staff). **Замещения (StaffDeputy) не проецируются никогда**: рёбра — только факты без даты. Роли воркспейса проецируются маппингом `staff|trainee→member`; `contractor` НЕ проецируется.

## Читающие пути (выбор несущий)

1. **`can()` / `check()` / `resolveLevel`** — точечная проверка одного объекта (кэшируется по эпохам).
2. **`grantSetFor(userId, resourceType)`** — массовая выборка под правами (список/поиск/лента): отдаёт принципалы (с развёрнутой лестницей ролей) и выданные id; потребитель подставляет их ОДНИМ условием в свой SQL. **НЕ `check()` в цикле** (N проверок на страницу) и **НЕ `listObjects`** (потолок MAX_VISITED=10 000 с молчаливой обрезкой).
3. **`principalsOf(userId)`** — «кто этот человек» отдельно от «что ему выдано» (первая половина grantSetFor; используют approvals-снимки, departmentCoworkerIds Документов). `principalIdsOfType` — то же для одного типа.

У типов, читаемых ТОЛЬКО через grantSetFor (Диск, doc_template), пустой `EPOCH_FANOUT` и нет способности — кэшируемый check() по ним не зовётся.

## Правила подключения нового типа

- Тип в `ACCESS_SCHEMA` + способности в `access-capabilities.ts` + строка в `EPOCH_FANOUT` (+ `LIST_OBJECTS_EXTRA_EXPANSION`, если тип достижим из listObjects).
- **Потребитель начал звать `can()/check()` по типу с пустым фанаутом (Диск, doc_template) → СНАЧАЛА заполнить `EPOCH_FANOUT`**, иначе права протухают до 10 минут (TTL кэша).
- **Новая форма userset/parent в проекции → в perf-карты** (`GENERIC_PRINCIPALS` / `LIST_OBJECTS_EXTRA_EXPANSION`), иначе `listObjects` пропустит результаты, а кэш переживёт грант.
- **Гранты не-user принципалам писать с `subjectRelation`** (`principalSubjectRelation`: `position → holder`, остальные → `member`) — без отношения выдача отделу/должности/филиалу молча не работает.
- Лестницы ролей — `ROLE_LADDERS` (принципал `workspace#manager` разворачивает owner/admin сам; `department`/`branch`: `head → member` — голова отдела/объекта в его составе); порядок обязан совпадать с union-цепочкой типа в `ACCESS_SCHEMA` (`member: union(THIS, computed('head'))`, иначе `check()` и `grantSetFor` разошлись бы). Отношение ВНЕ лестницы своего типа (`department#manager` — делегирование) `principalsOf` добавляет как есть. Способность `department.manage` = `manager` (голова ⇒ manager).
- Наследование по СВОЕМУ дереву движок не считает — материализуется в домене (массив предков + GIN, одно условие в SQL; паттерн Диска и closure отделов). Рекурсия `arrow('parent', …)` отвергнута (десятки запросов на промах + сброс кэша всей платформы).
- Выдал грант «человеку из окружения» → зарегистрируй отзыв в `PersonalGraphRegistry` (иначе доступ переживёт разрыв связи) — [contacts_circles.md](contacts_circles.md).
- Удаление группы снимает и рёбра, где она ПОЛУЧАТЕЛЬ гранта (`revokeSubject`).

## Кто НЕ в движке (осознанно)

- Карточки Окружения (B2C) — field-слой: доступ = наличие ContactLink, видимость полей по Группам.
- Файлы — доступ наследуется от привязанной сущности через `FilesRefRegistry` (родитель = источник истины; тип file в схему не добавлен) — [files_engine.md](files_engine.md).
- Гости share-links — не принципалы: строка ссылки И ЕСТЬ грант.
- Контрагенты — гейт РОЛЬЮ (прецедент Staff).

## Проверка

`verify-access.cjs`, `verify-access-projection.cjs`, `verify-tasks-access.cjs`, `verify-calendar-access.cjs`, `verify-circle-access-revoke.cjs` + сьюты потребителей.
