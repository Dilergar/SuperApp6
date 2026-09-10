# core/notifications — движок уведомлений (17-й)

> Уведомление = **событие + строка на адресата + журнал доставки** (Odoo `mail.message`/`mail.notification`, Knock). Продюсер решает КОМУ (фича знает семантику), движок — КАК: каналы, предпочтения, политика организации, тишина, схлопывание, presence-aware push. Один сквозной центр в топбаре с чипами контекстов и раздельными бейджами; «Упоминания» — вкладка ленты, отдельной модели нет; «Ждут решения» — отдельная очередь обязательств ([approvals_engine.md](approvals_engine.md)), уведомление лишь ведёт в неё.

Код: `apps/api/src/core/notifications/` (`notifications.service.ts` — `send`/лента/состояния · `notifications.fanout.ts` — джобы фанаута · `notifications.delivery.ts` — канальные джобы · `notifications.preferences.service.ts` · `notifications.policy.service.ts` · `notifications.settings.service.ts` — тишина/устройства · `notifications.quiet.ts` · `notifications.render.ts` · `notifications.registry.ts` — реестры · `channels/webpush.driver.ts`, `channels/email.driver.ts` · `notifications.controller.ts`, `notifications.policy.controller.ts` · `notifications.cron.ts`). Реестр типов — `packages/shared/src/notifications/` (файл на сервис + `index.ts`), формы провода — `packages/shared/src/types/notification.ts`, Zod — `validation/notification.ts`. Веб — `apps/web/src/components/notifications/`, `apps/web/src/app/notifications/`, `apps/web/src/app/profile/NotificationsSection.tsx`, `apps/web/src/app/workspaces/[id]/profile/WorkspaceNotificationPolicySection.tsx`, клиент `apps/web/src/lib/notifications-api.ts`.

## Модель данных

| Модель (`@@map`) | Смысл | Ключи |
|---|---|---|
| `NotificationEvent` (`notification_events`) | Одно событие продюсера: type, service/priority (денорм), payload, ref, actorId, workspaceId, reason, `recipients` (как передал продюсер), `options`, `snapshot` (текст в `SOURCE_LOCALE` — фолбэк ушедшего типа) | партиальный unique `(type, idempotency_key)` — идемпотентность у источника |
| `Notification` (`notifications`) | Строка ленты адресата; `eventId` = ПОСЛЕДНЕЕ схлопнутое событие; `workspaceId` — контекст строки (организация события, ЕСЛИ адресат — член, иначе `null` = «Личное»); `collapseKey`/`collapseCount`/`actorIds`; seen/read/archived/saved/snoozedUntil; `sortAt` (поднимается при схлопывании и пробуждении) ≠ `createdAt` | партиальный unique `(user_id, collapse_key) WHERE read_at IS NULL AND archived_at IS NULL`; `(user_id) WHERE seen_at IS NULL` — бейдж; keyset `(userId, sortAt, id)`; `(eventId)` и `(workspaceId)` — каскад/ретеншн событий и архив строк организации |
| `NotificationDelivery` (`notification_deliveries`) | **Леджер идемпотентности фанаута** + журнал: `recipient` (`user:<id>` \| `chat:<id>`), channel, status `queued/sent/delivered/failed/skipped`, `skipReason` (`pref_off/policy/muted/quiet/no_device/driver_not_configured/no_access/actor/throttled/seen/burst/no_phone/budget/expired`) | unique `(eventId, recipient, channel)`; ретеншн 30 дней |
| `NotificationPreference` | Разреженные переопределения человека: `context` (`personal` \| workspaceId — строка, не NULL), `subjectKind` service/type, channel `inapp/push/sms`, enabled | unique по пятёрке |
| `WorkspaceNotificationPolicy` | Дефолты + замки организации: mode `default_on/default_off/locked_on` (только inapp/push) | unique `(workspaceId, subjectKind, subjectKey, channel)` |
| `NotificationSubscription` | `mute` \| `follow` на объект (refType, refId) | unique `(userId, refType, refId)` |
| `NotificationDevice` | Устройство push: platform web/ios/android, provider webpush/expo/fcm, token (endpoint), subscription, lastSeenAt, failureCount, disabledAt | unique `(provider, token)` |
| `UserNotificationSettings` | Тишина: `quietSchedule` `[{days:[1..7], from, to}]` в `User.timezone` + `pausedUntil` | 1:1 к User |

