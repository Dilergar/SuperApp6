/* eslint-disable */
// Arch-review block 5: logout-all must hard-disconnect live messenger sockets (socket auth
// is handshake-only, so without the server-side kick a revoked session keeps receiving
// realtime traffic). Run (API up): node scripts/verify-logout-socket.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
// socket.io-client is taken from apps/web (the API itself only depends on the server lib).
let io;
try {
  io = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client')).io;
} catch (e) {
  console.error('socket.io-client not found in apps/web/node_modules', e.message);
  process.exit(1);
}
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };

async function call(method, p, token, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}

async function main() {
  const login = await call('POST', '/auth/login', null, { phone: P1, password: PW });
  if (!login.ok) throw new Error(`login: ${login.status}`);
  const token = login.json.data.accessToken;

  const socket = io('http://localhost:3001/messenger', {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });

  const connected = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    socket.on('connect', () => { clearTimeout(t); resolve(true); });
    socket.on('connect_error', () => { clearTimeout(t); resolve(false); });
  });
  check('socket connected with valid token', connected);

  const disconnected = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    socket.on('disconnect', () => { clearTimeout(t); resolve(true); });
  });

  const out = await call('POST', '/auth/logout-all', token);
  check('logout-all returns ok', out.ok, `status ${out.status}`);

  check('socket was force-disconnected by the server', await disconnected);
  socket.close();

  console.log(`\n${fails === 0 ? '✅ LOGOUT-SOCKET E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
