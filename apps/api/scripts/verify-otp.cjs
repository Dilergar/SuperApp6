/* eslint-disable */
// E2E: core/verify (11-й движок) — SMS-OTP. Полный путь на mock-драйвере + dev-ручке кода:
// гео-щит (только КЗ-мобильные), start/кулдаун 429 (+Retry-After, БЕЗ утечки challengeId),
// 5 попыток на цепочку и их сохранение при ресенде, verify-first регистрация (verifyToken
// consume, phoneVerifiedAt), honest 409 register / НЕОТЛИЧИМЫЙ password_reset по чужому
// номеру, сброс пароля (отзыв сессий + мгновенная смерть access-токенов + автовход),
// смена пароля (пароль проверяется ДО SMS), смена номера (оба кода + активация
// приглашений нового номера джобом), purpose-mismatch, одноразовость токена, тест-карта.
// Requires API on 3001 (NODE_ENV=development, SMS_DRIVER пуст/mock) + tester1 (seed).
// Тест-карта проверяется, только если в .env API задан VERIFY_TEST_PHONES с парой ниже.
// Run: node apps/api/scripts/verify-otp.cjs
const BASE = process.env.API_URL || 'http://localhost:3001/api';
const T1 = { phone: '+77009990001', password: 'Test1234!' };
const PW = 'Test1234!';
const PW2 = 'Test12345!';
// Пара из .env.example / CI — если карта не настроена, блок теста помечается SKIP.
const TEST_MAP_PHONE = '+77099999999';
const TEST_MAP_CODE = '424242';

async function http(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, json, headers: res.headers };
}

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, extra) => {
  if (c) { passed++; console.log(`  PASS ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${extra ? `  (${extra})` : ''}`); }
};
const skip = (n, why) => { skipped++; console.log(`  SKIP ${n} — ${why}`); };

// Уникальные казахстанские МОБИЛЬНЫЕ номера на прогон (лимиты на номер не мешают повторам)
const stamp = Date.now() % 1_000_000_0;
const freshPhone = (i) => `+7700${String((stamp + i * 137) % 10_000_000).padStart(7, '0')}`;

const devCode = async (challengeId) =>
  (await http('GET', `/verify/dev/last-code?challengeId=${challengeId}`)).json?.data?.code ?? null;

async function startAndCode(phone, purpose) {
  const start = await http('POST', '/verify/start', { body: { phone, purpose } });
  if (!start.ok) return { start };
  const code = await devCode(start.json.data.challengeId);
  return { start, challengeId: start.json.data.challengeId, code };
}

async function checkCode(challengeId, code) {
  return http('POST', '/verify/check', { body: { challengeId, code } });
}

