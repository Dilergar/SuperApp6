# Ревью «Архитектура / Масштаб / Скорость» 2026-07-18 — ВСЁ ПОЧИНЕНО той же сессией

Метод: 5 агентов + ручная верификация → ~30 находок → пользователь сказал «чини всё полностью» → все починены (кроме 3 осознанных отложек). Verify-сьют 45 скриптов ЗЕЛЁНЫЙ, nest build + web tsc чистые, миграция `20260717210755_scale_review_fixes` (6 индексов). НЕ закоммичено.

## Что сделано (карта фиксов)
**Security:**
- Finbook-revoke: СИНХРОННО из ContactsService.deleteContact/blockUser через DI_TOKENS.FinancesService (+FinancesEvents-шина ремень 2, ночной свип FinancesCron.sweepShares «гранты без живого ContactLink» ремень 3; contacts.service.ts revokeFinbookSharesBetween, finances.service.ts sweepOrphanFinbookShares).
- NODE_ENV fail-open: ветки `|| !NODE_ENV` убраны (app.module.ts троттлер, main.ts Swagger) — отсутствие переменной = полная защита.
- uncaughtException → лог + setTimeout exit(1) 200мс (main.ts).
- prod-warn: FILES_DRIVER=local и LIVEKIT_EGRESS_DIR в env.validation.ts (console.warn, не отказ).

**Масштаб/перф API:**
- /messenger/calls/active: listMyActiveCalls ПЕРЕВЁРНУТ — CallsService.listActiveRefIds (partial-индекс, активных единицы) → членство по IN → снапшоты; пустой ответ = 1 индексный запрос. buildCallStatePayload — Redis-кэш msgr:callstate:<chatId> TTL 15с (валидность по sessionId; broadcastCallState строит fresh + перезаписывает).
- Задачи: getStats = ОДИН $queryRaw (CTE mine = creator UNION participants, COUNT FILTER ×7, ручное зеркалирование chokepoint-скоупа wsFilter — $queryRaw обходит $extends!); списки/`listForCalendar` — visibilityWhere(userId, myParticipantTaskIds) = OR(creatorId, id IN (…)). Календарь getRange: mineWhere → OR(userId, id IN участий).
- ACL: пообъектная эпоха chat (access-schema: OBJECT_EPOCH_TYPES, CHAT_PARENT_SUBJECT_TYPES; access.service: epochFor 3-компонентный, bumpEpochs с реверс-lookup зависимых чатов по subject-индексу, фолбэк тип-эпоха; 'chat' убран из EPOCH_FANOUT task/order/event/office_room/workspace; объектные эпох-ключи INCR+EXPIRE 1ч).
- JWT-кэш auth:alive:<id> TTL 60с (jwt.strategy.ts; DEL в scheduleDeletion/anonymizeAccount; только положительный кэш).
- Троттлер: один Lua CHECK_LUA на троттлер (блок-чек+INCR+PEXPIRE+SET-блока атомарно) — 6→3 Redis-опа/запрос.
- presence.statusFor: один MGET (online+lastSeen разом) вместо 100–200 последовательных GET.
- Поиск-индексация сообщений: fire-and-forget (void … catch) в send-путях (reconcile — страховка); правки остались awaited.
- Медиа-семафор shared/utils/semaphore.ts (mediaSemaphore 3 слота): files-pipeline.process + voice-audio prepareForStt.
- bcryptjs → нативный bcrypt (auth/users; deps обновлены).
- Вложения: FilesService.buildAttachmentViews (батч ссылки+мета БЕЗ пер-файловых проверок — доступ у контейнера) → messenger.attachViewsTo обогащает payload files[].view в getMessages + эхо sendAttachmentMessage; тип AttachmentFileView в shared/types/messenger.ts. FilesService.countLinkedInTx — carve-out магазина закрыт (shop attachListingImage).
- GET /mentions/unread-count (1 COUNT) — бейдж больше не качает ленту.

**Кроны/ретеншны:**
- Индексы (миграция): messages.replyToId, workspace_invitations.positionId, process_instances.versionId, notifications.createdAt, mentions.createdAt, calendar_event_reminders.sentAt. Комментарии рукописных partial-уников дописаны в модели LedgerTransfer/ProcessStepRun.
- notifications.cleanupOld — батчи 10k по индексу; sessions purge (AccountCron 03:25 + UsersService.purgeExpiredSessions); mentions ретеншн 180д + scheduled_messages sent/cancelled 30д (ScheduledMessageCron.nightlyCleanup 03:35); календарь: topUpReminders keyset+topUpOnly (без delete/recreate, без голодания >5000), purgeSentReminders 30д (CalendarCron 03:50).
- Access-бэкфиллы: keyset-батчи; backfillTasks(since?) — крон передаёт 25ч, полный только scripts/backfill-access.cjs.
- Office reconcileOrphanParticipants: keyset-круг с Redis-курсором office:reconcile:cursor.
- Google pollAndRenew: optimistic-claim CAS по lastSyncedAt.
- WalletCron: инкрементально по маркеру wallet:reconcile:last-max-id (BigInt id журнала), полный по воскресеньям.
- EventBus: MAXLEN 100k + maybeWarnLag (XPENDING/XLEN раз в 5 мин); shop expireCampaigns take 200.

**DI-токены:** shared/di-tokens.ts (DI_TOKENS 9 шт.) + AppModule.onApplicationBootstrap smoke-check (валит старт при пропаже провайдера; лог «DI tokens smoke-check: 9 ok»); потребители переведены на манифест (tasks/rich-cards/presence/workspaces/contacts/process-action-nodes); OfficeService-каскад увольнения: warn→error. Регистрации в модулях остались строками (= значения манифеста, валидирует smoke-check).

**Веб** (агент): синглтон-сокет (1 io-коннект на вкладку, подписчики Set, heartbeat с visibility-гейтом — скрытая вкладка уходит offline по TTL), CallsWatcher 20с только на видимой вкладке + refetch на visibilitychange, refetchOnWindowFocus:false глобально + retry только сеть/5xx (providers.tsx), бейдж на unread-count, AttachmentContent потребляет files[].view (фолбэк на хуки при истечении/ошибке), useFileMeta staleTime Infinity, ключи мессенджера в lib/queries.ts, office-лист 7с↔30с адаптивно, xyflow type-only в process-lib, lucide-react удалён.

**Отложено осознанно:** materialized-остатки финансов (P3 «при росте», по модели wallet), вынос CallSession.summarizedAt в таблицу потребителя (при следующей работе над движком звонков), WS token-bucket пер-юзер (пер-сокет достаточен как DoS-гигиена).

## Gotchas, найденные при починке
- `Select-Object -First N` в конвейере PowerShell УБИВАЕТ фоновый node-процесс (обрыв пайплайна) — фоновые серверы логировать только `*>> file`.
- Дев-БД: tester1 упёрся в maxWorkspacesOwnedPerUser=20 от накопленных verify-прогонов → verify-office/files-consumers падали на создании организации (НЕ регрессия); лечится `UPDATE workspaces SET is_active=false WHERE owner_id=tester1`.
- verify-messenger-calls: чек «уведомление call.missed у t2» после «Отклонить» ПРОТИВОРЕЧИЛ правилу «endedById не получает Пропущенный» и проходил на вчерашних строках ленты; переписан на честный сценарий «звонящий отменил → t2 получает» с фильтром по createdAt (26/26).
- $queryRaw ОБХОДИТ chokepoint-$extends — raw-запросы по workspace-моделям обязаны зеркалить скоуп руками (wsFilter в getStats).
