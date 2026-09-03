# core/audiences — движок адресатов (16-й)

> Единый словарь «КОМУ адресовано» и его разворот в людей: человек · Группа · вся команда · отдел · должность · объект · ОТНОСИТЕЛЬНЫЕ виды оргструктуры (руководитель кого-то, команда кого-то, руководитель объекта кого-то). До движка четыре потребителя держали по копии разворота с тремя резолверами и знали наизусть имена отношений проекции прав. Движок **решает, кому адресовано, и НЕ пишет гранты**.

Код: `apps/api/src/core/audiences/` (`audiences.service.ts`, `audiences.registry.ts`, дев-полигон `audiences.dev.ts`). Словарь — `packages/shared/src/constants/audiences.ts`, формы — `types/audience.ts`, Zod — `validation/audience.ts`.

## Словарь

`AUDIENCE_KINDS = user | circle | workspace | department | position | branch | manager_of | subordinates_of | branch_head_of`. `AUDIENCE_KIND_DEFS` несёт `relative` (разворачивается по оргструктуре относительно человека), `grantable` (может быть получателем ребра прав — относительные НЕ могут: «руководитель X» меняется со временем), `workspaceOnly`. **Якоря** `$initiator` / `$subject` / `$self` — подстановки вместо id у относительных видов и `user`; подставляются из `AudienceContext` ДО любого Prisma-`where`; якорь без контекста → 400 `audience_anchor_unavailable`, не `[]`.

Наборы на потребителя (каждый — подмножество): `APPROVAL_AUDIENCE_KINDS` (шаг решения: user/position/department/branch/manager_of/branch_head_of), `CAMPAIGN_AUDIENCE_KINDS` (кампании и массовые кадровые действия: + workspace, subordinates_of), `DOC_TEMPLATE_GRANT_KINDS` (гранты бланка — только принципалы организации), `DRIVE_SHARE_KINDS`. `APPROVAL_ASSIGNEE_TYPES` движка согласований = `APPROVAL_AUDIENCE_KINDS`.

## Контракт

```ts
AudiencesService.resolve(refs, ctx, { max, onOverflow: 'throw'|'truncate', allowedKinds? })  // → userId[] живых
AudiencesService.resolveOne(ref, ctx, limit)        // сырой разворот одного
AudiencesService.label(ref, ctx) / labelMany(refs, ctx)   // «Отдел «Продажи»», «Руководитель инициатора»
AudiencesService.belongsToWorkspace(type, id, wsId)
AudiencesService.principalsFor(refs)               // форма субъекта ребра прав для grantable-видов
AudiencesRegistry.register(kind, { resolve(id, ctx, limit), label?(id, ctx) })  // владелец данных
```

`AudienceContext = { workspaceId, initiatorId?, subjectId?, selfId?, branchId? }`.

## Несущие правила

- **Организация скоупит всё**: чужой отдел/должность/объект → пусто; человек вне команды → пусто; `workspace` — только своя. Подрядчики никогда не в составе; в личном контексте — только живые аккаунты.
- **Одна карта отношений** осей: `department: [member, head]`, `position: [holder]`, `branch: [member, head]` — голова отдела/объекта входит в состав (как в `ROLE_LADDERS` движка прав: одно правило для check/grantSetFor/адресатов).
- **Переполнение** — семантика вызывающего: `throw` → 400 `audience_overflow`; `truncate` → молчаливая обрезка (кампании — записанный долг). Согласования передают `max+1`/`truncate` и бросают свой `approval_snapshot_too_big`.
- **Граница движка**: сам движок читает только `relationTuple` и `user_roles`; `circle` регистрирует `ContactsModule` (`ContactsAudiencesProvider` → `resolveCircleMemberIds`, `gate:false`), относительные виды — `StaffModule` (`StaffRegistriesProvider` → `managerOf`/`subordinateIdsOf`/держатели головы объекта). Ребро `core/audiences → modules/*` роняет CI.
- `branch_head_of` принимает id ОБЪЕКТА (→ его руководитель) либо id ЧЕЛОВЕКА/якорь (→ руководитель объекта его основного места или `ctx.branchId`).
- Движок не пишет гранты: шаблоны и Диск по-прежнему пишут рёбра сами через `principalSubjectRelation`; `grantable:false` механически прячет относительные виды из диалогов шеринга.

## Потребители

| Кто | Как |
|---|---|
| `core/approvals` `resolveAssignees` | снимок при активации; `$initiator` = автор заявки; вершина → владелец; подпись шага — `label` |
| `core/approvals` эскалация | `approval.overdue` дополнительно — `manager_of` каждого просрочившего |
| Кампании ознакомления (`doc-campaigns`) | `resolve(audience, {selfId: creator}, truncate campaignMaxTargets)` |
| Массовые кадровые действия (`hr-actions`) | то же + ранг-фильтр `canManageHrSubject` |
| Процессы | `human.task` `initiator_manager` — первый из `manager_of`; `human.approval` — относительные адресаты в шаг |
| Диск (`drive-share`) | подписи получателей — `labelMany` |
| Гранты бланков | `docTemplateGrantSchema` — `DOC_TEMPLATE_GRANT_KINDS` |

Миграции данных не было: каждый прежний enum — подмножество, снимки уже `[{type,id}]`.

## Дев-полигон

`POST /audiences/dev/resolve` (только development/test) — `{workspaceId?, refs, initiatorId?, subjectId?, branchId?, max?, onOverflow?}` → `{userIds, labels}`; `$self` = вызывающий.

## Проверка

`verify-audiences.cjs`: один `[{type:'department',id}]` даёт одинаковый состав у движка и в снимке шага; голова снаружи отдела — в составе; `manager_of/$initiator` садится в `awaitingUserIds`; корень → владелец; чужой отдел → пусто и `approval_empty_assignees`; переполнение/обрезка/якорь без контекста кодами; `subordinates_of/$self`; `branch_head_of` по человеку и по объекту; паспорта нод Процессов; маршрут заявления библиотеки; поля «Руководитель».

## Связанные доки

[org_structure.md](org_structure.md) · [approvals_engine.md](approvals_engine.md) · [access_engine.md](access_engine.md) · [documents_service.md](documents_service.md) · [hr_kedo.md](hr_kedo.md) · [module_graph.md](module_graph.md)
