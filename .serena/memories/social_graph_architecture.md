# Social Graph Architecture (Окружение + Группы + Notifications)

Фундаментальный модуль, на котором строятся Tasks, Calendar, Chat, Finance, Jobs Marketplace. Двусторонний подтверждённый соц. граф. Tasks/Calendar пока к нему НЕ привязаны.

> Слово «Контакты» НЕ в UI — для пользователя «Окружение». Бэкенд-модули `contacts/` + `circles/` — реализация. Фронт: единая страница `/circles` = «Моё окружение» (люди + приглашения + чипы-Группы). Нет отдельной /contacts.

## Модель (ВАЖНО — итог большого рефакторинга)

- **Роль**: ровно ОДНА роль на сторону, асимметрично (ты ему «Муж», он тебе «Жена»). Реальная роль из жизни, показывается на карточке. **Нет** `relationshipType` (6 категорий) и **нет** «меток»/`label` — это убрано как лишнее.
- **Группа** = `Circle` (пользователь создаёт и называет сам: «Семья», «Родственники»). Ручное членство через `CircleMembership`. Несёт `cardVisibility`.
- **Видимость карточки — ПО ГРУППАМ**. Зритель в ≥1 Группе владельца → объединение их `cardVisibility` (`mergeVisibilities`, OR). Ни в одной → дефолт владельца `users.card_visibility` (одиночная `CardVisibility`). Всегда видны: firstName, lastName, phone, role.

## Prisma (apps/api/prisma/schema.prisma)

- `User.cardVisibility Json? @map("card_visibility")` — одиночная `CardVisibility` = видимость ПО УМОЛЧАНИЮ (для тех, кто не в Группе).
- `ContactLink`: `userAId<userBId` (canonical, service-layer), `roleAForB` `@map("label_a_for_b")`, `roleBForA` `@map("label_b_for_a")` (Prisma-поля переименованы, DB-колонки те же → данные сохранены), `initiatedBy`, confirmedAt. `@@unique([userAId,userBId])`. Удаление двустороннее.
- `ContactInvitation`: `proposedRoleForSender` `@map("proposed_label_for_sender")`, `proposedRoleForRecipient` `@map("proposed_label_for_recipient")`, `toUserId` nullable (external), status pending|accepted|rejected|cancelled|expired, `message`. БЕЗ relationshipType.
- `ContactBlock`: односторонний, `@@unique([blockerId,blockedId])`.
- `Circle`: ownerId, name, icon?, color?, sortOrder, **`cardVisibility Json? @map("card_visibility")`**.
- `CircleMembership`: M2M Circle↔ContactLink, `@@unique([circleId,contactLinkId])`.
- `Notification`: generic (userId, type dot-namespaced, title, body?, payload?, actionUrl?, readAt?).
- **Миграции Prisma в репо НЕТ → только `db push`.** `relationship_type` (x2) удалён (данные категории потеряны — ок); label-колонки сохранены.

## @superapp/shared (packages/shared/src)

- `types/contact.ts` — `Contact { linkId, them, myRole, theirRole, initiatedBy, confirmedAt, myCircleIds }`; `ContactInvitation` с `proposedRoleForSender/Recipient`; DTO `SendInvitationRequest{toPhone,proposedRoleForRecipient?,proposedRoleForSender?,message?,autoAddToCircleIds?}`, `AcceptInvitationRequest{myRole?,theirRole?,autoAddToCircleIds?}`, `UpdateContactRequest{myRole?}`. **Нет типа `RelationshipType`.**
- `types/user.ts` — `UserProfile.cardVisibility: CardVisibility` (одиночная). Нет `CardVisibilityByRole`.
- `types/circle.ts` — `Circle.cardVisibility: CardVisibility`; `UpdateCircleRequest.cardVisibility?: Partial<CardVisibility>|null`.
- `validation/card-visibility.ts` (общий) — `cardVisibilityObjectSchema` (`.strict()`); используется в `validation/user.ts` (updateProfileSchema.cardVisibility одиночная) и `validation/circle.ts` (updateCircleSchema.cardVisibility).
- `validation/contact.ts` — `roleSchema` (1-50, noHtml), `sendInvitationSchema/acceptInvitationSchema/updateContactSchema` без relationshipType. Нет `relationshipTypeSchema`.
- `constants/contacts.ts` — `ROLE_PRESETS: readonly string[]` (плоский: Муж/Жена/Мама/.../Клиент), `DEFAULT_CIRCLE_PRESETS`, `CONTACT_LIMITS` (invitationTtlDays=1, maxInvitationsPer24h=30, resendCooldownHours≈10сек dev). Нет `RELATIONSHIP_TEMPLATES`.
- `constants/card-visibility.ts` — `DEFAULT_CARD_VISIBILITY`, `resolveCardVisibility`, `mergeVisibilities(list)` (база all-OFF, OR). Нет per-role резолверов.

