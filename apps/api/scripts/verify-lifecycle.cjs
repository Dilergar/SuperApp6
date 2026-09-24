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
// Манифест CANARY_STORES перечисляет КАЖДОЕ хранилище реестра — страж сверяет его с реестром;
// ночная канарейка стирания (Э4) сеет маркеры именно в эти хранилища.
//
// Запуск (API поднят): node scripts/verify-lifecycle.cjs
const { PrismaClient, Prisma } = require('@prisma/client');
const Redis = require('ioredis');
const { BASE, makeChecker, crash } = require('./_lib.cjs');
const { LIFECYCLE_POLICIES, LIFECYCLE_POLICY_IDS } = require('@superapp/shared');

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
  'SecurityAlert', 'VisibilityPolicy', 'VisibilityRule', 'WorkspaceVisibilitySettings', 'Chat', 'ChatMember',
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
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    redis.disconnect();
  }
  await finish();
}

main().catch(crash);