async function main() {
  console.log('=== core/verify E2E ===');

  // --- 0. Статус движка (dev: required=false, sms mock) ---
  const status = await http('GET', '/verify/status');
  check('status: 200 + required=false в dev', status.ok && status.json.data.required === false);
  check('status: smsEnabled=false (mock-драйвер)', status.json.data.smsEnabled === false);

  // --- 1. Гео-щит: только казахстанские МОБИЛЬНЫЕ ---
  const geo = await http('POST', '/verify/start', { body: { phone: '+79001234567', purpose: 'register' } });
  check('гео-щит: российский +7 9xx отвергнут 400', geo.status === 400, `got ${geo.status}`);
  const landline = await http('POST', '/verify/start', { body: { phone: '+77271234567', purpose: 'register' } });
  check('гео-щит: городской +7 727 отвергнут 400', landline.status === 400, `got ${landline.status}`);
  const regLandline = await http('POST', '/auth/register', { body: { phone: '+77271234567', password: PW, firstName: 'Гор' } });
  check('register тоже не принимает не-мобильный номер', regLandline.status === 400, `got ${regLandline.status}`);

  // --- 2. Register: занятый номер → честный 409 ---
  const taken = await http('POST', '/verify/start', { body: { phone: T1.phone, purpose: 'register' } });
  check('register на занятый номер → 409 честно', taken.status === 409, `got ${taken.status}`);

  // --- 3. Полный register-поток ---
  const phoneA = freshPhone(1);
  const a1 = await startAndCode(phoneA, 'register');
  check('start register: 200 + challengeId + resendInSec', a1.start.ok && !!a1.challengeId && a1.start.json.data.resendInSec > 0);
  check('dev-ручка отдаёт код', !!a1.code && /^\d{6}$/.test(a1.code));

  // кулдаун: немедленный повторный start → 429 c таймером, но БЕЗ id чужой цепочки
  const cool = await http('POST', '/verify/start', { body: { phone: phoneA, purpose: 'register' } });
  check('повторный start в кулдауне → 429', cool.status === 429, `got ${cool.status}`);
  check('429 несёт details.resendInSec', (cool.json?.details?.resendInSec ?? 0) > 0);
  check('429 НЕ отдаёт challengeId (иначе чужую цепочку можно сжечь)', cool.json?.details?.challengeId === undefined);
  check('429 отдаёт Retry-After', Number(cool.headers.get('retry-after')) > 0, `got ${cool.headers.get('retry-after')}`);

  // неверный код → attemptsLeft
  const bad = await checkCode(a1.challengeId, a1.code === '000000' ? '000001' : '000000');
  check('неверный код → 400 + attemptsLeft=4', bad.status === 400 && bad.json?.details?.attemptsLeft === 4, JSON.stringify(bad.json));
  check('ошибка несёт машинный код verify_code_wrong', bad.json?.details?.code === 'verify_code_wrong', JSON.stringify(bad.json?.details));

  // верный код → verifyToken
  const good = await checkCode(a1.challengeId, a1.code);
  const tokenA = good.json?.data?.verifyToken;
  check('верный код → verifyToken (64 hex)', good.ok && /^[a-f0-9]{64}$/.test(tokenA ?? ''));

  // повторный check того же кода → «уже подтверждён»
  const again = await checkCode(a1.challengeId, a1.code);
  check('повторная проверка → 400 (уже подтверждён)', again.status === 400);

  // register с чужим номером под этим токеном → 400 (expectedPhone)
  const wrongPhone = await http('POST', '/auth/register', {
    body: { phone: freshPhone(2), password: PW, firstName: 'Впс', verifyToken: tokenA },
  });
  check('register с токеном ЧУЖОГО номера → 400', wrongPhone.status === 400, `got ${wrongPhone.status}`);

  // register с верным номером → аккаунт, isVerified=true
  const regA = await http('POST', '/auth/register', {
    body: { phone: phoneA, password: PW, firstName: 'ОтпА', verifyToken: tokenA },
  });
  check('register с verifyToken → 201/200 + токены', regA.ok && !!regA.json?.data?.accessToken, JSON.stringify(regA.json).slice(0, 120));
  const oldAccessA = regA.json.data.accessToken;
  const meA = await http('GET', '/users/me', { token: oldAccessA });
  check('профиль: isVerified=true (phoneVerifiedAt)', meA.ok && meA.json.data.isVerified === true);

  // одноразовость: тот же токен второй раз → 400 (потрачен)
  const replay = await http('POST', '/auth/register', {
    body: { phone: freshPhone(3), password: PW, firstName: 'Реплей', verifyToken: tokenA },
  });
  check('повторное использование verifyToken → 400', replay.status === 400);
  check('ошибка гашения несёт verify_token_stale', replay.json?.details?.code === 'verify_token_stale', JSON.stringify(replay.json?.details));

  // dev-режим: register БЕЗ токена работает (required=false), isVerified=false
  const phoneB = freshPhone(4);
  const regB = await http('POST', '/auth/register', { body: { phone: phoneB, password: PW, firstName: 'ОтпБ' } });
  check('dev: register без токена работает (seed/скрипты живут)', regB.ok);
  const meB = await http('GET', '/users/me', { token: regB.json.data.accessToken });
  check('без токена isVerified=false', meB.ok && meB.json.data.isVerified === false);

  // --- 4. Сгорание цепочки: 5 неверных попыток ---
  const phoneC = freshPhone(5);
  const c1 = await startAndCode(phoneC, 'register');
  let lastAttempt = null;
  for (let i = 0; i < 5; i++) lastAttempt = await checkCode(c1.challengeId, '999999' === c1.code ? '111111' : '999999');
  check('5-я неверная: attemptsLeft=0', lastAttempt.json?.details?.attemptsLeft === 0, JSON.stringify(lastAttempt.json));
  const burnt = await checkCode(c1.challengeId, c1.code);
  check('после 5 промахов даже ВЕРНЫЙ код отвергнут', burnt.status === 400);

  // --- 5. password_reset по НЕсуществующему номеру неотличим от настоящего ---
  const ghostPhone = freshPhone(6);
  const ghost = await http('POST', '/verify/start', { body: { phone: ghostPhone, purpose: 'password_reset' } });
  check('reset несуществующего номера → 200 (нейтрально)', ghost.ok && !!ghost.json?.data?.challengeId);
  check('нейтральная цепочка НЕ оставляет кода (SMS не тратится)', (await devCode(ghost.json.data.challengeId)) === null);
  const ghostCheck = await checkCode(ghost.json.data.challengeId, '123456');
  check(
    'check по нейтральной цепочке отвечает КАК настоящая (attemptsLeft=4)',
    ghostCheck.status === 400 && ghostCheck.json?.details?.attemptsLeft === 4,
    JSON.stringify(ghostCheck.json),
  );
  const ghostCool = await http('POST', '/verify/start', { body: { phone: ghostPhone, purpose: 'password_reset' } });
  check('нейтральная цепочка так же упирается в кулдаун 429', ghostCool.status === 429, `got ${ghostCool.status}`);

  // --- 6. Настоящий сброс пароля (юзер A) ---
  const oldRefreshA = regA.json.data.refreshToken;
  const r1 = await startAndCode(phoneA, 'password_reset');
  check('reset существующего: 200 + код в dev-ручке', r1.start.ok && !!r1.code);
  const rTok = (await checkCode(r1.challengeId, r1.code)).json?.data?.verifyToken;

  // purpose-mismatch: reset-токен в register → 400
  const misuse = await http('POST', '/auth/register', { body: { phone: freshPhone(7), password: PW, firstName: 'Мис', verifyToken: rTok } });
  check('reset-токен в register (purpose mismatch) → 400', misuse.status === 400);

  const resetDone = await http('POST', '/auth/password-reset', { body: { verifyToken: rTok, newPassword: PW2 } });
  check('password-reset: 200 + АВТОВХОД (токены)', resetDone.ok && !!resetDone.json?.data?.accessToken);
  const oldLogin = await http('POST', '/auth/login', { body: { phone: phoneA, password: PW } });
  check('старый пароль больше не подходит', oldLogin.status === 401);
  const newLogin = await http('POST', '/auth/login', { body: { phone: phoneA, password: PW2 } });
  check('новый пароль работает', newLogin.ok);
  const deadRefresh = await http('POST', '/auth/refresh', { body: { refreshToken: oldRefreshA } });
  check('старый refresh-токен отозван (все сессии)', deadRefresh.status === 401);
  // Главное: ACCESS-токен, выданный до сброса, умирает сразу, а не живёт свои 15 минут.
  const deadAccess = await http('GET', '/users/me', { token: oldAccessA });
  check('старый ACCESS-токен отозван поколением (401)', deadAccess.status === 401, `got ${deadAccess.status}`);
  const freshAccess = await http('GET', '/users/me', { token: resetDone.json.data.accessToken });
  check('токен из автовхода рабочий', freshAccess.ok, `got ${freshAccess.status}`);

  // reset-токен одноразов
  const resetReplay = await http('POST', '/auth/password-reset', { body: { verifyToken: rTok, newPassword: 'Another1!' } });
  check('повторный password-reset тем же токеном → 400', resetReplay.status === 400);

  // --- 7. Смена пароля из профиля (step-up: пароль ДО отправки SMS) ---
  const tokA2 = newLogin.json.data.accessToken;
  const suWrongPw = await http('POST', '/verify/step-up', { token: tokA2, body: { purpose: 'password_change', password: 'Wrong123!' } });
  check('step-up с НЕВЕРНЫМ паролем → 401 (SMS не тратится)', suWrongPw.status === 401, `got ${suWrongPw.status}`);
  const suNoPw = await http('POST', '/verify/step-up', { token: tokA2, body: { purpose: 'password_change' } });
  check('step-up без пароля → 400 (схема)', suNoPw.status === 400, `got ${suNoPw.status}`);

  const su = await http('POST', '/verify/step-up', { token: tokA2, body: { purpose: 'password_change', password: PW2 } });
  check('step-up password_change: 200 (код на СВОЙ номер)', su.ok && su.json.data.phoneMasked.includes('*'), JSON.stringify(su.json).slice(0, 120));
  const suCode = await devCode(su.json.data.challengeId);
  const suTok = (await checkCode(su.json.data.challengeId, suCode)).json?.data?.verifyToken;
  const wrongCur = await http('POST', '/users/me/change-password', {
    token: tokA2,
    body: { currentPassword: 'Wrong123!', newPassword: PW, verifyToken: suTok },
  });
  check('смена пароля с неверным текущим → 401', wrongCur.status === 401);
  const chPass = await http('POST', '/users/me/change-password', {
    token: tokA2,
    body: { currentPassword: PW2, newPassword: PW, verifyToken: suTok, currentRefreshToken: newLogin.json.data.refreshToken },
  });
  check('смена пароля: 200', chPass.ok, JSON.stringify(chPass.json).slice(0, 120));
  const reLogin = await http('POST', '/auth/login', { body: { phone: phoneA, password: PW } });
  check('вход по НОВОМУ паролю после смены', reLogin.ok);
  const keptRefresh = await http('POST', '/auth/refresh', { body: { refreshToken: newLogin.json.data.refreshToken } });
  check('текущая сессия ПЕРЕЖИЛА смену пароля (refresh жив)', keptRefresh.ok, `got ${keptRefresh.status}`);
  const staleAccess2 = await http('GET', '/users/me', { token: tokA2 });
  check('access-токен до смены пароля отозван (401)', staleAccess2.status === 401, `got ${staleAccess2.status}`);
  const rotated = await http('GET', '/users/me', { token: keptRefresh.json.data.accessToken });
  check('после refresh той же сессии токен снова рабочий', rotated.ok, `got ${rotated.status}`);

  // step-up цели закрыты на публичном /verify/start
  const pubStepUp = await http('POST', '/verify/start', { body: { phone: phoneA, purpose: 'password_change' } });
  check('публичный start НЕ принимает step-up цели', pubStepUp.status === 404 || pubStepUp.status === 400);

  // --- 8. Смена номера (оба кода) + активация приглашений нового номера ---
  const phoneNew = freshPhone(8);
  // tester1 заранее шлёт приглашение на БУДУЩИЙ номер (external, toUserId=null)
  const t1login = await http('POST', '/auth/login', { body: T1 });
  const invite = await http('POST', '/contacts/invitations', {
    token: t1login.json.data.accessToken,
    body: { toPhone: phoneNew, proposedRoleForRecipient: 'Друг', proposedRoleForSender: 'Друг' },
  });
  check('приглашение на будущий номер создано (external)', invite.ok, JSON.stringify(invite.json).slice(0, 120));

  const tokA3 = reLogin.json.data.accessToken;
  const old1 = await http('POST', '/verify/step-up', { token: tokA3, body: { purpose: 'phone_change_old', password: PW } });
  check('step-up phone_change_old: 200', old1.ok, JSON.stringify(old1.json).slice(0, 120));
  const oldCode = await devCode(old1.json.data.challengeId);
  const oldTok = (await checkCode(old1.json.data.challengeId, oldCode)).json?.data?.verifyToken;

  const takenNew = await http('POST', '/verify/step-up', { token: tokA3, body: { purpose: 'phone_change_new', password: PW, newPhone: T1.phone } });
  check('phone_change_new на ЗАНЯТЫЙ номер → 409', takenNew.status === 409);

  const new1 = await http('POST', '/verify/step-up', { token: tokA3, body: { purpose: 'phone_change_new', password: PW, newPhone: phoneNew } });
  check('step-up phone_change_new: 200 (код на НОВЫЙ)', new1.ok);
  const newCode = await devCode(new1.json.data.challengeId);
  const newTok = (await checkCode(new1.json.data.challengeId, newCode)).json?.data?.verifyToken;

  // перепутанные местами пропуски → 400 (цель+номер связаны с цепочкой)
  const swapped = await http('POST', '/users/me/change-phone', {
    token: tokA3,
    body: { password: PW, newPhone: phoneNew, oldVerifyToken: newTok, newVerifyToken: oldTok },
  });
  check('пропуски old/new местами → 400 (purpose+phone связаны)', swapped.status === 400, `got ${swapped.status}`);

  const chPhone = await http('POST', '/users/me/change-phone', {
    token: tokA3,
    body: { password: PW, newPhone: phoneNew, oldVerifyToken: oldTok, newVerifyToken: newTok, currentRefreshToken: reLogin.json.data.refreshToken },
  });
  check('смена номера: 200', chPhone.ok, JSON.stringify(chPhone.json).slice(0, 160));
  const loginNew = await http('POST', '/auth/login', { body: { phone: phoneNew, password: PW } });
  check('вход по НОВОМУ номеру', loginNew.ok);
  const loginOldPhone = await http('POST', '/auth/login', { body: { phone: phoneA, password: PW } });
  check('старый номер освобождён (вход 401)', loginOldPhone.status === 401);

  // Приглашения активирует джоб core/jobs (поставлен в транзакции смены) — ждём воркер.
  let gotInvite = false;
  for (let i = 0; i < 20 && !gotInvite; i++) {
    const incoming = await http('GET', '/contacts/invitations/incoming', { token: loginNew.json.data.accessToken });
    gotInvite = (incoming.json?.data?.items ?? []).some((inv) => inv.fromUser?.phone === T1.phone || inv.proposedRoleForRecipient === 'Друг');
    if (!gotInvite) await new Promise((r) => setTimeout(r, 400));
  }
  check('приглашение на новый номер АКТИВИРОВАЛОСЬ джобом после смены', gotInvite);

  // Пропуск сброса, выданный на СТАРЫЙ (уже отпущенный) номер, больше не работает:
  // цепочка привязана к аккаунту, а его номер изменился.
  const staleReset = await startAndCode(phoneA, 'password_reset');
  check('reset на освобождённый номер → нейтральная цепочка', staleReset.start.ok && staleReset.code === null);

  // уведомления безопасности
  const notifs = await http('GET', '/notifications', { token: loginNew.json.data.accessToken });
  // /notifications отдаёт {items, unreadCount, nextCursor} — читаем строго items:
  // фолбэк `?? json.data` пропустил бы расплющивание страницы молча.
  const types = (notifs.json?.data?.items ?? []).map((n) => n.type);
  check('уведомление «Номер изменён» в ленте', types.includes('auth.phone.changed'), JSON.stringify(types.slice(0, 10)));
  check('уведомление «Пароль изменён» в ленте', types.includes('auth.password.changed'));

  // --- 9. Тест-карта номеров (SMS не шлётся, код фиксирован, лимиты пропускаются) ---
  const tm = await http('POST', '/verify/start', { body: { phone: TEST_MAP_PHONE, purpose: 'password_reset' } });
  const tmToken = tm.ok ? (await checkCode(tm.json.data.challengeId, TEST_MAP_CODE)).json?.data?.verifyToken : null;
  if (!tmToken) {
    skip('тест-карта VERIFY_TEST_PHONES', `не настроена для ${TEST_MAP_PHONE} (см. .env.example)`);
    skip('ресенд НЕ сбрасывает attempts', 'нужен номер тест-карты (ресенд без кулдауна)');
  } else {
    check('тест-карта: фиксированный код принят', /^[a-f0-9]{64}$/.test(tmToken));
    // Ресенд у тест-номера не упирается в кулдаун → можно проверить, что счётчик
    // неверных вводов ЖИВЁТ через ресенд (модель SuperTokens), а не обнуляется.
    // Номер тест-карты фиксирован, и цепочка register живёт 10 минут — гасим хвост
    // прошлого прогона верным кодом, чтобы следующий start завёл ЗАВЕДОМО свежую.
    const t0 = await http('POST', '/verify/start', { body: { phone: TEST_MAP_PHONE, purpose: 'register' } });
    await checkCode(t0.json.data.challengeId, TEST_MAP_CODE);
    const t2 = await http('POST', '/verify/start', { body: { phone: TEST_MAP_PHONE, purpose: 'register' } });
    const miss1 = await checkCode(t2.json.data.challengeId, '000001');
    const resent = await http('POST', '/verify/start', { body: { phone: TEST_MAP_PHONE, purpose: 'register' } });
    check('ресенд продолжает ТУ ЖЕ цепочку', resent.ok && resent.json.data.challengeId === t2.json.data.challengeId);
    const miss2 = await checkCode(resent.json.data.challengeId, '000002');
    // Счётчик проверяем ОТНОСИТЕЛЬНО: цепочка тест-номера живёт 10 минут и переживает
    // повторный прогон скрипта, так что абсолютное «4 → 3» ловило бы не тот дефект.
    const left1 = miss1.json?.details?.attemptsLeft;
    const left2 = miss2.json?.details?.attemptsLeft;
    check(
      'ресенд НЕ сбрасывает attempts (счётчик продолжает падать)',
      typeof left1 === 'number' && left2 === left1 - 1,
      `${left1} → ${left2}`,
    );
  }

  console.log(`\n=== ИТОГ: ${passed} PASS / ${failed} FAIL${skipped ? ` / ${skipped} SKIP` : ''} ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
