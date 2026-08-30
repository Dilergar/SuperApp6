# Организации (WorkspacesModule, B2B)

> Организация = арендатор (workspace). Личная жизнь = соц. граф (`workspaceId=null`), не организация. Роль участника — единый источник `UserRole` ([identity_roles.md](identity_roles.md)).

## Модель

- CRUD + передача владения + выход; лимиты `WORKSPACE_LIMITS`.
- **Приглашения по номеру** (send/accept/reject/cancel; external-активация при регистрации/смене номера) — найм ВСЕГДА в Стажёра, приглашать может **manager+** (iiko-модель), без кулдаунов (анти-мусорный потолок pending 500). Опционально `positionId` + `branchIds[]` «с порога» → назначения создаются при принятии (в одной tx с членством+ролью).
- **Профиль организации** (Party-паттерн, зеркало личного /profile): поля + `cardVisibility` на Workspace; `serializeWorkspace` отдаёт поля ПО РОЛИ зрителя (owner/admin видят всё; сотрудники — только включённые, остальные → null).
- `createWorkspace`/`acceptInvitation`/`transferOwnership` атомарны (`setSoleWorkspaceRoleTx` + инвалидация кэша ролей).

## Реквизиты (фундамент документной вертикали)

- **`WorkspaceRequisites`** (1:1): юрформа РК + налоговый режим + полное юрнаименование («name — бренд, в договор идёт юрформа») + БИН (контрольная сумма) + юрадрес + КБе + НДС (флаг+свидетельство) + **директор из сотрудников** (валидация членством; FK нет намеренно — увольнение не рвёт реквизиты) + основание подписи.
- **`WorkspaceBankAccount`** — счета СПИСКОМ с основным (модель 1С/Odoo: первый — основной сам; переключение атомарно; удаление основного передаёт роль).
- Блок в «Анкете компании» (admin+); сотрудникам виден по флагу `cardVisibility.requisites` (**по умолчанию ДА** — реквизиты печатаются на каждом счёте).
- Валидации — контрольные суммы, не длина: ИИН/БИН (два прохода весов mod 11), IBAN KZ (mod 97), БИК — чистые функции `shared/utils/requisites.ts` (те же в Zod и в веб-подсказках).

## «Видимость в Компаниях» (двухуровневая)

`users.companyCardVisibility` — что видят КОЛЛЕГИ в ростере (реквизитные поля — в `extras`, по умолчанию ВЫКЛЮЧЕНЫ); **управляющим (manager+) — нередактируемый уровень**: ИИН, ДР, адрес, удостоверение, основная карта видны всегда (комплект трудоустройства/выплат).

## Архив организаций (деактивация ОБРАТИМА)

- `DELETE /:id` = деактивация (владелец); `GET /archived` + `POST /:id/restore` (владелец; перепроверяет потолок владения). Деактивация ничего не удаляет.
- **Ретеншн 90 дней** (`archiveRetentionDays`): `archivedAt` (отдельная колонка — updatedAt двигает любая правка), `purgeAt` считает сервер. Свип — `WorkspacesCron` (ежедневно, Redis-лок) → `purgeWorkspace`.
- **`purgeWorkspace` — источник правды каскада**: схема каскадит только часть таблиц; ⚠️ `tasks.workspace_id` = SET NULL (голое удаление организации превращает её задачи в ЛИЧНЫЕ) + таблицы с workspace_id без FK (процессы, хроника, звонки, ресурсы, tuples, роли) + чаты задач/встреч. Кошелёк/магазин/финкнига НЕ удаляются (журнал неизменяем).
- Предупреждения владельцу за 7/3/1 день (`workspace.archive.expiring`; первый рубеж под остаток — максимум одно письмо за прогон; дедуп dedupKey; склонение — `pluralDays` shared). Обе ручки + DELETE сбрасывают кэш профиля (счётчик «Пространств» в Redis 5 мин).
- Дев-прогон: `POST /workspaces/dev/purge-archives` (development).

## API (кратко)

`GET /workspaces` · `POST /` · invitations (incoming/accept/reject; `:id/invitations` CRUD manager+) · `GET/PATCH/DELETE /:id` · requisites GET/PATCH + accounts CRUD · archived/restore · transfer/leave · `GET /:id/members` (ростер: роль + назначения + `member.card` по видимости владельца + `member.requisites` manager+) · `PATCH/DELETE /:id/members/:userId` (роль admin+; админа — только владелец; увольнение — каскад).

## Веб

`/workspaces/[id]` — Главная организации (сетка сервисов + статистика); `/workspaces/[id]/profile/<секция>` (6 секций, гейтинг по роли); члены — `/members`; журнал — `/journal` (manager+); «Ссылки наружу» — `/links` (manager+). Панель организаций на /dashboard: React Query на общих ключах (workspacesKey…), блок «Архив · N» с датой purge.

## Проверка

`verify-workspace-restore.cjs`, `verify-requisites.cjs`, `verify-staff.cjs`, `verify-b2b-reachability.cjs`.
