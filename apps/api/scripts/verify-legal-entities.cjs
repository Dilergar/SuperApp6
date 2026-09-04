// Юрлица организации (Ф0 сервиса «Объекты»): головное = старые реквизиты,
// второе ТОО, дубль БИН, архив, совместительство в КЭДО.
// Аккаунты СЬЮТА (suite1/2/3); БД не чистим — организация прогона одноразовая.
const { call, login, makeChecker, SUITE } = require('./_lib.cjs');

const { check, finish } = makeChecker();

/** Валидный 12-значный БИН: подбираем контрольную цифру (двухпроходный mod 11) */
function makeBin(prefix11) {
  const d = prefix11.split('').map(Number);
  const w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
  let s = d.reduce((acc, x, i) => acc + x * w1[i], 0) % 11;
  if (s === 10) {
    s = d.reduce((acc, x, i) => acc + x * w2[i], 0) % 11;
    if (s === 10) return null;
  }
  return prefix11 + String(s);
}

function randomBin() {
  for (let i = 0; i < 40; i++) {
    const p = '9' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
    const bin = makeBin(p);
    if (bin) return bin;
  }
  throw new Error('не подобрался БИН');
}

async function hire(ws, ownerToken, personToken, phone) {
  const inv = (await call('POST', `/workspaces/${ws.id}/invitations`, ownerToken, { phone })).json?.data;
  const mine = (await call('GET', '/workspaces/invitations/incoming', personToken)).json?.data?.find?.(
    (i) => i.workspaceId === ws.id,
  );
  await call('POST', `/workspaces/invitations/${mine?.id ?? inv?.id}/accept`, personToken);
}

