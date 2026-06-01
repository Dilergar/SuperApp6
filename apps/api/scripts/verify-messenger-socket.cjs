// Realtime smoke test for the messenger socket.io gateway.
// Proves a REST-sent message is PUSHED over the WebSocket to the recipient,
// that read receipts flow back to the sender live, and that edits push too.
// Requires the API running on 3001 + seeded testers. socket.io-client is taken
// from the web app's node_modules (not present at repo root under pnpm).
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
  t1: { phone: '+77001234567', password: 'Test1234!' },
  t2: { phone: '+77012345678', password: 'Test1234!' },
};

async function http(method, p, { token, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  let j; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t }; }
  return { status: res.status, json: j };
}
async function login(c) {
  const { json } = await http('POST', '/auth/login', { body: c });
  const token = json.data.accessToken;
  const me = await http('GET', '/users/me', { token });
  return { token, id: me.json.data.id };
}
async function ensureContact(tokenA, tokenB, phoneB) {
  const { json: contacts } = await http('GET', '/contacts', { token: tokenA });
  if ((contacts?.data || []).find((c) => c.phone === phoneB)) return;
  const inv = await http('POST', '/contacts/invitations', {
    token: tokenA, body: { toPhone: phoneB, proposedRoleForSender: 'Друг', proposedRoleForRecipient: 'Друг' },
  });
  const invId = inv.json?.data?.id;
  const incoming = await http('GET', '/contacts/invitations/incoming', { token: tokenB });
  const acc = (incoming.json?.data || []).find((i) => i.id === invId) || (incoming.json?.data || [])[0];
  if (acc) await http('POST', `/contacts/invitations/${acc.id}/accept`, { token: tokenB, body: { myRole: 'Друг', theirRole: 'Друг' } });
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const sock = io(`${ORIGIN}/messenger`, { auth: { token }, transports: ['websocket'], reconnection: false });
    sock.on('connect', () => resolve(sock));
    sock.on('connect_error', (e) => reject(new Error('connect_error: ' + e.message)));
    setTimeout(() => reject(new Error('socket connect timeout')), 8000);
  });
}
function waitFor(sock, event, pred, ms = 6000) {
  return new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), ms);
    sock.on(event, (payload) => { if (!pred || pred(payload)) { clearTimeout(to); resolve(payload); } });
  });
}

let passed = 0, failed = 0;
const check = (n, c) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}`); } };

async function main() {
  const t1 = await login(CREDS.t1);
  const t2 = await login(CREDS.t2);
  console.log('logged in t1, t2');
  await ensureContact(t1.token, t2.token, CREDS.t2.phone);

  const dm = await http('POST', '/messenger/chats/dm', { token: t1.token, body: { userId: t2.id } });
  const chatId = dm.json?.data?.id;
  check('opened DM', !!chatId);

  const s1 = await connect(t1.token);
  const s2 = await connect(t2.token);
  check('t1 socket connected', s1.connected);
  check('t2 socket connected', s2.connected);

  // 1) REST send by t1 → t2 must receive message:new over the socket.
  const newOnT2 = waitFor(s2, 'message:new', (p) => p?.chatId === chatId);
  const sent = await http('POST', `/messenger/chats/${chatId}/messages`, { token: t1.token, body: { content: 'realtime ping' } });
  const seq = sent.json?.data?.seq;
  const got = await newOnT2;
  check('t2 received message:new via socket', !!got);
  check('pushed content matches', got?.message?.content === sent.json?.data?.content);
  check('pushed carries memberUserIds incl. t2', Array.isArray(got?.memberUserIds) && got.memberUserIds.includes(t2.id));

  // 2) t2 emits read → t1 must receive a receipt over the socket.
  const receiptOnT1 = waitFor(s1, 'receipt', (p) => p?.chatId === chatId && p?.userId === t2.id && p?.lastReadSeq >= seq);
  s2.emit('message:read', { chatId, seq });
  const receipt = await receiptOnT1;
  check('t1 received read receipt via socket', !!receipt);
  check('receipt lastReadSeq >= sent seq', (receipt?.lastReadSeq ?? -1) >= seq);

  // 3) edit pushes message:updated to t2.
  const updOnT2 = waitFor(s2, 'message:updated', (p) => p?.chatId === chatId);
  await http('PATCH', `/messenger/messages/${sent.json.data.id}`, { token: t1.token, body: { content: 'edited live' } });
  const upd = await updOnT2;
  check('t2 received message:updated via socket', !!upd && upd.message.content === 'edited live');

  // 4) bad token is rejected (socket disconnects / never connects).
  let rejected = false;
  try {
    const bad = io(`${ORIGIN}/messenger`, { auth: { token: 'garbage' }, transports: ['websocket'], reconnection: false });
    await new Promise((resolve) => {
      bad.on('disconnect', () => { rejected = true; resolve(); });
      bad.on('connect', () => setTimeout(() => { rejected = !bad.connected; resolve(); }, 1500));
      setTimeout(resolve, 3000);
    });
    bad.close();
  } catch { rejected = true; }
  check('socket with bad token is rejected', rejected);

  s1.close(); s2.close();
  console.log(`\nRESULT ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
