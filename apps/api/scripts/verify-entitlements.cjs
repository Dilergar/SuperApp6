/* eslint-disable */
// E2E: core/entitlements — тариф и лимиты (19-й движок). Сьют suite1–3, API на :3001.
// Покрывает: free-значения = прежние константы; триал организации один на человека;
// места на путях приглашения/принятия; квота Диска consume/release + сверка; суточный
// сброс квоты SMS; оверрайд set/unlimited/deny; истечение подписки (dev-сдвиг → джоб →
// эпоха → free + уведомление); person-ключ в контексте организации, container-ключ
// личного — нет; /entitlements/me и /check; 402 несёт details.code и unlock; снимок без
// reason/grantedBy; гонка двух созданий на пороге — ровно одно.
// Прямые записи в БД (гранты/оверрайды для установки условий) сопровождаются
// POST /entitlements/dev/bump — иначе снимок живёт в кэше до 5 минут.
// Run: node apps/api/scripts/verify-entitlements.cjs
const { SUITE, call, login, makeChecker } = require('./_lib.cjs');
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');

const GB = 1024 * 1024 * 1024;
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
async function upload(p, token, bytes, filename, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), filename);
  const BASE = process.env.SA6_API_BASE || process.env.API_URL || process.env.API_BASE || 'http://localhost:3001/api';
  const res = await fetch(BASE + p, { method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: fd });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
async function uploadWhole(token, { profile, name, mime, bytes }) {
  const init = await call('POST', '/files', token, { profile, name, mime, size: bytes.length });
  if (!init.ok) return { init };
  const id = init.json.data.file.id;
  const put = await upload(`/files/${id}/content`, token, bytes, name, mime);
  if (!put.ok) return { init, put, id };
  const done = await call('POST', `/files/${id}/complete`, token, {});
  return { init, put, done, id, file: done.json?.data };
}

