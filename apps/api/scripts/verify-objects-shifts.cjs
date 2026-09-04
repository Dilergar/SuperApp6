// График смен объекта: шаблоны, ротация, публикация, «Возьму», факт, отдых, полночь.
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

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const owner = await login(SUITE.p1);
  const worker = await login(SUITE.p2);
  const other = await login(SUITE.p3);

  const ws = (await call('POST', '/workspaces', owner.token, { name: `Сьют-Смены ${Date.now()}` })).json.data;
  check('организация создана', !!ws?.id);
  await hire(ws.id, owner.token, worker.token, SUITE.p2);
  await hire(ws.id, owner.token, other.token, SUITE.p3);

  const base = `/workspaces/${ws.id}/objects`;
  const site = (await call('POST', base, owner.token, { name: 'Точка Смен', kind: 'site', timeZone: 'Asia/Almaty' })).json?.data;
  check('объект создан', !!site?.id);

  const posBarista = (await call('POST', `/workspaces/${ws.id}/staff/positions`, owner.token, { name: 'Бариста' })).json?.data;
  const posCook = (await call('POST', `/workspaces/${ws.id}/staff/positions`, owner.token, { name: 'Повар' })).json?.data;

  const unit = (await call('POST', `${base}/${site.id}/staffing/positions`, owner.token, { positionId: posBarista.id, headcount: 2 })).json?.data;
  const unitCook = (await call('POST', `${base}/${site.id}/staffing/positions`, owner.token, { positionId: posCook.id, headcount: 1 })).json?.data;
  check('штатные единицы созданы', !!unit?.rows && !!unitCook?.rows);
  const spBarista = unit.rows.find((r) => r.positionId === posBarista.id)?.staffingPositionId;
  const spCook = (await call('GET', `${base}/${site.id}/staffing`, owner.token)).json?.data?.rows?.find((r) => r.positionId === posCook.id)?.staffingPositionId;

  // suite2 — бариста, suite3 — повар
  const asg = await call('POST', `${base}/${site.id}/staffing/assign`, owner.token, { userId: worker.id, staffingPositionId: spBarista });
  check('бариста назначен', asg.ok, `${asg.status}`);
  const asgCook = await call('POST', `${base}/${site.id}/staffing/assign`, owner.token, { userId: other.id, staffingPositionId: spCook });
  check('повар назначен', asgCook.ok, `${asgCook.status}`);

  const table = (await call('GET', `${base}/${site.id}/staffing`, owner.token)).json?.data;
  const aWorker = table.rows.find((r) => r.assignment?.userId === worker.id)?.assignment?.id;
  const asgCookId = table.rows.find((r) => r.assignment?.userId === other.id)?.assignment?.id;

  // --- Шаблоны ---
  const tpl = (await call('POST', `/workspaces/${ws.id}/shift-templates`, owner.token, {
    name: 'Утро', startMin: 9 * 60, durationMin: 480, breakMin: 60, color: '#588cd3', branchId: site.id,
  })).json?.data;
  check('шаблон смены создан', !!tpl?.id, JSON.stringify(tpl ?? null));

  const nightTpl = (await call('POST', `/workspaces/${ws.id}/shift-templates`, owner.token, {
    name: 'Ночь', startMin: 22 * 60, durationMin: 480, branchId: site.id,
  })).json?.data;

  // --- Ротация 2/2 и идемпотентность генерации ---
  const today = isoDate(new Date());
  const pattern = await call('POST', `${base}/${site.id}/shift-patterns`, owner.token, {
    name: '2/2', assignmentId: aWorker, anchorDate: today, cycle: [tpl.id, tpl.id, null, null], activeFrom: today,
  });
  check('ротация создана', pattern.ok, `${pattern.status} ${JSON.stringify(pattern.json?.message ?? '')}`);

  const week = { from: today, to: addDays(today, 6) };
  const board1 = (await call('GET', `${base}/${site.id}/shifts?from=${week.from}&to=${week.to}`, owner.token)).json?.data;
  const count1 = board1?.shifts?.length ?? 0;
  check('ротация породила смены', count1 > 0, `${count1}`);

  await call('POST', `/workspaces/${ws.id}/shift-patterns/${pattern.json.data.id}/generate`, owner.token, {});
  const board2 = (await call('GET', `${base}/${site.id}/shifts?from=${week.from}&to=${week.to}`, owner.token)).json?.data;
  check('генерация идемпотентна (повтор не дублирует)', (board2?.shifts?.length ?? 0) === count1, `${board2?.shifts?.length} vs ${count1}`);

  // --- Черновик не виден сотруднику ---
  const boardWorkerDraft = (await call('GET', `${base}/${site.id}/shifts?from=${week.from}&to=${week.to}`, worker.token)).json?.data;
  check('черновик сотруднику не виден', (boardWorkerDraft?.shifts?.length ?? -1) === 0, `${boardWorkerDraft?.shifts?.length}`);

  // --- Публикация ---
  const pub = await call('POST', `${base}/${site.id}/shifts/publish`, owner.token, week);
  check('публикация прошла', pub.ok && (pub.json?.data?.published ?? 0) > 0, `${pub.status} ${JSON.stringify(pub.json?.data ?? {})}`);
  const boardWorker = (await call('GET', `${base}/${site.id}/shifts?from=${week.from}&to=${week.to}`, worker.token)).json?.data;
  check('после публикации сотрудник видит смены', (boardWorker?.shifts?.length ?? 0) > 0, `${boardWorker?.shifts?.length}`);

  // --- Слой календаря ---
  const calFrom = `${today}T00:00:00.000Z`;
  const calTo = `${addDays(today, 7)}T00:00:00.000Z`;
  const cal = await call('GET', `/calendar/events?from=${encodeURIComponent(calFrom)}&to=${encodeURIComponent(calTo)}&layers=shifts`, worker.token);
  const shiftItems = (cal.json?.data?.items ?? []).filter((i) => i.kind === 'shifts');
  check('смены лежат в слое календаря', shiftItems.length > 0, `${cal.status} items=${shiftItems.length}`);

  // --- Межсменный отдых: ночь сразу после утра ---
  const restViolation = await call('POST', `${base}/${site.id}/shifts`, owner.token, {
    localDate: today, startMin: 18 * 60, durationMin: 480, staffingPositionId: spBarista, assignmentId: aWorker,
  });
  check(
    'нарушение отдыха/пересечения отвергнуто 409',
    restViolation.status === 409 && ['rest_violation', 'shift_overlap'].includes(restViolation.code),
    `${restViolation.status}/${restViolation.code}`,
  );

  // force ставится на ТУ ЖЕ смену, что сейчас отвергли: иначе правило не нарушено,
  // обходить нечего, и проверка «обход записан в хронику» была ложноположительной —
  // она проходила лишь потому, что сервер писал `shift.forced` по самому флагу.
  const forced = await call('POST', `${base}/${site.id}/shifts`, owner.token, {
    localDate: today, startMin: 18 * 60, durationMin: 480, staffingPositionId: spBarista, assignmentId: aWorker, force: true,
  });
  check('force от управляющего проходит', forced.ok, `${forced.status}/${forced.code}`);

  // Пересечение не обходится НИЧЕМ: человек физически не в двух местах.
  const forcedOverlap = await call('POST', `${base}/${site.id}/shifts`, owner.token, {
    localDate: today, startMin: 18 * 60, durationMin: 480, staffingPositionId: spBarista, assignmentId: aWorker, force: true,
  });
  check(
    'пересечение не обходится force',
    forcedOverlap.status === 409 && forcedOverlap.code === 'shift_overlap',
    `${forcedOverlap.status}/${forcedOverlap.code}`,
  );

  // Хроника объекта получила запись об обходе правила
  const chron = await call('GET', `/chatter/branch/${site.id}?limit=50`, owner.token);
  const forcedEntry = (chron.json?.data?.items ?? []).some((e) => e.typeKey === 'shift.forced');
  check('обход правила записан в хронику', forcedEntry, `entries=${(chron.json?.data?.items ?? []).length}`);

  // --- Смена через полночь ---
  const overnight = await call('POST', `${base}/${site.id}/shifts`, owner.token, {
    localDate: addDays(today, 10), startMin: 22 * 60, durationMin: 480, staffingPositionId: spCook, templateId: nightTpl.id,
  });
  check('смена через полночь допустима', overnight.ok, `${overnight.status}/${overnight.code}`);
  if (overnight.ok) {
    const s = overnight.json.data;
    check('localDate = день НАЧАЛА смены', s.localDate === addDays(today, 10), `${s.localDate}`);
    check('конец смены — на следующие сутки', new Date(s.endsAt).getTime() > new Date(s.startsAt).getTime());
  }

  // --- Открытая смена и «Возьму» ---
  const openShift = (await call('POST', `${base}/${site.id}/shifts`, owner.token, {
    localDate: addDays(today, 14), startMin: 9 * 60, durationMin: 480, staffingPositionId: spBarista,
  })).json?.data;
  check('открытая смена создана', !!openShift?.id && openShift.userId === null);
  await call('POST', `${base}/${site.id}/shifts/publish`, owner.token, { from: addDays(today, 14), to: addDays(today, 14) });

  const takeWrong = await call('POST', `/workspaces/${ws.id}/shifts/${openShift.id}/take`, other.token, {});
  check('чужая должность взять не может (403)', takeWrong.status === 403 && takeWrong.code === 'shift_wrong_position', `${takeWrong.status}/${takeWrong.code}`);

  const takeOk = await call('POST', `/workspaces/${ws.id}/shifts/${openShift.id}/take`, worker.token, {});
  check('подходящая должность берёт смену', takeOk.ok && takeOk.json?.data?.userId === worker.id, `${takeOk.status}/${takeOk.code}`);

  const takeTwice = await call('POST', `/workspaces/${ws.id}/shifts/${openShift.id}/take`, worker.token, {});
  check('вторая попытка взять — 409', takeTwice.status === 409 && takeTwice.code === 'shift_not_open', `${takeTwice.status}/${takeTwice.code}`);

  // --- Факт выхода ---
  const firstShift = (board2?.shifts ?? []).find((s) => s.userId === worker.id);
  const att = await call('POST', `/workspaces/${ws.id}/shifts/${firstShift.id}/attendance`, owner.token, {
    outcome: 'late', lateMin: 25,
  });
  check('факт отмечен', att.ok && att.json?.data?.outcome === 'late' && att.json?.data?.lateMin === 25, `${att.status}`);
  const attAgain = await call('POST', `/workspaces/${ws.id}/shifts/${firstShift.id}/attendance`, owner.token, {
    outcome: 'worked',
  });
  check('повторная отметка ПРАВИТ, а не плодит', attAgain.ok && attAgain.json?.data?.id === att.json?.data?.id, `${attAgain.status}`);

  const attByWorker = await call('POST', `/workspaces/${ws.id}/shifts/${firstShift.id}/attendance`, worker.token, { outcome: 'worked' });
  check('рядовой факт не отмечает', attByWorker.status === 409 || attByWorker.status === 403, `${attByWorker.status}`);

  // Счётчики план/факт попали в штатку
  const tableAfter = (await call('GET', `${base}/${site.id}/staffing`, owner.token)).json?.data;
  const rowWorker = tableAfter?.rows?.find((r) => r.assignment?.userId === worker.id);
  check('счётчики смен в штатке', (rowWorker?.shifts?.planned ?? 0) > 0 && (rowWorker?.shifts?.worked ?? 0) > 0, JSON.stringify(rowWorker?.shifts ?? null));

  // --- Порт пропускной системы (source=access_control) ---
  const gateShift = (board2?.shifts ?? []).find((sh) => sh.userId === other.id) ??
    (await call('POST', `${base}/${site.id}/shifts`, owner.token, {
      localDate: addDays(today, 20), startMin: 9 * 60, durationMin: 480, staffingPositionId: spCook, assignmentId: asgCookId,
    })).json?.data;
  await call('POST', `${base}/${site.id}/shifts/publish`, owner.token, { from: addDays(today, 20), to: addDays(today, 20) });

  // Приход в допуске (10 мин) — «вышел»
  const inSoon = new Date(new Date(gateShift.startsAt).getTime() + 5 * 60000).toISOString();
  const gate1 = await call('POST', `${base}/${site.id}/attendance/gate`, owner.token, {
    userId: other.id, at: inSoon, direction: 'in', sourceRef: 'dev-1',
  });
  check('пропускная: приход в допуске = «вышел»', gate1.ok && gate1.json?.data?.outcome === 'worked', `${gate1.status} ${JSON.stringify(gate1.json?.data?.outcome)}`);
  check('источник события — access_control', gate1.json?.data?.source === 'access_control', `${gate1.json?.data?.source}`);

  // Уход дописывает фактическое окончание
  const outAt = new Date(new Date(gateShift.endsAt).getTime()).toISOString();
  const gate2 = await call('POST', `${base}/${site.id}/attendance/gate`, owner.token, {
    userId: other.id, at: outAt, direction: 'out', sourceRef: 'dev-2',
  });
  check('пропускная: уход пишет фактическое окончание', gate2.ok && !!gate2.json?.data?.actualEndAt, `${gate2.status}`);

  // Опоздание сверх допуска
  const lateShift = (await call('POST', `${base}/${site.id}/shifts`, owner.token, {
    localDate: addDays(today, 22), startMin: 9 * 60, durationMin: 480, staffingPositionId: spCook, assignmentId: asgCookId,
  })).json?.data;
  await call('POST', `${base}/${site.id}/shifts/publish`, owner.token, { from: addDays(today, 22), to: addDays(today, 22) });
  const lateAt = new Date(new Date(lateShift.startsAt).getTime() + 25 * 60000).toISOString();
  const gate3 = await call('POST', `${base}/${site.id}/attendance/gate`, owner.token, {
    userId: other.id, at: lateAt, direction: 'in',
  });
  check(
    'пропускная считает опоздание относительно допуска',
    gate3.ok && gate3.json?.data?.outcome === 'late' && gate3.json?.data?.lateMin === 25,
    `${gate3.status} ${JSON.stringify(gate3.json?.data ?? {})}`,
  );

  const gateByWorker = await call('POST', `${base}/${site.id}/attendance/gate`, worker.token, {
    userId: other.id, at: lateAt, direction: 'in',
  });
  check('рядовой пропускную ручку не дёргает', gateByWorker.status === 409 || gateByWorker.status === 403, `${gateByWorker.status}`);

  // --- Отмена ---
  const cancelled = await call('POST', `/workspaces/${ws.id}/shifts/${openShift.id}/cancel`, owner.token, {});
  check('смена отменена', cancelled.ok && cancelled.json?.data?.status === 'cancelled', `${cancelled.status}`);

  // ============================================================
  // Ревью 2026-09-04: уведомления, окно пропускной, табель, изоляция
  // ============================================================

  // 1. УВЕДОМЛЕНИЯ. Публикация обязана дойти до человека: `emitEvent` молча выходил
  //    на незамапленном типе, и весь раздел уведомлений о сменах был мёртв.
  // Уведомления кладёт ДЖОБ (`notifications.dispatch`) — движку нужно добежать.
  let shiftNotif = [];
  let notif = { status: 0 };
  for (let i = 0; i < 12; i += 1) {
    notif = await call('GET', '/notifications?limit=50', worker.token);
    const items = notif.json?.data?.items ?? notif.json?.data ?? [];
    shiftNotif = Array.isArray(items) ? items.filter((n) => String(n.type ?? '').startsWith('objects.')) : [];
    if (shiftNotif.length) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check('дайджест публикации дошёл сотруднику', shiftNotif.length > 0, `${notif.status} objects.*=${shiftNotif.length}`);

  // 2. ОКНО ПРОПУСКНОЙ на 12-часовой смене. Условие «смена целиком внутри ±12 ч»
  //    вырождалось: приход за минуту до начала не матчился, уход не писался никогда.
  const longDay = addDays(today, 60);
  const longShift = await call('POST', `${base}/${site.id}/shifts`, owner.token, {
    localDate: longDay, startMin: 8 * 60, durationMin: 720, staffingPositionId: spBarista, assignmentId: aWorker,
  });
  check('12-часовая смена поставлена', longShift.ok, `${longShift.status}/${longShift.code}`);
  await call('POST', `${base}/${site.id}/shifts/publish`, owner.token, { from: longDay, to: longDay });
  const early = await call('POST', `${base}/${site.id}/attendance/gate`, owner.token, {
    userId: worker.id,
    at: new Date(`${longDay}T02:59:00.000Z`).toISOString(), // 07:59 по Алматы — за минуту до начала
    direction: 'in',
    sourceRef: `gate-${Date.now()}-in`,
  });
  check(
    'приход за минуту до 12-часовой смены попал в план',
    early.ok && !!early.json?.data?.shiftId,
    `${early.status} shiftId=${early.json?.data?.shiftId ?? 'null'}`,
  );
  const late = await call('POST', `${base}/${site.id}/attendance/gate`, owner.token, {
    userId: worker.id,
    at: new Date(`${longDay}T15:01:00.000Z`).toISOString(), // 20:01 по Алматы — через минуту после конца
    direction: 'out',
    sourceRef: `gate-${Date.now()}-out`,
  });
  check('уход после 12-часовой смены записан', late.ok && !!late.json?.data?.actualEndAt, `${late.status}`);

  // 3. ИДЕМПОТЕНТНОСТЬ пропускной: повтор доставки события — не второй выход.
  const ref = `gate-idem-${Date.now()}`;
  const first = await call('POST', `${base}/${site.id}/attendance/gate`, owner.token, {
    userId: worker.id, at: new Date(`${longDay}T03:10:00.000Z`).toISOString(), direction: 'in', sourceRef: ref,
  });
  const repeat = await call('POST', `${base}/${site.id}/attendance/gate`, owner.token, {
    userId: worker.id, at: new Date(`${longDay}T03:10:00.000Z`).toISOString(), direction: 'in', sourceRef: ref,
  });
  check(
    'повтор события турникета не создаёт вторую запись',
    repeat.ok && repeat.json?.data?.id === first.json?.data?.id,
    `${repeat.status} ${first.json?.data?.id === repeat.json?.data?.id}`,
  );

  // 4. ТАБЕЛЬ: внеплановый выход теперь читается, правится и удаляется.
  const unplanned = await call('POST', `${base}/${site.id}/attendance`, owner.token, {
    userId: worker.id, localDate: addDays(today, 61), outcome: 'worked',
  });
  check('внеплановый выход записан', unplanned.ok, `${unplanned.status}`);
  const sheet = await call(
    'GET',
    `${base}/${site.id}/attendance?from=${addDays(today, 55)}&to=${addDays(today, 65)}`,
    owner.token,
  );
  const sheetRows = sheet.json?.data ?? [];
  check(
    'табель отдаёт внеплановую запись',
    sheet.ok && sheetRows.some((r) => r.id === unplanned.json?.data?.id),
    `${sheet.status} rows=${sheetRows.length}`,
  );
  const fixed = await call('PATCH', `/workspaces/${ws.id}/attendance/${unplanned.json?.data?.id}`, owner.token, {
    outcome: 'late', lateMin: 15,
  });
  check('запись табеля исправлена', fixed.ok && fixed.json?.data?.outcome === 'late', `${fixed.status}`);
  const dropped = await call('DELETE', `/workspaces/${ws.id}/attendance/${unplanned.json?.data?.id}`, owner.token);
  check('ошибочная запись табеля удалена', dropped.ok, `${dropped.status}`);

  // 5. ЧУЖОЙ ЧЕЛОВЕК в табель не пишется (у user_id нет внешнего ключа).
  const alien = await call('POST', `${base}/${site.id}/attendance`, owner.token, {
    userId: '11111111-1111-4111-8111-111111111111', localDate: today, outcome: 'worked',
  });
  check('чужого человека в табель не записать', alien.status === 400, `${alien.status}`);

  // 6. ДОГЕНЕРАЦИЯ по ротации — право на ВЕДЕНИЕ графика, а не «вижу объект».
  const patternsList = (await call('GET', `${base}/${site.id}/shift-patterns`, owner.token)).json?.data ?? [];
  if (patternsList[0]) {
    const genByWorker = await call('POST', `/workspaces/${ws.id}/shift-patterns/${patternsList[0].id}/generate`, worker.token, {});
    check('рядовой смены по ротации не догенерирует', genByWorker.status === 403, `${genByWorker.status}`);
  }

  // 7. ИЗОЛЯЦИЯ: ротация не принимает назначение и шаблон ЧУЖОЙ организации.
  const otherWs = (await call('POST', '/workspaces', owner.token, { name: `Сьют-Чужая ${Date.now()}` })).json?.data;
  const otherBase = `/workspaces/${otherWs.id}/objects`;
  const otherSite = (await call('POST', otherBase, owner.token, { name: 'Чужая точка', kind: 'site' })).json?.data;
  const otherTpl = (await call('POST', `/workspaces/${otherWs.id}/shift-templates`, owner.token, {
    name: 'Чужой шаблон', startMin: 9 * 60, durationMin: 480, branchId: otherSite.id,
  })).json?.data;
  const alienPattern = await call('POST', `${base}/${site.id}/shift-patterns`, owner.token, {
    name: 'Чужая ротация', assignmentId: aWorker, anchorDate: today, cycle: [otherTpl.id], activeFrom: today,
  });
  check('шаблон чужой организации в ротацию не берётся', !alienPattern.ok, `${alienPattern.status}`);
  const alienShift = await call('POST', `${base}/${site.id}/shifts`, owner.token, {
    localDate: addDays(today, 62), startMin: 9 * 60, durationMin: 480,
    staffingPositionId: spBarista, assignmentId: aWorker, templateId: otherTpl.id,
  });
  check('шаблон чужой организации в смену не берётся', !alienShift.ok, `${alienShift.status}`);

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
