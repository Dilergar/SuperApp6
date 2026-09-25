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
const { BASE, SUITE, makeChecker, crash, call, login, devCode, createSuiteWorkspace, archiveSuiteWorkspace, consoleLogin, consoleSudo } = require('./_lib.cjs');
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
  'LifecycleErasureJournal', 'LifecycleExport', 'LifecycleDeletedRow', 'LifecycleRun', 'LifecycleBackupRun', 'LifecycleStorageDaily', 'LifecyclePolicyOverride',
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
  'redis:keys_cache', 'redis:access_cache', 'redis:entitlement_cache', 'redis:visibility_cache', 'redis:visibility_state',
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
/** SCAN вместо KEYS: KEYS блокирует Redis и закрыт ACL приложения (infra/redis/users.acl). */
async function scanKeys(client, pattern) {
  const out = [];
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = next;
    out.push(...keys);
  } while (cursor !== '0');
  return out;
}

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
    for (const k of await scanKeys(redis, `smsout:receipt:${s1.id}:*`)) await redis.del(k);
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
  // Группа соседа с двумя плашками о человеке (он актор и цель): имя парой с id
  const plaqueName = `Сьют ${lastName}`;
  const plaqueChat = await prisma.chat.create({ data: { type: 'group', title: `Сьют плашки ${rnd()}`, createdById: s1.id, lastSeq: 2, members: { create: [{ userId: s1.id, role: 'owner' }] } }, select: { id: true } });
  const plaques = await Promise.all([
    prisma.message.create({ data: { chatId: plaqueChat.id, type: 'system', seq: 1, payload: { eventType: 'group.renamed', text: `${plaqueName} renamed the group to «T»`, chatter: { refType: 'chat', actorName: plaqueName, actorId: acc.id, payload: { actorName: plaqueName, title: 'T' } } } }, select: { id: true } }),
    prisma.message.create({ data: { chatId: plaqueChat.id, type: 'system', seq: 2, payload: { eventType: 'group.member_added', text: `${plaqueName} was added to the group`, chatter: { refType: 'chat', actorName: null, payload: { targetName: plaqueName, targetUserId: acc.id } } } }, select: { id: true } }),
  ]);
  const plaqueJson = async () => (await prisma.message.findMany({ where: { id: { in: plaques.map((m) => m.id) } }, select: { payload: true } })).map((m) => JSON.stringify(m.payload));
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
    check('плашки чатов под заморозкой хранителя — улика: имя на месте', (await plaqueJson()).every((j) => j.includes(lastName)));
    await holds.release(hAcc.json?.data?.id);
    r = await call('POST', '/lifecycle/dev/erasure/run', t1, { requestId: req.id });
    u = await prisma.user.findUnique({ where: { id: acc.id }, select: { lastName: true, phone: true, firstName: true } });
    check('после снятия — горячее стёрто: номер освобождён, фамилии нет, строка — томбстоун', r.ok && r.json?.data?.status === 'hot_purged' && u?.lastName === null && u?.phone === `deleted:${acc.id}`, `${r.json?.data?.status} ${u?.phone}`);
    const pj = await plaqueJson();
    check(
      'плашки чатов соседа: имени нет ни в структуре, ни в снимке текста, id остался (томбстоун по id)',
      pj.length === 2 && pj.every((j) => !j.includes(lastName) && j.includes(acc.id) && j.includes('A deleted user')),
      pj.map((j) => j.slice(0, 160)).join(' | '),
    );
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
    await prisma.chat.delete({ where: { id: plaqueChat.id } }).catch(() => undefined);
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

