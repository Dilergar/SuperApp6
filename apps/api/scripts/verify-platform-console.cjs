/* eslint-disable */
// E2E: core/platform — кабинет платформы (20-й движок). Сьют suite1 (владелец, bootstrap
// скриптом), suite2 (второй сотрудник), suite3 (не сотрудник). API на :3001, dev-режим.
// Покрывает: bootstrap владельца (повтор — отказ); вход пароль+OTP; блок после 5 паролей;
// продуктовый токен на /platform → 401, токен кабинета в продукте → 401, гость → 401,
// X-Workspace-Id → 400; простой сессии → 401; приостановка отзывает сессии; идемпотентный
// ключ дважды → одна запись/один эффект, другой вход → 409; preview без эффекта; high без
// sudo → 403 step_up_required, с sudo → ok; отказ по capability записан denied; маскирование
// входа; UPDATE журнала падает по триггеру; pii.reveal; lookup; панели без запрещённых полей;
// dual control → pending, автор не одобряет, второй владелец одобряет → executed с approvalId;
// команда над собственной записью → отказ; security-alert владельцу.
// Run: node apps/api/scripts/verify-platform-console.cjs
const { execFileSync } = require('child_process');
const path = require('path');
const { SUITE, call, login, makeChecker } = require('./_lib.cjs');
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { redactForAudit, sodConflicts } = require('../../../packages/shared/dist/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10_000, intervalMs = 400) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(intervalMs);
  }
}
const devCode = async (challengeId) => (await call('GET', `/verify/dev/last-code?challengeId=${challengeId}`)).json?.data?.code ?? null;

/** Полный вход в кабинет: пароль → код → токен кабинета. */
async function consoleLogin(phone) {
  const start = await call('POST', '/platform/auth/start', null, { phone, password: SUITE.password });
  if (!start.ok) return { start };
  const code = await devCode(start.json.data.challengeId);
  const chk = await call('POST', '/verify/check', null, { challengeId: start.json.data.challengeId, code });
  if (!chk.ok) return { start, chk };
  const login = await call('POST', '/platform/auth/login', null, { verifyToken: chk.json.data.verifyToken });
  return { start, chk, login, token: login.json?.data?.accessToken ?? null };
}
async function sudo(token) {
  const st = await call('POST', '/platform/auth/step-up/start', token, { password: SUITE.password });
  if (!st.ok) return st;
  const code = await devCode(st.json.data.challengeId);
  const chk = await call('POST', '/verify/check', null, { challengeId: st.json.data.challengeId, code });
  if (!chk.ok) return chk;
  return call('POST', '/platform/auth/step-up/confirm', token, { verifyToken: chk.json.data.verifyToken });
}
/**
 * Счётчики блокировок кабинета живут в Redis (вход и step-up). Сьют их специально
 * поджигает, поэтому чистит за собой: иначе следующий прогон в пределах 15 минут
 * упёрся бы в блокировку, которую сам же и поставил.
 */
async function clearConsoleLocks(userIds, phones) {
  let redis;
  try {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: false, maxRetriesPerRequest: 1 });
    for (const id of userIds) await redis.del(`platform:stepupfail:${id}`);
    for (const phone of phones) await redis.del(`platform:loginfail:${phone}`);
  } catch {
    /* Redis недоступен — сьют всё равно отработает, блокировки истекут сами */
  } finally {
    if (redis) await redis.quit().catch(() => undefined);
  }
}

const run = (token, key, input, extra = {}) =>
  call('POST', `/platform/commands/${key}`, token, { input, idempotencyKey: extra.idempotencyKey ?? `suite-${Date.now()}-${Math.random().toString(36).slice(2)}`, reason: extra.reason, ticketRef: extra.ticketRef });

