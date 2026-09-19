/* eslint-disable */
// E2E: core/consents (24-й движок) — согласия, шлюз новой версии, учёт действий с ПДн, инциденты.
//  1. Регистрация: старт SMS без согласий → отказ, SMS не уходит; возраст 15 → auth.minorNotAllowed;
//     ровно 4 записи приёмки с общим bundleKey — ИЗ КОНТЕКСТА SMS-цепочки, а не из тела шага 3.
//  2. Маркетинг вкл → выкл → вкл (частичный уникум); аналитика opt-out — зеркало в /analytics/consent.
//  3. Версия с будущей датой → баннер, шлюза нет; после даты → 403 consents.pending, а /users/me,
//     DELETE /users/me, /consents/* работают; сокет отвергается; /platform/* и бот — вне шлюза.
//  4. Несущественная версия шлюз не поднимает; правка опубликованной версии → отказ базы;
//     подмена текста в обход триггера → чтение падает (503 consents.integrity).
//  5. Подпись переживает ротацию и вывод ключа (архивная проверка — да, строгая — нет);
//     выключенная версия ключа отвергается обеими; перезаверение чинит.
//  6. Организация: непринятые условия после даты → владелец не управляет, сотрудник работает.
//  7. Удаление аккаунта: блокеры → мотивированный отказ; грейс 14 дней; SMS владельцу; отзыв согласий;
//     восстановление входом → шлюз просит согласия заново.
//  8. Учёт действий с ПДн: SMS, ссылка наружу, видимость карточки; «Лист согласия» — 8 реквизитов.
//  9. Инцидент: дедлайн = +1 рабочий день; тревога перед сроком — один раз.
// 10. Тестовое пополнение вне development/test → маршрута нет (проверка модуля в дочернем процессе).
// Requires: API on 3001 (NODE_ENV=development, SMS mock), suite1-3 (seed-test-accounts.cjs), PostgreSQL.
// Побочный эффект: публикуются новые версии документов и ротируется ключ подписи `consents` —
// в конце сьют принимает новое за suite1-3 и tester1-3, чтобы никто не остался за шлюзом.
// Run: node apps/api/scripts/verify-consents.cjs
const path = require('path');
const { execFileSync } = require('child_process');
const { registrationConsents, acceptAllPending } = require('./_consents.cjs');