async function main() {
  const { check, finish } = makeChecker();
  const prisma = new PrismaClient();
  const s1 = await login(SUITE.p1);
  const s2 = await login(SUITE.p2);
  const s3 = await login(SUITE.p3);
  console.log('logged in suite1..3');
  const tag = `ent-${Date.now()}`;
  const bump = (subject) => call('POST', '/entitlements/dev/bump', s1.token, { subject });
  const me = async (u, wsId) => (await call('GET', '/entitlements/me', u.token, null, wsId ? { 'X-Workspace-Id': wsId } : undefined)).json?.data;
  const setOverride = async (subject, key, mode, value, days = 7) => {
    await prisma.entitlementOverride.upsert({
      where: { subjectType_subjectId_key: { subjectType: subject.type, subjectId: subject.id, key } },
      create: { subjectType: subject.type, subjectId: subject.id, key, mode, value: value === undefined ? null : value, reason: `suite ${tag}`, validUntil: new Date(Date.now() + days * 864e5), createdBy: s1.id },
      update: { mode, value: value === undefined ? null : value, validUntil: new Date(Date.now() + days * 864e5) },
    });
    await bump(subject);
  };
  const clearOverride = async (subject, key) => {
    await prisma.entitlementOverride.deleteMany({ where: { subjectType: subject.type, subjectId: subject.id, key } });
    await bump(subject);
  };
  const cleanup = { workspaces: [], circles: [], files: [], grants: [] };

  try {
    // ===== 1. Free-значения = прежние константы =====
    // Предусловие: у suite1 нет живой личной подписки. Аккаунт общий для сьютов, и
    // сосед (кабинет платформы) мог пришить ему план — тогда «free-значения» читались
    // бы значениями плана. Своя же строка сьюты, поэтому снимаем её, а не чужую.
    await prisma.subjectSubscription.updateMany({
      where: { subjectType: 'user', subjectId: s1.id, status: { in: ['trialing', 'active', 'past_due'] } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    await bump({ type: 'user', id: s1.id });
    const snap = await me(s1);
    check('/entitlements/me: контекст личный', snap?.contextType === 'user' && snap?.contextId === s1.id);
    check('/entitlements/me: подписка не несёт reason/grantedBy/createdBy', !JSON.stringify(snap).match(/"(reason|grantedBy|createdBy)"/));
    const v = (k) => snap?.values?.[k];
    const freeOk = v('contacts.maxCircles')?.value === 50 && v('workspaces.maxOwned')?.value === 20 && v('shop.maxShowcases')?.value === 50 && v('files.storageBytes')?.value === 15 * GB && v('skins.perGroup')?.value === false;
    check('личные free-значения = прежние константы (50/20/50/15 ГБ/false)', freeOk, JSON.stringify({ c: v('contacts.maxCircles')?.value, w: v('workspaces.maxOwned')?.value, s: v('shop.maxShowcases')?.value, f: v('files.storageBytes')?.value }));
    check('лимит с провайдером несёт used', typeof v('contacts.maxCircles')?.used === 'number');
    check('person-ключ виден в личном снимке', v('skins.perGroup')?.carrier === 'person');

    // ===== 2. Организация: триал один на человека, free-значения =====
    // suite3: если триал ещё не потрачен — первая организация получит business_pro
    const consumed3 = await prisma.subjectSubscription.count({ where: { subjectType: 'workspace', trialConsumedBy: s3.id } });
    const w3 = await call('POST', '/workspaces', s3.token, { name: `Ent ${tag} A` });
    check('организация создана (suite3)', w3.ok, JSON.stringify(w3.json).slice(0, 200));
    const ws3 = w3.json?.data?.id;
    if (ws3) cleanup.workspaces.push(ws3);
    const snap3 = await me(s3, ws3);
    if (consumed3 === 0) check('первая организация → пробный business_pro', snap3?.subscription?.planKey === 'business_pro' && snap3?.subscription?.status === 'trialing', JSON.stringify(snap3?.subscription));
    else check('триал уже потрачен → новая организация free (подписки нет)', snap3?.subscription === null, JSON.stringify(snap3?.subscription));
    const w3b = await call('POST', '/workspaces', s3.token, { name: `Ent ${tag} B` });
    const ws3b = w3b.json?.data?.id;
    if (ws3b) cleanup.workspaces.push(ws3b);
    if (!ws3b) throw new Error(`workspace B not created: ${JSON.stringify(w3b.json).slice(0, 200)}`);
    const snap3b = await me(s3, ws3b);
    check('вторая организация того же человека → без триала (уникум trialConsumedBy)', w3b.ok && snap3b?.subscription === null, JSON.stringify(snap3b?.subscription));
    const wv = (k) => snap3b?.values?.[k];
    check('free-значения организации = прежние константы (1000/2000/20/500/100 ГБ)', wv('workspace.seats')?.value === 1000 && wv('objects.maxPerWorkspace')?.value === 2000 && wv('legalEntities.maxPerWorkspace')?.value === 20 && wv('notifications.smsPerDay')?.value === 500 && wv('files.storageBytes')?.value === 100 * GB, JSON.stringify({ s: wv('workspace.seats')?.value, o: wv('objects.maxPerWorkspace')?.value, l: wv('legalEntities.maxPerWorkspace')?.value, sms: wv('notifications.smsPerDay')?.value, f: wv('files.storageBytes')?.value }));
    check('container-ключ личного плана (contacts.maxCircles) в снимке организации отсутствует', !snap3b?.values?.['contacts.maxCircles']);
    check('person-ключ (skins.perGroup) едет в контекст организации', !!snap3b?.values?.['skins.perGroup']);

    // ===== 3. Места на путях приглашения и принятия =====
    const wsSubj = { type: 'workspace', id: ws3b };
    await setOverride(wsSubj, 'workspace.seats', 'set', 1); // владелец уже занимает место
    const inv = await call('POST', `/workspaces/${ws3b}/invitations`, s3.token, { phone: SUITE.p2 });
    check('приглашение при исчерпанных местах → 402 entitlement.seat_required', inv.status === 402 && inv.code === 'entitlement.seat_required', `${inv.status} ${inv.code}`);
    check('402 несёт key/value/used/unlock', inv.json?.details?.key === 'workspace.seats' && inv.json?.details?.unlock?.by === 'workspace_owner' && typeof inv.json?.details?.used === 'number', JSON.stringify(inv.json?.details));
    await setOverride(wsSubj, 'workspace.seats', 'set', 2);
    const inv2 = await call('POST', `/workspaces/${ws3b}/invitations`, s3.token, { phone: SUITE.p2 });
    check('место есть → приглашение создано', inv2.ok, JSON.stringify(inv2.json).slice(0, 200));
    await setOverride(wsSubj, 'workspace.seats', 'set', 1); // место «кончилось» между приглашением и принятием
    const invId = inv2.json?.data?.id;
    const acc = invId ? await call('POST', `/workspaces/invitations/${invId}/accept`, s2.token) : { status: 0 };
    check('принятие при исчерпанных местах → 402 (авторитетно, в транзакции)', acc.status === 402 && acc.code === 'entitlement.seat_required', `${acc.status} ${acc.code}`);
    await setOverride(wsSubj, 'workspace.seats', 'unlimited');
    const acc2 = invId ? await call('POST', `/workspaces/invitations/${invId}/accept`, s2.token) : { status: 0 };
    check('unlimited → принятие проходит', acc2.ok, `${acc2.status} ${acc2.code}`);
    const snapU = await me(s3, ws3b);
    check('оверрайд unlimited → value null в снимке, source override', snapU?.values?.['workspace.seats']?.value === null && snapU?.values?.['workspace.seats']?.source === 'override', JSON.stringify(snapU?.values?.['workspace.seats']));
    await setOverride(wsSubj, 'workspace.seats', 'deny');
    const snapD = await me(s3, ws3b);
    check('оверрайд deny → value 0', snapD?.values?.['workspace.seats']?.value === 0);
    await clearOverride(wsSubj, 'workspace.seats');

    // ===== 4. Гонка двух созданий на пороге — ровно одно =====
    const userSubj = { type: 'user', id: s1.id };
    const circlesNow = await prisma.circle.count({ where: { ownerId: s1.id } });
    await setOverride(userSubj, 'contacts.maxCircles', 'set', circlesNow + 1);
    const [r1, r2] = await Promise.all([
      call('POST', '/circles', s1.token, { name: `${tag} race 1` }),
      call('POST', '/circles', s1.token, { name: `${tag} race 2` }),
    ]);
    for (const r of [r1, r2]) if (r.ok) cleanup.circles.push(r.json.data.id);
    check('два одновременных создания на пороге → ровно одно проходит, второе 402', [r1, r2].filter((r) => r.ok).length === 1 && [r1, r2].some((r) => r.status === 402 && r.code === 'entitlement.limit_reached'), `${r1.status}/${r2.status}`);
    const chk = await call('POST', '/entitlements/check', s1.token, { items: [{ key: 'contacts.maxCircles' }] });
    check('/entitlements/check: на лимите allowed=false, code limit_reached', chk.ok && chk.json.data.results[0].allowed === false && chk.json.data.results[0].code === 'entitlement.limit_reached', JSON.stringify(chk.json?.data));
    await clearOverride(userSubj, 'contacts.maxCircles');

    // ===== 5. Квота Диска: consume/release + сверка =====
    const usage0 = (await call('GET', '/files/usage', s1.token)).json?.data;
    await setOverride(userSubj, 'files.storageBytes', 'set', usage0.bytesUsed + 100);
    const big = await uploadWhole(s1.token, { profile: 'generic', name: `${tag}-big.txt`, mime: 'text/plain', bytes: Buffer.alloc(2048, 65) });
    check('файл сверх квоты → 402 quota_exhausted', (big.init?.status === 402 && big.init?.code === 'entitlement.quota_exhausted') || (big.done?.status === 402), `${big.init?.status}/${big.done?.status} ${big.init?.code}`);
    if (big.id) cleanup.files.push(big.id);
    await setOverride(userSubj, 'files.storageBytes', 'set', usage0.bytesUsed + 10_000);
    const small = await uploadWhole(s1.token, { profile: 'generic', name: `${tag}-small.txt`, mime: 'text/plain', bytes: Buffer.alloc(512, 66) });
    check('файл в квоте → ready', small.done?.ok && small.file?.status === 'ready', `${small.init?.status}/${small.put?.status}/${small.done?.status}`);
    if (small.id) cleanup.files.push(small.id);
    const usage1 = (await call('GET', '/files/usage', s1.token)).json?.data;
    check('consume: bytesUsed +512, filesCount +1', usage1.bytesUsed === usage0.bytesUsed + 512 && usage1.filesCount === usage0.filesCount + 1, JSON.stringify({ usage0, usage1 }));
    check('usage.limitBytes = оверрайд', usage1.limitBytes === usage0.bytesUsed + 10_000);
    const del = await call('DELETE', `/files/${small.id}`, s1.token);
    const usage2 = (await call('GET', '/files/usage', s1.token)).json?.data;
    check('release: после удаления bytesUsed вернулся', del.ok && usage2.bytesUsed === usage0.bytesUsed && usage2.filesCount === usage0.filesCount, JSON.stringify({ usage0, usage2 }));
    // сверка: искажаем счётчик и запускаем reconcile
    await prisma.quotaCounter.updateMany({ where: { subjectType: 'user', subjectId: s1.id, key: 'files.storageBytes' }, data: { used: BigInt(usage0.bytesUsed + 999_999) } });
    const rec = await call('POST', '/entitlements/dev/reconcile', s1.token, {});
    const usage3 = (await call('GET', '/files/usage', s1.token)).json?.data;
    check('сверка квот возвращает счётчик к факту', rec.ok && usage3.bytesUsed === usage0.bytesUsed, JSON.stringify({ rec: rec.json?.data, usage3 }));
    await clearOverride(userSubj, 'files.storageBytes');

    // ===== 6. Квота SMS: суточный период, ленивый сброс =====
    const smsKey = 'notifications.smsPerDay';
    await setOverride(wsSubj, smsKey, 'set', 2);
    const c1 = await call('POST', '/entitlements/dev/consume', s1.token, { subject: wsSubj, key: smsKey, delta: 2 });
    check('consume квоты в пределах → ok, used=2', c1.ok && c1.json.data.used === 2, JSON.stringify(c1.json));
    const c2 = await call('POST', '/entitlements/dev/consume', s1.token, { subject: wsSubj, key: smsKey, delta: 1 });
    check('consume сверх потолка → 402 quota_exhausted', c2.status === 402 && c2.code === 'entitlement.quota_exhausted', `${c2.status} ${c2.code}`);
    await prisma.quotaCounter.updateMany({ where: { subjectType: 'workspace', subjectId: ws3b, key: smsKey }, data: { periodEnd: new Date(Date.now() - 1000) } });
    const c3 = await call('POST', '/entitlements/dev/consume', s1.token, { subject: wsSubj, key: smsKey, delta: 1 });
    check('период истёк → ленивый сброс, consume проходит с used=1', c3.ok && c3.json.data.used === 1, JSON.stringify(c3.json));
    const snapS = await me(s3, ws3b);
    // Возврат единицы: так доставка SMS чинит бюджет организации, когда шлюз отверг
    // сообщение (сбой и каждый ретрей джоба иначе сжигали бы платную квоту).
    const rel = await call('POST', '/entitlements/dev/release', s1.token, { subject: wsSubj, key: smsKey, delta: 1 });
    check('release квоты вернул единицу (used 1 → 0)', rel.ok && rel.json?.data?.used === 0, JSON.stringify(rel.json));
    const c4 = await call('POST', '/entitlements/dev/consume', s1.token, { subject: wsSubj, key: smsKey, delta: 1 });
    check('после возврата единица снова доступна', c4.ok && c4.json?.data?.used === 1, JSON.stringify(c4.json));
    check('квота в снимке: used и resetAt', snapS?.values?.[smsKey]?.used === 1 && !!snapS?.values?.[smsKey]?.resetAt, JSON.stringify(snapS?.values?.[smsKey]));
    await clearOverride(wsSubj, smsKey);

    // ===== 7. Грант person-ключа: виден в контексте организации; истечение по сдвигу =====
    const grant = await prisma.entitlementGrant.create({
      data: { subjectType: 'user', subjectId: s1.id, key: 'skins.perGroup', value: true, source: 'gift', idempotencyKey: `suite:${tag}:skins`, validUntil: new Date(Date.now() + 864e5), reason: 'suite' },
    });
    cleanup.grants.push(grant.id);
    await bump(userSubj);
    const snapG = await me(s1);
    check('грант фичи → value true, source grant, sourceKind gift', snapG?.values?.['skins.perGroup']?.value === true && snapG?.values?.['skins.perGroup']?.source === 'grant' && snapG?.values?.['skins.perGroup']?.sourceKind === 'gift', JSON.stringify(snapG?.values?.['skins.perGroup']));
    const w1 = (await call('GET', '/workspaces', s1.token)).json?.data?.[0];
    if (w1) {
      const snapGW = await me(s1, w1.id);
      check('person-ключ из гранта виден и в контексте организации', snapGW?.values?.['skins.perGroup']?.value === true);
    }
    const equip = await call('GET', '/card-skins/equip', s1.token);
    check('card-skins: premium из движка тарифов', equip.ok && equip.json?.data?.premium === true, `${equip.status} ${JSON.stringify(equip.json?.data?.premium)}`);
    const shift = await call('POST', '/entitlements/dev/shift-grant', s1.token, { grantId: grant.id, validUntil: new Date(Date.now() - 1000).toISOString() });
    const snapG2 = await me(s1);
    check('грант просрочен (dev-сдвиг) → фича снова false', shift.ok && snapG2?.values?.['skins.perGroup']?.value === false);
    const grp = await call('POST', '/circles', s1.token, { name: `${tag} grp` });
    if (grp.ok) cleanup.circles.push(grp.json.data.id);
    const eq = grp.ok ? await call('PUT', `/card-skins/equip/group`, s1.token, { circleId: grp.json.data.id, instanceId: null }) : { status: 0 };
    check('скин на Группу без фичи → 402 feature_locked', eq.status === 402 && eq.code === 'entitlement.feature_locked', `${eq.status} ${eq.code}`);

    // ===== 8. Истечение подписки: dev-сдвиг → джоб → epoch → free + уведомление =====
    // Свежий триал у организации B (без trialConsumedBy — уникум не мешает) заводим напрямую
    {
      const proV1 = await prisma.planVersion.findFirst({ where: { plan: { key: 'business_pro' } }, orderBy: { version: 'asc' } });
      await prisma.subjectSubscription.create({
        data: { subjectType: 'workspace', subjectId: ws3b, planVersionId: proV1.id, status: 'trialing', trialEndsAt: new Date(Date.now() + 864e5), source: 'trial' },
      });
      await bump(wsSubj);
      const wsA = wsSubj;
      const ws3 = ws3b;
      const before = await me(s3, ws3);
      check('свежий триал организации виден', before?.subscription?.status === 'trialing' && before?.subscription?.planKey === 'business_pro', JSON.stringify(before?.subscription));
      // Карточка подписки — дело владельца и админа. Рядовому члену (suite2 принят в
      // эту организацию выше) уезжают ЗНАЧЕНИЯ и расход (шкала места на Диске
      // организации нужна всем), но не ступень, статус и даты.
      const memberSnap = await me(s2, ws3);
      check(
        'рядовому члену подписка организации НЕ уезжает',
        memberSnap?.subscription === null && memberSnap?.recentlyEnded === null,
        JSON.stringify({ sub: memberSnap?.subscription, ended: memberSnap?.recentlyEnded }),
      );
      check(
        'рядовой член ВИДИТ значения и расход организации',
        typeof memberSnap?.values?.['files.storageBytes']?.value === 'number' && typeof memberSnap?.values?.['workspace.seats']?.used === 'number',
        JSON.stringify(memberSnap?.values?.['workspace.seats']),
      );
      check('владельцу замок говорит «доступно на ступени» (unlock.by=self)', before?.values?.['workspace.seats']?.unlock?.by === 'self', JSON.stringify(before?.values?.['workspace.seats']?.unlock));
      check('рядовому члену замок говорит «решает владелец»', memberSnap?.values?.['workspace.seats']?.unlock?.by === 'workspace_owner', JSON.stringify(memberSnap?.values?.['workspace.seats']?.unlock));
      const sh = await call('POST', '/entitlements/dev/shift-subscription', s1.token, { subject: wsA, trialEndsAt: new Date(Date.now() - 1000).toISOString() });
      check('срок пробного сдвинут в прошлое', sh.ok, JSON.stringify(sh.json));
      const run = await call('POST', '/entitlements/dev/run-expiry', s1.token, { subject: wsA });
      const snapE = await me(s3, ws3);
      check('после истечения подписки нет (free)', run.ok && snapE?.subscription === null, JSON.stringify(snapE?.subscription));
      const sub = await prisma.subjectSubscription.findFirst({ where: { subjectType: 'workspace', subjectId: ws3 }, orderBy: { createdAt: 'desc' } });
      check('статус подписки expired', sub?.status === 'expired', sub?.status);
      const row = await waitFor(async () => {
        const feed = (await call('GET', '/notifications?context=' + ws3, s3.token)).json?.data;
        return (feed?.items ?? []).find((n) => n.type === 'entitlement.trial.expired');
      });
      check('владельцу пришло entitlement.trial.expired', !!row, row ? row.title : 'нет строки');
    }
    // ===== 9. Ключ не для этого субъекта: отказ, а не «без ограничения» =====
    // Отсутствие ключа у субъекта НЕ равно `null` («без потолка»): иначе клиент и
    // AI-инструмент получили бы зелёный свет на действие, которое сервер отвергнет.
    const chkPersonal = await call('POST', '/entitlements/check', s1.token, { items: [{ key: 'workspace.seats' }] });
    const rPersonal = chkPersonal.json?.data?.results?.[0];
    check(
      'workspace-ключ в ЛИЧНОМ контексте → allowed=false, key_not_for_subject',
      rPersonal?.allowed === false && rPersonal?.code === 'entitlement.key_not_for_subject',
      JSON.stringify(rPersonal),
    );
    const chkWs = await call('POST', '/entitlements/check', s3.token, { items: [{ key: 'contacts.maxCircles' }] }, { 'X-Workspace-Id': ws3b });
    const rWs = chkWs.json?.data?.results?.[0];
    check(
      'личный ключ в контексте ОРГАНИЗАЦИИ → allowed=false, key_not_for_subject',
      rWs?.allowed === false && rWs?.code === 'entitlement.key_not_for_subject',
      JSON.stringify(rWs),
    );

    // ===== 10. Возврат из архива считает потолок (архив ≠ обход тарифа) =====
    const leBase = `/workspaces/${ws3b}/legal-entities`;
    await setOverride(wsSubj, 'legalEntities.maxPerWorkspace', 'set', 2);
    const le2 = await call('POST', leBase, s3.token, { name: `Юрлицо А ${tag}` });
    check('второе юрлицо под потолком создано', le2.ok, `${le2.status} ${le2.code}`);
    const leArch = le2.ok ? await call('POST', `${leBase}/${le2.json.data.id}/archive`, s3.token, {}) : { status: 0 };
    check('юрлицо ушло в архив', leArch.ok, `${leArch.status}`);
    const le3 = await call('POST', leBase, s3.token, { name: `Юрлицо Б ${tag}` });
    check('архивное не занимает место в тарифе → новое создалось', le3.ok, `${le3.status} ${le3.code}`);
    const leBack = le2.ok ? await call('POST', `${leBase}/${le2.json.data.id}/restore`, s3.token, {}) : { status: 0 };
    check('возврат из архива на потолке → 402 limit_reached', leBack.status === 402 && leBack.code === 'entitlement.limit_reached', `${leBack.status} ${leBack.code}`);
    await clearOverride(wsSubj, 'legalEntities.maxPerWorkspace');
  } finally {
    // Уборка ТОЛЬКО своего: файлы, группы, гранты, оверрайды, организации сьюта
    for (const id of cleanup.files) await call('DELETE', `/files/${id}`, s1.token).catch(() => undefined);
    for (const id of cleanup.circles) await call('DELETE', `/circles/${id}`, s1.token).catch(() => undefined);
    await prisma.entitlementGrant.deleteMany({ where: { id: { in: cleanup.grants } } });
    await prisma.entitlementOverride.deleteMany({ where: { reason: `suite ${tag}` } });
    for (const id of cleanup.workspaces) {
      await prisma.subjectSubscription.deleteMany({ where: { subjectType: 'workspace', subjectId: id } });
      await prisma.quotaCounter.deleteMany({ where: { subjectType: 'workspace', subjectId: id } });
      await call('DELETE', `/workspaces/${id}`, s3.token).catch(() => undefined);
    }
    await bump({ type: 'user', id: s1.id });
    await prisma.$disconnect();
  }
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
