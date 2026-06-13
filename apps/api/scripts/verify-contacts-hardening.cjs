/* eslint-disable */
// Contacts hardening (Circle review 2026-06-11, findings 2/3/5):
//  #2 Invitation anti-spam: non-pending invitation rows are RETAINED (30d) instead of
//     being deleted hourly — the 24h resend cooldown, the 30/day limit and
//     resendInvitation all read that history. Also: expired-but-not-yet-cron-marked
//     invitations must not show up in the pending lists.
//  #3 Phone lookup privacy: GET /users/lookup returns the last name MASKED to an
//     initial ("Н."), Kaspi-style, + dedicated throttle (throttle not testable in dev).
//  #5 Blocks: full lifecycle over the API — block without a link, masked entry in the
//     list, invitations refused in BOTH directions while blocked, unblock → invite →
//     accept works again.
// Run (API up + seeded testers): node scripts/verify-contacts-hardening.cjs
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
  const u2raw = await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true, lastName: true } });
  const u2 = u2raw.id;
  const [a, b] = u1 < u2 ? [u1, u2] : [u2, u1];

  // tester2 must have a last name for the masking assertions.
  const lastNameWasNull = !u2raw.lastName;
  if (lastNameWasNull) await prisma.user.update({ where: { id: u2 }, data: { lastName: 'Маскировкин' } });
  const fullLast = lastNameWasNull ? 'Маскировкин' : u2raw.lastName;
  const expectedMask = fullLast.charAt(0).toUpperCase() + '.';

  const wipeInvitations = () => prisma.contactInvitation.deleteMany({
    where: { OR: [
      { fromUserId: { in: [u1, u2] }, toPhone: { in: [P1, P2] } },
      { fromUserId: { in: [u1, u2] }, toUserId: { in: [u1, u2] } },
    ] },
  });
  const restoreLink = () => prisma.contactLink.upsert({
    where: { userAId_userBId: { userAId: a, userBId: b } },
    update: {},
    create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 },
  });

  // Clean slate: no blocks, no invitation history, no link between the pair.
  await prisma.contactBlock.deleteMany({ where: { OR: [{ blockerId: u1, blockedId: u2 }, { blockerId: u2, blockedId: u1 }] } });
  await wipeInvitations();
  await prisma.contactLink.deleteMany({ where: { userAId: a, userBId: b } });

  try {
    // ===== #3 Lookup masking =====
    const lk = await call('GET', `/users/lookup?phone=${encodeURIComponent(P2)}`, t1);
    check('lookup: найден по номеру', lk.ok && !!lk.json.data, `status ${lk.status}`);
    check('lookup: фамилия замаскирована до инициала', lk.json?.data?.lastName === expectedMask, `got "${lk.json?.data?.lastName}", full "${fullLast}"`);
    check('lookup: полная фамилия НЕ отдаётся', lk.json?.data?.lastName !== fullLast || fullLast.length <= 2);
    const lkNone = await call('GET', '/users/lookup?phone=%2B77009999999', t1);
    check('lookup: незарегистрированный номер → null', lkNone.ok && lkNone.json.data === null);

    // ===== #2 Cooldown / retention / resend =====
    const inv1 = await call('POST', '/contacts/invitations', t1, { toPhone: P2, proposedRoleForRecipient: 'Друг' });
    check('приглашение отправлено', inv1.ok, `status ${inv1.status}`);
    const inv1Id = inv1.json?.data?.id;

    const rej = await call('POST', `/contacts/invitations/${inv1Id}/reject`, t2);
    check('получатель отклонил', rej.ok, `status ${rej.status}`);

    const again = await call('POST', '/contacts/invitations', t1, { toPhone: P2 });
    check('повтор сразу после отказа → 400 (кулдаун 24ч жив)', again.status === 400 && /Повторная/.test(again.json?.message ?? ''), `status ${again.status}: ${again.json?.message}`);

    // Age the rejected row past the cooldown — it must still EXIST (retention!)
    // for resendInvitation to find it. Under the old hourly wipe it would be gone.
    await prisma.contactInvitation.update({ where: { id: inv1Id }, data: { updatedAt: new Date(Date.now() - 25 * 3600_000) } });
    const stillThere = await prisma.contactInvitation.findUnique({ where: { id: inv1Id }, select: { status: true } });
    check('история приглашения сохранена (ретеншн)', stillThere?.status === 'rejected');

    const resend = await call('POST', `/contacts/invitations/${inv1Id}/resend`, t1);
    check('resend после кулдауна работает (раньше — 404 после крона)', resend.ok, `status ${resend.status}: ${resend.json?.message}`);
    const inv2Id = resend.json?.data?.id;

    // Expired-but-not-yet-cron-marked must vanish from both pending lists.
    await prisma.contactInvitation.update({ where: { id: inv2Id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const incList = await call('GET', '/contacts/invitations/incoming', t2);
    const outList = await call('GET', '/contacts/invitations/outgoing', t1);
    check('просроченное скрыто из входящих', incList.ok && !(incList.json.data ?? []).some((i) => i.id === inv2Id));
    check('просроченное скрыто из исходящих', outList.ok && !(outList.json.data ?? []).some((i) => i.id === inv2Id));

    await wipeInvitations(); // no cooldown interference with the blocks phase

    // ===== #5 Blocks lifecycle =====
    const blk = await call('POST', '/contacts/blocks', t1, { userId: u2 });
    check('блок без существующей связи — ок', blk.ok, `status ${blk.status}`);

    const blist = await call('GET', '/contacts/blocks', t1);
    const entry = (blist.json?.data ?? []).find((x) => x.blockedUserId === u2);
    check('заблокированный в списке', blist.ok && !!entry, `status ${blist.status}`);
    check('в списке блоков фамилия — инициал', entry?.blockedLastName === expectedMask, `got "${entry?.blockedLastName}"`);
    check('в списке блоков есть аватар-поле', entry ? 'blockedAvatar' in entry : false);

    const fromBlocked = await call('POST', '/contacts/invitations', t2, { toPhone: P1 });
    check('приглашение ОТ заблокированного → 403', fromBlocked.status === 403, `status ${fromBlocked.status}`);
    const toBlocked = await call('POST', '/contacts/invitations', t1, { toPhone: P2 });
    check('приглашение заблокированному → 403', toBlocked.status === 403, `status ${toBlocked.status}`);

    const unb = await call('DELETE', `/contacts/blocks/${u2}`, t1);
    check('разблокировка — ок', unb.ok, `status ${unb.status}`);
    const blist2 = await call('GET', '/contacts/blocks', t1);
    check('список блоков пуст после разблокировки', blist2.ok && !(blist2.json?.data ?? []).some((x) => x.blockedUserId === u2));

    const inv3 = await call('POST', '/contacts/invitations', t1, { toPhone: P2, proposedRoleForRecipient: 'Друг', proposedRoleForSender: 'Друг' });
    check('после разблокировки приглашение снова уходит', inv3.ok, `status ${inv3.status}`);
    const acc = await call('POST', `/contacts/invitations/${inv3.json?.data?.id}/accept`, t2, {});
    check('и принимается — связь восстановлена', acc.ok, `status ${acc.status}`);
    const contacts = await call('GET', '/contacts', t1);
    check('t2 снова в окружении t1', contacts.ok && (contacts.json.data ?? []).some((c) => c.them?.id === u2));
  } finally {
    if (lastNameWasNull) await prisma.user.update({ where: { id: u2 }, data: { lastName: null } }).catch(() => {});
    await restoreLink().catch(() => {}); // testers stay linked for other scripts
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ CONTACTS HARDENING ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
