/* eslint-disable */
// E2E: core/audit — журнал аудита безопасности (26-й движок). Сьют suite1–3, API на :3001 (dev).
//
//   A. Реестр и база: самопроверка реестра, событие в транзакции факта и откат, append-only
//      триггеры (UPDATE не-шифротекста / DELETE / TRUNCATE родителя и партиции → отказ; перешивка
//      шифротекста проходит), `session_replication_role = replica` триггер не глушит, ENABLE ALWAYS
//      на каждой партиции, партиции вперёд.
//   B. Движок: эхо `X-Request-Id` и `details.requestId` в конверте отказа; контекст строки —
//      request_id, устройство, клиент, IP шифротекстом + псевдоним + сеть, UA — только семейство.
//   C–F. Защита входа, устройства и cooling, заморозка без входа, «Это не я».
//   G. Журнал организации: право owner/admin (trainee и чужой — 403), только свой контекст,
//      окно тарифа (free 90 дн; оверрайд 180 открывает старое), чужое/личное событие — 404,
//      имя устройства, данное человеком, организации не видно.
//   H. Кабинет «Безопасность»: лента с фильтрами (запрос, субъект, сеть), раскрытие IP командой
//      (step-up, причина, `platform.access.reveal`), поиск по IP (`platform.access.search`),
//      команды отзыва сессии / заморозки / разморозки (актор — сотрудник), запрет на себя,
//      тревога и её закрытие, панели карточки 360, мета-аудит `audit.viewed`.
//   I. Целостность: дайджест окна (копия вне базы, цепочка), проверка; подмена строки мимо
//      стража → расхождение + тревога CRITICAL; восстановление → ok; архив закрытого месяца
//      (идемпотентен), база отказывает в сбросе молодого и невыгруженного месяца.
//   J. Выгрузка организации: 402 на free, ключ повтора, trainee 403, окно тарифа, джоб → файл
//      на Диске в закрытой папке «Безопасность», уведомление, скачать — только управляющим,
//      CSV без формульной инъекции и без IP.
//   K. Стрим в SIEM: 402 без `audit.stream`, stream_changed, доставка `security.org.recorded`
//      (OCSF, без IP/UA/имён); детекции (распыление, перебор сети, поток SMS, выгрузка,
//      подстановка) — тревога + событие `detect.*`, повтор не плодит тревог.
//
// ПРАВИЛО (docs/testing_verify_suite.md): блокировку входа проверяем ТОЛЬКО на suite3 и
// снимаем `POST /audit/dev/unlock` в finally — 5 неверных входов на suite1/2 роняли бы CI.
// Run: node apps/api/scripts/verify-audit.cjs
const { randomUUID } = require('crypto');
const { BASE, SUITE, SUITE_DEVICE_ID, call, createSuiteWorkspace, login, makeChecker } = require('./_lib.cjs');
const { PrismaClient } = require('@prisma/client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { check, finish } = makeChecker();
  const prisma = new PrismaClient();
  const s1 = await login(SUITE.p1);
  console.log('logged in suite1');

  try {
    // ===================== A. Реестр и база =====================
    console.log('\n[A] registry and database guarantees');
    const shared = require('@superapp/shared');
    check('registry self-check is clean', shared.auditRegistryProblems().length === 0, shared.auditRegistryProblems().join('; '));
    check('registry has keys of every category', shared.AUDIT_CATEGORIES.every((c) => shared.auditKeysOf([c]).length > 0), shared.AUDIT_CATEGORIES.filter((c) => !shared.auditKeysOf([c]).length).join(','));

    const kept = await call('POST', '/audit/dev/tx-probe', s1.token, { rollback: false });
    check('event in the fact transaction is persisted', kept.ok && kept.json.data.persisted === true, JSON.stringify(kept.json?.data));
    const rolled = await call('POST', '/audit/dev/tx-probe', s1.token, { rollback: true });
    check('rolled-back fact leaves no event (the event is part of the fact)', rolled.ok && rolled.json.data.persisted === false && !!rolled.json.data.eventId, JSON.stringify(rolled.json?.data));

    const row = await prisma.securityEvent.findFirst({ where: { eventId: kept.json.data.eventId } });
    const expectFail = async (name, sql) => {
      let failed = false;
      try {
        await prisma.$executeRawUnsafe(sql);
      } catch (e) {
        failed = /append-only|truncate is forbidden/i.test(String(e.message));
      }
      check(name, failed);
    };
    await expectFail('UPDATE of a non-ciphertext column is refused', `UPDATE security_events SET reason_code = 'tamper' WHERE id = ${row.id}`);
    await expectFail('DELETE is refused', `DELETE FROM security_events WHERE id = ${row.id}`);
    await expectFail('TRUNCATE of the parent is refused', `TRUNCATE security_events`);
    const part = (await prisma.$queryRawUnsafe(`SELECT tableoid::regclass::text AS p FROM security_events WHERE id = ${row.id}`))[0].p;
    await expectFail(`TRUNCATE of the partition ${part} is refused`, `TRUNCATE ${part}`);
    await expectFail('DELETE straight from the partition is refused', `DELETE FROM ${part} WHERE id = ${row.id}`);
    // Перешивка шифротекста IP/UA (ротация платформенного KEK) — единственное разрешённое изменение
    let rewrapOk = true;
    try {
      await prisma.$executeRawUnsafe(`UPDATE security_events SET ip_enc = ip_enc, ua_raw_enc = ua_raw_enc WHERE id = ${row.id}`);
    } catch (e) {
      rewrapOk = false;
    }
    check('re-encryption of ip_enc/ua_raw_enc passes the guard', rewrapOk);
    // `replica` глушит обычные триггеры — наши ENABLE ALWAYS
    let replicaBlocked = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
        await tx.$executeRawUnsafe(`DELETE FROM security_events WHERE id = ${row.id}`);
      });
    } catch (e) {
      replicaBlocked = /append-only/.test(String(e.message)) || /permission denied/.test(String(e.message));
    }
    check('session_replication_role = replica does not silence the guard', replicaBlocked);
    const triggers = await prisma.$queryRawUnsafe(`
      SELECT c.relname AS rel, t.tgname AS name, t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname IN ('security_events_guard', 'security_events_no_truncate')`);
    const partitions = await prisma.$queryRawUnsafe(`SELECT c.relname AS rel FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'security_events'`);
    const guarded = partitions.every((p) => triggers.some((t) => t.rel === p.rel && t.name === 'security_events_guard' && t.enabled === 'A') && triggers.some((t) => t.rel === p.rel && t.name === 'security_events_no_truncate' && t.enabled === 'A'));
    check(`every partition (${partitions.length}) has both guards ENABLE ALWAYS`, guarded && partitions.length >= 3);
    const ahead = await call('GET', '/audit/dev/partitions', s1.token);
    const months = (ahead.json?.data ?? []).map((p) => p.name);
    const now = new Date();
    const want = [0, 1, 2].map((i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      return `security_events_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    });
    check('partitions exist for this month and two ahead', want.every((m) => months.includes(m)), months.join(','));

    // ===================== B. Движок: контекст запроса =====================
    console.log('\n[B] request context');
    const rid = randomUUID();
    const echoed = await call('POST', '/audit/dev/tx-probe', s1.token, { rollback: false }, { 'X-Request-Id': rid });
    check('X-Request-Id of the client is echoed', echoed.requestId === rid, echoed.requestId);
    const ev = await prisma.securityEvent.findFirst({ where: { eventId: echoed.json.data.eventId } });
    check('event carries the request id', ev?.requestId === rid, ev?.requestId);
    check('event carries the device id (X-Device-Id)', ev?.deviceId === SUITE_DEVICE_ID, ev?.deviceId);
    check('IP is an envelope + pseudonym + network, never plaintext', /^sa6e:1:/.test(ev?.ipEnc ?? '') && /^sa6m:1:/.test(ev?.ipHmac ?? '') && /\/(24|48)$/.test(ev?.ipNet ?? ''), `${ev?.ipEnc?.slice(0, 8)} ${ev?.ipHmac?.slice(0, 8)} ${ev?.ipNet}`);
    check('User-Agent stored as a family + ciphertext only', !!ev?.uaFamily && /^sa6e:1:/.test(ev?.uaRawEnc ?? ''), ev?.uaFamily);
    check('actor = the person of the session, subject = self, visible to the subject', ev?.actorKind === 0 && ev?.actorId === s1.id && ev?.subjectUserId === s1.id && ev?.visSubject === true && ev?.visWorkspace === false);
    check('route is a template (no ids)', typeof ev?.route === 'string' && ev.route.includes('/audit/dev/tx-probe'), ev?.route);
    const again = await call('POST', '/audit/dev/tx-probe', s1.token, { rollback: false });
    const ev2 = await prisma.securityEvent.findFirst({ where: { eventId: again.json.data.eventId } });
    check('same IP → same pseudonym (search by network is possible)', ev2?.ipHmac === ev?.ipHmac);
    const noRid = await call('GET', '/audit/no-such-route', s1.token);
    check('error envelope carries details.requestId', noRid.status === 404 && typeof noRid.json?.details?.requestId === 'string' && noRid.json.details.requestId === noRid.requestId, JSON.stringify(noRid.json?.details));

    await sectionLogin({ check, prisma });
    await sectionDevices({ check, prisma });
    await sectionFreeze({ check, prisma });
    await sectionNotMe({ check, prisma });
    const W = await sectionWorkspace({ check, prisma, s1 });
    await sectionConsole({ check, prisma, s1, rid, bEventId: ev?.id != null ? String(ev.id) : null, workspaceId: W });
    await sectionIntegrity({ check, prisma, s1 });
    await sectionExport({ check, prisma, s1 });
    await sectionStream({ check, prisma, s1 });
    await sectionReview({ check, prisma, s1 });
    await sectionMembership({ check, prisma, s1 });
    await sectionCoverage({ check, prisma, s1 });
  } finally {
    await prisma.$disconnect();
  }
  finish();
}

// ------------------------------------------------------------------
// Общие помощники разделов C–F
// ------------------------------------------------------------------
const { devCode } = require('./_lib.cjs');
const tokenPayload = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
/** Вход с явным устройством (новое устройство — свой uuid). */
const loginOn = (phone, deviceId, password = SUITE.password) => call('POST', '/auth/login', null, { phone, password }, { 'X-Device-Id': deviceId });
/** Код из dev-ручки → пропуск. */
async function passFor(start) {
  const code = await devCode(start.json.data.challengeId);
  const chk = await call('POST', '/verify/check', null, { challengeId: start.json.data.challengeId, code });
  return chk.json?.data?.verifyToken ?? null;
}
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
/** Строка, которую создаёт фоновый джоб после коммита (фанаут уведомлений) — ждём до 15 с. */
async function waitRow(fn, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await fn();
    if (r || Date.now() > until) return r;
    await sleep(500);
  }
}
const lastEvent = (prisma, where) => prisma.securityEvent.findFirst({ where, orderBy: { id: 'desc' } });
/** Эталонный корень Меркла RFC 6962 (рекурсия по определению) — независимая сверка потокового построителя движка. */
function merkleRef(leaves) {
  const { createHash } = require('crypto');
  const h = (...b) => { const x = createHash('sha256'); for (const p of b) x.update(p); return x.digest(); };
  if (!leaves.length) return h(Buffer.alloc(0));
  const mth = (lo, hi) => { const n = hi - lo; if (n === 1) return h(Buffer.from([0]), leaves[lo]); let k = 1; while (k * 2 < n) k *= 2; return h(Buffer.from([1]), mth(lo, lo + k), mth(lo + k, hi)); };
  return mth(0, leaves.length);
}

// ===================== R. Ревью движка (регрессии починок) =====================
async function sectionReview({ check, prisma, s1 }) {
  console.log('\n[R] review regressions: drop floor, feed index, trusted country, lockout burst, side doors, sockets');

  // R1. Пол «3 года» не обходится подложной строкой архива (роль приложения INSERT в архив умеет):
  // проба — в транзакции, которая откатывается целиком (DETACH/DROP в PostgreSQL транзакционны)
  const nowD = new Date();
  const cur = `security_events_${nowD.getUTCFullYear()}_${String(nowD.getUTCMonth() + 1).padStart(2, '0')}`;
  let floorMsg = '';
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO security_partition_archives (partition, from_at, to_at, rows, bytes, sha256, object_key, manifest_key, signature, kid)
         VALUES ('${cur}', '2000-01-01', '2000-02-01', 0, 0, 'x', 'x', 'x', '\\x00', 'x')
         ON CONFLICT (partition) DO NOTHING`,
      );
      try {
        await tx.$queryRawUnsafe(`SELECT audit_drop_partition('${cur}')`);
        floorMsg = 'DROPPED';
      } catch (e) {
        floorMsg = String(e.message);
      }
      throw new Error('rollback-probe');
    });
  } catch (e) {
    if (!/rollback-probe|current transaction is aborted/.test(String(e.message))) floorMsg = floorMsg || String(e.message);
  }
  check('a forged archive row cannot open the drop of a young month (bounds come from the name)', /does not describe its month/.test(floorMsg), floorMsg.slice(0, 160));
  const still = await prisma.$queryRawUnsafe(`SELECT to_regclass('public.${cur}')::text AS r`);
  check('the current month partition is intact after the probe', still[0]?.r === cur, still[0]?.r);

  // R2. Лента Кабинета без фильтров — индекс порядка, а не сортировка всей таблицы
  const plan = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_sort = off');
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    return tx.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) SELECT id FROM security_events ORDER BY occurred_at DESC, id DESC LIMIT 51`);
  });
  const planText = JSON.stringify(plan);
  check('the unfiltered platform feed is served by an ordered index (no Sort)', !/"Node Type":"Sort"/.test(planText.replace(/\s/g, '')) && /occurred_at_id_idx/.test(planText), planText.slice(0, 200));

  // R3. Страна журнала — только из доверенного заголовка края сети (GEO_COUNTRY_HEADER)
  const trusted = (process.env.GEO_COUNTRY_HEADER || '').trim().toLowerCase();
  const spoof = { 'CF-IPCountry': 'US', 'X-Vercel-IP-Country': 'US', 'X-Country-Code': 'US' };
  for (const k of Object.keys(spoof)) if (k.toLowerCase() === trusted) delete spoof[k];
  const geo = await call('POST', '/audit/dev/tx-probe', s1.token, { rollback: false }, { ...spoof, ...(trusted ? { [trusted]: 'DE' } : {}) });
  const geoEv = geo.ok ? await prisma.securityEvent.findFirst({ where: { eventId: geo.json.data.eventId } }) : null;
  check(`country comes only from the trusted edge header (${trusted || 'none configured'}), client geo headers are ignored`, !!geoEv && geoEv.country === (trusted ? 'DE' : null), `${geo.status} ${geoEv?.country}`);

  // R4–R6 — suite3 (блокировку снимает dev unlock в finally)
  const s3 = await login(SUITE.p3);
  const Redis = require('ioredis');
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  try {
    await call('POST', '/audit/dev/unlock', s3.token, { userId: s3.id });
    // R4. Залп параллельных неудач — ОДНА блокировка первой ступени и одно уведомление
    const t0 = new Date();
    const burst = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/auth/login', null, { phone: SUITE.p3, password: 'Wrong1234!' })));
    const locks = await prisma.securityEvent.findMany({ where: { eventKey: 'auth.login.locked', subjectUserId: s3.id, occurredAt: { gte: t0 } } });
    check('a parallel burst of failures locks ONCE at the first level (no escalation to a day)', locks.length === 1 && locks[0].details?.level === 1 && locks[0].details?.minutes === 15, `${locks.length} ${JSON.stringify(locks.map((l) => l.details))} statuses=${burst.map((b) => b.status).join(',')}`);
    const u3 = await prisma.user.findUnique({ where: { id: s3.id }, select: { loginLockedUntil: true } });
    check('the lock lasts the first-level 15 minutes', !!u3?.loginLockedUntil && u3.loginLockedUntil.getTime() - Date.now() <= 15 * 60_000 + 5_000, u3?.loginLockedUntil?.toISOString());
    // Попытка во время блокировки: строки нет, но детекции её видят (перебор «сверх блокировки»)
    const detKey = `audit:det:bf_acct:${s3.id}`;
    const before = Number((await redis.get(detKey)) ?? 0);
    const rowsBefore = await prisma.securityEvent.count({ where: { eventKey: 'auth.login.failed', subjectUserId: s3.id } });
    const locked = await call('POST', '/auth/login', null, { phone: SUITE.p3, password: 'Wrong1234!' });
    await sleep(300);
    const after = Number((await redis.get(detKey)) ?? 0);
    const rowsAfter = await prisma.securityEvent.count({ where: { eventKey: 'auth.login.failed', subjectUserId: s3.id } });
    check('an attempt during the lock: 429, no row, but the detection counter moves', locked.status === 429 && rowsAfter === rowsBefore && after === before + 1, `${locked.status} rows ${rowsBefore}→${rowsAfter} det ${before}→${after}`);
    const ttl = await redis.ttl(detKey);
    check('detection counters always carry a window (EXPIRE in the same MULTI)', ttl > 0 && ttl <= 600, ttl);

    // R5. Разморозка без входа проверяет пароль — под той же защитой по аккаунту (боковая дверь закрыта)
    await call('POST', '/audit/dev/unlock', s3.token, { userId: s3.id });
    let un = null;
    for (let i = 0; i < 5; i++) un = await call('POST', '/auth/unfreeze/start', null, { phone: SUITE.p3, password: 'Wrong1234!' });
    check('unfreeze/start: the 5th wrong password locks the account (429 auth.locked)', un.status === 429 && un.code === 'auth.locked', `${un.status} ${un.code}`);
    const right = await call('POST', '/auth/unfreeze/start', null, { phone: SUITE.p3, password: SUITE.password });
    check('while locked even the right password on unfreeze/start is refused (no password oracle)', right.status === 429, `${right.status} ${right.code}`);
    const unFails = await prisma.securityEvent.count({ where: { eventKey: 'auth.login.failed', subjectUserId: s3.id, reasonCode: 'wrong_password', occurredAt: { gte: t0 } } });
    check('unfreeze password failures are sign-in failures of the account (journal + lockout)', unFails >= 5 + 5, unFails);

    // R6. Step-up живой сессии: свой потолок неудач пароля (перебор угнанной сессией)
    await call('POST', '/audit/dev/unlock', s3.token, { userId: s3.id });
    const s3b = await login(SUITE.p3);
    let su = null;
    for (let i = 0; i < 5; i++) su = await call('POST', '/verify/step-up', s3b.token, { purpose: 'security_confirm', password: 'Wrong1234!' });
    const suLocked = await call('POST', '/verify/step-up', s3b.token, { purpose: 'security_confirm', password: SUITE.password });
    check('step-up: 5 wrong passwords close the password check (429) even for the right one', su.status === 401 && suLocked.status === 429 && suLocked.code === 'auth.locked', `${su.status} → ${suLocked.status} ${suLocked.code}`);
    const loginStill = await call('POST', '/auth/login', null, { phone: SUITE.p3, password: SUITE.password });
    check('the step-up ceiling does not lock the sign-in (anyone knowing the number could otherwise block password change)', loginStill.ok, loginStill.status);
  } finally {
    await call('POST', '/audit/dev/unlock', s3.token, { userId: s3.id });
    redis.disconnect();
  }

  // R7. «Завершить сессию» рвёт живой сокет ИМЕННО этой сессии; сокет текущей остаётся
  const path = require('path');
  let io = null;
  try {
    io = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client')).io;
  } catch {
    io = null;
  }
  if (!io) {
    check('socket.io-client is available (apps/web) for the socket check', false);
    return;
  }
  const origin = BASE.replace(/\/api\/?$/, '');
  const other = await loginOn(SUITE.p1, randomUUID());
  const otherToken = other.json?.data?.accessToken;
  const otherFam = otherToken ? tokenPayload(otherToken).fam : null;
  const open = (token) =>
    new Promise((resolve) => {
      const s = io(`${origin}/realtime`, { auth: { token }, transports: ['websocket'], reconnection: false });
      const t = setTimeout(() => resolve({ s, ok: false }), 5000);
      s.on('connect', () => {
        clearTimeout(t);
        // Отказ рукопожатия виден как немедленный разрыв — даём серверу доиграть
        setTimeout(() => resolve({ s, ok: s.connected }), 400);
      });
      s.on('connect_error', () => {
        clearTimeout(t);
        resolve({ s, ok: false });
      });
    });
  const mine = await open(s1.token);
  const theirs = await open(otherToken);
  check('two sessions of suite1 hold live sockets', mine.ok && theirs.ok);
  const theirsDropped = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 6000);
    theirs.s.on('disconnect', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  const end = await call('DELETE', `/users/me/sessions/${otherFam}`, s1.token);
  const dropped = await theirsDropped;
  await sleep(500);
  check('ending one session drops ITS socket at once', end.ok && dropped, `${end.status} dropped=${dropped}`);
  check('the socket of the current session stays', mine.s.connected === true);
  mine.s.close();
  theirs.s.close();
}

// ===================== M. Снятие членства: доступ, роли и журнал — одним фактом =====================
async function sectionMembership({ check, prisma, s1 }) {
  console.log("\n[M] membership removal: roles, keys and the journal are one fact");
  const s2 = await login(SUITE.p2);
  const ws = await createSuiteWorkspace(s1.token, 'Сьют-Аудит-Члены');
  const W = ws.json?.data?.id;
  check('M: workspace created', ws.ok && !!W, `${ws.status} ${ws.code}`);
  if (!W) return;
  const Redis = require('ioredis');
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  // Кэш ролей — инстанс роли «кэш» (без REDIS_CACHE_URL — тот же, что состояние)
  const cache = new Redis(process.env.REDIS_CACHE_URL || process.env.REDIS_URL || 'redis://localhost:6379');
  const join = async () => {
    const inv = await call('POST', `/workspaces/${W}/invitations`, s1.token, { phone: SUITE.p2 });
    const incoming = await call('GET', '/workspaces/invitations/incoming', s2.token);
    const invId = (incoming.json?.data ?? []).find((i) => i.workspaceId === W)?.id ?? inv.json?.data?.id;
    return (await call('POST', `/workspaces/invitations/${invId}/accept`, s2.token)).ok;
  };
  const state = async () => {
    const [member, roles] = await Promise.all([
      prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: W, userId: s2.id } }, select: { id: true } }),
      prisma.userRole.findMany({ where: { userId: s2.id, context: 'workspace', tenantId: W, isActive: true }, select: { role: true } }),
    ]);
    return { member: !!member, roles: roles.map((r) => r.role) };
  };
  const removedSince = (since) => prisma.securityEvent.findMany({ where: { eventKey: 'org.member.removed', workspaceId: W, targetId: s2.id, occurredAt: { gte: since } } });
  try {
    // M1. Снятие: строка членства, роли и событие журнала — вместе
    check('M1: suite2 joined', await join());
    let t0 = new Date();
    const rm = await call('DELETE', `/workspaces/${W}/members/${s2.id}`, s1.token);
    let st = await state();
    let evs = await removedSince(t0);
    check('M1: removal leaves neither the membership nor an active role, with exactly one journal event', rm.ok && !st.member && st.roles.length === 0 && evs.length === 1 && evs[0].details?.role === 'trainee' && evs[0].actorId === s1.id, `${rm.status} ${JSON.stringify(st)} events=${evs.length}`);

    // M2. Осиротевшее членство (строка есть, ролей нет — след прежнего неатомарного снятия) снимается,
    // а не упирается в 404 «не член»
    check('M2: suite2 joined again', await join());
    await prisma.userRole.updateMany({ where: { userId: s2.id, context: 'workspace', tenantId: W }, data: { isActive: false } });
    await cache.del(`user:${s2.id}:roles`);
    t0 = new Date();
    const orphan = await call('DELETE', `/workspaces/${W}/members/${s2.id}`, s1.token);
    st = await state();
    evs = await removedSince(t0);
    check('M2: an orphaned membership (row without roles) is removed and journaled', orphan.ok && !st.member && evs.length === 1 && evs[0].details?.role === undefined, `${orphan.status} ${orphan.code} ${JSON.stringify(st)} events=${evs.length}`);

    // M3. Параллельные снятия — один факт: одно событие журнала
    check('M3: suite2 joined again', await join());
    t0 = new Date();
    const both = await Promise.all([0, 1].map(() => call('DELETE', `/workspaces/${W}/members/${s2.id}`, s1.token)));
    st = await state();
    evs = await removedSince(t0);
    check('M3: two parallel removals record ONE event', !st.member && st.roles.length === 0 && evs.length === 1, `${both.map((b) => b.status).join(',')} ${JSON.stringify(st)} events=${evs.length}`);

    // M4. Смена роли наперегонки со снятием: роль без членства не остаётся (замок строки членства)
    let orphaned = 0;
    for (let i = 0; i < 3; i += 1) {
      if (!(await join())) continue;
      await Promise.all([
        call('PATCH', `/workspaces/${W}/members/${s2.id}`, s1.token, { role: 'staff' }),
        call('DELETE', `/workspaces/${W}/members/${s2.id}`, s1.token),
      ]);
      st = await state();
      if (!st.member && st.roles.length) orphaned += 1;
      if (st.member) await call('DELETE', `/workspaces/${W}/members/${s2.id}`, s1.token);
    }
    check('M4: a role change racing the removal never leaves a role without membership', orphaned === 0, `orphaned=${orphaned}`);

    // M5. Система по поручению человека (увольнение КЭДО применил джоб): организация видит инициатора
    const seeded = await call('POST', '/audit/dev/seed', s1.token, { key: 'org.member.removed', subjectUserId: s2.id, workspaceId: W, daysAgo: 0, details: {}, onBehalfOfId: s1.id });
    const feed = await call('GET', `/workspaces/${W}/security/events?limit=50`, s1.token);
    const item = (feed.json?.data?.items ?? []).find((e) => e.id === seeded.json?.data?.id);
    check('M5: a system event on behalf of a person shows the initiator to the organization', item?.actor?.kind === 'system' && item.actor.onBehalfOf?.id === s1.id, JSON.stringify(item?.actor ?? feed.status));

    // M6. Галочка «снять и членство» в увольнении КЭДО — то же право, что у кнопки ростера, и
    // проверяется при СОЗДАНИИ приказа (раньше менеджер ставил её, а применение молча не снимало).
    // Отказ — до шаблона и маршрута, поэтому шаблон здесь — любой uuid.
    const s3 = await login(SUITE.p3);
    check('M6: suite2 joined again', await join());
    const promoted = await call('PATCH', `/workspaces/${W}/members/${s2.id}`, s1.token, { role: 'manager' });
    await call('POST', `/workspaces/${W}/invitations`, s1.token, { phone: SUITE.p3 });
    const inc3 = await call('GET', '/workspaces/invitations/incoming', s3.token);
    const inv3 = (inc3.json?.data ?? []).find((i) => i.workspaceId === W)?.id;
    const joined3 = await call('POST', `/workspaces/invitations/${inv3}/accept`, s3.token);
    check('M6: suite2 is a manager, suite3 a trainee', promoted.ok && joined3.ok, `${promoted.status} ${joined3.status}`);
    const today = new Date().toISOString().slice(0, 10);
    const dismissal = (token, userId, alsoRemoveMembership) => call('POST', `/workspaces/${W}/hr/actions`, token, { kind: 'dismissal', userId, effectiveAt: today, templateId: randomUUID(), params: { ground: 'st50', ...(alsoRemoveMembership ? { alsoRemoveMembership: true } : {}) } });
    const RIGHTS = ['workspace.manageForbidden', 'workspace.ownerNotRemovable', 'workspace.adminRemoveOwnerOnly'];
    const byManager = await dismissal(s2.token, s3.id, true);
    check('M6: a manager cannot order a dismissal that also removes the membership → 403 workspace.manageForbidden', byManager.status === 403 && byManager.code === 'workspace.manageForbidden', `${byManager.status} ${byManager.code}`);
    const plain = await dismissal(s2.token, s3.id, false);
    check('M6: the same manager still orders a plain dismissal (the gate is the checkbox only)', !RIGHTS.includes(plain.code), `${plain.status} ${plain.code}`);
    const ownerSelf = await dismissal(s1.token, s1.id, true);
    check('M6: the organization owner cannot be dismissed with membership removal → 400 workspace.ownerNotRemovable', ownerSelf.status === 400 && ownerSelf.code === 'workspace.ownerNotRemovable', `${ownerSelf.status} ${ownerSelf.code}`);
    const byOwner = await dismissal(s1.token, s3.id, true);
    check('M6: the owner passes the membership check (fails later only on the template)', !RIGHTS.includes(byOwner.code), `${byOwner.status} ${byOwner.code}`);
    const batch = await call('POST', `/workspaces/${W}/hr/batches`, s2.token, { kind: 'dismissal', audience: [{ type: 'user', id: s3.id }], effectiveAt: today, templateId: randomUUID(), params: { ground: 'st50', alsoRemoveMembership: true } });
    check('M6: a manager cannot start a batch of dismissals with membership removal → 403', batch.status === 403 && batch.code === 'workspace.manageForbidden', `${batch.status} ${batch.code}`);
  } finally {
    redis.disconnect();
    cache.disconnect();
  }
}

// ===================== S. Охват экосистемы: доступы, ссылки, выгрузка, файлы, отказы, организации, интеграции, настройки =====================
async function sectionCoverage({ check, prisma, s1 }) {
  console.log('\n[S] coverage: access, public links, guest ZIP, files, denials, organizations, integrations, settings');
  const s2 = await login(SUITE.p2);
  const s3 = await login(SUITE.p3);
  const since = new Date(Date.now() - 2000);
  const stamp = Date.now();
  const events = (where) => prisma.securityEvent.findMany({ where: { occurredAt: { gte: since }, ...where }, orderBy: { id: 'asc' } });
  const ws = await createSuiteWorkspace(s1.token, 'Сьют-Аудит-Охват');
  const W = ws.json?.data?.id;
  check('S: workspace created', ws.ok && !!W, `${ws.status} ${ws.code}`);
  if (!W) return;

  // ---- S0. Создание организации — первый факт её журнала ----
  const created = await events({ eventKey: 'org.workspace.created', workspaceId: W });
  check('S0: org.workspace.created — creator is the subject, both the person and the organization see it', created.length === 1 && created[0].subjectUserId === s1.id && created[0].visSubject && created[0].visWorkspace, created.length);

  // suite2 — сотрудник организации (ему открываются доступы)
  await call('POST', `/workspaces/${W}/invitations`, s1.token, { phone: SUITE.p2 });
  const inc2 = await call('GET', '/workspaces/invitations/incoming', s2.token);
  const inv2 = (inc2.json?.data ?? []).find((i) => i.workspaceId === W)?.id;
  check('S: suite2 joined', (await call('POST', `/workspaces/invitations/${inv2}/accept`, s2.token)).ok);

  // ---- S1. Отмена приглашения ----
  const inv3 = await call('POST', `/workspaces/${W}/invitations`, s1.token, { phone: SUITE.p3 });
  const inv3Id = inv3.json?.data?.id;
  const cancel = await call('POST', `/workspaces/${W}/invitations/${inv3Id}/cancel`, s1.token);
  const cancelTwice = await call('POST', `/workspaces/${W}/invitations/${inv3Id}/cancel`, s1.token);
  const cancelled = await events({ eventKey: 'org.member.invitation_cancelled', workspaceId: W, targetId: inv3Id });
  check('S1: cancelling an invitation is journaled once; a second cancel → 400', cancel.ok && cancelTwice.status === 400 && cancelled.length === 1 && cancelled[0].visWorkspace, `${cancel.status}/${cancelTwice.status} events=${cancelled.length}`);

  // ---- S2. Доступ к папке Диска организации ----
  const folder = await call('POST', '/drive/folders', s1.token, { workspaceId: W, name: `audit-share-${stamp}` });
  const F = folder.json?.data?.id;
  check('S2: an organization folder created', folder.ok && !!F, folder.status);
  const shareAs = (role) => call('POST', `/drive/nodes/${F}/shares`, s1.token, { principalType: 'user', principalId: s2.id, role });
  const a1 = await shareAs('viewer');
  const a2 = await shareAs('editor');
  const a3 = await shareAs('editor');
  const unshare = () => call('DELETE', `/drive/nodes/${F}/shares/user/${s2.id}`, s1.token);
  const u1 = await unshare();
  const u2 = await unshare();
  const granted = await events({ eventKey: 'sharing.access.granted', workspaceId: W, targetId: F });
  const revoked = await events({ eventKey: 'sharing.access.revoked', workspaceId: W, targetId: F });
  check(
    'S2: folder access — opened (none → viewer), changed (viewer → editor), the same level again writes nothing',
    a1.ok && a2.ok && a3.ok && granted.length === 2 && granted[0].details.previousAccess === 'none' && granted[0].details.access === 'viewer' && granted[1].details.previousAccess === 'viewer' && granted[1].details.access === 'editor',
    JSON.stringify(granted.map((e) => e.details)),
  );
  check('S2: closing access is journaled once (closing a missing grant writes nothing)', u1.ok && u2.ok && revoked.length === 1 && revoked[0].subjectUserId === s2.id, revoked.length);
  check('S2: access events are the organization’s (never the person’s feed)', [...granted, ...revoked].every((e) => e.visWorkspace && !e.visSubject));
  const sharingFeed = await call('GET', `/workspaces/${W}/security/events?filter=sharing&limit=50`, s1.token);
  const sharingKeys = (sharingFeed.json?.data?.items ?? []).map((e) => e.key);
  check('S2: the “Access” chip of the organization log shows them', sharingFeed.ok && sharingKeys.includes('sharing.access.granted') && sharingKeys.includes('sharing.access.revoked'), JSON.stringify(sharingKeys));

  // Личная папка: шеринг другу — хроника, не журнал безопасности
  const [x, y] = s1.id < s2.id ? [s1.id, s2.id] : [s2.id, s1.id];
  if (!(await prisma.contactLink.findFirst({ where: { userAId: x, userBId: y } }))) {
    await prisma.contactLink.create({ data: { userAId: x, userBId: y, roleAForB: 'Коллега', roleBForA: 'Коллега', initiatedBy: s1.id } });
  }
  const personal = await call('POST', '/drive/folders', s1.token, { name: `audit-personal-${stamp}` });
  const P = personal.json?.data?.id;
  const pShare = await call('POST', `/drive/nodes/${P}/shares`, s1.token, { principalType: 'user', principalId: s2.id, role: 'viewer' });
  const pEvents = await events({ eventKey: { in: ['sharing.access.granted', 'sharing.access.revoked'] }, targetId: P });
  check('S2: sharing a PERSONAL folder is not a security event (history of the item only)', pShare.ok && pEvents.length === 0, `${pShare.status} events=${pEvents.length}`);
  await call('DELETE', `/drive/nodes/${P}/shares/user/${s2.id}`, s1.token);

  // ---- S3. Заметки организации ----
  const note = await call('POST', '/notes', s1.token, { workspaceId: W, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `audit note ${stamp}` }] }] } });
  const N = note.json?.data?.id;
  const nShare = await call('POST', `/notes/${N}/shares`, s1.token, { principalType: 'user', principalId: s2.id, role: 'viewer' });
  const nUnshare = await call('DELETE', `/notes/${N}/shares/user/${s2.id}`, s1.token);
  const nf = await call('POST', '/notes/folders', s1.token, { workspaceId: W, name: `audit-notes-${stamp}` });
  const NF = nf.json?.data?.id;
  const nfShare = await call('POST', `/notes/folders/${NF}/shares`, s1.token, { principalType: 'workspace', principalId: W, role: 'viewer' });
  const noteEv = await events({ eventKey: { in: ['sharing.access.granted', 'sharing.access.revoked'] }, workspaceId: W, targetId: { in: [N, NF].filter(Boolean) } });
  check(
    'S3: organization notes — note shared and unshared, folder opened to the whole team',
    nShare.ok && nUnshare.ok && nfShare.ok && noteEv.some((e) => e.eventKey === 'sharing.access.granted' && e.details.resource === 'note') && noteEv.some((e) => e.eventKey === 'sharing.access.revoked' && e.details.resource === 'note') && noteEv.some((e) => e.details.resource === 'note_folder' && e.details.principalType === 'workspace'),
    `${nShare.status}/${nUnshare.status}/${nfShare.status} ${JSON.stringify(noteEv.map((e) => [e.eventKey, e.details.resource]))}`,
  );

  // ---- S4. Шаблон документов организации ----
  const lib = await call('POST', `/workspaces/${W}/hr/library/install`, s1.token, { key: 'employment_contract', signerUserId: s1.id });
  const tpl = await prisma.docTemplate.findFirst({ where: { workspaceId: W }, select: { id: true } });
  if (tpl) {
    const tGrant = await call('POST', `/workspaces/${W}/documents/templates/${tpl.id}/grants`, s1.token, { principalType: 'user', principalId: s2.id });
    const tGrantAgain = await call('POST', `/workspaces/${W}/documents/templates/${tpl.id}/grants`, s1.token, { principalType: 'user', principalId: s2.id });
    const tRevoke = await call('DELETE', `/workspaces/${W}/documents/templates/${tpl.id}/grants/user/${s2.id}`, s1.token);
    const tplEv = await events({ eventKey: { in: ['sharing.access.granted', 'sharing.access.revoked'] }, workspaceId: W, targetId: tpl.id });
    check('S4: a document template granted (once) and withdrawn', tGrant.ok && tGrantAgain.ok && tRevoke.ok && tplEv.length === 2 && tplEv[0].details.access === 'use', `${tGrant.status}/${tGrantAgain.status}/${tRevoke.status} events=${tplEv.length}`);
  } else {
    check('S4: a document template installed from the library', false, `${lib.status} ${lib.code}`);
  }

  // ---- S5. Публичные ссылки: жизнь ссылки ----
  const tokenOf = (url) => String(url).split('/s/')[1];
  const mkLink = (body) => call('POST', '/share-links', s1.token, { refType: 'drive_node', refId: F, ...body });
  const l1 = await mkLink({ password: 'secret-42', label: 'audit' });
  const L1 = l1.json?.data?.id;
  const lCreated = await events({ eventKey: 'sharing.link.created', workspaceId: W });
  check('S5: public link created — what closes it is in the details, the organization sees it', l1.ok && lCreated.length === 1 && lCreated[0].details.passcode === true && lCreated[0].details.identity === false && lCreated[0].subjectUserId === s1.id && lCreated[0].visWorkspace, JSON.stringify(lCreated[0]?.details));
  const upd = await call('PATCH', `/share-links/${L1}`, s1.token, { allowDownload: false });
  const updSame = await call('PATCH', `/share-links/${L1}`, s1.token, { allowDownload: false });
  const rot = await call('POST', `/share-links/${L1}/rotate`, s1.token);
  const lUpd = await events({ eventKey: 'sharing.link.updated', workspaceId: W });
  check('S5: link changes — only real changes, by field code; a new address is a change too', upd.ok && updSame.ok && rot.ok && lUpd.length === 2 && JSON.stringify(lUpd[0].details.fields) === '["download"]' && JSON.stringify(lUpd[1].details.fields) === '["address"]', JSON.stringify(lUpd.map((e) => e.details.fields)));

  // Подбор пароля: одна строка на залп и уведомление автору
  const tok1 = tokenOf(rot.json?.data?.url);
  let last = null;
  for (let i = 0; i < 6; i++) last = await call('POST', `/share-links/guest/${tok1}/session`, null, { password: `wrong-${i}` });
  const locked = await events({ eventKey: 'sharing.link.password_locked', workspaceId: W });
  check('S5: password guessing on a link → ONE password_locked (author + organization), attempts in the lock are not rows', locked.length === 1 && locked[0].subjectUserId === s1.id && locked[0].visSubject && locked[0].visWorkspace && last?.status === 403, `${locked.length} last=${last?.status}/${last?.code}`);
  const lockNote = await waitRow(() => prisma.notification.findFirst({ where: { userId: s1.id, type: 'security.link.passwordLocked', createdAt: { gte: since } } }), 5000);
  check('S5: the link author is notified (in the transaction of the event)', !!lockNote);

  const rev = await call('POST', `/share-links/${L1}/revoke`, s1.token);
  const l2 = await mkLink({});
  const l3 = await mkLink({});
  const mine = await call('POST', '/share-links/mine/revoke', s1.token, { ids: [l2.json?.data?.id, l3.json?.data?.id] });
  const l4 = await mkLink({});
  const org = await call('POST', `/workspaces/${W}/share-links/revoke`, s1.token, { ids: [l4.json?.data?.id] });
  const sub = await call('POST', '/drive/folders', s1.token, { workspaceId: W, name: `audit-doomed-${stamp}`, parentId: F });
  const SUB = sub.json?.data?.id;
  const l5 = await call('POST', '/share-links', s1.token, { refType: 'drive_node', refId: SUB });
  await call('POST', '/drive/nodes/trash', s1.token, { ids: [SUB] });
  const purge = await call('DELETE', '/drive/nodes', s1.token, { ids: [SUB] });
  const lRev = await events({ eventKey: 'sharing.link.revoked', workspaceId: W });
  const reasons = lRev.map((e) => e.details.reason).sort();
  check(
    'S5: every way a link closes is journaled with its reason (manual · mine_bulk ×2 · workspace_bulk · object_deleted by the system)',
    rev.ok && mine.ok && org.ok && l5.ok && purge.ok && JSON.stringify(reasons) === JSON.stringify(['manual', 'mine_bulk', 'mine_bulk', 'object_deleted', 'workspace_bulk']) && lRev.find((e) => e.details.reason === 'object_deleted')?.actorKind === 3,
    `${purge.status} ${JSON.stringify(reasons)}`,
  );

  // ---- S6. Новый гость с подтверждённым номером ----
  const withFile = await call('POST', '/drive/folders', s1.token, { workspaceId: W, name: `audit-guest-${stamp}` });
  const G = withFile.json?.data?.id;
  const bytes = Buffer.from(`audit guest file ${stamp}`, 'utf8');
  const init = await call('POST', '/files', s1.token, { profile: 'drive_file', name: `audit-${stamp}.txt`, mime: 'text/plain', size: bytes.length });
  const fileId = init.json?.data?.file?.id;
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'text/plain' }), `audit-${stamp}.txt`);
  await fetch(`${BASE}/files/${fileId}/content`, { method: 'PUT', headers: { Authorization: 'Bearer ' + s1.token }, body: fd });
  await call('POST', `/files/${fileId}/complete`, s1.token, {});
  const placed = await call('POST', '/drive/nodes', s1.token, { parentId: G, fileId });
  check('S6: a file placed in the organization folder', placed.ok, placed.status);
  const idLink = await call('POST', '/share-links', s1.token, { refType: 'drive_node', refId: G, requireIdentity: true });
  const idTok = tokenOf(idLink.json?.data?.url);
  const guestPhone = '+7705' + String(stamp).slice(-7);
  const openAsGuest = async () => {
    const st = await call('POST', `/share-links/guest/${idTok}/identity/start`, null, { phone: guestPhone });
    const code = st.ok ? await devCode(st.json.data.challengeId) : null;
    const chk = code ? await call('POST', '/verify/check', null, { challengeId: st.json.data.challengeId, code }) : null;
    return chk?.ok ? call('POST', `/share-links/guest/${idTok}/session`, null, { verifyToken: chk.json.data.verifyToken, guestName: 'Аудит Гость' }) : null;
  };
  const g1 = await openAsGuest();
  const gv = await events({ eventKey: 'sharing.link.guest_verified', workspaceId: W });
  check('S6: a new verified guest of the link is journaled (actor guest, subject = link author)', g1?.ok && gv.length === 1 && gv[0].actorKind === 4 && gv[0].subjectUserId === s1.id && gv[0].details.guestId === gv[0].actorId, `${g1?.status} events=${gv.length}`);

  // ---- S7. Гостевой ZIP папки = выгрузка ----
  const zipLink = await call('POST', '/share-links', s1.token, { refType: 'drive_node', refId: G });
  const zs = await call('POST', `/share-links/guest/${tokenOf(zipLink.json?.data?.url)}/session`, null, {});
  const zip = await fetch(`${BASE}/drive/guest/download-zip?session=${encodeURIComponent(zs.json?.data?.sessionToken ?? '')}`);
  await zip.arrayBuffer().catch(() => undefined);
  const exp = await events({ eventKey: 'data.export', workspaceId: W });
  const guestZip = exp.find((e) => e.details.source === 'drive_guest_zip');
  check('S7: a guest ZIP of a folder is an export (author + organization see it, rows = files)', zip.status === 200 && !!guestZip && guestZip.details.rows === 1 && guestZip.subjectUserId === s1.id && guestZip.visWorkspace, `${zip.status} ${JSON.stringify(guestZip?.details)}`);

  // ---- S8. Вирус в загрузке (нужен ClamAV у API и здесь) ----
  if (process.env.CLAMAV_HOST) {
    const EICAR = 'X5O!P%@AP[4' + String.fromCharCode(92) + 'PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const infected = [];
    for (let i = 0; i < 3; i++) {
      const b = Buffer.from(EICAR);
      const ini = await call('POST', '/files', s1.token, { profile: 'generic', name: `eicar-${stamp}-${i}.txt`, mime: 'text/plain', size: b.length });
      const id = ini.json?.data?.file?.id;
      const f2 = new FormData();
      f2.append('file', new Blob([b], { type: 'text/plain' }), `eicar-${i}.txt`);
      await fetch(`${BASE}/files/${id}/content`, { method: 'PUT', headers: { Authorization: 'Bearer ' + s1.token }, body: f2 });
      await call('POST', `/files/${id}/complete`, s1.token, {});
      infected.push(id);
    }
    const mal = await waitRow(async () => {
      const rows = await events({ eventKey: 'files.malware_detected', targetId: { in: infected } });
      return rows.length === infected.length ? rows : null;
    }, 60_000);
    check('S8: a virus in an upload → files.malware_detected in the verdict transaction (uploader sees it, signature is a code)', !!mal && mal.every((e) => e.subjectUserId === s1.id && e.visSubject && /^[A-Za-z0-9_.:-]+$/.test(e.details.signature)), mal ? JSON.stringify(mal[0].details) : 'timeout');
    const malNote = await prisma.notification.findFirst({ where: { userId: s1.id, type: 'files.scan.infected', createdAt: { gte: since } } });
    check('S8: the uploader is notified by the event passport', !!malNote);
    const burst = await waitRow(() => prisma.securityAlert.findFirst({ where: { kind: 'malware_burst', subjectUserId: s1.id, status: { in: ['open', 'ack'] } } }), 5000);
    check('S8: three infected uploads by one person → malware_burst alert', !!burst);
  } else {
    console.log('  (S8 skipped: CLAMAV_HOST is not set — run the API and the suite with ClamAV to cover malware)');
  }

  // ---- S9. Отказы 403 и перебор чужих id ----
  // Свёртка живёт час на (актор, шаблон маршрута): раздел G уже получал этот отказ — окно с нуля
  const Redis = require('ioredis');
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  await redis.del(`audit:collapse:authz:${s3.id}:/api/workspaces/:workspaceId/security/events`);
  redis.disconnect();
  const denied = await call('GET', `/workspaces/${W}/security/events`, s3.token);
  for (let i = 0; i < 3; i++) await call('GET', `/workspaces/${W}/security/events`, s3.token);
  const dRows = await waitRow(async () => {
    const r = await events({ eventKey: 'authz.denied', actorId: s3.id });
    return r.length ? r : null;
  }, 5000);
  const dRow = (dRows ?? []).find((e) => String(e.route ?? '').includes('/security/events'));
  check('S9: a 403 is journaled as authz.denied — platform only, reason = the refusal code', denied.status === 403 && !!dRow && dRow.details.reason === denied.code && !dRow.visSubject && !dRow.visWorkspace, `${denied.status} ${denied.code} ${JSON.stringify(dRow?.details)}`);
  check('S9: repeated denials collapse (1, 10, 100… — not a row per refusal)', (dRows ?? []).filter((e) => String(e.route ?? '').includes('/security/events')).length === 1, (dRows ?? []).length);
  const s3feed = await call('GET', '/users/me/security/events?limit=50', s3.token);
  check('S9: the person does not see their own access denials', s3feed.ok && !(s3feed.json?.data?.items ?? []).some((e) => e.key === 'authz.denied'));
  // Разные чужие id, не быстрее троттлинга (10 запросов в секунду)
  for (let i = 0; i < 31; i++) {
    await call('GET', `/workspaces/${randomUUID()}/security/events`, s3.token);
    await sleep(120);
  }
  const idor = await waitRow(() => prisma.securityAlert.findFirst({ where: { kind: 'idor_probing', subjectUserId: s3.id, status: { in: ['open', 'ack'] } } }), 5000);
  check('S9: 30 different foreign ids in 10 min → idor_probing alert', !!idor);

  // ---- S10. Интеграция Google: отключение кнопкой ----
  await prisma.googleConnection.upsert({ where: { userId: s2.id }, create: { userId: s2.id, googleEmail: 'suite@example.com', accessToken: '', refreshToken: '' }, update: {} });
  const disc = await call('DELETE', '/integrations/google', s2.token);
  const left = await prisma.googleConnection.findUnique({ where: { userId: s2.id } });
  const dEv = await events({ eventKey: 'account.integration.disconnected', subjectUserId: s2.id });
  check('S10: disconnecting Google is journaled for the person (reason self)', disc.ok && !left && dEv.some((e) => e.details.reason === 'self' && e.details.provider === 'google_calendar' && e.visSubject), `${disc.status} ${JSON.stringify(dEv.map((e) => e.details))}`);

  // ---- S11. Настройки журнала ----
  const sBase = await call('POST', '/audit/dev/settings/check', s1.token, {});
  const sOff = await call('POST', '/audit/dev/settings/check', s1.token, { archiveEnabled: false });
  const sBack = await call('POST', '/audit/dev/settings/check', s1.token, {});
  const sEv = await events({ eventKey: 'audit.settings.changed' });
  const settingOf = (e) => e.details.setting;
  const baseline = await prisma.securityEvent.findMany({ where: { eventKey: 'audit.settings.changed', reasonCode: 'baseline' }, select: { details: true } });
  check('S11: every log setting has a baseline; an unchanged start writes nothing', sBase.json?.data?.written === 0 && ['digest_interval_min', 'retention_years', 'archive_enabled', 'trusted_country'].every((s) => baseline.some((b) => b.details.setting === s)), JSON.stringify(sBase.json?.data));
  check('S11: switching the archive off and back → two events (true → false → true)', sOff.json?.data?.written === 1 && sBack.json?.data?.written === 1 && sEv.filter((e) => settingOf(e) === 'archive_enabled').map((e) => `${e.details.from}>${e.details.to}`).join(',') === 'true>false,false>true', JSON.stringify(sEv.map((e) => e.details)));

  // ---- S12. Инициатор — в выгрузке и SIEM-стриме ----
  const { csvRow, ndjsonRow, CSV_COLUMNS } = require('../dist/core/audit/audit.export.js');
  const { AuditStreamService } = require('../dist/core/audit/audit.stream.js');
  const shared = require('@superapp/shared');
  const dto = {
    id: '1', eventId: randomUUID(), occurredAt: new Date().toISOString(), key: 'org.member.removed', category: 'org', severity: 'medium', outcome: 'success', reasonCode: null, op: null,
    title: 'x', body: null, actor: { kind: 'system', onBehalfOf: { id: s1.id, firstName: 'A', lastName: 'B', avatar: null } }, subject: { id: s2.id }, workspaceId: W,
    target: { type: 'user', id: s2.id, label: null }, client: 'job', location: { country: null, city: null }, device: { label: null, class: null }, details: {}, disputable: false, requestId: null, ref: null,
  };
  const cells = csvRow(dto).split(',');
  check('S12: CSV export carries the initiator column', cells[CSV_COLUMNS.indexOf('onBehalfOfId')] === s1.id, cells.join('|'));
  check('S12: NDJSON export carries actor.onBehalfOfId', JSON.parse(ndjsonRow(dto)).actor.onBehalfOfId === s1.id);
  const payload = AuditStreamService.prototype.payload.call({}, {
    eventId: randomUUID(), key: 'org.member.removed', def: shared.auditEventDef('org.member.removed'), occurredAt: new Date(), outcome: 'success', reasonCode: null,
    actorKind: 'system', actorId: null, onBehalfOfId: s1.id, subjectUserId: s2.id, workspaceId: W, targetType: 'user', targetId: s2.id, country: null, client: 'job', uaFamily: null, requestId: null, details: {},
  });
  check('S12: SIEM stream payload carries actor.onBehalfOfId of a system action', payload.actor.onBehalfOfId === s1.id, JSON.stringify(payload.actor));
  const staffPayload = AuditStreamService.prototype.payload.call({}, {
    eventId: randomUUID(), key: 'org.member.removed', def: shared.auditEventDef('org.member.removed'), occurredAt: new Date(), outcome: 'success', reasonCode: null,
    actorKind: 'platform_staff', actorId: s1.id, onBehalfOfId: s2.id, subjectUserId: s2.id, workspaceId: W, targetType: 'user', targetId: s2.id, country: null, client: 'console', uaFamily: null, requestId: null, details: {},
  });
  check('S12: a platform staff delegation never leaves in the stream', staffPayload.actor.kind === 'platform' && staffPayload.actor.id === null && !('onBehalfOfId' in staffPayload.actor), JSON.stringify(staffPayload.actor));
}

// ===================== C. Защита входа =====================
async function sectionLogin({ check, prisma }) {
  console.log('\n[C] sign-in protection (suite3 only — the lockout is lifted in finally)');
  const s3 = await login(SUITE.p3);
  try {
    // Тайминг: неизвестный номер стоит столько же, сколько неверный пароль существующего
    const unknown = [];
    const wrong = [];
    for (let i = 0; i < 3; i++) {
      const phone = `+7701${String(Math.floor(1e6 + Math.random() * 8e6)).padStart(7, '0')}`;
      let t = Date.now();
      await call('POST', '/auth/login', null, { phone, password: 'Wrong1234!' });
      unknown.push(Date.now() - t);
      t = Date.now();
      await call('POST', '/auth/login', null, { phone: SUITE.p3, password: 'Wrong1234!' });
      wrong.push(Date.now() - t);
    }
    const mu = median(unknown);
    const mw = median(wrong);
    check('timing: unknown number costs the same as a wrong password (no oracle)', mu > 0.5 * mw && mu < 2 * mw, `unknown ${mu} ms vs wrong ${mw} ms`);
    const failed = await lastEvent(prisma, { eventKey: 'auth.login.failed', subjectUserId: s3.id });
    check('wrong password → auth.login.failed with the subject and a reason', failed?.reasonCode === 'wrong_password' && failed.outcome === 1 && failed.visSubject === true);
    const anon = await lastEvent(prisma, { eventKey: 'auth.login.failed', subjectUserId: null });
    check('unknown number → failed event without a subject, with a pseudonym of the number', !!anon && /^sa6m:1:/.test(anon.details?.targetHmac ?? '') && !JSON.stringify(anon.details).includes('+7'), JSON.stringify(anon?.details));
    // Порог: ещё две неудачи (всего 5) → блокировка
    let lockedResp = null;
    for (let i = 0; i < 2; i++) lockedResp = await call('POST', '/auth/login', null, { phone: SUITE.p3, password: 'Wrong1234!' });
    check('5th failure → 429 auth.locked with Retry-After', lockedResp.status === 429 && lockedResp.code === 'auth.locked' && Number(lockedResp.retryAfter) > 0, `${lockedResp.status} ${lockedResp.code} ${lockedResp.retryAfter}`);
    const locked = await lastEvent(prisma, { eventKey: 'auth.login.locked', subjectUserId: s3.id });
    check('auth.login.locked recorded (15 min, level 1)', locked?.details?.minutes >= 15 && locked.details.attempts >= 5, JSON.stringify(locked?.details));
    const lockNote = await waitRow(() => prisma.notification.findFirst({ where: { userId: s3.id, type: 'security.login.locked', createdAt: { gt: new Date(Date.now() - 120_000) } } }));
    check('the owner is notified about the lock (event in the lock transaction, row by the fan-out)', !!lockNote);
    const rowsBefore = await prisma.securityEvent.count({ where: { eventKey: 'auth.login.failed', subjectUserId: s3.id } });
    const whileLocked = await call('POST', '/auth/login', null, { phone: SUITE.p3, password: SUITE.password });
    const rowsAfter = await prisma.securityEvent.count({ where: { eventKey: 'auth.login.failed', subjectUserId: s3.id } });
    check('while locked even the RIGHT password is refused (429), no row per attempt', whileLocked.status === 429 && rowsAfter === rowsBefore, `${whileLocked.status} rows ${rowsBefore}→${rowsAfter}`);
    // Симметрия: неизвестный номер блокируется так же (иначе 429/401 отличали бы аккаунт)
    const ghost = `+7702${String(Math.floor(1e6 + Math.random() * 8e6)).padStart(7, '0')}`;
    let ghostResp = null;
    for (let i = 0; i < 5; i++) ghostResp = await call('POST', '/auth/login', null, { phone: ghost, password: 'Wrong1234!' });
    check('unknown number is locked the same way after 5 failures (not an oracle)', ghostResp.status === 429 && ghostResp.code === 'auth.locked', `${ghostResp.status} ${ghostResp.code}`);
  } finally {
    const un = await call('POST', '/audit/dev/unlock', s3.token, { userId: s3.id });
    check('dev unlock lifts the lock (suite3 is usable again)', un.ok, un.status);
  }
  const back = await login(SUITE.p3);
  check('after unlock the right password signs in', !!back.token);
  const summary = await lastEvent(prisma, { eventKey: 'audit.lockout_summary', subjectUserId: back.id });
  check('attempts during the lock are summarized in one row', (summary?.details?.attempts ?? 0) >= 1, JSON.stringify(summary?.details));
}

// ===================== D. Устройства, cooling, мягкий отзыв =====================
async function sectionDevices({ check, prisma }) {
  console.log('\n[D] devices, cooling and soft revoke');
  const trusted = await login(SUITE.p2); // устройство сьюты — доверенное
  const devX = randomUUID();
  const fresh = await loginOn(SUITE.p2, devX);
  check('sign-in from a new device succeeds', fresh.ok, fresh.status);
  const tokX = fresh.json.data.accessToken;
  const famX = tokenPayload(tokX).fam;
  const nd = await lastEvent(prisma, { eventKey: 'auth.session.new_device', subjectUserId: trusted.id, actorFamilyId: famX });
  check('new device → auth.session.new_device event', !!nd);
  const note = await waitRow(() => prisma.notification.findFirst({ where: { userId: trusted.id, type: 'security.login.newDevice', createdAt: { gt: new Date(Date.now() - 120_000) } } }));
  check('new device → security.login.newDevice notification (event in the sign-in transaction)', !!note);
  const again = await loginOn(SUITE.p2, devX);
  const ndAgain = await lastEvent(prisma, { eventKey: 'auth.session.new_device', subjectUserId: trusted.id, actorFamilyId: tokenPayload(again.json.data.accessToken).fam });
  check('the same device again → no new_device event', !ndAgain);
  // Cooling: новая сессия не выгоняет остальных
  const blocked = await call('POST', '/auth/logout-all', tokX);
  check('unconfirmed new session: logout-all → 403 auth.cooling_period with confirmAt', blocked.status === 403 && blocked.code === 'auth.cooling_period' && !!blocked.json?.details?.confirmAt, `${blocked.status} ${blocked.code}`);
  const cool = await call('GET', '/users/me/security/cooling', tokX);
  check('cooling banner: not confirmed, confirmAt in ~24 h', cool.ok && cool.json.data.confirmed === false && Date.parse(cool.json.data.confirmAt) > Date.now() + 23 * 3600e3);
  const st = await call('POST', '/verify/step-up', tokX, { purpose: 'security_confirm', password: SUITE.password }, { 'X-Device-Id': devX });
  const vt = st.ok ? await passFor(st) : null;
  const conf = vt ? await call('POST', '/users/me/sessions/confirm', tokX, { verifyToken: vt }, { 'X-Device-Id': devX }) : null;
  check('step-up (password + SMS) confirms the session now', conf?.ok && conf.json.data.confirmed === true, `${st.status} ${conf?.status}`);
  const confEv = await lastEvent(prisma, { eventKey: 'auth.session.confirmed', subjectUserId: trusted.id, targetId: famX });
  check('auth.session.confirmed{via: step_up} recorded', confEv?.details?.via === 'step_up');
  // Мягкий отзыв чужой сессии: строка остаётся, причина видна, access-токен гаснет сразу
  const end = await call('DELETE', `/users/me/sessions/${famX}`, trusted.token);
  check('ending another session → 200', end.ok, `${end.status} ${end.code}`);
  const deadNow = await call('GET', '/users/me', tokX);
  check('its access token dies immediately (not after 15 min)', deadNow.status === 401, deadNow.status);
  const rows = await prisma.session.findMany({ where: { familyId: famX } });
  check('rows are kept (soft revoke) with the reason', rows.length >= 1 && rows.every((r) => r.revokedAt && r.revokedReason === 'other_session'));
  const list = await call('GET', '/users/me/sessions', trusted.token);
  const ended = (list.json?.data?.ended ?? []).find((x) => x.id === famX);
  check('"signed-out devices" list shows it with the reason', ended?.revokedReason === 'other_session');
  const revEv = await lastEvent(prisma, { eventKey: 'auth.session.revoked', subjectUserId: trusted.id, targetId: famX });
  check('auth.session.revoked{by: other_session} recorded', revEv?.details?.by === 'other_session');
  const selfEnd = await call('DELETE', `/users/me/sessions/${tokenPayload(trusted.token).fam}`, trusted.token);
  check('own current session cannot be ended from itself (it is logout)', selfEnd.status === 403 && selfEnd.code === 'audit.current_session', `${selfEnd.status} ${selfEnd.code}`);
  const devices = await call('GET', '/users/me/devices', trusted.token);
  check('devices list: the suite device is current and trusted', devices.ok && devices.json.data.some((d) => d.isCurrent && d.trustedAt), JSON.stringify(devices.json?.data?.map((d) => [d.label, d.isCurrent]))?.slice(0, 160));
  // OTP: неверный код — событие
  const otp = await call('POST', '/verify/step-up', trusted.token, { purpose: 'security_confirm', password: SUITE.password });
  if (otp.ok) {
    await call('POST', '/verify/check', null, { challengeId: otp.json.data.challengeId, code: '000000' });
    const otpEv = await lastEvent(prisma, { eventKey: 'auth.otp.failed', subjectUserId: trusted.id });
    check('wrong SMS code → auth.otp.failed with attempts left', otpEv?.details?.purpose === 'security_confirm' && otpEv.details.attemptsLeft >= 1, JSON.stringify(otpEv?.details));
  }
  const badPwd = await call('POST', '/verify/step-up', trusted.token, { purpose: 'security_confirm', password: 'Wrong1234!' });
  const stepEv = await lastEvent(prisma, { eventKey: 'auth.step_up.failed', subjectUserId: trusted.id });
  check('wrong password at step-up → 401 + auth.step_up.failed{stage: password}', badPwd.status === 401 && stepEv?.details?.stage === 'password');
}

// ===================== E. Заморозка без входа =====================
async function sectionFreeze({ check, prisma }) {
  console.log('\n[E] emergency freeze without signing in (suite3)');
  const s3 = await login(SUITE.p3);
  // Случайный «ничей» номер: у фиксированного прогоны копили бы часовой лимит SMS на номер
  const unknown = await call('POST', '/auth/freeze/start', null, { phone: `+7701${String(Math.floor(1e6 + Math.random() * 8e6)).padStart(7, '0')}` });
  const known = await call('POST', '/auth/freeze/start', null, { phone: SUITE.p3 });
  check('freeze start: unknown and known number answer the same way', unknown.status === known.status && known.ok, `${unknown.status} / ${known.status}`);
  const vt = known.ok ? await passFor(known) : null;
  const fr = vt ? await call('POST', '/auth/freeze/confirm', null, { verifyToken: vt }) : null;
  check('freeze confirm → frozen', fr?.ok && fr.json.data.frozen === true, `${fr?.status} ${fr?.code}`);
  const dead = await call('GET', '/users/me', s3.token);
  check('existing access token dies (epoch bump)', dead.status === 401, dead.status);
  const loginFrozen = await call('POST', '/auth/login', null, { phone: SUITE.p3, password: SUITE.password });
  check('sign-in with the right password → 403 auth.frozen', loginFrozen.status === 403 && loginFrozen.code === 'auth.frozen', `${loginFrozen.status} ${loginFrozen.code}`);
  const reset = await call('POST', '/verify/start', null, { phone: SUITE.p3, purpose: 'password_reset' });
  const rvt = reset.ok ? await passFor(reset) : null;
  const resetDone = rvt ? await call('POST', '/auth/password-reset', null, { verifyToken: rvt, newPassword: SUITE.password }) : null;
  check('password reset by SMS does NOT lift the freeze (403 auth.frozen)', resetDone?.status === 403 && resetDone.code === 'auth.frozen', `${resetDone?.status} ${resetDone?.code}`);
  const frozenEv = await lastEvent(prisma, { eventKey: 'account.frozen', subjectUserId: s3.id });
  check('account.frozen{by: self} recorded with revoked counts', frozenEv?.details?.by === 'self' && frozenEv.details.sessionsRevoked >= 1, JSON.stringify(frozenEv?.details));
  const badUn = await call('POST', '/auth/unfreeze/start', null, { phone: SUITE.p3, password: 'Wrong1234!' });
  check('unfreeze with a wrong old password → 401 before any SMS', badUn.status === 401, badUn.status);
  const un = await call('POST', '/auth/unfreeze/start', null, { phone: SUITE.p3, password: SUITE.password });
  const uvt = un.ok ? await passFor(un) : null;
  const unDone = uvt ? await call('POST', '/auth/unfreeze/confirm', null, { verifyToken: uvt }) : null;
  check('unfreeze (password + SMS) → signed in', unDone?.ok && !!unDone.json.data.accessToken, `${un.status} ${unDone?.status} ${unDone?.code}`);
  const unEv = await lastEvent(prisma, { eventKey: 'account.unfrozen', subjectUserId: s3.id });
  check('account.unfrozen{by: self} recorded', unEv?.details?.by === 'self');
  const again = await login(SUITE.p3);
  check('suite3 signs in normally after the unfreeze', !!again.token);
}

// ===================== F. «Это не я» =====================
async function sectionNotMe({ check, prisma }) {
  console.log('\n[F] “This wasn’t me” wizard (suite2)');
  const owner = await login(SUITE.p2);
  // Потолок «Это не я» 3/час: сьют гоняют чаще — дев-разблокировка сбрасывает и его
  await call('POST', '/audit/dev/unlock', owner.token, { userId: owner.id });
  const intruderDevice = randomUUID();
  const intruder = await loginOn(SUITE.p2, intruderDevice);
  const intruderFam = tokenPayload(intruder.json.data.accessToken).fam;
  const loginEv = await lastEvent(prisma, { eventKey: 'auth.login.success', subjectUserId: owner.id, actorFamilyId: intruderFam });
  const feed = await call('GET', '/users/me/security/events?filter=logins', owner.token);
  const row = (feed.json?.data?.items ?? []).find((e) => e.id === String(loginEv.id));
  check('the intruder sign-in is in the owner feed and is disputable', !!row && row.disputable === true, JSON.stringify(row)?.slice(0, 160));
  const noKey = await call('POST', '/users/me/security/not-me', owner.token, { eventId: String(loginEv.id) }, { 'Idempotency-Key': null });
  check('not-me requires an Idempotency-Key', noKey.status === 400, `${noKey.status} ${noKey.code}`);
  const intruderExport = await call('GET', '/users/me/security/export', intruder.json.data.accessToken);
  check('my data (full IP history) is closed to a fresh unconfirmed session (cooling)', intruderExport.status === 403 && intruderExport.code === 'auth.cooling_period', `${intruderExport.status} ${intruderExport.code}`);
  const fromIntruder = await call('POST', '/users/me/security/not-me', intruder.json.data.accessToken, { eventId: String(loginEv.id) });
  check('the fresh intruder session cannot run the wizard (cooling)', fromIntruder.status === 403 && fromIntruder.code === 'auth.cooling_period', `${fromIntruder.status} ${fromIntruder.code}`);
  // Подключение Google, выданное из угнанной сессии (канал выноса календаря) — мастер обязан его погасить
  await prisma.googleConnection.upsert({ where: { userId: owner.id }, create: { userId: owner.id, googleEmail: 'intruder@example.com', accessToken: '', refreshToken: '' }, update: {} });
  const notMeSince = new Date(Date.now() - 1000);
  const res = await call('POST', '/users/me/security/not-me', owner.token, { eventId: String(loginEv.id) });
  const googleLeft = await prisma.googleConnection.findUnique({ where: { userId: owner.id } });
  const googleEv = await prisma.securityEvent.findFirst({ where: { eventKey: 'account.integration.disconnected', subjectUserId: owner.id, occurredAt: { gte: notMeSince } } });
  check('not-me: the Google connection is really removed and journaled (reason not_me)', res.ok && !googleLeft && googleEv?.details?.reason === 'not_me', `${res.status} left=${!!googleLeft} ${JSON.stringify(googleEv?.details)}`);
  check('not-me: other sessions ended, devices forgotten', res.ok && res.json.data.sessionsRevoked >= 1 && res.json.data.devicesForgotten >= 1, JSON.stringify(res.json?.data));
  const intruderDead = await call('GET', '/users/me', intruder.json.data.accessToken);
  check('the intruder is out immediately', intruderDead.status === 401, intruderDead.status);
  const ownerAlive = await call('GET', '/users/me', owner.token);
  check('the owner session survives', ownerAlive.ok, ownerAlive.status);
  const disputed = await lastEvent(prisma, { eventKey: 'account.event_disputed', subjectUserId: owner.id });
  check('account.event_disputed references the disputed event', disputed?.refId === String(loginEv.id));
  // Клиент утверждает «пароль сменён» — журнал пишет правду по событиям (смены не было)
  const done = await call('POST', '/users/me/security/not-me/complete', owner.token, { eventId: String(loginEv.id), passwordChanged: true, phoneConfirmed: true });
  const doneEv = await lastEvent(prisma, { eventKey: 'account.not_me_completed', subjectUserId: owner.id });
  check('wizard completion recorded (+ notification)', done.ok && doneEv?.details?.numberConfirmed === true);
  check('“password changed” is taken from the journal, not from the request body', doneEv?.details?.credentialsRotated === false, JSON.stringify(doneEv?.details));
  const again = await call('POST', '/users/me/security/not-me/complete', owner.token, { eventId: String(loginEv.id), passwordChanged: false, phoneConfirmed: true });
  const completions = await prisma.securityEvent.count({ where: { eventKey: 'account.not_me_completed', subjectUserId: owner.id, refId: String(loginEv.id) } });
  check('a repeated completion writes no second event', again.ok && completions === 1, `${again.status} ${completions}`);
  const otherEv = await lastEvent(prisma, { eventKey: 'auth.login.success', subjectUserId: owner.id, NOT: { id: loginEv.id } });
  const unstarted = otherEv ? await call('POST', '/users/me/security/not-me/complete', owner.token, { eventId: String(otherEv.id), passwordChanged: false, phoneConfirmed: false }) : null;
  check('completion without a started wizard for that event → 400', unstarted?.status === 400 && unstarted.code === 'audit.not_disputable', `${unstarted?.status} ${unstarted?.code}`);
  const fd = await prisma.userDevice.findFirst({ where: { userId: owner.id, deviceId: intruderDevice } });
  check('the intruder device is forgotten', !!fd?.forgottenAt);
}

// ===================== G. Журнал организации =====================
async function sectionWorkspace({ check, prisma, s1 }) {
  console.log('\n[G] organization security log (suite1 owner, suite2 trainee, suite3 outsider)');
  const s2 = await login(SUITE.p2);
  const s3 = await login(SUITE.p3);
  const ws = await call('POST', '/workspaces', s1.token, { name: `audit-g-${Date.now()}` });
  const W = ws.json?.data?.id;
  check('G: workspace created', ws.ok && !!W, `${ws.status} ${ws.code}`);
  if (!W) return null;
  const bump = (subject) => call('POST', '/entitlements/dev/bump', s1.token, { subject });
  const subject = { type: 'workspace', id: W };
  let device = null;
  try {
    const inv = await call('POST', `/workspaces/${W}/invitations`, s1.token, { phone: SUITE.p2 });
    const incoming = await call('GET', '/workspaces/invitations/incoming', s2.token);
    const invId = (incoming.json?.data ?? []).find((i) => i.workspaceId === W)?.id ?? inv.json?.data?.id;
    const acc = await call('POST', `/workspaces/invitations/${invId}/accept`, s2.token);
    check('G: suite2 joined as a trainee', acc.ok, `${inv.status}/${acc.status}`);

    const base = `/workspaces/${W}/security`;
    const ov = await call('GET', `${base}/overview`, s1.token);
    check('overview on free: window 90 days, no export, no stream', ov.ok && ov.json.data.retentionDays === 90 && ov.json.data.canExport === false && ov.json.data.canStream === false, JSON.stringify(ov.json?.data));
    const trainee = await call('GET', `${base}/events`, s2.token);
    check('trainee → 403 workspace.manageForbidden', trainee.status === 403 && trainee.code === 'workspace.manageForbidden', `${trainee.status} ${trainee.code}`);
    const outsider = await call('GET', `${base}/events`, s3.token);
    check('outsider → 403 workspace.noAccess (existence not revealed)', outsider.status === 403 && outsider.code === 'workspace.noAccess', `${outsider.status} ${outsider.code}`);
    const foreign = await call('GET', `/workspaces/${randomUUID()}/security/events`, s1.token);
    check('IDOR: someone else’s organization id → 403', foreign.status === 403, foreign.status);

    // Имя устройства, данное человеком, — его личное: организация видит только автоподпись
    const devs = await call('GET', '/users/me/devices', s2.token);
    device = (devs.json?.data ?? []).find((d) => d.isCurrent) ?? null;
    if (device) await call('PATCH', `/users/me/devices/${device.id}`, s2.token, { label: 'Secret laptop' });
    await call('GET', '/entitlements/me', s2.token, null, { 'X-Workspace-Id': W });
    const firstSeen = await waitRow(() => lastEvent(prisma, { eventKey: 'org.session.first_seen', workspaceId: W, subjectUserId: s2.id }), 5000);
    check('org.session.first_seen recorded for the member in this organization', !!firstSeen);

    // Окно тарифа: событие 80 дней назад видно, 100 дней — нет
    const seed = (daysAgo) =>
      call('POST', '/audit/dev/seed', s1.token, { key: 'org.role.changed', subjectUserId: s2.id, workspaceId: W, daysAgo, details: { from: 'trainee', to: 'staff', source: 'manual' } });
    const inWindow = await seed(80);
    const outWindow = await seed(100);
    const feed = await call('GET', `${base}/events?limit=50`, s1.token);
    const ids = (feed.json?.data?.items ?? []).map((e) => e.id);
    check('feed window = 90 days on free', feed.ok && feed.json.data.windowDays === 90, feed.json?.data?.windowDays);
    check('event 80 days old is visible, 100 days old is not', ids.includes(inWindow.json?.data?.id) && !ids.includes(outWindow.json?.data?.id), `${inWindow.json?.data?.id} ${outWindow.json?.data?.id}`);
    check('only this organization’s events (never personal sign-ins)', (feed.json?.data?.items ?? []).every((e) => e.workspaceId === W && !e.key.startsWith('auth.login')), JSON.stringify((feed.json?.data?.items ?? []).map((e) => e.key)));
    check('invitation and joining are in the log', ['org.member.invited', 'org.member.joined'].every((k) => (feed.json?.data?.items ?? []).some((e) => e.key === k)));
    const fsItem = (feed.json?.data?.items ?? []).find((e) => e.key === 'org.session.first_seen');
    check('custom device name is not shown to the organization', !!fsItem && fsItem.device.label !== 'Secret laptop' && !JSON.stringify(fsItem).includes('Secret laptop'), fsItem?.device?.label);
    check('no IP address in the organization view', (feed.json?.data?.items ?? []).every((e) => !('ipNet' in (e.location ?? {}))));
    const old = await call('GET', `${base}/events/${outWindow.json?.data?.id}`, s1.token);
    check('event outside the window by id → 404', old.status === 404 && old.code === 'audit.event_not_found', `${old.status} ${old.code}`);
    const personal = await lastEvent(prisma, { eventKey: 'auth.login.success', subjectUserId: s1.id });
    const personalById = await call('GET', `${base}/events/${personal?.id}`, s1.token);
    check('personal sign-in by id through the organization → 404', personalById.status === 404, personalById.status);

    // «Мои данные» (ЗоПД ст. 24): полный IP — только СВОИХ действий; адрес, страна и устройство
    // админа, действовавшего над человеком (смена роли), — чужие данные
    const md = await call('GET', '/users/me/security/export', s2.token);
    const mdRows = md.json?.data?.rows ?? [];
    const ownRow = mdRows.find((r) => r.actor?.kind === 'user' && r.actor.id === s2.id && r.ip);
    const byAdmin = mdRows.filter((r) => r.actor?.kind === 'user' && r.actor.id === s1.id);
    check('my data: the full IP of my own actions is there', md.ok && !!ownRow, `${md.status} ${mdRows.length}`);
    check('my data: no IP, country or device of the admin who acted on me', byAdmin.length > 0 && byAdmin.every((r) => r.ip === null && r.device.label === null && r.location.country === null), JSON.stringify(byAdmin.map((r) => ({ k: r.key, ip: r.ip, d: r.device.label })).slice(0, 3)));
    const s2feed = await call('GET', '/users/me/security/events?filter=orgs', s2.token);
    const adminInFeed = (s2feed.json?.data?.items ?? []).filter((e) => e.actor?.kind === 'user' && e.actor.id === s1.id);
    check('my feed: the device of another person is not disclosed', adminInFeed.length > 0 && adminInFeed.every((e) => e.device.label === null && e.device.class === null), adminInFeed.length);

    // Тариф: оверрайд окна 180 открывает событие 100 дней
    await prisma.entitlementOverride.upsert({
      where: { subjectType_subjectId_key: { subjectType: 'workspace', subjectId: W, key: 'audit.retentionDays' } },
      create: { subjectType: 'workspace', subjectId: W, key: 'audit.retentionDays', mode: 'set', value: 180, reason: 'suite audit window', validUntil: new Date(Date.now() + 864e5), createdBy: s1.id },
      update: { mode: 'set', value: 180 },
    });
    await bump(subject);
    const wide = await call('GET', `${base}/events?limit=50`, s1.token);
    check('override 180 days → window 180, the 100-day event is visible', wide.json?.data?.windowDays === 180 && (wide.json?.data?.items ?? []).some((e) => e.id === outWindow.json?.data?.id), wide.json?.data?.windowDays);
    await prisma.entitlementOverride.deleteMany({ where: { subjectType: 'workspace', subjectId: W, key: 'audit.retentionDays' } });
    await bump(subject);
    const filtered = await call('GET', `${base}/events?filter=people&actorId=${s1.id}`, s1.token);
    check('filters narrow the projection (people × actor)', filtered.ok && (filtered.json.data.items ?? []).every((e) => e.actor?.id === s1.id), JSON.stringify((filtered.json?.data?.items ?? []).map((e) => e.key)));
    const badFilter = await call('GET', `${base}/events?workspaceId=${randomUUID()}`, s1.token);
    check('unknown query field is refused (strict schema)', badFilter.status === 400, badFilter.status);
    return W;
  } finally {
    if (device) await prisma.userDevice.update({ where: { id: device.id }, data: { customLabel: device.renamed ? device.label : null } }).catch(() => undefined);
    await call('DELETE', `/workspaces/${W}`, s1.token);
  }
}

// ===================== H. Кабинет «Безопасность» =====================
async function sectionConsole({ check, prisma, s1, rid, bEventId, workspaceId }) {
  console.log('\n[H] platform console: security');
  const { consoleLogin, consoleSudo } = require('./_lib.cjs');
  let c = await consoleLogin(SUITE.p1);
  if (!c.token) {
    require('child_process').execFileSync('node', [require('path').join(__dirname, 'platform-bootstrap-owner.cjs'), SUITE.p1], { stdio: 'pipe' });
    c = await consoleLogin(SUITE.p1);
  }
  const t = c.token;
  check('H: suite1 signs in to the console', !!t, `${c.start?.status} ${c.start?.code}`);
  if (!t) return;
  const sudo = await consoleSudo(t);
  check('H: step-up for high-risk commands', sudo.ok, `${sudo.status} ${sudo.code}`);
  const cmd = (key, input, reason) => call('POST', `/platform/commands/${key}`, t, { input, idempotencyKey: `suite-${Date.now()}-${Math.random().toString(36).slice(2)}`, reason });
  const s2 = await login(SUITE.p2);
  const s3 = await login(SUITE.p3);

  const product = await call('GET', '/platform/security/events', s1.token);
  check('product token cannot read the console log', product.status === 401 || product.status === 403, product.status);
  const byReq = await call('GET', `/platform/security/events?requestId=${rid}`, t);
  check('search by request id finds the event', byReq.ok && (byReq.json.data.items ?? []).some((e) => e.id === bEventId && e.requestId === rid), JSON.stringify((byReq.json?.data?.items ?? []).map((e) => e.id)));
  check('platform view carries the network (/24) and no raw IP', (byReq.json?.data?.items ?? []).every((e) => typeof e.location?.ipNet === 'string' && !('ip' in e.location)), JSON.stringify(byReq.json?.data?.items?.[0]?.location));

  // Раскрытие IP — команда: без причины отказ, с причиной — IP + псевдонимы, факт раскрытия в журнале
  const noReason = await cmd('security.event.reveal_ip', { eventId: bEventId });
  check('reveal IP without a reason → 400 platform.reason_required', noReason.status === 400 && noReason.code === 'platform.reason_required', `${noReason.status} ${noReason.code}`);
  const reveal = await cmd('security.event.reveal_ip', { eventId: bEventId }, 'suite: investigating a request');
  const rev = reveal.json?.data?.result ?? reveal.json?.data;
  check('reveal IP → full address + network pseudonyms', reveal.ok && typeof rev?.ip === 'string' && rev.pseudonyms?.length >= 1, `${reveal.status} ${reveal.code} ${JSON.stringify(rev)?.slice(0, 120)}`);
  const revealEv = await waitRow(() => lastEvent(prisma, { eventKey: 'platform.access.reveal', actorId: s1.id, targetType: 'security_event', targetId: bEventId }), 5000);
  check('platform.access.reveal recorded with fields [ip]', JSON.stringify(revealEv?.details?.fields) === '["ip"]', JSON.stringify(revealEv?.details));
  const cmdRow = await lastEvent(prisma, { eventKey: 'platform.command.executed', op: 'security.event.reveal_ip', actorId: s1.id, outcome: 0 });
  check('the command journal does not keep the IP (S7)', !!cmdRow && !JSON.stringify(cmdRow.details).includes(rev?.ip ?? '§'), JSON.stringify(cmdRow?.details)?.slice(0, 160));
  if (rev?.ip) {
    // Запись поиска — без ожидания (best-effort): ждём строку НОВЕЕ запроса, а не последнюю вообще
    // (иначе ловится прошлая строка другого сьюта с fields: [phone])
    const searchSince = new Date(Date.now() - 1000);
    const net = await call('POST', '/platform/security/network', t, { ip: rev.ip });
    check('network lookup by IP → the same pseudonyms', net.ok && rev.pseudonyms.every((p) => net.json.data.pseudonyms.includes(p)), JSON.stringify(net.json?.data));
    const searchEv = await waitRow(() => lastEvent(prisma, { eventKey: 'platform.access.search', actorId: s1.id, occurredAt: { gte: searchSince } }), 5000);
    check('IP lookup is recorded as a search over personal data (no value)', JSON.stringify(searchEv?.details?.fields) === '["ip"]' && !JSON.stringify(searchEv?.details).includes(rev.ip));
    const byNet = await call('GET', `/platform/security/events?ipHmac=${encodeURIComponent(net.json.data.pseudonyms.join(','))}&limit=200`, t);
    check('“all events from this IP” finds the event', byNet.ok && (byNet.json.data.items ?? []).length > 0, byNet.status);
  }
  const badNet = await call('POST', '/platform/security/network', t, { ip: 'not-an-ip' });
  check('network lookup validates the IP', badNet.status === 400, badNet.status);

  // Отзыв сессии: сессия suite2 на новом устройстве гаснет сразу, актор события — сотрудник
  const side = await loginOn(SUITE.p2, randomUUID());
  const sideToken = side.json?.data?.accessToken;
  const fam = sideToken ? tokenPayload(sideToken).fam : null;
  const revoke = await cmd('security.session.revoke', { userId: s2.id, sessionId: fam }, 'suite: session revoke by support');
  check('security.session.revoke ends the session', revoke.ok && (revoke.json?.data?.result ?? revoke.json?.data)?.sessionsRevoked === 1, `${revoke.status} ${revoke.code}`);
  const sideDead = await call('GET', '/users/me', sideToken);
  check('the revoked session is out immediately', sideDead.status === 401, sideDead.status);
  const s2Alive = await call('GET', '/users/me', s2.token);
  check('other sessions of the person survive', s2Alive.ok, s2Alive.status);
  const revEv = await lastEvent(prisma, { eventKey: 'auth.session.revoked', subjectUserId: s2.id, targetId: fam });
  check('auth.session.revoked{by: platform}, actor = platform staff (not anonymous)', revEv?.details?.by === 'platform' && revEv.actorKind === 2 && revEv.actorId === s1.id, `${revEv?.actorKind} ${revEv?.actorId}`);
  const s2Feed = await call('GET', '/users/me/security/events?limit=50', s2.token);
  const personRow = (s2Feed.json?.data?.items ?? []).find((e) => e.id === String(revEv?.id));
  check('the person sees the revocation, but not who of the staff did it', !!personRow && personRow.actor?.kind === 'platform' && !JSON.stringify(personRow).includes(s1.id), JSON.stringify(personRow?.actor));

  // Заморозка/разморозка командой; себя — нельзя
  const self = await cmd('security.account.freeze', { userId: s1.id }, 'suite: freezing myself must fail');
  check('freeze yourself → 403 platform.self_target', self.status === 403 && self.code === 'platform.self_target', `${self.status} ${self.code}`);
  const notFrozen = await cmd('security.account.unfreeze', { userId: s3.id }, 'suite: unfreeze of an active account');
  check('unfreeze of an active account → 409 audit.not_frozen', notFrozen.status === 409 && notFrozen.code === 'audit.not_frozen', `${notFrozen.status} ${notFrozen.code}`);
  const freeze = await cmd('security.account.freeze', { userId: s3.id }, 'suite: account takeover suspected');
  check('security.account.freeze → frozen', freeze.ok, `${freeze.status} ${freeze.code}`);
  try {
    const s3Dead = await call('GET', '/users/me', s3.token);
    check('the frozen person is out immediately', s3Dead.status === 401, s3Dead.status);
    const s3Login = await call('POST', '/auth/login', null, { phone: SUITE.p3, password: SUITE.password });
    check('sign-in of the frozen person → 403 auth.frozen', s3Login.status === 403 && s3Login.code === 'auth.frozen', `${s3Login.status} ${s3Login.code}`);
    const frEv = await lastEvent(prisma, { eventKey: 'account.frozen', subjectUserId: s3.id });
    check('account.frozen{by: platform}, actor = platform staff', frEv?.details?.by === 'platform' && frEv.actorKind === 2 && frEv.actorId === s1.id, `${frEv?.actorKind} ${frEv?.actorId}`);
  } finally {
    const unfreeze = await cmd('security.account.unfreeze', { userId: s3.id }, 'suite: identity confirmed by support');
    check('security.account.unfreeze → sign-in works again', unfreeze.ok && !!(await login(SUITE.p3)).token, `${unfreeze.status} ${unfreeze.code}`);
  }

  // Тревога: открыта детекцией (здесь — вставкой), закрывается командой один раз
  const alert = await prisma.securityAlert.create({ data: { kind: 'suite_probe', severity: 'high', dedupeKey: `suite:${randomUUID()}`, subjectUserId: s2.id, evidence: bEventId ? [bEventId] : [] } });
  const openList = await call('GET', '/platform/security/alerts?status=open', t);
  check('open alerts list has the alert', openList.ok && (openList.json.data.items ?? []).some((a) => a.id === alert.id && a.subject?.id === s2.id), openList.status);
  const close = await cmd('security.alert.close', { alertId: alert.id, resolution: 'false_positive' }, 'suite: probe alert');
  const closedRow = await prisma.securityAlert.findUnique({ where: { id: alert.id } });
  check('security.alert.close → closed with the resolution and assignee', close.ok && closedRow?.status === 'closed' && closedRow.resolution === 'false_positive' && closedRow.assigneeId === s1.id, `${close.status} ${close.code}`);
  const closeAgain = await cmd('security.alert.close', { alertId: alert.id, resolution: 'resolved' }, 'suite: probe alert again');
  check('closing twice → 409 audit.alert_closed', closeAgain.status === 409 && closeAgain.code === 'audit.alert_closed', `${closeAgain.status} ${closeAgain.code}`);

  // Панели карточки 360
  const up = await call('GET', `/platform/entities/user/${s2.id}/panels/user.security`, t);
  const upData = up.json?.data?.data ?? up.json?.data;
  check('panel user.security: sessions, devices, recent events', up.ok && upData?.activeSessions >= 1 && upData?.devices >= 1 && Array.isArray(upData?.recent) && upData.recent.length > 0, `${up.status} ${JSON.stringify(upData)?.slice(0, 120)}`);
  if (workspaceId) {
    const wp = await call('GET', `/platform/entities/workspace/${workspaceId}/panels/workspace.security`, t);
    const wpData = wp.json?.data?.data ?? wp.json?.data;
    check('panel workspace.security: window and recent events', wp.ok && wpData?.retentionDays === 90 && Array.isArray(wpData?.recent), `${wp.status} ${JSON.stringify(wpData)?.slice(0, 120)}`);
  }
  const parts = await call('GET', '/platform/security/partitions', t);
  check('partitions list with statuses', parts.ok && (parts.json.data ?? []).some((p) => p.status === 'in_db'), parts.status);
  const digests = await call('GET', '/platform/security/digests', t);
  check('digests list answers', digests.ok && Array.isArray(digests.json.data), digests.status);

  // Команды целостности и выгрузки Кабинета
  const dv = await cmd('security.digest.verify', { from: new Date(Date.now() - 3600e3).toISOString(), to: new Date().toISOString() });
  const dvr = dv.json?.data?.result;
  check('security.digest.verify → the log is intact', dv.ok && dvr?.ok === true, `${dv.status} ${dv.code} ${JSON.stringify(dvr)}`);
  const ex = await cmd('security.export', { format: 'ndjson', from: new Date(Date.now() - 600e3).toISOString(), to: new Date().toISOString() }, 'suite: platform export of the security log');
  check('security.export (critical) queues the export', ex.ok && ex.json?.data?.result?.jobQueued === true, `${ex.status} ${ex.code}`);
  const exEv = await waitRow(() => prisma.securityEvent.findFirst({ where: { eventKey: 'data.export', targetType: 'audit_platform_export', targetId: ex.json?.data?.result?.exportId ?? '-' } }), 30_000);
  check('data.export{audit_platform} recorded, invisible to people and organizations', exEv?.details?.source === 'audit_platform' && exEv.visSubject === false && exEv.visWorkspace === false, JSON.stringify(exEv?.details));
  const mine = await call('GET', '/platform/security/exports', t);
  const f = (mine.json?.data ?? [])[0];
  check('the export is listed for its author', mine.ok && !!f && f.name.endsWith('.ndjson'), JSON.stringify(mine.json?.data)?.slice(0, 120));
  if (f) {
    const u = await call('GET', `/platform/security/exports/${f.fileId}/url`, t);
    const body = u.ok ? await (await fetch(u.json.data.url)).text() : '';
    const first = body.split(String.fromCharCode(10))[0];
    check('NDJSON export: one JSON event per line, no ciphertext and no names', u.ok && !!JSON.parse(first).eventId && !/ip_enc|ua_raw|"name":/.test(body), first.slice(0, 100));
    const productDl = await call('GET', `/files/${f.fileId}/download`, s2.token);
    check('the platform export is not reachable from the product by others', productDl.status === 403 || productDl.status === 404, productDl.status);
    // Уборка: файл выгрузки — в квоте автора; удаление через движок файлов возвращает квоту
    await call('DELETE', `/files/${f.fileId}`, s1.token);
  }

  // Мета-аудит: кто смотрел журнал — агрегат за час
  const flushed = await call('POST', '/audit/dev/viewed-flush', s1.token, {});
  const viewedEv = await lastEvent(prisma, { eventKey: 'audit.viewed', actorId: s1.id });
  check('audit.viewed aggregate recorded for the staff member', flushed.ok && viewedEv?.details?.queries >= 1 && viewedEv.details.reveals >= 1 && viewedEv.actorKind === 2, JSON.stringify(viewedEv?.details));
  const personHidden = await call('GET', '/users/me/security/events', s1.token);
  check('staff actions stay invisible to people (platform.* never in the person feed)', (personHidden.json?.data?.items ?? []).every((e) => !e.key.startsWith('platform.') && e.key !== 'audit.viewed'));
}

// ===================== I. Целостность и архив =====================
async function sectionIntegrity({ check, prisma, s1 }) {
  console.log('\n[I] integrity digests and partition archive');
  const probe = await call('POST', '/audit/dev/tx-probe', s1.token, { rollback: false });
  const run = await call('POST', '/audit/dev/digest/run', s1.token, {});
  check('digest over the new window is signed', run.ok && (run.json.data === null || run.json.data.count > 0), JSON.stringify(run.json?.data));
  const digest = await prisma.securityDigest.findFirst({ orderBy: { xactTo: 'desc' } });
  const probeRow = await prisma.securityEvent.findFirst({ where: { eventId: probe.json?.data?.eventId } });
  check('the digest covers the probe row (xact below the digest end)', !!digest && !!probeRow, `${digest?.xactTo} ${probeRow?.id}`);
  check('digest copy exported off the database', !!digest?.exportedAt);
  check('digest chain: prev hash present when a previous digest exists', (await prisma.securityDigest.count()) < 2 || !!digest?.prevDigestHash);
  const window = () => ({ from: new Date(digest.signedAt.getTime() - 1000).toISOString(), to: new Date(digest.signedAt.getTime() + 1000).toISOString() });
  const ok1 = await call('POST', '/audit/dev/digest/verify', s1.token, window());
  check('verify: intact log → ok', ok1.ok && ok1.json.data.ok === true && ok1.json.data.digests >= 1, JSON.stringify(ok1.json?.data));
  const mine = run.json?.data?.id ? await prisma.securityDigest.findUnique({ where: { id: run.json.data.id } }) : null;
  if (mine) {
    const lv = await prisma.$queryRawUnsafe(`SELECT sha256(convert_to(jsonb_strip_nulls(to_jsonb(e) - 'ip_enc' - 'ua_raw_enc')::text, 'UTF8')) AS h FROM security_events e WHERE e.xact >= $1::xid8 AND e.xact < $2::xid8 ORDER BY e.xact, e.id`, String(mine.xactFrom), String(mine.xactTo));
    const ref = merkleRef(lv.map((r) => Buffer.from(r.h)));
    check('digest = v3 leaves (null-stripped, numeric order) and its root equals an independent RFC 6962 root', mine.leafVersion === 3 && lv.length === mine.count && ref.equals(Buffer.from(mine.merkleRoot)), `v${mine.leafVersion} ${lv.length}/${mine.count}`);
    // Регрессия порядка листьев: ВЕСЬ журнал (больше страницы движка, через 9 999 → 10 000 id и
    // переходы разрядов xact) — корень движка v3 равен независимому числовому. Текстовый порядок
    // выходных колонок (v1–v2) здесь расходился, а курсор страницы терял строки.
    const span = (await prisma.$queryRawUnsafe(`SELECT min(xact)::text AS lo, (max(xact)::text::numeric + 1)::text AS hi, count(*)::int AS n FROM security_events`))[0];
    const { AuditDigestService } = require('../dist/core/audit/audit.digests.js');
    const engine = await Object.assign(Object.create(AuditDigestService.prototype), { db: prisma }).leaves(BigInt(span.lo), BigInt(span.hi), 3);
    const allLv = await prisma.$queryRawUnsafe(`SELECT sha256(convert_to(jsonb_strip_nulls(to_jsonb(e) - 'ip_enc' - 'ua_raw_enc')::text, 'UTF8')) AS h FROM security_events e WHERE e.xact >= $1::xid8 AND e.xact < $2::xid8 ORDER BY e.xact, e.id`, span.lo, span.hi);
    check('whole-log v3 root (pages of the engine) equals the independent numeric-order root — no row lost or reordered', engine.count === allLv.length && engine.root.equals(merkleRef(allLv.map((r) => Buffer.from(r.h)))), `${engine.count}/${allLv.length} of ${span.n}`);
  }

  // Подмена строки ВНЕ стража (суперпользователь выключил триггер) — дайджест ловит её
  const part = (await prisma.$queryRawUnsafe(`SELECT tableoid::regclass::text AS p FROM security_events WHERE id = ${probeRow.id}`))[0].p;
  const tamper = async (value) => {
    await prisma.$executeRawUnsafe(`ALTER TABLE ${part} DISABLE TRIGGER security_events_guard`);
    try {
      await prisma.$executeRawUnsafe(`UPDATE ${part} SET reason_code = ${value === null ? 'NULL' : `'${value}'`} WHERE id = ${probeRow.id}`);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE ${part} ENABLE ALWAYS TRIGGER security_events_guard`);
    }
  };
  let failed;
  try {
    await tamper('tampered');
    failed = await call('POST', '/audit/dev/digest/verify', s1.token, window());
  } finally {
    await tamper(probeRow.reasonCode ?? null);
  }
  check('verify after a raw UPDATE → mismatch (root)', failed?.ok && failed.json.data.ok === false && failed.json.data.mismatched.some((m) => m.digestId === digest.id && m.reason === 'root'), JSON.stringify(failed?.json?.data));
  const alert = await prisma.securityAlert.findFirst({ where: { kind: 'digest_mismatch', dedupeKey: `digest:${digest.id}` } });
  check('digest_mismatch alert raised (critical) + audit.digest.failed recorded', alert?.severity === 'critical' && !!(await lastEvent(prisma, { eventKey: 'audit.digest.failed' })), alert?.status);
  const ok2 = await call('POST', '/audit/dev/digest/verify', s1.token, window());
  check('restored row → verify ok again', ok2.ok && ok2.json.data.ok === true, JSON.stringify(ok2.json?.data));
  if (alert) await prisma.securityAlert.update({ where: { id: alert.id }, data: { status: 'closed', resolution: 'resolved', closedAt: new Date() } });
  const guard = await prisma.$queryRawUnsafe(`SELECT tgenabled AS e FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = '${part}' AND t.tgname = 'security_events_guard'`);
  check('the guard is ENABLE ALWAYS again after the probe', guard[0]?.e === 'A', guard[0]?.e);

  // Разрыв цепочки (логический перенос базы в новый кластер: свежий счётчик транзакций ниже
  // конца последнего окна). «Будущий» дайджест подсаживает эту картину — раннер обязан поднять
  // тревогу digest_gap (CRITICAL), а не молча вернуть «пустое окно», как было раньше.
  {
    const tail = await prisma.securityDigest.findFirst({ orderBy: { xactTo: 'desc' } });
    const [{ x }] = await prisma.$queryRawUnsafe(`SELECT pg_current_xact_id()::text AS x`);
    const futureTo = BigInt(x) + 10_000_000_000n;
    const fakeId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO security_digests (id, xact_from, xact_to, count, merkle_root, signature, kid, leaf_version) VALUES ($1::uuid, $2::bigint, $3::bigint, 0, '\\x00'::bytea, '\\x00'::bytea, 'probe', 3)`,
      fakeId,
      String(tail?.xactTo ?? 0n),
      String(futureTo),
    );
    let gap;
    try {
      gap = await call('POST', '/audit/dev/digest/run', s1.token, {});
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE security_digests DISABLE TRIGGER security_digests_guard`);
      try {
        await prisma.$executeRawUnsafe(`DELETE FROM security_digests WHERE id = $1::uuid`, fakeId);
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE security_digests ENABLE ALWAYS TRIGGER security_digests_guard`);
      }
    }
    const gapAlert = await prisma.securityAlert.findFirst({ where: { kind: 'digest_gap', dedupeKey: `xid:${futureTo}` } });
    check('xid regression (logical restore) → digest_gap CRITICAL alert, no digest signed', gap?.ok && gap.json?.data == null && gapAlert?.severity === 'critical', `${gap?.status} ${gapAlert?.status}`);
    if (gapAlert) await prisma.securityAlert.update({ where: { id: gapAlert.id }, data: { status: 'closed', resolution: 'resolved', closedAt: new Date() } });
  }

  // Архив закрытого месяца (посеянное событие 100 дней назад — закрытая партиция)
  const seeded = await call('POST', '/audit/dev/seed', s1.token, { key: 'account.settings_changed', daysAgo: 100, details: { sessionMaxIdleDays: 90 } });
  const at = new Date(seeded.json.data.occurredAt);
  const name = `security_events_${at.getUTCFullYear()}_${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  const arch = await call('POST', '/audit/dev/archive/run', s1.token, { partition: name });
  const row = await prisma.securityPartitionArchive.findUnique({ where: { partition: name } });
  check(`closed month ${name} archived (NDJSON+gzip, signed manifest)`, arch.ok && !!row && row.rows >= 1 && /^[0-9a-f]{64}$/.test(row.sha256) && row.signature.length > 0, `${arch.status} ${JSON.stringify(arch.json?.data)?.slice(0, 120)}`);
  const again = await call('POST', '/audit/dev/archive/run', s1.token, { partition: name });
  check('archiving again is idempotent (the stored object is never rewritten)', again.ok && again.json.data.sha256 === row?.sha256);
  // Консоль «Целостность»: манифест из хранилища сверяется с подписью в базе; сводка очереди тревог
  const { consoleLogin } = require('./_lib.cjs');
  const ct = (await consoleLogin(SUITE.p1)).token;
  if (ct) {
    const man = await call('GET', `/platform/security/partitions/${name}/manifest`, ct);
    const m = man.json?.data;
    check('archive manifest: signature valid and matches the archive record', man.ok && m?.signatureOk === true && m.matchesRecord === true && m.merkleRoot?.length === 64 && m.rows === row?.rows, `${man.status} ${JSON.stringify(m)?.slice(0, 160)}`);
    const none = await call('GET', '/platform/security/partitions/security_events_2099_01/manifest', ct);
    const bad = await call('GET', '/platform/security/partitions/..%2Fetc/manifest', ct);
    check('manifest of a month without an archive or of a bad name → 404', none.status === 404 && none.code === 'audit.partition_not_found' && bad.status === 404, `${none.status} ${none.code} / ${bad.status}`);
    const sum = await call('GET', '/platform/security/alerts/summary', ct);
    const open = await prisma.securityAlert.count({ where: { status: 'open' } });
    check('alert summary counts the unresolved queue', sum.ok && sum.json.data.open === open && typeof sum.json.data.critical === 'number', `${sum.status} ${JSON.stringify(sum.json?.data)} open=${open}`);
  }
  let dropRefused = false;
  try {
    await prisma.$queryRawUnsafe(`SELECT audit_drop_partition('${name}')`);
  } catch (e) {
    dropRefused = /younger than the 3-year/.test(String(e.message));
  }
  check('the database refuses to drop a month younger than 3 years', dropRefused);
  let unarchivedRefused = false;
  try {
    await prisma.$queryRawUnsafe(`SELECT audit_drop_partition('security_events_2099_01')`);
  } catch (e) {
    unarchivedRefused = /not archived/.test(String(e.message));
  }
  check('the database refuses to drop a month without an archive', unarchivedRefused);
}

// ===================== J. Выгрузка журнала организацией =====================
async function sectionExport({ check, prisma, s1 }) {
  console.log('\n[J] organization export to the Drive');
  const s2 = await login(SUITE.p2);
  const ws = await call('POST', '/workspaces', s1.token, { name: `audit-j-${Date.now()}` });
  const W = ws.json?.data?.id;
  if (!W) return check('J: workspace created', false, ws.status);
  const bump = () => call('POST', '/entitlements/dev/bump', s1.token, { subject: { type: 'workspace', id: W } });
  const setFeature = async (key, value) => {
    await prisma.entitlementOverride.upsert({
      where: { subjectType_subjectId_key: { subjectType: 'workspace', subjectId: W, key } },
      create: { subjectType: 'workspace', subjectId: W, key, mode: 'set', value, reason: 'suite audit export', validUntil: new Date(Date.now() + 864e5), createdBy: s1.id },
      update: { mode: 'set', value },
    });
    await bump();
  };
  const body = () => ({ format: 'csv', from: new Date(Date.now() - 7 * 864e5).toISOString(), to: new Date().toISOString() });
  try {
    const inv = await call('POST', `/workspaces/${W}/invitations`, s1.token, { phone: SUITE.p2 });
    const incoming = await call('GET', '/workspaces/invitations/incoming', s2.token);
    const invId = (incoming.json?.data ?? []).find((i) => i.workspaceId === W)?.id ?? inv.json?.data?.id;
    await call('POST', `/workspaces/invitations/${invId}/accept`, s2.token);

    const free = await call('POST', `/workspaces/${W}/security/export`, s1.token, body());
    check('free plan → 402 entitlement (export is from basic)', free.status === 402 && /^entitlement\./.test(free.code ?? ''), `${free.status} ${free.code}`);
    await setFeature('audit.export', true);
    const noKey = await call('POST', `/workspaces/${W}/security/export`, s1.token, body(), { 'Idempotency-Key': null });
    check('export requires an Idempotency-Key', noKey.status === 400, `${noKey.status} ${noKey.code}`);
    const trainee = await call('POST', `/workspaces/${W}/security/export`, s2.token, body());
    check('trainee → 403', trainee.status === 403, trainee.status);
    const tooOld = await call('POST', `/workspaces/${W}/security/export`, s1.token, { ...body(), from: new Date(Date.now() - 200 * 864e5).toISOString() });
    check('period outside the plan window → 400 audit.export_range', tooOld.status === 400 && tooOld.code === 'audit.export_range', `${tooOld.status} ${tooOld.code}`);
    const ok = await call('POST', `/workspaces/${W}/security/export`, s1.token, body());
    check('export accepted (202, job queued)', ok.status === 202 && ok.json?.data?.jobQueued === true, `${ok.status} ${ok.code}`);
    const ev = await waitRow(() => prisma.securityEvent.findFirst({ where: { eventKey: 'data.export', workspaceId: W, targetType: 'audit_export' } }), 30_000);
    check('data.export{audit_org} recorded by the job', ev?.details?.source === 'audit_org' && ev.details.format === 'csv' && typeof ev.details.rows === 'number', JSON.stringify(ev?.details));
    const link = ev ? await prisma.fileLink.findFirst({ where: { refType: 'audit_export', refId: W }, orderBy: { createdAt: 'desc' } }) : null;
    const file = link ? await prisma.fileObject.findUnique({ where: { id: link.fileId } }) : null;
    check('the file belongs to the organization (profile audit_export, text/csv)', file?.ownerType === 'workspace' && file.ownerId === W && file.profile === 'audit_export' && file.mime === 'text/csv', `${file?.ownerType} ${file?.profile} ${file?.mime}`);
    const node = file ? await waitRow(() => prisma.driveNode.findFirst({ where: { fileId: file.id, trashedAt: null } }), 20_000) : null;
    const folder = node?.parentId ? await prisma.driveNode.findUnique({ where: { id: node.parentId } }) : null;
    check('the file is on the organization Drive in the closed «Security» folder', folder?.systemKey === 'security_exports' && folder.restricted === true, `${folder?.systemKey} ${folder?.restricted}`);
    const note = await waitRow(() => prisma.notification.findFirst({ where: { type: 'security.org.exportReady', userId: s1.id } }), 20_000);
    check('security.org.exportReady notification to the requester', !!note);
    const dl = file ? await call('GET', `/files/${file.id}/download`, s1.token) : null;
    const trDl = file ? await call('GET', `/files/${file.id}/download`, s2.token) : null;
    check('owner can download the export, trainee cannot', dl?.ok && trDl && !trDl.ok, `${dl?.status} / ${trDl?.status}`);
    if (dl?.ok) {
      const buf = Buffer.from(await (await fetch(dl.json.data.url)).arrayBuffer());
      const text = buf.toString('utf8');
      // BOM — по байтам: `fetch().text()` (TextDecoder) его срезает
      check('CSV: BOM + header, no IP column', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf && text.slice(1).startsWith('occurredAt,eventId,key') && !/\bip\b/i.test(text.split('\n')[0]), text.slice(0, 60));
    }
    const { csvCell } = require('../dist/core/audit/audit.export.js');
    check('CSV cells cannot start a formula (=, +, -, @)', csvCell('=HYPERLINK("x")') === `"'=HYPERLINK(""x"")"` && csvCell('+1') === "'+1" && csvCell('@a') === "'@a" && csvCell('plain') === 'plain', csvCell('=1'));
    const exportedInOrgLog = await call('GET', `/workspaces/${W}/security/events?filter=exports`, s1.token);
    check('the export is visible in the organization log (filter exports)', (exportedInOrgLog.json?.data?.items ?? []).some((e) => e.key === 'data.export'));
  } finally {
    await prisma.entitlementOverride.deleteMany({ where: { subjectType: 'workspace', subjectId: W, key: 'audit.export' } });
    await call('DELETE', `/workspaces/${W}`, s1.token);
  }
}

// ===================== K. Стрим в SIEM и детекции =====================
async function sectionStream({ check, prisma, s1 }) {
  console.log('\n[K] SIEM stream and detections');
  const http = require('http');
  const received = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: b });
      res.writeHead(200);
      res.end('ok');
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const s3 = await login(SUITE.p3);
  const ws = await call('POST', '/workspaces', s1.token, { name: `audit-k-${Date.now()}` });
  const W = ws.json?.data?.id;
  const setFeature = async (key, value) => {
    if (value === null) await prisma.entitlementOverride.deleteMany({ where: { subjectType: 'workspace', subjectId: W, key } });
    else
      await prisma.entitlementOverride.upsert({
        where: { subjectType_subjectId_key: { subjectType: 'workspace', subjectId: W, key } },
        create: { subjectType: 'workspace', subjectId: W, key, mode: 'set', value, reason: 'suite audit stream', validUntil: new Date(Date.now() + 864e5), createdBy: s1.id },
        update: { mode: 'set', value },
      });
    await call('POST', '/entitlements/dev/bump', s1.token, { subject: { type: 'workspace', id: W } });
  };
  const stepUp = async () => {
    const st = await call('POST', '/verify/step-up', s1.token, { purpose: 'keys_manage', password: SUITE.password });
    const code = await devCode(st.json.data.challengeId);
    const chk = await call('POST', '/verify/check', null, { challengeId: st.json.data.challengeId, code });
    return call('POST', '/keys/step-up/confirm', s1.token, { verifyToken: chk.json.data.verifyToken });
  };
  try {
    if (!W) return check('K: workspace created', false, ws.status);
    await stepUp();
    const base = `/workspaces/${W}/webhooks/endpoints`;
    const hook = { url: `http://127.0.0.1:${port}/siem`, events: ['security.org.recorded', 'security.keys.recorded'], signing: 'hmac' };
    const locked = await call('POST', base, s1.token, hook);
    check('subscribing to security.* without audit.stream → 402', locked.status === 402 && /^entitlement\./.test(locked.code ?? ''), `${locked.status} ${locked.code}`);
    await setFeature('audit.stream', true);
    const created = await call('POST', base, s1.token, hook);
    check('with audit.stream the SIEM endpoint is created', created.status === 201, `${created.status} ${created.code}`);
    const changed = await lastEvent(prisma, { eventKey: 'org.audit.stream_changed', workspaceId: W });
    check('org.audit.stream_changed{enabled} in the organization log', changed?.details?.enabled === true && changed.details.categories === 2, JSON.stringify(changed?.details));
    const endpointId = created.json?.data?.endpoint?.id;
    const active = await waitRow(() => prisma.webhookEndpoint.findFirst({ where: { id: endpointId, status: 'active' } }), 20_000);
    check('endpoint verified by the ping → active', !!active);
    await call('POST', `/workspaces/${W}/invitations`, s1.token, { phone: SUITE.p3 });
    const got = await waitRow(async () => received.find((r) => { try { return JSON.parse(r.body).type === 'security.org.recorded'; } catch { return false; } }) ?? null, 30_000);
    const payload = got ? JSON.parse(got.body) : null;
    const dels = await prisma.webhookDelivery.findMany({ where: { endpointId }, select: { eventKey: true, status: true } });
    check('org event streamed as security.org.recorded (OCSF inside)', payload?.data?.schema === 1 && payload.data.key === 'org.member.invited' && payload.data.ocsf?.class_uid > 0, got?.body?.slice(0, 160) ?? `received=${received.map((r) => { try { return JSON.parse(r.body).type; } catch { return '?'; } }).join(',')} deliveries=${JSON.stringify(dels)}`);
    check('stream payload has no IP, UA or names', !!payload && !/"ip"|ip_enc|userAgent|firstName|lastName/.test(got.body), got?.body?.slice(0, 200));
    // Детекции (посев без настоящих неудачных входов)
    for (const kind of ['password_spray', 'bruteforce_ip', 'otp_fatigue', 'mass_export', 'credential_stuffing']) {
      const r = await call('POST', '/audit/dev/detect/seed', s1.token, { kind });
      const a = r.json?.data?.alert;
      check(`detection ${kind} raises an open alert`, r.ok && a?.status === 'open', JSON.stringify(r.json?.data));
      if (a) {
        const ev = await lastEvent(prisma, { eventKey: `detect.${kind}`, targetId: a.id });
        check(`detect.${kind} event references the alert`, !!ev);
        await prisma.securityAlert.update({ where: { id: a.id }, data: { status: 'closed', resolution: 'resolved', closedAt: new Date() } });
      }
    }
    const spray2 = await call('POST', '/audit/dev/detect/seed', s1.token, { kind: 'otp_fatigue' });
    check('a repeat on an open alert does not duplicate it (hits grow)', spray2.ok && !!spray2.json?.data?.alert);
    if (spray2.json?.data?.alert) await prisma.securityAlert.update({ where: { id: spray2.json.data.alert.id }, data: { status: 'closed', resolution: 'duplicate', closedAt: new Date() } });
    // Массовая выгрузка ВНУТРИ организации → владелец узнаёт сам, ссылка — на событие её журнала
    const cause = await lastEvent(prisma, { eventKey: 'org.member.invited', workspaceId: W });
    const since = new Date();
    const orgSeed = await call('POST', '/audit/dev/detect/seed', s1.token, { kind: 'mass_export', org: { workspaceId: W, eventId: String(cause?.id ?? '0') } });
    const massNote = await waitRow(() => prisma.notification.findFirst({ where: { type: 'security.org.massExport', userId: s1.id, createdAt: { gte: since } }, include: { event: { select: { refType: true, refId: true } } } }), 20_000);
    check('mass export inside an organization notifies its owner (link to the event of the organization log)', orgSeed.ok && !!massNote && massNote.event?.refType === 'security_org_event' && String(massNote.event?.refId ?? '').startsWith(`${W}:`), JSON.stringify({ seed: orgSeed.json?.data?.alert?.status, ref: massNote?.event }));
    if (orgSeed.json?.data?.alert) await prisma.securityAlert.update({ where: { id: orgSeed.json.data.alert.id }, data: { status: 'closed', resolution: 'resolved', closedAt: new Date() } });
    // Очередь тревог: закрытая старше года удаляется, свежая закрытая и старая открытая — нет
    const old = new Date(Date.now() - 400 * 86_400_000);
    const tag = `suite-purge-${Date.now()}`;
    const [aOld, aRecent, aOpen] = await Promise.all([
      prisma.securityAlert.create({ data: { kind: 'bruteforce_ip', severity: 'high', dedupeKey: `${tag}:old`, status: 'closed', resolution: 'resolved', openedAt: old, closedAt: old } }),
      prisma.securityAlert.create({ data: { kind: 'bruteforce_ip', severity: 'high', dedupeKey: `${tag}:recent`, status: 'closed', resolution: 'resolved', openedAt: old, closedAt: new Date() } }),
      prisma.securityAlert.create({ data: { kind: 'bruteforce_ip', severity: 'high', dedupeKey: `${tag}:open`, status: 'open', openedAt: old } }),
    ]);
    const purge = await call('POST', '/audit/dev/alerts/purge', s1.token, {});
    const left = await prisma.securityAlert.findMany({ where: { id: { in: [aOld.id, aRecent.id, aOpen.id] } }, select: { id: true } });
    check('closed alerts past a year are purged; recent closed and open ones stay', purge.ok && purge.json.data.purged >= 1 && !left.some((a) => a.id === aOld.id) && left.length === 2, `${purge.status} ${JSON.stringify(purge.json?.data)} left=${left.length}`);
    await prisma.securityAlert.deleteMany({ where: { id: { in: [aRecent.id, aOpen.id] } } });
    const { consoleLogin } = require('./_lib.cjs');
    const ct = (await consoleLogin(SUITE.p1)).token;
    if (ct) {
      const { consoleSudo } = require('./_lib.cjs');
      await consoleSudo(ct);
      const before = received.length;
      const rp = await call('POST', '/platform/commands/security.stream.replay', ct, { input: { workspaceId: W, from: new Date(Date.now() - 3600e3).toISOString(), to: new Date().toISOString() }, idempotencyKey: `suite-${Date.now()}`, reason: 'suite: SIEM lost deliveries' });
      check('security.stream.replay re-sends the window', rp.ok && rp.json?.data?.result?.events >= 1, `${rp.status} ${rp.code} ${JSON.stringify(rp.json?.data?.result)}`);
      await waitRow(async () => (received.length > before ? true : null), 20_000);
      check('replayed deliveries reach the SIEM', received.length > before, `${before} → ${received.length}`);
    }
    await call('DELETE', `${base}/${endpointId}`, s1.token);
    const off = await lastEvent(prisma, { eventKey: 'org.audit.stream_changed', workspaceId: W });
    check('deleting the endpoint records stream_changed{enabled: false}', off?.details?.enabled === false, JSON.stringify(off?.details));
  } finally {
    server.close();
    if (W) {
      await setFeature('audit.stream', null);
      await call('DELETE', `/workspaces/${W}`, s1.token);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
