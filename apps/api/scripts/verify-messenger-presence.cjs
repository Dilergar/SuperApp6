/* eslint-disable */
// Phase 4 e2e: presence (online/offline/last-seen) + typing relay + contextual calendar
// presence via the per-viewer GET /messenger/presence batch. Requires API on 3001 + seeded
// testers. socket.io-client is taken from apps/web/node_modules. Run: node scripts/verify-messenger-presence.cjs
const fs = require('fs'), path = require('path');
for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = process.env.API_URL || 'http://localhost:3001/api';
const ORIGIN = BASE.replace(/\/api\/?$/, '');
let io;
try { io = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client')).io; }
catch (e) { console.error('socket.io-client not found in apps/web/node_modules', e.message); process.exit(1); }

const CREDS = {
  t1: { phone: '+77001234567', password: 'Test1234!' },
  t2: { phone: '+77012345678', password: 'Test1234!' },
};
async function http(method, p, { token, body } = {}) {
  const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await res.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t }; }
  return { status: res.status, json: j };
}
async function login(c) { const { json } = await http('POST', '/auth/login', { body: c }); const token = json.data.accessToken; const me = await http('GET', '/users/me', { token }); return { token, id: me.json.data.id }; }
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(`${ORIGIN}/messenger`, { auth: { token }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error('connect_error ' + e.message)));
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}
function waitFor(sock, ev, pred, ms = 6000) {
  return new Promise((res) => { const to = setTimeout(() => res(null), ms); sock.on(ev, (p) => { if (!pred || pred(p)) { clearTimeout(to); res(p); } }); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function presenceOf(token, ids) { const r = await http('GET', `/messenger/presence?userIds=${ids.join(',')}`, { token }); return (r.json?.data?.items) || []; }

let pass = 0, fail = 0;
const check = (n, c, extra) => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n}${extra ? '  (' + extra + ')' : ''}`); } };

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(CREDS.t1), t2 = await login(CREDS.t2);
  // Deterministic Окружение link t1↔t2.
  const [a, b] = t1.id < t2.id ? [t1.id, t2.id] : [t2.id, t1.id];
  await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: t1.id } });
  // Ensure both are visible by default (mode 'everyone', card flag on).
  await prisma.user.update({ where: { id: t1.id }, data: { onlineStatusMode: 'everyone' } });
  await prisma.user.update({ where: { id: t2.id }, data: { onlineStatusMode: 'everyone' } });
  console.log('logged in t1, t2 + linked');

  console.log('\n-- offline baseline --');
  let p = await presenceOf(t1.token, [t2.id]);
  check('t2 offline before connect', p[0] && p[0].online === false, JSON.stringify(p[0]));

  console.log('\n-- t2 connects → online (t1 gets presence:changed) --');
  const s1 = await connect(t1.token);
  const changed = waitFor(s1, 'presence:changed', (x) => x.userId === t2.id, 6000);
  const s2 = await connect(t2.token);
  const ping = await changed;
  check('t1 received presence:changed for t2', !!ping, JSON.stringify(ping));
  await sleep(300);
  p = await presenceOf(t1.token, [t2.id]);
  check('t2 now online for t1', p[0] && p[0].online === true, JSON.stringify(p[0]));

  console.log('\n-- typing relay (t2 typing in a DM → t1 sees it) --');
  const dm = await http('POST', '/messenger/chats/dm', { token: t1.token, body: { userId: t2.id } });
  const chatId = dm.json?.data?.id;
  const typing = waitFor(s1, 'typing', (x) => x.chatId === chatId && x.userId === t2.id && x.typing === true, 6000);
  s2.emit('typing:start', { chatId });
  const tp = await typing;
  check('t1 received typing:start from t2', !!tp, JSON.stringify(tp));
  const typingStop = waitFor(s1, 'typing', (x) => x.chatId === chatId && x.userId === t2.id && x.typing === false, 6000);
  s2.emit('typing:stop', { chatId });
  check('t1 received typing:stop from t2', !!(await typingStop));

  console.log('\n-- contextual calendar status (busy vs detailed) --');
  // NOTE: contextual current-event is cached per target in Redis (~60s). To keep this
  // section deterministic regardless of prior runs, we (1) use a UNIQUE event title,
  // (2) clear the target's ctx cache before each presence read, (3) set the SHARE FIRST.
  const evTitle = 'Тренировка-' + Date.now();
  const delCtx = async () => { const c = new (require('ioredis'))(process.env.REDIS_URL || 'redis://localhost:6379'); try { await c.del(`presence:${t2.id}:ctx`); } finally { c.disconnect(); } };
  const now = new Date();
  const ev = await http('POST', '/calendar/events', {
    token: t2.token,
    body: { title: evTitle, startTime: new Date(now.getTime() - 600000).toISOString(), endTime: new Date(now.getTime() + 3600000).toISOString() },
  });
  check('t2 created ongoing event', ev.status === 200 || ev.status === 201, `status ${ev.status}`);

  // No calendar share yet → no contextual.
  await http('DELETE', `/calendar/shares/${t1.id}`, { token: t2.token });
  await delCtx();
  p = await presenceOf(t1.token, [t2.id]);
  check('no calendar share → no contextual for t1', p[0] && p[0].contextual === null, JSON.stringify(p[0]?.contextual));

  // Share busy → "Занят до HH:MM" (no title).
  await http('POST', '/calendar/shares', { token: t2.token, body: { sharedWithUserId: t1.id, accessLevel: 'busy' } });
  await delCtx();
  p = await presenceOf(t1.token, [t2.id]);
  const ctxBusy = p[0]?.contextual;
  check('busy share → contextual level=busy', ctxBusy && ctxBusy.level === 'busy', JSON.stringify(ctxBusy));
  check('busy contextual hides the title', ctxBusy && !ctxBusy.label.includes(evTitle), JSON.stringify(ctxBusy));

  // Upgrade to detailed → "На <title> до HH:MM".
  await http('POST', '/calendar/shares', { token: t2.token, body: { sharedWithUserId: t1.id, accessLevel: 'detailed' } });
  await delCtx();
  p = await presenceOf(t1.token, [t2.id]);
  const ctxDet = p[0]?.contextual;
  check('detailed share → contextual level=detailed', ctxDet && ctxDet.level === 'detailed', JSON.stringify(ctxDet));
  check('detailed contextual shows the title', ctxDet && ctxDet.label.includes(evTitle), JSON.stringify(ctxDet));
  await http('DELETE', `/calendar/shares/${t1.id}`, { token: t2.token });

  console.log('\n-- privacy: t2 sets nobody → hidden from t1 --');
  await prisma.user.update({ where: { id: t2.id }, data: { onlineStatusMode: 'nobody' } });
  await sleep(150);
  p = await presenceOf(t1.token, [t2.id]);
  check('mode=nobody → t2 offline for t1', p[0] && p[0].online === false, JSON.stringify(p[0]));
  check('mode=nobody → no contextual', p[0] && p[0].contextual === null);
  await prisma.user.update({ where: { id: t2.id }, data: { onlineStatusMode: 'everyone' } });

  console.log('\n-- reciprocity: viewer t1=nobody → sees no one online --');
  await prisma.user.update({ where: { id: t1.id }, data: { onlineStatusMode: 'nobody' } });
  await sleep(150);
  p = await presenceOf(t1.token, [t2.id]);
  check('viewer nobody → t2 appears offline (reciprocity)', p[0] && p[0].online === false, JSON.stringify(p[0]));
  await prisma.user.update({ where: { id: t1.id }, data: { onlineStatusMode: 'everyone' } });

  console.log('\n-- disconnect → offline + lastSeen --');
  s2.close();
  await sleep(800);
  p = await presenceOf(t1.token, [t2.id]);
  check('t2 offline after disconnect', p[0] && p[0].online === false, JSON.stringify(p[0]));
  check('t2 has lastSeen set', p[0] && typeof p[0].lastSeen === 'string', JSON.stringify(p[0]?.lastSeen));

  s1.close();
  // cleanup the test event
  try { if (ev.json?.data?.id) await http('DELETE', `/calendar/events/${ev.json.data.id}`, { token: t2.token }); } catch {}
  await prisma.$disconnect();
  console.log(`\nRESULT ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
