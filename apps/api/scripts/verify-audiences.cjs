/* eslint-disable */
// core/audiences (16-й движок) — e2e: единый словарь адресатов.
// Один [{type:'department',id}] даёт ОДИНАКОВЫЙ состав у движка и в снимке шага
// согласования · голова отдела (снаружи отдела) теперь в составе · manager_of/$initiator
// садится в awaitingUserIds · корень → владелец · чужой отдел → пусто (честная ошибка
// шага) · переполнение бросает кодом · якорь без контекста → ошибка · подписи ·
// процессы получили относительные адресаты · заявления библиотеки согласует
// руководитель стороны документа.
// Run (API up, NODE_ENV=development, seeded suite accounts): node scripts/verify-audiences.cjs
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { call, login, makeChecker, SUITE } = require('./_lib.cjs');

const { check, finish } = makeChecker();
const sorted = (a) => [...(a ?? [])].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

async function main() {
  const s1 = await login(SUITE.p1), s2 = await login(SUITE.p2), s3 = await login(SUITE.p3);
  const t1 = s1.token, t2 = s2.token, t3 = s3.token;
  const u1 = s1.id, u2 = s2.id, u3 = s3.id;
  const cleanup = { ws: [] };

  try {
    const ws = await call('POST', '/workspaces', t1, { name: 'audiences-e2e' });
    check('организация создана', ws.ok, `status ${ws.status}`);
    const wsId = ws.json.data.id; cleanup.ws.push(wsId);
    const S = (p) => `/workspaces/${wsId}/staff${p}`;
    for (const [p, t] of [[SUITE.p2, t2], [SUITE.p3, t3]]) {
      await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: p });
      const mine = (await call('GET', '/workspaces/invitations/incoming', t)).json?.data?.find((i) => i.workspaceId === wsId);
      await call('POST', `/workspaces/invitations/${mine?.id}/accept`, t);
    }
    const dir = (await call('GET', S(''), t1)).json?.data;
    const defBranch = dir?.branches?.find((b) => b.isDefault);

    // Отдел «Продажи»: Менеджер продаж (внутри) — suite2; голова — «Руководитель продаж» СНАРУЖИ отдела — suite3
    const dep = (await call('POST', S('/departments'), t1, { name: 'Продажи' })).json?.data;
    const posMgr = (await call('POST', S('/positions'), t1, { name: 'Менеджер продаж', departmentId: dep?.id })).json?.data;
    const posHead = (await call('POST', S('/positions'), t1, { name: 'Руководитель продаж' })).json?.data;
    const headSet = await call('PATCH', S(`/departments/${dep?.id}`), t1, { headPositionId: posHead?.id });
    check('голова отдела — должность снаружи отдела', headSet.ok, `status ${headSet.status}`);
    await call('POST', S(`/members/${u2}/assignments`), t1, { positionId: posMgr?.id });
    await call('POST', S(`/members/${u3}/assignments`), t1, { positionId: posHead?.id });

    const dev = async (token, body) => call('POST', '/audiences/dev/resolve', token, body);

    // ===== Движок: отдел = участники + голова (снаружи) =====
    const rDep = await dev(t1, { workspaceId: wsId, refs: [{ type: 'department', id: dep.id }] });
    check('dev/resolve отдел: участник + голова снаружи отдела (лестница head ⇒ member)', rDep.ok && same(rDep.json?.data?.userIds, [u2, u3]), `${rDep.status} ${JSON.stringify(rDep.json?.data?.userIds)}`);
    check('подпись отдела', rDep.json?.data?.labels?.[0]?.label === 'Отдел «Продажи»', JSON.stringify(rDep.json?.data?.labels));

    // ===== Снимок шага согласования — ТОТ ЖЕ состав =====
    const refId = crypto.randomUUID();
    const ap = await call('POST', '/approvals/dev/request', t1, {
      refId, title: 'aud: отдел', workspaceId: wsId,
      steps: [{ order: 0, kind: 'acknowledgement', assigneeType: 'department', assigneeId: dep.id, rule: 'all' }],
    });
    check('заявка на отдел создана', ap.ok, `status ${ap.status} ${JSON.stringify(ap.json?.message ?? '')}`);
    const stepDep = ap.json?.data?.steps?.[0];
    check('awaitingUserIds шага = состав движка (одинаково у всех потребителей)', same(stepDep?.awaitingUserIds, rDep.json?.data?.userIds), JSON.stringify(stepDep?.awaitingUserIds));
    check('assigneeLabel шага — из единого словаря', stepDep?.assigneeLabel === 'Отдел «Продажи»', JSON.stringify(stepDep?.assigneeLabel));

    // ===== manager_of/$initiator → руководитель инициатора в снимке =====
    const ap2 = await call('POST', '/approvals/dev/request', t2, {
      refId: crypto.randomUUID(), title: 'aud: мой руководитель', workspaceId: wsId,
      steps: [{ order: 0, kind: 'approval', assigneeType: 'manager_of', assigneeId: '$initiator' }],
    });
    check('шаг manager_of/$initiator создан (Zod принимает якорь у относительного адресата)', ap2.ok, `status ${ap2.status} ${JSON.stringify(ap2.json?.message ?? ap2.json?.errors ?? '')}`);
    const step2 = ap2.json?.data?.steps?.[0];
    check('manager_of($initiator=suite2) → голова отдела suite3', same(step2?.awaitingUserIds, [u3]), JSON.stringify(step2?.awaitingUserIds));
    check('подпись «Руководитель инициатора»', step2?.assigneeLabel === 'Руководитель инициатора', JSON.stringify(step2?.assigneeLabel));

    // ===== корень → владелец =====
    const ap3 = await call('POST', '/approvals/dev/request', t3, {
      refId: crypto.randomUUID(), title: 'aud: корень', workspaceId: wsId,
      steps: [{ order: 0, kind: 'approval', assigneeType: 'manager_of', assigneeId: '$initiator' }],
    });
    check('вершина без руководителя → снимок = владелец (не пусто)', ap3.ok && same(ap3.json?.data?.steps?.[0]?.awaitingUserIds, [u1]), JSON.stringify(ap3.json?.data?.steps?.[0]?.awaitingUserIds));

    // ===== якорь у не-относительного вида → 400 =====
    const apBad = await call('POST', '/approvals/dev/request', t1, {
      refId: crypto.randomUUID(), title: 'aud: bad', workspaceId: wsId,
      steps: [{ order: 0, kind: 'approval', assigneeType: 'department', assigneeId: '$initiator' }],
    });
    check('якорь у отдела → 400 (Zod)', apBad.status === 400, `status ${apBad.status}`);
    const apKind = await call('POST', '/approvals/dev/request', t1, {
      refId: crypto.randomUUID(), title: 'aud: kind', workspaceId: wsId,
      steps: [{ order: 0, kind: 'approval', assigneeType: 'workspace', assigneeId: wsId }],
    });
    check('вид «вся команда» шагу согласования недоступен → 400', apKind.status === 400, `status ${apKind.status}`);

    // ===== чужой отдел → пусто → честная ошибка шага =====
    const ws2 = await call('POST', '/workspaces', t1, { name: 'audiences-e2e-2' });
    const ws2Id = ws2.json?.data?.id; cleanup.ws.push(ws2Id);
    const depForeign = (await call('POST', `/workspaces/${ws2Id}/staff/departments`, t1, { name: 'Чужой отдел' })).json?.data;
    const rForeign = await dev(t1, { workspaceId: wsId, refs: [{ type: 'department', id: depForeign.id }] });
    check('чужой отдел разворачивается в пусто', rForeign.ok && rForeign.json?.data?.userIds?.length === 0, JSON.stringify(rForeign.json?.data));
    const apForeign = await call('POST', '/approvals/dev/request', t1, {
      refId: crypto.randomUUID(), title: 'aud: foreign', workspaceId: wsId,
      steps: [{ order: 0, kind: 'approval', assigneeType: 'department', assigneeId: depForeign.id }],
    });
    check('шаг на чужой отдел → approval_empty_assignees', apForeign.status === 400 && apForeign.code === 'approval_empty_assignees', `status ${apForeign.status} code ${apForeign.code}`);

    // ===== переполнение / обрезка / якорь без контекста / команда / руководитель объекта =====
    const rOver = await dev(t1, { workspaceId: wsId, refs: [{ type: 'department', id: dep.id }], max: 1, onOverflow: 'throw' });
    check('переполнение бросает кодом audience_overflow', rOver.status === 400 && rOver.code === 'audience_overflow', `status ${rOver.status} code ${rOver.code}`);
    const rTrunc = await dev(t1, { workspaceId: wsId, refs: [{ type: 'department', id: dep.id }], max: 1, onOverflow: 'truncate' });
    check('режим truncate режет до потолка', rTrunc.ok && rTrunc.json?.data?.userIds?.length === 1, JSON.stringify(rTrunc.json?.data?.userIds));
    const rAnchor = await dev(t1, { workspaceId: wsId, refs: [{ type: 'manager_of', id: '$subject' }] });
    check('якорь $subject без контекста → audience_anchor_unavailable', rAnchor.status === 400 && rAnchor.code === 'audience_anchor_unavailable', `status ${rAnchor.status} code ${rAnchor.code}`);
    const rTeam = await dev(t3, { workspaceId: wsId, refs: [{ type: 'subordinates_of', id: '$self' }] });
    check('subordinates_of/$self (suite3) → команда = suite2', rTeam.ok && same(rTeam.json?.data?.userIds, [u2]), JSON.stringify(rTeam.json?.data?.userIds));
    check('подпись «Команда меня»', rTeam.json?.data?.labels?.[0]?.label === 'Команда меня', JSON.stringify(rTeam.json?.data?.labels));
    await call('PATCH', S(`/branches/${defBranch.id}`), t1, { headPositionId: posHead.id });
    const rBh = await dev(t2, { workspaceId: wsId, refs: [{ type: 'branch_head_of', id: '$initiator' }] });
    check('branch_head_of/$initiator (suite2) → руководитель основного объекта suite3', rBh.ok && same(rBh.json?.data?.userIds, [u3]), JSON.stringify(rBh.json?.data?.userIds));
    const rBhId = await dev(t1, { workspaceId: wsId, refs: [{ type: 'branch_head_of', id: defBranch.id }] });
    check('branch_head_of по id объекта → его руководитель', rBhId.ok && same(rBhId.json?.data?.userIds, [u3]) && rBhId.json?.data?.labels?.[0]?.label?.startsWith('Руководитель объекта «'), JSON.stringify(rBhId.json?.data));
    const rWs = await dev(t1, { workspaceId: wsId, refs: [{ type: 'workspace', id: wsId }] });
    check('вся команда = 3 (подрядчиков нет)', rWs.ok && rWs.json?.data?.userIds?.length === 3 && rWs.json?.data?.labels?.[0]?.label === 'вся команда', JSON.stringify(rWs.json?.data?.userIds));
    const rUserForeign = await dev(t1, { workspaceId: ws2Id, refs: [{ type: 'user', id: u2 }] });
    check('человек вне команды организации → пусто', rUserForeign.ok && rUserForeign.json?.data?.userIds?.length === 0);

    // ===== Процессы: относительные адресаты в паспортах нод =====
    const nt = (await call('GET', `/workspaces/${wsId}/processes/node-types?surface=documents.hr`, t1)).json?.data ?? [];
    const approvalNode = nt.find((n) => n.type === 'human.approval');
    const modes = (approvalNode?.fields?.find((f) => f.key === 'assigneeMode')?.options ?? []).map((o) => o.value);
    check('human.approval: режимы initiator_manager / subject_manager / branch_head', ['initiator_manager', 'subject_manager', 'branch_head'].every((m) => modes.includes(m)), modes.join(','));
    const ntG = (await call('GET', `/workspaces/${wsId}/processes/node-types`, t1)).json?.data ?? [];
    const taskNode = ntG.find((n) => n.type === 'human.task');
    const tModes = (taskNode?.fields?.find((f) => f.key === 'assigneeMode')?.options ?? []).map((o) => o.value);
    check('human.task: режим initiator_manager', tModes.includes('initiator_manager'), tModes.join(','));

    // ===== Библиотека бланков: заявление согласует руководитель стороны документа =====
    const inst = await call('POST', `/workspaces/${wsId}/hr/library/install`, t1, { key: 'leave_application', signerUserId: u1 });
    check('заявление на отпуск установлено', inst.ok, `status ${inst.status} ${JSON.stringify(inst.json?.message ?? '')}`);
    // Маршрут установки — по записи установки (DTO бланка процесс не несёт)
    const prisma = new PrismaClient();
    const install = await prisma.docTemplateLibraryInstall.findFirst({ where: { workspaceId: wsId, libraryKey: 'leave_application' }, select: { processId: true } }).catch(() => null);
    await prisma.$disconnect();
    const procId = install?.processId ?? null;
    const def = procId ? (await call('GET', `/workspaces/${wsId}/processes/${procId}`, t1)).json?.data : null;
    const approveNode = (def?.document?.nodes ?? []).find((n) => n.id === 'approve');
    check('маршрут заявления: шаг согласования адресован subject_manager', approveNode?.config?.assigneeMode === 'subject_manager', JSON.stringify(approveNode?.config ?? def?.document?.nodes?.map((n) => n.id)));

    // ===== Шаблонные поля «Руководитель» =====
    const fg = (await call('GET', '/templates/field-groups', t1)).json?.data ?? [];
    const emp = (Array.isArray(fg) ? fg : fg.groups ?? []).find((g) => g.key === 'employee');
    const keys = (emp?.fields ?? []).map((f) => f.key);
    check('группа «Сотрудник»: Руководитель / Руководитель Должность / Руководитель объекта', ['Руководитель', 'Руководитель Должность', 'Руководитель объекта', 'Руководитель объекта Должность'].every((k) => keys.includes(k)), keys.join(','));
    const resolved = await call('POST', '/templates/dev/resolve', t1, { workspaceId: wsId, subjectUserId: u2 });
    const vals = resolved.json?.data?.values ?? resolved.json?.data ?? {};
    const flat = JSON.stringify(vals);
    check('поля «Руководитель» резолвятся по факту (suite3 — Руководитель продаж)', resolved.ok && flat.includes('Руководитель продаж'), `${resolved.status} ${flat.slice(0, 200)}`);
  } finally {
    for (const id of cleanup.ws) await call('DELETE', `/workspaces/${id}`, t1).catch(() => {});
  }
  finish();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
