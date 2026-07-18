/* eslint-disable */
// Движок звонков (core/calls) — e2e генерик-части БЕЗ живого LiveKit-сервера:
// статус/инертность, 400 на неизвестный refType, вебхук (401 без/с мусорной подписью,
// 200 идемпотентный no-op с ВАЛИДНОЙ подписью — скрипт подписывает сам, подпись локальная),
// алиас /api/v1 покрыт raw-парсером. Комнатные проверки с резолвером — verify-office.cjs.
// Run: node scripts/verify-calls.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const crypto = require('crypto');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => (await call('POST', '/auth/login', null, { phone, password: PW })).json.data.accessToken;

async function postWebhook(url, rawBody, authHeader) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/webhook+json', ...(authHeader ? { Authorization: authHeader } : {}) },
    body: rawBody,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function main() {
  const t1 = await login(P1);

  // ---------- 0. Статус / инертность ----------
  const status = await call('GET', '/calls/status', t1);
  check('GET /calls/status отвечает', status.ok, `status ${status.status}`);
  const enabled = !!status.json?.data?.enabled;
  if (!enabled) {
    const tok = await call('POST', '/calls/token', t1, { refType: 'office_room', refId: crypto.randomUUID() });
    check('движок выключен → POST /calls/token 400', tok.status === 400, `status ${tok.status}`);
    console.log('\nLIVEKIT_* не заданы — остальные проверки SKIP.');
    process.exit(fails === 0 ? 0 : 1);
  }
  check('status.wsUrl задан', typeof status.json.data.wsUrl === 'string' && status.json.data.wsUrl.startsWith('ws'), String(status.json.data.wsUrl));

  // ---------- 1. Неизвестный refType → 400 ----------
  const unknown = await call('POST', '/calls/token', t1, { refType: 'nope', refId: 'x' });
  check('неизвестный refType → 400', unknown.status === 400, `status ${unknown.status}`);

  // ---------- 2. Вебхук: подпись обязательна ----------
  const body = JSON.stringify({ event: 'room_finished', id: 'evt_verify', room: { name: 'call_00000000-0000-0000-0000-000000000000' } });
  const noAuth = await postWebhook(`${BASE}/calls/livekit/webhook`, body, null);
  check('вебхук без Authorization → 401', noAuth.status === 401, `status ${noAuth.status}`);
  const badAuth = await postWebhook(`${BASE}/calls/livekit/webhook`, body, 'garbage.jwt.here');
  check('вебхук с мусорной подписью → 401', badAuth.status === 401, `status ${badAuth.status}`);

  // ---------- 3. Валидная подпись (сами подписываем, как сервер LiveKit) ----------
  const { AccessToken } = require('livekit-server-sdk');
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { ttl: 600 });
  at.sha256 = crypto.createHash('sha256').update(body).digest('base64');
  const jwt = await at.toJwt();
  const okHook = await postWebhook(`${BASE}/calls/livekit/webhook`, body, jwt);
  check('валидная подпись, незнакомая комната → 200 no-op', okHook.status === 200, `status ${okHook.status} ${JSON.stringify(okHook.json)}`);
  const okHook2 = await postWebhook(`${BASE}/calls/livekit/webhook`, body, jwt);
  check('повторная доставка → 200 (идемпотентно)', okHook2.status === 200, `status ${okHook2.status}`);

  // ---------- 4. Легаси-алиас /api/v1 (raw-парсер стоит ПОСЛЕ rewrite — оба префикса) ----------
  const v1 = await postWebhook('http://localhost:3001/api/v1/calls/livekit/webhook', body, jwt);
  check('вебхук на /api/v1 → 200 (alias покрыт)', v1.status === 200, `status ${v1.status}`);

  console.log(fails === 0 ? '\nALL PASS' : `\nFAILS: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
