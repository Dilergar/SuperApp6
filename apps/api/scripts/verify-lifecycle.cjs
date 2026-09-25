/* eslint-disable */
// verify-lifecycle — сьют движка жизненного цикла данных (core/lifecycle).
//
// Живые сверки реестра (packages/shared/src/lifecycle) с РЕАЛЬНЫМИ хранилищами dev-стенда —
// то, чего статический страж `pnpm check:lifecycle` не видит:
//   - каждая таблица базы (кроме листьев партиций) покрыта политикой модели или сырой таблицы;
//   - каждый внешний ключ БАЗЫ объявлен ребром удаления родителя (правило ON DELETE = вид ребра);
//   - каждый ключ ЖИВОГО Redis принадлежит зарегистрированному семейству (чужие — роль external);
//   - у семейств с потолком TTL нет «вечных» ключей (ключ без TTL в кэше = утечка навсегда);
//   - смоук бута: API отвечает — реестр цел (иначе LifecycleModule роняет бут).
//
// Манифест CANARY_STORES перечисляет КАЖДОЕ хранилище реестра — страж сверяет его с реестром.
//
// Э4 — заморозки, стирание, сертификат, канарейка:
//   - заморозка держит КАЖДЫЙ путь удаления: «удалить навсегда» задачи, заметки, поддерева Диска,
//     события; группа чата (409) и правка/удаление сообщения (оригинал — в hold store); раннер
//     сроков; реап файлов; каскад организации (заморозка ПЛАТФОРМЫ на её данных); стирание человека;
//   - стирание одноразового аккаунта от удаления до сертификата: квитанция публична и без ПДн,
//     подпись Ed25519 сходится по JWKS и архивно сервером, подделка сертификата — нет;
//   - канарейка: чистый прогон без находок с полным покрытием плана; подсаженная строка и ключ
//     Redis ловятся (журнал безопасности `lifecycle.canary.failed`), синтетика убрана.
//
// Запуск (API поднят): node scripts/verify-lifecycle.cjs
const { PrismaClient, Prisma } = require('@prisma/client');
const Redis = require('ioredis');
const nodeCrypto = require('node:crypto');
const { BASE, SUITE, makeChecker, crash, call, login, devCode, createSuiteWorkspace } = require('./_lib.cjs');
const { registrationConsents, acceptAllPending } = require('./_consents.cjs');
const { LIFECYCLE_POLICIES, LIFECYCLE_POLICY_IDS, lifecycleCertificatePayload } = require('@superapp/shared');

