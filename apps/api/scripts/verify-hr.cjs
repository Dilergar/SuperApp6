// КЭДО (modules/hr): сквозной путь.
// Библиотека бланков (мастер: вид+шаблон+ОПУБЛИКОВАННЫЙ маршрут) → трудовая
// карточка (гейт оклада) → приём с пакетом (черновик не виден субъекту) →
// маршрут: подпись работодателя (mock-ЭЦП) → ознакомление работника →
// регистрация → подшивка → hr.apply → ЕСУТД-срок → перевод БУДУЩЕЙ датой
// (scheduled, данные не раньше даты) → оклад → отпуск → увольнение (ст. 54,
// отзыв ст. 56 п. 4) → запрет удаления → личный архив переживает purge.
const { BASE, call, login, makeChecker, SUITE } = require('./_lib.cjs');

const { check, finish } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(name, fn, timeoutMs = 60000, everyMs = 900) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) {
      console.log(`  … timeout: ${name}`);
      return null;
    }
    await sleep(everyMs);
  }
}

const mockCms = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const today = () => new Date().toISOString().slice(0, 10);
// «Сегодня» — как считает сервер: календарная дата в APP_TIMEZONE (Asia/Almaty). UTC-дата после
// 19:00 по Алматы уже отстаёт на день, и «завтрашнее» действие применялось сразу.
const almatyToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plusDays = (n) => { const d = new Date(almatyToday + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Подписать свой акт заявки mock-ЭЦП (dev-верификатор принимает) */
async function signEcp(user, requestId) {
  const flow = await call('GET', `/sign/requests/${requestId}`, user.token);
  const actId = flow.json?.data?.myAct?.id;
  const sha = flow.json?.data?.request?.subjectSha256;
  if (!actId) throw new Error(`нет своего акта (req ${requestId})`);
  const r = await call('POST', `/sign/acts/${actId}/cms`, user.token, { cms: mockCms({ sha256: sha }) });
  if (!r.ok) throw new Error(`cms: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data;
}

/** Мой активный шаг по заявке предмета: из стопки (id элемента источника approval = stepId) */
async function myStepFor(user, wsId, titlePart, kind) {
  const inbox = await call('GET', `/approvals/inbox?workspaceId=${wsId}`, user.token);
  const items = inbox.json?.data?.items ?? [];
  return (
    items.find(
      (i) => i.sourceKey === 'approval' && i.title.includes(titlePart) && (!kind || i.stepKind === kind),
    ) ?? null
  );
}

async function main() {
  const owner = await login(SUITE.p1);
  const employee = await login(SUITE.p2); // сотрудник с карточкой
  const newbie = await login(SUITE.p3); // приём с нуля

  // ============ Организация + найм ============
  const ws = (await call('POST', '/workspaces', owner.token, { name: `Сьют-КЭДО ${Date.now()}` })).json.data;
  for (const u of [employee, newbie]) {
    await call('POST', `/workspaces/${ws.id}/invitations`, owner.token, { phone: u === employee ? SUITE.p2 : SUITE.p3 });
    const inv = (await call('GET', '/workspaces/invitations/incoming', u.token)).json?.data?.find?.(
      (i) => i.workspaceId === ws.id,
    );
    await call('POST', `/workspaces/invitations/${inv?.id}/accept`, u.token);
  }
  check('организация + найм двоих', !!ws?.id);

  // Должность/филиал для перевода и договора
  const pos1 = (await call('POST', `/workspaces/${ws.id}/staff/positions`, owner.token, { name: 'Официант' })).json.data;
  const pos2 = (await call('POST', `/workspaces/${ws.id}/staff/positions`, owner.token, { name: 'Бармен' })).json.data;
  const br = (await call('POST', `/workspaces/${ws.id}/staff/branches`, owner.token, { name: 'Филиал на Абая' })).json.data;
  await call('POST', `/workspaces/${ws.id}/staff/members/${employee.id}/assignments`, owner.token, {
    positionId: pos1.id,
  });
  check('справочники + факт-назначение', !!pos1?.id && !!pos2?.id && !!br?.id);

  // ============ Библиотека бланков (Этап 3) ============
  const lib = await call('GET', `/workspaces/${ws.id}/hr/library`, owner.token);
  check('каталог библиотеки отдаётся', lib.ok && (lib.json.data?.length ?? 0) >= 8, `items=${lib.json?.data?.length}`);

  const toInstall = ['hire_order', 'transfer_order', 'salary_order', 'leave_order', 'dismissal_order', 'pd_consent'];
  const installed = {};
  for (const key of toInstall) {
    const r = await call('POST', `/workspaces/${ws.id}/hr/library/install`, owner.token, {
      key,
      signerUserId: owner.id,
    });
    installed[key] = r.json?.data ?? null;
    check(`библиотека: установлен ${key}`, r.ok && !!r.json?.data?.installed && !!r.json?.data?.templateId, r.ok ? '' : JSON.stringify(r.json));
  }

  // Гейт: стажёру библиотека закрыта
  const libAsTrainee = await call('GET', `/workspaces/${ws.id}/hr/library`, employee.token);
  check('библиотека закрыта стажёру (403)', libAsTrainee.status === 403);

  // ============ Этап 1: трудовая карточка + гейты ============
  const emp = await call('PUT', `/workspaces/${ws.id}/hr/members/${employee.id}/employment`, owner.token, {
    hiredAt: '2026-01-15',
    contractNumber: 'ТД-2026-001',
    contractDate: '2026-01-15',
    legalPositionId: pos2.id, // ДОГОВОР говорит «Бармен», факт — «Официант» → расхождение
    salaryAmount: 25000000, // 250 000 ₸ тиынами
    workSchedule: '5/2, 09:00–18:00',
  });
  check('трудовая карточка заведена', emp.ok && emp.json.data?.salaryAmount === '25000000', JSON.stringify(emp.json?.data?.salaryAmount));

  const cardOwner = await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, owner.token);
  check(
    'оклад виден менеджеру',
    cardOwner.ok && cardOwner.json.data?.employment?.salaryAmount === '25000000' && cardOwner.json.data?.canSeeEmployment,
  );
  const cardSelf = await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, employee.token);
  check('оклад виден себе', cardSelf.ok && cardSelf.json.data?.employment?.salaryAmount === '25000000');
  const cardPeer = await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, newbie.token);
  check(
    'оклад скрыт стажёру (карточка без employment)',
    cardPeer.ok && cardPeer.json.data?.employment === null && cardPeer.json.data?.canSeeEmployment === false,
  );
  check(
    'расхождение факт/договор — плашка, не ошибка',
    cardOwner.json.data?.mismatch?.mismatch === true &&
      cardOwner.json.data?.mismatch?.factPositionName === 'Официант' &&
      cardOwner.json.data?.mismatch?.legalPositionName === 'Бармен',
  );
  const overview = await call('GET', `/workspaces/${ws.id}/hr/roster-overview`, owner.token);
  check('сводка ростера: расхождение у сотрудника', overview.ok && overview.json.data?.byUser?.[employee.id]?.mismatch === true);

  // Исключение из организации ≠ увольнение по ТК: с ЖИВЫМ договором ростер человека
  // не отпускает (иначе сроки ЕСУТД и расчёта тикали бы по тому, кого уже нет).
  const kickLive = await call('DELETE', `/workspaces/${ws.id}/members/${employee.id}`, owner.token);
  check(
    'исключение из организации при живом договоре → 409 employment_active',
    kickLive.status === 409 && kickLive.code === 'employment_active',
    `status ${kickLive.status} code ${kickLive.code}`,
  );

  // ============ Отрицательное: действие без маршрута с hr.apply ============
  // Свой шаблон без маршрута вовсе
  const bareType = (
    await call('POST', `/workspaces/${ws.id}/documents/doc-types`, owner.token, { name: 'Приказы без маршрута', category: 'hr' })
  ).json.data;
  const bareTpl = (
    await call('POST', `/workspaces/${ws.id}/documents/templates`, owner.token, {
      docTypeId: bareType.id,
      name: 'Бланк без маршрута',
      kind: 'builder',
    })
  ).json.data;
  await call('POST', `/workspaces/${ws.id}/documents/templates/${bareTpl.id}/publish`, owner.token);
  const noRoute = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'leave',
    userId: employee.id,
    effectiveAt: plusDays(3),
    effectiveTo: plusDays(6),
    templateId: bareTpl.id,
  });
  check('действие без маршрута с hr.apply — честный отказ', noRoute.status === 400 && noRoute.code === 'hr_no_apply_route', noRoute.code);

  // ============ Отрицательное: дата за горизонтом календаря ============
  const horizon = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'salary_change',
    userId: employee.id,
    effectiveAt: '2030-01-15',
    templateId: installed.salary_order.templateId,
    params: { salaryAmount: 30000000 },
  });
  check('дата за горизонтом календаря — честный отказ', horizon.status === 400 && horizon.code === 'hr_calendar_horizon', horizon.code);

  // ============ Этап 4: приём с онбординг-пакетом ============
  const hire = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'hire',
    userId: newbie.id,
    effectiveAt: today(),
    templateId: installed.hire_order.templateId,
    packageTemplateIds: [installed.pd_consent.templateId],
    params: { legalPositionId: pos1.id, salaryAmount: 20000000, probationUntil: plusDays(30) },
  });
  check('приём: действие + пакет из 2 документов', hire.ok && hire.json.data?.documents?.length === 2, JSON.stringify(hire.json?.details ?? hire.json?.message ?? ''));
  const hireAction = hire.json.data;
  const orderDoc = hireAction.documents[0];

  // Черновик приказа НЕ виден субъекту (видимость «с момента отправки ему»)
  const draftAsSubject = await call('GET', `/workspaces/${ws.id}/documents/${orderDoc.id}`, newbie.token);
  check('черновик приказа не виден субъекту (403)', draftAsSubject.status === 403, String(draftAsSubject.status));
  const subjList = await call(
    'GET',
    `/workspaces/${ws.id}/documents?subjectUserId=${newbie.id}`,
    newbie.token,
  );
  check(
    '«Обо мне» субъекта пуст до отправки ему',
    subjList.ok && !(subjList.json.data?.items ?? []).some((d) => d.id === orderDoc.id),
  );

  // Дождаться сборки приказа (файл) и отправить на маршрут
  const ready = await until('приказ собрался', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/documents/${orderDoc.id}`, owner.token);
    return d.json?.data?.fileId && !d.json?.data?.rebuilding ? d.json.data : null;
  });
  check('приказ о приёме собрался (builder → PDF)', !!ready?.fileId);

  const submitted = await call('POST', `/workspaces/${ws.id}/documents/${orderDoc.id}/submit`, owner.token);
  check('приказ ушёл на маршрут', submitted.ok, JSON.stringify(submitted.json?.message ?? ''));
  const actionInProgress = await until('действие «на оформлении»', async () => {
    const c = await call('GET', `/workspaces/${ws.id}/hr/members/${newbie.id}`, owner.token);
    const a = c.json?.data?.actions?.find((x) => x.id === hireAction.id);
    return a?.status === 'in_progress' ? a : null;
  }, 15000);
  check('действие перешло в «на оформлении»', !!actionInProgress);

  // Подпись работодателя (шаг маршрута, mock-ЭЦП)
  const signItem = await until('шаг подписи у владельца', () => myStepFor(owner, ws.id, 'Приказ', 'signature'));
  check('шаг «Подписать» в стопке владельца', !!signItem);
  const stepFlow = await call('POST', `/sign/requests/for-step/${signItem.id}`, owner.token);
  check('заявка подписи шага заведена', stepFlow.ok, JSON.stringify(stepFlow.json?.message ?? ''));
  await signEcp(owner, stepFlow.json.data.request.id);

  // Ознакомление работника (адресат — СТОРОНА документа, режим subject)
  const ackItem = await until('шаг ознакомления у работника', () => myStepFor(newbie, ws.id, 'Приказ', 'acknowledgement'));
  check('ознакомление адресовано СТОРОНЕ документа (subject)', !!ackItem);
  if (ackItem) {
    const ack = await call('POST', `/approvals/steps/${ackItem.id}/decide`, newbie.token, { decision: 'approved' });
    check('работник ознакомился', ack.ok, JSON.stringify(ack.json?.message ?? ''));
  }

  // Ознакомление по МАРШРУТУ — тот же юридический факт, что клик в кампании:
  // личный архив обязан получить запись kind='acknowledged' (хук onDecided).
  const routeAckRecord = await until('запись route-ack в личном архиве', async () => {
    const my = await call('GET', '/hr/my-documents', newbie.token);
    return (my.json?.data?.items ?? []).find((r) => r.orgDocumentId === orderDoc.id && r.kind === 'acknowledged') ?? null;
  }, 15000);
  check('ознакомление по маршруту дошло до «Моих документов»', !!routeAckRecord);

  // Маршрут дожёвывает: регистрация → подшивка → hr.apply → применение (дата = сегодня)
  const applied = await until('приём применён', async () => {
    const c = await call('GET', `/workspaces/${ws.id}/hr/members/${newbie.id}`, owner.token);
    const a = c.json?.data?.actions?.find((x) => x.id === hireAction.id);
    return a?.status === 'applied' ? a : null;
  }, 90000);
  check('приём применён (hr.apply, дата сегодня)', !!applied);
  const newbieCard = await call('GET', `/workspaces/${ws.id}/hr/members/${newbie.id}`, owner.token);
  check(
    'трудовая карточка новичка активна',
    newbieCard.json.data?.employment?.status === 'active' && newbieCard.json.data?.employment?.hiredAt === today(),
  );
  const orderAfter = await call('GET', `/workspaces/${ws.id}/documents/${orderDoc.id}`, owner.token);
  check('приказ получил номер (нода «Регистрация»)', !!orderAfter.json?.data?.number, orderAfter.json?.data?.number ?? '');
  check('после отправки работнику приказ ему ВИДЕН', (await call('GET', `/workspaces/${ws.id}/documents/${orderDoc.id}`, newbie.token)).ok);

  // ЕСУТД: заключение — очередь + срок в рабочих днях
  const esutd = await call('GET', `/workspaces/${ws.id}/hr/esutd`, owner.token);
  const contractSub = (esutd.json?.data?.items ?? []).find((s) => s.kind === 'contract' && s.hrActionId === hireAction.id);
  check('ЕСУТД: сдача «заключение» в очереди со сроком', !!contractSub && !!contractSub.dueAt);
  check(
    'ЕСУТД: срок считается рабочими днями (0..5 — п. 7 Правил № 353)',
    contractSub?.workDaysLeft !== null && contractSub?.workDaysLeft >= 0 && contractSub?.workDaysLeft <= 5,
    String(contractSub?.workDaysLeft),
  );

  const payload = await call('GET', `/workspaces/${ws.id}/hr/esutd/${contractSub?.id}/payload`, owner.token);
  check(
    '«Скопировать сведения» отдаёт снимок по Правилам № 353',
    payload.ok && !!payload.json.data?.['Вид сведений'] && 'ИИН работника' in (payload.json.data ?? {}),
  );

  const marked = await call('POST', `/workspaces/${ws.id}/hr/esutd/${contractSub?.id}/submitted`, owner.token, {
    externalNumber: 'ESUTD-001',
  });
  check(
    'отметка «сдано» + окно исправления 30 РД',
    marked.ok && marked.json.data?.status === 'submitted' && !!marked.json.data?.correctionUntil,
    marked.json?.data?.correctionUntil ?? '',
  );

  // Сводный экран «Кадровые сроки»
  const deadlines = await call('GET', `/workspaces/${ws.id}/hr/deadlines`, owner.token);
  check('экран «Кадровые сроки» отвечает', deadlines.ok && typeof deadlines.json.data?.total === 'number');
  const deadlinesAsTrainee = await call('GET', `/workspaces/${ws.id}/hr/deadlines`, employee.token);
  check('«Сроки» закрыты рядовому (403)', deadlinesAsTrainee.status === 403);

  // ============ Этап 2: перевод БУДУЩЕЙ датой → scheduled ============
  const transfer = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'transfer',
    userId: employee.id,
    effectiveAt: plusDays(5),
    templateId: installed.transfer_order.templateId,
    params: { legalPositionId: pos1.id, syncFact: true },
  });
  check('перевод заведён', transfer.ok, JSON.stringify(transfer.json?.message ?? ''));
  const trDoc = transfer.json.data.documents[0];
  await until('приказ о переводе собрался', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/documents/${trDoc.id}`, owner.token);
    return d.json?.data?.fileId && !d.json?.data?.rebuilding ? d.json.data : null;
  });
  await call('POST', `/workspaces/${ws.id}/documents/${trDoc.id}/submit`, owner.token);
  const trSign = await until('шаг подписи перевода', () => myStepFor(owner, ws.id, 'перевод', 'signature'));
  if (trSign) {
    const f = await call('POST', `/sign/requests/for-step/${trSign.id}`, owner.token);
    await signEcp(owner, f.json.data.request.id);
  }
  const trAck = await until('ознакомление с переводом', () => myStepFor(employee, ws.id, 'перевод', 'acknowledgement'));
  if (trAck) await call('POST', `/approvals/steps/${trAck.id}/decide`, employee.token, { decision: 'approved' });

  const scheduled = await until('перевод «вступает в силу»', async () => {
    const c = await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, owner.token);
    const a = c.json?.data?.actions?.find((x) => x.id === transfer.json.data.id);
    return a?.status === 'scheduled' ? a : null;
  }, 90000);
  check('перевод будущей датой = scheduled (не applied)', !!scheduled);
  const empAfterSchedule = await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, owner.token);
  check(
    'данные НЕ изменились раньше даты вступления',
    empAfterSchedule.json.data?.employment?.legalPositionName === 'Бармен',
    empAfterSchedule.json.data?.employment?.legalPositionName,
  );

  // ============ Перевод СЕГОДНЯШНЕЙ датой: applied + синхронизация ФАКТА ============
  // scheduled-путь дату вступления дождаться не может — эффект применения
  // (данные + syncFact → StaffAssignment) проверяем переводом «сегодня».
  const pos3 = (await call('POST', `/workspaces/${ws.id}/staff/positions`, owner.token, { name: 'Кассир' })).json.data;
  const transferNow = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'transfer',
    userId: employee.id,
    effectiveAt: today(),
    templateId: installed.transfer_order.templateId,
    params: { legalPositionId: pos3.id, syncFact: true },
  });
  check('перевод сегодняшней датой заведён', transferNow.ok, JSON.stringify(transferNow.json?.message ?? ''));
  const tnDoc = transferNow.json.data.documents[0];
  await until('приказ о переводе-сегодня собрался', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/documents/${tnDoc.id}`, owner.token);
    return d.json?.data?.fileId && !d.json?.data?.rebuilding ? d.json.data : null;
  });
  await call('POST', `/workspaces/${ws.id}/documents/${tnDoc.id}/submit`, owner.token);
  const tnSign = await until('шаг подписи перевода-сегодня', () => myStepFor(owner, ws.id, 'перевод', 'signature'));
  if (tnSign) {
    const f = await call('POST', `/sign/requests/for-step/${tnSign.id}`, owner.token);
    await signEcp(owner, f.json.data.request.id);
  }
  const tnAck = await until('ознакомление с переводом-сегодня', () => myStepFor(employee, ws.id, 'перевод', 'acknowledgement'));
  if (tnAck) await call('POST', `/approvals/steps/${tnAck.id}/decide`, employee.token, { decision: 'approved' });
  const tnApplied = await until('перевод-сегодня применён', async () => {
    const c = await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, owner.token);
    const a = c.json?.data?.actions?.find((x) => x.id === transferNow.json.data.id);
    return a?.status === 'applied' ? a : null;
  }, 90000);
  check('перевод сегодняшней датой применён (scheduled → applied в дату)', !!tnApplied);
  const empAfterT2 = (await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, owner.token)).json.data;
  check('договор обновился В ДАТУ применения', empAfterT2?.employment?.legalPositionName === 'Кассир', empAfterT2?.employment?.legalPositionName);
  check(
    'syncFact: факт-назначение синхронизировано со StaffAssignment',
    (empAfterT2?.assignments ?? []).some((a) => a.positionName === 'Кассир'),
    JSON.stringify((empAfterT2?.assignments ?? []).map((a) => a.positionName)),
  );
  check('расхождение факт/договор погашено применением', empAfterT2?.mismatch?.mismatch === false);

  // ============ Изменение оклада (сегодня → applied) ============
  const salary = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'salary_change',
    userId: employee.id,
    effectiveAt: today(),
    templateId: installed.salary_order.templateId,
    params: { salaryAmount: 30000000 },
  });
  const salDoc = salary.json.data.documents[0];
  await until('приказ об окладе собрался', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/documents/${salDoc.id}`, owner.token);
    return d.json?.data?.fileId && !d.json?.data?.rebuilding ? d.json.data : null;
  });
  await call('POST', `/workspaces/${ws.id}/documents/${salDoc.id}/submit`, owner.token);
  const salSign = await until('шаг подписи оклада', () => myStepFor(owner, ws.id, 'оклад', 'signature'));
  if (salSign) {
    const f = await call('POST', `/sign/requests/for-step/${salSign.id}`, owner.token);
    await signEcp(owner, f.json.data.request.id);
  }
  const salAck = await until('ознакомление с окладом', () => myStepFor(employee, ws.id, 'оклад', 'acknowledgement'));
  if (salAck) await call('POST', `/approvals/steps/${salAck.id}/decide`, employee.token, { decision: 'approved' });
  const salApplied = await until('оклад применён', async () => {
    const c = await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, owner.token);
    const a = c.json?.data?.actions?.find((x) => x.id === salary.json.data.id);
    return a?.status === 'applied' ? a : null;
  }, 90000);
  check('оклад применён', !!salApplied);
  const empAfterSalary = await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, owner.token);
  check('оклад изменился на 300 000 ₸', empAfterSalary.json.data?.employment?.salaryAmount === '30000000');
  const esutd2 = await call('GET', `/workspaces/${ws.id}/hr/esutd`, owner.token);
  check(
    'ЕСУТД: «изменение» встало в очередь (15 календарных)',
    (esutd2.json?.data?.items ?? []).some((s) => s.kind === 'amendment' && s.hrActionId === salary.json.data.id),
  );

  // ============ Отпуск (документооборот; applied-запись кормит ст. 54) ============
  const leave = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'leave',
    userId: employee.id,
    effectiveAt: plusDays(2),
    effectiveTo: plusDays(9),
    templateId: installed.leave_order.templateId,
  });
  const lvDoc = leave.json.data.documents[0];
  await until('приказ об отпуске собрался', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/documents/${lvDoc.id}`, owner.token);
    return d.json?.data?.fileId && !d.json?.data?.rebuilding ? d.json.data : null;
  });
  await call('POST', `/workspaces/${ws.id}/documents/${lvDoc.id}/submit`, owner.token);
  const lvSign = await until('шаг подписи отпуска', () => myStepFor(owner, ws.id, 'отпуск', 'signature'));
  if (lvSign) {
    const f = await call('POST', `/sign/requests/for-step/${lvSign.id}`, owner.token);
    await signEcp(owner, f.json.data.request.id);
  }
  const lvAck = await until('ознакомление с отпуском', () => myStepFor(employee, ws.id, 'отпуск', 'acknowledgement'));
  if (lvAck) await call('POST', `/approvals/steps/${lvAck.id}/decide`, employee.token, { decision: 'approved' });
  // Дата отпуска — послезавтра: hr.apply поставит scheduled; ПРИМЕНИМ вручную
  // невозможно (нет такой ручки) — поэтому отпуск для ст. 54 заведём датой СЕГОДНЯ.
  const leaveNow = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'leave',
    userId: employee.id,
    effectiveAt: today(),
    effectiveTo: plusDays(7),
    templateId: installed.leave_order.templateId,
  });
  const lvDoc2 = leaveNow.json.data.documents[0];
  await until('второй приказ об отпуске собрался', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/documents/${lvDoc2.id}`, owner.token);
    return d.json?.data?.fileId && !d.json?.data?.rebuilding ? d.json.data : null;
  });
  await call('POST', `/workspaces/${ws.id}/documents/${lvDoc2.id}/submit`, owner.token);
  const lv2Sign = await until('шаг подписи отпуска-2', () => myStepFor(owner, ws.id, 'отпуск', 'signature'));
  if (lv2Sign) {
    const f = await call('POST', `/sign/requests/for-step/${lv2Sign.id}`, owner.token);
    await signEcp(owner, f.json.data.request.id);
  }
  const lv2Ack = await until('ознакомление с отпуском-2', () => myStepFor(employee, ws.id, 'отпуск', 'acknowledgement'));
  if (lv2Ack) await call('POST', `/approvals/steps/${lv2Ack.id}/decide`, employee.token, { decision: 'approved' });
  const leaveApplied = await until('отпуск применён', async () => {
    const c = await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, owner.token);
    const a = c.json?.data?.actions?.find((x) => x.id === leaveNow.json.data.id);
    return a?.status === 'applied' ? a : null;
  }, 90000);
  check('отпуск применён (данные для ст. 54)', !!leaveApplied);

  // ============ Ст. 54: увольнение по инициативе работодателя в отпуске ============
  const banDismissal = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'dismissal',
    userId: employee.id,
    effectiveAt: plusDays(1), // внутри отпуска (сегодня..+7)
    templateId: installed.dismissal_order.templateId,
    params: { ground: 'st52_p1_2' }, // сокращение — инициатива работодателя, НЕ исключение
  });
  const banDoc = banDismissal.json.data.documents[0];
  await until('приказ об увольнении (ст.54) собрался', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/documents/${banDoc.id}`, owner.token);
    return d.json?.data?.fileId && !d.json?.data?.rebuilding ? d.json.data : null;
  });
  await call('POST', `/workspaces/${ws.id}/documents/${banDoc.id}/submit`, owner.token);
  const banSign = await until('шаг подписи увольнения-54', () => myStepFor(owner, ws.id, 'увольнении', 'signature'));
  if (banSign) {
    const f = await call('POST', `/sign/requests/for-step/${banSign.id}`, owner.token);
    await signEcp(owner, f.json.data.request.id);
  }
  const banAck = await until('ознакомление с увольнением-54', () => myStepFor(employee, ws.id, 'увольнении', 'acknowledgement'));
  if (banAck) await call('POST', `/approvals/steps/${banAck.id}/decide`, employee.token, { decision: 'approved' });
  // Дата завтра → scheduled; но проверка законности сработает в момент применения.
  // Ждать сутки тест не может — проверим, что действие ушло в scheduled (проверка
  // отработает джобом в дату), и отменим его: сам ЗАПРЕТ проверяем вторым увольнением
  // с датой СЕГОДНЯ — оно применяется сразу и обязано лечь в failed.
  const banScheduled = await until('увольнение-54 scheduled', async () => {
    const c = await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, owner.token);
    const a = c.json?.data?.actions?.find((x) => x.id === banDismissal.json.data.id);
    return a && ['scheduled', 'failed'].includes(a.status) ? a : null;
  }, 90000);
  check('увольнение будущей датой дошло до применения (scheduled)', banScheduled?.status === 'scheduled', banScheduled?.status);
  await call('POST', `/workspaces/${ws.id}/hr/actions/${banDismissal.json.data.id}/cancel`, owner.token);

  const banNow = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'dismissal',
    userId: employee.id,
    effectiveAt: today(), // сегодня — внутри applied-отпуска
    templateId: installed.dismissal_order.templateId,
    params: { ground: 'st52_p1_2' },
  });
  const banNowDoc = banNow.json.data.documents[0];
  await until('приказ ст.54-сегодня собрался', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/documents/${banNowDoc.id}`, owner.token);
    return d.json?.data?.fileId && !d.json?.data?.rebuilding ? d.json.data : null;
  });
  await call('POST', `/workspaces/${ws.id}/documents/${banNowDoc.id}/submit`, owner.token);
  const banNowSign = await until('шаг подписи ст.54-сегодня', () => myStepFor(owner, ws.id, 'увольнении', 'signature'));
  if (banNowSign) {
    const f = await call('POST', `/sign/requests/for-step/${banNowSign.id}`, owner.token);
    await signEcp(owner, f.json.data.request.id);
  }
  const banNowAck = await until('ознакомление ст.54-сегодня', () => myStepFor(employee, ws.id, 'увольнении', 'acknowledgement'));
  if (banNowAck) await call('POST', `/approvals/steps/${banNowAck.id}/decide`, employee.token, { decision: 'approved' });
  const banFailed = await until('увольнение в отпуске отклонено', async () => {
    const c = await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, owner.token);
    const a = c.json?.data?.actions?.find((x) => x.id === banNow.json.data.id);
    return a?.status === 'failed' ? a : null;
  }, 90000);
  check(
    'ст. 54: применение в отпуске = failed с причиной (больничные — вручную)',
    !!banFailed && /ст\. 54/.test(banFailed.failReason ?? '') && /больничн/i.test(banFailed.failReason ?? ''),
    banFailed?.failReason ?? '',
  );
  check('сотрудник НЕ уволен', (await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, owner.token)).json.data?.employment?.status === 'active');

  // ============ Ст. 56 п. 4: отзыв заявления работником ============
  const resignation = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'dismissal',
    userId: employee.id,
    effectiveAt: plusDays(30),
    templateId: installed.dismissal_order.templateId,
    params: { ground: 'st56' },
  });
  check('увольнение по собственному заведено', resignation.ok);
  const withdrawn = await call(
    'POST',
    `/workspaces/${ws.id}/hr/actions/${resignation.json.data.id}/cancel`,
    employee.token, // САМ РАБОТНИК
  );
  check('работник отозвал заявление (ст. 56 п. 4)', withdrawn.ok && withdrawn.json.data?.status === 'cancelled', withdrawn.json?.data?.status);
  const resignDoc = resignation.json.data.documents[0];
  const resignDocAfter = await call('GET', `/workspaces/${ws.id}/documents/${resignDoc.id}`, owner.token);
  check('неизданный приказ отменён вместе с отзывом', resignDocAfter.json?.data?.status === 'cancelled', resignDocAfter.json?.data?.status);
  const notAssignee = await call(
    'POST',
    `/workspaces/${ws.id}/hr/actions/${salary.json.data.id}/cancel`,
    employee.token,
  );
  check('чужое/не-увольнение работник отменить не может', notAssignee.status === 403 || notAssignee.status === 400);

  // ============ Увольнение НОВИЧКА по-настоящему (сегодня, ст. 50) ============
  const dismissal = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'dismissal',
    userId: newbie.id,
    effectiveAt: today(),
    templateId: installed.dismissal_order.templateId,
    params: { ground: 'st50' },
  });
  const disDoc = dismissal.json.data.documents[0];
  await until('приказ об увольнении собрался', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/documents/${disDoc.id}`, owner.token);
    return d.json?.data?.fileId && !d.json?.data?.rebuilding ? d.json.data : null;
  });
  await call('POST', `/workspaces/${ws.id}/documents/${disDoc.id}/submit`, owner.token);
  const disSign = await until('шаг подписи увольнения', () => myStepFor(owner, ws.id, 'увольнении', 'signature'));
  if (disSign) {
    const f = await call('POST', `/sign/requests/for-step/${disSign.id}`, owner.token);
    await signEcp(owner, f.json.data.request.id);
  }
  const disAck = await until('ознакомление новичка с увольнением', () => myStepFor(newbie, ws.id, 'увольнении', 'acknowledgement'));
  if (disAck) await call('POST', `/approvals/steps/${disAck.id}/decide`, newbie.token, { decision: 'approved' });
  const disApplied = await until('увольнение применено', async () => {
    const c = await call('GET', `/workspaces/${ws.id}/hr/members/${newbie.id}`, owner.token);
    const a = c.json?.data?.actions?.find((x) => x.id === dismissal.json.data.id);
    return a?.status === 'applied' ? a : null;
  }, 90000);
  check('увольнение применено', !!disApplied);
  const firedCard = await call('GET', `/workspaces/${ws.id}/hr/members/${newbie.id}`, owner.token);
  check(
    'карточка терминирована с основанием',
    firedCard.json.data?.employment?.status === 'terminated' && firedCard.json.data?.employment?.dismissalGround === 'st50',
  );
  const esutd3 = await call('GET', `/workspaces/${ws.id}/hr/esutd`, owner.token);
  const termSub = (esutd3.json?.data?.items ?? []).find(
    (s) => s.kind === 'termination' && s.hrActionId === dismissal.json.data.id,
  );
  check('ЕСУТД: «прекращение» в очереди (3 рабочих)', !!termSub);

  // Строгая валидация ДО отправки прекращения (операция без отката — п. 13):
  // у suite-аккаунтов нет ИИН, у организации — БИН → сдача обязана отказать
  // честно, с полным списком недостающего, а не принять недостоверные сведения.
  const termMark = await call('POST', `/workspaces/${ws.id}/hr/esutd/${termSub?.id}/submitted`, owner.token, {
    externalNumber: 'ESUTD-TERM-1',
  });
  check(
    'ЕСУТД: неполное прекращение НЕ сдаётся (валидация до отправки, hr_esutd_incomplete)',
    termMark.status === 400 && termMark.code === 'hr_esutd_incomplete' && /ИИН/.test(termMark.json?.message ?? ''),
    `${termMark.status} ${termMark.code ?? ''}`,
  );
  const deadlines2 = await call('GET', `/workspaces/${ws.id}/hr/deadlines`, owner.token);
  check(
    '«Сроки»: расчёт (3 РД, ст. 113) появился после увольнения',
    (deadlines2.json?.data?.settlements ?? []).some((s) => s.userId === newbie.id),
  );

  // Вручение (specialDelivery у вида увольнения из библиотеки)
  check('«Сроки»: акт ждёт вручения (ст. 61 п. 3)', (deadlines2.json?.data?.deliveries ?? []).some((d) => d.userId === newbie.id));
  const delivery = await call('POST', `/workspaces/${ws.id}/documents/${disDoc.id}/delivery`, owner.token, {
    method: 'in_person',
  });
  check('вручение зафиксировано', delivery.ok && !!delivery.json.data?.deliveredAt);
  const deliveryTwice = await call('POST', `/workspaces/${ws.id}/documents/${disDoc.id}/delivery`, owner.token, {
    method: 'in_person',
  });
  check('второй раз вручение не фиксируется', deliveryTwice.status === 400);
  // След вручения в хронике — кадровым ключом (чип «Кадры» в журнале), не «подшит»
  const disChronicle = await call('GET', `/chatter/org_document/${disDoc.id}`, owner.token);
  check(
    'вручение в хронике — свой ключ hr.delivery_fixed',
    (disChronicle.json?.data?.items ?? []).some((e) => e.typeKey === 'hr.delivery_fixed'),
  );

  // ============ Этап 8: запрет удаления подписанного кадрового документа ============
  const disDocRow = await call('GET', `/workspaces/${ws.id}/documents/${disDoc.id}`, owner.token);
  const protectedFileId = disDocRow.json?.data?.fileId;
  const delTry = await call('DELETE', `/files/${protectedFileId}`, owner.token);
  check('подписанный кадровый документ удалить нельзя (403)', delTry.status === 403, String(delTry.status));

  // Выгрузка личного дела ZIP
  const zipRes = await fetch(`${BASE}/workspaces/${ws.id}/hr/export/personal-file/${newbie.id}`, {
    headers: { Authorization: 'Bearer ' + owner.token },
  });
  check('выгрузка личного дела — ZIP', zipRes.ok && (zipRes.headers.get('content-type') ?? '').includes('zip'), String(zipRes.status));
  const zipBytes = Buffer.from(await zipRes.arrayBuffer());
  check('ZIP не пустой (PDF + протоколы + опись)', zipBytes.length > 500, `${zipBytes.length} bytes`);

  // ============ Этап 9: личный архив переживает purge организации ============
  const myDocsBefore = await call('GET', '/hr/my-documents', newbie.token);
  const myRecords = (myDocsBefore.json?.data?.items ?? []).filter((r) => r.workspaceId === ws.id);
  check('личный архив пополнился (подписи/ознакомления/вручение)', myRecords.length >= 1, `records=${myRecords.length}`);
  const withUrl = myRecords.find((r) => r.downloadUrl);
  check('запись личного архива несёт ссылку на файл', !!withUrl);

  // Срочный договор: продление молчанием ×2 → плашка «бессрочный» в «Сроках»
  await call('PUT', `/workspaces/${ws.id}/hr/members/${employee.id}/employment`, owner.token, {
    contractType: 'fixed_term',
    contractEndAt: plusDays(10),
    contractExtensionsCount: 2,
  });
  const deadlines3 = await call('GET', `/workspaces/${ws.id}/hr/deadlines`, owner.token);
  check(
    'срочный ×2 продления — плашка «считается бессрочным» (ст. 30)',
    (deadlines3.json?.data?.contractEnds ?? []).some((c) => c.userId === employee.id && /бессрочн/i.test(c.title)),
  );

  // ============ Ст. 54, ПОЗИТИВ: основание-исключение применяется В ОТПУСКЕ ============
  // Пять исключений (пп. 1), 18), 20), 23) п. 1 ст. 52 и п. 1-1) стоят в
  // справочнике: увольнение по пп. 20) (неявка >2 месяцев из-за нетрудоспособности)
  // обязано примениться, хотя сотрудник в applied-отпуске (галочка НЕ нужна).
  const exDismissal = await call('POST', `/workspaces/${ws.id}/hr/actions`, owner.token, {
    kind: 'dismissal',
    userId: employee.id,
    effectiveAt: today(), // внутри applied-отпуска (сегодня..+7)
    templateId: installed.dismissal_order.templateId,
    params: { ground: 'st52_p1_20' },
  });
  check('увольнение по исключению ст. 52 заведено', exDismissal.ok, JSON.stringify(exDismissal.json?.message ?? ''));
  const exDoc = exDismissal.json.data.documents[0];
  await until('приказ по исключению собрался', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/documents/${exDoc.id}`, owner.token);
    return d.json?.data?.fileId && !d.json?.data?.rebuilding ? d.json.data : null;
  });
  await call('POST', `/workspaces/${ws.id}/documents/${exDoc.id}/submit`, owner.token);
  const exSign = await until('шаг подписи увольнения-исключения', () => myStepFor(owner, ws.id, 'увольнении', 'signature'));
  if (exSign) {
    const f = await call('POST', `/sign/requests/for-step/${exSign.id}`, owner.token);
    await signEcp(owner, f.json.data.request.id);
  }
  const exAck = await until('ознакомление с увольнением-исключением', () => myStepFor(employee, ws.id, 'увольнении', 'acknowledgement'));
  if (exAck) await call('POST', `/approvals/steps/${exAck.id}/decide`, employee.token, { decision: 'approved' });
  const exApplied = await until('увольнение-исключение применено', async () => {
    const c = await call('GET', `/workspaces/${ws.id}/hr/members/${employee.id}`, owner.token);
    const a = c.json?.data?.actions?.find((x) => x.id === exDismissal.json.data.id);
    return a && ['applied', 'failed'].includes(a.status) ? a : null;
  }, 90000);
  check(
    'ст. 54: исключение (пп. 20) п. 1 ст. 52) применяется В ОТПУСКЕ без ручной галочки',
    exApplied?.status === 'applied',
    `${exApplied?.status ?? ''} ${exApplied?.failReason ?? ''}`,
  );

  // Пустой снимок адресатов — честная ошибка (движок решений)
  const emptyAssignee = await call('POST', '/approvals/dev/request', owner.token, {
    refId: require('crypto').randomUUID(),
    title: 'Полигон: пустой адресат',
    workspaceId: ws.id,
    steps: [
      {
        order: 0,
        kind: 'approval',
        assigneeType: 'department',
        assigneeId: '00000000-0000-4000-8000-000000000000',
        rule: 'all',
      },
    ],
  });
  check(
    'пустой снимок адресатов — честная ошибка (не молчаливая активация)',
    emptyAssignee.status === 400 && emptyAssignee.code === 'approval_empty_assignees',
    `${emptyAssignee.status} ${emptyAssignee.code ?? ''}`,
  );

  // PURGE организации (dev): личный архив жив, файл скачивается
  await call('DELETE', `/workspaces/${ws.id}`, owner.token);
  const purged = await call('POST', '/workspaces/dev/purge-archives', owner.token, { workspaceId: ws.id });
  check('dev-purge организации отработал', purged.ok && purged.json.data?.purged === 1);
  const myDocsAfter = await call('GET', '/hr/my-documents', newbie.token);
  const afterRecords = (myDocsAfter.json?.data?.items ?? []).filter((r) => r.workspaceId === ws.id);
  check('личный архив ПЕРЕЖИЛ purge организации', afterRecords.length === myRecords.length, `${afterRecords.length}/${myRecords.length}`);
  check('запись помечена «организация закрыта»', afterRecords.every((r) => r.workspaceAlive === false));
  const aliveUrl = afterRecords.find((r) => r.downloadUrl)?.downloadUrl;
  let fileAlive = false;
  if (aliveUrl) {
    const dl = await fetch(aliveUrl.startsWith('http') ? aliveUrl : `${BASE.replace(/\/api$/, '')}${aliveUrl}`);
    fileAlive = dl.ok;
  }
  check('файл записи скачивается ПОСЛЕ purge', fileAlive);
  // checkUrl есть только у записей с АКТОМ ПОДПИСИ самого человека — у новичка
  // здесь их нет (он знакомился, подписывал работодатель). Живой прогон
  // публичной проверки (/sign/check по checkUrl) делает verify-hr-campaigns
  // на ПЭП-акте адресата sms-кампании.
  if (withUrl?.checkUrl) {
    check('ссылка публичной проверки подписи сохранилась', afterRecords.some((r) => r.checkUrl));
  }

  finish();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
