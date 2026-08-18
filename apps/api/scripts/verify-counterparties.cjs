// Сервис «Контрагенты» (B2B): справочник, гейты, дедуп БИН, контакты, счета.
// Аккаунты СЬЮТА (suite1/2/3); мусор прогона убирается штатным путём в конце.
const { call, login, makeChecker, SUITE } = require('./_lib.cjs');

const { check, finish } = makeChecker();

/** Валидный 12-значный БИН/ИИН: подбираем контрольную цифру (двухпроходный mod 11) */
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

async function main() {
  const owner = await login(SUITE.p1);
  const trainee = await login(SUITE.p2);

  // Организация прогона (уборка в конце — gc-скрипт умеет добирать хвосты)
  const ws = (await call('POST', '/workspaces', owner.token, { name: `Сьют-Контрагенты ${Date.now()}` })).json
    .data;
  check('организация создана', !!ws?.id);

  // Найм suite2 (Стажёр): чтение справочника ему открыто, запись — нет
  const inv = (await call('POST', `/workspaces/${ws.id}/invitations`, owner.token, { phone: SUITE.p2 })).json
    ?.data;
  const myInv = (await call('GET', '/workspaces/invitations/incoming', trainee.token)).json?.data?.find?.(
    (i) => i.workspaceId === ws.id,
  );
  await call('POST', `/workspaces/invitations/${myInv?.id ?? inv?.id}/accept`, trainee.token);

  const base = `/workspaces/${ws.id}/counterparties`;
  const bin = randomBin();

  // --- Создание: гейт manager+ ---
  const asTrainee = await call('POST', base, trainee.token, { name: 'Ромашка', kind: 'legal' });
  check('Стажёру запись закрыта (403)', asTrainee.status === 403, `got ${asTrainee.status}`);

  const created = await call('POST', base, owner.token, {
    kind: 'legal',
    orgForm: 'too',
    name: 'Ромашка',
    legalName: 'Товарищество с ограниченной ответственностью «Ромашка»',
    bin,
    legalAddress: 'г. Астана, пр. Абая, 1',
    kbe: '17',
    taxRegime: 'simplified',
    directorName: 'Иванов Иван',
    signBasis: 'Устава',
    vatPayer: false,
    phone: '+7 727 244 00 00',
    email: 'info@romashka.kz',
  });
  check('контрагент создан', created.ok, JSON.stringify(created.json?.message ?? ''));
  const cp = created.json?.data;
  check(
    'новые поля карточки едут в DTO (режим, орг-форма, телефон)',
    cp?.taxRegime === 'simplified' && cp?.orgForm === 'too' && cp?.phone === '+77272440000' && cp?.email === 'info@romashka.kz',
    JSON.stringify({ taxRegime: cp?.taxRegime, orgForm: cp?.orgForm, phone: cp?.phone }),
  );

  // Фактический адрес: пусто = совпадает с юридическим — резолвер шаблонов
  // подставляет юрадрес (контракт честности группы «Контрагент»)
  const resolved = (
    await call('POST', '/templates/dev/resolve', owner.token, { workspaceId: ws.id, counterpartyId: cp.id })
  ).json?.data?.values?.['Контрагент'];
  check(
    'пустой фактический адрес падает на юридический (теги шаблонов)',
    resolved?.['Фактический адрес'] === 'г. Астана, пр. Абая, 1' &&
      resolved?.['Налоговый режим'] === 'Упрощённая декларация',
    JSON.stringify({ addr: resolved?.['Фактический адрес'], regime: resolved?.['Налоговый режим'] }),
  );
  const patched = await call('PATCH', `${base}/${cp.id}`, owner.token, { actualAddress: 'г. Астана, ул. Сыганак, 5' });
  check('фактический адрес сохраняется правкой', patched.ok && patched.json?.data?.actualAddress === 'г. Астана, ул. Сыганак, 5');

  // Rich-card: контрагент пересылается в чат живой карточкой (Принцип 3)
  const card = await call('GET', `/rich-cards/counterparty/${cp.id}`, owner.token);
  check(
    'rich-card контрагента рендерится (название + БИН + «Открыть»)',
    card.ok &&
      card.json?.data?.title === 'Ромашка' &&
      JSON.stringify(card.json?.data?.fields ?? []).includes(bin) &&
      String(card.json?.data?.href ?? '').includes(`open=${cp.id}`),
    JSON.stringify(card.json?.data ?? card.status),
  );
  const cardAsTrainee = await call('GET', `/rich-cards/counterparty/${cp.id}`, trainee.token);
  check('rich-card видит и команда (Стажёр)', cardAsTrainee.ok, `status ${cardAsTrainee.status}`);

  // --- БИН: контрольная сумма и дедуп ---
  const badBin = await call('POST', base, owner.token, { name: 'Кривой', bin: '123456789012' });
  check('битый БИН отвергнут (400)', badBin.status === 400);
  const dup = await call('POST', base, owner.token, { name: 'Ромашка-2', bin });
  check('дубль БИН среди живых → 409', dup.status === 409, `got ${dup.status}`);

  // lookup находит живого
  const found = await call('GET', `${base}/lookup?bin=${bin}`, owner.token);
  check('lookup по БИН находит', found.ok && found.json?.data?.id === cp.id);
  // lookup Стажёру открыт (чтение)
  const foundT = await call('GET', `${base}/lookup?bin=${bin}`, trainee.token);
  check('чтение открыто Стажёру', foundT.ok);

  // --- Контакты ---
  const contact = await call('POST', `${base}/${cp.id}/contacts`, owner.token, {
    name: 'Асель Подписант',
    position: 'Директор',
    phone: '+7 700 777 00 77',
  });
  check('контакт создан (номер нормализован)', contact.ok && contact.json?.data?.phone === '+77007770077');
  const contactId = contact.json?.data?.id;

  const cpFull = (await call('GET', `${base}/${cp.id}`, owner.token)).json?.data;
  check('карточка отдаёт контакты', cpFull?.contacts?.length === 1);

  // --- Счета: первый основной сам, переключение, удаление передаёт роль ---
  const acc1 = await call('POST', `${base}/${cp.id}/accounts`, owner.token, {
    iban: 'KZ86125KZT5004100100',
    bankName: 'АО «Народный Банк»',
    bik: 'HSBKKZKX',
  });
  check('счёт 1 создан и основной', acc1.ok && acc1.json?.data?.isPrimary === true);
  const acc2 = await call('POST', `${base}/${cp.id}/accounts`, owner.token, {
    iban: 'KZ75125KZT2069100100',
    bankName: 'АО «Kaspi Bank»',
    bik: 'CASPKZKA',
  });
  check('счёт 2 не основной', acc2.ok && acc2.json?.data?.isPrimary === false);
  await call('POST', `${base}/${cp.id}/accounts/${acc2.json?.data?.id}/set-primary`, owner.token);
  let accounts = (await call('GET', `${base}/${cp.id}`, owner.token)).json?.data?.bankAccounts ?? [];
  check(
    'set-primary переключил основной',
    accounts.find((a) => a.id === acc2.json?.data?.id)?.isPrimary === true &&
      accounts.find((a) => a.id === acc1.json?.data?.id)?.isPrimary === false,
  );
  await call('DELETE', `${base}/${cp.id}/accounts/${acc2.json?.data?.id}`, owner.token);
  accounts = (await call('GET', `${base}/${cp.id}`, owner.token)).json?.data?.bankAccounts ?? [];
  check('удаление основного передало роль старейшему', accounts.length === 1 && accounts[0].isPrimary === true);

  // --- Список: страница ЦЕЛЬНАЯ в data (items + nextCursor), поиск ---
  const list = await call('GET', `${base}?search=Ромаш`, owner.token);
  check(
    'список: CursorPage в data',
    Array.isArray(list.json?.data?.items) && 'nextCursor' in (list.json?.data ?? {}),
  );
  check(
    'поиск находит и несёт documentsCount',
    list.json?.data?.items?.some((c) => c.id === cp.id && typeof c.documentsCount === 'number'),
  );

  // --- Правка (диффы в хронику) и хроника ---
  await call('PATCH', `${base}/${cp.id}`, owner.token, { legalAddress: 'г. Алматы, ул. Абая, 10' });
  const chron = await call('GET', `/chatter/counterparty/${cp.id}`, owner.token);
  const keys = (chron.json?.data?.items ?? []).map((e) => e.typeKey);
  check(
    'хроника: created + updated + contact_added',
    keys.includes('counterparty.created') && keys.includes('counterparty.updated') && keys.includes('counterparty.contact_added'),
    keys.join(','),
  );

  // --- Архив контакта (не удаление: на него ссылаются документы) ---
  await call('DELETE', `${base}/${cp.id}/contacts/${contactId}`, owner.token);
  const afterContact = (await call('GET', `${base}/${cp.id}`, owner.token)).json?.data;
  check('контакт ушёл из живых', (afterContact?.contacts ?? []).length === 0);

  // --- Архив карточки: живой документ блокирует ---
  const typeR = await call('POST', `/workspaces/${ws.id}/documents/doc-types`, owner.token, {
    name: 'Договор (сьют)',
    category: 'external',
  });
  check('external-вид создан (уровень по умолчанию ПЭП)', typeR.ok && typeR.json?.data?.signatureLevel === 'pep');
  const freeDoc = await call('POST', `/workspaces/${ws.id}/documents/free`, owner.token, {
    docTypeId: typeR.json?.data?.id,
    title: 'Договор с Ромашкой',
    counterpartyId: cp.id,
  });
  check('свободный документ с контрагентом создан', freeDoc.ok, JSON.stringify(freeDoc.json?.message ?? ''));
  // draft не блокирует архив (блокируют in_review|sent) — но документсCount виден
  const cpAfterDoc = (await call('GET', `${base}/${cp.id}`, owner.token)).json?.data;
  check('documentsCount вырос', cpAfterDoc?.documentsCount === 1);

  // Привязка контрагента к НЕ-external виду отвергается
  const generalType = await call('POST', `/workspaces/${ws.id}/documents/doc-types`, owner.token, {
    name: 'Служебка (сьют)',
    category: 'general',
  });
  const wrongBind = await call('POST', `/workspaces/${ws.id}/documents/free`, owner.token, {
    docTypeId: generalType.json?.data?.id,
    title: 'Служебка',
    counterpartyId: cp.id,
  });
  check('контрагент у не-external вида → 400', wrongBind.status === 400, `got ${wrongBind.status}`);

  // Фильтр «Вид» списка = орг-форма формы (ОДИН источник counterpartyFormQuery):
  // до этого список фильтровал по широкому kind и с формой разъезжался
  const byForm = await call('GET', `${base}?orgForm=too`, owner.token);
  check(
    'фильтр по орг-форме находит ТОО',
    byForm.ok && (byForm.json?.data?.items ?? []).some((r) => r.id === cp.id),
    JSON.stringify((byForm.json?.data?.items ?? []).map((r) => r.name)),
  );
  const byOtherForm = await call('GET', `${base}?orgForm=ao`, owner.token);
  check(
    'фильтр по чужой орг-форме карточку НЕ показывает',
    byOtherForm.ok && !(byOtherForm.json?.data?.items ?? []).some((r) => r.id === cp.id),
  );

  // Архив живой карточки проходит (документ в draft), после архива дубль-БИН свободен
  const archived = await call('DELETE', `${base}/${cp.id}`, owner.token);
  check('архив карточки прошёл', archived.ok);

  // Архив ВИДЕН отдельным списком и обратим (прецедент архива организаций)
  const archList = await call('GET', `${base}?archived=true`, owner.token);
  check(
    'архив читается списком',
    archList.ok && (archList.json?.data?.items ?? []).some((r) => r.id === cp.id),
    JSON.stringify((archList.json?.data?.items ?? []).map((r) => r.name)),
  );
  const liveList = await call('GET', base, owner.token);
  check('в действующих архивной карточки нет', !(liveList.json?.data?.items ?? []).some((r) => r.id === cp.id));

  const again = await call('POST', base, owner.token, { name: 'Ромашка (заново)', bin });
  check('архив отпускает БИН (создание заново)', again.ok);

  // Номер уже занят живой карточкой — возврат обязан отбиться, а не задвоить БИН
  const restoreBusy = await call('POST', `${base}/${cp.id}/restore`, owner.token);
  check('возврат при занятом БИН → 409', restoreBusy.status === 409, `got ${restoreBusy.status}`);

  // Освобождаем номер и возвращаем карточку
  await call('DELETE', `${base}/${again.json?.data?.id}`, owner.token);
  const restored = await call('POST', `${base}/${cp.id}/restore`, owner.token);
  check(
    'возврат из архива прошёл',
    restored.ok && restored.json?.data?.archivedAt === null,
    JSON.stringify(restored.json?.message ?? restored.status),
  );
  const liveAfter = await call('GET', base, owner.token);
  check('карточка снова в действующих', (liveAfter.json?.data?.items ?? []).some((r) => r.id === cp.id));
  const chronRestore = (await call('GET', `/chatter/counterparty/${cp.id}`, owner.token)).json?.data?.items ?? [];
  check('возврат записан в хронику', chronRestore.some((e) => e.typeKey === 'counterparty.restored'));

  const asTraineeRestore = await call('POST', `${base}/${cp.id}/restore`, trainee.token);
  check('Стажёру возврат закрыт (403)', asTraineeRestore.status === 403, `got ${asTraineeRestore.status}`);

  // Уборка: отменяем документ, убираем карточку в архив; организация — на gc
  await call('POST', `/workspaces/${ws.id}/documents/${freeDoc.json?.data?.id}/cancel`, owner.token);
  await call('DELETE', `${base}/${cp.id}`, owner.token);

  finish();
}

main().catch((e) => {
  console.error('CRASH', e);
  process.exit(1);
});
