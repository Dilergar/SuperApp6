/* eslint-disable */
// E2E: core/keys — движок ключей (22-й). Сьют suite1–3, API на :3001 (NODE_ENV=development:
// дев-полигон /keys/dev/*). Покрывает: JWKS публикуется (well-known + api-алиас) и несёт
// только OKP/Ed25519; roundtrip envelope с AAD (чужое поле не читается); HMAC-ключ
// (tagged/verify); ротация подписи без разлогина (старый access жив, новый kid в JWKS, старая
// версия проверяет до retire); ротация KEK + rewrap (старые шифротексты читаются);
// заморозка скоупа → отказ keys.key_unavailable → разморозка; учение восстановления
// корня (keys-verify-root.cjs копией файла); журнал ключей append-only (UPDATE → ошибка).
// Фазы B–F дописывают свои секции ниже.
// Run: node apps/api/scripts/verify-keys.cjs
const { SUITE, call, login, makeChecker, devCode, createSuiteWorkspace, archiveSuiteWorkspace, crash } = require('./_lib.cjs');
const { PrismaClient } = require('@prisma/client');
const { SIGNING_AUDIENCES, MAC_KEY_NAMES } = require('@superapp/shared');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE_ROOT = (process.env.SA6_API_BASE || process.env.API_URL || process.env.API_BASE || 'http://localhost:3001/api').replace(/\/api(\/v1)?$/, '');
const decodeHeader = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString());

