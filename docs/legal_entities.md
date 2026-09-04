# Юрлица организации (LegalEntity)

> Список ТОО/ИП внутри одной организации: сторона трудового договора, владелец счетов, балансодержатель оборудования. Workspace — это БРЕНД («Сеть кофеен Ромашка»), а договор подписывает конкретное юрлицо; у сети их бывает несколько (регионы, налоговые режимы).

Код: `apps/api/src/modules/workspaces/legal-entities.service.ts` + `legal-entities.controller.ts`; веб — `apps/web/src/app/workspaces/[id]/profile/LegalEntitiesSection.tsx`.

## Модель

`LegalEntity` — бывшая `WorkspaceRequisites`, переименованная миграцией **с сохранением id и данных** (на них ссылаются уже напечатанные документы). Поля реквизитов те же (`orgForm`, `taxRegime`, `legalName`, `bin`, `legalAddress`, `kbe`, НДС, `directorUserId`, `signBasis`) плюс `name`, `isHead`, `sortOrder`, `archivedAt`.

- **Ровно одно ГОЛОВНОЕ** (`isHead`) на организацию — рукописный `UNIQUE(workspace_id) WHERE is_head`. Оно подставляется везде, где юрлицо не выбрано явно, и архивировать его нельзя (409 `legal_entity_head`). Сменить головное — `POST legal-entities/:leId/make-head`: снятие старого флага и установка нового ОДНОЙ транзакцией (партиальный уникум терпит только такую последовательность). Без этой ручки сеть, заведшая настоящее ТОО вторым, навсегда оставалась бы с автосозданной заглушкой во главе.
- **Самолечение** `ensureHeadLegalEntity(ws)` по образцу `ensureDefaultBranch`: организация без строки чинится первым же обращением; новая организация получает головное юрлицо в ТОЙ ЖЕ транзакции, что и себя.
- **Удаления нет — только архив**: на юрлицо ссылаются трудовые карточки (FK **Restrict**), объекты (SetNull), счета (Cascade) и документы.
- `WorkspaceBankAccount.legalEntityId` (NOT NULL): счёт принадлежит юрлицу — в платёжку идут ЕГО БИН и КБе.
- `Employment.legalEntityId` (NOT NULL) + `legalEntityName` (снимок на момент договора). Рукописный уникум КЭДО пересобран: **`UNIQUE(workspace_id, user_id, legal_entity_id) WHERE status <> 'terminated'`** — одна живая трудовая карточка на человека В КАЖДОМ юрлице, то есть совместительство внутри организации разрешено.
- `BIN` уникален среди ЖИВЫХ юрлиц организации (`UNIQUE(workspace_id, bin) WHERE bin IS NOT NULL AND archived_at IS NULL`) → 409 `legal_entity_bin_duplicate`.

## HTTP API

`GET/POST /workspaces/:id/legal-entities` · `GET legal-entities/lite` (справочник для форм — вся команда) · `GET/PATCH legal-entities/:leId` · `POST …/archive|restore` · `POST …/make-head` · `POST/PATCH/DELETE …/accounts[/:accId]`. Правят `owner`/`admin`.

**Старые ручки `/workspaces/:id/requisites` продолжают работать** и читают/правят ГОЛОВНОЕ юрлицо — совместимость веба и напечатанных документов.

## Как юрлицо попадает в документ

Группа полей шаблона «Организация» (`workspaces-template-fields.provider.ts`) читает `ctx.legalEntityId`, а не организацию: реквизиты в договоре — того ТОО, которое его подписывает. Контекст дополняет КЭДО через `TemplateFieldRegistry.registerContextEnricher` (`hr-registries.provider.ts`): по `hrActionId` находится трудовая карточка и её `legalEntityId`. Движок при этом фичи не импортирует — направление только обратное (реестр).

`org.service.ts` берёт директора ГОЛОВНОГО юрлица как вершину схемы организации. ЕСУТД отправляет работодателя = юрлицо карточки.

## Ловушки

- **`archivedAt` у юрлица — не косметика**: `resolveLegalEntityId` отвергает архивное (409 `legal_entity_archived`), иначе новый договор заключался бы от имени закрытого ТОО.
- **Имя юрлица в штатке — живое, в договоре — снимок.** Переименование ТОО обязано быть видно в таблицах, но не должно менять уже напечатанный договор.
- **Совместительство ≠ дубль.** Вторая живая карточка в ДРУГОМ юрлице — норма; в том же — 409. Правка конкретной карточки идёт с `employmentId` (иначе сервер возьмёт головную).

## Проверка

`node apps/api/scripts/verify-legal-entities.cjs` — головное заводится само, `/requisites` = головное, второе ТОО, дубль БИН 409, архив/восстановление, совместительство, договор на архивное юрлицо 409.

## Связанные доки

[workspaces.md](workspaces.md) · [hr_kedo.md](hr_kedo.md) · [objects.md](objects.md) · [templates_engine.md](templates_engine.md) · [documents_service.md](documents_service.md)