const CANARY_STORES = [
  'User', 'UserRole', 'Session', 'UserDevice', 'VerifyChallenge', 'RelationTuple', 'NotificationEvent',
  'Notification', 'NotificationDelivery', 'NotificationPreference', 'WorkspaceNotificationPolicy',
  'NotificationSubscription', 'NotificationDevice', 'UserNotificationSettings', 'FileObject', 'FileLink',
  'FileVariant', 'VoiceTranscript', 'CallSession', 'CallSessionParticipant', 'CallRecording',
  'CallRecordingClaim', 'Job', 'ChatterEntry', 'SearchDocument', 'ShareLink', 'ShareLinkVisit',
  'ShareLinkGuest', 'ApprovalRequest', 'ApprovalStep', 'ApprovalDecision', 'SignRequest', 'SignAct',
  'SignActEvent', 'SignQrSession', 'Document', 'DocumentVersion', 'DocumentSession', 'Plan', 'PlanVersion',
  'SubjectSubscription', 'EntitlementGrant', 'EntitlementOverride', 'QuotaCounter', 'PlatformStaff',
  'PlatformStaffRole', 'PlatformSession', 'PlatformPolicy', 'PlatformCommandRequest',
  'PlatformCommandReceipt', 'AnalyticsIdentityLink', 'AnalyticsEventOverride', 'AnalyticsQuarantine',
  'AnalyticsRollupEventDay', 'AnalyticsRollupActorDay', 'AnalyticsRollupSessionDay', 'AnalyticsReport',
  'AnalyticsDashboard', 'CryptoKey', 'CryptoKeyVersion', 'Bot', 'ApiKey', 'ApiAccessLog', 'WebhookEndpoint',
  'WebhookDelivery', 'WorkspaceKeyPolicy', 'ConsentVersion', 'ConsentAcceptance', 'PdIncident',
  'PdIncidentEvent', 'IdempotencyInbox', 'SecurityEvent', 'SecurityDigest', 'SecurityPartitionArchive',
  'SecurityAlert', 'VisibilityPolicy', 'VisibilityRule', 'WorkspaceVisibilitySettings', 'LifecycleSetting',
  'LifecycleHold', 'LifecycleHoldStore', 'LifecycleHoldExtraction', 'LifecycleErasureRequest',
  'LifecycleErasureJournal', 'LifecycleExport', 'LifecycleDeletedRow', 'LifecycleRun', 'LifecycleBackupRun',
  'LifecyclePartitionSpec', 'LifecyclePartitionArchive', 'Chat', 'ChatMember',
  'Message', 'ScheduledMessage', 'Workspace', 'WorkspaceMember', 'WorkspaceInvitation', 'LegalEntity',
  'WorkspaceBankAccount', 'StaffDepartment', 'StaffPosition', 'StaffBranch', 'StaffAssignment',
  'StaffingPosition', 'StaffRate', 'StaffDeputy', 'ShiftTemplate', 'ShiftPattern', 'Shift',
  'ShiftAttendance', 'AssetModel', 'Asset', 'AssetMove', 'AssetServiceRecord', 'Counterparty',
  'CounterpartyContact', 'CounterpartyBankAccount', 'DocType', 'DocTypeCounter', 'DocTemplate',
  'OrgDocument', 'DocCampaign', 'DocCampaignTarget', 'DocTemplateLibraryInstall', 'Employment', 'HrAction',
  'HrActionBatch', 'EsutdSubmission', 'PersonalDocRecord', 'WorkCalendarDay', 'ProcessDefinition',
  'ProcessVersion', 'ProcessInstance', 'ProcessStepRun', 'ProcessTrigger', 'ProcessCredential', 'OfficeRoom',
  'OfficeRoomParticipant', 'ContactLink', 'ContactInvitation', 'ContactBlock', 'Circle', 'CircleMembership',
  'Task', 'TaskParticipant', 'TaskTag', 'CalendarEvent', 'CalendarEventReminder', 'EventParticipant',
  'Resource', 'GoogleConnection', 'UserPaymentCard', 'Currency', 'Account', 'LedgerTransfer',
  'EscrowAgreement', 'EscrowHold', 'Shop', 'Showcase', 'Listing', 'ListingPrice', 'Order',
  'OrderContribution', 'OrderPrice', 'WishItem', 'CardSkin', 'CardSkinInstance', 'CardSkinTransfer',
  'FinBook', 'FinAccount', 'FinTransaction', 'FinBudget', 'FinPerson', 'FinRecurringRule', 'FinAuditLog',
  'DriveSpace', 'DriveNode', 'DriveNodeVersion', 'DriveStar', 'DriveRecent', 'DrivePhotoBucket', 'NoteSpace',
  'NoteFolder', 'Note', 'NoteRevision', 'NoteLink', 'NoteBoardItem', 'NoteChunk', 'VoiceRecording',
  'table:analytics.events', 'table:analytics.outbox', 'table:idem.keys', 'table:idem.responses',
  'table:public._prisma_migrations', 'blob:avatar', 'blob:listing_image', 'blob:chat_attachment',
  'blob:voice_message', 'blob:dictaphone', 'blob:document', 'blob:drive_file', 'blob:sign_subject',
  'blob:sign_cms', 'blob:sign_stamped', 'blob:asset_photo', 'blob:note_image', 'blob:audit_export',
  'blob:generic', 'redis:locks', 'redis:event_bus', 'redis:analytics_stream', 'redis:auth_revocation',
  'redis:auth_throttle', 'redis:throttler', 'redis:verify', 'redis:sms_outbound', 'redis:entitlement_epochs',
  'redis:access_epochs', 'redis:keys_state', 'redis:audit_state', 'redis:notifications_state',
  'redis:platform_console', 'redis:analytics_state', 'redis:analytics_watermarks', 'redis:wallet_state',
  'redis:office_state', 'redis:socket_adapter', 'redis:lifecycle_state', 'redis:auth_alive',
  'redis:keys_cache', 'redis:access_cache', 'redis:entitlement_cache', 'redis:visibility_cache',
  'redis:user_cache', 'redis:presence', 'redis:seen_throttle', 'redis:consents_gate', 'redis:org_graph',
  'redis:analytics_cache', 'redis:docs_discovery', 'redis:livekit', 'derived:audit_archive',
  'derived:audit_digests', 'derived:lifecycle_archive', 'derived:lifecycle_exports',
  'derived:erasure_journal', 'derived:backups', 'derived:app_logs', 'derived:upload_tmp',
  'derived:call_egress',
];

const { check, finish } = makeChecker();
const PARTITION_LEAF = /_(\d{4}_\d{2}|\d{4}_\d{2}_\d{2}|\d{8}|p\d+|default)$/;
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

const DAY = 86_400_000;
const PW = SUITE.password;
const rnd = () => nodeCrypto.randomBytes(4).toString('hex');

/** Заморозка платформы через дев-полигон (путь сервиса: замок, журнал, метрика); снятие — там же. */
function holdsOf(token) {
  const placed = [];
  return {
    async put(body) {
      const r = await call('POST', '/lifecycle/dev/holds', token, { reasonCode: 'litigation', ...body });
      if (r.ok && r.json?.data?.id) placed.push(r.json.data.id);
      return r;
    },
    release: (id) => call('POST', '/lifecycle/dev/holds/release', token, { holdId: id }),
    async releaseAll() {
      for (const id of placed) await call('POST', '/lifecycle/dev/holds/release', token, { holdId: id }).catch(() => undefined);
    },
  };
}

