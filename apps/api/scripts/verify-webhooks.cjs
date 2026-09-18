/* eslint-disable */
// E2E: core/webhooks — исходящие вебхуки (23-й движок). Сьют поднимает приёмник на
// 127.0.0.1 (API в development с WEBHOOKS_DEV_LOOPBACK=true доставляет на loopback) и
// проверяет: каталог событий; создание endpoint'а (секрет `sa6_whs_…` show-once, пинг →
// active); подпись Standard Webhooks (webhook-id/timestamp/signature, `v1,` HMAC по
// `id.ts.body`); событие `tasks.task.created` доставляется при создании задачи в
// организации; провал приёмника → доставка failed, ручной probe → active; ротация секрета —
// две подписи `v1,` (новый + prev), обе проверяются; Ed25519 endpoint — `v1a,` проверяется
// публичным ключом; повторная доставка; аудит битой подписью: приёмник, принявший битую
// подпись, отключается (`signature_audit`) с уведомлением; owner/admin-гейт и step-up;
// реестр ключей показывает endpoint строкой `webhook`; журнал.
// Ревью 2026-09-19: адрес отвергается у формы (логин/пароль, приватные сети, метаданные);
// `tasks.task.completed` уходит на ГЛАВНОМ пути (сдал → постановщик принял) ровно один раз
// и не уходит на сдаче; двойное «Готово» личной задачи организации — одно событие; пачка
// пингов не копит доставки; «Повторить» у ждущей ретрая доставки шлёт сразу, а не после
// чужого бэкоффа; исчерпанный пинг → disabled/verification; автоотключение = порог штук И
// возраст серии; предохранитель мёртвого адреса откладывает без сети; включение проходит
// потолок тарифа (обход «выключил → создал → включил» закрыт); потолок ручных действий.
// Run: node apps/api/scripts/verify-webhooks.cjs
const { SUITE, call, login, makeChecker, devCode, consoleLogin, consoleSudo } = require('./_lib.cjs');
const { randomUUID } = require('crypto');
const http = require('http');
const { createHmac, createPublicKey, verify: cryptoVerify } = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Приёмник: копит запросы, отвечает по режиму (200 | 500 | «принимаю всё, подписи не смотрю»). */
function startReceiver() {
  const state = { mode: 'ok', received: [], verify: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const entry = { headers: req.headers, body, at: Date.now() };
      state.received.push(entry);
      if (state.mode === 'fail') {
        res.writeHead(500);
        return res.end('boom');
      }
      if (state.mode === 'verify' && state.verify) {
        const ok = state.verify(req.headers, body);
        res.writeHead(ok ? 200 : 401);
        return res.end(ok ? 'ok' : 'bad signature');
      }
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

/** Проверка Standard Webhooks на стороне приёмника (референс из docs/webhooks_engine.md). */
function verifyStd(headers, body, { secrets = [], ed25519PublicKeyRaw = null, toleranceSec = 300 } = {}) {
  const id = headers['webhook-id'];
  const ts = Number(headers['webhook-timestamp']);
  const sig = headers['webhook-signature'];
  if (!id || !Number.isFinite(ts) || !sig) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return false;
  const content = `${id}.${ts}.${body}`;
  for (const part of sig.split(' ')) {
    const [v, value] = part.split(',');
    if (v === 'v1') {
      for (const s of secrets) {
        const expected = createHmac('sha256', Buffer.from(s, 'utf8')).update(content).digest('base64');
        if (expected === value) return true;
      }
    } else if (v === 'v1a' && ed25519PublicKeyRaw) {
      // raw 32 байта → SPKI DER (префикс Ed25519)
      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(ed25519PublicKeyRaw, 'base64')]);
      const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
      if (cryptoVerify(null, Buffer.from(content), key, Buffer.from(value, 'base64'))) return true;
    }
  }
  return false;
}

async function waitFor(fn, { timeoutMs = 20000, stepMs = 400 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(stepMs);
  }
}

