# Объекты (ObjectsModule, B2B)

> Дерево физических площадок организации: точка → здание → этаж → зона. Вокруг объекта собраны штатное расписание (план ставок и денег), график смен (план и факт) и оборудование. Спроектирован как ХАБ: будущие Финансы читают план затрат, пропускная система пишет факт выходов в те же таблицы, AI и терминал ходят через те же ручки.

Код: `apps/api/src/modules/objects/`, веб — `apps/web/src/app/workspaces/[id]/objects/`.

## Модель

Новой сущности объекта НЕТ — расширен `StaffBranch` (ключ `branch` в access/audiences/tuples сохранён; в UI «Объект»). Существующий B2C `Resource` (личное бронирование в календаре) к этому сервису отношения не имеет.

- **`StaffBranch`** — объект. Имя уникально В ПРЕДЕЛАХ РОДИТЕЛЯ и только среди живых
  (`UNIQUE(workspace_id, COALESCE(parent_id, ''), name) WHERE archived_at IS NULL`): «Этаж 1»
  бывает в каждом здании сети, а архивный объект имя не держит.
  `parentId` (self-FK **Restrict**), `kind` (`OBJECT_KINDS`: site/building/floor/room/warehouse/zone/other), `legalEntityId` (FK SetNull; null = наследуется), `timeZone` (смены считаются в поясе ОБЪЕКТА), `glyph`, `scheduleSettings` (Json: `minRestMin`, `maxShiftMin`, `lateToleranceMin`, `weekStartsOn`, `accountingPeriod`), `archivedAt`.
  **`ancestorIds` (String[], корень первым, без себя) + `depth`** — материализованные предки. Паттерн Диска и closure отделов: ОДНО условие в SQL и для поддерева (`ancestor_ids @> ARRAY[id]`), и для прав через предков (`ancestor_ids && $granted`). Рукописный `CREATE INDEX … USING GIN(ancestor_ids)`.
- **`StaffingPosition` → `StaffAssignment` → `StaffRate`** — штатное расписание (единицы, датированные назначения, версии ставок), отдельный док: [objects_staffing.md](objects_staffing.md).
- **`ShiftTemplate` → `ShiftPattern` → `Shift` (план) → `ShiftAttendance` (факт)** — график смен, отдельный док: [objects_shifts.md](objects_shifts.md).
- **`AssetModel` → `Asset` → `AssetMove` + `AssetServiceRecord`** — оборудование, отдельный док: [objects_assets.md](objects_assets.md).

## Права

Схема `core/access`, тип `branch` (симметрично `department`):

```
member: union(THIS, computed('head'))
head:   THIS
manager:        union(THIS, computed('head'))       // явное делегирование ребром
scheduler:      union(THIS, computed('manager'))    // график и факт смен
payroll_viewer: union(THIS, computed('manager'))    // управленческие деньги
```

Способности: `branch.view→member`, `branch.manage→manager`, `branch.schedule.manage→scheduler`, `branch.attendance.mark→scheduler`, `branch.payroll.view→payroll_viewer`. У штатки, смен и активов **своих tuples нет** — право считается по их объекту.

**Дерево** проецируется в `applyStaffDiff` (`core/access/access-projection.service.ts`): `branch#member` — замыканием ВВЕРХ (назначен на этаж → член этажа, здания, площадки), `branch#head` — замыканием ВНИЗ (голова здания — голова его этажей) + `member` предков. Держатели головы ищутся в объекте И ЕГО ПОДДЕРЕВЕ (управляющий сидит на этаже, руководит зданием). Явные делегирования (`manager`/`scheduler`/`payroll_viewer`) не проецируются — их учитывает `capsFor` через предков.

> **Правило проверки.** `can()` по id ребёнка ПРОМАХИВАЕТСЯ мимо предков (кэш резолвится по одному узлу). Права считаются ОДИН раз на запрос: `ObjectsService.scopeOf(user, ws)` → `capsFor(scope, branch)` — пересечение грантов `grantSetFor(user,'branch')` с цепочкой `[id, ...ancestorIds]`. `grantSetFor` НЕ скоупит по организации (рёбра не несут workspaceId) — пересекать со справочником организации обязательно.