/** Одноразовый человек для стирания (аккаунты сьюта стирать нельзя): регистрация + пропуск удаления. */
async function registerThrowaway(lastName) {
  const phone = `+7700${String(Date.now() % 10_000_000).padStart(7, '0')}`;
  const consents = await registrationConsents(BASE);
  const reg = await call('POST', '/auth/register', null, { phone, password: PW, firstName: 'Стирание', lastName, dateOfBirth: '1990-01-01', consents });
  if (!reg.ok) throw new Error(`register ${phone}: ${reg.status} ${JSON.stringify(reg.json)}`);
  const token = reg.json.data.accessToken;
  const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  return { phone, token, id };
}

async function deleteAccount(acc, body = {}) {
  const su = await call('POST', '/verify/step-up', acc.token, { purpose: 'account_delete', password: PW });
  const code = await devCode(su.json?.data?.challengeId);
  const chk = await call('POST', '/verify/check', null, { challengeId: su.json?.data?.challengeId, code });
  return call('DELETE', '/users/me', acc.token, { password: PW, verifyToken: chk.json?.data?.verifyToken, ...body });
}

// ---------------------------------------------------------------- 4. заморозка на всех путях
async function holdsOnEveryPath(prisma, redis, s1) {
  console.log('\n-- 4. заморозка держит каждый путь удаления --');
  const t1 = s1.token;
  const holds = holdsOf(t1);
  try {
    // 4.1 задача из корзины — «удалить навсегда»
    const task = await call('POST', '/tasks', t1, { title: `Сьют hold ${rnd()}` });
    const taskId = task.json?.data?.id;
    await call('POST', `/tasks/${taskId}/trash`, t1);
    const hTask = await holds.put({ scope: 'record', recordType: 'Task', recordId: taskId });
    check('заморозка записи ставится путём сервиса (дев-полигон)', hTask.ok && !!hTask.json?.data?.id, `${hTask.status} ${hTask.code ?? ''}`);
    let r = await call('DELETE', `/tasks/${taskId}`, t1);
    check('задача: «удалить навсегда» под заморозкой → 409 lifecycle.held, строка цела', r.status === 409 && r.code === 'lifecycle.held' && (await prisma.task.count({ where: { id: taskId } })) === 1, `${r.status} ${r.code}`);
    await holds.release(hTask.json?.data?.id);
    r = await call('DELETE', `/tasks/${taskId}`, t1);
    check('задача: после снятия удаляется', r.ok && (await prisma.task.count({ where: { id: taskId } })) === 0, `${r.status} ${r.code ?? ''}`);

    // 4.2 заметка
    const note = await call('POST', '/notes', t1, { markdown: `# Сьют hold ${rnd()}` });
    const noteId = note.json?.data?.id;
    await call('POST', `/notes/${noteId}/trash`, t1);
    const hNote = await holds.put({ scope: 'record', recordType: 'Note', recordId: noteId });
    r = await call('DELETE', `/notes/${noteId}`, t1);
    check('заметка: под заморозкой → 409, строка цела', r.status === 409 && r.code === 'lifecycle.held' && (await prisma.note.count({ where: { id: noteId } })) === 1, `${r.status} ${r.code}`);
    await holds.release(hNote.json?.data?.id);
    r = await call('DELETE', `/notes/${noteId}`, t1);
    check('заметка: после снятия удаляется', r.ok && (await prisma.note.count({ where: { id: noteId } })) === 0, `${r.status} ${r.code ?? ''}`);

    // 4.3 Диск: заморозка РЕБЁНКА держит удаление папки (поддерево уходит каскадом)
    const folder = await call('POST', '/drive/folders', t1, { name: `Сьют hold ${rnd()}` });
    const folderId = folder.json?.data?.id;
    const child = await call('POST', '/drive/folders', t1, { name: 'вложенная', parentId: folderId });
    const childId = child.json?.data?.id;
    await call('POST', '/drive/nodes/trash', t1, { ids: [folderId] });
    const hNode = await holds.put({ scope: 'record', recordType: 'DriveNode', recordId: childId });
    r = await call('DELETE', '/drive/nodes', t1, { ids: [folderId] });
    check('Диск: заморозка вложенного узла держит удаление папки → 409, оба узла целы', r.status === 409 && r.code === 'lifecycle.held' && (await prisma.driveNode.count({ where: { id: { in: [folderId, childId] } } })) === 2, `${r.status} ${r.code}`);
    await holds.release(hNode.json?.data?.id);
    r = await call('DELETE', '/drive/nodes', t1, { ids: [folderId] });
    check('Диск: после снятия поддерево удалено', r.ok && (await prisma.driveNode.count({ where: { id: { in: [folderId, childId] } } })) === 0, `${r.status} ${r.code ?? ''}`);

    // 4.4 событие календаря
    const start = new Date(Date.now() + 3 * DAY);
    const ev = await call('POST', '/calendar/events', t1, { title: `Сьют hold ${rnd()}`, startTime: start.toISOString(), endTime: new Date(start.getTime() + 3_600_000).toISOString() });
    const evId = ev.json?.data?.id;
    await call('POST', `/calendar/events/${evId}/trash`, t1);
    const hEv = await holds.put({ scope: 'record', recordType: 'CalendarEvent', recordId: evId });
    r = await call('DELETE', `/calendar/events/${evId}`, t1);
    check('календарь: событие из корзины под заморозкой → 409, строка цела', r.status === 409 && r.code === 'lifecycle.held' && (await prisma.calendarEvent.count({ where: { id: evId } })) === 1, `${r.status} ${r.code}`);
    await holds.release(hEv.json?.data?.id);
    r = await call('DELETE', `/calendar/events/${evId}`, t1);
    check('календарь: после снятия удаляется', r.ok && (await prisma.calendarEvent.count({ where: { id: evId } })) === 0, `${r.status} ${r.code ?? ''}`);

    // 4.5 мессенджер: хранитель под заморозкой — правка и удаление сохраняют оригинал, группа не удаляется
    const group = await call('POST', '/messenger/chats/group', t1, { name: `Сьют hold ${rnd()}`, memberIds: [] });
    const chatId = group.json?.data?.id;
    const original = `оригинал ${rnd()}`;
    const msg = await call('POST', `/messenger/chats/${chatId}/messages`, t1, { content: original });
    const msgId = msg.json?.data?.id;
    const hCust = await holds.put({ scope: 'custodian', custodianUserId: s1.id });
    r = await call('PATCH', `/messenger/messages/${msgId}`, t1, { content: 'правка' });
    const stored1 = await prisma.lifecycleHoldStore.findMany({ where: { holdId: hCust.json?.data?.id, sourcePk: msgId } });
    check('сообщение: правка под заморозкой не блокируется, оригинал ушёл в hold store', r.ok && stored1.length === 1, `${r.status} store=${stored1.length}`);
    check('hold store хранит оригинал под ключом (не открытым текстом)', stored1.length === 1 && !Buffer.from(stored1[0].rowEnc).toString('utf8').includes(original));
    r = await call('DELETE', `/messenger/messages/${msgId}`, t1);
    const stored2 = await prisma.lifecycleHoldStore.count({ where: { holdId: hCust.json?.data?.id, sourcePk: msgId } });
    check('сообщение: удаление под заморозкой — томбстоун у всех, копия в hold store', r.ok && stored2 === 2, `${r.status} store=${stored2}`);
    r = await call('DELETE', `/messenger/chats/${chatId}`, t1);
    check('группа с удерживаемыми сообщениями не удаляется → 409, чат цел', r.status === 409 && r.code === 'lifecycle.held' && (await prisma.chat.count({ where: { id: chatId } })) === 1, `${r.status} ${r.code}`);
    await holds.release(hCust.json?.data?.id);
    r = await call('DELETE', `/messenger/chats/${chatId}`, t1);
    check('группа: после снятия удаляется вместе с сообщениями', r.ok && (await prisma.chat.count({ where: { id: chatId } })) === 0 && (await prisma.message.count({ where: { chatId } })) === 0, `${r.status} ${r.code ?? ''}`);

    // 4.6 раннер сроков: корзина задач старше срока под заморозкой остаётся
    const old = await call('POST', '/tasks', t1, { title: `Сьют hold runner ${rnd()}` });
    const oldId = old.json?.data?.id;
    await call('POST', `/tasks/${oldId}/trash`, t1);
    await prisma.task.update({ where: { id: oldId }, data: { deletedAt: new Date(Date.now() - 400 * DAY) } });
    const hRun = await holds.put({ scope: 'record', recordType: 'Task', recordId: oldId });
    r = await call('POST', '/lifecycle/dev/purge/run', t1, { policyId: 'Task' });
    check('раннер сроков: задача старше срока под заморозкой остаётся', r.ok && (await prisma.task.count({ where: { id: oldId } })) === 1, `${r.status} ${r.code ?? ''}`);
    await holds.release(hRun.json?.data?.id);
    r = await call('POST', '/lifecycle/dev/purge/run', t1, { policyId: 'Task' });
    check('раннер сроков: после снятия — удалена', r.ok && (await prisma.task.count({ where: { id: oldId } })) === 0, `${r.status} ${r.code ?? ''}`);

    // 4.7 реап файлов: удалённый файл старше корзины под заморозкой остаётся
    const fileId = nodeCrypto.randomUUID();
    await prisma.fileObject.create({
      data: {
        id: fileId, ownerType: 'user', ownerId: s1.id, uploaderId: s1.id, profile: 'generic', kind: 'document', name: 'suite-hold.txt', mime: 'text/plain', size: BigInt(1),
        status: 'deleted', deletedAt: new Date(Date.now() - 400 * DAY), storageDriver: 'local', storageKey: `suite/hold/${fileId}`,
      },
    });
    const hFile = await holds.put({ scope: 'record', recordType: 'FileObject', recordId: fileId });
    r = await call('POST', '/lifecycle/dev/purge/run', t1, { policyId: 'FileObject' });
    check('реап файлов: удалённый файл старше корзины под заморозкой остаётся', r.ok && (await prisma.fileObject.count({ where: { id: fileId } })) === 1, `${r.status} ${r.code ?? ''}`);
    await holds.release(hFile.json?.data?.id);
    r = await call('POST', '/lifecycle/dev/purge/run', t1, { policyId: 'FileObject' });
    check('реап файлов: после снятия — удалён', r.ok && (await prisma.fileObject.count({ where: { id: fileId } })) === 0, `${r.status} ${r.code ?? ''}`);

    // 4.8 каскад организации: заморозка ПЛАТФОРМЫ на данных организации (хранитель) держит каскад целиком
    const ws = await createSuiteWorkspace(t1, 'Сьют-Lifecycle');
    const wsId = ws.json?.data?.id;
    const WSH = { 'X-Workspace-Id': wsId };
    const orgTask = await call('POST', '/tasks', t1, { title: `Сьют org ${rnd()}` }, WSH);
    const orgTaskId = orgTask.json?.data?.id;
    // Суточный бюджет SMS-квитанций suite1 выжигают архивы остальных сьютов — окно сбрасывается
    for (const k of await redis.keys(`smsout:receipt:${s1.id}:*`)) await redis.del(k);
    const archivedAt = new Date();
    const arch = await call('DELETE', `/workspaces/${wsId}`, t1);
    check('архив организации: код квитанции стирания выдан один раз (26 знаков base32)', arch.ok && /^[a-z2-7]{26}$/.test(String(arch.json?.data?.receipt ?? '')), `${arch.status} ${arch.code ?? ''}`);
    let smsProof = 0;
    for (let i = 0; i < 20 && !smsProof; i++) {
      await new Promise((r) => setTimeout(r, 250));
      smsProof = await prisma.securityEvent.count({ where: { eventKey: 'pd.transfer', subjectUserId: s1.id, workspaceId: wsId, occurredAt: { gte: archivedAt } } });
    }
    check('архив организации: ссылка на квитанцию ушла владельцу SMS (учёт передачи номера шлюзу)', smsProof === 1, smsProof);
    const hPlat = await holds.put({ scope: 'custodian', custodianUserId: s1.id });
    r = await call('POST', '/workspaces/dev/purge-archives', t1, { workspaceId: wsId });
    check('каскад организации: заморозка платформы на её данных → 409 lifecycle.tenantHeld, строки целы', r.status === 409 && r.code === 'lifecycle.tenantHeld' && (await prisma.workspace.count({ where: { id: wsId } })) === 1 && (await prisma.task.count({ where: { id: orgTaskId } })) === 1, `${r.status} ${r.code}`);
    await holds.release(hPlat.json?.data?.id);
    r = await call('POST', '/workspaces/dev/purge-archives', t1, { workspaceId: wsId });
    check('каскад организации: после снятия прошёл', r.ok && (await prisma.workspace.count({ where: { id: wsId } })) === 0 && (await prisma.task.count({ where: { id: orgTaskId } })) === 0, `${r.status} ${r.code ?? ''}`);
  } finally {
    await holds.releaseAll();
  }
}

