# Орг. структура (B2B) — вертикаль власти на графе должностей и объектов

> «Кто кому руководитель» — граф ДОЛЖНОСТЕЙ и ОБЪЕКТОВ (не людей: переживает текучку; не штатное расписание). **Орг. структура — это Circle для B2B**: на ней стоят согласования, КЭДО, процессы, будущие Объекты и Штатное расписание. Единственный вход «кто мой руководитель / моя команда» — `managerOf` / `subordinateIdsOf`, снаружи — адресаты `manager_of` / `subordinates_of` / `branch_head_of` ([audiences_engine.md](audiences_engine.md)).

Код: `apps/api/src/modules/staff/` (`org-resolve.ts` — чистые функции, `org-graph.service.ts` — снимок + кэш, `org-rights.service.ts` — области, `org.service.ts` + `org.controller.ts` — API, `staff-registries.provider.ts` — регистрации в движках). Справочники и назначения — [staff.md](staff.md). Веб — `apps/web/src/app/workspaces/[id]/members/org/`, общий канвас — `apps/web/src/components/canvas/`.

## Модель (поверх справочников Staff)

- **`StaffDepartment.headPositionId`** — руководящая ДОЛЖНОСТЬ отдела. Лежит НА ОТДЕЛЕ, не флагом на должности: должность вправе руководить отделом, находясь вне его (CFO ведёт «Финансовый», сидя вне отдела), и вести несколько отделов (без `@@unique`). FK `SetNull` + прикладной 409 `org_head_in_use` при удалении должности-головы.
- **`StaffBranch.headPositionId`** — руководящая должность ОБЪЕКТА («Управляющий точкой»), та же модель. **`StaffBranch.isDefault`** — основной объект (ровно один; заводится вместе с организацией с именем организации; партиальный уникум руками). Объект = **отдел по умолчанию**: должность без отдела подчиняется голове объекта назначения.
- **`StaffPosition.reportsToPositionId`** — точечное переопределение подчинения, сильнее всего (self-FK `SetNull`: потеря переопределения = откат к дереву, безопасно). `glyph` — значок-данные. Флага «корень» нет: корень = «нет разрешимого руководителя»; второй корень — сигнал интерфейсу («Вне структуры»).
- **`StaffAssignment.branchId` NOT NULL**, **`isPrimary`** — основное место (первое назначение основное само; смена снимает старое в той же транзакции; удаление основного повышает следующее по `createdAt`; партиальный уникум руками). Читают: `computeMismatch` КЭДО, поля шаблонов, `managerOf`.
- **`StaffDeputy`** — заместитель: кого замещают — ДОЛЖНОСТЬ (`positionId`) в объекте (`branchId`, null = во всех); кем — ровно одно из `deputyPositionId` | `deputyUserId`; `startsOn`/`endsOn` (`@db.Date`), `note`, `createdById`. Руками в миграции: `CHECK` XOR цели, `CHECK endsOn >= startsOn`, `CHECK` не сам себя, дедуп-индекс по `COALESCE(...)` (защита от двойного клика, не бизнес-правило — пересечения разрешены, ответ — множество).

## Несущий инвариант

> **`RelationTuple` хранит только НЕЗАВИСИМЫЕ ОТ ВРЕМЕНИ факты; всё с датой вычисляется.** Руководство (головы) проецируется в рёбра прав; замещения — НИКОГДА: проекция не пересчитывается в полночь, датированное замещение в рёбрах молча пережило бы отпуск.

## Вывод вертикали

Правило «кто чей руководитель» и лестница замещений вынесены отдельно (тема выросла): снимок с кэшем, `superiorPositionOf` / `holdersForPosition` / `managerOf` / `subordinateIdsOf` / `findPositionCycle` — [org_structure_resolve.md](org_structure_resolve.md). Вертикаль считается по ФАКТУ (`StaffAssignment`), не по договору (`Employment.legalPositionId`) — [staff.md](staff.md).

## Проекция в core/access

`department#head` на отдел и всех потомков (+ `member` предков), `branch#head` — держатели в этом объекте; лестницы `head → member`; диф сужен по отношению (чужие рёбра переживают resync) — [access_engine.md](access_engine.md), [staff.md](staff.md).

## Областные права (`org-rights.service.ts`)