## Резолв видимости (contacts.service.ts)

- `userCardSelect()` включает `cardVisibility` владельца (дефолт).
- `membershipSelect()` = `{ circleId, circle:{ ownerId, cardVisibility } }`.
- `resolveVisibilityForViewer(ownerId, ownerDefault, memberships)`: Группы владельца (`circle.ownerId===ownerId`), содержащие этот link → `mergeVisibilities`; иначе `resolveCardVisibility(ownerDefault)`.
- `mapLinkToContact`: `them`=владелец карточки; myRole/theirRole из roleAForB/roleBForA по стороне; видимость через резолвер; `toContactUserCard(row, visibility: CardVisibility)` принимает готовую видимость. Группы тянутся в `listContacts`/`getContact` одним include (без N+1).
- Инвайты (`listIncoming/OutgoingInvitations`): видимость = `resolveCardVisibility(user.card_visibility)` (групп ещё нет).
- `CirclesService`: `listCircles/getCircle/serialize` отдают резолвнутый `cardVisibility`; `updateCircle` принимает `cardVisibility` (мердж в полную карту, `Prisma.JsonNull` при null); `assertOwned`/limits/ручное членство — как было. Сообщения «группа» вместо «окружение».
- `UsersService.getProfile` → `cardVisibility: resolveCardVisibility(...)` (одиночная). `updateProfile` хранит одиночную.

## Web (apps/web/src)

- `/circles`: поток добавления — телефон → lookup имени → 2× `RolePicker` (Моя роль / Его роль; `ROLE_PRESETS` из shared + «Свой вариант»); шлёт `proposedRoleForRecipient`(=invTheyForMe)/`proposedRoleForSender`(=invMeForThem). «+ Группа», `GroupVisibilityEditor` (виден при выбранной Группе; debounced `PATCH /circles/:id {cardVisibility}`; оптимистично обновляет `groups`). InvitationCard читает `proposedRole*`.
- `PersonCard.tsx`: локальный `Contact` без relationshipType; бейдж = `contact.myRole`. `FullProps.onToggleVisibility` опционально (без него read-only `ReadOnlyRow`).
- `/profile`: сайдбар, «Моя карточка» первой и по умолчанию (read-only PersonCard + `<select>` «По умолчанию / Группа X», берёт `group.cardVisibility` из `/circles`); «Моя Анкета» (форма + блок «Видимость по умолчанию» — тумблеры одиночной `CardVisibility`, debounced `PATCH /users/me {cardVisibility}`).
- `lib/stores/auth.ts`: `UserProfile.cardVisibility?: CardVisibility` (одиночная), импорт `CardVisibility` из shared.

## Notifications / Invitations / Blocks (без изменений по сути)

- `NotificationsEventsListener` подписан на `contact.*/task.*/calendar.*`, форвардит payload в `notify`. Шаблоны `NOTIFICATION_REGISTRY` используют только `{{fromName}}/{{message}}/{{byName}}/{{otherName}}` — переименование payload-ключей безопасно. `ContactInvitationReceivedPayload`: `proposedRoleForRecipient`, без relationshipType.
- `AuthService.register` инжектит `ContactsService` (@Global) → `activatePendingInvitationsForNewUser`. Canonical userA<userB на service-layer. P2002 на concurrent accept. `ContactsCron` чистит инвайты.

## Отвергнуто — НЕ возвращаться

- 6 авто-категорий `relationshipType` для видимости.
- Системная папка «Незнакомец?» / per-folder с union+ensureDefaultCircle.
- Двойные асимметричные «метки» + отдельный category. Теперь: ОДНА роль/сторона, видимость по Группам, дефолт `users.card_visibility`. Та же форма «сегмент→видимость» переносима на B2B/marketplace через Universal Identity (`UserRole.role`) + существующий NotificationsModule (рассылки).

## Статус

Рефактор выполнен и проверен: `pnpm build` 4/4, `tsc --noEmit` api+web чисто, E2E (login/contacts/circles/visibility) OK. Данные 3 тест-аккаунтов сохранены (роли «Бог»/«Дог» уцелели через `@map`). Тест-аккаунты — см. memory `test_credentials`.
