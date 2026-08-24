// КЭДО, Этап 5 — кампании ознакомления.
// Кампания на отдел и на всю организацию · режимы click (вечный след с
// отпечатком) и sms (акты ПЭП на заявке refType='doc_campaign') · standing
// догоняет принятого позже · уволенный не подвешивает шаг rule:'all' ·
// sms_failed — отдельный исход · аналитика совпадает с фактом.
const { call, login, makeChecker, SUITE } = require('./_lib.cjs');
const crypto = require('crypto');

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

async function devCode(challengeId) {
  const r = await call('GET', `/verify/dev/last-code?challengeId=${challengeId}`);
  return r.json?.data?.code ?? null;
}

async function main() {
  const owner = await login(SUITE.p1);
  const emp2 = await login(SUITE.p2);
  const emp3 = await login(SUITE.p3);

  // ============ Организация: отдел + должности + назначения ============
  const ws = (await call('POST', '/workspaces', owner.token, { name: `Сьют-Кампании ${Date.now()}` })).json.data;
  for (const [u, phone] of [
    [emp2, SUITE.p2],
    [emp3, SUITE.p3],
  ]) {
    await call('POST', `/workspaces/${ws.id}/invitations`, owner.token, { phone });
    const inv = (await call('GET', '/workspaces/invitations/incoming', u.token)).json?.data?.find?.(
      (i) => i.workspaceId === ws.id,
    );
    await call('POST', `/workspaces/invitations/${inv?.id}/accept`, u.token);
  }
  const dep = (await call('POST', `/workspaces/${ws.id}/staff/departments`, owner.token, { name: 'Кухня' })).json.data;
  const pos = (
    await call('POST', `/workspaces/${ws.id}/staff/positions`, owner.token, { name: 'Повар', departmentId: dep.id })
  ).json.data;
  // В отделе — ТОЛЬКО emp2 (emp3 догонит standing-кампания позже)
  await call('POST', `/workspaces/${ws.id}/staff/members/${emp2.id}/assignments`, owner.token, { positionId: pos.id });
  check('организация + отдел + назначение', !!ws?.id && !!dep?.id && !!pos?.id);

  // ============ Предмет: ЛНА из библиотеки (кибербезопасность — quick win) ============
  const inst = await call('POST', `/workspaces/${ws.id}/hr/library/install`, owner.token, {
    key: 'cybersecurity_policy',
    signerUserId: owner.id,
  });
  check('ЛНА «Кибербезопасность» установлен из библиотеки', inst.ok && !!inst.json?.data?.templateId, JSON.stringify(inst.json?.message ?? ''));
  const doc = (
    await call('POST', `/workspaces/${ws.id}/documents`, owner.token, { templateId: inst.json.data.templateId })
  ).json.data;
  const docReady = await until('ЛНА собрался (PDF)', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/documents/${doc.id}`, owner.token);
    return d.json?.data?.fileId && !d.json?.data?.rebuilding ? d.json.data : null;
  });
  check('документ-ЛНА готов', !!docReady?.fileId);

  // ============ Click-кампания на ОТДЕЛ ============
  const clickCampaign = await call('POST', `/workspaces/${ws.id}/doc-campaigns`, owner.token, {
    orgDocumentId: doc.id,
    audience: [{ type: 'department', id: dep.id }],
    fixMode: 'click',
  });
  check('click-кампания на отдел создана', clickCampaign.ok, JSON.stringify(clickCampaign.json?.message ?? ''));
  const cc = clickCampaign.json.data;

  // Материализация пачками (джоб): адресат — ТОЛЬКО член отдела
  const ccDetail = await until('адресаты click-кампании материализовались', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/doc-campaigns/${cc.id}`, owner.token);
    return (d.json?.data?.targets?.length ?? 0) > 0 ? d.json.data : null;
  });
  check('адресат — член отдела (emp2), не филиала', ccDetail?.targets?.length === 1 && ccDetail?.targets?.[0]?.userId === emp2.id);

  // Стопка адресата: источник hr_campaign с кнопкой «Ознакомлен»
  const inbox2 = await until('задание в стопке emp2', async () => {
    const r = await call('GET', `/approvals/inbox?workspaceId=${ws.id}`, emp2.token);
    return (r.json?.data?.items ?? []).find((i) => i.sourceKey === 'hr_campaign' && i.id === cc.id) ?? null;
  });
  check('кампания в стопке «Ждут решения» (hr_campaign)', !!inbox2 && inbox2.stepKind === 'acknowledgement');
  check('click-кампания несёт кнопку «Ознакомлен»', (inbox2?.actions ?? []).some((a) => a.key === 'acknowledge'));

  // Предмет кампании ВИДЕН адресату (visibilityWhere: адресат кампании)
  const docAsTarget = await call('GET', `/workspaces/${ws.id}/documents/${doc.id}`, emp2.token);
  check('предмет кампании виден адресату', docAsTarget.ok, String(docAsTarget.status));

  // Чужой человек «Ознакомлен» нажать не может
  const foreignAck = await call('POST', `/doc-campaigns/${cc.id}/acknowledge`, emp3.token);
  check('не-адресат ознакомиться не может (403)', foreignAck.status === 403, String(foreignAck.status));

  // Фиксация кликом: acknowledgedAt + sha256 (вечный след)
  const ack = await call('POST', `/doc-campaigns/${cc.id}/acknowledge`, emp2.token);
  check('emp2 ознакомился кликом', ack.ok);
  const ackTwice = await call('POST', `/doc-campaigns/${cc.id}/acknowledge`, emp2.token);
  check('повторное «Ознакомлен» идемпотентно', ackTwice.ok);
  const ccAfter = (await call('GET', `/workspaces/${ws.id}/doc-campaigns/${cc.id}`, owner.token)).json.data;
  check(
    'аналитика совпадает с фактом (1 из 1, sha зафиксирован)',
    ccAfter.counts.acknowledged === 1 &&
      ccAfter.counts.pending === 0 &&
      ccAfter.targets[0].status === 'acknowledged' &&
      !!ccAfter.targets[0].acknowledgedAt &&
      (ccAfter.targets[0].subjectSha256 ?? '').length === 64,
    `sha=${ccAfter.targets[0]?.subjectSha256 ?? 'null'}`,
  );
  check('one_off кампания завершилась сама', ccAfter.status === 'done', ccAfter.status);

  // Личный архив адресата пополнился записью «Ознакомлен»
  const myDocs2 = await call('GET', '/hr/my-documents', emp2.token);
  check(
    'личный архив: запись kind=acknowledged',
    (myDocs2.json?.data?.items ?? []).some((r) => r.orgDocumentId === doc.id && r.kind === 'acknowledged'),
  );

  // ============ Кампания на ФИЛИАЛ (третья ось аудитории) ============
  const br = (await call('POST', `/workspaces/${ws.id}/staff/branches`, owner.token, { name: 'Филиал Юг' })).json.data;
  // Второе назначение той же должности С филиалом — проекция branch#member
  await call('POST', `/workspaces/${ws.id}/staff/members/${emp2.id}/assignments`, owner.token, {
    positionId: pos.id,
    branchId: br.id,
  });
  const branchCampaign = await call('POST', `/workspaces/${ws.id}/doc-campaigns`, owner.token, {
    orgDocumentId: doc.id,
    audience: [{ type: 'branch', id: br.id }],
    fixMode: 'click',
  });
  check('кампания на ФИЛИАЛ создана', branchCampaign.ok, JSON.stringify(branchCampaign.json?.message ?? ''));
  const bcDetail = await until('адресаты филиал-кампании материализовались', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/doc-campaigns/${branchCampaign.json.data.id}`, owner.token);
    return (d.json?.data?.targets?.length ?? 0) > 0 ? d.json.data : null;
  });
  check(
    'адресат филиал-кампании — член филиала (emp2)',
    bcDetail?.targets?.length === 1 && bcDetail?.targets?.[0]?.userId === emp2.id,
    JSON.stringify(bcDetail?.targets?.map((t) => t.userId) ?? []),
  );
  // Закрываем, чтобы не висела в стопке дальше по прогону
  await call('POST', `/doc-campaigns/${branchCampaign.json.data.id}/acknowledge`, emp2.token);

  // ============ SMS-кампания на ВСЮ организацию ============
  const smsCampaign = await call('POST', `/workspaces/${ws.id}/doc-campaigns`, owner.token, {
    orgDocumentId: doc.id,
    audience: [{ type: 'workspace', id: ws.id }],
    fixMode: 'sms',
  });
  check('sms-кампания на всю организацию создана', smsCampaign.ok, JSON.stringify(smsCampaign.json?.message ?? ''));
  const sc = smsCampaign.json.data;
  const scDetail = await until('адресаты sms-кампании материализовались', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/doc-campaigns/${sc.id}`, owner.token);
    return (d.json?.data?.targets?.length ?? 0) >= 3 ? d.json.data : null;
  });
  check('вся команда — адресаты (3)', scDetail?.targets?.length === 3, String(scDetail?.targets?.length));

  // Заявка подписи refType='doc_campaign' с актами адресатов
  const scRow = (await call('GET', `/workspaces/${ws.id}/doc-campaigns/${sc.id}`, owner.token)).json.data;
  const inbox3 = await until('sms-задание в стопке emp3', async () => {
    const r = await call('GET', `/approvals/inbox?workspaceId=${ws.id}`, emp3.token);
    return (r.json?.data?.items ?? []).find((i) => i.sourceKey === 'hr_campaign' && i.id === sc.id) ?? null;
  });
  check('sms-задание без кнопки клика (только подпись)', !!inbox3 && (inbox3.actions ?? []).length === 0);
  check('href ведёт на карточку подписания', !!inbox3?.href && /\/sign\//.test(inbox3.href));

  // Клик в sms-кампании ЗАПРЕЩЁН — фиксация только кодом
  const clickInSms = await call('POST', `/doc-campaigns/${sc.id}/acknowledge`, emp3.token);
  check('клик в sms-кампании отвергается (400)', clickInSms.status === 400, String(clickInSms.status));

  // ПЭП-подпись адресата по заявке кампании
  const requestId = inbox3.href.split('/sign/')[1];
  const flow = await call('GET', `/sign/requests/${requestId}`, emp3.token);
  check(
    'заявка кампании — refType doc_campaign (не org_document: уникум свободных заявок)',
    flow.json?.data?.request?.refType === 'doc_campaign',
    flow.json?.data?.request?.refType ?? '',
  );
  const actId = flow.json?.data?.myAct?.id;
  check('акт адресата заведён пачкой (systemEnsureActs)', !!actId);
  const pepStart = await call('POST', `/sign/acts/${actId}/pep/start`, emp3.token, { consentAccepted: true });
  check('ПЭП: код отправлен', pepStart.ok, JSON.stringify(pepStart.json?.message ?? ''));
  const code = await devCode(pepStart.json?.data?.challengeId);
  const pepConfirm = await call('POST', `/sign/acts/${actId}/pep/confirm`, emp3.token, {
    challengeId: pepStart.json?.data?.challengeId,
    code,
  });
  check('ПЭП: подпись поставлена', pepConfirm.ok, JSON.stringify(pepConfirm.json?.message ?? ''));

  // Хук onActFinished → target acknowledged с signActId
  const smsAcked = await until('sms-ознакомление зафиксировано хуком', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/doc-campaigns/${sc.id}`, owner.token);
    const t = (d.json?.data?.targets ?? []).find((x) => x.userId === emp3.id);
    return t?.status === 'acknowledged' ? d.json.data : null;
  });
  check('sms-режим: акт ПЭП закрыл задание', !!smsAcked);

  // sms_failed — отдельный исход (не «не ознакомился»)
  const smsFail = await call(
    'POST',
    `/workspaces/${ws.id}/doc-campaigns/${sc.id}/targets/${emp2.id}/sms-failed`,
    owner.token,
  );
  check('sms_failed отмечен', smsFail.ok);
  const scAfterFail = (await call('GET', `/workspaces/${ws.id}/doc-campaigns/${sc.id}`, owner.token)).json.data;
  check(
    'sms_failed — отдельный исход в аналитике',
    scAfterFail.counts.sms_failed === 1 &&
      (scAfterFail.targets ?? []).find((t) => t.userId === emp2.id)?.status === 'sms_failed',
  );
  check(
    'итоговый расклад sms-кампании: pending ровно один и это owner',
    scAfterFail.counts.pending === 1 &&
      (scAfterFail.targets ?? []).find((t) => t.status === 'pending')?.userId === owner.id,
    JSON.stringify(scAfterFail.counts),
  );

  // Публичная проверка подписи ЖИВЬЁМ: запись личного архива emp3 несёт checkUrl
  // ПЭП-акта → /sign/check по actId+k отвечает без токена
  const emp3Docs = await call('GET', '/hr/my-documents', emp3.token);
  const emp3Rec = (emp3Docs.json?.data?.items ?? []).find(
    (r) => r.orgDocumentId === doc.id && r.kind === 'acknowledged' && r.checkUrl,
  );
  check('запись sms-ознакомления несёт checkUrl', !!emp3Rec?.checkUrl, JSON.stringify(emp3Rec ?? null));
  if (emp3Rec?.checkUrl) {
    const m = emp3Rec.checkUrl.match(/^\/check\/([^?]+)\?k=(.+)$/);
    const pub = await call('GET', `/sign/check?actId=${m?.[1]}&k=${encodeURIComponent(m?.[2] ?? '')}`);
    check('публичная проверка подписи отвечает (без токена)', pub.ok, String(pub.status));
  }

  // Последний pending закрыт исходом sms_failed → one_off ОБЯЗАН завершиться
  const ownerFail = await call(
    'POST',
    `/workspaces/${ws.id}/doc-campaigns/${sc.id}/targets/${owner.id}/sms-failed`,
    owner.token,
  );
  check('sms_failed по последнему pending принят', ownerFail.ok);
  const scDone = await until('one_off завершилась после sms_failed', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/doc-campaigns/${sc.id}`, owner.token);
    return d.json?.data?.status === 'done' ? d.json.data : null;
  }, 15000);
  check('one_off не зависает в active, когда последний закрыт sms_failed', !!scDone);

  // ============ Standing-кампания догоняет принятого позже ============
  const standing = await call('POST', `/workspaces/${ws.id}/doc-campaigns`, owner.token, {
    orgDocumentId: doc.id,
    audience: [{ type: 'department', id: dep.id }],
    fixMode: 'click',
    mode: 'standing',
  });
  check('standing-кампания на отдел создана', standing.ok);
  const st = standing.json.data;
  await until('первый адресат standing', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/doc-campaigns/${st.id}`, owner.token);
    return (d.json?.data?.targets?.length ?? 0) >= 1 ? d.json.data : null;
  });

  // «Принят позже»: emp3 назначается в отдел ПОСЛЕ старта кампании
  await call('POST', `/workspaces/${ws.id}/staff/members/${emp3.id}/assignments`, owner.token, { positionId: pos.id });
  // Ежедневный крон тест не ждёт — «Догнать аудиторию сейчас» (штатная ручка standing)
  const kick = await call('POST', `/workspaces/${ws.id}/doc-campaigns/${st.id}/sweep`, owner.token);
  check('«Догнать аудиторию сейчас» отработал', kick.ok, JSON.stringify(kick.json?.message ?? ''));
  const caught = await until('standing догнал принятого позже', async () => {
    const d = await call('GET', `/workspaces/${ws.id}/doc-campaigns/${st.id}`, owner.token);
    return (d.json?.data?.targets ?? []).some((t) => t.userId === emp3.id) ? d.json.data : null;
  });
  check('emp3 получил задание standing-кампании', !!caught);
  check('standing не завершается сам (правило живёт)', caught?.status === 'active');

  // ============ Уволенный не подвешивает шаг rule:'all' ============
  const refId = crypto.randomUUID();
  const allStep = await call('POST', '/approvals/dev/request', owner.token, {
    refId,
    title: 'Полигон: нужен каждый в отделе',
    workspaceId: ws.id,
    steps: [{ order: 0, kind: 'approval', assigneeType: 'department', assigneeId: dep.id, rule: 'all' }],
  });
  check('заявка «нужен каждый» на отдел заведена', allStep.ok, JSON.stringify(allStep.json?.message ?? ''));
  const reqId = allStep.json?.data?.id;
  const step = allStep.json?.data?.steps?.[0];
  check('снимок шага = оба члена отдела', (step?.awaitingUserIds ?? []).length === 2, String(step?.awaitingUserIds?.length));

  // Первый решает, второго УВОЛЬНЯЮТ — шаг обязан закрыться пересчётом
  const dec = await call('POST', `/approvals/steps/${step.id}/decide`, emp2.token, { decision: 'approved' });
  check('emp2 согласовал', dec.ok, JSON.stringify(dec.json?.message ?? ''));
  const fired = await call('DELETE', `/workspaces/${ws.id}/members/${emp3.id}`, owner.token);
  check('emp3 уволен', fired.ok);
  const resolved = await until('заявка закрылась без уволенного', async () => {
    const r = await call('GET', `/approvals/${reqId}`, owner.token);
    return r.json?.data?.status === 'approved' ? r.json.data : null;
  }, 30000);
  check('уволенный НЕ подвесил шаг rule:\'all\' (снятие + пересчёт)', !!resolved);

  // Увольнение сняло emp3 и с pending-заданий кампаний? (задание остаётся —
  // кампании чистит своя аналитика; проверяем только шаги решений)

  // Уборка штатным путём (правило сьютов): организация прогона не копится
  await call('DELETE', `/workspaces/${ws.id}`, owner.token);
  await call('POST', '/workspaces/dev/purge-archives', owner.token, { workspaceId: ws.id });

  finish();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