## Реестр типов (`packages/shared/src/notifications/`)

Тип — декларируемая сущность: `{ service, priority, icon, contexts, collapse, defaultChannels?, throttle?, ttlSec?, lockable?, smsEligible? }`. Union `NotificationType = keyof` реестра — руками не пишется. Новый сервис = +1 файл `<service>.ts` + строка в `NOTIFICATION_SERVICES` (`types.ts`) + ключи `notifications.<type>.title|label` (+`body`, `collapsed`) в трёх каталогах. `icon` — ключ реестра Phosphor веба, не эмодзи.

- **Приоритет** (Android importance + Novu critical): `critical` — неотключаем, скрыт из матрицы, пробивает тишину и mute, кандидат на SMS · `high` — «адресно мне» (in-app+push) · `normal` — ход дел (in-app) · `low` — FYI (in-app, схлопывается).
- **Схлопывание** (Teams chainId / FCM collapse_key): `none` · `ref` (`type:refType:refId`) · `ref_actor` · `type` (скоупится контекстом строки: 12 смен → «Изменено 12 ваших смен»). Продюсер может передать свой `collapseKey`.
- **Троттлинг** `throttle {windowSec, max}` на пару (адресат, collapseKey) — заменил самодельный `share.link.opened.muted`.
- Страж `pnpm check:i18n` роняет CI, если у типа реестра нет `.title` в любой локали или в каталоге остался `.title/.body/.collapsed` типа, которого нет в реестре.

## Контракт продюсера

```ts
notifications.send(tx, {
  type, to: Array<{ userId } | AudienceRef | { chatId }>,   // chatId — объект-получатель канала chat
  payload?, ref?: { type, id }, actorId?, workspaceId?, reason?,   // reason: mention|assigned|requested|participant|owner|manager|subscribed|system
  collapseKey?, idempotencyKey?, actionUrl?, channels?, includeActor?, audienceCtx?, budget?: 'workspace',
}) → { eventId } | null   // null — повтор idempotencyKey
```

- `tx` обязателен там, где есть транзакция мутации (outbox: `NotificationEvent` + `enqueue(tx, 'notifications.fanout')`); `null` — только кроны/пост-коммит.
  ДОЛГ: по факту `tx` передают единицы (approvals, calendar), остальные продюсеры зовут `send(null, …)` пост-коммитом — как и `chatter.log(null, …)` рядом. Смерть процесса между коммитом мутации и `send` теряет уведомление; перевод продюсера на `tx` — вместе с миграцией его сервиса.
- `send` прав НЕ проверяет (как все system-методы движков); при фанауте движок ОТСЕИВАЕТ адресатов без права видеть `ref` через `NotificationRefRegistry.canViewMany` (батчем — правило Jira).
- Актор вычитается по умолчанию (`includeActor` для редких случаев). `to` принимает `AudienceRef` core/audiences (отдел/должность/объект/руководитель) — движок разворачивает и дедуплицирует; подписчики `follow` на `ref` добавляются сами.
- `budget: 'workspace'` — программируемые продюсеры (нода Процессов «Уведомить»): скользящее окно 10 000 событий/час на организацию → `badRequest('notification.rateLimited')`.
- Доменные события для других листенеров — отдельно через `EventBusService.emit` (Slack: «о чём» ≠ «как»); `emitEvent` и карта `notifications.map.ts` больше не существуют.

## Пайплайн

**Джоб `notifications.fanout`** (очередь `notifications`, идемпотентен, `eventId` в каждой строке лога): разворот `to` → отсев без права → членство адресатов в `workspaceId` одним запросом → контекст строки → эффективные каналы на каждого → ОДНА tx на чанк: `INSERT NotificationDelivery(event,user:<id>,inapp) ON CONFLICT DO NOTHING` (не легло → адресат уже обработан) → схлопывание/вставка строки одним `INSERT … ON CONFLICT (user_id, collapse_key) WHERE … DO UPDATE` (count++, actorIds ∪, sortAt=now, snoozed сброшен, **seen сброшен** — бейдж зажигается снова) → строки доставки прочих каналов (`skipped` с причиной) → канальные джобы. После коммита — `events.emit('notifications.created')` → realtime. >500 адресатов → дочерние `notifications.fanout.chunk`.