// ---------------------------------------------------------------- 7. сроки хранения организации и таймер чата (Э5)
async function retentionSettings(prisma, s1) {
  console.log('\n-- 7. сроки организации: коридор, отложенное сокращение, чтение в сроке, таймер чата --');
  const t1 = s1.token;
  const s2 = await login(SUITE.p2);
  const s3 = await login(SUITE.p3);
  // Владелец — suite2: сотрудник платформы (suite1) задаёт ей условия тарифа не «на себя»
  const owner = s2;
  const tO = owner.token;
  const ws = await createSuiteWorkspace(tO, 'Сьют-Сроки');
  const wsId = ws.json?.data?.id;
  // Член организации (получатель уведомления) — suite1, админ (получатель уведомления о заморозке) — suite3
  for (const [who, phone] of [[s1, SUITE.p1], [s3, SUITE.p3]]) {
    const inv = await call('POST', `/workspaces/${wsId}/invitations`, tO, { phone });
    const mine = (await call('GET', '/workspaces/invitations/incoming', who.token)).json?.data?.find((i) => i.workspaceId === wsId);
    await call('POST', `/workspaces/invitations/${mine?.id ?? inv.json?.data?.id}/accept`, who.token);
  }
  await call('PATCH', `/workspaces/${wsId}/members/${s3.id}`, tO, { role: 'admin' });
  const member = s1;
  const base = `/workspaces/${wsId}/lifecycle`;

  let r = await call('GET', `${base}/settings`, tO);
  const byClass = Object.fromEntries((r.json?.data?.classes ?? []).map((c) => [c.dataClass, c]));
  check('настройки: три класса организации, умолчание — «вечно» у сообщений и хроники', r.ok && byClass.user_content_shared?.current === 'forever' && byClass.tenant_record?.current === 'forever' && !!byClass.operational, `${r.status}`);
  check('коридор журнала вебхуков: пол 7, потолок = общий срок партиций (30)', byClass.operational?.min === 7 && byClass.operational?.max === 30, JSON.stringify({ min: byClass.operational?.min, max: byClass.operational?.max }));
  check('классы «по закону» показаны с нормой (без выбора)', (r.json?.data?.law ?? []).some((l) => l.citation), JSON.stringify((r.json?.data?.law ?? []).map((l) => l.dataClass)));
  r = await call('GET', `${base}/settings`, member.token);
  check('рядовой член страницу сроков не видит (404, не оракул)', r.status === 404, `${r.status}`);

  r = await call('PUT', `${base}/settings`, tO, { dataClass: 'operational', days: 3 });
  check('ниже пола закона → 400 lifecycle.retentionBelowFloor', r.status === 400 && r.code === 'lifecycle.retentionBelowFloor', `${r.status} ${r.code}`);
  r = await call('PUT', `${base}/settings`, tO, { dataClass: 'operational', days: 60 });
  check('выше потолка политики → 400 lifecycle.retentionAboveCeiling', r.status === 400 && r.code === 'lifecycle.retentionAboveCeiling', `${r.status} ${r.code}`);
  r = await call('PUT', `${base}/settings`, tO, { dataClass: 'tenant_record', days: '10' });
  check('срок строкой-числом — не срок (400)', r.status === 400, `${r.status}`);

  // Потолок тарифа — индивидуальным условием Кабинета: «вечно» выше потолка → 402 с разблокировкой
  const c = await consoleLogin(SUITE.p1);
  const ct = c.token;
  await consoleSudo(ct);
  const ceilingKey = 'lifecycle.retention.tenant_record.ceilingDays';
  const until = new Date(Date.now() + 86_400_000).toISOString();
  r = await call('POST', '/platform/commands/entitlements.override.set', ct, {
    input: { subject: { type: 'workspace', id: wsId }, key: ceilingKey, mode: 'set', value: 90, reason: 'suite: plan ceiling of the record history', validUntil: until },
    idempotencyKey: nodeCrypto.randomUUID(),
    reason: 'suite: plan ceiling of the record history',
  });
  const ceilingSet = r.ok;
  check('условие Кабинета: потолок хроники 90 дней', ceilingSet, `${r.status} ${r.code ?? ''}`);
  r = await call('GET', `${base}/settings`, tO);
  const rec = (r.json?.data?.classes ?? []).find((x) => x.dataClass === 'tenant_record');
  check('карточка видит потолок тарифа и «выше тарифа» у текущего «вечно»', rec?.planCeiling === 90 && rec?.max === 90 && rec?.aboveCeiling === true && !!rec?.unlock, JSON.stringify({ ceiling: rec?.planCeiling, max: rec?.max, above: rec?.aboveCeiling }));
  r = await call('PUT', `${base}/settings`, tO, { dataClass: 'tenant_record', days: 365 });
  check('выше потолка тарифа → 402 entitlement.limit_reached с разблокировкой', r.status === 402 && r.code === 'entitlement.limit_reached', `${r.status} ${r.code}`);

  // Предпросмотр и отложенное сокращение
  r = await call('POST', `${base}/settings/preview`, tO, { dataClass: 'tenant_record', days: 30 });
  const pv = r.json?.data;
  const in30 = Date.now() + 30 * 86_400_000;
  check('предпросмотр: сокращение, вступит через 30 дней, счёт по политикам класса', r.ok && pv?.shortened === true && Math.abs(new Date(pv?.effectiveAt).getTime() - in30) < 120_000 && Array.isArray(pv?.counts) && pv.counts.some((x) => x.policyId === 'ChatterEntry'), JSON.stringify(pv));
  const t0 = new Date();
  r = await call('PUT', `${base}/settings`, tO, { dataClass: 'tenant_record', days: 30 });
  check('сокращение сохранено отложенным: действует прежний срок, дата вступления через 30 дней', r.ok && r.json?.data?.current === 'forever' && r.json?.data?.pending?.days === 30, JSON.stringify(r.json?.data?.pending));
  check('смена срока: событие журнала безопасности (организация видит)', (await prisma.securityEvent.count({ where: { eventKey: 'lifecycle.settings.changed', workspaceId: wsId, occurredAt: { gte: t0 } } })) === 1);
  let notif = 0;
  for (let i = 0; i < 20 && !notif; i++) {
    await new Promise((res) => setTimeout(res, 300));
    notif = await prisma.notification.count({ where: { userId: member.id, event: { type: 'lifecycle.retention.changed', workspaceId: wsId } } });
  }
  check('уведомление «срок изменён» — рядовому члену организации', notif === 1, notif);
  r = await call('GET', `/chatter/lifecycle_settings/${wsId}`, tO);
  check('хроника раздела сроков: запись о смене', r.ok && (r.json?.data?.items ?? []).some((e) => e.typeKey === 'lifecycle_settings.retention_changed'), `${r.status}`);
  r = await call('GET', `/chatter/lifecycle_settings/${wsId}`, member.token);
  check('хроника раздела — только владельцу и админу (403 члену)', r.status === 403, `${r.status}`);
  r = await call('DELETE', `${base}/settings/tenant_record/pending`, tO);
  check('отмена отложенного сокращения', r.ok && r.json?.data?.pending === null, `${r.status}`);
  r = await call('DELETE', `${base}/settings/tenant_record/pending`, tO);
  check('отменять нечего → 404 lifecycle.noPendingChange', r.status === 404 && r.code === 'lifecycle.noPendingChange', `${r.status} ${r.code}`);

  // Чтение в сроке: вступившее сокращение (время подвинуто в своей строке) режет хронику сразу
  await call('PUT', `${base}/settings`, tO, { dataClass: 'tenant_record', days: 30 });
  await prisma.lifecycleSetting.update({ where: { workspaceId_dataClass: { workspaceId: wsId, dataClass: 'tenant_record' } }, data: { pendingEffectiveAt: new Date(Date.now() - 1000) } });
  // Повтор того же срока — no-op, сбрасывающий кэш выбора этого процесса
  await call('PUT', `${base}/settings`, tO, { dataClass: 'tenant_record', days: 30 });
  const old = await prisma.chatterEntry.create({ data: { refType: 'workspace', refId: wsId, workspaceId: wsId, actorId: owner.id, typeKey: 'staff.unit_created', payload: { unitLabelKey: 'staff.unitLabel.department', unitName: 'Сьют старое' }, createdAt: new Date(Date.now() - 40 * 86_400_000) } });
  const fresh = await prisma.chatterEntry.create({ data: { refType: 'workspace', refId: wsId, workspaceId: wsId, actorId: owner.id, typeKey: 'staff.unit_created', payload: { unitLabelKey: 'staff.unitLabel.department', unitName: 'Сьют свежее' } } });
  r = await call('GET', `/workspaces/${wsId}/journal?limit=100`, tO);
  const ids = new Set((r.json?.data?.items ?? []).map((e) => String(e.id)));
  check('журнал организации: запись старше срока скрыта сразу, свежая видна', r.ok && !ids.has(String(old.id)) && ids.has(String(fresh.id)), `${r.status} old=${ids.has(String(old.id))} fresh=${ids.has(String(fresh.id))}`);
  r = await call('GET', `/chatter/workspace/${wsId}?limit=100`, tO);
  const ids2 = new Set((r.json?.data?.items ?? []).map((e) => String(e.id)));
  check('лента записи: то же правило', r.ok && !ids2.has(String(old.id)) && ids2.has(String(fresh.id)), `${r.status}`);
  r = await call('POST', '/lifecycle/dev/purge/run', t1, { policyId: 'ChatterEntry' });
  check('раннер: правило организации удаляет только её строки старше срока', r.ok && (await prisma.chatterEntry.count({ where: { id: old.id } })) === 0 && (await prisma.chatterEntry.count({ where: { id: fresh.id } })) === 1, `${r.status} ${r.code ?? ''}`);
  await prisma.chatterEntry.deleteMany({ where: { id: fresh.id } }).catch(() => undefined);

  // Заморозка организации (тариф — условием Кабинета): уведомление админу, хранителю — нет
  await call('POST', '/platform/commands/entitlements.override.set', ct, {
    input: { subject: { type: 'workspace', id: wsId }, key: 'lifecycle.holds', mode: 'set', value: true, reason: 'suite: legal holds of the organisation', validUntil: until },
    idempotencyKey: nodeCrypto.randomUUID(),
    reason: 'suite: legal holds of the organisation',
  });
  const t2h = new Date();
  const hold = await call('POST', `${base}/holds`, tO, { scope: 'custodian', custodianUserId: member.id, reasonCode: 'audit' });
  let adminNotified = 0;
  for (let i = 0; i < 20 && !adminNotified; i++) {
    await new Promise((res) => setTimeout(res, 300));
    adminNotified = await prisma.notification.count({ where: { userId: s3.id, event: { type: 'lifecycle.hold.created', workspaceId: wsId, createdAt: { gte: t2h } } } });
  }
  check('заморозка: уведомление админу организации', hold.ok && adminNotified === 1, `${hold.status} ${adminNotified}`);
  check('заморозка тихая: хранителю уведомления нет', (await prisma.notification.count({ where: { userId: member.id, event: { type: 'lifecycle.hold.created', createdAt: { gte: t2h } } } })) === 0);

  // Чип «Заморожено» карточки: руководитель и выше видит; рядовой и сам хранитель — «нет» без
  // отказа (тихая заморозка); не участник — 404; запись не своей организации — 404
  const st = (token, type, id, ws = wsId) => call('GET', `/workspaces/${ws}/lifecycle/holds/status?type=${type}&id=${id}`, token);
  r = await st(tO, 'user', member.id);
  check('статус заморозки: владелец видит хранителя под заморозкой', r.ok && r.json?.data?.held === true, `${r.status} ${JSON.stringify(r.json?.data)}`);
  r = await st(s3.token, 'user', member.id);
  check('статус заморозки: админ видит тоже', r.ok && r.json?.data?.held === true, `${r.status}`);
  r = await st(member.token, 'user', member.id);
  check('статус заморозки: хранитель о себе не узнаёт — «нет» без отказа', r.ok && r.json?.data?.held === false, `${r.status}`);
  r = await st(tO, 'user', s3.id);
  check('статус заморозки: человек без заморозки — «нет»', r.ok && r.json?.data?.held === false, `${r.status}`);
  // Хранитель — сам руководитель: по роли видел бы, но о своей заморозке не узнаёт
  const hAdm = await call('POST', `${base}/holds`, tO, { scope: 'custodian', custodianUserId: s3.id, reasonCode: 'audit' });
  r = await st(s3.token, 'user', s3.id);
  const selfHidden = r.ok && r.json?.data?.held === false;
  r = await st(tO, 'user', s3.id);
  check('хранитель-админ о своей заморозке не узнаёт, владелец видит', hAdm.ok && selfHidden && r.json?.data?.held === true, `${hAdm.status} self=${selfHidden} owner=${r.json?.data?.held}`);
  if (hAdm.json?.data?.id) await call('POST', `${base}/holds/${hAdm.json.data.id}/release`, tO, {});
  r = await st(tO, 'user', member.id, nodeCrypto.randomUUID());
  check('статус заморозки в чужой организации → 404 (не оракул)', r.status === 404, `${r.status} ${r.code}`);
  r = await st(tO, 'OrgDocument', nodeCrypto.randomUUID());
  check('статус записи не своей организации → 404', r.status === 404 && r.code === 'lifecycle.holdTargetInvalid', `${r.status} ${r.code}`);
  r = await st(tO, 'user', 'not-a-uuid');
  check('статус заморозки: кривой id → 400', r.status === 400, `${r.status}`);

  if (hold.json?.data?.id) await call('POST', `${base}/holds/${hold.json.data.id}/release`, tO, {});
  r = await st(tO, 'user', member.id);
  check('статус заморозки: после снятия — «нет»', r.ok && r.json?.data?.held === false, `${r.status}`);

  r = await call('GET', `${base}/summary`, tO);
  check('сводка страницы: место, записи по классам, заморозки', r.ok && Array.isArray(r.json?.data?.counts) && r.json.data.counts.length === 3 && typeof r.json?.data?.activeHolds === 'number', `${r.status}`);

  for (const key of [ceilingKey, 'lifecycle.holds']) {
    await call('POST', '/platform/commands/entitlements.override.clear', ct, { input: { subject: { type: 'workspace', id: wsId }, key }, idempotencyKey: nodeCrypto.randomUUID(), reason: 'suite: plan conditions cleanup' });
  }
  // Организация прогона — в архив (не копится у suite2 за места тарифа)
  await archiveSuiteWorkspace(wsId);

  // ---- Таймер чата ----
  r = await call('POST', '/messenger/chats/group', t1, { name: `Сьют-Таймер ${rnd()}`, memberIds: [s2.id] });
  const chatId = r.json?.data?.id;
  check('группа для таймера создана', r.ok && !!chatId, `${r.status} ${r.code ?? ''}`);
  r = await call('PUT', `/messenger/chats/${chatId}/timer`, s2.token, { days: 7 });
  check('таймер группы — только владелец и админ (403 участнику)', r.status === 403, `${r.status} ${r.code}`);
  r = await call('PUT', `/messenger/chats/${chatId}/timer`, t1, { days: 5 });
  check('таймер вне пресетов (1/7/30) → 400', r.status === 400, `${r.status}`);
  // Старые сообщения: плашка создания и одно «старое» — задним числом (seq и время растут вместе)
  const before = await prisma.chat.findUnique({ where: { id: chatId }, select: { lastSeq: true } });
  await prisma.message.create({ data: { chatId, authorId: s1.id, type: 'text', content: 'Сьют старое', seq: before.lastSeq + 1 } });
  await prisma.chat.update({ where: { id: chatId }, data: { lastSeq: before.lastSeq + 1 } });
  await prisma.message.updateMany({ where: { chatId }, data: { createdAt: new Date(Date.now() - 10 * 86_400_000) } });
  r = await call('PUT', `/messenger/chats/${chatId}/timer`, t1, { days: 7 });
  check('таймер 7 дней включён: сроки в деталях чата', r.ok && r.json?.data?.retention?.timerDays === 7 && r.json?.data?.retention?.effectiveDays === 7 && r.json?.data?.retention?.canChange === true, JSON.stringify(r.json?.data?.retention));
  r = await call('GET', `/messenger/chats/${chatId}/messages`, t1);
  const msgs = r.json?.data ?? [];
  check('лента: сообщения старше таймера скрыты сразу, плашка «таймер включён» видна', r.ok && !msgs.some((m) => m.content === 'Сьют старое') && msgs.some((m) => m.payload?.eventType === 'chat.timer_set'), JSON.stringify(msgs.map((m) => m.payload?.eventType ?? m.content)));
  r = await call('POST', '/lifecycle/dev/purge/run', t1, { policyId: 'Message' });
  check('раннер: таймер удаляет сообщения старше срока чата', r.ok && (await prisma.message.count({ where: { chatId, content: 'Сьют старое' } })) === 0, `${r.status} ${r.code ?? ''}`);
  r = await call('PUT', `/messenger/chats/${chatId}/timer`, t1, { days: null });
  check('таймер выключен: плашка «выключил»', r.ok && r.json?.data?.retention?.timerDays === null, `${r.status}`);
  await call('DELETE', `/messenger/chats/${chatId}`, t1);
}