`scopeOf(userId, ws)` → `all` (роль ∈ `STAFF_FULL_SCOPE_ROLES = ['owner','admin','manager']` — сужение до owner/admin одной константой вместе с ролью «Кадры») | `scoped` (`grantSetFor(user,'department').granted.head ∪ .manager` и `grantSetFor(user,'branch').granted.head`, пересечённые со справочниками ЭТОЙ организации — рёбра прав не несут workspaceId) | `none` (подрядчик, рядовой). Голова отдела правит свою ветку (подотделы — через closure проекции, обхода дерева нет): подотделы, должности, назначения; перемещение — права на ОБА отдела; корневой отдел, объекты, мастер — только `all`. Голова объекта правит НАЗНАЧЕНИЯ в своём объекте, отделы — нет (типовая схема общая для сети). Ранг субъекта: назначать/снимать человеку с БОЛЕЕ высокой ролью нельзя (равная — можно), владелец — всё. Отказ — 403 `org_scope_forbidden`. `system*`-методы (`assignPositionSystem`, `removeAssignmentSystem`, `ensureDefaultBranch`) прав не проверяют — проверяет вызывающий (фоновый джоб `hr.apply` от имени создателя приказа).

Заместителя ставит: держатель · его руководитель · голова ветки/объекта · полновластные роли.

## Каскады

Уход из организации: назначения и замещения снимаются (след `staff.deputy_closed`) ОДНОЙ транзакцией с их записями в журнале, head-рёбра снимает resync; голова без держателей → вертикаль поднимается выше. `purgeWorkspace` чистит рёбра осей явно; `StaffDeputy` — каскад FK. Удаление последнего/основного объекта — 409 `org_default_branch` (перенос флага — `isDefault: true` на другом объекте, старый снимается в той же транзакции). Удаление должности-головы — 409 `org_head_in_use`.

## Интеграции

Регистрации оргструктуры в движках (адресаты, согласования, процессы, бланки, шаблоны, хроника, уведомления, поиск) — таблица в [staff.md](staff.md), «Регистрации в движках».

## API

База `workspaces/:id/org` (статические пути до параметрических): `GET /chart?branchId&focus` (цельный граф, потолок `ORG_LIMITS.maxChartPositions` → 409 `org_chart_too_big`; `superiorPositionId` считает СЕРВЕР) · `GET /unassigned` · `GET /my-scope` · `GET /people/:userId/line?branchId&assignmentId` · `GET/POST/PATCH/DELETE /deputies[/:id]` · `POST /setup` (мастер). **Отдельных `/head` и `/reports-to` нет** — расширены схемы справочников: `updateStaffDepartmentSchema + headPositionId`, `updateStaffBranchSchema + headPositionId, isDefault:true`, `updateStaffPositionSchema + reportsToPositionId, glyph`, назначения `+ isPrimary`, `branchId` необязателен (пусто → основной). DTO — `packages/shared/src/types/org.ts`.

## Веб

Канвас, мастер, «Вне структуры», мобильное дерево и «Место в структуре» в профиле — [org_structure_web.md](org_structure_web.md).

## Ловушки

- Лестница `head → member` даёт участие головы через движок; сырого `member`-ребра на сам отдел проекция не пишет (лестница = union-цепочка типа).
- `grantSetFor` возвращает гранты ВСЕХ организаций — область обязана пересекаться со справочниками своей (иначе архивный прогон сьюта «дарит» отделы).
- `principalIdsOfType` игнорирует отношение — область читает `granted.get('head')`.
- Тесты и «сегодня»: сервер считает дату в `APP_TIMEZONE`; UTC-дата после 19:00 по Алматы отстаёт на день (сьюты берут дату через `Intl` с `Asia/Almaty`).

## Что следом

Зафиксированный порядок и что уже заложено под каждую стройку (Объекты → Штатное расписание по объекту → Графики/табель → Доступы и видимость) — [roadmap.md](roadmap.md), «Ближайшие кандидаты».

## Проверка

`verify-org.cjs` (вертикаль, замещения, циклы, `isPrimary`, основной объект, проекция + чужое ребро, области, каскады), `verify-audiences.cjs`; регрессии — `verify-staff`, `verify-approvals`, `verify-hr`, `verify-hr-campaigns`, `verify-processes`, `verify-templates`.

## Связанные доки

[staff.md](staff.md) · [org_structure_web.md](org_structure_web.md) · [audiences_engine.md](audiences_engine.md) · [access_engine.md](access_engine.md) · [approvals_engine.md](approvals_engine.md) · [hr_kedo.md](hr_kedo.md) · [workspaces.md](workspaces.md)
