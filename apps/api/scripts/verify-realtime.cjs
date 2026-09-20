// Realtime уведомлений через общий сокет платформы `/realtime` (core/realtime):
// `notification:new` приходит адресату и НЕ приходит актору; `notification:counts`
// прилетает после POST /notifications/seen; события мессенджера продолжают идти тем
// же сокетом (регресс после выделения движка). Отзыв сессии → verify-logout-socket.cjs.
// Требует API на :3001 (development — нужна dev-ручка /notifications/dev/send) и
// аккаунты сьюта. socket.io-client берётся из apps/web/node_modules.
const path = require('path');
const BASE = process.env.API_URL || 'http://localhost:3001/api';
const ORIGIN = BASE.replace(/\/api\/?$/, '');

let io;
try {
  io = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client')).io;
} catch (e) {
  console.error('socket.io-client not found in apps/web/node_modules', e.message);
  process.exit(1);
}

const CREDS = {
  s1: { phone: '+77009990001', password: 'Test1234!' },
  s2: { phone: '+77009990002', password: 'Test1234!' },
};

async function http(method, p, { token, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': require('crypto').randomUUID(), 'X-Locale': process.env.SA6_SUITE_LOCALE || 'ru', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  let j; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t }; }
  return { status: res.status, ok: res.ok, json: j };
}
async function login(c) {
  const { json } = await http('POST', '/auth/login', { body: c });
  const token = json.data.accessToken;
  const me = await http('GET', '/users/me', { token });
  return { token, id: me.json.data.id };
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const sock = io(`${ORIGIN}/realtime`, { auth: { token }, transports: ['websocket'], reconnection: false });
    sock.on('connect', () => resolve(sock));
    sock.on('connect_error', (e) => reject(new Error('connect_error: ' + e.message)));
    setTimeout(() => reject(new Error('socket connect timeout')), 8000);
  });
}
function waitFor(sock, event, pred, ms = 8000) {
  return new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), ms);
    sock.on(event, (payload) => { if (!pred || pred(payload)) { clearTimeout(to); resolve(payload); } });
  });
}

let passed = 0, failed = 0;
const check = (n, c, extra) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${extra ? ' — ' + extra : ''}`); } };

async function main() {
  const s1 = await login(CREDS.s1);
  const s2 = await login(CREDS.s2);
  console.log('logged in s1, s2');
  const sock1 = await connect(s1.token);
  const sock2 = await connect(s2.token);
  check('s1 socket connected (/realtime)', sock1.connected);
  check('s2 socket connected (/realtime)', sock2.connected);

  // 1) s1 шлёт событие адресату s2 (актор = s1 по умолчанию).
  const tag = `rt-${Date.now()}`;
  const newOn2 = waitFor(sock2, 'notification:new', (p) => p?.type === 'task.assigned');
  const newOn1 = waitFor(sock1, 'notification:new', (p) => p?.type === 'task.assigned', 4000);
  const sent = await http('POST', '/notifications/dev/send', {
    token: s1.token,
    body: { type: 'task.assigned', to: [s2.id], payload: { taskTitle: tag, tag }, idempotencyKey: `verify-realtime:${tag}` },
  });
  check('dev/send принят', sent.ok && !!sent.json?.data?.eventId, `${sent.status} ${JSON.stringify(sent.json).slice(0, 160)}`);
  const got = await newOn2;
  check('адресат получил notification:new по сокету', !!got, JSON.stringify(got));
  check('в событии есть notificationId, context и unseen', !!got?.notificationId && typeof got?.context === 'string' && typeof got?.unseen === 'boolean', JSON.stringify(got));
  const gotActor = await newOn1;
  check('актору notification:new НЕ приходит', gotActor === null, JSON.stringify(gotActor));

  // 2) seen у адресата → notification:counts тем же сокетом.
  const countsOn2 = waitFor(sock2, 'notification:counts', () => true, 6000);
  const seen = await http('POST', '/notifications/seen', { token: s2.token, body: { ids: got?.notificationId ? [got.notificationId] : [] } });
  check('POST /notifications/seen 200', seen.ok, `${seen.status}`);
  const counts = await countsOn2;
  check('адресат получил notification:counts после seen', !!counts, JSON.stringify(counts));
  const after = await http('GET', '/notifications/counts', { token: s2.token });
  check('counts.unseen — число', typeof after.json?.data?.unseen === 'number', JSON.stringify(after.json?.data));

  // 3) Регресс мессенджера: сообщение по REST доезжает адресату тем же сокетом.
  const dm = await http('POST', '/messenger/chats/dm', { token: s1.token, body: { userId: s2.id } });
  const chatId = dm.json?.data?.id;
  check('DM открыт', !!chatId, `${dm.status}`);
  if (chatId) {
    const msgOn2 = waitFor(sock2, 'message:new', (p) => p?.chatId === chatId);
    const msg = await http('POST', `/messenger/chats/${chatId}/messages`, { token: s1.token, body: { content: `realtime regress ${tag}` } });
    const m = await msgOn2;
    check('message:new мессенджера идёт через /realtime', !!m && m?.message?.content === msg.json?.data?.content, JSON.stringify(m).slice(0, 160));
  }

  sock1.close(); sock2.close();
  console.log(`\nRESULT ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