async function main() {
  const owner = await login(SUITE.p1);
  const worker = await login(SUITE.p2);

  const ws = (await call('POST', '/workspaces', owner.token, { name: `Сьют-Юрлица ${Date.now()}` })).json.data;
  check('организация создана', !!ws?.id);

  const base = `/workspaces/${ws.id}/legal-entities`;

  // --- 1. Головное юрлицо заводится вместе с организацией ---
  const list0 = await call('GET', base, owner.token);
  const head = list0.json?.data?.find?.((e) => e.isHead);
  check('головное юрлицо есть сразу', !!head, `list=${JSON.stringify(list0.json?.data?.length)}`);
  check('имя головного = имя организации', head?.name === ws.name, head?.name);

  // --- 2. Старые /requisites правят ГОЛОВНОЕ ---
  const headBin = randomBin();
  const patched = await call('PATCH', `/workspaces/${ws.id}/requisites`, owner.token, {
    legalName: 'ТОО «Головное»',
    bin: headBin,
    orgForm: 'too',
  });
  check('PATCH /requisites прошёл', patched.ok, `${patched.status}`);
  const afterList = (await call('GET', base, owner.token)).json?.data ?? [];
  const headAfter = afterList.find((e) => e.isHead);
  check('правка через /requisites видна в головном юрлице', headAfter?.bin === headBin, headAfter?.bin);
  const req = (await call('GET', `/workspaces/${ws.id}/requisites`, owner.token)).json?.data;
  check('GET /requisites отдаёт головное', req?.bin === headBin, req?.bin);

  // --- 3. Второе юрлицо ---
  const secondBin = randomBin();
  const second = await call('POST', base, owner.token, {
    name: 'ТОО «Южное»',
    legalName: 'Товарищество с ограниченной ответственностью «Южное»',
    bin: secondBin,
    orgForm: 'too',
  });
  check('второе юрлицо создано', second.ok && !second.json?.data?.isHead, `${second.status}`);
  const secondId = second.json?.data?.id;

  // --- 4. Дубль БИН → 409 с машинным кодом ---
  const dup = await call('POST', base, owner.token, { name: 'Дубль', bin: secondBin });
  check(
    'дубль БИН отвергнут 409',
    dup.status === 409 && dup.code === 'legal_entity_bin_duplicate',
    `${dup.status}/${dup.code}`,
  );

  // --- 5. Счёт заводится у ЮРЛИЦА ---
  const acc = await call('POST', `${base}/${secondId}/accounts`, owner.token, {
    iban: 'KZ86125KZT5004100100',
    bankName: 'Kaspi Bank',
    bik: 'CASPKZKA',
  });
  check('счёт добавлен юрлицу', acc.ok && acc.json?.data?.bankAccounts?.length === 1, `${acc.status}`);
  const headNow = (await call('GET', `/workspaces/${ws.id}/requisites`, owner.token)).json?.data;
  check('счёт второго юрлица НЕ виден в реквизитах головного', (headNow?.bankAccounts?.length ?? 0) === 0);

  // --- 6. Головное не архивируется ---
  const archHead = await call('POST', `${base}/${headAfter.id}/archive`, owner.token, {});
  check(
    'головное юрлицо архивировать нельзя (409)',
    archHead.status === 409 && archHead.code === 'legal_entity_head',
    `${archHead.status}/${archHead.code}`,
  );

  // --- 7. Совместительство: две живые карточки в РАЗНЫХ юрлицах — ок ---
  await hire(ws, owner.token, worker.token, SUITE.p2);
  const empBase = `/workspaces/${ws.id}/hr/members/${worker.id}/employment`;
  const e1 = await call('PUT', empBase, owner.token, { salaryAmount: 25000000, workRate: 1 });
  check('карточка в головном юрлице заведена', e1.ok, `${e1.status}`);
  check('карточка несёт юрлицо', e1.json?.data?.legalEntityId === headAfter.id, e1.json?.data?.legalEntityId);

  const e2 = await call('PUT', empBase, owner.token, {
    legalEntityId: secondId,
    salaryAmount: 10000000,
    workRate: 0.5,
  });
  check('вторая карточка в ДРУГОМ юрлице — ок', e2.ok && e2.json?.data?.id !== e1.json?.data?.id, `${e2.status}`);

  const cardAfter = (await call('GET', `/workspaces/${ws.id}/hr/members/${worker.id}`, owner.token)).json?.data;
  check('карточка человека отдаёт обе трудовые', (cardAfter?.employments?.length ?? 0) === 2, `${cardAfter?.employments?.length}`);
  check('employment (совместимость) = головное', cardAfter?.employment?.legalEntityId === headAfter.id);

  // Повторная правка ТОЙ ЖЕ карточки не плодит третью
  const e2again = await call('PUT', empBase, owner.token, { legalEntityId: secondId, workRate: 0.75 });
  const cardAfter2 = (await call('GET', `/workspaces/${ws.id}/hr/members/${worker.id}`, owner.token)).json?.data;
  check('повторная правка не плодит карточку', e2again.ok && cardAfter2?.employments?.length === 2, `${cardAfter2?.employments?.length}`);

  // --- 8. Архив юрлица с карточками: сама запись архивируется, договоры остаются ---
  const arch = await call('POST', `${base}/${secondId}/archive`, owner.token, {});
  check('юрлицо ушло в архив', arch.ok && !!arch.json?.data?.archivedAt, `${arch.status}`);
  const liveList = (await call('GET', base, owner.token)).json?.data ?? [];
  check('архивное не в живом списке', !liveList.some((e) => e.id === secondId));
  const withArch = (await call('GET', `${base}?archived=true`, owner.token)).json?.data ?? [];
  check('archived=true показывает архивное', withArch.some((e) => e.id === secondId));

  // Новый договор на архивное юрлицо не заключается
  const onArchived = await call('PUT', `/workspaces/${ws.id}/hr/members/${owner.id}/employment`, owner.token, {
    legalEntityId: secondId,
    workRate: 1,
  });
  check(
    'договор на архивное юрлицо отвергнут',
    onArchived.status === 409 && onArchived.code === 'legal_entity_archived',
    `${onArchived.status}/${onArchived.code}`,
  );

  const restored = await call('POST', `${base}/${secondId}/restore`, owner.token, {});
  check('возврат из архива', restored.ok && !restored.json?.data?.archivedAt, `${restored.status}`);

  // --- 9. Чужому организация не видна ---
  const stranger = await login(SUITE.p3);
  const denied = await call('GET', base, stranger.token);
  check('постороннему список юрлиц закрыт', denied.status === 404 || denied.status === 403, `${denied.status}`);

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
