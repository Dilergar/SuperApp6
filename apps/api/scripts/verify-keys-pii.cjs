/* eslint-disable */
// E2E: core/keys, фаза D — ПДн под движком ключей. Сьют suite1–3, API на :3001 (dev).
// Покрывает: бэкфилл `_enc`/`_bi` (0 небэкфилленных строк); двойная запись на путях API
// (анкета: ИИН/адрес/e-mail; приглашение по номеру; приглашение в организацию; цепочка
// SMS; контрагент с телефоном/e-mail и счётом); детерминизм слепого индекса между
// таблицами (users.phone_bi = verify_challenges.phone_bi того же номера); режим
// `encrypted`: логин по слепому индексу, /users/me отдаёт расшифрованный номер, поиск
// приглашений по номеру, платформенный lookup по номеру и ИИН, журнал чтений ПДн
// (pii_access_log) при чтении ИИН; в конце режим возвращается в legacy.
// Run: node apps/api/scripts/verify-keys-pii.cjs
const { SUITE, call, login, makeChecker, consoleLogin } = require('./_lib.cjs');
const { PrismaClient } = require('@prisma/client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isEnv = (v) => typeof v === 'string' && v.startsWith('sa6e:1:');
const isBi = (v) => typeof v === 'string' && v.startsWith('sa6b:1:');
/** Валидный ИИН РК: 11 цифр + контрольная (веса 1..11, при 10 — 3..11,1,2). */
function makeIin(base11) {
  const d = base11.split('').map(Number);
  const w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
  let c = d.reduce((a, x, i) => a + x * w1[i], 0) % 11;
  if (c === 10) c = d.reduce((a, x, i) => a + x * w2[i], 0) % 11;
  return base11 + String(c);
}
const IIN = makeIin('90010130012');

async function main() {
  const { check, finish } = makeChecker();
  const prisma = new PrismaClient();
  const s1 = await login(SUITE.p1);
  const s2 = await login(SUITE.p2);
  console.log('logged in suite1, suite2');
  const dev = (p, body) => call('POST', `/keys/dev/${p}`, s1.token, body);
  const setMode = async (mode) => {
    const r = await dev('pii/mode', { mode });
    if (!r.ok) throw new Error(`pii/mode ${mode}: ${r.status}`);
  };

  try {
    // ===== 1. Бэкфилл =====
    const bf = await dev('pii/backfill', {});
    check('pii/backfill: 200', bf.ok, bf.status);
    const st = await call('GET', '/keys/dev/pii/status', s1.token);
    check('pii/status: 0 rows without _enc after backfill', st.ok && st.json?.data?.total === 0, JSON.stringify(st.json?.data?.pending ?? st.json).slice(0, 300));
    const u1 = await prisma.user.findUnique({ where: { id: s1.id } });
    check('users.phone_enc is an envelope, phone_bi a blind index', isEnv(u1.phoneEnc) && isBi(u1.phoneBi), `${u1.phoneEnc?.slice(0, 12)} ${u1.phoneBi?.slice(0, 12)}`);
    check('users.phone (plaintext) still present on the dual-write window', u1.phone === SUITE.p1);

    // ===== 2. Двойная запись на путях API =====
    const patch = await call('PATCH', '/users/me', s1.token, { iin: IIN, residentialAddress: 'Almaty, Abay 1', email: `keys-pii-${Date.now()}@example.kz` });
    check('PATCH /users/me (iin, address, email): 200', patch.ok, `${patch.status} ${JSON.stringify(patch.json).slice(0, 160)}`);
    const u1b = await prisma.user.findUnique({ where: { id: s1.id } });
    check('iin → iin_enc + iin_bi', isEnv(u1b.iinEnc) && isBi(u1b.iinBi));
    check('residentialAddress → _enc (no index)', isEnv(u1b.residentialAddressEnc));
    check('email → email_enc + email_bi', isEnv(u1b.emailEnc) && isBi(u1b.emailBi));

    // Цепочка SMS: phone_enc/phone_bi; тот же номер → тот же слепой индекс, что у users
    const otp = await call('POST', '/verify/start', null, { phone: SUITE.p1, purpose: 'password_reset' });
    check('verify/start (password_reset): 200', otp.ok, otp.status);
    if (otp.ok) {
      const ch = await prisma.verifyChallenge.findUnique({ where: { id: otp.json.data.challengeId } });
      check('verify_challenges.phone_enc/bi written', isEnv(ch?.phoneEnc) && isBi(ch?.phoneBi));
      check('blind index is the same across tables for the same number', ch?.phoneBi === u1.phoneBi);
      check('challenge envelope is under the platform KEK (scope has no owner)', ch?.phoneEnc?.split(':')[2] !== u1.phoneEnc?.split(':')[2]);
    }

    // Приглашение по номеру (Окружение) — внешний номер (не на платформе): toUserId = null
    const EXT_PHONE = '+77009990777';
    await prisma.contactInvitation.deleteMany({ where: { fromUserId: s1.id, toPhone: EXT_PHONE } });
    const inv = await call('POST', '/contacts/invitations', s1.token, { toPhone: EXT_PHONE });
    check('contact invitation by phone: 201', inv.ok, `${inv.status} ${JSON.stringify(inv.json).slice(0, 160)}`);
    const invRow = inv.ok ? await prisma.contactInvitation.findUnique({ where: { id: inv.json.data.id } }) : null;
    check('contact_invitations.to_phone_enc/bi written (sender KEK)', isEnv(invRow?.toPhoneEnc) && isBi(invRow?.toPhoneBi));

    // Организация: приглашение по номеру + контрагент с телефоном/e-mail + счёт
    const ws = await call('POST', '/workspaces', s1.token, { name: `pii-ws-${Date.now()}` });
    check('workspace create', ws.ok, ws.status);
    const wsId = ws.json?.data?.id;
    const H = { 'X-Workspace-Id': wsId };
    if (wsId) {
      const winv = await call('POST', `/workspaces/${wsId}/invitations`, s1.token, { phone: '+77009990009' }, H);
      if (winv.ok) {
        const wrow = await prisma.workspaceInvitation.findUnique({ where: { id: winv.json.data.id } });
        check('workspace_invitations.to_phone_enc/bi written (workspace KEK)', isEnv(wrow?.toPhoneEnc) && isBi(wrow?.toPhoneBi));
      } else check('workspace invitation by phone', false, `${winv.status} ${JSON.stringify(winv.json).slice(0, 160)}`);
      const cp = await call('POST', `/workspaces/${wsId}/counterparties`, s1.token, { kind: 'legal', name: 'PII Ltd', phone: '+77011112233', email: 'cp@example.kz' }, H);
      check('counterparty create', cp.ok, `${cp.status} ${JSON.stringify(cp.json).slice(0, 160)}`);
      if (cp.ok) {
        const crow = await prisma.counterparty.findUnique({ where: { id: cp.json.data.id } });
        check('counterparties.phone_enc/bi + email_enc written', isEnv(crow?.phoneEnc) && isBi(crow?.phoneBi) && isEnv(crow?.emailEnc));
        const acc = await call('POST', `/workspaces/${wsId}/counterparties/${cp.json.data.id}/accounts`, s1.token, { iban: 'KZ86125KZT5004100100', bankName: 'Kaspi', bik: 'CASPKZKA' }, H);
        if (acc.ok) {
          const arow = await prisma.counterpartyBankAccount.findUnique({ where: { id: acc.json.data.id } });
          check('counterparty_bank_accounts.iban_enc written under the workspace KEK', isEnv(arow?.ibanEnc) && arow?.workspaceId === wsId);
        } else check('counterparty bank account create', false, `${acc.status} ${JSON.stringify(acc.json).slice(0, 160)}`);
      }
    }

    // ===== 3. Режим encrypted =====
    await setMode('encrypted');
    const st2 = await call('GET', '/keys/dev/pii/status', s1.token);
    check('read mode switched to encrypted', st2.json?.data?.readMode === 'encrypted');
    const lg = await call('POST', '/auth/login', null, { phone: SUITE.p2, password: SUITE.password });
    check('encrypted: login finds the account by the blind index', lg.ok, lg.status);
    const me = await call('GET', '/users/me', lg.json?.data?.accessToken ?? s2.token);
    check('encrypted: /users/me returns the decrypted phone', me.json?.data?.phone === SUITE.p2, me.json?.data?.phone);
    const me1 = await call('GET', '/users/me', s1.token);
    check('encrypted: iin decrypts back (sensitive field)', me1.json?.data?.iin === IIN, me1.json?.data?.iin);
    check('encrypted: address decrypts back', me1.json?.data?.residentialAddress === 'Almaty, Abay 1');
    const wrongLogin = await call('POST', '/auth/login', null, { phone: '+77009990999', password: SUITE.password });
    check('encrypted: unknown number → 401 (no leak)', wrongLogin.status === 401);
    // Повтор приглашения тем же номером → отказ: проверка pending идёт по слепому индексу
    const dup = await call('POST', '/contacts/invitations', s1.token, { toPhone: EXT_PHONE });
    check('encrypted: duplicate pending invitation is refused (pending lookup by _bi)', dup.status === 409 || dup.status === 400 || dup.status === 429, dup.status);
    const outgoing = await call('GET', '/contacts/invitations/outgoing', s1.token);
    check('encrypted: outgoing list shows the decrypted phone', JSON.stringify(outgoing.json).includes(EXT_PHONE), JSON.stringify(outgoing.json).slice(0, 160));
    // Ростер организации читает людей через include → расшифровка вложенных строк
    if (wsId) {
      const members = await call('GET', `/workspaces/${wsId}/members`, s1.token, null, H);
      const mine = (members.json?.data?.items ?? members.json?.data ?? []).find?.((m) => (m.userId ?? m.user?.id ?? m.id) === s1.id);
      check('encrypted: workspace roster (nested user include) shows the decrypted phone', !!mine && JSON.stringify(mine).includes(SUITE.p1), JSON.stringify(mine ?? members.json).slice(0, 200));
    }
    // Кабинет: lookup по номеру и ИИН
    const cl = await consoleLogin(SUITE.p1);
    if (cl.token) {
      const byPhone = await call('GET', `/platform/lookup?q=${encodeURIComponent(SUITE.p2)}`, cl.token);
      check('encrypted: console lookup by phone hits', byPhone.ok && JSON.stringify(byPhone.json).includes(s2.id), `${byPhone.status} ${JSON.stringify(byPhone.json).slice(0, 160)}`);
      const byIin = await call('GET', `/platform/lookup?q=${IIN}`, cl.token);
      check('encrypted: console lookup by IIN hits', byIin.ok && JSON.stringify(byIin.json).includes(s1.id), `${byIin.status} ${JSON.stringify(byIin.json).slice(0, 160)}`);
    } else console.log('  (suite1 is not platform staff — console lookup skipped)');
    // Журнал чтений ПДн: чтение ИИН через /users/me → строка pii_access_log
    await sleep(2500);
    const logRow = await prisma.piiAccessLog.findFirst({ where: { entity: 'user', actorId: s1.id, fields: { has: 'iin' } }, orderBy: { id: 'desc' } });
    check('pii_access_log: reading IIN is journaled (actor, entity, fields)', !!logRow && logRow.count >= 1, JSON.stringify(logRow ? { ...logRow, id: String(logRow.id) } : null).slice(0, 160));
    const nophoneLog = await prisma.piiAccessLog.findFirst({ where: { entity: 'user', fields: { has: 'phone' } } });
    check('pii_access_log: phone (contact field) is not journaled', !nophoneLog);
    // OTP-цепочка в encrypted: start → check (dev-код) → пропуск
    const otp2 = await call('POST', '/verify/start', null, { phone: SUITE.p3, purpose: 'password_reset' });
    if (otp2.ok) {
      const code = (await call('GET', `/verify/dev/last-code?challengeId=${otp2.json.data.challengeId}`)).json?.data?.code;
      const chk = await call('POST', '/verify/check', null, { challengeId: otp2.json.data.challengeId, code });
      check('encrypted: OTP chain (phone filters via _bi) verifies', chk.ok && !!chk.json?.data?.verifyToken, `${chk.status} ${JSON.stringify(chk.json).slice(0, 120)}`);
    } else check('encrypted: verify/start', false, otp2.status);

    // cleanup
    if (inv.ok) await call('POST', `/contacts/invitations/${inv.json.data.id}/cancel`, s1.token).catch(() => undefined);
    await call('PATCH', '/users/me', s1.token, { iin: null, residentialAddress: null, email: null }).catch(() => undefined);
    if (wsId) await call('DELETE', `/workspaces/${wsId}`, s1.token).catch(() => undefined);
  } finally {
    await setMode('legacy').catch(() => undefined);
    await prisma.$disconnect();
  }
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