async function main() {
  const { check, finish } = makeChecker();
  const prisma = new PrismaClient();
  const s1 = await login(SUITE.p1);
  console.log('logged in suite1');
  const dev = (p, body) => call('POST', `/keys/dev/${p}`, s1.token, body);

  try {
    // ===== A1. Статус движка =====
    const st = await call('GET', '/keys/dev/status', s1.token);
    check('dev/status: 200', st.ok, st.status);
    check('provider software, root fingerprint 16 hex', st.json?.data?.provider === 'software' && /^[0-9a-f]{16}$/.test(st.json?.data?.rootKid ?? ''), JSON.stringify(st.json?.data?.rootKid));
    const audiences = (st.json?.data?.signing ?? []).map((s) => s.audience).sort();
    // Ожидание — реестр shared целиком: новая аудитория без пары ключей в базе = провал
    const wantAudiences = [...SIGNING_AUDIENCES].sort();
    check(`signing keys for all ${wantAudiences.length} audiences`, JSON.stringify(audiences) === JSON.stringify(wantAudiences), audiences.join(','));
    check('every audience has a primary kid', (st.json?.data?.signing ?? []).every((s) => !!s.primaryKid));
    const macs = (st.json?.data?.mac ?? []).map((m) => m.name).sort();
    // Ожидание — реестр именованных HMAC-ключей shared целиком
    const wantMacs = [...MAC_KEY_NAMES].sort();
    check(`mac keys: ${wantMacs.join(', ')}`, JSON.stringify(macs) === JSON.stringify(wantMacs), macs.join(','));

    // ===== A2. JWKS =====
    const wk = await fetch(`${BASE_ROOT}/.well-known/jwks.json`);
    const wkJson = await wk.json().catch(() => null);
    check('/.well-known/jwks.json: 200 outside /api prefix', wk.status === 200 && Array.isArray(wkJson?.keys), wk.status);
    check('jwks: only OKP/Ed25519/EdDSA/sig', (wkJson?.keys ?? []).every((k) => k.kty === 'OKP' && k.crv === 'Ed25519' && k.alg === 'EdDSA' && k.use === 'sig' && typeof k.x === 'string' && k.kid));
    check('jwks: cache-control 600', /max-age=600/.test(wk.headers.get('cache-control') ?? ''), wk.headers.get('cache-control'));
    const alias = await call('GET', '/keys/jwks', null);
    check('/keys/jwks alias: same key count', alias.ok && alias.json?.keys?.length === wkJson?.keys?.length);
    check('jwks: no private material leaks (no "d")', (wkJson?.keys ?? []).every((k) => !('d' in k)));

    // ===== A3. Envelope roundtrip + AAD + HMAC =====
    const rt = await dev('roundtrip', { plaintext: '+77009990001' });
    check('roundtrip: ok', rt.ok && rt.json?.data?.roundtripOk === true, JSON.stringify(rt.json).slice(0, 200));
    check('roundtrip: format sa6e:1:<kid>:A256GCM:…', /^sa6e:1:[0-9a-f-]{36}:A256GCM:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(rt.json?.data?.stored ?? ''), rt.json?.data?.stored?.slice(0, 60));
    check('roundtrip: AAD binds the field (other field → unreadable)', rt.json?.data?.aadBound === true);
    check('roundtrip: kek kid = primary of user scope', rt.json?.data?.kekKid && rt.json?.data?.kekKid === rt.json?.data?.primaryKid);
    check('mac: sa6m tagged verifies', /^sa6m:1:/.test(rt.json?.data?.mac ?? '') && rt.json?.data?.macOk === true);
    check('blind index: sa6b:1:<kid>:', /^sa6b:1:[0-9a-f-]{36}:[A-Za-z0-9_-]{40,}$/.test(rt.json?.data?.blindIndex ?? ''), rt.json?.data?.blindIndex?.slice(0, 50));
    const rt2 = await dev('roundtrip', { plaintext: '+77009990001' });
    check('blind index is deterministic', rt2.json?.data?.blindIndex === rt.json?.data?.blindIndex);
    check('ciphertext is randomized (fresh DEK/IV)', rt2.json?.data?.stored !== rt.json?.data?.stored);

    // ===== A4. Ротация подписи =====
    const sig0 = await dev('signing/sign', { audience: 'webhook' });
    check('sign/verify test token (webhook audience)', sig0.ok && sig0.json?.data?.payload?.drill === true && sig0.json?.data?.payload?.aud === 'webhook', JSON.stringify(sig0.json).slice(0, 200));
    const kidBefore = sig0.json?.data?.kid;
    const rot = await dev('signing/rotate', { audience: 'webhook' });
    check('rotate: pending version created', rot.ok && rot.json?.data?.kid && rot.json?.data?.kid !== kidBefore);
    const newKid = rot.json?.data?.kid;
    const wk2 = await (await fetch(`${BASE_ROOT}/.well-known/jwks.json`)).json();
    check('jwks: pending kid already published', (wk2.keys ?? []).some((k) => k.kid === newKid));
    const sig1 = await dev('signing/sign', { audience: 'webhook' });
    check('before activation: signing still uses the old primary', sig1.json?.data?.kid === kidBefore, sig1.json?.data?.kid);
    const act = await dev('signing/activate', { kid: newKid });
    check('activate: pending → active', act.ok && act.json?.data?.activated === true, JSON.stringify(act.json));
    const sig2 = await dev('signing/sign', { audience: 'webhook' });
    check('after activation: new kid signs', sig2.json?.data?.kid === newKid, sig2.json?.data?.kid);
    const ret = await dev('signing/retire', { kid: kidBefore });
    check('retire old version → destroy_scheduled', ret.ok && ret.json?.data?.state === 'destroy_scheduled', JSON.stringify(ret.json));
    const retPrimary = await dev('signing/retire', { kid: newKid });
    check('retire never touches the primary', retPrimary.ok && (await prisma.cryptoKeyVersion.findUnique({ where: { id: newKid } }))?.state === 'active');
    // Восстановление: destroy_scheduled → active (модель Google), потом обратно на вывод
    // (сьют оставляет keystore в естественном состоянии: старая версия на выводе)

    // ===== A5. Ротация KEK + rewrap =====
    const storedBefore = rt.json?.data?.stored;
    const kekRot = await dev('kek/rotate', { type: 'user', id: s1.id });
    check('kek/rotate: new active primary', kekRot.ok && kekRot.json?.data?.kid, JSON.stringify(kekRot.json));
    const rt3 = await dev('roundtrip', { plaintext: 'after-rotation' });
    check('after KEK rotation: new writes use the new kid', rt3.json?.data?.kekKid === kekRot.json?.data?.kid, `${rt3.json?.data?.kekKid} vs ${kekRot.json?.data?.kid}`);
    check('old ciphertext still has old kid (rewrap only touches registered columns)', storedBefore && storedBefore.split(':')[2] !== kekRot.json?.data?.kid);
    // ПДн — зарегистрированные колонки: после ротации KEK человека его `_enc` лежат под НОВОЙ версией,
    // а старая версия выведена только потому, что под ней не осталось ни одной строки
    const piiRow = await prisma.user.findUnique({ where: { id: s1.id }, select: { phoneEnc: true } });
    check('PII rewrap: users.phone_enc moved to the new KEK version', !piiRow?.phoneEnc || piiRow.phoneEnc.split(':')[2] === kekRot.json?.data?.kid, String(piiRow?.phoneEnc).slice(0, 60));
    const strayPii = await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM "contact_invitations" WHERE "from_user_id" = ${s1.id}::uuid AND "to_phone_enc" LIKE 'sa6e:1:%' AND "to_phone_enc" NOT LIKE ${'sa6e:1:' + kekRot.json?.data?.kid + ':%'}`;
    check('PII rewrap: no contact_invitations rows left under old KEK versions', Number(strayPii[0]?.n ?? 0) === 0, JSON.stringify(strayPii));
    const oldVersions = await prisma.cryptoKeyVersion.findMany({ where: { key: { scope: `user:${s1.id}`, purpose: 'kek' }, id: { not: kekRot.json?.data?.kid } }, select: { state: true } });
    check('old KEK versions retired only after the rewrap left nothing under them', oldVersions.every((v) => v.state !== 'active'), JSON.stringify(oldVersions));

    // ===== A6. Заморозка скоупа (kill-switch) =====
    // Версия, выключенная ПОШТУЧНО (подозрение на утечку), заморозку и разморозку скоупа переживает
    // выключенной: разморозка возвращает только то, что выключила сама заморозка (`frozen_from`)
    const singled = await prisma.cryptoKeyVersion.findFirst({ where: { key: { scope: `user:${s1.id}`, purpose: 'kek' }, state: 'destroy_scheduled' } });
    if (singled) await prisma.cryptoKeyVersion.update({ where: { id: singled.id }, data: { state: 'disabled', frozenFrom: null } });
    const fr = await dev('scope/freeze', { type: 'user', id: s1.id });
    check('freeze: versions disabled', fr.ok && fr.json?.data?.versions >= 1, JSON.stringify(fr.json));
    const rtFrozen = await dev('roundtrip', { plaintext: 'frozen?' });
    check('frozen scope: encrypt refused with 403 keys.key_unavailable', rtFrozen.status === 403 && rtFrozen.code === 'keys.key_unavailable', `${rtFrozen.status} ${rtFrozen.code}`);
    const unfr = await dev('scope/unfreeze', { type: 'user', id: s1.id });
    check('unfreeze: versions active again', unfr.ok && unfr.json?.data?.versions >= 1);
    if (singled) {
      const after = await prisma.cryptoKeyVersion.findUnique({ where: { id: singled.id }, select: { state: true } });
      check('unfreeze leaves an individually disabled version disabled', after?.state === 'disabled', after?.state);
      await prisma.cryptoKeyVersion.update({ where: { id: singled.id }, data: { state: 'destroy_scheduled' } });
    }
    const frozenLeft = await prisma.cryptoKeyVersion.count({ where: { key: { scope: `user:${s1.id}` }, frozenFrom: { not: null } } });
    check('unfreeze clears the remembered pre-freeze state', frozenLeft === 0, frozenLeft);
    const rtBack = await dev('roundtrip', { plaintext: 'back' });
    check('after unfreeze: roundtrip works', rtBack.ok && rtBack.json?.data?.roundtripOk === true);

    // ===== A7. Журнал append-only =====
    // Журнал ключей — проекция журнала безопасности (core/audit): категория keys, действие в `op`
    const last = await prisma.securityEvent.findFirst({ where: { eventKey: { startsWith: 'keys.' } }, orderBy: { id: 'desc' } });
    check('audit: entries exist (scope.frozen present)', !!(await prisma.securityEvent.findFirst({ where: { eventKey: 'keys.crypto.scope_frozen', op: 'scope.frozen', targetId: `user:${s1.id}` } })));
    let immutable = false;
    try {
      await prisma.securityEvent.updateMany({ where: { id: last.id, occurredAt: last.occurredAt }, data: { reasonCode: 'tamper' } });
    } catch (e) {
      immutable = /append-only/.test(String(e.message));
    }
    check('audit: UPDATE is refused by trigger', immutable);
    let noDelete = false;
    try {
      await prisma.securityEvent.deleteMany({ where: { id: last.id, occurredAt: last.occurredAt } });
    } catch (e) {
      noDelete = /append-only/.test(String(e.message));
    }
    check('audit: DELETE is refused by trigger', noDelete);

    // ===== A8. Учение восстановления корня =====
    const rootFile = process.env.KEYS_ROOT_KEY_FILE ? path.resolve(process.env.KEYS_ROOT_KEY_FILE) : path.join(__dirname, '..', '.keys', 'root.key');
    const copy = path.join(os.tmpdir(), `sa6-root-copy-${Date.now()}.key`);
    fs.copyFileSync(rootFile, copy);
    let verifyOut = '';
    let verifyCode = 0;
    try {
      verifyOut = execFileSync('node', [path.join(__dirname, 'keys-verify-root.cjs'), copy], { encoding: 'utf8' });
    } catch (e) {
      verifyCode = e.status;
      verifyOut = String(e.stdout || e.message);
    }
    check('keys-verify-root.cjs: a copy of the root opens the keystore', verifyCode === 0 && /recovery rehearsal passed/.test(verifyOut), verifyOut.split('\n').slice(-2).join(' | '));
    const wrong = path.join(os.tmpdir(), `sa6-root-wrong-${Date.now()}.key`);
    fs.writeFileSync(wrong, 'a'.repeat(64) + '\n');
    let wrongCode = 0;
    try {
      execFileSync('node', [path.join(__dirname, 'keys-verify-root.cjs'), wrong], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      wrongCode = e.status;
    }
    check('keys-verify-root.cjs: a wrong copy fails (exit 1)', wrongCode === 1, `exit ${wrongCode}`);
    fs.unlinkSync(copy);
    fs.unlinkSync(wrong);
    const init = execFileSync('node', [path.join(__dirname, 'keys-init-root.cjs'), rootFile], { encoding: 'utf8' });
    check('keys-init-root.cjs never overwrites an existing root', /already exists/.test(init));

    // ============================================================
    // B. Потребители подписи: продукт (EdDSA + kid + typ), refresh reuse-detection,
    //    legacy HS256 на окне, разделение аудиторий, подписанные ссылки файлов
    // ============================================================
    const lg = await call('POST', '/auth/login', null, { phone: SUITE.p2, password: SUITE.password });
    check('login: 200', lg.ok, lg.status);
    const access = lg.json.data.accessToken;
    const refresh = lg.json.data.refreshToken;
    const ah = decodeHeader(access);
    const rh = decodeHeader(refresh);
    const ap = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString());
    check('access token: alg EdDSA + kid + typ at+jwt', ah.alg === 'EdDSA' && /^[0-9a-f-]{36}$/.test(ah.kid ?? '') && ah.typ === 'at+jwt', JSON.stringify(ah));
    check('access token: aud product, exp ≈ 15 min', ap.aud === 'product' && ap.exp - ap.iat === lg.json.data.expiresIn, `${ap.aud} ${ap.exp - ap.iat}`);
    check('refresh token: typ refresh+jwt with jti', rh.typ === 'refresh+jwt' && !!JSON.parse(Buffer.from(refresh.split('.')[1], 'base64url').toString()).jti);
    check('access kid is the primary of the product audience', ah.kid === (st.json?.data?.signing ?? []).find((s) => s.audience === 'product')?.primaryKid);
    const me = await call('GET', '/users/me', access);
    check('access token works on /users/me', me.ok, me.status);
    const asAccess = await call('GET', '/users/me', refresh);
    check('refresh token as access → 401', asAccess.status === 401, asAccess.status);
    const r1 = await call('POST', '/auth/refresh', null, { refreshToken: refresh });
    check('refresh: rotation issues a new pair', r1.ok && r1.json.data.refreshToken !== refresh, r1.status);
    const sessions = await call('GET', '/users/me/sessions', r1.json.data.accessToken);
    const familyRows = await prisma.session.count({ where: { userId: s1.id === ap.sub ? s1.id : ap.sub, rotatedAt: { not: null } } });
    // Список сессий (core/audit) — семейства: прокрученные строки хранятся, но сессия видна ОДНОЙ строкой
    const famRows = (sessions.json?.data?.active ?? []).filter((x) => x.id === ap.fam);
    check('rotated rows are kept in DB but the family is one entry in the device list', familyRows >= 1 && famRows.length === 1, `rotated=${familyRows} entries=${famRows.length}`);
    const r2 = await call('POST', '/auth/refresh', null, { refreshToken: refresh });
    check('reuse within grace (network retry): still 200', r2.ok, r2.status);
    console.log('  waiting 11 s for the reuse grace window…');
    await sleep(11_000);
    const r3 = await call('POST', '/auth/refresh', null, { refreshToken: refresh });
    check('reuse after grace → 401 (family revoked)', r3.status === 401, r3.status);
    const r4 = await call('POST', '/auth/refresh', null, { refreshToken: r1.json.data.refreshToken });
    check('the latest refresh of the family is dead too', r4.status === 401, r4.status);
    const reuseNotif = await prisma.notificationEvent.findFirst({ where: { type: 'auth.session.reuseDetected' }, orderBy: { createdAt: 'desc' } });
    check('auth.session.reuseDetected notification created', !!reuseNotif && Date.now() - reuseNotif.createdAt.getTime() < 60_000);

    // legacy HS256 (JWT_SECRET из .env, окно открыто в dev)
    const crypto = require('crypto');
    const legacySecret = process.env.JWT_SECRET_LEGACY || process.env.JWT_SECRET;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const hs = (secret, header, payload) => {
      const input = `${b64(header)}.${b64(payload)}`;
      return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
    };
    const now = Math.floor(Date.now() / 1000);
    const u2 = await prisma.user.findUnique({ where: { id: ap.sub }, select: { tokenEpoch: true } });
    const legacyPayload = { sub: ap.sub, phone: SUITE.p2, role: 'user', epoch: u2.tokenEpoch, sid: ap.sid, iat: now, exp: now + 600 };
    const legacyOk = await call('GET', '/users/me', hs(legacySecret, { alg: 'HS256', typ: 'JWT' }, legacyPayload));
    check('legacy HS256 access token (no aud) accepted on the migration window', legacyOk.ok, legacyOk.status);
    const legacyBad = await call('GET', '/users/me', hs('wrong-secret-wrong-secret-wrong', { alg: 'HS256', typ: 'JWT' }, legacyPayload));
    check('HS256 with a wrong secret → 401', legacyBad.status === 401, legacyBad.status);
    const noneTok = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(legacyPayload)}.`;
    const noneRes = await call('GET', '/users/me', noneTok);
    check('alg:none → 401', noneRes.status === 401, noneRes.status);
    const jwkTok = hs(legacySecret, { alg: 'HS256', jwk: { kty: 'oct', k: 'x' } }, legacyPayload);
    check('header with jwk → 401', (await call('GET', '/users/me', jwkTok)).status === 401);
    const platAud = await call('GET', '/users/me', hs(legacySecret, { alg: 'HS256' }, { ...legacyPayload, aud: 'platform' }));
    check('HS256 token with aud=platform rejected by the product', platAud.status === 401, platAud.status);

    // Кабинет платформы: свой ключ, свой typ — токены не взаимозаменяемы
    const { consoleLogin } = require('./_lib.cjs');
    const cl = await consoleLogin(SUITE.p1);
    if (cl.token) {
      const ph = decodeHeader(cl.token);
      check('platform token: EdDSA + typ platform+jwt + aud platform', ph.alg === 'EdDSA' && ph.typ === 'platform+jwt' && JSON.parse(Buffer.from(cl.token.split('.')[1], 'base64url').toString()).aud === 'platform', JSON.stringify(ph));
      check('platform token on a product route → 401', (await call('GET', '/users/me', cl.token)).status === 401);
      check('product token on a platform route → 401', (await call('GET', '/platform/me', s1.token)).status === 401);
      check('platform token on /platform/me → 200', (await call('GET', '/platform/me', cl.token)).ok);
    } else {
      console.log('  (suite1 is not platform staff — console checks skipped)');
    }

    // Подписанные ссылки файлов: k=<kid> + Ed25519, legacy HMAC на окне
    const bytes = Buffer.from('keys-suite-file ' + Date.now());
    const initF = await call('POST', '/files', s1.token, { profile: 'generic', name: 'k.txt', mime: 'text/plain', size: bytes.length });
    if (initF.ok) {
      const fid = initF.json.data.file.id;
      const fd = new FormData();
      fd.append('file', new Blob([bytes], { type: 'text/plain' }), 'k.txt');
      const BASE = process.env.SA6_API_BASE || process.env.API_URL || process.env.API_BASE || 'http://localhost:3001/api';
      await fetch(`${BASE}/files/${fid}/content`, { method: 'PUT', headers: { Authorization: 'Bearer ' + s1.token }, body: fd });
      await call('POST', `/files/${fid}/complete`, s1.token, {});
      const dl = await call('GET', `/files/${fid}/download`, s1.token);
      const url = dl.json?.data?.url ?? '';
      check('download url carries k=<kid> and sig', /[?&]k=[0-9a-f-]{36}/.test(url) && /[?&]sig=/.test(url), url.slice(0, 120));
      const got = await fetch(url);
      check('signed url serves the bytes (200)', got.status === 200, got.status);
      // Портим НАЧАЛО подписи: хвост — старший байт скаляра S у Ed25519, он < 0x10 и в 1 случае из 16
      // равен нулю — замена хвоста на «AA» тогда даёт ту же самую подпись, и проверка мигала
      const tampered = await fetch(url.replace(/sig=([A-Za-z0-9_-]+)/, (m, v) => `sig=${v[0] === 'A' ? 'B' : 'A'}${v.slice(1)}`));
      check('tampered signature → 403', tampered.status === 403, tampered.status);
      const u = new URL(url);
      const exp = Number(u.searchParams.get('exp'));
      const legacyKey = crypto.createHash('sha256').update(`files:${legacySecret}`).digest();
      const legacySig = crypto.createHmac('sha256', legacyKey).update(`${fid}:original:${exp}`).digest('base64url');
      const legacyUrl = `${u.origin}${u.pathname}?exp=${exp}&sig=${legacySig}`;
      check('legacy HMAC url (no k) accepted on the window', (await fetch(legacyUrl)).status === 200);
    } else {
      check('files init (attachment profile)', false, JSON.stringify(initF.json).slice(0, 200));
    }

    // ============================================================
    // C. Секреты: карты и креды Процессов — envelope в БД, legacy-строки перешиты джобом
    // ============================================================
    // Полного номера карты в продукте нет ни у кого (core/visibility R11, PCI DSS 3.4.1): круговое
    // шифрование проверяется IBAN карт-счёта — он читается владельцу, а PAN — только маской
    const IBAN = 'KZ86125KZT5004100100';
    const card = await call('POST', '/wallet/cards', s1.token, { pan: '4111111111111111', iban: IBAN, holderName: 'KEYS SUITE', expMonth: 12, expYear: 2031 });
    if (card.ok) {
      const row = await prisma.userPaymentCard.findUnique({ where: { id: card.json.data.id } });
      check('card PAN stored as envelope sa6e:', row?.panEncrypted?.startsWith('sa6e:1:') === true, row?.panEncrypted?.slice(0, 12));
      check('card IBAN stored as envelope sa6e:', row?.ibanEncrypted?.startsWith('sa6e:1:') === true, row?.ibanEncrypted?.slice(0, 12));
      const list = await call('GET', '/wallet/cards', s1.token);
      const mine = (list.json?.data ?? []).find((c) => c.id === card.json.data.id);
      check('card IBAN decrypts back for the owner', mine?.iban === IBAN, mine?.iban);
      check('R11: full PAN is never on the wire (even to the owner) — only last-4 mask', !!mine && !('pan' in mine) && /1111$/.test(mine.panMasked ?? '') && !JSON.stringify(list.json).includes('4111111111111111'));
      // legacy-строка: старый AES производным ключом → джоб перешивает → API читает
      const legacyKey = crypto.createHash('sha256').update(`field:payment-card:${legacySecret}`).digest();
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
      const enc = Buffer.concat([c.update('4242424242424242', 'utf8'), c.final()]);
      const legacyStored = `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
      // IBAN тем же прежним шифром — его и читаем (PAN наружу не отдаётся никогда)
      const iv2 = crypto.randomBytes(12);
      const c2 = crypto.createCipheriv('aes-256-gcm', legacyKey, iv2);
      const enc2 = Buffer.concat([c2.update(IBAN, 'utf8'), c2.final()]);
      const legacyIban = `${iv2.toString('base64')}.${c2.getAuthTag().toString('base64')}.${enc2.toString('base64')}`;
      const legacyCard = await prisma.userPaymentCard.create({ data: { userId: s1.id, panEncrypted: legacyStored, ibanEncrypted: legacyIban, panLast4: '0001', holderName: 'LEGACY', expMonth: 1, expYear: 2030 } });
      const before = await call('GET', '/wallet/cards', s1.token);
      check('legacy card readable before re-encrypt (window open)', (before.json?.data ?? []).some((x) => x.id === legacyCard.id && x.iban === IBAN));
      const re = await dev('legacy/reencrypt', {});
      check('legacy/reencrypt: ≥1 row', re.ok && re.json?.data?.rows >= 1, JSON.stringify(re.json));
      const after = await prisma.userPaymentCard.findUnique({ where: { id: legacyCard.id } });
      check('legacy card re-encrypted into envelope', after?.panEncrypted?.startsWith('sa6e:1:') === true);
      const afterList = await call('GET', '/wallet/cards', s1.token);
      check('re-encrypted card still decrypts to the same value', (afterList.json?.data ?? []).some((x) => x.id === legacyCard.id && x.iban === IBAN));
      await call('DELETE', `/wallet/cards/${legacyCard.id}`, s1.token);
      await call('DELETE', `/wallet/cards/${card.json.data.id}`, s1.token);
    } else {
      check('card create', false, JSON.stringify(card.json).slice(0, 200));
    }

    // Кред Процессов: envelope с KEK организации
    const ws = await createSuiteWorkspace(s1.token, 'Сьют-Ключи');
    if (ws.ok) {
      const wsId = ws.json.data.id;
      const cred = await call('POST', `/workspaces/${wsId}/processes/credentials`, s1.token, { name: 'suite', type: 'bearer', token: 'tok-secret-123' }, { 'X-Workspace-Id': wsId });
      check('process credential created', cred.ok, `${cred.status} ${JSON.stringify(cred.json).slice(0, 120)}`);
      if (cred.ok) {
        const crow = await prisma.processCredential.findUnique({ where: { id: cred.json.data.id } });
        check('credential stored as envelope under the workspace KEK', crow?.data?.startsWith('sa6e:1:') === true);
        const kek = await prisma.cryptoKey.findUnique({ where: { scope_purpose_name: { scope: `workspace:${wsId}`, purpose: 'kek', name: 'default' } } });
        check('workspace KEK created lazily on first encrypt', !!kek?.primaryVersionId && crow.data.split(':')[2] === kek.primaryVersionId);
      }
      // OTP-код: хеш нового формата sa6m:
      const otp = await call('POST', '/verify/start', null, { phone: '+77009990009', purpose: 'register' });
      if (otp.ok) {
        const ch = await prisma.verifyChallenge.findUnique({ where: { id: otp.json.data.challengeId } });
        check('OTP code hash uses the verify_otp mac key (sa6m:)', ch?.codeHash?.startsWith('sa6m:1:') === true, ch?.codeHash?.slice(0, 12));
      }
      await archiveSuiteWorkspace(wsId);
    } else {
      check('workspace create', false, JSON.stringify(ws.json).slice(0, 200));
    }
    // Токены вебхуков Процессов: в БД только хеш (64 hex) + envelope
    const hooks = await prisma.processTrigger.findMany({ where: { webhookToken: { not: null } }, select: { webhookToken: true, webhookTokenEnc: true }, take: 50 });
    check('process webhook tokens are hashed (no raw token in DB)', hooks.every((h) => /^[0-9a-f]{64}$/.test(h.webhookToken) && !!h.webhookTokenEnc), `rows=${hooks.length}`);

    // ===== E. Боты, ключи API, реестр, каскады =====
    {
      const s2 = await login(SUITE.p2);
      const KEY_RE = /^sa6_(bot|pat)_test_[0-9A-Za-z]{43}_[0-9A-Za-z]{6}$/;
      // Step-up окна управления ключами: пароль + SMS-код (purpose keys_manage) → 15 минут
      const stepUp = async (s) => {
        const st = await call('POST', '/verify/step-up', s.token, { purpose: 'keys_manage', password: SUITE.password });
        if (!st.ok) return st;
        const code = await devCode(st.json.data.challengeId);
        const chk = await call('POST', '/verify/check', null, { challengeId: st.json.data.challengeId, code });
        if (!chk.ok) return chk;
        return call('POST', '/keys/step-up/confirm', s.token, { verifyToken: chk.json.data.verifyToken });
      };
      const flipLast = (secret) => secret.slice(0, -8) + (secret.slice(-8, -7) === 'a' ? 'b' : 'a') + secret.slice(-7);

      const wsE = await createSuiteWorkspace(s1.token, 'Сьют-Ключи-Боты');
      check('E: workspace created', wsE.ok, wsE.status);
      const W = wsE.json?.data?.id;
      const WSH = { 'X-Workspace-Id': W };
      // suite2 — рядовой член (trainee)
      const inv = await call('POST', `/workspaces/${W}/invitations`, s1.token, { phone: SUITE.p2 });
      const incoming = await call('GET', '/workspaces/invitations/incoming', s2.token);
      const invId = (incoming.json?.data ?? []).find((i) => i.workspaceId === W)?.id ?? inv.json?.data?.id;
      const acc = await call('POST', `/workspaces/invitations/${invId}/accept`, s2.token);
      check('E: suite2 joined as trainee', acc.ok, `${inv.status}/${acc.status}`);

      // --- Роль: реестр и ключи организации — только owner/admin ---
      const regDenied = await call('GET', `/workspaces/${W}/keys/registry`, s2.token);
      check('registry: trainee → 403 keys.role_required', regDenied.status === 403 && regDenied.code === 'keys.role_required', `${regDenied.status} ${regDenied.code}`);
      const regEmpty = await call('GET', `/workspaces/${W}/keys/registry`, s1.token);
      check('registry: owner → 200, empty page', regEmpty.ok && Array.isArray(regEmpty.json?.data?.items) && regEmpty.json.data.items.length === 0, JSON.stringify(regEmpty.json).slice(0, 120));
      const matrix = await call('GET', '/keys/scope-matrix', s1.token);
      check('scope-matrix: services with bot flags (tasks bot, messenger no)', matrix.ok && matrix.json.data.services.some((r) => r.service === 'tasks' && r.bot) && matrix.json.data.services.some((r) => r.service === 'messenger' && !r.bot));

      // --- Step-up: без окна — 403 ---
      const botInput = { name: 'Suite bot', purpose: 'e2e: tasks sync', rank: 'member', scopes: { tasks: 'write', documents: 'read' }, expiresInDays: 30 };
      await call('POST', '/keys/step-up/end', s1.token, {});
      const noStep = await call('POST', `/workspaces/${W}/keys/bots`, s1.token, botInput);
      check('bot create without step-up → 403 keys.step_up_required', noStep.status === 403 && noStep.code === 'keys.step_up_required', `${noStep.status} ${noStep.code}`);
      const su = await stepUp(s1);
      check('step-up confirmed (keys_manage) → window', su.ok && !!su.json?.data?.until, `${su.status} ${JSON.stringify(su.json).slice(0, 120)}`);
      const suSt = await call('GET', '/keys/step-up', s1.token);
      check('step-up status: until in the future', suSt.ok && Date.parse(suSt.json.data.until) > Date.now());

      // --- Бот: создание = бот + теневой пользователь + роль + ключ (show-once) ---
      const bot = await call('POST', `/workspaces/${W}/keys/bots`, s1.token, botInput);
      check('bot created (201) with show-once secret', bot.status === 201 && typeof bot.json?.data?.secret === 'string', `${bot.status} ${JSON.stringify(bot.json).slice(0, 200)}`);
      const botSecret = bot.json?.data?.secret ?? '';
      const botId = bot.json?.data?.bot?.id;
      const botUserId = bot.json?.data?.bot?.userId;
      const botKeyId = bot.json?.data?.key?.id;
      check('secret format sa6_bot_test_<43 base62>_<crc6>', KEY_RE.test(botSecret) && botSecret.startsWith('sa6_bot_test_'), botSecret.slice(0, 20));
      check('key DTO carries prefix/last4 only, never the secret', bot.json?.data?.key?.prefix && bot.json?.data?.key?.last4 && !JSON.stringify(bot.json.data.key).includes(botSecret.slice(20, 40)));
      const keyRow = botKeyId ? await prisma.apiKey.findUnique({ where: { id: botKeyId } }) : null;
      check('DB stores an HMAC hash (64 hex), not the secret', !!keyRow && /^[0-9a-f]{64}$/.test(keyRow.hash) && keyRow.hash !== botSecret, keyRow?.hash?.slice(0, 12));
      const botUser = botUserId ? await prisma.user.findUnique({ where: { id: botUserId }, select: { kind: true, phone: true, password: true, roles: { where: { context: 'workspace', tenantId: W, isActive: true }, select: { role: true } } } }) : null;
      check('shadow user: kind=bot, phone bot:<id>, no usable password, role staff in the workspace', botUser?.kind === 'bot' && botUser?.phone === `bot:${botUserId}` && botUser?.password === '!' && botUser?.roles?.some((r) => r.role === 'staff'), JSON.stringify(botUser));
      const botLogin = await call('POST', '/auth/login', null, { phone: `bot:${botUserId}`, password: '!' });
      check('bot cannot log in with a password', botLogin.status === 401 || botLogin.status === 400, botLogin.status);

      // --- Ключ бота работает: личность, скоупы, организация ---
      const me = await call('GET', '/users/me', botSecret);
      check('GET /users/me with the bot key → 200, kind=bot', me.ok && me.json?.data?.kind === 'bot' && me.json?.data?.id === botUserId, `${me.status} ${me.code}`);
      const botTask = await call('POST', '/tasks', botSecret, { title: 'created by bot key', executorId: s1.id });
      check('bot key: POST /tasks (tasks:write) → 201 in the key workspace', botTask.status === 201 && botTask.json?.data?.workspaceId === W, `${botTask.status} ${botTask.code} ws=${botTask.json?.data?.workspaceId}`);
      const botTaskWs = await call('POST', '/tasks', botSecret, { title: 'bot with header' }, WSH);
      check('bot key + matching X-Workspace-Id → ok', botTaskWs.status === 201, `${botTaskWs.status} ${botTaskWs.code}`);
      const mismatch = await call('GET', '/tasks', botSecret, undefined, { 'X-Workspace-Id': '00000000-0000-4000-8000-000000000000' });
      check('bot key + foreign X-Workspace-Id → 403 keys.workspace_mismatch', mismatch.status === 403 && mismatch.code === 'keys.workspace_mismatch', `${mismatch.status} ${mismatch.code}`);
      const noScope = await call('GET', `/workspaces/${W}/counterparties`, botSecret);
      check('bot key: service outside scopes → 403 keys.scope.denied', noScope.status === 403 && noScope.code === 'keys.scope.denied', `${noScope.status} ${noScope.code}`);
      const botClosed = await call('GET', '/messenger/chats', botSecret);
      check('bot key: people-only service (messenger) → 403 keys.scope.denied', botClosed.status === 403 && botClosed.code === 'keys.scope.denied', `${botClosed.status} ${botClosed.code}`);
      const docsWrite = await call('POST', `/workspaces/${W}/documents`, botSecret, { title: 'x' });
      check('bot key: documents:read → POST denied by scope level', docsWrite.status === 403 && docsWrite.code === 'keys.scope.denied', `${docsWrite.status} ${docsWrite.code}`);
      const manageWithKey = await call('GET', `/workspaces/${W}/keys/registry`, botSecret);
      check('keys cannot manage keys (@NoApiKeys) → 403', manageWithKey.status === 403 && manageWithKey.code === 'keys.scope.denied', `${manageWithKey.status} ${manageWithKey.code}`);
      // Реестр скоупов — явный белый список: реквизиты (IBAN) и приглашения (номера) ботам закрыты,
      // настройка уведомлений — только живой сессией; catch-all `/workspaces` больше нет
      const botRequisites = await call('GET', `/workspaces/${W}/requisites`, botSecret);
      check('bot key: /workspaces/:id/requisites (people-only service) → 403 keys.scope.denied', botRequisites.status === 403 && botRequisites.code === 'keys.scope.denied', `${botRequisites.status} ${botRequisites.code}`);
      const botInvites = await call('GET', `/workspaces/${W}/invitations`, botSecret);
      check('bot key: /workspaces/:id/invitations → 403 keys.scope.denied', botInvites.status === 403 && botInvites.code === 'keys.scope.denied', `${botInvites.status} ${botInvites.code}`);
      const botPolicy = await call('GET', `/workspaces/${W}/notification-policy`, botSecret);
      check('bot key: /workspaces/:id/notification-policy (@NoApiKeys) → 403', botPolicy.status === 403 && botPolicy.code === 'keys.scope.denied', `${botPolicy.status} ${botPolicy.code}`);
      const bad = await call('GET', '/users/me', flipLast(botSecret));
      check('tampered secret (crc mismatch) → 401 keys.invalid', bad.status === 401 && bad.code === 'keys.invalid', `${bad.status} ${bad.code}`);

      // --- Использование: last_used / журнал обращений (батч через Redis) ---
      const fl = await dev('usage/flush', {});
      check('dev usage/flush ran', fl.ok, JSON.stringify(fl.json).slice(0, 100));
      const used = await prisma.apiKey.findUnique({ where: { id: botKeyId }, select: { lastUsedAt: true, useCount: true } });
      check('last_used_at + use_count written after flush', !!used?.lastUsedAt && used.useCount >= 3, JSON.stringify(used));
      const accessRows = await prisma.apiAccessLog.count({ where: { keyId: botKeyId } });
      check('api_access_log has rows for the key (route templates, statuses)', accessRows >= 3, accessRows);
      const logged = await prisma.apiAccessLog.findFirst({ where: { keyId: botKeyId, route: '/tasks', method: 'POST' } });
      check('access log stores a route template (/tasks) with status', !!logged && logged.status === 201, logged ? `${logged.method} ${logged.route} ${logged.status}` : 'none');
      const deniedLogged = await prisma.apiAccessLog.findFirst({ where: { keyId: botKeyId, status: 403 } });
      check('scope denials are logged too (403 rows)', !!deniedLogged, deniedLogged ? deniedLogged.route : 'none');

      // --- Хроника: актор-бот несёт kind=bot ---
      if (botTask.ok) {
        const chron = await call('GET', `/chatter/task/${botTask.json.data.id}`, s1.token, undefined, WSH);
        const actors = chron.json?.data?.actors ?? {};
        check('chatter actors expose kind=bot for the bot actor', chron.ok && actors[botUserId]?.kind === 'bot', `${chron.status} ${JSON.stringify(actors[botUserId] ?? null)}`);
      }

      // --- Заморозка / разморозка (owner, step-up) ---
      const frz = await call('POST', `/workspaces/${W}/keys/bots/${botId}/freeze`, s1.token);
      check('bot frozen by owner', frz.ok && frz.json?.data?.status === 'frozen' && frz.json?.data?.frozenReason === 'owner', `${frz.status} ${frz.code}`);
      const frozenCall = await call('GET', '/users/me', botSecret);
      check('frozen bot key → 403 keys.bot.frozen', frozenCall.status === 403 && frozenCall.code === 'keys.bot.frozen', `${frozenCall.status} ${frozenCall.code}`);
      const pend = await call('GET', `/workspaces/${W}/keys/pending`, s1.token);
      check('pending: 1 frozen bot (header badge)', pend.ok && pend.json?.data?.frozenBots === 1, JSON.stringify(pend.json?.data));
      const unfrzTrainee = await call('POST', `/workspaces/${W}/keys/bots/${botId}/unfreeze`, s2.token, {});
      check('trainee cannot unfreeze → 403', unfrzTrainee.status === 403, unfrzTrainee.status);
      const unfrz = await call('POST', `/workspaces/${W}/keys/bots/${botId}/unfreeze`, s1.token, { note: 'suite' });
      check('owner unfreezes (step-up window open)', unfrz.ok && unfrz.json?.data?.status === 'active', `${unfrz.status} ${unfrz.code}`);
      const afterUnfrz = await call('GET', '/users/me', botSecret);
      check('bot key works again after unfreeze (cache invalidated)', afterUnfrz.ok, afterUnfrz.status);

      // --- IP-allowlist: чужой адрес → 403 ---
      const ipBot = await call('POST', `/workspaces/${W}/keys/bots`, s1.token, { name: 'Allowlist bot', purpose: 'e2e: allowlist', rank: 'member', scopes: { tasks: 'read' }, ipAllowlist: ['10.0.0.0/8'], expiresInDays: 5 });
      check('bot with IP allowlist created', ipBot.status === 201, `${ipBot.status} ${ipBot.code}`);
      const ipDenied = await call('GET', '/users/me', ipBot.json?.data?.secret ?? '');
      check('request from an address outside the allowlist → 403 keys.ip.denied', ipDenied.status === 403 && ipDenied.code === 'keys.ip.denied', `${ipDenied.status} ${ipDenied.code}`);
      const noExpiryAdmin = await call('POST', `/workspaces/${W}/keys/bots`, s1.token, { name: 'Forever', purpose: 'e2e', rank: 'member', scopes: { tasks: 'read' }, noExpiry: true });
      check('noExpiry without allowlist → 400 keys.no_expiry_needs_allowlist', noExpiryAdmin.status === 400 && noExpiryAdmin.code === 'keys.no_expiry_needs_allowlist', `${noExpiryAdmin.status} ${noExpiryAdmin.code}`);

      // --- Ротация с перекрытием, семейство ≤ 2, отзыв ---
      const rot = await call('POST', `/workspaces/${W}/keys/keys/${botKeyId}/rotate`, s1.token, { graceHours: 1 });
      check('rotate: new secret, same family, old in grace', rot.ok && KEY_RE.test(rot.json?.data?.secret ?? '') && rot.json?.data?.key?.familyId === keyRow?.familyId && rot.json?.data?.key?.rotatedFromId === botKeyId, `${rot.status} ${rot.code}`);
      const newSecret = rot.json?.data?.secret ?? '';
      const newKeyId = rot.json?.data?.key?.id;
      const oldStill = await call('GET', '/users/me', botSecret);
      const newWorks = await call('GET', '/users/me', newSecret);
      check('old secret still works through the grace window; new works', oldStill.ok && newWorks.ok, `${oldStill.status}/${newWorks.status}`);
      const rot2 = await call('POST', `/workspaces/${W}/keys/keys/${newKeyId}/rotate`, s1.token, { graceHours: 1 });
      check('third live secret in the family → 409 keys.family_full', rot2.status === 409 && rot2.code === 'keys.family_full', `${rot2.status} ${rot2.code}`);
      const rev = await call('POST', `/workspaces/${W}/keys/keys/${botKeyId}/revoke`, s1.token, { reason: 'owner', note: 'suite' });
      check('revoke old key', rev.ok && rev.json?.data?.status === 'revoked', `${rev.status} ${rev.code}`);
      const revoked = await call('GET', '/users/me', botSecret);
      check('revoked secret → 401 keys.revoked (cache invalidated)', revoked.status === 401 && revoked.code === 'keys.revoked', `${revoked.status} ${revoked.code}`);
      const verifyRevoked = await call('POST', '/keys/verify', null, { key: botSecret });
      const verifyLive = await call('POST', '/keys/verify', null, { key: newSecret });
      const verifyGet = await call('GET', `/keys/verify?key=${encodeURIComponent(newSecret)}`, null);
      check('GET /keys/verify (secret in URL) is gone → 404', verifyGet.status === 404, `${verifyGet.status} ${verifyGet.code}`);
      check('POST /keys/verify: revoked=false, live=true, kind only', verifyRevoked.ok && verifyRevoked.json.data.valid === false && verifyLive.ok && verifyLive.json.data.valid === true && verifyLive.json.data.kind === 'bot' && !('id' in verifyLive.json.data));

      // --- Личный ключ для собственных данных (любой человек, step-up) ---
      const su2 = await stepUp(s2);
      check('suite2 step-up', su2.ok, su2.status);
      const pat = await call('POST', '/keys/personal', s2.token, { name: 'My script', purpose: 'e2e: read my tasks', scopes: { tasks: 'read' }, expiresInDays: 30 });
      check('personal key created (sa6_pat_test_…)', pat.status === 201 && /^sa6_pat_test_/.test(pat.json?.data?.secret ?? ''), `${pat.status} ${pat.code}`);
      const patSecret = pat.json?.data?.secret ?? '';
      const patMe = await call('GET', '/users/me', patSecret);
      check('personal key: /users/me → the person (kind=user)', patMe.ok && patMe.json?.data?.id === s2.id && patMe.json?.data?.kind === 'person', `${patMe.status} ${patMe.code}`);
      const patList = await call('GET', '/tasks', patSecret);
      check('personal key: GET /tasks (tasks:read) → 200', patList.ok, `${patList.status} ${patList.code}`);
      const patWrite = await call('POST', '/tasks', patSecret, { title: 'x' });
      check('personal key: POST /tasks with read scope → 403 keys.scope.denied', patWrite.status === 403 && patWrite.code === 'keys.scope.denied', `${patWrite.status} ${patWrite.code}`);
      const patWs = await call('GET', '/tasks', patSecret, undefined, WSH);
      check('personal key with X-Workspace-Id → 403 keys.personal_needs_workspace', patWs.status === 403 && patWs.code === 'keys.personal_needs_workspace', `${patWs.status} ${patWs.code}`);
      // --- Потолки ключа: обращений в минуту (429 keys.rate_limited) и строк выгрузки в сутки (429 keys.export_cap) ---
      const patKeyId = pat.json?.data?.key?.id;
      const seedRate = await dev('usage/throttle', { keyId: patKeyId, kind: 'rate', value: 600 });
      check('dev: rate bucket seeded to the limit', seedRate.ok, `${seedRate.status} ${seedRate.code}`);
      const rateHit = await call('GET', '/tasks', patSecret);
      check('key over requestsPerMinute → 429 keys.rate_limited', rateHit.status === 429 && rateHit.code === 'keys.rate_limited', `${rateHit.status} ${rateHit.code}`);
      await dev('usage/throttle', { keyId: patKeyId, kind: 'rate', value: 0 });
      const rateBack = await call('GET', '/tasks', patSecret);
      check('rate bucket cleared → 200 again', rateBack.ok, `${rateBack.status} ${rateBack.code}`);
      let throttledNotif = null;
      for (let i = 0; i < 16; i++) {
        throttledNotif = await call('GET', '/notifications?limit=20', s2.token);
        if ((throttledNotif.json?.data?.items ?? []).some((n) => n.type === 'key.throttled')) break;
        await sleep(500);
      }
      check('key.throttled notification reached the holder (once per day)', throttledNotif?.ok && (throttledNotif.json?.data?.items ?? []).some((n) => n.type === 'key.throttled'), (throttledNotif?.json?.data?.items ?? []).map((n) => n.type).slice(0, 8).join(','));
      const seedExport = await dev('usage/throttle', { keyId: patKeyId, kind: 'export', value: 200000 });
      check('dev: export counter seeded to the cap', seedExport.ok, `${seedExport.status} ${seedExport.code}`);
      const exportHit = await call('GET', '/tasks', patSecret);
      check('key over exportRowsPerDay → 429 keys.export_cap (reads only)', exportHit.status === 429 && exportHit.code === 'keys.export_cap', `${exportHit.status} ${exportHit.code}`);
      const exportMe = await call('GET', '/users/me', patSecret);
      check('export cap: GET /users/me is also a read → 429', exportMe.status === 429, `${exportMe.status} ${exportMe.code}`);
      await dev('usage/throttle', { keyId: patKeyId, kind: 'export', value: 0 });
      const exportBack = await call('GET', '/tasks', patSecret);
      check('export counter cleared → 200 again', exportBack.ok, `${exportBack.status} ${exportBack.code}`);
      const patOrgDenied = await call('POST', `/workspaces/${W}/keys/keys`, s2.token, { name: 'org', purpose: 'e2e', scopes: { tasks: 'read' } });
      check('trainee cannot create a key for organization data → 403 keys.role_required', patOrgDenied.status === 403 && patOrgDenied.code === 'keys.role_required', `${patOrgDenied.status} ${patOrgDenied.code}`);

      // --- Утечка: сканер → отзыв + уведомление ---
      const leaked = await call('POST', '/keys/leaked', null, [{ token: patSecret, source: 'suite-scanner', url: 'https://example.com/gist' }]);
      check('POST /keys/leaked → revoked 1', leaked.ok && leaked.json?.data?.revoked === 1, JSON.stringify(leaked.json));
      const leakedCall = await call('GET', '/users/me', patSecret);
      check('leaked key is dead', leakedCall.status === 401 && leakedCall.code === 'keys.revoked', `${leakedCall.status} ${leakedCall.code}`);
      // Фанаут уведомлений — джобом после коммита: ждём до 8 с
      let notif = null;
      for (let i = 0; i < 16; i++) {
        notif = await call('GET', '/notifications?limit=20', s2.token);
        if ((notif.json?.data?.items ?? []).some((n) => n.type === 'key.leaked')) break;
        await sleep(500);
      }
      check('key.leaked notification reached the holder', notif?.ok && (notif.json?.data?.items ?? []).some((n) => n.type === 'key.leaked'), (notif?.json?.data?.items ?? []).map((n) => n.type).slice(0, 8).join(','));

      // --- Каскад: админ с ключами уходит (понижение → исключение) ---
      const promote = await call('PATCH', `/workspaces/${W}/members/${s2.id}`, s1.token, { role: 'admin' });
      check('suite2 promoted to admin', promote.ok, `${promote.status} ${promote.code}`);
      const adminPat = await call('POST', `/workspaces/${W}/keys/keys`, s2.token, { name: 'admin org key', purpose: 'e2e: org', scopes: { tasks: 'read' } });
      check('admin creates a personal key for organization data', adminPat.status === 201, `${adminPat.status} ${adminPat.code}`);
      // Личный ключ действует от имени держателя: владелец организации (не держатель) может его
      // только отозвать — перевыпуск отдал бы ЕМУ секрет с правами и именем другого человека
      const foreignRotate = await call('POST', `/workspaces/${W}/keys/keys/${adminPat.json?.data?.key?.id}/rotate`, s1.token, { graceHours: 0 });
      check('rotate of another person PAT → 403 keys.holder_only', foreignRotate.status === 403 && foreignRotate.code === 'keys.holder_only', `${foreignRotate.status} ${foreignRotate.code}`);
      const foreignPatch = await call('PATCH', `/workspaces/${W}/keys/keys/${adminPat.json?.data?.key?.id}`, s1.token, { ipAllowlist: [] });
      check('update of another person PAT → 403 keys.holder_only', foreignPatch.status === 403 && foreignPatch.code === 'keys.holder_only', `${foreignPatch.status} ${foreignPatch.code}`);
      const stillAlive = await call('GET', '/users/me', adminPat.json?.data?.secret ?? '');
      check('refused rotate left the key of its holder intact', stillAlive.ok, `${stillAlive.status} ${stillAlive.code}`);
      const wideCidr = await call('POST', `/workspaces/${W}/keys/keys`, s2.token, { name: 'wide', purpose: 'e2e: wide cidr', scopes: { tasks: 'read' }, ipAllowlist: ['0.0.0.0/0'] });
      check('allowlist 0.0.0.0/0 → 400 (a list that admits everyone is not a list)', wideCidr.status === 400, `${wideCidr.status} ${wideCidr.code}`);
      const adminBot = await call('POST', `/workspaces/${W}/keys/bots`, s2.token, { name: 'Admin bot', purpose: 'e2e: admin', rank: 'manager', scopes: { tasks: 'write' }, responsibleUserId: s2.id });
      check('admin creates a bot (rank manager → role manager)', adminBot.status === 201, `${adminBot.status} ${adminBot.code}`);
      const adminBotRole = adminBot.ok ? await prisma.userRole.findFirst({ where: { userId: adminBot.json.data.bot.userId, context: 'workspace', tenantId: W, isActive: true } }) : null;
      check('manager bot projected as role manager', adminBotRole?.role === 'manager', adminBotRole?.role);
      const demote = await call('PATCH', `/workspaces/${W}/members/${s2.id}`, s1.token, { role: 'staff' });
      check('suite2 demoted to staff', demote.ok, `${demote.status} ${demote.code}`);
      const adminPatDead = await call('GET', '/users/me', adminPat.json?.data?.secret ?? '');
      check('demoted admin: organization key revoked (member_left)', adminPatDead.status === 401 && adminPatDead.code === 'keys.revoked', `${adminPatDead.status} ${adminPatDead.code}`);
      const adminBotFrozen = await call('GET', '/users/me', adminBot.json?.data?.secret ?? '');
      check('demoted admin: his bot frozen (creator_left)', adminBotFrozen.status === 403 && adminBotFrozen.code === 'keys.bot.frozen', `${adminBotFrozen.status} ${adminBotFrozen.code}`);
      const frozenRow = adminBot.ok ? await prisma.bot.findUnique({ where: { id: adminBot.json.data.bot.id } }) : null;
      check('bot row: frozen, reason creator_left, responsible cleared', frozenRow?.status === 'frozen' && frozenRow?.frozenReason === 'creator_left' && frozenRow?.responsibleUserId === null, JSON.stringify({ s: frozenRow?.status, r: frozenRow?.frozenReason, resp: frozenRow?.responsibleUserId }));
      let ownerNotif = null;
      for (let i = 0; i < 16; i++) {
        ownerNotif = await call('GET', '/notifications?limit=30', s1.token, undefined, WSH);
        if ((ownerNotif.json?.data?.items ?? []).some((n) => n.type === 'bot.frozen')) break;
        await sleep(500);
      }
      check('bot.frozen notification reached the owner', ownerNotif?.ok && (ownerNotif.json?.data?.items ?? []).some((n) => n.type === 'bot.frozen'), (ownerNotif.json?.data?.items ?? []).map((n) => n.type).slice(0, 10).join(','));
      const regFrozen = await call('GET', `/workspaces/${W}/keys/registry?filter=frozen`, s1.token);
      check('registry filter=frozen lists the frozen bot key with reason', regFrozen.ok && regFrozen.json.data.items.some((r) => r.kind === 'bot' && r.status === 'frozen' && r.frozenReason === 'creator_left'), JSON.stringify(regFrozen.json?.data?.items?.map((r) => [r.kind, r.status, r.frozenReason])));
      const regAll = await call('GET', `/workspaces/${W}/keys/registry`, s1.token);
      check('registry rows carry holder/purpose/createdBy/scopes', regAll.ok && regAll.json.data.items.every((r) => r.holder && r.purpose && r.createdById && typeof r.scopeCount === 'number'), regAll.json?.data?.items?.length);
      const journal = await call('GET', `/workspaces/${W}/keys/journal`, s1.token);
      const actions = new Set((journal.json?.data?.items ?? []).map((e) => e.action));
      check('journal: bot.created, api_key.created, bot.frozen, api_key.revoked, api_key.rotated', ['bot.created', 'api_key.created', 'bot.frozen', 'api_key.revoked', 'api_key.rotated'].every((a) => actions.has(a)), [...actions].join(','));
      // Журнал append-only: UPDATE/DELETE отвергаются триггером
      let journalImmutable = false;
      try {
        await prisma.$executeRawUnsafe(`DELETE FROM security_events WHERE workspace_id = '${W}'::uuid`);
      } catch (e) {
        journalImmutable = true;
      }
      check('key journal is append-only (DELETE rejected)', journalImmutable);
      const remove = await call('DELETE', `/workspaces/${W}/members/${s2.id}`, s1.token);
      check('suite2 removed from the workspace', remove.ok, `${remove.status} ${remove.code}`);

      // --- Каскад: админ выходит САМ (leaveWorkspace) — его ключ организации гаснет ---
      const s3 = await login(SUITE.p3);
      const inv3 = await call('POST', `/workspaces/${W}/invitations`, s1.token, { phone: SUITE.p3 });
      const incoming3 = await call('GET', '/workspaces/invitations/incoming', s3.token);
      const inv3Id = (incoming3.json?.data ?? []).find((i) => i.workspaceId === W)?.id ?? inv3.json?.data?.id;
      const acc3 = await call('POST', `/workspaces/invitations/${inv3Id}/accept`, s3.token);
      const promote3 = await call('PATCH', `/workspaces/${W}/members/${s3.id}`, s1.token, { role: 'admin' });
      check('suite3 joined and promoted to admin', acc3.ok && promote3.ok, `${acc3.status}/${promote3.status}`);
      // suite3 — админ БЕЗ окна step-up: ранг/права/IP-список бота (сила уже выпущенных ключей)
      // он поменять не может, а имя — может
      await call('POST', '/keys/step-up/end', s3.token, {});
      const powerNoStep = await call('PATCH', `/workspaces/${W}/keys/bots/${botId}`, s3.token, { scopes: { tasks: 'write', documents: 'write', notes: 'write' } });
      check('bot scopes change without step-up → 403 keys.step_up_required', powerNoStep.status === 403 && powerNoStep.code === 'keys.step_up_required', `${powerNoStep.status} ${powerNoStep.code}`);
      const rankNoStep = await call('PATCH', `/workspaces/${W}/keys/bots/${botId}`, s3.token, { rank: 'manager' });
      check('bot rank change without step-up → 403 keys.step_up_required', rankNoStep.status === 403 && rankNoStep.code === 'keys.step_up_required', `${rankNoStep.status} ${rankNoStep.code}`);
      const nameNoStep = await call('PATCH', `/workspaces/${W}/keys/bots/${botId}`, s3.token, { purpose: 'e2e: tasks sync (renamed)' });
      check('bot purpose change needs no step-up → 200', nameNoStep.ok, `${nameNoStep.status} ${nameNoStep.code}`);
      const su3 = await stepUp(s3);
      check('suite3 step-up', su3.ok, su3.status);
      const leaverPat = await call('POST', `/workspaces/${W}/keys/keys`, s3.token, { name: 'leaver org key', purpose: 'e2e: leave path', scopes: { tasks: 'read' } });
      check('admin (suite3) creates a personal key for organization data', leaverPat.status === 201, `${leaverPat.status} ${leaverPat.code}`);
      const leaverAlive = await call('GET', '/tasks', leaverPat.json?.data?.secret ?? '');
      check('leaver key works before leaving', leaverAlive.ok, `${leaverAlive.status} ${leaverAlive.code}`);
      const leave3 = await call('POST', `/workspaces/${W}/leave`, s3.token);
      check('suite3 leaves the workspace', leave3.ok, `${leave3.status} ${leave3.code}`);
      const leaverDead = await call('GET', '/tasks', leaverPat.json?.data?.secret ?? '');
      check('left on his own: organization key revoked (member_left)', leaverDead.status === 401 && leaverDead.code === 'keys.revoked', `${leaverDead.status} ${leaverDead.code}`);

      // --- Политика организации ---
      const pol = await call('PATCH', `/workspaces/${W}/keys/policy`, s1.token, { maxBotKeyDays: 10 });
      check('policy updated by owner (maxBotKeyDays=10)', pol.ok && pol.json?.data?.maxBotKeyDays === 10, `${pol.status} ${pol.code}`);
      const overPolicy = await call('POST', `/workspaces/${W}/keys/bots`, s1.token, { name: 'Long', purpose: 'e2e', rank: 'member', scopes: { tasks: 'read' }, expiresInDays: 30 });
      check('bot key beyond policy → 400 keys.policy_max_days', overPolicy.status === 400 && overPolicy.code === 'keys.policy_max_days', `${overPolicy.status} ${overPolicy.code}`);

      // --- Архив бота: ключи отозваны, роль снята ---
      const arch = await call('DELETE', `/workspaces/${W}/keys/bots/${botId}`, s1.token);
      check('bot archived', arch.ok, `${arch.status} ${arch.code}`);
      const archCall = await call('GET', '/users/me', newSecret);
      check('archived bot key → 401 keys.revoked', archCall.status === 401 && archCall.code === 'keys.revoked', `${archCall.status} ${archCall.code}`);
      const archRoles = await prisma.userRole.count({ where: { userId: botUserId, context: 'workspace', tenantId: W, isActive: true } });
      check('archived bot has no active workspace role', archRoles === 0, archRoles);

      // --- Тариф: боты — свой потолок, места не занимают ---
      const seats = await call('GET', '/entitlements/me', s1.token, undefined, WSH);
      check('entitlements/me answers in the workspace context (bots do not take seats)', seats.ok && JSON.stringify(seats.json).includes('keys.maxBots'), `${seats.status} ${JSON.stringify(seats.json).slice(0, 100)}`);

      await archiveSuiteWorkspace(W);
    }
  } finally {
    await prisma.$disconnect();
  }
  finish();
}

main().catch(crash);