**Деньги** (оклады факт, статус оформления, цена/баланс/ремонты оборудования) видят `owner`/`admin` (`OBJECTS_PAYROLL_FULL_ROLES`) и управляющий СВОЕГО объекта. Сужение — не на клиенте: без `caps.payrollView` денежные поля в ответе ОТСУТСТВУЮТ (`?:`), а не равны null. Ответы несут `caps` — веб прячет колонки по ним, не по роли.

## HTTP API (кратко)

Все под `/api/v1/workspaces/:workspaceId/…`; статические пути объявлены ДО `:id`.

| Путь | Что делает |
|---|---|
| `GET objects/tree?archived=` · `GET objects/mine` | Дерево (обрезано правами; предки видимых узлов отдаются «тропинкой» с пустыми caps) · мои объекты |
| `POST objects` · `GET/PATCH/DELETE objects/:objectId` · `POST …/move` · `…/archive` · `…/restore` · `…/make-default` | CRUD + перенос (цикл → 409 `object_cycle`, пересчёт поддерева в одной tx) + архив поддерева + смена основного объекта |
| `GET objects/:objectId/attendance?from&to` · `PATCH attendance/:attId` · `DELETE attendance/:attId` | Табель объекта: план и ВНЕПЛАНОВЫЕ выходы; правка и удаление ошибочной записи |
| `GET objects/:objectId/people` · `GET/POST objects/:objectId/files` · `DELETE …/files/:fileId` | Коллеги (с поддеревом) · файлы объекта (движок `core/files`) |
| `staffing/*` (таблица, единицы, назначения, ставки) | Штатное расписание — [objects_staffing.md](objects_staffing.md) |
| `shift-templates`, `shift-patterns`, `shifts`, `attendance` | График смен и факт выходов — [objects_shifts.md](objects_shifts.md) |
| `asset-models`, `objects/:objectId/assets`, `assets/:assetId/*` | Оборудование — [objects_assets.md](objects_assets.md) |

## Порты (`objects-ports.ts`)

- **`ObjectsPayrollPort.getPlannedPayroll(ws, {branchId?, from, to})`** → строки по штатным единицам, включая ВАКАНСИИ, + итог. Суммы — тиыны строкой. Токен `DI_TOKENS.ObjectsPayrollPort` (реализация — `StaffingService`).
- **`AttendancePort.recordAttendanceSystem({ws, userId, branchId, at, direction, source, sourceRef})`** — событие прохода: матчится с ближайшей опубликованной сменой, опоздание считается от планового начала с допуском объекта. Контракт `system*` — прав НЕ проверяет; HTTP-обёртка `POST objects/:id/attendance/gate` требует `branch.attendance.mark`. Токен `DI_TOKENS.AttendancePort`.

## Регистрации в движках

`chatter` (`branch`, `asset` — ОБА обязаны быть зарегистрированы в `ChatterRefRegistry`, иначе записи пишутся «в стол»: движок отвечает 404 на незнакомый refType) · `files` (`branch`, `asset`, `asset_model`, `asset_service`; `scopedPlace: true` + список `allowedProfiles` — место со своей видимостью обязано их объявить) · `drive routing` (файлы едут на Диск ОРГАНИЗАЦИИ) · `search` (провайдеры `branch` и `asset`, обрезка правами по `ancestorIds`) · `rich-cards` (`branch` — переслать точку; `shift` — открытая смена с действием `shift.take`) · слой календаря `shifts` · уведомления смен ([objects_shifts.md](objects_shifts.md)).

Джобы: `objects.shifts.generate` (`uniqueKey sp:<patternId>:<week>`) и `staff.assignment.rollover` (`runAt` = полночь в поясе объекта, `uniqueKey sa:<id>:<date>`, эффект — `projectWorkspaceStaff`).

## Несущие правила

