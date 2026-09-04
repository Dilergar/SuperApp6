// Оборудование объекта: модели на лету, журналы, права, деньги, инвентарные номера.
// Аккаунты СЬЮТА; организация прогона одноразовая.
const { call, login, makeChecker, SUITE } = require('./_lib.cjs');

const { check, finish } = makeChecker();

async function hire(wsId, ownerToken, personToken, phone) {
  const inv = (await call('POST', `/workspaces/${wsId}/invitations`, ownerToken, { phone })).json?.data;
  const mine = (await call('GET', '/workspaces/invitations/incoming', personToken)).json?.data?.find?.(
    (i) => i.workspaceId === wsId,
  );
  await call('POST', `/workspaces/invitations/${mine?.id ?? inv?.id}/accept`, personToken);
}

async function main() {
  const owner = await login(SUITE.p1);
  const worker = await login(SUITE.p2);
  const stranger = await login(SUITE.p3);

  const ws = (await call('POST', '/workspaces', owner.token, { name: `Сьют-Оборудование ${Date.now()}` })).json.data;
  check('организация создана', !!ws?.id);
  await hire(ws.id, owner.token, worker.token, SUITE.p2);
  await hire(ws.id, owner.token, stranger.token, SUITE.p3);

  const base = `/workspaces/${ws.id}/objects`;
  const siteA = (await call('POST', base, owner.token, { name: 'Точка А', kind: 'site' })).json?.data;
  const siteB = (await call('POST', base, owner.token, { name: 'Точка Б', kind: 'site' })).json?.data;
  check('объекты созданы', !!siteA?.id && !!siteB?.id);

  // suite2 работает в А, suite3 — нигде (посторонний по объектам)
  const pos = (await call('POST', `/workspaces/${ws.id}/staff/positions`, owner.token, { name: 'Бариста' })).json?.data;
  await call('POST', `/workspaces/${ws.id}/staff/members/${worker.id}/assignments`, owner.token, {
    positionId: pos.id,
    branchId: siteA.id,
  });

  // --- Модель создаётся на лету и ПЕРЕИСПОЛЬЗУЕТСЯ ---
  const a1 = await call('POST', `${base}/${siteA.id}/assets`, owner.token, {
    newModel: { name: 'Кофемашина Jura X8', manufacturer: 'Jura' },
    name: 'Кофемашина у бара',
    inventoryNumber: 'INV-001',
    purchasePrice: '45000000',
    custodianUserId: worker.id,
  });
  check('оборудование создано с новой моделью', a1.ok, `${a1.status} ${JSON.stringify(a1.json?.message ?? '')}`);
  const asset1 = a1.json?.data;

  const models = (await call('GET', `/workspaces/${ws.id}/asset-models`, owner.token)).json?.data ?? [];
  check('модель попала в справочник', models.length === 1 && models[0].name === 'Кофемашина Jura X8', `${models.length}`);

  const a2 = await call('POST', `${base}/${siteA.id}/assets`, owner.token, {
    newModel: { name: 'Кофемашина Jura X8' },
    name: 'Кофемашина запасная',
    inventoryNumber: 'INV-002',
  });
  const modelsAfter = (await call('GET', `/workspaces/${ws.id}/asset-models`, owner.token)).json?.data ?? [];
  check('повтор той же модели не плодит справочник', a2.ok && modelsAfter.length === 1, `${modelsAfter.length}`);
  check('счётчик экземпляров модели', modelsAfter[0]?.assetsCount === 2, `${modelsAfter[0]?.assetsCount}`);

  // --- Инвентарный дубль ---
  const dup = await call('POST', `${base}/${siteA.id}/assets`, owner.token, {
    modelId: modelsAfter[0].id,
    name: 'Третья',
    inventoryNumber: 'INV-001',
  });
  check(
    'инвентарный дубль отвергнут 409',
    dup.status === 409 && dup.code === 'asset_inventory_duplicate',
    `${dup.status}/${dup.code}`,
  );

  // --- Удаление модели с экземплярами ---
  const delModel = await call('DELETE', `/workspaces/${ws.id}/asset-models/${modelsAfter[0].id}`, owner.token);
  check(
    'модель с экземплярами не удаляется (409)',
    delModel.status === 409 && delModel.code === 'asset_model_in_use',
    `${delModel.status}/${delModel.code}`,
  );

  // --- Перемещение пишет журнал и меняет объект ---
  const moved = await call('POST', `/workspaces/${ws.id}/assets/${asset1.id}/move`, owner.token, {
    branchId: siteB.id,
    reason: 'перевезли на новую точку',
  });
  check('перемещение прошло', moved.ok && moved.json?.data?.branchId === siteB.id, `${moved.status}`);

  const card = (await call('GET', `/workspaces/${ws.id}/assets/${asset1.id}`, owner.token)).json?.data;
  const placement = (card?.moves ?? []).filter((m) => m.kind === 'placement');
  check('журнал перемещений пополнился', placement.length >= 2, `${placement.length}`);
  check('в журнале есть «откуда → куда»', placement.some((m) => m.fromLabel === 'Точка А' && m.toLabel === 'Точка Б'), JSON.stringify(placement[0] ?? null));

  // --- Ответственный — запись журнала ---
  const cust = await call('POST', `/workspaces/${ws.id}/assets/${asset1.id}/custodian`, owner.token, {
    custodianUserId: null,
    reason: 'уволился',
  });
  check('ответственный снят', cust.ok && cust.json?.data?.custodianUserId === null, `${cust.status}`);
  const card2 = (await call('GET', `/workspaces/${ws.id}/assets/${asset1.id}`, owner.token)).json?.data;
  check('смена ответственного — запись журнала', (card2?.moves ?? []).some((m) => m.kind === 'custodian'));

  // --- Обслуживание и TCO ---
  await call('POST', `/workspaces/${ws.id}/assets/${asset1.id}/service`, owner.token, {
    kind: 'repair', title: 'Замена помпы', cost: '3500000',
  });
  await call('POST', `/workspaces/${ws.id}/assets/${asset1.id}/service`, owner.token, {
    kind: 'maintenance', title: 'Чистка', cost: '1500000',
  });
  const card3 = (await call('GET', `/workspaces/${ws.id}/assets/${asset1.id}`, owner.token)).json?.data;
  const tco = (card3?.services ?? []).reduce((sum, r) => sum + Number(r.cost ?? 0), 0);
  check('TCO = сумма записей обслуживания', tco === 5000000, `${tco}`);

  // --- Статус: списание уводит из живого списка ---
  const written = await call('POST', `/workspaces/${ws.id}/assets/${asset1.id}/status`, owner.token, {
    status: 'written_off', reason: 'не подлежит ремонту',
  });
  check('статус «списано» проставлен', written.ok && written.json?.data?.status === 'written_off', `${written.status}`);
  const liveB = (await call('GET', `${base}/${siteB.id}/assets`, owner.token)).json?.data;
  check('списанное ушло из живого списка', !(liveB?.items ?? []).some((x) => x.id === asset1.id), `${liveB?.items?.length}`);

  // --- Права: член объекта видит, посторонний нет ---
  const asWorker = await call('GET', `${base}/${siteA.id}/assets`, worker.token);
  check('член объекта видит оборудование', asWorker.ok && (asWorker.json?.data?.items?.length ?? 0) > 0, `${asWorker.status}`);
  const asStranger = await call('GET', `${base}/${siteA.id}/assets`, stranger.token);
  check('посторонний объект не видит (404)', asStranger.status === 404, `${asStranger.status}`);

  // --- Деньги: без права полей НЕТ ---
  const asset2 = (asWorker.json?.data?.items ?? [])[0];
  const rawWorker = JSON.stringify(asWorker.json?.data ?? {});
  check('без права поля цены нет', asset2 && !('purchasePrice' in asset2) && !('holdingKind' in asset2), Object.keys(asset2 ?? {}).join(','));
  check('в JSON нет суммы покупки', !rawWorker.includes('45000000'));

  const cardWorker = await call('GET', `/workspaces/${ws.id}/assets/${asset2.id}`, worker.token);
  check('карточка сотруднику видна', cardWorker.ok, `${cardWorker.status}`);
  check('в карточке без права нет денег', !JSON.stringify(cardWorker.json?.data?.asset ?? {}).includes('purchasePrice'));

  // Владение меняет только тот, кто видит деньги
  const holdingByWorker = await call('POST', `/workspaces/${ws.id}/assets/${asset2.id}/holding`, worker.token, {
    holdingKind: 'rented',
  });
  check('без права на деньги владение не меняется', holdingByWorker.status === 409 || holdingByWorker.status === 403, `${holdingByWorker.status}`);

  const holdingByOwner = await call('POST', `/workspaces/${ws.id}/assets/${asset2.id}/holding`, owner.token, {
    holdingKind: 'rented',
  });
  check('владелец меняет владение', holdingByOwner.ok && holdingByOwner.json?.data?.holdingKind === 'rented', `${holdingByOwner.status}`);

  // ============================================================
  // Ревью 2026-09-04: журнал, возврат из списания, чужие id, TCO
  // ============================================================

  // 1. ЖУРНАЛ ПЕРЕМЕЩЕНИЙ не раскрывает владение тому, кому деньги закрыты:
  //    правило сужения обязано стоять во ВСЕХ путях ответа, не только в самом активе.
  const cardForWorker = await call('GET', `/workspaces/${ws.id}/assets/${asset2.id}`, worker.token);
  const workerMoves = cardForWorker.json?.data?.moves ?? [];
  check(
    'запись о владении скрыта без права на деньги',
    cardForWorker.ok && workerMoves.every((m) => m.kind !== 'holding'),
    `${cardForWorker.status} moves=${workerMoves.map((m) => m.kind).join(',')}`,
  );
  const cardForOwner = await call('GET', `/workspaces/${ws.id}/assets/${asset2.id}`, owner.token);
  check(
    'владельцу запись о владении видна',
    (cardForOwner.json?.data?.moves ?? []).some((m) => m.kind === 'holding'),
    `${cardForOwner.status}`,
  );

  // 2. ВОЗВРАТ ИЗ СПИСАНИЯ. Раньше `archivedAt` не снимался никогда: статус
  //    возвращался, а из списков и поиска актив исчезал навсегда.
  await call('POST', `/workspaces/${ws.id}/assets/${asset2.id}/status`, owner.token, { status: 'written_off' });
  const goneList = (await call('GET', `${base}/${siteA.id}/assets`, owner.token)).json?.data?.items ?? [];
  check('списанное ушло из живого списка', !goneList.some((a) => a.id === asset2.id), `items=${goneList.length}`);
  await call('POST', `/workspaces/${ws.id}/assets/${asset2.id}/status`, owner.token, { status: 'active' });
  const backList = (await call('GET', `${base}/${siteA.id}/assets`, owner.token)).json?.data?.items ?? [];
  check('возврат в работу вернул актив в список', backList.some((a) => a.id === asset2.id), `items=${backList.length}`);

  // 3. ЧУЖИЕ ID. Внешние ключи не скоуплены организацией, у ответственного ключа нет
  //    вовсе — принадлежность проверяет сервис.
  const alienCustodian = await call('POST', `${base}/${siteA.id}/assets`, owner.token, {
    newModel: { name: `Модель-чужак ${Date.now()}` },
    name: 'Кофемашина с чужим ответственным',
    custodianUserId: '11111111-1111-4111-8111-111111111111',
  });
  check('чужой ответственный отвергнут', alienCustodian.status === 400, `${alienCustodian.status}`);
  const alienLegal = await call('POST', `/workspaces/${ws.id}/assets/${asset2.id}/holding`, owner.token, {
    holdingKind: 'leased',
    balanceLegalEntityId: '22222222-2222-4222-8222-222222222222',
  });
  check('чужое юрлицо-балансодержатель отвергнуто', alienLegal.status === 400, `${alienLegal.status}`);

  // 4. ИМЯ ОТВЕТСТВЕННОГО приходит с сервера (поле было жёстко null).
  const withCustodian = await call('POST', `/workspaces/${ws.id}/assets/${asset2.id}/custodian`, owner.token, {
    custodianUserId: worker.id,
  });
  check(
    'имя ответственного приходит с сервера',
    withCustodian.ok && !!withCustodian.json?.data?.custodianName,
    `${withCustodian.status} name=${withCustodian.json?.data?.custodianName ?? 'null'}`,
  );

  // 5. TCO считает СЕРВЕР (агрегатом по всем ремонтам), а не клиент по странице.
  await call('POST', `/workspaces/${ws.id}/assets/${asset2.id}/service`, owner.token, {
    kind: 'repair', title: 'Замена помпы', cost: '1500000',
  });
  const tcoCard = await call('GET', `/workspaces/${ws.id}/assets/${asset2.id}`, owner.token);
  check(
    'сумма расходов на обслуживание приходит с сервера',
    BigInt(tcoCard.json?.data?.asset?.serviceCost ?? '0') >= 1500000n,
    `serviceCost=${tcoCard.json?.data?.asset?.serviceCost}`,
  );
  const tcoForWorker = await call('GET', `/workspaces/${ws.id}/assets/${asset2.id}`, worker.token);
  check(
    'без права на деньги суммы расходов нет',
    !('serviceCost' in (tcoForWorker.json?.data?.asset ?? {})),
    `${tcoForWorker.status}`,
  );

  // 6. ФАЙЛЫ МОДЕЛИ: инструкция крепится к модели один раз (ручек не было вовсе).
  const modelsList = (await call('GET', `/workspaces/${ws.id}/asset-models`, owner.token)).json?.data ?? [];
  if (modelsList[0]) {
    const modelFiles = await call('GET', `/workspaces/${ws.id}/asset-models/${modelsList[0].id}/files`, owner.token);
    check('файлы модели читаются', modelFiles.ok && Array.isArray(modelFiles.json?.data), `${modelFiles.status}`);
  }

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
