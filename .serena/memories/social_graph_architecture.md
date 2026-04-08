# Social Graph Architecture (Окружение + Папки + Notifications)

Фундаментальный модуль, на котором строятся Tasks, Calendar, Chat, Finance, Jobs Marketplace. Двусторонний подтверждённый соц. граф.

> **ВАЖНО:** Слово "Контакты" НЕ используется в UI. Для пользователя — "Окружение". Бэкенд модули `contacts/` и `circles/` — внутренняя реализация. Фронт: единая страница `/circles` = "Моё окружение" (люди + приглашения + папки-чипы). Нет отдельной /contacts страницы.

## Prisma модели (apps/api/prisma/schema.prisma)

### User (обновлён)
Добавлены поля:
- `dateOfBirth DateTime? @db.Date` — ISO date, опционально при регистрации
- `cardVisibility Json? @map("card_visibility")` — per-field флаги видимости на карточке контакта, `null` = использовать дефолты
Новые relations: `contactLinksA`, `contactLinksB`, `sentInvitations`, `receivedInvitations`, `blocksMade`, `blocksReceived`, `notifications`.

### ContactLink
```
id, userAId, userBId (канонический порядок: userAId < userBId лексикографически),
labelAForB, labelBForA (асимметричные метки — как A называет B и наоборот),
relationshipType (family|romantic|friend|professional|acquaintance|other),
initiatedBy (user_id отправителя приглашения — аудит),
confirmedAt, createdAt, updatedAt
@@unique([userAId, userBId])
```
- Удаление — двустороннее (cascade на обе стороны).
- Сервис-слой ОБЯЗАН enforce `userAId < userBId` перед вставкой.
- Клиент получает структуру `{ linkId, them: ContactUserCard, myLabelForThem, theirLabelForMe, ... }` — сервис маппит me/them по requestingUserId.

### ContactInvitation
```
id, fromUserId, toUserId (nullable!), toPhone (E.164),
proposedLabelForSender, proposedLabelForRecipient (оба опц.),
relationshipType, message (опц.),
status: pending|accepted|rejected|cancelled|expired,
expiresAt (TTL 30 дней — CONTACT_LIMITS.invitationTtlDays),
respondedAt, createdAt, updatedAt
```
- `toUserId = null` — external invitation (номер ещё не зареган).
- При регистрации: `AuthService.register` после создания user вызывает `ContactsService.activatePendingInvitationsForNewUser(userId, phone)` → все invitation с этим toPhone получают `toUserId = newUserId`, эмитится событие `contact.invitation.received` → NotificationsService пишет уведомление → отправитель видит, что получатель появился.
- **Нет rejection reason** — product решение.
- Cancel поддерживается отправителем; resend с cooldown 24ч (CONTACT_LIMITS.resendCooldownHours); throttle 30 invitations/24ч (CONTACT_LIMITS.maxInvitationsPer24h).
- Фоновая задача помечает expired.

### ContactBlock
```
id, blockerId, blockedId, createdAt
@@unique([blockerId, blockedId])
```
- Односторонний. A блокирует B → B не может отправить invitation A. Обратный блок — отдельная строка.

### Circle (новый, старый CircleMember удалён)
```
id, ownerId, name, icon?, color?, sortOrder, createdAt, updatedAt
```
- Это локальная папка у одного владельца ("Семья", "Работа", "Друзья"). НЕ групповой чат, НЕ чат-комната.
- Один и тот же ContactLink может лежать в Circles у обеих сторон независимо (у A есть "Семья" со связью A-B, у B есть "Работа" со связью A-B).

### CircleMembership
```
id, circleId, contactLinkId, addedAt
@@unique([circleId, contactLinkId])
```
- M2M между Circle и ContactLink. Владелец Circle управляет membership только своей Circle; права — через ownerId.

### Notification
```
id, userId, type (dot-namespaced), title, body?, payload Json?, actionUrl?, readAt?, createdAt
@@index([userId, createdAt])
@@index([userId, readAt])
```
- Generic для всех модулей. Types: `contact.invitation.received/accepted/rejected/cancelled`, `contact.linked/removed`, `task.assigned/completed/commented/due_soon`, `calendar.event.invited/reminder`, `system.welcome/announcement`.

## @superapp/shared (packages/shared/src)

### types/
- `user.ts` — User, UserProfile (с dateOfBirth, cardVisibility, contactsCount), CardVisibility interface
- `auth.ts` — RegisterRequest с dateOfBirth?
- `contact.ts` — Contact (me/them view), ContactUserCard, ContactInvitation, IncomingInvitation, OutgoingInvitation, SendInvitationRequest, AcceptInvitationRequest, UpdateContactRequest, BlockUserRequest, RelationshipType
- `circle.ts` — Circle, CircleWithMembers, CreateCircleRequest, UpdateCircleRequest, AddToCircleRequest, ReorderCirclesRequest
- `notification.ts` — Notification<TPayload>, NotificationType (union), per-type payload интерфейсы, NotificationListResponse, MarkNotificationsReadRequest

### validation/
- `auth.ts` — registerSchema с dateOfBirthSchema (YYYY-MM-DD, 1900..today)
- `contact.ts` — sendInvitationSchema, acceptInvitationSchema, updateContactSchema, blockUserSchema, relationshipTypeSchema
- `circle.ts` — createCircleSchema, updateCircleSchema, addToCircleSchema, reorderCirclesSchema