// ---------------------------------------------------------------- 5. стирание человека до сертификата
async function erasureEndToEnd(prisma, s1) {
  console.log('\n-- 5. стирание человека: заморозка, этапы, квитанция, подписанный сертификат --');
  const t1 = s1.token;
  const holds = holdsOf(t1);
  const lastName = `Лцс${rnd()}`;
  const acc = await registerThrowaway(lastName);
  try {
    await acceptAllPending(BASE, acc.token);
    await call('POST', '/tasks', acc.token, { title: `личное ${lastName}` });
    const del = await deleteAccount(acc, { eraseMessages: true });
    const body = del.json?.data ?? del.json ?? {};
    const receipt = body.receipt;
    check('удаление аккаунта: квитанция-код выдана один раз (26 знаков base32)', del.ok && /^[a-z2-7]{26}$/.test(String(receipt ?? '')), `${del.status} ${JSON.stringify(body).slice(0, 120)}`);
    const req = await prisma.lifecycleErasureRequest.findFirst({ where: { subjectType: 'user', subjectId: acc.id }, orderBy: { requestedAt: 'desc' } });
    check('заявка на стирание заведена в транзакции удаления (отпечаток кода, без самого кода)', !!req && req.status === 'scheduled' && req.receiptHash === nodeCrypto.createHash('sha256').update(receipt ?? '').digest('hex'), req?.status);
    let pub = await call('GET', `/lifecycle/erasure-receipts/${receipt}`, null);
    check('квитанция публична (без входа): этап «запланировано», сертификата ещё нет', pub.ok && pub.json?.data?.status === 'scheduled' && pub.json?.data?.certificate === null, `${pub.status} ${pub.json?.data?.status}`);

    // Хранитель под заморозкой: аккаунт СКРЫТ, но ПДн строки — улика, не стираются
    const hAcc = await holds.put({ scope: 'custodian', custodianUserId: acc.id });
    let r = await call('POST', '/lifecycle/dev/erasure/run', t1, { requestId: req.id, now: true });
    let u = await prisma.user.findUnique({ where: { id: acc.id }, select: { deletedAt: true, lastName: true, phone: true } });
    check('стирание под заморозкой хранителя: аккаунт скрыт, ПДн на месте, заявка ждёт', r.ok && r.json?.data?.status === 'held' && !!u?.deletedAt && u?.lastName === lastName, `${r.status} ${r.json?.data?.status} last=${u?.lastName}`);
    await holds.release(hAcc.json?.data?.id);
    r = await call('POST', '/lifecycle/dev/erasure/run', t1, { requestId: req.id });
    u = await prisma.user.findUnique({ where: { id: acc.id }, select: { lastName: true, phone: true, firstName: true } });
    check('после снятия — горячее стёрто: номер освобождён, фамилии нет, строка — томбстоун', r.ok && r.json?.data?.status === 'hot_purged' && u?.lastName === null && u?.phone === `deleted:${acc.id}`, `${r.json?.data?.status} ${u?.phone}`);
    check('личная задача стёрта', (await prisma.task.count({ where: { creatorId: acc.id, workspaceId: null } })) === 0);

    // Ключи на уничтожение → окно бэкапов → сертификат
    r = await call('POST', '/lifecycle/dev/erasure/advance', t1, { requestId: req.id });
    check('перемотка: ключи уничтожены, окно бэкапов прошло → сертификат', r.ok && r.json?.data?.status === 'completed', `${r.status} ${r.json?.data?.status}`);
    pub = await call('GET', `/lifecycle/erasure-receipts/${receipt}`, null);
    const rc = pub.json?.data ?? {};
    check('квитанция: все этапы с датами, сертификат, подпись и kid', rc.status === 'completed' && !!rc.hiddenAt && !!rc.hotPurgedAt && !!rc.keysDestroyedAt && !!rc.certificate && !!rc.signature && !!rc.kid);
    check('в квитанции нет ПДн (ни номера, ни фамилии, ни id человека)', !JSON.stringify(rc).includes(acc.phone.slice(1)) && !JSON.stringify(rc).includes(lastName) && !JSON.stringify(rc).includes(acc.id));
    const jwks = await call('GET', '/keys/jwks', null);
    const jwk = (jwks.json?.keys ?? jwks.json?.data?.keys ?? []).find((k) => k.kid === rc.kid);
    const pubKey = jwk ? nodeCrypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }) : null;
    const sig = Buffer.from(String(rc.signature ?? ''), 'base64url');
    const okSig = !!pubKey && nodeCrypto.verify(null, Buffer.from(lifecycleCertificatePayload(rc.certificate)), pubKey, sig);
    check('подпись сертификата сходится по публичному JWKS (Ed25519)', okSig, jwk ? 'kid found' : `kid ${rc.kid} not in JWKS`);
    const forged = { ...rc.certificate, counts: { ...rc.certificate.counts, user_content_private: (rc.certificate.counts?.user_content_private ?? 0) + 1 } };
    check('поддельный сертификат (счётчик +1) подпись не проходит', !!pubKey && !nodeCrypto.verify(null, Buffer.from(lifecycleCertificatePayload(forged)), pubKey, sig));
    const ver = await call('GET', `/lifecycle/erasure-receipts/${receipt}/verification`, null);
    check('архивная проверка сервером: valid', ver.ok && ver.json?.data?.state === 'valid' && ver.json?.data?.kid === rc.kid, `${ver.status} ${ver.json?.data?.state}`);
    const bogus = await call('GET', `/lifecycle/erasure-receipts/${'a'.repeat(26)}`, null);
    check('чужой код → 404 lifecycle.receiptNotFound', bogus.status === 404 && bogus.code === 'lifecycle.receiptNotFound', `${bogus.status} ${bogus.code}`);
    const bad = await call('GET', '/lifecycle/erasure-receipts/not-a-code', null);
    check('кривой код → 400', bad.status === 400, `${bad.status}`);

    r = await call('POST', '/lifecycle/dev/erasure/journal/export', t1);
    const pending = await prisma.lifecycleErasureJournal.count({ where: { requestId: req.id, exportedAt: null } });
    check('журнал стираний выгружен вне базы (NDJSON): строк заявки без отметки не осталось', r.ok && pending === 0, `${r.status} pending=${pending}`);
    const jr = await prisma.lifecycleErasureJournal.findMany({ where: { requestId: req.id }, select: { pseudonym: true } });
    check('журнал без ПДн: псевдоним вместо id', jr.length > 0 && jr.every((j) => j.pseudonym && !j.pseudonym.includes(acc.id)));
  } finally {
    await holds.releaseAll();
  }
}

