/* eslint-disable */
// Privacy fix (Circle review 2026-06-11): removing a contact (deleteContact) or blocking
// them (blockUser) deletes the ContactLink; its CircleMembership rows cascade away in the
// DB — but the mirrored access-engine tuples (circle:<id>#member@user) must be revoked
// IMMEDIATELY, not at the 4AM AccessReconcileCron. Otherwise the removed/blocked person
// keeps LIVE group-granted visibility for up to ~24h: per-Group calendar sharing
// (busy/detailed) and showcases/wishlists shared to a Group.
// Run (API up + seeded testers): node scripts/verify-circle-access-revoke.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const [a, b] = u1 < u2 ? [u1, u2] : [u2, u1];

  // The engine edge under test: circle:<cid>#member@user:<u2>.
  const tupleCount = (circleId) => prisma.relationTuple.count({
    where: { resourceType: 'circle', resourceId: circleId, relation: 'member', subjectType: 'user', subjectId: u2 },
  });
  const makeLink = () => prisma.contactLink.upsert({
    where: { userAId_userBId: { userAId: a, userBId: b } },
    update: {},
    create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 },
  });

  // Clean slate: no blocks between the pair; no leaked PERSONAL calendar share
  // u1→u2 from other scripts (it would mask the group-revoke assertions below).
  await prisma.contactBlock.deleteMany({ where: { OR: [{ blockerId: u1, blockedId: u2 }, { blockerId: u2, blockedId: u1 }] } });
  let link = await makeLink();
  await call('DELETE', `/calendar/shares/${u2}`, t1).catch(() => {});

  const cleanup = { circleId: null, showcaseId: null, eventId: null };
  try {
    // Fixture: t2 in t1's group; group gets detailed calendar + a shared showcase.
    const circle = await call('POST', '/circles', t1, { name: 'revoke-e2e' });
    check('t1 создал группу', circle.ok, `status ${circle.status}`);
    const cid = circle.json.data.id; cleanup.circleId = cid;

    const add = await call('POST', `/circles/${cid}/members`, t1, { contactLinkId: link.id });
    check('t1 добавил t2 в группу', add.ok, `status ${add.status}`);
    check('tuple circle#member@t2 спроецирован', (await tupleCount(cid)) === 1);

    const vis = await call('PATCH', `/circles/${cid}`, t1, { calendarVisibility: 'detailed' });
    check('календарь открыт группе (detailed)', vis.ok, `status ${vis.status}`);

    const start = new Date(Date.now() + 3600_000).toISOString();
    const end = new Date(Date.now() + 7200_000).toISOString();
    const ev = await call('POST', '/calendar/events', t1, { title: 'revoke-e2e-event', startTime: start, endTime: end });
    check('t1 создал событие', ev.ok, `status ${ev.status}`);
    cleanup.eventId = ev.ok ? ev.json.data.id : null;

    await call('GET', '/shop', t1); // lazy-create t1's shop
    const sc = await call('POST', '/shop/showcases', t1, { name: 'revoke-e2e-sc' });
    check('t1 создал витрину', sc.ok, `status ${sc.status}`);
    const scId = sc.ok ? sc.json.data.id : null; cleanup.showcaseId = scId;
    const share = await call('POST', `/shop/showcases/${scId}/shares`, t1, { principalType: 'circle', principalId: cid });
    check('витрина расшарена группе', share.ok, `status ${share.status}`);

    // Scoped probes (robust to unrelated fixtures of other scripts).
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 24 * 3600_000).toISOString();
    const overlayUrl = `/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&layers=events&include=${u1}`;
    const seesEvent = async () => JSON.stringify((await call('GET', overlayUrl, t2)).json ?? {}).includes('revoke-e2e-event');
    const seesShowcase = async () => {
      const r = await call('GET', `/shop/of/${u1}`, t2);
      return r.ok && ((r.json && r.json.data && r.json.data.showcases) || []).some((s) => s.id === scId);
    };

    // Baseline: group membership grants both.
    check('до удаления: t2 видит календарь t1 через группу', await seesEvent());
    check('до удаления: t2 видит витрину t1 через группу', await seesShowcase());

    // ===== deleteContact must revoke instantly =====
    const del = await call('DELETE', `/contacts/${link.id}`, t1);
    check('t1 удалил t2 из окружения', del.ok, `status ${del.status}`);
    check('deleteContact: tuple отозван СРАЗУ (без reconcile)', (await tupleCount(cid)) === 0);
    check('deleteContact: витрина сразу недоступна t2', !(await seesShowcase()));
    check('deleteContact: календарь t1 сразу скрыт от t2', !(await seesEvent()));

    // Re-link + re-add: access returns (proves the denial above wasn't a cache fluke).
    link = await makeLink();
    const re = await call('POST', `/circles/${cid}/members`, t1, { contactLinkId: link.id });
    check('t2 снова добавлен в группу', re.ok, `status ${re.status}`);
    check('tuple снова спроецирован', (await tupleCount(cid)) === 1);
    check('после повторной связи: витрина снова видна', await seesShowcase());

    // ===== blockUser must revoke instantly =====
    const blk = await call('POST', '/contacts/blocks', t1, { userId: u2 });
    check('t1 заблокировал t2', blk.ok, `status ${blk.status}`);
    check('blockUser: tuple отозван СРАЗУ (без reconcile)', (await tupleCount(cid)) === 0);
    check('blockUser: витрина сразу недоступна t2', !(await seesShowcase()));
    check('blockUser: календарь t1 сразу скрыт от t2', !(await seesEvent()));
  } finally {
    await call('DELETE', `/contacts/blocks/${u2}`, t1).catch(() => {});
    if (cleanup.circleId) {
      // calendarVisibility → none first, so the calendar group-tuple is revoked via the API.
      await call('PATCH', `/circles/${cleanup.circleId}`, t1, { calendarVisibility: 'none' }).catch(() => {});
      await call('DELETE', `/circles/${cleanup.circleId}`, t1).catch(() => {});
    }
    if (cleanup.showcaseId) await call('DELETE', `/shop/showcases/${cleanup.showcaseId}`, t1).catch(() => {});
    if (cleanup.eventId) await call('DELETE', `/calendar/events/${cleanup.eventId}`, t1).catch(() => {});
    await makeLink().catch(() => {}); // restore the testers' link for other scripts
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ CIRCLE ACCESS REVOKE E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