**Эффективные каналы** (Novu «частное побеждает»): critical → inapp+push всегда, sms при opt-in; иначе mute на ref (кроме `reason=mention`) → ничего; иначе override типа → override сервиса → политика организации (`locked_on` → вкл; `default_*`) → дефолт реестра. «In-app выключен» = строка НЕ создаётся (канальная семантика Knock). Затем тишина (расписание/пауза в `User.timezone`) откладывает push/SMS; presence (`PresenceProviderRegistry`, регистрирует мессенджер) откладывает push на 2 мин при онлайне.

**Каналы**:
- `inapp` — строка ленты + realtime `notification:new` ([realtime_engine.md](realtime_engine.md)).
- `push` — джоб `notifications.deliver.push` = **батчер на человека** (`uniqueKey push:<userId>`; при `inserted=false` ставится парный догоняющий `push:<userId>:next`; critical — своим ключом и сразу). В момент доставки: перепроверка тишины, `skipped: seen` (строка уже просмотрена), `expired` (ttlSec), burst guard (≥5 push за 5 мин → только сводные «N новых»), сводный push при >1 строке. Отложенное тишиной и хвост страницы (>200 созревших) поднимают СЕБЯ парным ключом (`push:<id>:quiet(:next)` / `:tail(:next)`) — «уже идёт» ≠ «уже учтено». Драйвер `webpush` (VAPID, `web-push`): endpoint подписки — адрес из данных → **белый список хостов push-служб** `isAllowedWebPushEndpoint` (fcm.googleapis.com, updates.push.services.mozilla.com, web.push.apple.com, `*.notify.windows.com`) при регистрации И перед отправкой; 404/410 или 3 отказа подряд → `disabledAt`; `lastSeenAt` старше 60 дней → крон отключает. `expo`/`fcm` — контракт `PushDriver`, живые драйверы на mobile-этапе (`skipped: driver_not_configured`).
- `sms` — только critical + `smsEligible` + opt-in человека (preference `channel: 'sms'` в контексте), KZ-номер, суточные потолки человека (10) и организации (500) в Redis по образцу `SmsOutboundService`; драйвер `VerifySmsService` (kazinfoteh|mock — в dev код в лог). Текст `notifications.sms.text` + абсолютный deep link.
- `chat` — объект-получатель `{chatId}`; драйвер регистрирует мессенджер (`MessengerNotificationsProvider`): рич-карта от актора, если `ref` рендерится в core/rich-cards и актор есть, иначе системное сообщение (authorId=null, как плашки хроники — в непрочитанное чата не попадает; текст перерисовывается в языке читателя из type+payload). Тем же драйвером ходит `rich-cards.shareToChat` — ребро `core/rich-cards → modules/messenger` закрыто. Транзиентный сбой оставляет доставку в `queued` (иначе ретрай упёрся бы в собственный гвард «не queued → выходим»); `gone` — `skipped`.
- `email` — контракт `EmailDriver` без живой доставки (`NullEmailDriver`); в UI не показывается.

## Реестры (направление «фича → движок»)

- `NotificationRefRegistry.register(refType, { canViewMany(userIds, refId), href(ref, {workspaceId}), richCardType? })` — регистрируют владельцы сущностей (`*-notification-refs.provider.ts` в tasks, calendar, shop, approvals, sign, documents, drive, notes, objects, hr, office, processes, workspaces, contacts, finances, recorder, share-links, calls; мессенджер — `chat`/`chat_message`). Хелперы батча — `notifications.ref-helpers.ts` (`workspaceMembersOf`, `intersect`).
- `NotificationChannelRegistry.registerPush(driver) / registerChat(driver) / registerEmail(driver)`.
- `PresenceProviderRegistry.register({ isOnline(userIds) })` — мессенджер (`PresenceService.onlineOf`, один MGET).

## HTTP API (`/api/v1/notifications`, статика ДО `:id`)