// ---------------------------------------------------------------- 6. канарейка
async function canary(prisma, s1) {
  console.log('\n-- 6. канарейка стирания --');
  const t1 = s1.token;
  let r = await call('POST', '/lifecycle/dev/canary/run', t1, {});
  let rep = r.json?.data ?? {};
  check('чистый прогон: находок нет, синтетика убрана', r.ok && rep.ok === true && rep.findings?.length === 0 && rep.cleaned === true, `${r.status} ${JSON.stringify(rep.findings ?? r.json).slice(0, 200)}`);
  check('полнота: каждое хранилище плана стирания посеяно', Array.isArray(rep.unseeded) && rep.unseeded.length === 0 && rep.planted >= 100, `unseeded=${(rep.unseeded ?? []).join(',')} planted=${rep.planted}`);
  const t0 = new Date();
  r = await call('POST', '/lifecycle/dev/canary/run', t1, { leak: 'row' });
  rep = r.json?.data ?? {};
  check('подсаженная строка после стирания поймана (Task: owned)', r.ok && rep.ok === false && (rep.findings ?? []).some((f) => f.store === 'Task' && f.kind === 'owned'), JSON.stringify(rep.findings ?? r.json).slice(0, 200));
  check('находка доказана журналом безопасности (lifecycle.canary.failed)', (await prisma.securityEvent.count({ where: { eventKey: 'lifecycle.canary.failed', occurredAt: { gte: t0 } } })) >= 1);
  check('утечка убрана вместе с синтетикой', rep.cleaned === true);
  r = await call('POST', '/lifecycle/dev/canary/run', t1, { leak: 'redis' });
  rep = r.json?.data ?? {};
  check('подсаженный ключ Redis с id стёртого пойман', r.ok && rep.ok === false && (rep.findings ?? []).some((f) => f.kind === 'redis'), JSON.stringify(rep.findings ?? r.json).slice(0, 200));
  const left = await prisma.lifecycleRun.count({ where: { kind: 'canary', NOT: { report: { path: ['cleaned'], equals: true } } } });
  check('ни одного недоубранного прогона канарейки', left === 0, `${left}`);
  const metricsUrl = BASE.replace(/\/api\/?$/, '') + '/metrics';
  const m = await fetch(metricsUrl, { headers: process.env.METRICS_TOKEN ? { Authorization: `Bearer ${process.env.METRICS_TOKEN}` } : {} });
  const text = m.ok ? await m.text() : '';
  check('метрики канарейки в /metrics (находки по хранилищу, последний чистый прогон, полнота)', /lifecycle_canary_failures_total\{store="Task"\}/.test(text) && /lifecycle_canary_last_success_seconds \d/.test(text) && /lifecycle_canary_unseeded_policies 0/.test(text), `${m.status}`);
}

