# Окружение (Circle) — социальный граф

> Приложение-фундамент экосистемы. Для пользователя всё — **«Окружение»** (слово «Контакты» в UI и документации НЕ используется; бэкенд-модули `contacts/` и `circles/` — внутренняя реализация). На нём стоят все сервисы «между людьми». Модель несущая — менять осторожно.

Код: `apps/api/src/modules/contacts/` (связи, достижимость, PersonalGraphRegistry) + `apps/api/src/modules/circles/` (Группы); веб — `apps/web/src/app/circles/`.

## Продуктовая модель

- Добавить человека **с ролью как в жизни**: ровно одна роль на сторону («Муж», «Коллега»), она же подпись на карточке. Нет relationshipType и отдельных «меток» (отвергнуто).
- **Группы** (Circle: «Семья», «Коллеги») — пользователь создаёт сам; по Группам настраивается видимость карточки.
- Flow: номер → две роли → приглашение → принятие → оба видят друг друга → каждый сам раскладывает по Группам.

## Модель данных

- **`ContactLink`** — подтверждённая связь. Канонический порядок `userAId < userBId` (`@@unique`). Роли асимметричны: `roleAForB`/`roleBForA` (`@map` на label-колонки). `initiatedBy` — кто отправил приглашение (аудит). Удаление двустороннее.
- **`ContactInvitation`** — pending-запрос; `toUserId` nullable (external — номер ещё не зарегистрирован; активация при регистрации/смене номера — `activatePendingInvitationsForNewUser`). Статусы pending→accepted/rejected/cancelled/expired; TTL 30 дней; resend cooldown 24ч; лимиты `CONTACT_LIMITS`; партиальный unique `(from, to_phone) WHERE pending`. `autoAddToCircleIds` — группы отправителя, куда контакт ляжет при принятии. Причин отказа нет (решение продукта). **История не-pending хранится 30 дней** (`CONTACT_LIMITS.nonPendingRetentionDays`) — на ней держатся кулдаун resend, суточный лимит и сама кнопка «Отправить повторно»; `ContactsCron` (ежечасно, Redis-лок) помечает просроченные и удаляет не-pending старше ретеншна; просроченные скрываются из списков СРАЗУ фильтром по `expiresAt`, не дожидаясь крона.
- **`ContactBlock`** — односторонний блок; блок УДАЛЯЕТ ContactLink (продуктовое правило) и гасит внешние приглашения по номеру.
- **`Circle`** + **`CircleMembership`** (M2M с ContactLink) — Группы; несут `cardVisibility` и `calendarVisibility`.

## Видимость карточки (field-слой, НЕ core/access)

Всегда видны: имя, фамилия, телефон, роль. Остальное — по Группам (`Circle.cardVisibility`); зритель в нескольких Группах → **объединение** (`mergeVisibilities`; пустой список fail-closed); ни в одной → дефолт владельца (`users.card_visibility`). Общий инструментарий — `packages/shared`: константы `DEFAULT_CARD_VISIBILITY`/`resolveCardVisibility`/`mergeVisibilities` (`constants/card-visibility.ts`) + ЕДИНАЯ Zod-схема `cardVisibilityObjectSchema` (`validation/card-visibility.ts`) — одно описание формы и для `/users/me`, и для `/circles`. **Группа без своей настройки наследует дефолт владельца, а не платформенный** (иначе добавление в свежую группу раскрывало скрытые поля). `PATCH /users/me` мержит карту, не заменяет. Отдельный набор — `users.companyCardVisibility` («Видимость в Компаниях», двухуровневая — [workspaces.md](workspaces.md)). В личном Окружении реквизиты не показываются вовсе.

## Санкционированные методы (копии запрещены)

- **`assertReachable(ownerId, ids, msg?, opts?)`** — единый гейт «между людьми»: связь + нет блока в обе стороны; в контексте организации — со-членство командными ролями («рабочий пропуск»); `{personalOnly:true}` — для личных ресурсов; `alwaysCheckBlocks` — DM; `filterReachable` — не бросающая версия для фоновых путей.
- **`resolveCircleMemberIds(ownerId, circleId)`** — ЕДИНСТВЕННЫЙ законный разворот Группы в людей (проверяет владение и гейтит состав; `{gate:false}` — только системные пути). Две разъехавшиеся копии уже стоили дыры в гейте.
- `listCircleIdsWhereMember`, `searchContactUsers`, `filterCoworkers` — вместо прямых чтений таблиц графа.
- **`resolveVisibilityForViewer(ownerId, memberships, ownerCardVisibility)`** — санкционированный резолв видимости карточки при просмотре; Группы владельца тянутся ОДНИМ findMany в listContacts (без N+1).
- **`PersonalGraphRegistry`** — выдал грант человеку из окружения → зарегистрируй `{onUnlinked}`; разрыв связи/блок снимает доступ (идемпотентно). Потребители: finances, calendar, shop, drive.

## Два режима Группы в сервисах (не смешивать)

- **Назначение/приглашение** (задача на группу, звать на событие) = разворот в **СНИМОК** участников на момент действия;
- **Аудитория/видимость** (шеринг календаря/витрины/вишлиста, скины) = **живой** принципал `circle` в core/access.

## Правила, выученные ревью (вечные)

- Принятие приглашения проецирует членство в access СРАЗУ (не ждёт ночной сверки); встречное приглашение не виснет; телефон отправителя маскируется до подтверждения связи; списки приглашений отдают пре-линк карточку (`maskLastName` + обнулённая анкета) — иначе исходящее приглашение раскрывало анкету целиком.
- Удаление группы снимает и рёбра, где она получатель гранта.
- Личные ресурсы шарятся только по личной связи (`personalOnly`).
- Регистрация активирует приглашения ДЖОБОМ в транзакции (не после коммита).

## UI

`/circles` — единая страница «Моё окружение»: грид людей (PersonCard L → клик XL), приглашения (вход/исход + история с canResend), «Заблокированные», чипы-Группы (фильтр + редактор видимости Группы), форма добавления по номеру (lookup c инициалом фамилии, два RolePicker с пресетами). Отдельной страницы /contacts НЕТ.

## API (кратко)

`GET/PATCH/DELETE /contacts…` · `POST /contacts/invitations` + incoming/outgoing(+history)/accept/reject/cancel/resend · blocks CRUD · `GET/POST/PATCH/DELETE /circles…` + members + reorder. `GET /users/lookup?phone=` — фамилия инициалом, лимит 30/час.

## Проверка

`verify-circle-review.cjs`, `verify-contacts-hardening.cjs`, `verify-block-enforcement.cjs`, `verify-circle-access-revoke.cjs`.
