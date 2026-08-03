/* eslint-disable */
// Реквизиты (организация + человек + карты) — сквозная проверка.
//
// Аккаунты СЬЮТА (+7700999000x). Уборка — только свои объекты и штатным путём:
// карты — DELETE /wallet/cards, поля анкеты — PATCH null, организация —
// деактивация (архив приберёт gc-test-workspaces.cjs).
//
// Run (API up): node scripts/verify-requisites.cjs
// Адрес API переопределяется переменной окружения: два экземпляра на одной машине
// (например, когда :3001 занят чужим дев-сервером) — обычная ситуация при проверке правок.
const BASE = process.env.SA6_API_BASE || 'http://localhost:3001/api';
const P1 = '+77009990001', P2 = '+77009990002', P3 = '+77009990003', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`);
  if (!ok) fails++;
};

async function call(method, p, token, body, headers) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}

const login = async (phone) => {
  const r = await call('POST', '/auth/login', null, { phone, password: PW });
  if (!r.ok) throw new Error(`login ${phone}: ${r.status}`);
  const token = r.json.data.accessToken;
  const me = await call('GET', '/users/me', token);
  return { token, userId: me.json.data.id };
};

// ------------------------------------------------------------
// Генераторы валидных номеров (те же публичные алгоритмы, что в shared)
// ------------------------------------------------------------

function makeIinOrBin() {
  for (;;) {
    const d = Array.from({ length: 11 }, () => Math.floor(Math.random() * 10));
    const w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
    let s = d.reduce((a, x, i) => a + x * w1[i], 0) % 11;
    if (s === 10) {
      s = d.reduce((a, x, i) => a + x * w2[i], 0) % 11;
      if (s === 10) continue;
    }
    return d.join('') + String(s);
  }
}

function mod97(digits) {
  let rem = 0;
  for (let i = 0; i < digits.length; i += 7) rem = Number(String(rem) + digits.slice(i, i + 7)) % 97;
  return rem;
}

function makeKzIban() {
  const body = Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join('');
  // ISO 13616: контрольные цифры = 98 − mod97(body + 'KZ00' в числовом виде)
  const numeric = (body + 'KZ00').replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  const checkDigits = String(98 - mod97(numeric)).padStart(2, '0');
  return `KZ${checkDigits}${body}`;
}

const VISA_TEST_PAN = '4111111111111111'; // классический Luhn-валидный тестовый номер

async function main() {
  const { token: t1, userId: u1 } = await login(P1);
  const { token: t2 } = await login(P2);
  const { userId: u3 } = await login(P3);
  const stamp = Date.now();
  const cleanup = { wsId: null, cardIds: [] };

  try {
    // ============================================================
    // 1. Организация: создать + нанять u2
    // ============================================================
    const cws = await call('POST', '/workspaces', t1, { name: `req-ws-${stamp}` });
    check('организация создана', cws.ok, `status ${cws.status}`);
    const wsId = cws.json.data.id;
    cleanup.wsId = wsId;

    await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: P2 });
    const inc = await call('GET', '/workspaces/invitations/incoming', t2);
    const inv = (inc.json?.data ?? []).find((i) => i.workspaceId === wsId);
    check('приглашение доставлено u2', !!inv, String((inc.json?.data ?? []).length));
    if (inv) await call('POST', `/workspaces/invitations/${inv.id}/accept`, t2);

    // ============================================================
    // 2. Реквизиты организации
    // ============================================================
    const badBin = await call('PATCH', `/workspaces/${wsId}/requisites`, t1, { bin: '123456789012' });
    check('БИН без контрольной суммы → 400', badBin.status === 400, `status ${badBin.status}`);

    const bin = makeIinOrBin();
    const setReq = await call('PATCH', `/workspaces/${wsId}/requisites`, t1, {
      orgForm: 'too',
      taxRegime: 'simplified',
      legalName: `ТОО «Реквизит-${stamp}»`,
      bin,
      legalAddress: 'г. Алматы, ул. Тестовая, 1',
      kbe: '17',
      vatPayer: true,
      vatSeries: '60001',
      vatNumber: '1234567',
      signBasis: 'Устава',
    });
    check('реквизиты сохранены', setReq.ok && setReq.json.data.bin === bin, `status ${setReq.status}`);

    const badDirector = await call('PATCH', `/workspaces/${wsId}/requisites`, t1, { directorUserId: u3 });
    check('директор НЕ из сотрудников → 400', badDirector.status === 400, `status ${badDirector.status}`);
    const goodDirector = await call('PATCH', `/workspaces/${wsId}/requisites`, t1, { directorUserId: u1 });
    check('директор из сотрудников принят', goodDirector.ok && !!goodDirector.json.data.directorName, goodDirector.json?.data?.directorName);

    // Стажёру блок виден по умолчанию (реквизиты печатаются на каждом счёте)
    const asStaff = await call('GET', `/workspaces/${wsId}/requisites`, t2);
    check('сотрудник видит реквизиты по умолчанию', asStaff.ok && asStaff.json.data?.bin === bin, `status ${asStaff.status}`);

    // Владелец выключает флаг «Реквизиты» → сотруднику data: null, владельцу — как было
    await call('PATCH', `/workspaces/${wsId}`, t1, { cardVisibility: { requisites: false } });
    const hidden = await call('GET', `/workspaces/${wsId}/requisites`, t2);
    check('флаг видимости скрывает блок от сотрудника', hidden.ok && hidden.json.data === null, JSON.stringify(hidden.json?.data));
    const stillOwner = await call('GET', `/workspaces/${wsId}/requisites`, t1);
    check('владелец видит при любом флаге', stillOwner.ok && stillOwner.json.data?.bin === bin);
    await call('PATCH', `/workspaces/${wsId}`, t1, { cardVisibility: { requisites: true } });

    // Стажёр править не может
    const staffEdit = await call('PATCH', `/workspaces/${wsId}/requisites`, t2, { kbe: '19' });
    check('сотрудник не правит реквизиты → 403', staffEdit.status === 403, `status ${staffEdit.status}`);

    // ============================================================
    // 3. Банковские счета: список с основным
    // ============================================================
    const badIban = await call('POST', `/workspaces/${wsId}/requisites/accounts`, t1, {
      iban: 'KZ001234', bankName: 'Kaspi', bik: 'CASPKZKA',
    });
    check('битый IBAN → 400', badIban.status === 400, `status ${badIban.status}`);

    const iban1 = makeKzIban(), iban2 = makeKzIban();
    const acc1 = await call('POST', `/workspaces/${wsId}/requisites/accounts`, t1, {
      iban: iban1, bankName: 'Kaspi Bank', bik: 'CASPKZKA',
    });
    check('первый счёт создан и стал основным', acc1.ok && acc1.json.data.bankAccounts[0]?.isPrimary === true, JSON.stringify(acc1.json?.data?.bankAccounts));
    const acc2 = await call('POST', `/workspaces/${wsId}/requisites/accounts`, t1, {
      iban: iban2, bankName: 'Halyk Bank', bik: 'HSBKKZKX',
    });
    const accs = acc2.json?.data?.bankAccounts ?? [];
    check('второй счёт НЕ основной', accs.length === 2 && accs.find((a) => a.iban === iban2)?.isPrimary === false);

    const a2id = accs.find((a) => a.iban === iban2)?.id;
    const swap = await call('PATCH', `/workspaces/${wsId}/requisites/accounts/${a2id}`, t1, { isPrimary: true });
    const afterSwap = swap.json?.data?.bankAccounts ?? [];
    check(
      'основной ровно один после переключения',
      afterSwap.filter((a) => a.isPrimary).length === 1 && afterSwap.find((a) => a.iban === iban2)?.isPrimary === true,
      JSON.stringify(afterSwap.map((a) => [a.iban.slice(-4), a.isPrimary])),
    );

    const del2 = await call('DELETE', `/workspaces/${wsId}/requisites/accounts/${a2id}`, t1);
    const afterDel = del2.json?.data?.bankAccounts ?? [];
    check('удаление основного передаёт роль оставшемуся', afterDel.length === 1 && afterDel[0].isPrimary === true, JSON.stringify(afterDel));

    // ============================================================
    // 4. Анкета человека: ИИН, адрес, удостоверение
    // ============================================================
    const badIin = await call('PATCH', '/users/me', t2, { iin: '111111111111' });
    check('ИИН без контрольной суммы → 400', badIin.status === 400, `status ${badIin.status}`);

    const iin2 = makeIinOrBin();
    const setMe = await call('PATCH', '/users/me', t2, {
      iin: iin2,
      residentialAddress: 'г. Алматы, мкр. Тестовый, д. 5, кв. 12',
      idDocNumber: '045678901',
      idDocIssuedBy: 'МВД РК',
      idDocIssuedAt: '2020-05-15',
    });
    check('реквизиты анкеты сохранены', setMe.ok, `status ${setMe.status}`);
    const me2 = await call('GET', '/users/me', t2);
    check('профиль отдаёт ИИН и удостоверение', me2.json?.data?.iin === iin2 && me2.json?.data?.idDocIssuedAt === '2020-05-15', `${me2.json?.data?.iin}/${me2.json?.data?.idDocIssuedAt}`);

    // ============================================================
    // 5. Карты в «Кошельке»
    // ============================================================
    const badPan = await call('POST', '/wallet/cards', t2, {
      pan: '4111111111111112', holderName: 'TEST USER', expMonth: 12, expYear: 2031,
    });
    check('номер карты без суммы Луна → 400', badPan.status === 400, `status ${badPan.status}`);

    const cardIban = makeKzIban();
    const c1 = await call('POST', '/wallet/cards', t2, {
      pan: VISA_TEST_PAN, iban: cardIban, holderName: 'SUITE TWO', expMonth: 12, expYear: 2031,
    });
    check('карта добавлена и стала основной', c1.ok && c1.json.data.isPrimary === true, `status ${c1.status}`);
    if (c1.ok) cleanup.cardIds.push(c1.json.data.id);
    check('владельцу номер отдаётся полностью', c1.json?.data?.pan === VISA_TEST_PAN, c1.json?.data?.panMasked);

    const c2 = await call('POST', '/wallet/cards', t2, {
      pan: '5500005555555559', holderName: 'SUITE TWO', expMonth: 6, expYear: 2030,
    });
    check('вторая карта НЕ основная', c2.ok && c2.json.data.isPrimary === false, `status ${c2.status}`);
    if (c2.ok) cleanup.cardIds.push(c2.json.data.id);

    // ============================================================
    // 6. Ростер: manager+ видит реквизиты всегда, коллега — по тумблерам
    // ============================================================
    const roster1 = await call('GET', `/workspaces/${wsId}/members`, t1); // владелец = manager+
    const rowU2 = (roster1.json?.data ?? []).find((m) => m.card?.phone === P2 || m.userName.includes('')) ?? null;
    const u2row = (roster1.json?.data ?? []).find((m) => m.requisites?.iin === iin2) ?? rowU2;
    check('управляющий видит ИИН сотрудника (нередактируемый уровень)', u2row?.requisites?.iin === iin2, JSON.stringify(u2row?.requisites ?? null));
    check('управляющий видит основную карту полностью', u2row?.requisites?.paymentCard?.pan === VISA_TEST_PAN, u2row?.requisites?.paymentCard?.pan);
    check('управляющему приехал и IBAN карт-счёта', u2row?.requisites?.paymentCard?.iban === cardIban);
    check('и удостоверение с датой', u2row?.requisites?.idDocNumber === '045678901' && u2row?.requisites?.idDocIssuedAt === '2020-05-15');

    // Коллега (u2 — стажёр) смотрит на владельца u1: у того реквизиты не заполнены и
    // тумблеры выключены → блока нет вовсе.
    const roster2 = await call('GET', `/workspaces/${wsId}/members`, t2);
    const u1row = (roster2.json?.data ?? []).find((m) => m.userId === u1);
    check('рядовому реквизиты коллег не видны (тумблеры выключены)', !u1row?.requisites?.iin && !u1row?.requisites?.paymentCard, JSON.stringify(u1row?.requisites ?? null));

    // u2 включает коллегам ТОЛЬКО ИИН → u1 (manager+) и так видел; проверяем именно
    // рядового зрителя: наймём третьего? Дешевле проверить обратное — u2 видит своего
    // же коллегу-владельца ПОСЛЕ того, как тот включит тумблер.
    await call('PATCH', '/users/me', t1, { iin: makeIinOrBin(), companyCardVisibility: { extras: { iin: true } } });
    const roster3 = await call('GET', `/workspaces/${wsId}/members`, t2);
    const u1row2 = (roster3.json?.data ?? []).find((m) => m.userId === u1);
    check('тумблер «ИИН коллегам» открывает поле рядовому', !!u1row2?.requisites?.iin, JSON.stringify(u1row2?.requisites ?? null));
    check('карта при этом рядовому НЕ видна (свой тумблер выключен)', !u1row2?.requisites?.paymentCard);

    // ============================================================
    // 7. Управление картами: смена основной, удаление с передачей роли
    // ============================================================
    const mkPrimary = await call('PATCH', `/wallet/cards/${cleanup.cardIds[1]}`, t2, { isPrimary: true });
    check('вторая карта стала основной', mkPrimary.ok && mkPrimary.json.data.isPrimary === true, `status ${mkPrimary.status}`);
    const delPrimary = await call('DELETE', `/wallet/cards/${cleanup.cardIds[1]}`, t2);
    check('основная удалена', delPrimary.ok, `status ${delPrimary.status}`);
    cleanup.cardIds = [cleanup.cardIds[0]];
    const listAfter = await call('GET', '/wallet/cards', t2);
    check('роль основной перешла оставшейся', (listAfter.json?.data ?? [])[0]?.isPrimary === true, JSON.stringify(listAfter.json?.data?.map((c) => c.panMasked)));
  } finally {
    // Уборка: карты — штатным DELETE, поля анкеты — null, организация — в архив.
    for (const id of cleanup.cardIds) await call('DELETE', `/wallet/cards/${id}`, t2).catch(() => {});
    await call('PATCH', '/users/me', t2, {
      iin: null, residentialAddress: null, idDocNumber: null, idDocIssuedBy: null, idDocIssuedAt: null,
    }).catch(() => {});
    await call('PATCH', '/users/me', t1, { iin: null, companyCardVisibility: null }).catch(() => {});
    if (cleanup.wsId) await call('DELETE', `/workspaces/${cleanup.wsId}`, t1).catch(() => {});
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