async function main() {
  const { check, finish } = makeChecker();
  const s1 = await login(SUITE.p1);
  const s2 = await login(SUITE.p2);
  const { server, state, port } = await startReceiver();
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const stepUp = async (s) => {
    const st = await call('POST', '/verify/step-up', s.token, { purpose: 'keys_manage', password: SUITE.password });
    if (!st.ok) return st;
    const code = await devCode(st.json.data.challengeId);
    const chk = await call('POST', '/verify/check', null, { challengeId: st.json.data.challengeId, code });
    if (!chk.ok) return chk;
    return call('POST', '/keys/step-up/confirm', s.token, { verifyToken: chk.json.data.verifyToken });
  };

  try {
    const ws = await call('POST', '/workspaces', s1.token, { name: `wh-${Date.now()}` });
    check('workspace created', ws.ok, ws.status);
    const W = ws.json?.data?.id;
    const WSH = { 'X-Workspace-Id': W };
    const base = `/workspaces/${W}/webhooks/endpoints`;
    const deliveriesOf = async (id) => (await call('GET', `${base}/${id}/deliveries`, s1.token)).json?.data?.items ?? [];

    // ---- Каталог ----
    const cat = await call('GET', '/webhooks/events', s1.token);
    check('GET /webhooks/events: services with events', cat.ok && cat.json.data.services.some((s) => s.service === 'tasks' && s.events.some((e) => e.key === 'tasks.task.created' && e.version === 1)), JSON.stringify(cat.json).slice(0, 120));

    // ---- Гейты ----
    const noRole = await call('GET', base, s2.token);
    check('endpoints: non-member → 403 keys.role_required', noRole.status === 403 && noRole.code === 'keys.role_required', `${noRole.status} ${noRole.code}`);
    await call('POST', '/keys/step-up/end', s1.token, {});
    const noStep = await call('POST', base, s1.token, { url: url('/hook'), events: ['tasks.task.created'] });
    check('create without step-up → 403 keys.step_up_required', noStep.status === 403 && noStep.code === 'keys.step_up_required', `${noStep.status} ${noStep.code}`);
    const su = await stepUp(s1);
    check('step-up window opened', su.ok, su.status);
    const badUrl = await call('POST', base, s1.token, { url: 'http://example.com/hook', events: ['tasks.task.created'] });
    check('plain http (non-loopback) → 400', badUrl.status === 400, `${badUrl.status} ${badUrl.code}`);
    const badEvent = await call('POST', base, s1.token, { url: url('/hook'), events: ['tasks.task.nope'] });
    check('unknown event → 400', badEvent.status === 400, badEvent.status);
    for (const [label, bad] of [
      ['credentials in the url', 'https://user:pass@example.com/hook'],
      ['private IP literal', 'https://10.0.0.5/hook'],
      ['loopback over https', 'https://127.0.0.1/hook'],
      ['internal name', 'https://db.internal/hook'],
      ['cloud metadata', 'https://169.254.169.254/latest'],
      ['decimal-encoded loopback', 'https://2130706433/hook'],
    ]) {
      const r = await call('POST', base, s1.token, { url: bad, events: ['tasks.task.created'] });
      check(`url rejected at the form: ${label} → 400 keys.webhook.url_rejected`, r.status === 400 && r.code === 'keys.webhook.url_rejected', `${r.status} ${r.code}`);
    }

    // ---- Создание: секрет show-once, пинг → active ----
    const created = await call('POST', base, s1.token, { url: url('/hook'), events: ['tasks.task.created', 'tasks.task.completed'], signing: 'hmac' });
    check('endpoint created (201) with a show-once secret', created.status === 201 && /^sa6_whs_test_[0-9A-Za-z]{43}_[0-9A-Za-z]{6}$/.test(created.json?.data?.secret ?? ''), `${created.status} ${created.json?.data?.secret?.slice(0, 16)}`);
    const secret = created.json?.data?.secret;
    const ep = created.json?.data?.endpoint;
    check('endpoint starts pending_verification', ep?.status === 'pending_verification', ep?.status);
    check('DTO never carries the secret', !JSON.stringify(ep).includes(secret.slice(15, 30)));
    const ping = await waitFor(async () => state.received.find((r) => JSON.parse(r.body).type === 'webhook.ping'));
    check('verification ping delivered to the receiver', !!ping, `received=${state.received.length}`);
    if (ping) {
      check('ping carries Standard Webhooks headers', !!ping.headers['webhook-id'] && !!ping.headers['webhook-timestamp'] && /^v1,/.test(ping.headers['webhook-signature'] ?? ''), JSON.stringify({ id: ping.headers['webhook-id'], sig: (ping.headers['webhook-signature'] ?? '').slice(0, 12) }));
      check('ping signature verifies with the secret (HMAC over id.ts.body)', verifyStd(ping.headers, ping.body, { secrets: [secret] }));
      check('tampered body does not verify', !verifyStd(ping.headers, ping.body + ' ', { secrets: [secret] }));
      check('wrong secret does not verify', !verifyStd(ping.headers, ping.body, { secrets: ['sa6_whs_test_x'] }));
      const pb = JSON.parse(ping.body);
      check('ping body: id msg_…, type, version, occurredAt, data.endpointId', /^msg_/.test(pb.id) && pb.version === 1 && pb.data?.endpointId === ep.id && pb.id === ping.headers['webhook-id']);
    }
    const active = await waitFor(async () => { const r = await call('GET', base, s1.token); const e = r.json?.data?.find((x) => x.id === ep.id); return e?.status === 'active' ? e : null; });
    check('endpoint became active after 2xx on the ping', !!active, active?.status);

    // ---- Событие продюсера: задача в организации ----
    state.received.length = 0;
    const task = await call('POST', '/tasks', s1.token, { title: 'webhook e2e task' }, WSH);
    check('task created in the workspace', task.status === 201, task.status);
    const ev = await waitFor(async () => state.received.find((r) => JSON.parse(r.body).type === 'tasks.task.created'));
    check('tasks.task.created delivered', !!ev, `received=${state.received.map((r) => JSON.parse(r.body).type).join(',')}`);
    if (ev) {
      const body = JSON.parse(ev.body);
      check('event data carries task id/title/status/workspaceId (no description)', body.data?.id === task.json.data.id && body.data?.title === 'webhook e2e task' && body.data?.workspaceId === W && !('description' in body.data));
      check('event signature verifies', verifyStd(ev.headers, ev.body, { secrets: [secret] }));
      check('user-agent identifies the platform', /SuperApp6-Webhooks/.test(ev.headers['user-agent'] ?? ''), ev.headers['user-agent']);
    }
    const personalTask = await call('POST', '/tasks', s1.token, { title: 'personal, no webhook' });
    await sleep(1500);
    check('personal task (no workspace) emits nothing', personalTask.ok && !state.received.some((r) => JSON.parse(r.body).data?.id === personalTask.json?.data?.id));
    // ---- «Задача завершена»: главный путь (сдал → постановщик принял) ----
    const typesOf = (id) => state.received.filter((r) => JSON.parse(r.body).data?.id === id).map((r) => JSON.parse(r.body).type);
    const invite = await call('POST', `/workspaces/${W}/invitations`, s1.token, { phone: SUITE.p2 });
    const incoming = await call('GET', '/workspaces/invitations/incoming', s2.token);
    const myInv = (incoming.json?.data ?? []).find((i) => i.workspaceId === W || i.workspace?.id === W);
    const accepted = await call('POST', `/workspaces/invitations/${myInv?.id}/accept`, s2.token);
    check('suite2 joined the workspace (executor for the acceptance flow)', invite.ok && accepted.ok, `${invite.status} ${accepted.status}`);
    const assigned = await call('POST', '/tasks', s1.token, { title: 'webhook e2e acceptance', executorId: s2.id }, WSH);
    check('task assigned to the employee', assigned.status === 201, `${assigned.status} ${assigned.json?.message ?? ''}`);
    const AT = assigned.json?.data?.id;
    const submitted = await call('POST', `/tasks/${AT}/submit`, s2.token, {}, WSH);
    check('executor submitted the work', submitted.ok, `${submitted.status} ${submitted.json?.message ?? ''}`);
    await sleep(2000);
    check('submit alone does NOT emit tasks.task.completed (the work is not accepted yet)', !typesOf(AT).includes('tasks.task.completed'), typesOf(AT).join(','));
    const acceptedWork = await call('POST', `/tasks/${AT}/accept`, s1.token, {}, WSH);
    check('creator accepted the work', acceptedWork.ok, `${acceptedWork.status} ${acceptedWork.json?.message ?? ''}`);
    const completedEv = await waitFor(async () => (typesOf(AT).includes('tasks.task.completed') ? true : null));
    check('tasks.task.completed delivered on the MAIN path (submit → accept)', !!completedEv, typesOf(AT).join(','));
    await sleep(1500);
    check('…exactly once', typesOf(AT).filter((t) => t === 'tasks.task.completed').length === 1, typesOf(AT).join(','));
    const doneBody = state.received.map((r) => JSON.parse(r.body)).find((b) => b.type === 'tasks.task.completed' && b.data?.id === AT);
    check('completed event carries status done', doneBody?.data?.status === 'done', doneBody?.data?.status);
    // Задача организации без исполнителей: двойное «Готово» — одно событие
    const selfTask = await call('POST', '/tasks', s1.token, { title: 'webhook e2e self' }, WSH);
    const ST = selfTask.json?.data?.id;
    await Promise.all([call('POST', `/tasks/${ST}/submit`, s1.token, {}, WSH), call('POST', `/tasks/${ST}/submit`, s1.token, {}, WSH)]);
    await waitFor(async () => (typesOf(ST).includes('tasks.task.completed') ? true : null));
    await sleep(1500);
    check('self-task: a double «done» emits tasks.task.completed exactly once', typesOf(ST).filter((t) => t === 'tasks.task.completed').length === 1, typesOf(ST).join(','));
    const dl = await waitFor(async () => { const d = await deliveriesOf(ep.id); return d.find((x) => x.eventKey === 'tasks.task.created' && x.status === 'delivered') ? d : null; });
    check('deliveries list shows the delivered event with HTTP 200', !!dl && dl.some((d) => d.eventKey === 'tasks.task.created' && d.lastStatus === 200 && d.attempts === 1), JSON.stringify(dl?.slice(0, 2)));

    // ---- Повторная доставка (тот же msg id) ----
    const delivered = dl?.find((d) => d.eventKey === 'tasks.task.created');
    state.received.length = 0;
    const re = await call('POST', `${base}/${ep.id}/deliveries/${delivered.id}/redeliver`, s1.token, {});
    check('redeliver accepted', re.ok, `${re.status} ${re.code}`);
    const again = await waitFor(async () => state.received.find((r) => JSON.parse(r.body).type === 'tasks.task.created'));
    check('redelivery arrives with the SAME webhook-id (receiver can dedupe)', !!again && again.headers['webhook-id'] === `msg_${delivered.id}`, `${again?.headers['webhook-id']} vs msg_${delivered.id}`);

    // ---- Провал приёмника: pending endpoint остаётся pending; probe руками → active ----
    state.mode = 'fail';
    state.received.length = 0;
    const ep2 = await call('POST', base, s1.token, { url: url('/hook2'), events: ['workspaces.member.joined'] });
    check('second endpoint created', ep2.status === 201, ep2.status);
    const failed = await waitFor(async () => { const d = await deliveriesOf(ep2.json.data.endpoint.id); return d.find((x) => x.eventKey === 'webhook.ping' && x.status === 'failed') ?? null; });
    check('ping to a failing receiver → delivery failed, HTTP 500, attempts 1', !!failed && failed.lastStatus === 500 && failed.attempts === 1, JSON.stringify(failed));
    const stillPending = (await call('GET', base, s1.token)).json?.data?.find((x) => x.id === ep2.json.data.endpoint.id);
    check('endpoint stays pending_verification', stillPending?.status === 'pending_verification', stillPending?.status);
    // Пачка «Пинг», пока живой пинг ждёт ретрая: новых доставок не копится
    for (let i = 0; i < 3; i++) await call('POST', `${base}/${ep2.json.data.endpoint.id}/probe`, s1.token, {});
    const pingRows = (await deliveriesOf(ep2.json.data.endpoint.id)).filter((x) => x.eventKey === 'webhook.ping');
    check('a burst of manual pings does not stack deliveries while one is alive', pingRows.length === 1, `pings=${pingRows.length}`);
    // «Повторить» у ждущей ретрая доставки: уходит СРАЗУ, а не после чужого 30-секундного бэкоффа
    state.mode = 'ok';
    state.received.length = 0;
    const t0 = Date.now();
    const rePing = await call('POST', `${base}/${ep2.json.data.endpoint.id}/deliveries/${failed.id}/redeliver`, s1.token, {});
    check('redeliver of a failed delivery accepted', rePing.ok, `${rePing.status} ${rePing.code}`);
    const fast = await waitFor(async () => state.received.find((r) => JSON.parse(r.body).type === 'webhook.ping'), { timeoutMs: 12000 });
    check('redelivery goes out at once (not after the pending 30 s backoff)', !!fast && Date.now() - t0 < 12000, `${Date.now() - t0} ms`);
    const probe = await call('POST', `${base}/${ep2.json.data.endpoint.id}/probe`, s1.token, {});
    check('manual probe accepted', probe.ok, probe.status);
    const active2 = await waitFor(async () => { const r = await call('GET', base, s1.token); const e = r.json?.data?.find((x) => x.id === ep2.json.data.endpoint.id); return e?.status === 'active' ? e : null; });
    check('endpoint active after a successful manual probe', !!active2, active2?.status);

    // ---- Ротация: две подписи, обе проверяются ----
    const rot = await call('POST', `${base}/${ep.id}/rotate-secret`, s1.token, { prevHours: 24 });
    check('rotate-secret → new secret shown once', rot.ok && /^sa6_whs_test_/.test(rot.json?.data?.secret ?? '') && rot.json.data.secret !== secret, `${rot.status} ${rot.code}`);
    const secret2 = rot.json?.data?.secret;
    check('DTO shows prevSecretUntil during the overlap', !!rot.json?.data?.endpoint?.prevSecretUntil);
    state.received.length = 0;
    await call('POST', `${base}/${ep.id}/probe`, s1.token, {});
    const p2 = await waitFor(async () => state.received.find((r) => { const b = JSON.parse(r.body); return b.type === 'webhook.ping' && b.data?.endpointId === ep.id; }));
    check('after rotation: two v1 signatures in the header', !!p2 && (p2.headers['webhook-signature'] ?? '').split(' ').filter((x) => x.startsWith('v1,')).length === 2, p2?.headers['webhook-signature']?.length);
    check('new secret verifies', !!p2 && verifyStd(p2.headers, p2.body, { secrets: [secret2] }));
    check('old secret still verifies during the overlap', !!p2 && verifyStd(p2.headers, p2.body, { secrets: [secret] }));

    // ---- Ed25519 endpoint ----
    state.received.length = 0;
    const ed = await call('POST', base, s1.token, { url: url('/hook-ed'), events: ['tasks.task.created'], signing: 'ed25519' });
    check('ed25519 endpoint created with a public key', ed.status === 201 && typeof ed.json?.data?.endpoint?.publicKey === 'string' && ed.json.data.endpoint.publicKey.length > 20, `${ed.status} ${ed.json?.data?.endpoint?.publicKey?.slice(0, 10)}`);
    const pe = await waitFor(async () => state.received.find((r) => r.headers['webhook-signature']?.includes('v1a,')));
    check('ed25519 ping carries v1a signature and verifies with the public key', !!pe && verifyStd(pe.headers, pe.body, { ed25519PublicKeyRaw: ed.json.data.endpoint.publicKey }));
    check('ed25519 signature fails on a tampered body', !!pe && !verifyStd(pe.headers, pe.body + 'x', { ed25519PublicKeyRaw: ed.json.data.endpoint.publicKey }));

    // ---- Аудит битой подписью: приёмник, принимающий всё → disabled ----
    // ep принимает всё (mode ok) → после probe с битой подписью отключается
    const audit = await call('POST', '/keys/dev/webhooks/probe', s1.token, { endpointId: ep.id });
    check('dev bogus-signature probe ran', audit.ok, audit.status);
    const disabled = (await call('GET', base, s1.token)).json?.data?.find((x) => x.id === ep.id);
    check('receiver that accepts a bogus signature → disabled (signature_audit)', disabled?.status === 'disabled' && disabled?.disabledReason === 'signature_audit', `${disabled?.status} ${disabled?.disabledReason}`);
    let notif = null;
    for (let i = 0; i < 16; i++) {
      notif = await call('GET', '/notifications?limit=20', s1.token, undefined, WSH);
      if ((notif.json?.data?.items ?? []).some((n) => n.type === 'webhook.endpoint.disabled')) break;
      await sleep(500);
    }
    check('webhook.endpoint.disabled notification reached the owner', (notif?.json?.data?.items ?? []).some((n) => n.type === 'webhook.endpoint.disabled'), (notif?.json?.data?.items ?? []).map((n) => n.type).slice(0, 6).join(','));
    // Приёмник, проверяющий подписи, аудит проходит
    state.mode = 'verify';
    state.verify = (h, b) => verifyStd(h, b, { secrets: [secret2] });
    const audit2 = await call('POST', '/keys/dev/webhooks/probe', s1.token, { endpointId: ep2.json.data.endpoint.id });
    // ep2 подписан своим секретом — проверка ep2-секретом невозможна, проверяем только что endpoint не отключён «случайно»
    const ep2After = (await call('GET', base, s1.token)).json?.data?.find((x) => x.id === ep2.json.data.endpoint.id);
    check('receiver rejecting a bogus signature stays active', audit2.ok && ep2After?.status === 'active', `${ep2After?.status} ${ep2After?.disabledReason}`);
    state.mode = 'ok';

    // Отключённый endpoint ничего не получает
    state.received.length = 0;
    const t2 = await call('POST', '/tasks', s1.token, { title: 'after disable' }, WSH);
    await sleep(2000);
    // Приёмник общий: ed25519-endpoint тоже подписан на задачи — отличаем доставки ep по его HMAC-секрету
    check('disabled endpoint receives nothing (only the ed25519 endpoint gets the task)', t2.ok && !state.received.some((r) => JSON.parse(r.body).data?.id === t2.json?.data?.id && verifyStd(r.headers, r.body, { secrets: [secret2] })));
    // Включение руками → снова проверка адреса
    const enable = await call('PATCH', `${base}/${ep.id}`, s1.token, { enabled: true });
    check('enable → pending_verification again (ping re-sent)', enable.ok && enable.json?.data?.status === 'pending_verification', `${enable.status} ${enable.json?.data?.status}`);
    const reActive = await waitFor(async () => { const r = await call('GET', base, s1.token); const e = r.json?.data?.find((x) => x.id === ep.id); return e?.status === 'active' ? e : null; });
    check('endpoint active again after the ping', !!reActive);
    const disable = await call('PATCH', `${base}/${ep.id}`, s1.token, { enabled: false });
    check('manual disable → disabled/manual', disable.ok && disable.json?.data?.status === 'disabled' && disable.json?.data?.disabledReason === 'manual');

    // ---- Учения (дев-полигон): правила времени за секунды ----
    const drill = (path, body) => call('POST', `/keys/dev/webhooks/${path}`, s1.token, body);
    const epOf = async (id) => (await call('GET', base, s1.token)).json?.data?.find((x) => x.id === id);

    // Исчерпанный пинг → disabled/verification (а не вечное «ждёт проверки»)
    state.mode = 'fail';
    const ep3 = await call('POST', base, s1.token, { url: url('/hook3'), events: ['tasks.task.created'] });
    const E3 = ep3.json?.data?.endpoint?.id;
    const ping3 = await waitFor(async () => (await deliveriesOf(E3)).find((x) => x.eventKey === 'webhook.ping' && x.status === 'failed') ?? null);
    check('drill: ping of a failing receiver is waiting for a retry', !!ping3, JSON.stringify(ping3));
    const lastPing = await drill('deliver', { deliveryId: ping3.id, attempt: 6, maxAttempts: 6 });
    check('drill: the LAST ping attempt ran', lastPing.ok && lastPing.json?.data?.outcome === 'done', JSON.stringify(lastPing.json?.data));
    const e3 = await epOf(E3);
    check('exhausted verification ping → disabled/verification', e3?.status === 'disabled' && e3?.disabledReason === 'verification', `${e3?.status} ${e3?.disabledReason}`);

    // Автоотключение: порог штук И возраст серии. ed25519-endpoint активен и подписан на задачи
    const ED = ed.json.data.endpoint.id;
    await drill('streak', { endpointId: ED, failures: 0, failingHours: 0 });
    const failTask = await call('POST', '/tasks', s1.token, { title: 'webhook e2e failing' }, WSH);
    const failRow = await waitFor(async () => (await deliveriesOf(ED)).find((x) => x.eventKey === 'tasks.task.created' && x.status === 'failed') ?? null);
    check('drill: an event delivery to the failing receiver is waiting for a retry', failTask.ok && !!failRow, JSON.stringify(failRow));
    await drill('streak', { endpointId: ED, failures: 80, failingHours: 1 });
    const young = await drill('deliver', { deliveryId: failRow.id, attempt: 2 });
    const eYoung = await epOf(ED);
    check('80 failures in a row but the streak is 1 hour old → still active (count alone is not enough)', young.json?.data?.outcome === 'retry' && eYoung?.status === 'active' && eYoung?.failures === 81, `${young.json?.data?.outcome} ${eYoung?.status} ${eYoung?.failures}`);

    // Предохранитель: серия ≥ 5 и свежий провал → доставка откладывается БЕЗ похода в сеть
    state.received.length = 0;
    const snoozed = await drill('deliver', { deliveryId: failRow.id, attempt: 3 });
    check('circuit breaker: delivery is snoozed, no network call', snoozed.json?.data?.outcome === 'snoozed' && snoozed.json.data.delayMs > 0 && state.received.length === 0, `${JSON.stringify(snoozed.json?.data)} received=${state.received.length}`);
    const afterSnooze = await epOf(ED);
    check('…and a snooze does not count as a failure', afterSnooze?.failures === 81, afterSnooze?.failures);
    // Пауза прошла → ОДНА пробная доставка идёт в сеть, вторая подряд снова ждёт
    await drill('streak', { endpointId: ED, failures: 80, failingHours: 1, lastFailureSecAgo: 3600 });
    const trial = await drill('deliver', { deliveryId: failRow.id, attempt: 3 });
    const second = await drill('deliver', { deliveryId: failRow.id, attempt: 3 });
    check('circuit breaker: one trial per pause goes out, the next one waits', trial.json?.data?.outcome === 'retry' && second.json?.data?.outcome === 'snoozed' && state.received.length === 1, `${trial.json?.data?.outcome} ${second.json?.data?.outcome} received=${state.received.length}`);

    // Серия и длинная, и долгая → disabled/failures
    await drill('streak', { endpointId: ED, failures: 80, failingHours: 25, lastFailureSecAgo: 3600 });
    const old = await drill('deliver', { deliveryId: failRow.id, attempt: 4 });
    const eOld = await epOf(ED);
    check('80 failures AND a 25-hour streak → disabled/failures', old.ok && eOld?.status === 'disabled' && eOld?.disabledReason === 'failures', `${eOld?.status} ${eOld?.disabledReason}`);
    // Успех обнуляет серию целиком
    state.mode = 'ok';
    const reEnable = await call('PATCH', `${base}/${ED}`, s1.token, { enabled: true });
    const edActive = await waitFor(async () => { const e = await epOf(ED); return e?.status === 'active' ? e : null; });
    check('re-enabled endpoint is verified again and its streak is reset', reEnable.ok && !!edActive && edActive.failures === 0, `${reEnable.status} ${edActive?.status} ${edActive?.failures}`);

    // Потолок ручных действий на endpoint в час
    let limited = null;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await call('POST', `${base}/${ED}/probe`, s1.token, {});
      if (r.status === 429) limited = r;
    }
    check('manual pings are capped per endpoint per hour → 429 keys.webhook.tooManyManual', limited?.code === 'keys.webhook.tooManyManual', `${limited?.status} ${limited?.code}`);

    // ---- Кабинет платформы: стоп-кран, который организация не снимает сама ----
    const con = await consoleLogin(SUITE.p1);
    if (!con.token) {
      check('platform console login (suite1 is platform staff)', false, `${con.start?.status} ${con.login?.status}`);
    } else {
      const PT = con.token;
      const sudo = await consoleSudo(PT);
      check('console sudo window for high-risk commands', sudo.ok, sudo.status);
      const cmd = (key, input, reason) => call('POST', `/platform/commands/${key}`, PT, { input, idempotencyKey: randomUUID(), reason });
      const E2 = ep2.json.data.endpoint.id;
      const lock = await cmd('webhooks.endpoint.disable', { endpointId: E2 }, 'suite: abuse drill — platform lock');
      check('platform command webhooks.endpoint.disable', lock.ok, `${lock.status} ${JSON.stringify(lock.json?.details ?? lock.json?.data?.status ?? '')}`);
      const locked = await epOf(E2);
      check('endpoint → disabled/platform', locked?.status === 'disabled' && locked?.disabledReason === 'platform', `${locked?.status} ${locked?.disabledReason}`);
      const selfEnable = await call('PATCH', `${base}/${E2}`, s1.token, { enabled: true });
      check('organization cannot lift the platform lock → 409 keys.webhook.platformDisabled', selfEnable.status === 409 && selfEnable.code === 'keys.webhook.platformDisabled', `${selfEnable.status} ${selfEnable.code}`);
      // ep отключён организацией (manual) — замок платформы ложится ПОВЕРХ, иначе админ включит его сам
      const relock = await cmd('webhooks.endpoint.disable', { endpointId: ep.id }, 'suite: lock over a manual disable');
      const relocked = await epOf(ep.id);
      check('platform lock goes over a manual disable', relock.ok && relocked?.disabledReason === 'platform', `${relock.status} ${relocked?.disabledReason}`);
      const wrongEnable = await cmd('webhooks.endpoint.enable', { endpointId: ED }, 'suite: not platform-disabled');
      check('console enables only ITS OWN lock → 409 keys.webhook.notPlatformDisabled', wrongEnable.status === 409 && wrongEnable.code === 'keys.webhook.notPlatformDisabled', `${wrongEnable.status} ${wrongEnable.code}`);
      const unlock = await cmd('webhooks.endpoint.enable', { endpointId: E2 }, 'suite: lift the platform lock');
      const back = await waitFor(async () => { const e = await epOf(E2); return e?.status === 'active' ? e : null; });
      check('console lifts the lock → verified by a ping → active', unlock.ok && !!back, `${unlock.status} ${back?.status}`);
      const panel = await call('GET', `/platform/entities/workspace/${W}/panels/workspace.webhooks`, PT);
      const rowsP = panel.json?.data?.data?.endpoints ?? panel.json?.data?.endpoints ?? [];
      check('console panel lists endpoints without query strings and without secrets', panel.ok && rowsP.length >= 3 && rowsP.every((r) => !String(r.url).includes('?')) && !JSON.stringify(panel.json).includes('sa6_whs_'), `${panel.status} rows=${rowsP.length}`);
    }

    // Тариф: включение проходит тот же потолок, что и создание (free = 5 живых)
    const ws2 = await call('POST', '/workspaces', s1.token, { name: `wh-cap-${Date.now()}` });
    const W2 = ws2.json?.data?.id;
    const base2 = `/workspaces/${W2}/webhooks/endpoints`;
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await call('POST', base2, s1.token, { url: url(`/cap${i}`), events: ['tasks.task.created'] }));
    check('five endpoints fit the free plan', made.every((m) => m.status === 201), made.map((m) => m.status).join(','));
    const sixth = await call('POST', base2, s1.token, { url: url('/cap5'), events: ['tasks.task.created'] });
    check('the sixth → 402 entitlement.limit_reached', sixth.status === 402 && sixth.code === 'entitlement.limit_reached', `${sixth.status} ${sixth.code}`);
    const off = await call('PATCH', `${base2}/${made[0].json.data.endpoint.id}`, s1.token, { enabled: false });
    const sixthAgain = await call('POST', base2, s1.token, { url: url('/cap5'), events: ['tasks.task.created'] });
    check('after disabling one, a new one fits', off.ok && sixthAgain.status === 201, `${off.status} ${sixthAgain.status}`);
    const sneak = await call('PATCH', `${base2}/${made[0].json.data.endpoint.id}`, s1.token, { enabled: true });
    check('enabling the disabled one over the cap → 402 (disable → create → enable bypass is closed)', sneak.status === 402 && sneak.code === 'entitlement.limit_reached', `${sneak.status} ${sneak.code}`);
    await call('DELETE', `/workspaces/${W2}`, s1.token).catch(() => undefined);

    // ---- Реестр и журнал ----
    const reg = await call('GET', `/workspaces/${W}/keys/registry?kind=webhook`, s1.token);
    check('key registry lists endpoints as webhook rows', reg.ok && reg.json.data.items.some((r) => r.kind === 'webhook' && r.id === ep.id && r.status === 'disabled'), JSON.stringify(reg.json?.data?.items?.map((r) => [r.kind, r.status])));
    const journal = await call('GET', `/workspaces/${W}/keys/journal?subjectType=webhook_endpoint`, s1.token);
    const actions = new Set((journal.json?.data?.items ?? []).map((e) => e.action));
    check('journal: created, verified, secret_rotated, disabled, enabled', ['webhook.endpoint.created', 'webhook.endpoint.verified', 'webhook.endpoint.secret_rotated', 'webhook.endpoint.disabled', 'webhook.endpoint.enabled'].every((a) => actions.has(a)), [...actions].join(','));
    const ent = await call('GET', '/entitlements/me', s1.token, undefined, WSH);
    check('entitlements expose webhooks.maxEndpoints', ent.ok && JSON.stringify(ent.json).includes('webhooks.maxEndpoints'));

    // ---- Удаление ----
    const del = await call('DELETE', `${base}/${ed.json.data.endpoint.id}`, s1.token);
    check('endpoint deleted', del.ok, del.status);
    const gone = (await call('GET', base, s1.token)).json?.data?.some((x) => x.id === ed.json.data.endpoint.id);
    check('deleted endpoint is gone from the list', gone === false);

    await call('DELETE', `/workspaces/${W}`, s1.token).catch(() => undefined);
  } finally {
    server.close();
  }
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