- **Наступление и истечение даты события не рождают.** Tuples прав дат не несут, поэтому: (1) КАЖДЫЙ потребитель «кто сейчас работает» фильтрует назначения через `activeAssignmentWhere()` (`apps/api/src/shared/utils/assignment-window.ts`); (2) правка дат ставит джоб `staff.assignment.rollover` **`enqueue(tx)` в той же транзакции**; (3) страховка — ночной reconcile проекции.
- **План и факт — разные записи** (`Shift` ≠ `ShiftAttendance`), **шаблон → экземпляр с заморозкой**, правила отдыха и `force` — [objects_shifts.md](objects_shifts.md).
- **Ставка версионируется, официальный оклад читается из КЭДО, ранг субъекта уважается** — [objects_staffing.md](objects_staffing.md).
- **Правила объекта — данные**, а не константы кода: `scheduleSettings` (отдых, максимум смены, допуск опоздания, начало недели, отчётный период). Правятся в форме объекта; Zod держит только ТЕХНИЧЕСКИЙ потолок (сутки), доменный — из настроек объекта.
- **Архив каскадом ≠ «закрыт своим решением».** Каскад ставит поддереву ОДИН момент `archivedAt`; возврат родителя поднимает только строки с этим моментом. Возврат ребёнка при архивном родителе — 409.
- **Удаляется только ПУСТОЙ объект.** Дети, люди, штатка, смены и оборудование держат его (везде FK `Restrict`, а `P2003` в общий фильтр не разобран — без прикладной проверки был бы 500 вместо 409 `object_in_use`).

## Ловушки

- **`btree_gist`, имена индексов до 63 символов, партиальные уникумы** — ловушки БД сервиса собраны в [objects_staffing.md](objects_staffing.md).
- **Часовые пояса.** «Сегодня» — по `branch.timeZone` и НИКОГДА не `new Date().toISOString().slice(0,10)`: Казахстан UTC+5, и с 00:00 до 05:00 местного UTC-дата ещё вчерашняя (ровно ночная смена). Сервер — `utcToLocalDate`, веб — единственный источник `lib/objects-time.ts`. Прочее время — [objects_shifts.md](objects_shifts.md).
- **BigInt на проводе — только строкой**; агрегаты плана затрат считаются в `bigint`.
- **Один RQ-ключ = одна форма кэша**: список оборудования — infinite-запрос (`objectAssetsKey`), карточка — свой `assetKey`.
- **Статические пути до `:id`**: `objects/tree|mine`, `staffing/positions`, `shifts/publish`, `legal-entities/lite`.

## Веб

`app/workspaces/[id]/objects/` — дерево с поиском и сворачиванием (`page.tsx`) + `[objectId]/layout.tsx` с вкладками (Обзор / Штатное расписание / График смен / Оборудование / Хроника): вложенные сегменты с общим layout, у сетки смен и оборудования свои чанки. Компоненты — `_components/` (`ObjectTree`, `ObjectForm`, `UnitForm`, `AssignPanel`, `RateHistory`, `ShiftCell`, `ShiftForm`, `AttendanceModal`, `UnplannedAttendanceModal`, `ShiftTemplatesPanel`, `PatternForm`, `AssetForm`). Справочник моделей оборудования — СОСЕДНИЙ маршрут `objects/models` (модель принадлежит организации, а не объекту; статический сегмент выигрывает у `[objectId]`). Фетчеры — `objects-api.ts`, RQ-ключи — `lib/queries.ts`, время объекта — `lib/objects-time.ts`. Пункт меню — `ws-objects` в `lib/app-nav.ts`; старый `/members/branches` редиректит сюда.

## Проверка (сьюты)

`node apps/api/scripts/verify-objects.cjs` (дерево, права, архив, штатка) · `verify-objects-shifts.cjs` (ротация, публикация, «Возьму», факт, отдых, пропускная) · `verify-objects-assets.cjs` (модели, журналы, деньги, инвентарные номера) · `verify-legal-entities.cjs`.

## Связанные доки

[objects_staffing.md](objects_staffing.md) · [objects_shifts.md](objects_shifts.md) · [objects_assets.md](objects_assets.md) · [staff.md](staff.md) · [org_structure.md](org_structure.md) · [hr_kedo.md](hr_kedo.md) · [legal_entities.md](legal_entities.md) · [access_engine.md](access_engine.md) · [calendar.md](calendar.md) · [jobs_engine.md](jobs_engine.md) · [files_engine.md](files_engine.md) · [counterparties.md](counterparties.md)