// ---------------------------------------------------------------- 8. дашборд «Данные» Кабинета и отчёты бэкапов (Э5)
async function dataDashboard(prisma, s1) {
  console.log('\n-- 8. дашборд «Данные»: вкладки, отчёт бэкапа с подписью, команды --');
  const c = await consoleLogin(SUITE.p1);
  const ct = c.token;
  check('вход в Кабинет (suite1 — сотрудник платформы)', !!ct, c.login?.status);
  // Отчёт бэкапа: в разработке токен не задан — открыто; с токеном — подпись обязательна (проверяется в проде)
  const report = { kind: 'full', repo: 'repo1', status: 'ok', externalId: `suite-${rnd()}`, startedAt: new Date(Date.now() - 3600_000).toISOString(), finishedAt: new Date().toISOString(), bytes: 1024 };
  let r = await fetch(`${BASE}/lifecycle/ops/backups/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
  let j = await r.json().catch(() => ({}));
  check('отчёт бэкапа принят (dev без токена)', r.ok && j.data?.created === true, r.status);
  r = await fetch(`${BASE}/lifecycle/ops/backups/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
  j = await r.json().catch(() => ({}));
  check('повтор отчёта идемпотентен (та же строка)', r.ok && j.data?.created === false, r.status);
  r = await fetch(`${BASE}/lifecycle/ops/backups/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...report, kind: 'nonsense' }) });
  check('кривой отчёт → 400', r.status === 400, r.status);

  for (const tab of ['overview', 'storage', 'retention', 'erasure', 'backups', 'canary', 'summary']) {
    const t = await call('GET', `/platform/data/${tab}`, ct);
    check(`вкладка «${tab}» отвечает`, t.ok, `${t.status} ${t.code ?? ''}`);
    if (tab === 'overview') check('обзор: шесть плиток и «Нужно внимание»', ['database', 'backups', 'partitions', 'retention', 'erasure', 'canary'].every((k) => !!t.json?.data?.[k]?.level) && Array.isArray(t.json?.data?.attention), JSON.stringify(Object.keys(t.json?.data ?? {})));
    if (tab === 'backups') check('бэкапы: отчёт в прогонах, покрытие окна 35 суток', (t.json?.data?.runs ?? []).some((x) => x.repo === 'repo1') && (t.json?.data?.coverage ?? []).length === 35, `${(t.json?.data?.coverage ?? []).length}`);
    if (tab === 'retention') {
      // Кабинет не предлагает отвергаемого: признаки строки совпадают с условиями команд
      const rows = t.json?.data?.rows ?? [];
      const by = (id) => rows.find((x) => x.policyId === id);
      check(
        'сроки: «срок командой» только у построчного удаления без своего шага, прогон — у ведомых раннером',
        by('LifecycleRun')?.overridable === true && by('LifecycleRun')?.runnable === true && by('SecurityEvent')?.overridable === false && by('OrgDocument')?.runnable === false && by('OrgDocument')?.overridable === false,
        JSON.stringify(['LifecycleRun', 'SecurityEvent', 'OrgDocument'].map((id) => ({ id, run: by(id)?.runnable, ov: by(id)?.overridable }))),
      );
    }
  }
  const plain = await login(SUITE.p2);
  r = await call('GET', '/platform/data/overview', plain.token);
  check('продуктовый токен в Кабинет не пускает', r.status === 401 || r.status === 403, r.status);

  // Команды: пауза (step-up), срок политики (не ниже пола), пробный прогон, отчёт индексов
  await consoleSudo(ct);
  const pol = 'LifecycleRun';
  r = await call('POST', '/platform/commands/lifecycle.retention.pause', ct, { input: { policyId: pol, paused: true }, idempotencyKey: nodeCrypto.randomUUID(), reason: 'suite: pause the retention of runs' });
  check('пауза политики командой', r.ok && !!(await prisma.lifecyclePolicyOverride.findUnique({ where: { policyId: pol } }))?.paused, `${r.status} ${r.code ?? ''}`);
  const run = await call('POST', '/lifecycle/dev/purge/run', s1.token, { policyId: pol });
  check('раннер уважает паузу (stopped: paused)', run.ok && run.json?.data?.stoppedReason === 'paused', JSON.stringify(run.json?.data?.stoppedReason));
  r = await call('POST', '/platform/commands/lifecycle.retention.pause', ct, { input: { policyId: pol, paused: false }, idempotencyKey: nodeCrypto.randomUUID(), reason: 'suite: resume the retention of runs' });
  check('пауза снята — строки переопределения нет', r.ok && !(await prisma.lifecyclePolicyOverride.findUnique({ where: { policyId: pol } })), `${r.status}`);
  // Пол закона у тревог безопасности — 3 года: срок короче командой не задать
  r = await call('POST', '/platform/commands/lifecycle.retention.override', ct, { input: { policyId: 'SecurityAlert', days: 30 }, idempotencyKey: nodeCrypto.randomUUID(), reason: 'suite: override below the floor' });
  check('срок ниже пола закона → 400 lifecycle.retentionBelowFloor', r.status === 400 && r.code === 'lifecycle.retentionBelowFloor' && !(await prisma.lifecyclePolicyOverride.findUnique({ where: { policyId: 'SecurityAlert' } })), `${r.status} ${r.code}`);
  // Длиннее реестра — безопасное направление: задаётся и снимается
  r = await call('POST', '/platform/commands/lifecycle.retention.override', ct, { input: { policyId: 'SecurityAlert', days: 2000 }, idempotencyKey: nodeCrypto.randomUUID(), reason: 'suite: longer retention of alerts' });
  check('срок политики командой (длиннее реестра)', r.ok && (await prisma.lifecyclePolicyOverride.findUnique({ where: { policyId: 'SecurityAlert' } }))?.days === 2000, `${r.status} ${r.code ?? ''}`);
  r = await call('POST', '/platform/commands/lifecycle.retention.override', ct, { input: { policyId: 'SecurityAlert', days: null }, idempotencyKey: nodeCrypto.randomUUID(), reason: 'suite: back to the registry' });
  check('срок снят — снова по реестру', r.ok && !(await prisma.lifecyclePolicyOverride.findUnique({ where: { policyId: 'SecurityAlert' } })), `${r.status}`);
  r = await call('POST', '/platform/commands/lifecycle.retention.override', ct, { input: { policyId: 'WebhookDelivery', days: 10 }, idempotencyKey: nodeCrypto.randomUUID(), reason: 'suite: override of a partitioned log' });
  check('срок секционированного журнала командой не переопределяется', r.status === 400 && r.code === 'lifecycle.overrideNotSupported', `${r.status} ${r.code}`);
  r = await call('POST', '/platform/commands/lifecycle.indexes.report', ct, { input: {}, idempotencyKey: nodeCrypto.randomUUID() });
  check('отчёт неиспользуемых индексов', r.ok && Array.isArray(r.json?.data?.result?.indexes), `${r.status} ${r.code ?? ''}`);
  r = await call('POST', '/platform/commands/lifecycle.retention.dryRun', ct, { input: { policyId: 'LifecycleRun' }, idempotencyKey: nodeCrypto.randomUUID() });
  check('пробный прогон политики ставится', r.ok, `${r.status} ${r.code ?? ''}`);
  await prisma.lifecycleBackupRun.deleteMany({ where: { externalId: report.externalId } });

  // Упавшее стирание: в очереди дашборда сразу «застряло», повтор командой возвращает в работу и
  // снимает completedAt падения. Синтетическая заявка: случайная несуществующая организация и срок
  // в будущем — джоб повтора только ждёт срока; своя строка и свой джоб убираются по id
  const failedReq = await prisma.lifecycleErasureRequest.create({
    data: { subjectType: 'workspace', subjectId: nodeCrypto.randomUUID(), pseudonym: `suite-${rnd()}`, status: 'failed', errorCode: 'suite', effectiveAt: new Date(Date.now() + 30 * 86_400_000), completedAt: new Date() },
  });
  try {
    r = await call('GET', '/platform/data/erasure', ct);
    const row = (r.json?.data?.queue ?? []).find((x) => x.id === failedReq.id);
    check('упавшее стирание — в очереди дашборда и сразу «застряло»', r.ok && row?.status === 'failed' && row?.stuck === true, JSON.stringify(row ?? null));
    r = await call('POST', '/platform/commands/lifecycle.erasure.retry', ct, { input: { requestId: failedReq.id }, idempotencyKey: nodeCrypto.randomUUID(), reason: 'suite: retry a failed erasure' });
    const after = await prisma.lifecycleErasureRequest.findUnique({ where: { id: failedReq.id } });
    check('повтор стирания: снова в работе, completedAt и код ошибки сняты', r.ok && after?.status === 'running' && after?.completedAt === null && after?.errorCode === null, `${r.status} ${r.code ?? ''} ${after?.status} ${after?.completedAt}`);
  } finally {
    await prisma.job.deleteMany({ where: { uniqueKey: `erasure:${failedReq.id}` } });
    await prisma.lifecycleErasureRequest.delete({ where: { id: failedReq.id } }).catch(() => undefined);
  }
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

    // ---- 3. каждый ключ живого Redis принадлежит семейству, лежит в инстансе СВОЕЙ роли, срок в потолке ----
    // Два инстанса (docs/data_architecture.md): состояние (`REDIS_URL`, noeviction) и кэш (`REDIS_CACHE_URL`,
    // allkeys-lfu). Ключ состояния в кэше вытеснится под давлением памяти (снятая пауза, забытое
    // надгробие); ключ кэша в состоянии съест память, которую никто не вытеснит.
    const families = LIFECYCLE_POLICY_IDS.map((id) => LIFECYCLE_POLICIES[id]).filter((p) => p.store.kind === 'redis');
    const matchers = families.flatMap((p) => p.store.patterns.map((g) => ({ re: globRe(g), p })));
    const unknown = new Map();
    const immortal = new Map();
    const overTtl = new Map();
    const misplaced = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
    let scanned = 0;
    const cacheSeparate = !!process.env.REDIS_CACHE_URL && process.env.REDIS_CACHE_URL !== process.env.REDIS_URL;
    const instances = [{ role: 'state', client: redis }];
    if (cacheSeparate) instances.push({ role: 'cache', client: new Redis(process.env.REDIS_CACHE_URL, { maxRetriesPerRequest: 3 }) });
    for (const inst of instances) {
      let cursor = '0';
      do {
        const [next, keys] = await inst.client.scan(cursor, 'COUNT', 1000);
        cursor = next;
        const withTtl = keys.length ? await inst.client.pipeline(keys.map((k) => ['ttl', k])).exec() : [];
        keys.forEach((k, i) => {
          scanned++;
          const hit = matchers.find((m) => m.re.test(k));
          const shape = k.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>').replace(/\d{3,}/g, '<n>').split(':').slice(0, 3).join(':');
          if (!hit) return bump(unknown, `${inst.role} ${shape}`);
          const role = hit.p.store.role;
          // Чужие компоненты (LiveKit) — только в dev-инстансе состояния; в проде у них свой Redis
          if (cacheSeparate && (role === 'external' ? inst.role !== 'state' : role !== inst.role)) bump(misplaced, `${hit.p.id}(${role}) в ${inst.role}: ${shape}`);
          const ttl = withTtl[i]?.[1];
          const max = hit.p.store.maxTtlSeconds;
          if (max === null || role === 'external') return;
          if (ttl === -1) bump(immortal, `${hit.p.id} ${shape}`);
          // Срок больше потолка реестра — реестр лжёт о семействе (стирание, объём, ПДн считаются по потолку)
          else if (ttl > max + 60) bump(overTtl, `${hit.p.id} ${shape} ttl=${ttl}>${max}`);
        });
      } while (cursor !== '0');
    }
    for (const inst of instances.slice(1)) inst.client.disconnect();
    check(`каждый ключ живого Redis (${scanned}, инстансов: ${instances.length}) принадлежит семейству реестра`, unknown.size === 0, [...unknown].slice(0, 8).map(([s, n]) => `${s}×${n}`).join(', '));
    check('у семейств с потолком TTL нет ключей без срока (кэш без TTL = утечка навсегда)', immortal.size === 0, [...immortal].slice(0, 8).map(([s, n]) => `${s}×${n}`).join(', '));
    check('срок ключа не выше потолка его семейства в реестре', overTtl.size === 0, [...overTtl].slice(0, 8).map(([s, n]) => `${s}×${n}`).join(', '));
    if (cacheSeparate) check('каждый ключ лежит в инстансе роли своего семейства (состояние ≠ кэш)', misplaced.size === 0, [...misplaced].slice(0, 8).map(([s, n]) => `${s}×${n}`).join(', '));
    else console.log('  · REDIS_CACHE_URL не задан — размещение по ролям не проверяется (один инстанс)');

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

    // ---- Э5 ----
    await retentionSettings(prisma, s1);
    await dataDashboard(prisma, s1);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    redis.disconnect();
  }
  await finish();
}

main().catch(crash);