async function main() {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 3 });
  try {
    // ---- 0. манифест и смоук бута ----
    const listed = new Set(CANARY_STORES);
    const missing = LIFECYCLE_POLICY_IDS.filter((id) => !listed.has(id));
    check('манифест CANARY_STORES = реестр (каждое хранилище)', missing.length === 0 && CANARY_STORES.length === LIFECYCLE_POLICY_IDS.length, missing.slice(0, 5).join(', '));
    const boot = await fetch(`${BASE}/auth/me`).catch(() => null);
    check('смоук бута: API поднялся с целым реестром (иначе LifecycleModule роняет бут)', !!boot && boot.status > 0 && boot.status < 500, boot?.status);

    // ---- 1. каждая таблица базы покрыта политикой ----
    const models = Prisma.dmmf.datamodel.models;
    const modelByTable = new Map(models.map((m) => [`public.${m.dbName ?? m.name}`, m]));
    const tables = await prisma.$queryRawUnsafe(`
      SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`);
    const tablePolicies = new Set(LIFECYCLE_POLICY_IDS.filter((id) => LIFECYCLE_POLICIES[id].store.kind === 'table').map((id) => LIFECYCLE_POLICIES[id].store.table));
    const uncovered = [];
    for (const t of tables) {
      const key = `${t.schema}.${t.name}`;
      if (PARTITION_LEAF.test(t.name)) continue;
      const m = modelByTable.get(key);
      if (m && LIFECYCLE_POLICIES[m.name]) continue;
      if (tablePolicies.has(key)) continue;
      uncovered.push(key);
    }
    check(`каждая таблица базы (${tables.length}) покрыта политикой`, uncovered.length === 0, uncovered.join(', '));

    // ---- 2. каждый FK базы объявлен ребром удаления ----
    const fks = await prisma.$queryRawUnsafe(`
      SELECT cl.relname AS child, pl.relname AS parent, con.confdeltype AS action,
             (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid AND NOT cl.relispartition
      JOIN pg_class pl ON pl.oid = con.confrelid
      WHERE con.contype = 'f' AND con.conparentid = 0`);
    const fieldOfCol = (model, col) => model.fields.find((f) => (f.dbName ?? f.name) === col)?.name ?? col;
    const badFk = [];
    for (const fk of fks) {
      const child = modelByTable.get(`public.${fk.child}`);
      const parent = modelByTable.get(`public.${fk.parent}`);
      if (!child || !parent) continue;
      const via = fk.cols.split(',').map((c) => fieldOfCol(child, c)).join(',');
      const kind = fk.action === 'n' || fk.action === 'd' ? 'shallow' : 'deep';
      const edge = (LIFECYCLE_POLICIES[parent.name]?.edges ?? []).find((e) => e.to === child.name && e.via === via);
      if (!edge || edge.kind !== kind) badFk.push(`${child.name}.${via}→${parent.name}(${kind})`);
    }
    check(`каждый FK базы (${fks.length}) объявлен ребром удаления нужного вида`, badFk.length === 0, badFk.slice(0, 6).join('; '));

    // ---- 3. каждый ключ живого Redis принадлежит семейству; «вечных» ключей в семействах с TTL нет ----
    const families = LIFECYCLE_POLICY_IDS.map((id) => LIFECYCLE_POLICIES[id]).filter((p) => p.store.kind === 'redis');
    const matchers = families.flatMap((p) => p.store.patterns.map((g) => ({ re: globRe(g), p })));
    const unknown = new Map();
    const immortal = new Map();
    let scanned = 0;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'COUNT', 1000);
      cursor = next;
      const withTtl = keys.length ? await redis.pipeline(keys.map((k) => ['ttl', k])).exec() : [];
      keys.forEach((k, i) => {
        scanned++;
        const hit = matchers.find((m) => m.re.test(k));
        const shape = k.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>').replace(/\d{3,}/g, '<n>').split(':').slice(0, 3).join(':');
        if (!hit) {
          unknown.set(shape, (unknown.get(shape) ?? 0) + 1);
          return;
        }
        const ttl = withTtl[i]?.[1];
        const max = hit.p.store.maxTtlSeconds;
        if (max !== null && hit.p.store.role !== 'external' && ttl === -1) immortal.set(`${hit.p.id} ${shape}`, (immortal.get(`${hit.p.id} ${shape}`) ?? 0) + 1);
      });
    } while (cursor !== '0');
    check(`каждый ключ живого Redis (${scanned}) принадлежит семейству реестра`, unknown.size === 0, [...unknown].slice(0, 8).map(([s, n]) => `${s}×${n}`).join(', '));
    check('у семейств с потолком TTL нет ключей без срока (кэш без TTL = утечка навсегда)', immortal.size === 0, [...immortal].slice(0, 8).map(([s, n]) => `${s}×${n}`).join(', '));

    // ---- CHECK-ограничения таблиц движка = перечисления shared (статус в коде без CHECK в базе — 500 на пути стирания) ----
    const shared = require('@superapp/shared');
    const enumChecks = {
      lifecycle_erasure_requests_status_check: shared.LIFECYCLE_ERASURE_STATUSES,
      lifecycle_runs_status_check: shared.LIFECYCLE_RUN_STATUSES,
      lifecycle_holds_scope_check: shared.LIFECYCLE_HOLD_SCOPE_KINDS,
      lifecycle_erasure_requests_subject_check: ['user', 'workspace'],
    };
    const defs = await prisma.$queryRawUnsafe(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ANY($1::text[])`, Object.keys(enumChecks));
    const drift = [];
    for (const [name, values] of Object.entries(enumChecks)) {
      const def = defs.find((d) => d.conname === name)?.def ?? '';
      const inDb = new Set([...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
      const missing = values.filter((v) => !inDb.has(v));
      const extra = [...inDb].filter((v) => !values.includes(v));
      if (!def || missing.length || extra.length) drift.push(`${name}: -[${missing}] +[${extra}]`);
    }
    check('CHECK-ограничения движка = перечисления shared (статусы заявок, прогонов, области заморозок)', drift.length === 0, drift.join('; '));

    // ---- Э4 ----
    const s1 = await login(SUITE.p1);
    await acceptAllPending(BASE, s1.token);
    await holdsOnEveryPath(prisma, redis, s1);
    await erasureEndToEnd(prisma, s1);
    await canary(prisma, s1);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    redis.disconnect();
  }
  await finish();
}

main().catch(crash);