const BASE = process.env.API_URL || 'http://localhost:3001/api';
const PW = 'Test1234!';
const SUITE = { p1: '+77009990001', p2: '+77009990002', p3: '+77009990003' };
const HUMANS = ['+77001234567', '+77012345678', '+77023456789'];

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, extra) => {
  if (c) { passed++; console.log(`  PASS ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${extra ? `  (${extra})` : ''}`); }
};
const skip = (n, why) => { skipped++; console.log(`  SKIP ${n} — ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, token, body, headers) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Locale': 'ru', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    ...(body !== undefined && body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, json, code: json?.error?.details?.code ?? json?.details?.code ?? json?.error?.code ?? null };
}
const codeOf = (r) => r.code ?? JSON.stringify(r.json ?? {}).slice(0, 160);
async function login(phone) {
  const r = await call('POST', '/auth/login', null, { phone, password: PW });
  if (!r.ok) throw new Error(`login ${phone}: ${r.status} ${JSON.stringify(r.json)}`);
  return { token: r.json.data.accessToken, refresh: r.json.data.refreshToken };
}
const stamp = Date.now() % 10_000_000;
const freshPhone = (i) => `+7700${String((stamp + i * 7919) % 10_000_000).padStart(7, '0')}`;
const devCode = async (challengeId) => (await call('GET', `/verify/dev/last-code?challengeId=${challengeId}`)).json?.data?.code ?? null;

async function registerFresh(i, opts = {}) {
  const phone = freshPhone(i);
  const consents = await registrationConsents(BASE, { marketing: !!opts.marketing });
  const r = await call('POST', '/auth/register', null, { phone, password: PW, firstName: 'Согласие', lastName: `Сьют${i}`, dateOfBirth: opts.dob || '1995-05-05', consents });
  if (!r.ok) throw new Error(`register ${phone}: ${r.status} ${JSON.stringify(r.json)}`);
  return { phone, token: r.json.data.accessToken };
}

let prisma = null;
function db() {
  if (prisma) return prisma;
  // Prisma сам читает apps/api/.env (рядом со схемой) — как в остальных сьютах
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
  return prisma;
}

async function main() {
  console.log('=== core/consents E2E ===');
  const s1 = await login(SUITE.p1);
  const s2 = await login(SUITE.p2);
  await acceptAllPending(BASE, s1.token);
  await acceptAllPending(BASE, s2.token);

  // ------------------------------------------------------------------
  console.log('\n[1] Пакет и регистрация');
  const bundle = await call('GET', '/consents/bundles/registration');
  check('пакет registration публичен: 4 обязательных + marketing', bundle.ok && bundle.json.data.documents.length === 4 && bundle.json.data.optional.some((d) => d.documentKey === 'marketing'), JSON.stringify(bundle.json).slice(0, 200));
  const docPublic = await call('GET', '/consents/documents/terms?locale=kk');
  check('документ публичен, отдаётся на запрошенном языке с хэшем', docPublic.ok && docPublic.json.data.locale === 'kk' && /^[a-f0-9]{64}$/.test(docPublic.json.data.contentHash) && docPublic.json.data.body.includes('SuperApp6'), `${docPublic.status}`);
  check('реквизиты оператора подставлены при публикации', docPublic.ok && !docPublic.json.data.body.includes('{{') && docPublic.json.data.body.includes('260940016516'));

  const phoneA = freshPhone(1);
  const noConsents = await call('POST', '/verify/start', null, { phone: phoneA, purpose: 'register' });
  check('verify/start register без consents → 400 consents.required', noConsents.status === 400 && noConsents.code === 'consents.required', `${noConsents.status} ${codeOf(noConsents)}`);
  const stale = await call('POST', '/verify/start', null, { phone: phoneA, purpose: 'register', consents: { versionIds: ['00000000-0000-4000-8000-000000000000'], locale: 'ru', channel: 'web' } });
  check('verify/start с чужим id версии → отказ', stale.status === 400 || stale.status === 409, `${stale.status} ${codeOf(stale)}`);
  const baseConsents = await registrationConsents(BASE);
  const start = await call('POST', '/verify/start', null, { phone: phoneA, purpose: 'register', consents: { ...baseConsents, channel: 'web' } });
  check('после отказов старт с согласиями проходит сразу — отказ не завёл цепочку и не сжёг кулдаун (SMS не уходила)', start.ok && !!start.json?.data?.challengeId, `${start.status} ${codeOf(start)}`);
  const code = await devCode(start.json?.data?.challengeId);
  const chk = await call('POST', '/verify/check', null, { challengeId: start.json?.data?.challengeId, code });
  const verifyToken = chk.json?.data?.verifyToken;
  const minor = await call('POST', '/auth/register', null, { phone: phoneA, password: PW, firstName: 'Юный', dateOfBirth: new Date(Date.now() - 15 * 365.25 * 86400000).toISOString().slice(0, 10), verifyToken });
  check('возраст 15 → 403 auth.minorNotAllowed (пропуск не сгорел)', minor.status === 403 && minor.code === 'auth.minorNotAllowed', `${minor.status} ${codeOf(minor)}`);
  // Тело шага 3 несёт ДРУГОЙ набор (с рассылками) — сервер обязан взять контекст SMS-цепочки (без рассылок)
  const withMarketing = await registrationConsents(BASE, { marketing: true });
  const reg = await call('POST', '/auth/register', null, { phone: phoneA, password: PW, firstName: 'Согласие', lastName: 'Цепочка', dateOfBirth: '1996-06-06', verifyToken, consents: withMarketing });
  check('регистрация по SMS-цепочке проходит', reg.ok, `${reg.status} ${codeOf(reg)}`);
  const tA = reg.json?.data?.accessToken;
  const histA = await call('GET', '/consents/history', tA);
  const rowsA = histA.json?.data ?? [];
  check('ровно 4 записи приёмки с общим bundleKey=registration', rowsA.length === 4 && rowsA.every((r) => r.bundleKey === 'registration'), `${rowsA.length} ${rowsA.map((r) => r.documentKey).join(',')}`);
  check('версии взяты из контекста SMS-цепочки: marketing из тела шага 3 НЕ записан, канал — из цепочки', !rowsA.some((r) => r.documentKey === 'marketing') && rowsA.every((r) => r.channel === 'web'));
  const stateA = await call('GET', '/consents/state', tA);
  const st = (key) => (stateA.json?.data ?? []).find((x) => x.documentKey === key);
  check('состояние: privacy accepted, marketing none, analytics default_on', st('privacy')?.status === 'accepted' && st('marketing')?.status === 'none' && st('analytics')?.status === 'default_on', JSON.stringify((stateA.json?.data ?? []).map((x) => [x.documentKey, x.status])));
  const tasksA = await call('GET', '/tasks', tA);
  check('marketing не блокирует: сервисы работают', tasksA.ok, `${tasksA.status}`);
  const noDob = await call('POST', '/auth/register', null, { phone: freshPhone(2), password: PW, firstName: 'Без', consents: baseConsents });
  check('регистрация без даты рождения → 400', noDob.status === 400, `${noDob.status}`);
  const noBundle = await call('POST', '/auth/register', null, { phone: freshPhone(2), password: PW, firstName: 'Без', dateOfBirth: '1990-01-01' });
  check('регистрация без согласий (dev, без SMS) → 400 consents.required', noBundle.status === 400 && noBundle.code === 'consents.required', `${noBundle.status} ${codeOf(noBundle)}`);

  // ------------------------------------------------------------------
  console.log('\n[2] Отзывные согласия: маркетинг и аналитика');
  const mk = bundle.json.data.optional.find((d) => d.documentKey === 'marketing');
  const on1 = await call('POST', '/consents/accept', tA, { versionIds: [mk.versionId], locale: 'ru', channel: 'web' });
  const off1 = await call('POST', '/consents/revoke', tA, { documentKey: 'marketing' });
  const on2 = await call('POST', '/consents/accept', tA, { versionIds: [mk.versionId], locale: 'ru', channel: 'web' });
  check('маркетинг вкл → выкл → вкл проходит (частичный уникум живой приёмки)', on1.ok && off1.ok && off1.json.data.revoked === 1 && on2.ok, `${on1.status}/${off1.status}/${on2.status} ${codeOf(on2)}`);
  const outside = await call('POST', '/consents/dev/accept-outside-tx', tA, {});
  check('страж: приёмка ВНЕ транзакции вызывающего отвергается движком', outside.ok && outside.json.data.refused === true, JSON.stringify(outside.json));
  const again = await call('POST', '/consents/accept', tA, { versionIds: [mk.versionId], locale: 'ru', channel: 'web' });
  check('повторная приёмка той же версии идемпотентна (та же запись)', again.ok && again.json.data.accepted[0].acceptanceId === on2.json.data.accepted[0].acceptanceId);
  const revPrivacy = await call('POST', '/consents/revoke', tA, { documentKey: 'privacy' });
  check('privacy отдельно не отзывается → 400 consents.notRevocable', revPrivacy.status === 400 && revPrivacy.code === 'consents.notRevocable', `${revPrivacy.status} ${codeOf(revPrivacy)}`);
  const anOff = await call('POST', '/consents/revoke', tA, { documentKey: 'analytics' });
  const mirrorOff = await call('GET', '/analytics/consent', tA);
  check('аналитика: отказ записан, зеркало users.analyticsOptOut = true', anOff.ok && anOff.json.data.revoked === 1 && mirrorOff.json?.data?.optOut === true, `${anOff.status} ${JSON.stringify(mirrorOff.json)}`);
  const anDoc = await call('GET', '/consents/documents/analytics');
  const anOn = await call('POST', '/consents/accept', tA, { versionIds: [anDoc.json.data.versionId], locale: 'ru', channel: 'web' });
  const mirrorOn = await call('GET', '/analytics/consent', tA);
  check('аналитика: включение обратно — зеркало false', anOn.ok && mirrorOn.json?.data?.optOut === false);
  const oldDoor = await call('PATCH', '/analytics/consent', tA, { optOut: true });
  check('прежняя дверь PATCH /analytics/consent закрыта (правда — движок согласий)', oldDoor.status === 404, `${oldDoor.status}`);

  // ------------------------------------------------------------------
  console.log('\n[3] Шлюз новой версии');
  const gated = await registerFresh(10);
  // Организация заводится ДО шлюза: ниже проверяется выход её владельца из-за блокирующего экрана
  const gatedWsRes = await call('POST', '/workspaces', gated.token, { name: `Consents gate exit ${Date.now()}` });
  const gatedWs = gatedWsRes.ok ? gatedWsRes.json.data : null;
  const pub = await call('POST', '/consents/dev/publish', s1.token, { documentKey: 'terms', effectiveInSec: 6, material: true });
  check('dev-публикация существенной версии terms с датой в будущем', pub.ok, `${pub.status} ${codeOf(pub)}`);
  await sleep(2300); // микрокэш версий соседних запросов
  const pendFuture = await call('GET', '/consents/pending', gated.token);
  check('до даты: баннер (upcoming), блокирующего нет', pendFuture.ok && pendFuture.json.data.upcoming.some((d) => d.versionId === pub.json.data.versionId) && pendFuture.json.data.blocking.length === 0, JSON.stringify(pendFuture.json).slice(0, 200));
  const beforeGate = await call('GET', '/tasks', gated.token);
  check('до даты шлюза нет', beforeGate.ok, `${beforeGate.status}`);
  const early = await registerFresh(11);
  const earlyAccept = await call('POST', '/consents/accept', early.token, { versionIds: [pub.json.data.versionId], locale: 'ru', channel: 'web' });
  check('«принять заранее» проходит', earlyAccept.ok, `${earlyAccept.status} ${codeOf(earlyAccept)}`);
  await sleep(6500);
  const afterGate = await call('GET', '/tasks', gated.token);
  check('после даты → 403 consents.pending', afterGate.status === 403 && afterGate.code === 'consents.pending', `${afterGate.status} ${codeOf(afterGate)}`);
  const earlyOk = await call('GET', '/tasks', early.token);
  check('принявший заранее не заблокирован', earlyOk.ok, `${earlyOk.status}`);
  // Владелец организации, НЕ принимающий новые условия, обязан иметь выход: единственное владение
  // блокирует удаление аккаунта, поэтому список сотрудников, передача владения и архив — вне шлюза
  if (gatedWs) {
    const gMembers = await call('GET', `/workspaces/${gatedWs.id}/members`, gated.token);
    const gUpdate = await call('PATCH', `/workspaces/${gatedWs.id}`, gated.token, { name: 'renamed behind the gate' });
    const gBlock = await call('GET', '/users/me/deletion-blockers', gated.token);
    const gArchive = await call('DELETE', `/workspaces/${gatedWs.id}`, gated.token);
    const gBlockAfter = await call('GET', '/users/me/deletion-blockers', gated.token);
    check('за шлюзом: сотрудники и архив организации доступны (выход к удалению аккаунта), прочее управление — 403 consents.pending',
      gMembers.status !== 403 && gUpdate.status === 403 && gUpdate.code === 'consents.pending' && gArchive.ok, `${gMembers.status}/${gUpdate.status} ${codeOf(gUpdate)}/${gArchive.status} ${codeOf(gArchive)}`);
    check('архив снимает блокер sole_owner — удаление аккаунта за шлюзом достижимо',
      gBlock.ok && gBlock.json.data.blockers.some((b) => b.code === 'sole_owner') && gBlockAfter.ok && gBlockAfter.json.data.canDelete === true, JSON.stringify(gBlockAfter.json).slice(0, 160));
  } else skip('выход владельца из-за шлюза', `организация не создалась: ${gatedWsRes.status} ${codeOf(gatedWsRes)}`);
  const me = await call('GET', '/users/me', gated.token);
  const blockers = await call('GET', '/users/me/deletion-blockers', gated.token);
  const delWrong = await call('DELETE', '/users/me', gated.token, { password: 'wrong-password-1' });
  check('за шлюзом работают GET /users/me, блокеры удаления и DELETE /users/me (неверный пароль → 401, не 403)', me.ok && blockers.ok && delWrong.status === 401, `${me.status}/${blockers.status}/${delWrong.status}`);
  const pendNow = await call('GET', '/consents/pending', gated.token);
  check('за шлюзом работает /consents/pending: terms в blocking', pendNow.ok && pendNow.json.data.blocking.some((d) => d.documentKey === 'terms'));
  let io = null;
  try { io = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client')).io; } catch { /* нет клиента */ }
  if (io) {
    // Рукопожатие socket.io проходит на транспорте, а отказ сервер выражает разрывом сразу после него:
    // «пустили» = соединение живо спустя секунду, «отвергли» = ошибка либо разрыв сервером
    const connect = (token) => new Promise((resolve) => {
      const sock = io('http://localhost:3001/realtime', { auth: { token }, transports: ['websocket'], reconnection: false });
      let done = false;
      const finish = (v) => { if (done) return; done = true; clearTimeout(t); sock.removeAllListeners(); sock.close(); resolve(v); };
      const t = setTimeout(() => finish('timeout'), 6000);
      sock.on('connect', () => setTimeout(() => finish(sock.connected ? 'connected' : 'dropped'), 1200));
      sock.on('connect_error', () => finish('rejected'));
      sock.on('disconnect', () => finish('dropped'));
    });
    const sockGated = await connect(gated.token);
    const sockOk = await connect(early.token);
    check('сокет человека за шлюзом отвергается тем же валидатором, принявшего — пускает', sockGated !== 'connected' && sockOk === 'connected', `${sockGated}/${sockOk}`);
  } else skip('сокет за шлюзом', 'socket.io-client не найден');
  const platform = await call('GET', '/platform/commands', gated.token);
  check('/platform/* вне шлюза: продуктовый токен получает 401 кабинета, а не consents.pending', platform.status === 401 && platform.code !== 'consents.pending', `${platform.status} ${codeOf(platform)}`);
  const acceptGate = await acceptAllPending(BASE, gated.token);
  const afterAccept = await call('GET', '/tasks', gated.token);
  check('принятие снимает шлюз сразу', acceptGate.ok && afterAccept.ok, `${afterAccept.status}`);
  // suite1 тоже упёрся в новую версию — принимаем, дальше он нужен рабочим
  await acceptAllPending(BASE, s1.token);
  await acceptAllPending(BASE, s2.token);

  // ------------------------------------------------------------------
  console.log('\n[4] Несущественная версия, неизменяемость, целостность');
  const probe = await registerFresh(12);
  const minorPub = await call('POST', '/consents/dev/publish', s1.token, { documentKey: 'cross_border', effectiveInSec: 0, material: false });
  await sleep(2300);
  const probeTasks = await call('GET', '/tasks', probe.token);
  check('несущественная версия шлюз не поднимает', minorPub.ok && probeTasks.ok, `${minorPub.status}/${probeTasks.status}`);
  const archive = await call('GET', '/consents/documents/cross_border/versions');
  check('архив версий публичен, новая версия сверху', archive.ok && archive.json.data[0].versionId === minorPub.json.data.versionId && archive.json.data.length >= 2);
  const old = await call('GET', `/consents/documents/cross_border/v/${archive.json.data[archive.json.data.length - 1].version}`);
  check('прошлая версия читается из архива и не помечена действующей', old.ok && old.json.data.isCurrent === false);
  const staleAccept = await call('POST', '/consents/accept', probe.token, { versionIds: [archive.json.data[archive.json.data.length - 1].versionId], locale: 'ru', channel: 'web' });
  check('приёмка заменённой версии → 409 consents.versionMismatch', staleAccept.status === 409 && staleAccept.code === 'consents.versionMismatch', `${staleAccept.status} ${codeOf(staleAccept)}`);
  try {
    const p = db();
    let refused = false;
    try { await p.$executeRawUnsafe(`UPDATE "consent_versions" SET "bodies" = '{"kk":"x","ru":"x","en":"x"}'::jsonb WHERE "id" = '${minorPub.json.data.versionId}'`); } catch { refused = true; }
    check('правка опубликованной версии → отказ на уровне базы (триггер)', refused);
    let delRefused = false;
    try { await p.$executeRawUnsafe(`DELETE FROM "consent_acceptances" WHERE "id" = '${on2.json.data.accepted[0].acceptanceId}'`); } catch { delRefused = true; }
    check('удаление записи приёмки → отказ на уровне базы', delRefused);
    // Лестница статуса: подпись статус НЕ покрывает, поэтому «оживить» заменённую версию не даёт база
    const supersededRow = await p.$queryRawUnsafe(`SELECT "id" FROM "consent_versions" WHERE "status" = 'superseded' LIMIT 1`);
    if (supersededRow.length) {
      let reviveRefused = false;
      try { await p.$executeRawUnsafe(`UPDATE "consent_versions" SET "status" = 'published' WHERE "id" = '${supersededRow[0].id}'`); } catch { reviveRefused = true; }
      check('superseded → published → отказ на уровне базы (лестница статуса)', reviveRefused);
    } else skip('лестница статуса', 'нет заменённых версий');
    let withdrawRefused = false;
    try { await p.$executeRawUnsafe(`UPDATE "consent_versions" SET "status" = 'withdrawn' WHERE "id" = (SELECT "id" FROM "consent_versions" WHERE "status" = 'published' AND "effective_from" < now() - interval '1 hour' LIMIT 1)`).then((n) => { if (n === 0) withdrawRefused = null; }); } catch { withdrawRefused = true; }
    if (withdrawRefused === null) skip('отзыв вступившей версии', 'нет версии старше часа');
    else check('вступившую в силу версию нельзя отозвать (withdrawn) — отказ на уровне базы', withdrawRefused === true);
    // Подмена в ОБХОД триггера (владелец таблицы): чтение обязано упасть на проверке хэша/подписи
    const vid = minorPub.json.data.versionId;
    const before = await p.$queryRawUnsafe(`SELECT "bodies"::text AS b FROM "consent_versions" WHERE "id" = '${vid}'`);
    await p.$executeRawUnsafe(`ALTER TABLE "consent_versions" DISABLE TRIGGER "consent_versions_guard"`);
    try {
      await p.$executeRawUnsafe(`UPDATE "consent_versions" SET "bodies" = jsonb_set("bodies", '{ru}', '"подменённый текст"') WHERE "id" = '${vid}'`);
      await call('POST', '/consents/dev/flush', s1.token, {});
      const tampered = await call('GET', '/consents/documents/cross_border?locale=ru');
      check('подмена текста в базе → чтение падает 503 consents.integrity', tampered.status === 503 && tampered.code === 'consents.integrity', `${tampered.status} ${codeOf(tampered)}`);
      const tamperedAccept = await call('POST', '/consents/accept', probe.token, { versionIds: [vid], locale: 'ru', channel: 'web' });
      check('приёмка подменённого текста невозможна', tamperedAccept.status === 503, `${tamperedAccept.status}`);
    } finally {
      await p.$executeRawUnsafe(`UPDATE "consent_versions" SET "bodies" = $1::jsonb WHERE "id" = '${vid}'`, before[0].b);
      await p.$executeRawUnsafe(`ALTER TABLE "consent_versions" ENABLE TRIGGER "consent_versions_guard"`);
      await call('POST', '/consents/dev/flush', s1.token, {});
    }
    const healed = await call('GET', '/consents/documents/cross_border?locale=ru');
    check('после возврата текста документ снова читается', healed.ok, `${healed.status}`);
  } catch (e) {
    skip('проверки уровня базы', `нет доступа к БД: ${e.message}`);
  }

  // ------------------------------------------------------------------
  console.log('\n[5] Подпись версии переживает ротацию ключа');
  const vA = await call('POST', '/consents/dev/publish', s1.token, { documentKey: 'marketing', effectiveInSec: 0, material: false });
  const sigA0 = await call('POST', '/consents/dev/verify-signature', s1.token, { versionId: vA.json.data.versionId });
  check('свежая версия: строгая и архивная проверки проходят', sigA0.ok && sigA0.json.data.strict === true && sigA0.json.data.archival === true, JSON.stringify(sigA0.json?.data));
  const kid1 = sigA0.json.data.kid;
  const rot1 = await call('POST', '/keys/dev/signing/rotate', s1.token, { audience: 'consents' });
  await call('POST', '/keys/dev/signing/activate', s1.token, { kid: rot1.json?.data?.kid });
  const ret1 = await call('POST', '/keys/dev/signing/retire', s1.token, { kid: kid1 });
  check('ключ ротирован, прежняя версия выведена (destroy_scheduled)', rot1.ok && ret1.json?.data?.state === 'destroy_scheduled', `${rot1.status} ${JSON.stringify(ret1.json?.data)}`);
  await call('POST', '/consents/dev/flush', s1.token, {});
  const sigA1 = await call('POST', '/consents/dev/verify-signature', s1.token, { versionId: vA.json.data.versionId });
  check('после вывода ключа: verifyArchival проходит, строгая verify — нет, документ читается', sigA1.json.data.archival === true && sigA1.json.data.strict === false && sigA1.json.data.integrity === true, JSON.stringify(sigA1.json?.data));
  const vB = await call('POST', '/consents/dev/publish', s1.token, { documentKey: 'marketing', effectiveInSec: 0, material: false });
  const sigB0 = await call('POST', '/consents/dev/verify-signature', s1.token, { versionId: vB.json.data.versionId });
  const kid2 = sigB0.json.data.kid;
  const rot2 = await call('POST', '/keys/dev/signing/rotate', s1.token, { audience: 'consents' });
  await call('POST', '/keys/dev/signing/activate', s1.token, { kid: rot2.json?.data?.kid });
  const dis = await call('POST', '/keys/dev/signing/disable', s1.token, { kid: kid2 });
  await call('POST', '/consents/dev/flush', s1.token, {});
  const sigB1 = await call('POST', '/consents/dev/verify-signature', s1.token, { versionId: vB.json.data.versionId });
  check('выключенная (disabled) версия ключа отвергается ОБЕИМИ проверками', dis.json?.data?.state === 'disabled' && sigB1.json.data.archival === false && sigB1.json.data.strict === false, `${JSON.stringify(dis.json?.data)} ${JSON.stringify(sigB1.json?.data)}`);
  const comp = await call('POST', '/keys/dev/signing/compromise', s1.token, { audience: 'consents', kid: kid2 });
  check('метка компрометации ставится (навсегда)', comp.ok && comp.json.data.compromised === true, JSON.stringify(comp.json?.data));
  const reatt = await call('POST', '/consents/dev/reattest', s1.token, {});
  const sigB2 = await call('POST', '/consents/dev/verify-signature', s1.token, { versionId: vB.json.data.versionId });
  check('перезаверение: версия переподписана действующим ключом, старая подпись в истории', reatt.ok && reatt.json.data.reattested.includes(vB.json.data.versionId) && sigB2.json.data.strict === true && sigB2.json.data.kid !== kid2, JSON.stringify(reatt.json?.data).slice(0, 200));
  const mkDoc = await call('GET', '/consents/documents/marketing');
  check('документ снова читается после перезаверения', mkDoc.ok, `${mkDoc.status} ${codeOf(mkDoc)}`);

  // ------------------------------------------------------------------
  console.log('\n[6] Организация: мягкий шлюз');
  const owner = await registerFresh(20);
  const member = await registerFresh(21);
  const wsBundle = await call('GET', '/consents/bundles/workspace_creation');
  const wsBad = await call('POST', '/workspaces', owner.token, { name: 'consents-e2e', consents: { versionIds: [wsBundle.json.data.documents[0].versionId], locale: 'ru', channel: 'web' } });
  check('создание организации с неполным пакетом → 400 consents.required', wsBad.status === 400 && wsBad.code === 'consents.required', `${wsBad.status} ${codeOf(wsBad)}`);
  const wsNew = await call('POST', '/workspaces', owner.token, { name: 'consents-e2e', consents: { versionIds: wsBundle.json.data.documents.map((d) => d.versionId), locale: 'ru', channel: 'web' } });
  check('создание организации с пакетом workspace_creation', wsNew.status === 201 || wsNew.ok, `${wsNew.status} ${codeOf(wsNew)}`);
  const W = wsNew.json?.data?.id;
  const ownerHist = await call('GET', '/consents/history', owner.token);
  check('приёмка организации: 2 записи org_owner с bundleKey=workspace_creation', (ownerHist.json?.data ?? []).filter((r) => r.actorRole === 'org_owner' && r.bundleKey === 'workspace_creation').length === 2);
  await call('POST', `/workspaces/${W}/invitations`, owner.token, { phone: member.phone });
  const incoming = await call('GET', '/workspaces/invitations/incoming', member.token);
  const invId = (incoming.json?.data ?? []).find((i) => i.workspaceId === W)?.id;
  const joined = await call('POST', `/workspaces/invitations/${invId}/accept`, member.token);
  check('сотрудник вступил в организацию', joined.ok, `${joined.status}`);
  // Бот — не субъект согласия: у его теневого пользователя нет ни одной приёмки, а шлюз (G > 0) его не трогает
  const suKeys = await call('POST', '/verify/step-up', owner.token, { purpose: 'keys_manage', password: PW });
  const suKeysCode = await devCode(suKeys.json?.data?.challengeId);
  const suKeysChk = await call('POST', '/verify/check', null, { challengeId: suKeys.json?.data?.challengeId, code: suKeysCode });
  await call('POST', '/keys/step-up/confirm', owner.token, { verifyToken: suKeysChk.json?.data?.verifyToken });
  const bot = await call('POST', `/workspaces/${W}/keys/bots`, owner.token, { name: 'Consents bot', purpose: 'e2e: consent gate exemption', rank: 'member', scopes: { tasks: 'read' }, expiresInDays: 1 });
  if (bot.status === 201 && bot.json?.data?.secret) {
    const botTasks = await call('GET', '/tasks', bot.json.data.secret);
    check('бот (kind: bot) вне шлюза согласий: запрос по ключу проходит без единой приёмки', botTasks.ok, `${botTasks.status} ${codeOf(botTasks)}`);
    const botAccept = await call('GET', '/consents/pending', bot.json.data.secret);
    check('маршруты согласий боту закрыты', botAccept.status === 403, `${botAccept.status} ${codeOf(botAccept)}`);
  } else skip('бот вне шлюза', `бот не создан: ${bot.status} ${codeOf(bot)}`);
  const wsPub = await call('POST', '/consents/dev/publish', s1.token, { documentKey: 'business_terms', effectiveInSec: 0, material: true });
  await sleep(2300);
  const manage = await call('PATCH', `/workspaces/${W}`, owner.token, { name: 'consents-e2e-renamed' });
  check('после даты владелец не управляет: PATCH /workspaces/:id → 403 consents.workspacePending', manage.status === 403 && manage.code === 'consents.workspacePending', `${manage.status} ${codeOf(manage)}`);
  const memberTask = await call('POST', '/tasks', member.token, { title: 'работа не останавливается' }, { 'X-Workspace-Id': W });
  const ownerTask = await call('POST', '/tasks', owner.token, { title: 'владелец тоже работает' }, { 'X-Workspace-Id': W });
  check('сотрудник работает, и сам владелец в сервисах работает', (memberTask.ok || memberTask.status === 201) && (ownerTask.ok || ownerTask.status === 201), `${memberTask.status}/${ownerTask.status}`);
  const pendOwner = await call('GET', '/consents/pending', owner.token);
  const wsPending = (pendOwner.json?.data?.workspaces ?? []).find((x) => x.workspaceId === W);
  check('владелец видит непринятые условия своей организации (canAccept)', !!wsPending && wsPending.canAccept === true && wsPending.blocking.length === 1);
  const memberAccept = await call('POST', '/consents/accept', member.token, { versionIds: [wsPub.json.data.versionId], locale: 'ru', channel: 'web', workspaceId: W });
  check('сотрудник принять за организацию не может → 403', memberAccept.status === 403, `${memberAccept.status} ${codeOf(memberAccept)}`);
  await acceptAllPending(BASE, owner.token);
  const manage2 = await call('PATCH', `/workspaces/${W}`, owner.token, { name: 'consents-e2e-renamed' });
  check('после принятия владельцем управление возвращается сразу', manage2.ok, `${manage2.status} ${codeOf(manage2)}`);

  // ------------------------------------------------------------------
  console.log('\n[7] Удаление аккаунта');
  const bl = await call('GET', '/users/me/deletion-blockers', owner.token);
  check('блокеры: единоличное владение организацией, грейс 14 дней', bl.ok && bl.json.data.canDelete === false && bl.json.data.graceDays === 14 && bl.json.data.blockers.some((b) => b.code === 'sole_owner' && b.workspaces.some((w) => w.id === W)), JSON.stringify(bl.json?.data).slice(0, 200));
  const delBlocked = await call('DELETE', '/users/me', owner.token, { password: PW });
  check('удаление при блокерах → 409 account.deletionBlocked (мотивированный отказ со списком)', delBlocked.status === 409 && delBlocked.code === 'account.deletionBlocked', `${delBlocked.status} ${codeOf(delBlocked)}`);
  const leaver = await registerFresh(22);
  // SMS-подтверждение: пароль → код на свой номер (цель account_delete)
  const su = await call('POST', '/verify/step-up', leaver.token, { purpose: 'account_delete', password: PW });
  const suCode = await devCode(su.json?.data?.challengeId);
  const suChk = await call('POST', '/verify/check', null, { challengeId: su.json?.data?.challengeId, code: suCode });
  check('step-up account_delete: пароль → SMS-код → пропуск', su.ok && suChk.ok && !!suChk.json?.data?.verifyToken, `${su.status}/${suChk.status}`);
  const wrongPurpose = await call('POST', '/verify/step-up', leaver.token, { purpose: 'password_change', password: PW });
  const wpCode = await devCode(wrongPurpose.json?.data?.challengeId);
  const wpChk = await call('POST', '/verify/check', null, { challengeId: wrongPurpose.json?.data?.challengeId, code: wpCode });
  const delWrongPurpose = await call('DELETE', '/users/me', leaver.token, { password: PW, verifyToken: wpChk.json?.data?.verifyToken });
  check('пропуск чужой цели (password_change) аккаунт не удаляет', delWrongPurpose.status === 400, `${delWrongPurpose.status} ${codeOf(delWrongPurpose)}`);
  const del = await call('DELETE', '/users/me', leaver.token, { password: PW, verifyToken: suChk.json?.data?.verifyToken });
  check('удаление запланировано: грейс 14 дней, дата окончательного удаления', (del.ok || del.json?.scheduled) && (del.json?.gracePeriodDays ?? del.json?.data?.gracePeriodDays) === 14, `${del.status} ${JSON.stringify(del.json).slice(0, 160)}`);
  const dead = await call('GET', '/users/me', leaver.token);
  check('сессии погашены: старый токен → 401', dead.status === 401, `${dead.status}`);
  await sleep(600);
  const back = await call('POST', '/auth/login', null, { phone: leaver.phone, password: PW });
  check('вход в грейс-период восстанавливает аккаунт', back.ok && back.json.data.restored === true, `${back.status} ${JSON.stringify(back.json).slice(0, 120)}`);
  const tBack = back.json?.data?.accessToken;
  const gateBack = await call('GET', '/tasks', tBack);
  check('согласия отозваны удалением: вернувшийся человек стоит за шлюзом до нового принятия', gateBack.status === 403 && gateBack.code === 'consents.pending', `${gateBack.status} ${codeOf(gateBack)}`);
  const histBack = await call('GET', '/consents/history', tBack);
  check('отзыв записан причиной account_deleted', (histBack.json?.data ?? []).some((r) => r.revokedReason === 'account_deleted' && r.documentKey === 'privacy'));
  const pendBack = await call('GET', '/consents/pending', tBack);
  const backKeys = (pendBack.json?.data?.blocking ?? []).map((d) => d.documentKey).sort().join(',');
  check('вернувшийся принимает ВЕСЬ обязательный пакет, включая политику оператора (уведомление без единой приёмки блокирует)', backKeys === 'cross_border,privacy,privacy_policy,terms', backKeys);
  await acceptAllPending(BASE, tBack);
  const gateOpen = await call('GET', '/tasks', tBack);
  check('после принятия пакета шлюз снят', gateOpen.ok, `${gateOpen.status} ${codeOf(gateOpen)}`);
  const transfersBack = await call('GET', '/consents/my-data/transfers', tBack);
  const purposes = (transfersBack.json?.data?.items ?? []).map((x) => x.purpose);
  check('SMS владельцу «запрошено удаление» ушло и записано в учёт (service_sms), как и код step-up (otp_sms)', purposes.includes('service_sms') && purposes.includes('otp_sms'), purposes.join(','));

  // ------------------------------------------------------------------
  console.log('\n[8] Учёт действий с ПДн и «Лист согласия»');
  // Первый аккаунт сьюта пережил учения публикации выше — принимает новое, иначе он за шлюзом
  const accA = await acceptAllPending(BASE, tA);
  const pendA = await call('GET', '/consents/pending', tA);
  check('первый аккаунт сьюта принял новые версии и вышел из-за шлюза', accA.ok && pendA.ok && pendA.json.data.blocking.length === 0, `${JSON.stringify(accA)}`);
  const vis = await call('PATCH', '/users/me', tA, { cardVisibility: { city: false } });
  const folder = await call('POST', '/drive/folders', tA, { name: `consents-${stamp}` });
  const link = folder.ok ? await call('POST', '/share-links', tA, { refType: 'drive_node', refId: folder.json.data.id }) : { ok: false, status: folder.status };
  const tr = await call('GET', '/consents/my-data/transfers', tA);
  const items = tr.json?.data?.items ?? [];
  check('учёт: SMS регистрации (kazinfoteh, otp_sms) записано уже после создания аккаунта', items.some((x) => x.purpose === 'otp_sms' && x.recipientKey === 'kazinfoteh' && x.crossBorder === false), items.map((x) => x.purpose).join(','));
  check('учёт: смена видимости карточки — распространение (publication)', vis.ok && items.some((x) => x.purpose === 'card_visibility_changed' && x.actionType === 'publication'));
  check('учёт: ссылка наружу — распространение (publication)', link.ok && items.some((x) => x.purpose === 'share_link_created' && x.actionType === 'publication'), `${link.status}`);
  check('учёт несёт только КОДЫ полей, без значений', items.every((x) => x.fields.every((f) => /^[a-z_]+$/.test(f))));
  skip('учёт: web push / Google Calendar / доставка вебхука', 'нужны VAPID, OAuth Google и живой приёмник — запись стоит в коде доставки (notifications.delivery, google-calendar.service, webhooks.delivery.job)');
  const privacyRow = rowsA.find((r) => r.documentKey === 'privacy');
  const receipt = await call('GET', `/consents/receipt/${privacyRow.id}`, tA);
  const rc = receipt.json?.data;
  check('«Лист согласия»: 8 реквизитов ст. 8 п. 4 (оператор+БИН, ФИО, срок, третьи лица, трансграничка, распространение, перечень данных, подпись версии)',
    receipt.ok && rc.operator.bin === '260940016516' && rc.subject.fullName.includes('Цепочка') && rc.term.until === 'account_deletion' && rc.thirdParties.some((t) => t.key === 'kazinfoteh') && Array.isArray(rc.crossBorder) && rc.publication === true && rc.dataFields.includes('phone') && rc.signatureValid === true,
    JSON.stringify(rc ?? receipt.json).slice(0, 240));
  const cbRow = rowsA.find((r) => r.documentKey === 'cross_border');
  const cbReceipt = await call('GET', `/consents/receipt/${cbRow.id}`, tA);
  check('лист cross_border называет трансграничного получателя web_push (США)', cbReceipt.ok && cbReceipt.json.data.crossBorder.some((t) => t.key === 'web_push' && t.country === 'US'));
  const foreignReceipt = await call('GET', `/consents/receipt/${privacyRow.id}`, s2.token);
  check('чужой лист согласия → 404', foreignReceipt.status === 404, `${foreignReceipt.status}`);

  // ------------------------------------------------------------------
  console.log('\n[9] Журнал инцидентов ПДн');
  // Пятница 18:00 Алматы (13:00 UTC) → дедлайн понедельник 18:00 Алматы
  const friday = new Date(Date.UTC(2026, 8, 11, 13, 0, 0));
  const inc = await call('POST', '/consents/dev/incident/open', s1.token, { kind: 'leak', detectedAt: friday.toISOString(), scope: 'e2e: учебный инцидент', summary: 'Учебный инцидент сьюта verify-consents: проверка арифметики рабочего дня.' });
  const expected = new Date(Date.UTC(2026, 8, 14, 13, 0, 0)).toISOString();
  check('дедлайн уведомления органа = +1 рабочий день (пятница → понедельник, то же время)', inc.ok && inc.json.data.notifyDeadlineAt === expected, `${inc.json?.data?.notifyDeadlineAt} vs ${expected}`);
  check('просроченный инцидент помечен overdue', inc.json?.data?.overdue === true);
  const al1 = await call('POST', '/consents/dev/incident/alert', s1.token, { incidentId: inc.json.data.id });
  const al2 = await call('POST', '/consents/dev/incident/alert', s1.token, { incidentId: inc.json.data.id });
  const alerts = (al2.json?.data?.events ?? []).filter((e) => e.type === 'deadline_alert').length;
  check('тревога перед сроком уходит и записывается ОДИН раз (повтор джоба — no-op)', al1.ok && alerts === 1, `alerts=${alerts}`);
  const future = await call('POST', '/consents/dev/incident/open', s1.token, { kind: 'other', detectedAt: new Date(Date.now() + 3600_000).toISOString(), scope: 'e2e', summary: 'Момент обнаружения в будущем — должен быть отвергнут.' });
  check('обнаружение в будущем → 400', future.status === 400, `${future.status}`);
  const closed = await call('POST', '/consents/dev/incident/close', s1.token, { incidentId: inc.json.data.id });
  const closedAgain = await call('POST', '/consents/dev/incident/close', s1.token, { incidentId: inc.json.data.id });
  check('закрытие — status-guarded: повтор → 409', closed.ok && closed.json.data.status === 'closed' && closedAgain.status === 409, `${closed.status}/${closedAgain.status}`);
  try {
    let immut = false;
    try { await db().$executeRawUnsafe(`UPDATE "pd_incident_events" SET "note" = 'x' WHERE "incident_id" = '${inc.json.data.id}'`); } catch { immut = true; }
    check('события инцидента append-only (триггер базы)', immut);
    let pdImmut = false;
    try { await db().$executeRawUnsafe(`DELETE FROM "pd_action_records" WHERE "subject_id" = '${(await call('GET', '/users/me', tA)).json.data.id}'`); } catch { pdImmut = true; }
    check('учёт действий с ПДн append-only (триггер базы на партициях)', pdImmut);
  } catch (e) { skip('append-only уровня базы', e.message); }

  // ------------------------------------------------------------------
  console.log('\n[10] Возраст и деньги; тестовое пополнение вне development');
  const topup = await call('POST', '/card-skins/wallet/topup', tA, { amount: 5 });
  check('в development тестовое пополнение работает', topup.ok, `${topup.status}`);
  try {
    const out = execFileSync(process.execPath, ['-e', `
      process.env.NODE_ENV = 'production';
      require('reflect-metadata');
      const { CardSkinsModule } = require('./dist/modules/card-skins/card-skins.module');
      const names = (Reflect.getMetadata('controllers', CardSkinsModule) || []).map((c) => c.name);
      process.stdout.write(JSON.stringify(names));
    `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8' });
    const names = JSON.parse(out.trim().split('\n').pop());
    check('вне development/test дев-контроллер пополнения НЕ регистрируется (маршрута нет → 404)', names.includes('CardSkinsController') && !names.includes('CardSkinsDevController'), out.trim());
    const devOut = execFileSync(process.execPath, ['-e', `
      process.env.NODE_ENV = 'development';
      require('reflect-metadata');
      const { CardSkinsModule } = require('./dist/modules/card-skins/card-skins.module');
      process.stdout.write(JSON.stringify((Reflect.getMetadata('controllers', CardSkinsModule) || []).map((c) => c.name)));
    `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'development' }, encoding: 'utf8' });
    check('страж срабатывает в обе стороны: в development контроллер есть', JSON.parse(devOut.trim().split('\n').pop()).includes('CardSkinsDevController'), devOut.trim());
  } catch (e) { skip('регистрация дев-контроллера по среде', e.message.slice(0, 160)); }

  // ------------------------------------------------------------------
  console.log('\n[10a] Кабинет платформы: команды и чтения');
  try {
    const p = db();
    // Номер в базе зашифрован (ПДн) — сотрудника ищем по id, а не по телефону
    const s1me = await call('GET', '/users/me', s1.token);
    const isStaff = await p.platformStaff.findFirst({ where: { userId: s1me.json?.data?.id, status: 'active' }, select: { userId: true } }).catch(() => null);
    if (!isStaff) {
      skip('команды кабинета', 'suite1 не сотрудник платформы (platform-bootstrap-owner.cjs не запускался)');
    } else {
      await p.platformPolicy.upsert({ where: { id: 'default' }, create: { id: 'default', policy: { dualControlEnabled: false } }, update: {} });
      const st = await call('POST', '/platform/auth/start', null, { phone: SUITE.p1, password: PW });
      const stChk = await call('POST', '/verify/check', null, { challengeId: st.json?.data?.challengeId, code: await devCode(st.json?.data?.challengeId) });
      const pl = await call('POST', '/platform/auth/login', null, { verifyToken: stChk.json?.data?.verifyToken });
      const pt = pl.json?.data?.token ?? pl.json?.data?.accessToken;
      check('вход в кабинет (suite1 — владелец платформы)', !!pt, `${st.status}/${stChk.status}/${pl.status}`);
      const su1 = await call('POST', '/platform/auth/step-up/start', pt, { password: PW });
      const su1Chk = await call('POST', '/verify/check', null, { challengeId: su1.json?.data?.challengeId, code: await devCode(su1.json?.data?.challengeId) });
      await call('POST', '/platform/auth/step-up/confirm', pt, { verifyToken: su1Chk.json?.data?.verifyToken });
      const run = (key, input, extra = {}) => call('POST', `/platform/commands/${key}`, pt, { input, idempotencyKey: `consents-${stamp}-${key}-${Math.random().toString(36).slice(2)}`, reason: extra.reason });
      const docs = {};
      for (const l of ['kk', 'ru', 'en']) docs[l] = (await call('GET', `/consents/documents/marketing?locale=${l}`)).json.data;
      const pick = (f) => ({ kk: docs.kk[f], ru: docs.ru[f], en: docs.en[f] });
      const note = { kk: 'Кабинет сьюты: редакциялық түзету', ru: 'Сьют кабинета: редакционная правка', en: 'Console suite: editorial fix' };
      const draft = await run('consents.document.draft.save', { documentKey: 'marketing', bodies: pick('body'), summaries: pick('summary'), changeSummary: note, material: false });
      check('команда consents.document.draft.save', draft.ok && draft.json.data.result?.version > docs.ru.version, `${draft.status} ${codeOf(draft)}`);
      const badPlaceholder = await run('consents.document.draft.save', { documentKey: 'marketing', bodies: { ...pick('body'), ru: 'Текст с {{unknownThing}}' }, summaries: pick('summary'), material: false });
      check('опечатка в подстановке {{…}} ловится на сохранении черновика', badPlaceholder.status === 400 && badPlaceholder.code === 'consents.unknownPlaceholder', `${badPlaceholder.status} ${codeOf(badPlaceholder)}`);
      await run('consents.document.draft.save', { documentKey: 'marketing', bodies: pick('body'), summaries: pick('summary'), changeSummary: note, material: false });
      const noReason = await run('consents.document.publish', { documentKey: 'marketing' });
      check('публикация без причины → отказ конвейера кабинета', !noReason.ok, `${noReason.status} ${codeOf(noReason)}`);
      const soon = await run('consents.document.publish', { documentKey: 'marketing', effectiveFrom: new Date(Date.now() + 3600_000).toISOString() }, { reason: 'suite: publication sooner than the notice period without the urgent flag' });
      check('дата раньше срока уведомления без urgent → 400 consents.urgentNeedsReason', soon.status === 400 && soon.code === 'consents.urgentNeedsReason', `${soon.status} ${codeOf(soon)}`);
      const pubCmd = await run('consents.document.publish', { documentKey: 'marketing' }, { reason: 'suite: regular publication with the default effective date' });
      const eff = pubCmd.json?.data?.result?.effectiveFrom;
      check('публикация по умолчанию: дата вступления ≈ +10 дней', pubCmd.ok && Math.abs(new Date(eff).getTime() - (Date.now() + 10 * 86400_000)) < 120_000, `${pubCmd.status} ${codeOf(pubCmd)} ${eff}`);
      // Срочная правка не ждёт плановую: новая публикация ОТЗЫВАЕТ ещё не вступившую версию (withdrawn)
      const urgentPub = await call('POST', '/consents/dev/publish', s1.token, { documentKey: 'marketing', effectiveInSec: 0, material: false });
      const afterUrgent = await call('GET', '/platform/consents/documents', pt);
      const plannedRow = (afterUrgent.json?.data?.versions ?? []).find((v) => v.versionId === pubCmd.json?.data?.result?.versionId);
      const currentMk = await call('GET', '/consents/documents/marketing');
      check('новая публикация отзывает ещё не вступившую версию (withdrawn), действующей становится срочная', urgentPub.ok && plannedRow?.status === 'withdrawn' && currentMk.json?.data?.versionId === urgentPub.json?.data?.versionId, `${urgentPub.status} ${codeOf(urgentPub)} ${plannedRow?.status}`);
      const listed = await call('GET', '/platform/consents/documents', pt);
      check('чтение кабинета: версии без текста + охват принятия', listed.ok && listed.json.data.versions.some((v) => v.versionId === pubCmd.json?.data?.result?.versionId) && listed.json.data.coverage.some((c) => c.documentKey === 'terms' && c.population > 0) && !JSON.stringify(listed.json.data).includes('"bodies"'));
      const productToken = await call('GET', '/platform/consents/documents', s1.token);
      check('продуктовый токен чтения кабинета не открывает', productToken.status === 401, `${productToken.status}`);
      const s2me = await call('GET', '/users/me', s2.token);
      const attest = await run('consents.document.attest', { versionId: docs.ru.versionId, signerUserId: s2me.json.data.id }, { reason: 'suite: certification of a version by the digital signature of the head' });
      if (attest.ok) check('команда consents.document.attest: заявка на ЭЦП заведена через core/sign', !!attest.json.data.result?.signRequestId, JSON.stringify(attest.json.data.result));
      else if (attest.code === 'consents.pdfUnavailable') skip('заверение ЭЦП', 'печать в PDF выключена (GOTENBERG_URL)');
      else check('команда consents.document.attest', false, `${attest.status} ${codeOf(attest)}`);
      const incOpen = await run('pd.incident.open', { kind: 'other', scope: 'e2e: команда кабинета', summary: 'Учебный инцидент, открытый командой кабинета платформы.' }, { reason: 'suite: incident register drill' });
      const incList = await call('GET', '/platform/consents/incidents', pt);
      check('pd.incident.open командой + журнал инцидентов в кабинете', incOpen.ok && incList.ok && incList.json.data.some((i) => i.id === incOpen.json.data.result?.incidentId), `${incOpen.status} ${codeOf(incOpen)}`);
      const incClose = await run('pd.incident.close', { incidentId: incOpen.json?.data?.result?.incidentId, note: 'suite' }, { reason: 'suite: closing the drill incident' });
      check('pd.incident.close командой', incClose.ok && incClose.json.data.result?.status === 'closed', `${incClose.status} ${codeOf(incClose)}`);
      await call('POST', '/platform/auth/logout', pt, {});
    }
  } catch (e) { skip('кабинет платформы', e.message.slice(0, 200)); }

  // ------------------------------------------------------------------
  console.log('\n[11] Уборка: никто не остаётся за шлюзом');
  let cleaned = 0;
  for (const phone of [SUITE.p1, SUITE.p2, SUITE.p3, ...HUMANS]) {
    try {
      const s = await login(phone);
      const r = await acceptAllPending(BASE, s.token);
      if (r.ok) cleaned++;
    } catch { /* аккаунта нет — сид не запускали */ }
  }
  check('аккаунты сьюта и человека приняли новые версии', cleaned >= 3, `${cleaned}`);
  const finalGate = await call('GET', '/tasks', (await login(SUITE.p1)).token);
  check('suite1 работает', finalGate.ok, `${finalGate.status}`);

  if (prisma) await prisma.$disconnect();
  console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error('FATAL', e); if (prisma) await prisma.$disconnect().catch(() => undefined); process.exit(1); });
