// Сервис «Объекты» — §1 (дерево, права, архив) и §2 (штатное расписание).
// Аккаунты СЬЮТА (suite1/2/3); организация прогона одноразовая, БД не чистим.
const { call, login, makeChecker, SUITE } = require('./_lib.cjs');

const { check, finish } = makeChecker();

async function hire(wsId, ownerToken, personToken, phone) {
  const inv = (await call('POST', `/workspaces/${wsId}/invitations`, ownerToken, { phone })).json?.data;
  const mine = (await call('GET', '/workspaces/invitations/incoming', personToken)).json?.data?.find?.(
    (i) => i.workspaceId === wsId,
  );
  await call('POST', `/workspaces/invitations/${mine?.id ?? inv?.id}/accept`, personToken);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const owner = await login(SUITE.p1);
  const worker = await login(SUITE.p2);
  const manager = await login(SUITE.p3);

  const ws = (await call('POST', '/workspaces', owner.token, { name: `Сьют-Объекты ${Date.now()}` })).json.data;
  check('организация создана', !!ws?.id);
  const base = `/workspaces/${ws.id}/objects`;

  await hire(ws.id, owner.token, worker.token, SUITE.p2);
  await hire(ws.id, owner.token, manager.token, SUITE.p3);

  // ============================================================
  // §1. Дерево, перенос, права, архив
  // ============================================================

  const site = (await call('POST', base, owner.token, { name: 'Площадка Абая', kind: 'site', address: 'г. Алматы, Абая 10' })).json?.data;
  check('площадка создана', !!site?.id && site.depth === 0, `depth=${site?.depth}`);

  const building = (await call('POST', base, owner.token, { name: 'Здание А', kind: 'building', parentId: site.id })).json?.data;
  check('здание внутри площадки', building?.parentId === site.id && building?.depth === 1, `depth=${building?.depth}`);
  check('предки материализованы', JSON.stringify(building?.ancestorIds) === JSON.stringify([site.id]), JSON.stringify(building?.ancestorIds));

  const floor = (await call('POST', base, owner.token, { name: 'Этаж 2', kind: 'floor', parentId: building.id })).json?.data;
  check('этаж — глубина 2', floor?.depth === 2 && floor.ancestorIds.length === 2, `depth=${floor?.depth}`);

  // Юрлицо наследуется от предка/головного
  check('юрлицо наследуется', floor?.legalEntityInherited === true && !!floor?.effectiveLegalEntityId);

  // Цикл: перенести площадку внутрь своего этажа
  const cycle = await call('POST', `${base}/${site.id}/move`, owner.token, { parentId: floor.id });
  check('цикл отвергнут 409', cycle.status === 409 && cycle.code === 'object_cycle', `${cycle.status}/${cycle.code}`);

  // Перенос узла: этаж переезжает под площадку напрямую
  const moved = (await call('POST', `${base}/${floor.id}/move`, owner.token, { parentId: site.id })).json?.data;
  check('перенос пересчитал предков', moved?.depth === 1 && JSON.stringify(moved?.ancestorIds) === JSON.stringify([site.id]), `depth=${moved?.depth}`);
  // вернуть на место
  await call('POST', `${base}/${floor.id}/move`, owner.token, { parentId: building.id });

  // Удаление непустого узла
  const delBusy = await call('DELETE', `${base}/${building.id}`, owner.token);
  check('удаление узла с детьми — 409', delBusy.status === 409 && delBusy.code === 'object_has_children', `${delBusy.status}/${delBusy.code}`);

  // Права: рядовой без назначения не видит объектов (кроме тропинок — их нет)
  const treeWorker0 = (await call('GET', `${base}/tree`, worker.token)).json?.data;
  check('рядовой без назначения не видит объектов', (treeWorker0?.nodes?.length ?? -1) === 0, `${treeWorker0?.nodes?.length}`);
  check('рядовой не может создавать', treeWorker0?.canCreate === false);

  // Должности + назначение рядового на ЭТАЖ
  const posBarista = (await call('POST', `/workspaces/${ws.id}/staff/positions`, owner.token, { name: 'Бариста' })).json?.data;
  const posManager = (await call('POST', `/workspaces/${ws.id}/staff/positions`, owner.token, { name: 'Управляющий зданием' })).json?.data;
  check('должности созданы', !!posBarista?.id && !!posManager?.id);

  const assigned = await call('POST', `/workspaces/${ws.id}/staff/members/${worker.id}/assignments`, owner.token, {
    positionId: posBarista.id,
    branchId: floor.id,
  });
  check('рядовой назначен на этаж', assigned.ok, `${assigned.status}`);

  const treeWorker = (await call('GET', `${base}/tree`, worker.token)).json?.data;
  const seen = new Map((treeWorker?.nodes ?? []).map((n) => [n.id, n]));
  check('рядовой видит свой этаж', seen.get(floor.id)?.caps?.view === true);
  check('рядовой видит предков (тропинка)', seen.has(building.id) && seen.has(site.id), `nodes=${seen.size}`);
  check('рядовой НЕ управляет объектом', seen.get(floor.id)?.caps?.manage === false);
  check('рядовому деньги закрыты', seen.get(floor.id)?.caps?.payrollView === false);

  // Голова ЗДАНИЯ: управляющая должность на здании + назначение suite3 в здание
  await call('PATCH', `${base}/${building.id}`, owner.token, { headPositionId: posManager.id });
  await call('POST', `/workspaces/${ws.id}/staff/members/${manager.id}/assignments`, owner.token, {
    positionId: posManager.id,
    branchId: building.id,
  });

  const treeMgr = (await call('GET', `${base}/tree`, manager.token)).json?.data;
  const mgrSeen = new Map((treeMgr?.nodes ?? []).map((n) => [n.id, n]));
  check('голова здания видит свой этаж', mgrSeen.get(floor.id)?.caps?.view === true, JSON.stringify(mgrSeen.get(floor.id)?.caps));
  check('голова здания управляет этажом', mgrSeen.get(floor.id)?.caps?.manage === true);
  // Решение №9: деньги видят owner/admin И управляющий СВОЕГО объекта.
  check('управляющий объектом видит деньги своей ветки', mgrSeen.get(floor.id)?.caps?.payrollView === true);
  check('управляющий может ставить смены', mgrSeen.get(floor.id)?.caps?.scheduleManage === true);

  // Архив закрывает поддерево
  const arch = await call('POST', `${base}/${building.id}/archive`, owner.token, {});
  check('здание в архиве', arch.ok && !!arch.json?.data?.archivedAt, `${arch.status}`);
  const liveTree = (await call('GET', `${base}/tree`, owner.token)).json?.data;
  check('архивные не в живом дереве', !liveTree.nodes.some((n) => n.id === building.id || n.id === floor.id));
  const archTree = (await call('GET', `${base}/tree?archived=true`, owner.token)).json?.data;
  check('архивные видны с archived=true', archTree.nodes.some((n) => n.id === floor.id));
  await call('POST', `${base}/${building.id}/restore`, owner.token, {});
  await call('POST', `${base}/${floor.id}/restore`, owner.token, {});

  // Посторонний
  const stranger = await login(SUITE.p1); // тот же owner, но чужая организация ниже
  const otherWs = (await call('POST', '/workspaces', owner.token, { name: `Сьют-Чужая ${Date.now()}` })).json.data;
  const crossed = await call('GET', `/workspaces/${otherWs.id}/objects/${floor.id}`, owner.token);
  check('объект чужой организации — 404', crossed.status === 404, `${crossed.status}`);
  void stranger;

  // Коллеги объекта: площадка видит людей поддерева
  const people = (await call('GET', `${base}/${site.id}/people`, owner.token)).json?.data ?? [];
  check('коллеги площадки считают поддерево', people.some((p) => p.userId === worker.id), `${people.length}`);

  // ============================================================
  // §2. Штатное расписание
  // ============================================================

  const period = isoDate(new Date()).slice(0, 7);
  // Отдельная должность для §2: у suite2 уже есть «Бариста» на этаже из §1.
  const posBarman = (await call('POST', `/workspaces/${ws.id}/staff/positions`, owner.token, { name: 'Бармен' })).json?.data;
  const unit = await call('POST', `${base}/${floor.id}/staffing/positions`, owner.token, {
    positionId: posBarman.id,
    headcount: 2,
    plannedRate: { rateType: 'monthly', amount: '30000000' },
  });
  check('штатная единица создана', unit.ok, `${unit.status} ${JSON.stringify(unit.json?.error ?? unit.json?.message ?? '')}`);

  const dupUnit = await call('POST', `${base}/${floor.id}/staffing/positions`, owner.token, {
    positionId: posBarman.id,
    headcount: 1,
  });
  check('дубль единицы отвергнут 409', dupUnit.status === 409, `${dupUnit.status}/${dupUnit.code}`);

  const table = (await call('GET', `${base}/${floor.id}/staffing?period=${period}`, owner.token)).json?.data;
  check('таблица штатки отдаётся', !!table?.rows, `rows=${table?.rows?.length}`);
  const barmanRows = (table?.rows ?? []).filter((r) => r.positionId === posBarman.id);
  check('вакансии — отдельные строки (2 по штату)', barmanRows.length === 2 && barmanRows.every((r) => r.assignment === null), `${barmanRows.length}`);
  check('владельцу видна плановая ставка', !!barmanRows[0]?.plannedRate, JSON.stringify(barmanRows[0]?.plannedRate));

  const spId = barmanRows[0]?.staffingPositionId;
  const assignRes = await call('POST', `${base}/${floor.id}/staffing/assign`, owner.token, {
    userId: worker.id,
    staffingPositionId: spId,
    startsOn: isoDate(new Date()),
    rate: { rateType: 'monthly', amount: '25000000' },
  });
  check('назначение на штатную единицу', assignRes.ok, `${assignRes.status} ${JSON.stringify(assignRes.json?.message ?? '')}`);

  const table2 = (await call('GET', `${base}/${floor.id}/staffing?period=${period}`, owner.token)).json?.data;
  const filled = table2?.rows?.find((r) => r.positionId === posBarman.id && r.assignment);
  check('человек попал в таблицу', !!filled?.assignment?.userId, JSON.stringify(filled?.assignment ?? null));
  check('фактическая ставка записана', !!filled?.actualRate, JSON.stringify(filled?.actualRate ?? null));
  const barmanAfter = (table2?.rows ?? []).filter((r) => r.positionId === posBarman.id);
  check('вакансия осталась строкой (2 по штату)', barmanAfter.length === 2 && barmanAfter.some((r) => !r.assignment), `${barmanAfter.length}`);

  // Деньги в JSON: рядовому их НЕТ (полей нет вовсе, не null)
  const tableWorker = (await call('GET', `${base}/${floor.id}/staffing?period=${period}`, worker.token)).json?.data;
  const workerRow = tableWorker?.rows?.[0];
  const raw = JSON.stringify(tableWorker ?? {});
  check('рядовому штатка видна', !!tableWorker?.rows, `${tableWorker?.rows?.length}`);
  check('без права ПОЛЕЙ денег нет', workerRow && !('actualRate' in workerRow) && !('officialSalary' in workerRow), Object.keys(workerRow ?? {}).join(','));
  check('в JSON нет сумм', !raw.includes('25000000') && !raw.includes('30000000'));

  // Пересечение периодов назначения → 409
  const overlap = await call('POST', `${base}/${floor.id}/staffing/assign`, owner.token, {
    userId: worker.id,
    staffingPositionId: spId,
    startsOn: isoDate(new Date()),
  });
  check('пересечение назначений — 409', overlap.status === 409 && overlap.code === 'assignment_overlap', `${overlap.status}/${overlap.code}`);

  // Ставка с даты закрывает предыдущую
  const aId = filled?.assignment?.id;
  const tomorrow = isoDate(new Date(Date.now() + 86400000));
  const rate2 = await call('POST', `/workspaces/${ws.id}/staffing/assignments/${aId}/rates`, owner.token, {
    rateType: 'monthly',
    amount: '28000000',
    effectiveFrom: tomorrow,
  });
  check('новая ставка принята', rate2.ok, `${rate2.status}`);
  const rates = (await call('GET', `/workspaces/${ws.id}/staffing/assignments/${aId}/rates`, owner.token)).json?.data ?? [];
  const closed = rates.find((r) => r.amount === '25000000');
  check('предыдущая ставка закрыта датой', !!closed?.effectiveTo, JSON.stringify(closed ?? null));

  // Закрытие назначения
  const closeRes = await call('POST', `/workspaces/${ws.id}/staffing/assignments/${aId}/close`, owner.token, {
    endsOn: isoDate(new Date()),
  });
  check('назначение закрыто', closeRes.ok, `${closeRes.status}`);

  // Повторное назначение после закрытия — можно (уникум снят)
  const again = await call('POST', `${base}/${floor.id}/staffing/assign`, owner.token, {
    userId: worker.id,
    staffingPositionId: spId,
    startsOn: isoDate(new Date(Date.now() + 2 * 86400000)),
  });
  check('повторное назначение после закрытия — ок', again.ok, `${again.status} ${JSON.stringify(again.json?.message ?? '')}`);

  // Увольнение в КЭДО закрывает назначения датой приказа — проверяется в verify-hr;
  // здесь проверяем системный порт закрытия через выход из организации.

  // ============================================================
  // 3. Жизненный цикл объекта: удаление, архив, основной, имена
  //    (ревью 2026-09-04 — все проверки ниже ловят починенные дефекты)
  // ============================================================

  // Удаление объекта, который держат штатка/оборудование — 409 с машинным кодом,
  // а НЕ 500 (внешние ключи стоят на Restrict, P2003 в общий фильтр не разобран).
  const delStaffed = await call('DELETE', `${base}/${floor.id}`, owner.token);
  check(
    'удаление объекта со штаткой — 409',
    delStaffed.status === 409 && delStaffed.code === 'object_in_use',
    `${delStaffed.status}/${delStaffed.code}`,
  );

  // Одноимённые узлы в РАЗНЫХ ветках: уникальность имени — на пару «родитель + имя».
  const bldTwo = (await call('POST', base, owner.token, { name: 'Здание Б', kind: 'building', parentId: site.id })).json?.data;
  const twinFloor = await call('POST', base, owner.token, { name: 'Этаж 2', kind: 'floor', parentId: bldTwo?.id });
  check('одноимённый этаж в другом здании — можно', twinFloor.ok, `${twinFloor.status} ${JSON.stringify(twinFloor.json?.message ?? '')}`);

  // Архив: возврат родителя НЕ оживляет то, что закрывали отдельно и раньше.
  await call('POST', `${base}/${twinFloor.json?.data?.id}/archive`, owner.token);
  await call('POST', `${base}/${bldTwo.id}/archive`, owner.token);
  await call('POST', `${base}/${bldTwo.id}/restore`, owner.token);
  const treeArch = (await call('GET', `${base}/tree?archived=true`, owner.token)).json?.data;
  const twinAfter = treeArch?.nodes?.find((n) => n.id === twinFloor.json?.data?.id);
  check('возврат родителя не оживил закрытого отдельно', !!twinAfter?.archivedAt, `archivedAt=${twinAfter?.archivedAt}`);

  // Возврат ребёнка при архивном родителе — отказ: живой этаж внутри закрытого
  // здания в жизни не встречается.
  await call('POST', `${base}/${bldTwo.id}/archive`, owner.token);
  const restoreChild = await call('POST', `${base}/${twinFloor.json?.data?.id}/restore`, owner.token);
  check(
    'возврат ребёнка при архивном родителе — 409',
    restoreChild.status === 409,
    `${restoreChild.status}/${restoreChild.code}`,
  );

  // «Сделайте основным другой» перестало быть тупиком: ручка есть.
  const mkDefault = await call('POST', `${base}/${site.id}/make-default`, owner.token);
  check('объект стал основным', mkDefault.ok && mkDefault.json?.data?.isDefault === true, `${mkDefault.status}`);
  const mkByWorker = await call('POST', `${base}/${site.id}/make-default`, worker.token);
  check('рядовой основным не назначает', mkByWorker.status === 403 || mkByWorker.status === 404, `${mkByWorker.status}`);

  // Закрытое назначение больше не числится коллегой (правило activeAssignmentWhere).
  const peopleAfter = (await call('GET', `${base}/${floor.id}/people`, owner.token)).json?.data ?? [];
  const nodeAfter = (await call('GET', `${base}/${floor.id}`, owner.token)).json?.data;
  check(
    'счётчик людей и список коллег согласованы',
    peopleAfter.length === (nodeAfter?.membersCount ?? -1),
    `people=${peopleAfter.length} membersCount=${nodeAfter?.membersCount}`,
  );

  // Закрытие датой раньше начала — 400 с понятным текстом, а не 500 из CHECK.
  const badClose = await call('POST', `/workspaces/${ws.id}/staffing/assignments/${aId}/close`, owner.token, {
    endsOn: '2020-01-01',
  });
  check('закрытие датой раньше начала — 400', badClose.status === 400, `${badClose.status}`);

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