`GET /notifications?cursor&context=personal|<wsId>&service&state=all|unread|saved|snoozed|archived&mentions=1` → `NotificationPageDto` (страница цельной + `actors`/`workspaces` пачкой; `href` из actionUrl/реестра; `richCardType`) · `GET /counts` → `{unseen, byContext}` · `POST /seen {ids?}` · `POST /read {ids?|all, context?}` · `POST /:id/read|unread|archive|unarchive|save|unsave|snooze {until}|unsnooze` · `DELETE /:id` (в UI нет) · `POST|DELETE /mute {refType, refId}` · `GET|PUT /preferences?context=` (разреженные + эффективная матрица + замки; `enabled: null` снимает) · `POST /preferences/copy-to-workspaces {fromContext}` (копирование, не наследование) · `GET|PUT /quiet` · `POST /quiet/pause {minutes|untilMorning|clear}` · `GET /vapid-public-key` · `GET|POST|DELETE /devices` · `GET|PUT /workspaces/:id/notification-policy` (admin/owner) · dev: `GET /dev/deliveries?userId|eventId`, `POST /dev/send`, `POST /dev/retention`.

Отказы: `notification.notFound` · `notification.policy.forbidden` (замок) · `notification.policy.notLockable` · `notification.policy.noAccess` · `notification.critical.immutable` · `notification.context.notMember` · `notification.device.invalidEndpoint` · `notification.push.notConfigured` · `notification.rateLimited` · `notification.snooze.tooFar|inPast` · `notification.sms.notEligible` · `notification.chat.notConfigured`.

## Несущие правила

- **seen ≠ read ≠ archived**: бейдж = unseen; открыл панель → показанные `seen`, жирные до клика; «Готово» (archive) убирает из основного вида; Saved — вне ретеншна (90 дней всем, доставки 30); отложенное (`snoozedUntil > now`) не трогается.
- Текст — **render-at-read** в языке запроса (`notifications.<type>.title|body`, `.collapsed` при count>1); push/SMS рендерятся в момент доставки в `User.locale`.
- **Слово в payload — КЛЮЧОМ**: `kindLabelKey: 'hr.esutdKind.contract'` вместо `kindLabel: 'Заключение договора'`; `resolveLabelKeys` подставит перевод под именем без суффикса при каждом чтении и при каждой доставке ([i18n.md](i18n.md)). Готовая строка в payload застыла бы в языке продюсера — то есть у джоба это язык по умолчанию, а не адресата.
- **Адресат в payload — СНИМКОМ**, с суффиксом `Audience` (`assigneeLabelAudience` = `{kind, id, key, name}` из `AudiencesService.labelSnapshot`): подпись собирает `resolveAudienceLabels` в языке АДРЕСАТА ([audiences_engine.md](audiences_engine.md)). Правило `i18n/no-viewer-text-in-payload` (`lint:guard`) не пускает в payload готовый текст вообще.
- **Дата в payload — МАШИННОЙ**, с суффиксом `Iso` (`periodIso: '2026-09'`, `untilIso: '2026-09-11'`): `resolveIsoValues` развернёт её форматтерами АДРЕСАТА под именем без суффикса. Запечённая строка была бы и языком, и регионом того, кто её записал — а уведомление о рубеже читает руководитель, и месяц он ждёт своими словами.
- Контекст строки — по ЧЛЕНСТВУ адресата, не по событию: приглашение в организацию у не-члена лежит в «Личном». Исключение из организации архивирует её строки (`archiveWorkspaceRows`), не удаляет.
- Mute объекта не глушит личное упоминание и critical (Google Chat / GitHub). Замок политики — только на `lockable`-типах и только inapp/push (SMS запереть нельзя — деньги организации, номер человека).
- Ретеншн не трогает `savedAt` и живой snooze; событие удаляется, когда не осталось строк адресатов.
- Разрешение на web push спрашивается НЕ при загрузке — карточкой в панели / тумблером в настройках.
- Мёртвый deep link (объект удалён после фанаута): раскрытие рич-карты при 404 → `toastError(targetGone)` и строка прочитана.

## Ловушки

- Чанк фанаута — интерактивная транзакция на сотни адресатов: дефолтные 5 с Prisma её не держат, окно задано явно (`NOTIFICATION_FANOUT_TX`). Без него P2028 сжигал бы попытки джоба, и массовая рассылка не доходила бы НИ ДО КОГО.
- Deep link push несёт `n=<id>`, и разделитель считается по ФАКТИЧЕСКОМУ адресу: он приходит и от продюсера, и из реестра, а тот бывает с query (`/messenger?chat=…`).
- Организация ушла у человека (исключение, выход) или ушла совсем (purge) — её строки АРХИВИРУЮТСЯ: `Notification.workspaceId` — колонка без FK, и переживший организацию хвост считался бы в бейдже, а чипа, чтобы его отфильтровать, уже нет.
- Продюсер собирает фразу в коде (`«осталось просрочено (4 раб. дн.)»`) — она застывает в одном языке и попадает внутрь чужой: в каталог едут ЧИСЛО и признак состояния, слова живут ветками ICU (`hr.esutd.due_soon` — образец).
- Строки, перенесённые миграцией со старой ленты, несут payload СТАРОГО формата: плейсхолдеры каталога им нечем заполнить (у `task.assigned` пустой `{taskTitle}`). Снимок текста у них есть в событии; свежие строки в порядке, ретеншн уносит старые за 90 дней.