### constants/
- `contacts.ts` — `RELATIONSHIP_TEMPLATES` (Record<RelationshipType, string[]> — примеры "жена/муж/друг" по категориям, пользователь может вводить custom), `DEFAULT_CIRCLE_PRESETS`, `CONTACT_LIMITS` (maxCirclesPerUser=50, maxMembersPerCircle=500, maxPendingOutgoingInvitations=100, invitationTtlDays=30, maxInvitationsPer24h=30, resendCooldownHours=24)
- `card-visibility.ts` — `DEFAULT_CARD_VISIBILITY` (dateOfBirth false, age true, onlineStatus true, maritalStatus false, city true, bio true), `resolveCardVisibility(stored)` merger
- `notifications.ts` — `NOTIFICATION_REGISTRY: Record<NotificationType, NotificationMeta>` с шаблонами title/body/icon/pushByDefault/category для каждого типа, `NOTIFICATION_LIMITS` (pageSize 30, retentionDays 90)

## Card visibility правило
**Всегда видны** (независимо от флагов): `firstName`, `lastName`, `phone`, `role` (метка противоположной стороны на ContactLink).
**Кастомизируется владельцем карточки**: dateOfBirth, age, onlineStatus, maritalStatus, city, bio, extras.
`null` в БД = дефолты. UsersService.getProfile вызывает `resolveCardVisibility` чтобы всегда вернуть полный объект.

## Implementation (Phase 4-5, ✅ ALL DONE)

### Phase 4 — NotificationsModule (`apps/api/src/modules/notifications/`) ✅
- `notifications.service.ts`: `notify(userId, type, payload)` — рендер `{{placeholder}}` шаблонов из NOTIFICATION_REGISTRY, cursor-пагинация `list()`, `markRead()`, `delete()`
- `notifications.controller.ts`: `GET /api/notifications`, `POST /mark-read`, `DELETE /:id`
- `notifications.events.ts`: `NotificationsEventsListener` подписан на `contact.*`, `task.*`, `calendar.*` через EventBus
- `@Global()` модуль

### Phase 5 — ContactsModule (`apps/api/src/modules/contacts/`) ✅
- `contacts.service.ts`: canonical ordering, sendInvitation (throttle + cooldown + block check), accept (ContactLink + labels + auto-circle), reject/cancel/resend, removeContact (bilateral), listContacts (me/them mapping + cardVisibility), `activatePendingInvitationsForNewUser(userId, phone)`
- `contacts.controller.ts`: все /api/contacts/* эндпоинты + /invitations/* + /blocks
- Events: `contact.invitation.sent/activated/accepted/rejected/cancelled`, `contact.linked`, `contact.removed`, `contact.blocked`
- `@Global()` — чтобы AuthService мог инжектить без циклической зависимости

### Phase 5 — CirclesModule (`apps/api/src/modules/circles/`) ✅
- `circles.service.ts`: CRUD Circle, addMember/removeMember CircleMembership, reorder, enforce ownerId + CONTACT_LIMITS
- `circles.controller.ts`: /api/circles/* эндпоинты

### Интеграция ✅
- `AuthService.register` инжектит `ContactsService` напрямую (@Global) и вызывает `activatePendingInvitationsForNewUser(user.id, user.phone)` после транзакции создания user
- Все три модуля зарегистрированы в `app.module.ts` в порядке: NotificationsModule → ContactsModule → CirclesModule → TasksModule → CalendarModule
- `tsc --noEmit` + `nest build` проходят чисто. API запускается, все маршруты видны в Swagger

### Тестирование — ожидается end-to-end
- 3 тестовых аккаунта созданы (см. memory `test_credentials`)
- Нужно проверить: invitation send/accept flow, external invitation activation, circles CRUD, blocks

## Ключевые решения (не менять без обсуждения)
- Role templates — плоские строки, НЕ отдельная таблица. Примеры в RELATIONSHIP_TEMPLATES, пользователь может ввести любой custom текст.
- lastName и dateOfBirth — опциональны при регистрации ("желательно, но не обязательно").
- Canonical ordering userA<userB — на service layer, не через триггеры БД.
- Circle — папка внутри Окружения у одного владельца, НЕ групповой чат. Групповые чаты будут отдельной сущностью в будущем.
- Notifications — отдельный модуль с EventBus subscription, НЕ напрямую из каждого сервиса.
- Нет rejection reason на invitation — product решение.
- Card visibility — 4 всегда видимых поля + остальное per-field через JSONB.
- **"Контакты" как отдельная сущность/страница/слой — отклонено.** Всё через "Окружение".
- PersonCard вынесен в отдельный файл `apps/web/src/app/circles/PersonCard.tsx` — стиль скетча на текстурной бумаге.
- Роли при приглашении: 13 пресетов (Жена, Муж, Мама, Папа, Сын, Дочь, Семья, Родственник, Друг, Коллега, Одноклассник, Однокурсник, Клиент) + свободный ввод. `relationshipType` автоопределяется из пресета (family/friend/professional/acquaintance/other).
- `GET /api/users/lookup?phone=...` — поиск по номеру для формы приглашения (показывает имя до отправки).
- InvitationCard — единый компонент для входящих/исходящих. Роли отображаются как "Я: Тренер" / "tester2: Клиент".
- ContactUserCard расширен: +bio, +city, +email, +maritalStatus, +socialLinks. `toContactUserCard()` в contacts.service.ts применяет `resolveCardVisibility()` ко всем новым полям — скрытые возвращаются как null.
- UserCardRow и userCardSelect() в contacts.service.ts обновлены для select новых полей из Prisma.
- PersonCard compact в окружении показывает все видимые поля (город, био, дата рождения, семейное положение, email, соц. сети).
- PersonCard full в профиле показывает все поля + тогглы видимости (ON=видно, OFF=opacity 0.3).
