/* eslint-disable */
// Phase 2 (Calendar) e2e: calendar sharing decided by the unified access engine. Asserts that a
// personal share (detailed) and a per-Group share (Circle.calendarVisibility=busy) both surface in
// the recipient's /calendar/shared-with-me at the right level, and that removing a share revokes it.
// All via the real API (setShare → tuples; shared-with-me → engine listObjects). Run (API up):
//   node scripts/verify-calendar-access.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', P3 = '+77023456789', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };
const sharedLevel = (arr, ownerId) => (arr || []).find((s) => s.userId === ownerId)?.accessLevel ?? null;

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const u3 = (await prisma.user.findUnique({ where: { phone: P3 }, select: { id: true } })).id;

  const linkOf = async (x, y) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    return prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 } });
  };
  await linkOf(u1, u2);
  const l13 = await linkOf(u1, u3);

  let circleId;
  try {
    // 1) Personal share: t1 → t2 detailed
    const s = await call('POST', '/calendar/shares', t1, { sharedWithUserId: u2, accessLevel: 'detailed' });
    check('t1 делится календарём с t2 (detailed)', s.ok, `status ${s.status}`);
    const sw2 = await call('GET', '/calendar/shared-with-me', t2);
    check('t2 видит календарь t1 как detailed', sharedLevel(sw2.json.data, u1) === 'detailed', JSON.stringify(sw2.json.data));
    const sw3a = await call('GET', '/calendar/shared-with-me', t3);
    check('t3 пока НЕ видит календарь t1', sharedLevel(sw3a.json.data, u1) === null, JSON.stringify(sw3a.json.data));

    // 2) Per-Group share: a Group with t3, calendarVisibility=busy
    const c = await call('POST', '/circles', t1, { name: 'Кал-тест' });
    check('создание Группы', c.ok, `status ${c.status}`);
    circleId = c.json.data.id;
    const addm = await call('POST', `/circles/${circleId}/members`, t1, { contactLinkId: l13.id });
    check('добавление t3 в Группу', addm.ok, `status ${addm.status}`);
    const patch = await call('PATCH', `/circles/${circleId}`, t1, { calendarVisibility: 'busy' });
    check('Группе выставлен calendarVisibility=busy', patch.ok, `status ${patch.status}`);
    const sw3b = await call('GET', '/calendar/shared-with-me', t3);
    check('t3 (член Группы) видит календарь t1 как busy', sharedLevel(sw3b.json.data, u1) === 'busy', JSON.stringify(sw3b.json.data));

    // 3) Revoke personal share → t2 loses access
    const rm = await call('DELETE', `/calendar/shares/${u2}`, t1);
    check('t1 отзывает доступ у t2', rm.ok, `status ${rm.status}`);
    const sw2b = await call('GET', '/calendar/shared-with-me', t2);
    check('t2 больше НЕ видит календарь t1', sharedLevel(sw2b.json.data, u1) === null, JSON.stringify(sw2b.json.data));
  } finally {
    await call('DELETE', `/calendar/shares/${u2}`, t1).catch(() => {});
    if (circleId) {
      await call('PATCH', `/circles/${circleId}`, t1, { calendarVisibility: 'none' }).catch(() => {});
      await call('DELETE', `/circles/${circleId}`, t1).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ CALENDAR ACCESS E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