- `collapse: 'type'` без контекста склеил бы смены РАЗНЫХ организаций — ключ всегда несёт `personal|<wsId>` строки.
- Unique на строке ленты как леджер не годится: ретрай после схлопывания накрутил бы `collapseCount` — леджер живёт в `NotificationDelivery(eventId, recipient, channel)`.
- Возврат прочитанной строки в непрочитанные при живой строке того же ключа столкнулся бы с партиальным unique — `setState` перевешивает её на собственный `eventId`.
- Батчер push с `uniqueKey`: «уже идёт» ≠ «уже учтено» — при `inserted=false` ставится парный догоняющий джоб (правило core/jobs).
- `NOTIFICATION_REGISTRY` типизирован `Record<NotificationType, NotificationTypeDef>` намеренно: сырой `as const`-union без необязательных полей не даёт читать `lockable`/`smsEligible`.
- Сьюты, ждущие строку сразу после действия, краснеют: строка рождается джобом — ждать поллингом (пример — `verify-office.cjs`).

## Веб

`NotificationBell` (топбар, сквозной; телефон → страница) · `NotificationPanel` (вкладки Все/Непрочитанные/@Упоминания, чипы контекста при ≥1 организации, пауза-луна, «Прочитать все», `PushEnableCard`) · `NotificationList` (общий список, `infiniteQueryOptions` в `lib/queries.ts`) · `NotificationRow` (PersonAvatar актора / логотип организации / системный значок, `<Icon name={icon}/>`, меню ⋯ из шести пунктов, без «Удалить») · `NotificationRichCard` (живая рич-карта через `GET /rich-cards/:refType/:refId`) · страница `/notifications` (фильтры чипами; `/mentions` → редирект `?filter=mentions`) · `/profile/notifications` (тишина, устройства с `PushToggle`, вкладки контекстов: матрица сервисы × В приложении/Push → типы, «SMS для важного» при живом драйвере, «Всегда приходят», «Применить ко всем моим организациям») · `/workspaces/[id]/profile/notifications` (политика: сегментный контрол Вкл/Выкл/Обязательно, gate manage). Колокольчик, панель, список и строка живут в `components/notifications/` (каркас держит их в корневом графе — импорты точечные, не из барабана кита); слова панели — в неймспейсе `shell`, слова страницы и настроек — в `notifications`. Сокет — `lib/realtime/useRealtime.ts`; push — `lib/notifications/usePushSubscription.ts` + `public/sw.js`.

## Проверка

`apps/api/scripts/verify-notifications.cjs` (14 секций: адресат/актор, леджер при ретрае, схлопывание, независимость наборов контекстов, critical + SMS opt-in, политика и замок, mute vs упоминание, состояния и counts, ретеншн и saved, устройства и белый список, тишина, языки, бюджет, идемпотентность) · `verify-mentions.cjs` · `verify-notify-jobs.cjs` · `verify-realtime.cjs` (`notification:new` адресату и не актору, `notification:counts` после seen, регресс мессенджера тем же сокетом) · `verify-messenger-socket.cjs` / `verify-logout-socket.cjs` · регресс эмиттеров (`verify-approvals`, `verify-office`, `verify-share-links`, `verify-workspace-restore`, `verify-richcards`…).

## Связанные доки

[realtime_engine.md](realtime_engine.md) · [jobs_engine.md](jobs_engine.md) · [audiences_engine.md](audiences_engine.md) · [rich_cards.md](rich_cards.md) · [verify_engine.md](verify_engine.md) · [i18n.md](i18n.md) · [security.md](security.md) · [messenger.md](messenger.md) · [module_graph.md](module_graph.md) · [playbook_new_service.md](playbook_new_service.md)