async function main() {
  const { check, finish } = makeChecker();
  const prisma = new PrismaClient();
  const s1 = await login(SUITE.p1);
  const s2 = await login(SUITE.p2);
  const s3 = await login(SUITE.p3);
  console.log('logged in suite1..3');
  await clearConsoleLocks([s1.id, s2.id, s3.id], [SUITE.p1, SUITE.p2]);
  const tag = `pc-${Date.now()}`;

  // ===== 0. Bootstrap владельца: скрипт (идемпотентно для suite1), повтор — отказ =====
  const owners = await prisma.platformStaffRole.count({ where: { role: 'platform_owner', staff: { status: 'active' } } });
  if (owners === 0) {
    execFileSync('node', [path.join(__dirname, 'platform-bootstrap-owner.cjs'), SUITE.p1], { stdio: 'inherit' });
  }
  let refused = false;
  try {
    execFileSync('node', [path.join(__dirname, 'platform-bootstrap-owner.cjs'), SUITE.p1], { stdio: 'pipe' });
  } catch {
    refused = true;
  }
  check('bootstrap повторно → отказ (владелец уже есть)', refused);
  // Состояние сьюта: suite2 — не сотрудник (или сотрудник, оставшийся от прошлого прогона — чистим)
  await prisma.platformStaffRole.deleteMany({ where: { userId: s2.id } });
  await prisma.platformStaff.deleteMany({ where: { userId: s2.id } });
  await prisma.platformStaff.deleteMany({ where: { userId: s3.id } });
  await prisma.platformPolicy.upsert({ where: { id: 'default' }, create: { id: 'default', policy: { dualControlEnabled: false } }, update: { policy: { dualControlEnabled: false } } });

  try {
    // ===== 1. Вход =====
    const c1 = await consoleLogin(SUITE.p1);
    check('вход владельца: пароль → OTP → токен кабинета', !!c1.token, JSON.stringify(c1.login?.json ?? c1.chk?.json ?? c1.start?.json).slice(0, 200));
    const t1 = c1.token;
    const me = await call('GET', '/platform/me', t1);
    check('/platform/me: роль platform_owner и capabilities', me.ok && me.json.data.roles.includes('platform_owner') && me.json.data.capabilities.includes('entitlements.catalog.write'), JSON.stringify(me.json?.data).slice(0, 200));
    check('sudo ещё нет', me.json?.data?.sudoUntil === null);
    // Не-сотрудник — suite2 (ещё не добавлен); suite3 ниже получит 15-минутный блок паролей
    const c3 = await consoleLogin(SUITE.p2);
    check('не-сотрудник: start и код проходят (не раскрываем), login → 403 platform.not_staff', c3.start?.ok && c3.chk?.ok && c3.login?.status === 403 && c3.login?.code === 'platform.not_staff', `${c3.start?.status}/${c3.chk?.status}/${c3.login?.status} ${c3.login?.code}`);
    // Блок после 5 неверных паролей — на номере suite3 (не портим вход владельца и второго сотрудника)
    let blocked = null;
    for (let i = 0; i < 6; i++) blocked = await call('POST', '/platform/auth/start', null, { phone: SUITE.p3, password: 'nope-' + i });
    check('6-я попытка с неверным паролем → 429 platform.login_blocked', blocked.status === 429 && blocked.code === 'platform.login_blocked', `${blocked.status} ${blocked.code}`);

    // ===== 2. Границы токенов =====
    check('гость на /platform/me → 401', (await call('GET', '/platform/me', null)).status === 401);
    check('продуктовый токен на /platform/me → 401', (await call('GET', '/platform/me', s1.token)).status === 401);
    const prod = await call('GET', '/users/me', t1);
    check('токен кабинета на продуктовой ручке → 401', prod.status === 401, `${prod.status} ${prod.code}`);
    const hdr = await call('GET', '/platform/me', t1, null, { 'X-Workspace-Id': s1.id });
    check('X-Workspace-Id на /platform/* → 400', hdr.status === 400 && hdr.code === 'platform.workspace_header_rejected', `${hdr.status} ${hdr.code}`);

    // ===== 3. Команды: capability, step-up, причина, идемпотентность, preview =====
    const cmds = await call('GET', '/platform/commands', t1);
    check('реестр команд отдан с JSON-схемой входа', cmds.ok && cmds.json.data.some((c) => c.key === 'entitlements.override.set' && c.inputSchema?.type === 'object'), `${cmds.status}`);
    const noSudo = await run(t1, 'entitlements.plan.publishVersion', { planVersionId: '00000000-0000-4000-8000-000000000102' }, { reason: 'suite: publish without sudo' });
    check('high-risk без sudo → 403 platform.step_up_required', noSudo.status === 403 && noSudo.code === 'platform.step_up_required', `${noSudo.status} ${noSudo.code}`);
    const su = await sudo(t1);
    check('step-up: пароль → код → sudoUntil', su.ok && !!su.json.data.sudoUntil, JSON.stringify(su.json).slice(0, 200));
    const noReason = await run(t1, 'entitlements.plan.publishVersion', { planVersionId: '00000000-0000-4000-8000-000000000102' });
    check('high-risk без причины → 400 platform.reason_required', noReason.status === 400 && noReason.code === 'platform.reason_required', `${noReason.status} ${noReason.code}`);
    // Идемпотентность на medium-команде (черновик версии)
    const idem = `suite-idem-${tag}`;
    const v1 = await run(t1, 'entitlements.plan.createVersion', { planKey: 'personal', note: `suite ${tag}` }, { idempotencyKey: idem });
    const v2 = await run(t1, 'entitlements.plan.createVersion', { planKey: 'personal', note: `suite ${tag}` }, { idempotencyKey: idem });
    check('команда с тем же ключом дважды → один auditId, replayed', v1.ok && v2.ok && v1.json.data.auditId === v2.json.data.auditId && v2.json.data.replayed === true, JSON.stringify({ a: v1.json?.data?.auditId, b: v2.json?.data?.auditId }));
    const versionsAfter = await prisma.planVersion.count({ where: { note: `suite ${tag}` } });
    check('эффект — ровно один черновик', versionsAfter === 1, String(versionsAfter));
    const v3 = await run(t1, 'entitlements.plan.createVersion', { planKey: 'business_basic', note: `suite ${tag}` }, { idempotencyKey: idem });
    check('тот же ключ с другим входом → 409 platform.idempotency_mismatch', v3.status === 409 && v3.code === 'platform.idempotency_mismatch', `${v3.status} ${v3.code}`);
    const draft = await prisma.planVersion.findFirst({ where: { note: `suite ${tag}` } });
    const bad = await run(t1, 'entitlements.plan.updateDraft', { planVersionId: draft.id, entitlements: { 'contacts.maxCircles': -5 } });
    check('черновик с отрицательным значением → 400', bad.status === 400, `${bad.status} ${bad.code}`);
    const badKey = await run(t1, 'entitlements.plan.updateDraft', { planVersionId: draft.id, entitlements: { 'nope.key': 1 } });
    check('черновик с неизвестным ключом → 400', badKey.status === 400, `${badKey.status} ${badKey.code}`);
    const freshForPreview = await consoleLogin(SUITE.p1);
    const prevNoSudo = await call('POST', `/platform/commands/entitlements.plan.publishVersion/preview`, freshForPreview.token, { input: { planVersionId: draft.id } });
    check('предпросмотр high-команды без sudo → 403 step_up_required', prevNoSudo.status === 403 && prevNoSudo.code === 'platform.step_up_required', `${prevNoSudo.status} ${prevNoSudo.code}`);
    const prev = await call('POST', `/platform/commands/entitlements.plan.publishVersion/preview`, t1, { input: { planVersionId: draft.id } });
    const still = await prisma.planVersion.findUnique({ where: { id: draft.id } });
    check('preview публикации показывает after.status=published, эффекта нет (draft остался)', prev.ok && prev.json.data.after?.status === 'published' && still.status === 'draft', `${prev.status} ${still.status}`);
    const viewLogAfterPreview = await waitFor(() => prisma.platformAccessLog.findFirst({ where: { actorId: s1.id, kind: 'view' }, orderBy: { occurredAt: 'desc' } }), 5000);
    check('предпросмотр считается чтением (бюджет просмотров общий)', !!viewLogAfterPreview);
    const dryRow = await prisma.platformAuditEntry.findFirst({ where: { commandKey: 'entitlements.plan.publishVersion', targetId: draft.id, dryRun: true }, orderBy: { occurredAt: 'desc' } });
    check('предпросмотр оставляет строку журнала (dryRun, readOnly)', !!dryRow && dryRow.readOnly === true && dryRow.outcome === 'ok', JSON.stringify({ dry: dryRow?.dryRun, ro: dryRow?.readOnly }));
    const pub = await run(t1, 'entitlements.plan.publishVersion', { planVersionId: draft.id }, { reason: `suite ${tag}: publish personal draft` });
    check('публикация с sudo и причиной → ok', pub.ok && pub.json.data.status === 'ok', `${pub.status} ${pub.code}`);
    const audit = await call('GET', `/platform/audit?commandKey=entitlements.plan.publishVersion&targetId=${draft.id}`, t1);
    check('журнал: запись ok с reason и stepUpAt', audit.ok && audit.json.data.items[0]?.outcome === 'ok' && !!audit.json.data.items[0]?.stepUpAt && audit.json.data.items[0]?.reason?.includes(tag), JSON.stringify(audit.json?.data?.items?.[0]).slice(0, 200));
    // Подписка suite3 на опубликованную версию (последняя опубликованная personal = черновик сьюта)
    const setSub = await run(t1, 'entitlements.subscription.set', { subject: { type: 'user', id: s3.id }, planKey: 'personal', status: 'active' }, { reason: `suite ${tag}: pin suite3` });
    check('subscription.set → подписка пришита к опубликованной версии', setSub.ok && setSub.json.data.after?.planVersionId === draft.id, JSON.stringify(setSub.json?.data?.after).slice(0, 200));
    // Снимок клиента после публикации — на ТОМ субъекте, которому сьют сам пришил план:
    // опираться на чужой триал (suite1) значит зависеть от состояния соседнего сьюта
    const meProduct = (await call('GET', '/entitlements/me', s3.token)).json?.data;
    check('подписчик опубликованной версии видит значение плана (source plan)', meProduct?.values?.['contacts.maxCircles']?.source === 'plan' && meProduct?.values?.['contacts.maxCircles']?.value === 100, JSON.stringify(meProduct?.values?.['contacts.maxCircles']));
    const arch = await run(t1, 'entitlements.plan.archiveVersion', { planVersionId: draft.id }, { reason: `suite ${tag}: archive` });
    check('архив опубликованной версии с живыми подписками → 409 versionPinned', arch.status === 409, `${arch.status} ${arch.code}`);
    const selfSub = await run(t1, 'entitlements.subscription.set', { subject: { type: 'user', id: s1.id }, planKey: 'personal', status: 'active' }, { reason: `suite ${tag}: self plan` });
    check('тариф САМОМУ СЕБЕ → 403 platform.self_target', selfSub.status === 403 && selfSub.code === 'platform.self_target', `${selfSub.status} ${selfSub.code}`);
    const supportNote = await waitFor(async () => {
      const feed = (await call('GET', '/notifications?context=personal', s3.token)).json?.data;
      return (feed?.items ?? []).find((n) => n.type === 'entitlement.support.changed');
    });
    check('субъект узнал, что тариф изменила поддержка', !!supportNote, supportNote ? supportNote.title : 'нет строки');
    const grantNoUntil = await run(t1, 'entitlements.grant.create', { subject: { type: 'user', id: s3.id }, key: 'contacts.maxCircles', value: 5, source: 'manual' }, { reason: `suite ${tag}: grant without deadline` });
    check('ручной грант без срока → 400 (срок обязателен)', grantNoUntil.status === 400, `${grantNoUntil.status} ${grantNoUntil.code}`);
    const unset = await run(t1, 'entitlements.subscription.set', { subject: { type: 'user', id: s3.id }, planVersionId: null }, { reason: `suite ${tag}: unpin suite3` });
    check('subscription.set с null → подписка снята (free)', unset.ok && unset.json.data.after === null, JSON.stringify(unset.json?.data).slice(0, 200));
    // Подписка на ЧЕРНОВИКЕ читает значения последней опубликованной: убрать её из
    // каталога — значит молча уронить таких подписчиков на free. План `family` для
    // пробы и берётся: у него опубликованных версий нет вовсе, поэтому наша станет
    // единственной (у personal в живой базе их несколько — правило там не при делах).
    const famDraft = await run(t1, 'entitlements.plan.createVersion', { planKey: 'family', note: `suite ${tag} family` }, { idempotencyKey: `suite-fam-${tag}` });
    const famVersionId = famDraft.json?.data?.after?.id;
    const famPub = await run(t1, 'entitlements.plan.publishVersion', { planVersionId: famVersionId }, { reason: `suite ${tag}: publish family draft` });
    const famSeed = await prisma.planVersion.findFirst({ where: { plan: { key: 'family' }, status: 'draft' }, orderBy: { version: 'asc' } });
    const famSubject = randomUUID();
    const famSub = famSeed
      ? await prisma.subjectSubscription.create({
          data: { subjectType: 'family', subjectId: famSubject, planVersionId: famSeed.id, status: 'active', startedAt: new Date(), source: 'manual' },
        })
      : null;
    const archLast = await run(t1, 'entitlements.plan.archiveVersion', { planVersionId: famVersionId }, { reason: `suite ${tag}: archive the last published` });
    check(
      'архив ПОСЛЕДНЕЙ опубликованной версии при живых подписках плана → 409 entitlement.planLastPublished',
      famPub.ok && !!famSub && archLast.status === 409 && archLast.code === 'entitlement.planLastPublished',
      `${famPub.status}/${archLast.status} ${archLast.code}`,
    );
    // Снимаем причину отказа — архивация обязана пройти (иначе правило запирало бы каталог)
    if (famSub) await prisma.subjectSubscription.delete({ where: { id: famSub.id } });
    const archAfter = await run(t1, 'entitlements.plan.archiveVersion', { planVersionId: famVersionId }, { reason: `suite ${tag}: archive after unpin` });
    check('без живых подписок плана та же архивация проходит', archAfter.ok, `${archAfter.status} ${archAfter.code}`);

    // ===== 4. Журнал неизменяем; маскирование =====
    let trigger = false;
    try {
      await prisma.platformAuditEntry.update({ where: { id: pub.json.data.auditId }, data: { reason: 'tampered' } });
    } catch (e) {
      trigger = /append-only/.test(String(e.message));
    }
    check('UPDATE записи журнала падает по триггеру', trigger);
    const masked = redactForAudit({ password: 'x', nested: { token: 'y', ok: 1 }, list: [{ otpCode: 'z' }] }, ['custom']);
    check('маскирование входа: password/token/otpCode → [redacted]', masked.password === '[redacted]' && masked.nested.token === '[redacted]' && masked.nested.ok === 1 && masked.list[0].otpCode === '[redacted]');
    check('SoD-хелпер: write+approve одной пары — конфликт', sodConflicts(['entitlements.override.write', 'entitlements.override.approve']).length === 1 && sodConflicts(['entitlements.override.write']).length === 0);

    // ===== 5. Сотрудники: добавить suite2 (critical), self-target, security-alert =====
    const selfCmd = await run(t1, 'platform.staff.suspend', { userId: s1.id }, { reason: `suite ${tag}: self suspend` });
    check('команда над собственной записью → 403 platform.self_target', selfCmd.status === 403 && selfCmd.code === 'platform.self_target', `${selfCmd.status} ${selfCmd.code}`);
    const add = await run(t1, 'platform.staff.add', { userId: s2.id, note: `suite ${tag}` }, { reason: `suite ${tag}: add staff` });
    check('platform.staff.add (critical, sudo+причина) → ok', add.ok, `${add.status} ${add.code}`);
    const alert = await waitFor(async () => {
      const feed = (await call('GET', '/notifications?context=personal', s1.token)).json?.data;
      return (feed?.items ?? []).find((n) => n.type === 'platform.security.alert');
    });
    check('security-alert доставлен владельцу', !!alert, alert ? alert.title : 'нет строки');
    // suite2 — сотрудник без роли: вход есть, capability нет
    const c2 = await consoleLogin(SUITE.p2);
    check('сотрудник без роли входит', !!c2.token, JSON.stringify(c2.login?.json).slice(0, 150));
    const t2 = c2.token;
    const denied = await call('GET', '/platform/audit', t2);
    check('без capability → 403 platform.capability_denied', denied.status === 403 && denied.code === 'platform.capability_denied', `${denied.status} ${denied.code}`);
    const deniedRow = await waitFor(() => prisma.platformAuditEntry.findFirst({ where: { actorId: s2.id, outcome: 'denied' }, orderBy: { occurredAt: 'desc' } }), 5000);
    check('отказ записан в журнал как denied', !!deniedRow, JSON.stringify(deniedRow?.input));
    const grant = await run(t1, 'platform.staff.role.grant', { userId: s2.id, role: 'platform_owner' }, { reason: `suite ${tag}: second owner` });
    check('выдача роли platform_owner второму сотруднику → ok', grant.ok, `${grant.status} ${grant.code}`);
    await sleep(300);
    const me2 = await call('GET', '/platform/me', t2);
    check('после выдачи роли capabilities появились (кэш сброшен)', me2.ok && me2.json.data.capabilities.includes('entitlements.override.approve'), JSON.stringify(me2.json?.data?.capabilities?.length));

    // ===== 6. Lookup, карточка 360, PII =====
    const lk = await call('GET', `/platform/lookup?q=${encodeURIComponent(SUITE.p3)}`, t1);
    check('lookup по полному телефону → 1 человек, телефон маскирован', lk.ok && lk.json.data.query.kind === 'phone' && lk.json.data.users.length === 1 && /•••/.test(lk.json.data.users[0].phoneMasked), JSON.stringify(lk.json?.data).slice(0, 200));
    const lkPartial = await call('GET', `/platform/lookup?q=${encodeURIComponent('+7700999')}`, t1);
    check('неполный телефон → пусто (tooShort)', lkPartial.ok && lkPartial.json.data.users.length === 0 && lkPartial.json.data.query.kind === 'tooShort');
    const lkUuid = await call('GET', `/platform/lookup?q=${s3.id}`, t1);
    check('lookup по uuid → человек', lkUuid.ok && lkUuid.json.data.users[0]?.id === s3.id);
    const ws1 = (await call('GET', '/workspaces', s1.token)).json?.data?.[0];
    if (ws1) {
      const lkWs = await call('GET', `/platform/lookup?q=${encodeURIComponent(ws1.name.slice(0, 6))}`, t1);
      check('lookup по названию организации', lkWs.ok && lkWs.json.data.workspaces.some((w) => w.id === ws1.id));
      const head = await prisma.legalEntity.findFirst({ where: { workspaceId: ws1.id, bin: { not: null } } });
      if (head?.bin) {
        const lkBin = await call('GET', `/platform/lookup?q=${head.bin}`, t1);
        check('lookup по БИН → организация, БИН маскирован', lkBin.ok && lkBin.json.data.workspaces[0]?.id === ws1.id && /•/.test(lkBin.json.data.workspaces[0].binMasked));
      }
      const card = await call('GET', `/platform/entities/workspace/${ws1.id}`, t1);
      check('карточка организации: панели и команды', card.ok && card.json.data.panels.some((p) => p.key === 'workspace.entitlements') && card.json.data.commands.some((c) => c.key === 'entitlements.subscription.set'));
      const p = await call('GET', `/platform/entities/workspace/${ws1.id}/panels/workspace.entitlements`, t1);
      check('панель тарифа организации грузится', p.ok && !!p.json.data.data?.snapshot);
    }
    const card3 = await call('GET', `/platform/entities/user/${s3.id}`, t1);
    check('карточка человека: шапка маскирована, панели', card3.ok && /•••/.test(card3.json.data.header.phoneMasked) && card3.json.data.panels.some((p) => p.key === 'user.profile'));
    const prof = await call('GET', `/platform/entities/user/${s3.id}/panels/user.profile`, t1);
    const profStr = JSON.stringify(prof.json?.data);
    check('панель профиля без запрещённых полей и с масками', prof.ok && !/"password"|"tokenEpoch"|"token"/.test(profStr) && !profStr.includes(SUITE.p3) && /phoneMasked/.test(profStr), profStr.slice(0, 200));
    const accessLog = await waitFor(() => prisma.platformAccessLog.findFirst({ where: { actorId: s1.id, kind: 'view', targetType: 'user', targetId: s3.id } }), 5000);
    check('просмотр карточки пишет PlatformAccessLog', !!accessLog);
    // Раскрытие PII под SMS-подтверждением: свежая сессия (sudo ещё нет) получает отказ
    const freshForPii = await consoleLogin(SUITE.p1);
    const revNoSudo = await run(freshForPii.token, 'platform.pii.reveal', { entity: 'user', id: s3.id, fields: ['phone'] }, { reason: `suite ${tag}: reveal without sudo` });
    check('pii.reveal без sudo → 403 platform.step_up_required', revNoSudo.status === 403 && revNoSudo.code === 'platform.step_up_required', `${revNoSudo.status} ${revNoSudo.code}`);
    const reveal = await run(t1, 'platform.pii.reveal', { entity: 'user', id: s3.id, fields: ['phone'] }, { reason: `suite ${tag}: support ticket` });
    check('pii.reveal с причиной → полный телефон', reveal.ok && reveal.json.data.result?.fields?.phone === SUITE.p3, JSON.stringify(reveal.json).slice(0, 200));
    const revealLog = await waitFor(() => prisma.platformAuditEntry.findFirst({ where: { commandKey: 'platform.pii.reveal', targetId: s3.id, outcome: 'ok' }, orderBy: { occurredAt: 'desc' } }), 5000);
    check('pii.reveal записан в журнал команд, результат не сохранён', !!revealLog && !JSON.stringify(revealLog.after ?? {}).includes(SUITE.p3));

    const revNoReason = await call('POST', '/platform/commands/platform.pii.reveal', t1, {
      input: { entity: 'user', id: s3.id, fields: ['phone'] },
      idempotencyKey: `suite-rev-noreason-${tag}`,
    });
    check('pii.reveal без причины → 400 platform.reason_required', revNoReason.status === 400 && revNoReason.code === 'platform.reason_required', `${revNoReason.status} ${revNoReason.code}`);

    // ===== 7. Four-eyes: политика → pending → автор не одобряет → второй одобряет =====
    const pol = await run(t1, 'platform.policy.set', { dualControlEnabled: true }, { reason: `suite ${tag}: enable dual control` });
    check('platform.policy.set → dualControlEnabled=true', pol.ok && pol.json.data.after?.dualControlEnabled === true, `${pol.status} ${pol.code}`);
    const ovKey = `suite-ov-${tag}`;
    const ovInput = { subject: { type: 'user', id: s3.id }, key: 'contacts.maxCircles', mode: 'set', value: 77, reason: `suite ${tag} override reason`, validUntil: new Date(Date.now() + 864e5).toISOString() };
    const ov = await run(t1, 'entitlements.override.set', ovInput, { reason: `suite ${tag}: override via four-eyes`, idempotencyKey: ovKey });
    check('override.set при включённом dual control → status pending + requestId', ov.ok && ov.json.data.status === 'pending' && !!ov.json.data.requestId, JSON.stringify(ov.json).slice(0, 200));
    const reqId = ov.json?.data?.requestId;
    const notYet = await prisma.entitlementOverride.findFirst({ where: { subjectType: 'user', subjectId: s3.id, key: 'contacts.maxCircles' } });
    check('эффекта до одобрения нет', !notYet);
    const own = await call('POST', `/platform/requests/${reqId}/decide`, t1, { outcome: 'approved' });
    check('автор одобрить не может → 403 platform.author_cannot_approve', own.status === 403 && own.code === 'platform.author_cannot_approve', `${own.status} ${own.code}`);
    const pendingRow = await waitFor(async () => {
      const feed = (await call('GET', '/notifications?context=personal', s2.token)).json?.data;
      return (feed?.items ?? []).find((n) => n.type === 'platform.request.pending');
    });
    check('второму владельцу пришло platform.request.pending', !!pendingRow);
    const inbox = await call('GET', '/approvals/inbox', s2.token);
    check('заявка кабинета НЕ попадает в продуктовую стопку', inbox.ok && !(inbox.json.data.items ?? []).some((i) => i.title === 'entitlements.override.set'));
    const list2 = await call('GET', '/platform/requests?state=pending', t2);
    check('второй владелец видит заявку и может решить', list2.ok && list2.json.data.items.some((r) => r.id === reqId && r.canDecide === true), JSON.stringify(list2.json?.data?.items?.[0]).slice(0, 200));
    const decNoSudo = await call('POST', `/platform/requests/${reqId}/decide`, t2, { outcome: 'approved', comment: 'ok by suite2' });
    check('решение по high-заявке без sudo → 403 step_up_required', decNoSudo.status === 403 && decNoSudo.code === 'platform.step_up_required', `${decNoSudo.status} ${decNoSudo.code}`);
    // Обход контура продуктовыми ручками: заявку кабинета не решает и не отзывает
    // движок согласований — там нет ни step-up, ни разделения обязанностей.
    const reqDto = (await call('GET', `/platform/requests/${reqId}`, t2)).json?.data;
    const bypass = await call('POST', `/approvals/steps/${reqDto?.stepId}/decide`, s2.token, { decision: 'approved', comment: 'bypass attempt' });
    check('продуктовое решение заявки кабинета → 403 approval_console_only', bypass.status === 403 && bypass.code === 'approval_console_only', `${bypass.status} ${bypass.code}`);
    const bypassCancel = await call('POST', `/approvals/${reqDto?.approvalId}/cancel`, s1.token, {});
    check('продуктовый отзыв заявки кабинета → 403 approval_console_only', bypassCancel.status === 403 && bypassCancel.code === 'approval_console_only', `${bypassCancel.status} ${bypassCancel.code}`);
    const mineProduct = await call('GET', '/approvals/mine', s1.token);
    check('заявка кабинета НЕ попадает в продуктовые «Мои»', mineProduct.ok && !(mineProduct.json.data.items ?? []).some((i) => i.id === reqDto?.approvalId), JSON.stringify(mineProduct.json?.data?.items ?? []).slice(0, 150));
    const pendingStill = await prisma.platformCommandRequest.findUnique({ where: { id: reqId } });
    check('после обеих попыток заявка всё ещё ждёт решения', pendingStill?.status === 'pending', pendingStill?.status);

    const su2 = await sudo(t2);
    check('sudo второго владельца', su2.ok);
    const dec = await call('POST', `/platform/requests/${reqId}/decide`, t2, { outcome: 'approved', comment: 'ok by suite2' });
    check('одобрение вторым владельцем → executed', dec.ok && dec.json.data.status === 'executed' || (await waitFor(async () => (await prisma.platformCommandRequest.findUnique({ where: { id: reqId } }))?.status === 'executed')), JSON.stringify(dec.json).slice(0, 200));
    const applied = await prisma.entitlementOverride.findFirst({ where: { subjectType: 'user', subjectId: s3.id, key: 'contacts.maxCircles' } });
    check('оверрайд применён (77)', applied?.value === 77, JSON.stringify(applied?.value));
    const execRow = await prisma.platformCommandRequest.findUnique({ where: { id: reqId } });
    const execAudit = execRow?.executedAuditId ? await prisma.platformAuditEntry.findUnique({ where: { id: execRow.executedAuditId } }) : null;
    check('запись исполнения несёт approvalId и onBehalfOfId (кто одобрил)', !!execAudit?.approvalId && execAudit?.onBehalfOfId === s2.id && execAudit?.actorId === s1.id);
    const meProduct3 = (await call('GET', '/entitlements/me', s3.token)).json?.data;
    check('клиент видит оверрайд без reason/createdBy', meProduct3?.values?.['contacts.maxCircles']?.value === 77 && meProduct3?.values?.['contacts.maxCircles']?.source === 'override' && !JSON.stringify(meProduct3).includes('override reason'));
    const replay = await run(t1, 'entitlements.override.set', ovInput, { reason: `suite ${tag}: override via four-eyes`, idempotencyKey: ovKey });
    check('повтор ключа заявки → replayed pending с тем же requestId', replay.ok && replay.json.data.replayed === true && replay.json.data.requestId === reqId);
    // Соседняя дверь к оверрайду: грант «без ограничения» даёт тот же эффект — значит
    // при включённой политике он тоже идёт вторым сотрудником, а не в одиночку
    const grantReq = await run(
      t1,
      'entitlements.grant.create',
      { subject: { type: 'user', id: s3.id }, key: 'contacts.maxCircles', value: null, source: 'manual', validUntil: new Date(Date.now() + 864e5).toISOString() },
      { reason: `suite ${tag}: unlimited via grant` },
    );
    check('grant.create при включённом dual control → pending (обхода нет)', grantReq.ok && grantReq.json.data.status === 'pending' && !!grantReq.json.data.requestId, JSON.stringify(grantReq.json?.data).slice(0, 160));
    const grantNotYet = await prisma.entitlementGrant.findFirst({ where: { subjectType: 'user', subjectId: s3.id, source: 'manual' } });
    check('грант до одобрения не создан', !grantNotYet);
    await call('POST', `/platform/requests/${grantReq.json?.data?.requestId}/withdraw`, t1, {});

    // Отзыв своей заявки — в кабинете (продуктовая ручка для неё закрыта)
    const ovW = await run(t1, 'entitlements.override.set', { ...ovInput, value: 78 }, { reason: `suite ${tag}: override to withdraw`, idempotencyKey: `${ovKey}-w` });
    const reqW = ovW.json?.data?.requestId;
    const wd = await call('POST', `/platform/requests/${reqW}/withdraw`, t1, {});
    check('автор отзывает свою заявку в кабинете → cancelled', wd.ok && wd.json.data.status === 'cancelled', `${wd.status} ${wd.code} ${wd.json?.data?.status}`);
    const wd2 = await call('POST', `/platform/requests/${reqW}/withdraw`, t1, {});
    check('повторный отзыв → 409 platform.request_not_pending', wd2.status === 409 && wd2.code === 'platform.request_not_pending', `${wd2.status} ${wd2.code}`);
    const notApplied = await prisma.entitlementOverride.findFirst({ where: { subjectType: 'user', subjectId: s3.id, key: 'contacts.maxCircles' } });
    check('отозванная заявка эффекта не дала (значение прежнее 77)', notApplied?.value === 77, JSON.stringify(notApplied?.value));

    // Сам тумблер под «четырьмя глазами»: пока держатель одобряющего права есть (suite2),
    // выключение политики идёт заявкой, а не в одиночку
    const off = await run(t1, 'platform.policy.set', { dualControlEnabled: false }, { reason: `suite ${tag}: disable dual control` });
    check('выключение политики при живом втором владельце → заявка, а не исполнение', off.ok && off.json.data.status === 'pending' && !!off.json.data.requestId, `${off.status} ${off.json?.data?.status}`);
    const offDec = await call('POST', `/platform/requests/${off.json?.data?.requestId}/decide`, t2, { outcome: 'approved' });
    const polAfter = await waitFor(async () => (await prisma.platformPolicy.findUnique({ where: { id: 'default' } }))?.policy?.dualControlEnabled === false);
    check('второй владелец одобрил → политика выключена', offDec.ok && !!polAfter, `${offDec.status} ${offDec.code}`);
    const clrNoReason = await run(t1, 'entitlements.override.clear', { subject: { type: 'user', id: s3.id }, key: 'contacts.maxCircles' });
    check('override.clear без причины → 400 (снятие зеркалит установку)', clrNoReason.status === 400 && clrNoReason.code === 'platform.reason_required', `${clrNoReason.status} ${clrNoReason.code}`);
    const clr = await run(t1, 'entitlements.override.clear', { subject: { type: 'user', id: s3.id }, key: 'contacts.maxCircles' }, { reason: `suite ${tag}: clear override` });
    check('override.clear (high, sudo + причина) → ok', clr.ok, `${clr.status} ${clr.code}`);

    // ===== 8. Сессии: простой, приостановка =====
    const idle = await call('POST', '/platform/dev/idle', t2, {});
    const afterIdle = await call('GET', '/platform/me', t2);
    check('простой сессии → 401 platform.session_idle', idle.ok && afterIdle.status === 401 && afterIdle.code === 'platform.session_idle', `${afterIdle.status} ${afterIdle.code}`);
    const c2b = await consoleLogin(SUITE.p2);
    const t2b = c2b.token;
    check('повторный вход suite2', !!t2b);
    // Step-up — второй фактор: неверные пароли считаются и блокируются, как на входе
    let stepUpBlocked = null;
    for (let i = 0; i < 6; i += 1) {
      stepUpBlocked = await call('POST', '/platform/auth/step-up/start', t2b, { password: 'WrongPass1!' });
      if (stepUpBlocked.status === 429) break;
    }
    check('6 неверных паролей на step-up → 429 platform.login_blocked', stepUpBlocked?.status === 429 && stepUpBlocked?.code === 'platform.login_blocked', `${stepUpBlocked?.status} ${stepUpBlocked?.code}`);
    const stepUpDenied = await prisma.platformAuditEntry.findFirst({ where: { actorId: s2.id, commandKey: 'platform.auth.step_up', outcome: 'denied' }, orderBy: { occurredAt: 'desc' } });
    check('неверный пароль step-up оставляет след в журнале', !!stepUpDenied && stepUpDenied.errorCode === 'auth.wrongPassword');

    const susp = await run(t1, 'platform.staff.suspend', { userId: s2.id }, { reason: `suite ${tag}: suspend second owner` });
    check('приостановка второго владельца → ok (владелец остаётся)', susp.ok, `${susp.status} ${susp.code}`);
    const afterSusp = await call('GET', '/platform/me', t2b);
    check('сессии приостановленного отозваны → 401', afterSusp.status === 401, `${afterSusp.status} ${afterSusp.code}`);
    const c2c = await consoleLogin(SUITE.p2);
    check('приостановленный войти не может → 403 platform.not_staff', c2c.login?.status === 403 && c2c.login?.code === 'platform.not_staff', `${c2c.login?.status} ${c2c.login?.code}`);
    // Поблажка «один владелец»: политика включена, второго держателя нет (suite2
    // приостановлен) — команды штата и политики исполняются напрямую, иначе кабинет
    // заперся бы насмерть (второго некому добавить, политику некому выключить).
    //
    // ПРЕМИССА ПРОВЕРЯЕТСЯ: на боевой базе у кабинета бывает ВТОРОЙ живой владелец —
    // личный вход основателя, заведённый при первом запуске платформы. Тогда поблажки
    // нет по построению (второй одобряющий существует), и проверять её нечего:
    // молча красить сьют в такой обстановке значило бы врать о причине.
    const approvers = await prisma.platformStaffRole.findMany({
      where: { role: 'platform_owner', staff: { status: 'active' } },
      select: { userId: true },
    });
    const solo = approvers.filter((a) => a.userId !== s2.id && a.userId !== s3.id).length <= 1;
    if (!solo) {
      console.log(`  ~ поблажка «один владелец» не проверяется: живых владельцев кабинета ${approvers.length} (личный вход основателя)`);
    } else {
      const polOnSolo = await run(t1, 'platform.policy.set', { dualControlEnabled: true }, { reason: `suite ${tag}: enable dual control solo` });
      check('включение политики единственным владельцем → ok', polOnSolo.ok && polOnSolo.json.data.after?.dualControlEnabled === true, `${polOnSolo.status} ${polOnSolo.code}`);
      const soloAdd = await run(t1, 'platform.staff.add', { userId: s3.id, note: `suite ${tag} solo` }, { reason: `suite ${tag}: add staff while alone` });
      check('штат при включённой политике и одном владельце → исполнено напрямую (не заперлись)', soloAdd.ok && soloAdd.json.data.status === 'ok', `${soloAdd.status} ${soloAdd.json?.data?.status} ${soloAdd.code}`);
      const soloAudit = await prisma.platformAuditEntry.findFirst({ where: { commandKey: 'platform.staff.add', targetId: s3.id, outcome: 'ok' }, orderBy: { occurredAt: 'desc' } });
      check('строка одиночного исполнения отличима: approvalId пуст', !!soloAudit && soloAudit.approvalId === null);
      const polOffSolo = await run(t1, 'platform.policy.set', { dualControlEnabled: false }, { reason: `suite ${tag}: disable dual control solo` });
      check('выключение политики единственным владельцем → ok (замка нет)', polOffSolo.ok && polOffSolo.json.data.status === 'ok', `${polOffSolo.status} ${polOffSolo.json?.data?.status}`);
    }

    const staffList = await call('GET', '/platform/staff', t1);
    check('GET /platform/staff: suite2 suspended с ролью', staffList.ok && staffList.json.data.some((s) => s.userId === s2.id && s.status === 'suspended'));
    const out = await call('POST', '/platform/auth/logout', t1, {});
    const afterOut = await call('GET', '/platform/me', t1);
    check('logout отзывает сессию → 401', out.ok && afterOut.status === 401);
  } finally {
    // Уборка своего: suite2 из сотрудников, черновики/оверрайды сьюта, политика выключена
    await prisma.platformStaffRole.deleteMany({ where: { userId: { in: [s2.id, s3.id] } } });
    await prisma.platformStaff.deleteMany({ where: { userId: { in: [s2.id, s3.id] } } });
    await prisma.entitlementOverride.deleteMany({ where: { reason: { contains: tag } } });
    await prisma.platformPolicy.upsert({ where: { id: 'default' }, create: { id: 'default', policy: { dualControlEnabled: false } }, update: { policy: { dualControlEnabled: false } } });
    // Версия personal, опубликованная сьютом, уходит в архив (никто не пришит), черновики — удаляются:
    // каталог возвращается к состоянию до прогона.
    await prisma.subjectSubscription.updateMany({ where: { planVersion: { note: { contains: tag } }, status: { in: ['trialing', 'active', 'past_due'] } }, data: { status: 'cancelled', cancelledAt: new Date() } });
    await prisma.planVersion.updateMany({ where: { note: { contains: tag }, status: 'published' }, data: { status: 'archived' } });
    await prisma.planVersion.deleteMany({ where: { note: { contains: tag }, status: 'draft' } });
    await call('POST', '/entitlements/dev/bump', s1.token, { subject: { type: 'user', id: s1.id } });
    await call('POST', '/entitlements/dev/bump', s1.token, { subject: { type: 'user', id: s3.id } });
    await clearConsoleLocks([s1.id, s2.id, s3.id], [SUITE.p1, SUITE.p2]);
    await prisma.$disconnect();
  }
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
