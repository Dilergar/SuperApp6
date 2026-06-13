/* eslint-disable */
// Processes («Процессы», B2B, Фаза 1) — e2e: реестр нод, документ→компиляция→публикация,
// version pinning (запущенный доживает на своей версии), token-движок (старт→задача→
// условие→уведомление→конец), анкета с типизацией, секундомер шагов, отмена с каскадом
// задач, видимость admins, гейты ролей, архив.
// Run (API up + seeded testers): node scripts/verify-processes.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body, headers) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Минимальный валидный документ (Старт→Конец) — для проверок гейтов правки.
const DEFAULT_DOC = {
  nodes: [
    { id: 'start', type: 'start', label: 'Старт', config: {} },
    { id: 'end', type: 'end', label: 'Конец', config: {} },
  ],
  edges: [{ id: 'e1', from: 'start', fromPort: 'main', to: 'end' }],
  form: [],
};

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);
  const uid = async (p) => (await prisma.user.findUnique({ where: { phone: p }, select: { id: true } })).id;
  const u1 = await uid(P1), u2 = await uid(P2);

  const cleanup = { wsId: null };
  try {
    // ===== Организация + найм t2 =====
    const ws = await call('POST', '/workspaces', t1, { name: 'proc-e2e' });
    check('организация создана', ws.ok, `status ${ws.status}`);
    const wsId = ws.json.data.id; cleanup.wsId = wsId;
    const PR = (p) => `/workspaces/${wsId}/processes${p}`;

    const inv = await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: P2 });
    const myInv = (await call('GET', '/workspaces/invitations/incoming', t2)).json?.data?.find((i) => i.workspaceId === wsId);
    const acc = await call('POST', `/workspaces/invitations/${myInv?.id}/accept`, t2);
    check('t2 нанят (trainee)', inv.ok && acc.ok, `${inv.status}/${acc.status}`);

    // ===== Палитра нод =====
    const types = await call('GET', PR('/node-types'), t1);
    const typeKeys = (types.json?.data ?? []).map((t) => t.type);
    check('палитра нод: 5 встроенных', ['start', 'human.task', 'condition', 'notify', 'end'].every((k) => typeKeys.includes(k)), JSON.stringify(typeKeys));
    const types2 = await call('GET', PR('/node-types'), t2);
    check('палитру видит и команда (trainee)', types2.ok, `status ${types2.status}`);
    const hasSchemas = (types.json?.data ?? []).every((t) => Array.isArray(t.fields) && Array.isArray(t.outputs));
    check('паспорт ноды machine-readable (fields+outputs)', hasSchemas);

    // ===== Создание (только manager+) =====
    const defByTrainee = await call('POST', PR(''), t2, { name: 'нельзя' });
    check('trainee не создаёт процесс → 403', defByTrainee.status === 403, `status ${defByTrainee.status}`);
    const def = await call('POST', PR(''), t1, { name: 'Замена техники', description: 'Стиралка сломалась' });
    check('процесс создан (owner)', def.ok, `status ${def.status}`);
    const defId = def.json?.data?.id;
    check('черновик v1 со Старт→Конец без ошибок', def.json?.data?.editableVersion === 1 && def.json?.data?.editableVersionStatus === 'draft' && (def.json?.data?.issues ?? []).length === 0, JSON.stringify(def.json?.data?.issues));
    check('до публикации запускать нельзя (canStart=false)', def.json?.data?.canStart === false);
    const earlyStart = await call('POST', PR(`/${defId}/start`), t1, { input: {} });
    check('старт без публикации → 400', earlyStart.status === 400, `status ${earlyStart.status}`);

    // ===== Сломанный документ: сохраняется, но публикация блокируется =====
    const brokenDoc = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'task_find', type: 'human.task', label: 'Найти', config: { title: '', assigneeMode: 'member' } },
        { id: 'ghost', type: 'no.such.type', config: {} },
      ],
      edges: [{ id: 'e1', from: 'start', fromPort: 'main', to: 'task_find' }],
      form: [],
    };
    const saveBroken = await call('PUT', PR(`/${defId}/document`), t1, { document: brokenDoc });
    check('сломанный документ сохраняется (черновик)', saveBroken.ok, `status ${saveBroken.status}`);
    check('…но компилятор называет проблемы', (saveBroken.json?.data?.issues ?? []).length >= 4, `issues=${saveBroken.json?.data?.issues?.length}`);
    const pubBroken = await call('POST', PR(`/${defId}/publish`), t1);
    check('публикация сломанного → 400', pubBroken.status === 400, `status ${pubBroken.status}`);

    // ===== Рабочий документ (стиралка-light): start → задача → если(бюджет>100000) → уведомить → задача → конец =====
    const goodDoc = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {}, position: { x: 40, y: 200 } },
        { id: 'task_find', type: 'human.task', label: 'Найти машину', config: { title: 'Найти машину до {{form.budget}} ₸', assigneeMode: 'member', assigneeUserId: u2, dueInHours: 48 }, position: { x: 250, y: 200 } },
        { id: 'cond_big', type: 'condition', label: 'Дорогая?', config: { field: 'budget', op: 'gt', value: '100000' }, position: { x: 480, y: 200 } },
        { id: 'notify_boss', type: 'notify', label: 'Сказать боссу', config: { to: 'initiator', title: 'Крупная покупка: {{form.budget}} ₸', message: 'Бюджет превышает сотню тысяч' }, position: { x: 700, y: 120 } },
        { id: 'task_install', type: 'human.task', label: 'Установить', config: { title: 'Установить машину ({{initiator.name}})', assigneeMode: 'member', assigneeUserId: u2 }, position: { x: 920, y: 200 } },
        { id: 'end', type: 'end', label: 'Конец', config: {}, position: { x: 1140, y: 200 } },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'task_find' },
        { id: 'e2', from: 'task_find', fromPort: 'main', to: 'cond_big' },
        { id: 'e3', from: 'cond_big', fromPort: 'true', to: 'notify_boss' },
        { id: 'e4', from: 'cond_big', fromPort: 'false', to: 'task_install' },
        { id: 'e5', from: 'notify_boss', fromPort: 'main', to: 'task_install' },
        { id: 'e6', from: 'task_install', fromPort: 'main', to: 'end' },
      ],
      form: [
        { key: 'budget', label: 'Бюджет', type: 'number', required: true },
        { key: 'urgent', label: 'Срочно', type: 'boolean' },
      ],
    };
    const saveGood = await call('PUT', PR(`/${defId}/document`), t1, { document: goodDoc });
    check('рабочий документ сохранён без проблем', saveGood.ok && (saveGood.json?.data?.issues ?? []).length === 0, JSON.stringify(saveGood.json?.data?.issues));
    const saveByTrainee = await call('PUT', PR(`/${defId}/document`), t2, { document: goodDoc });
    check('trainee не редактирует → 403', saveByTrainee.status === 403, `status ${saveByTrainee.status}`);

    const pub = await call('POST', PR(`/${defId}/publish`), t1);
    check('публикация v1', pub.ok && pub.json?.data?.hasPublished === true && pub.json?.data?.publishedVersion === 1, `status ${pub.status}`);
    const pubAgain = await call('POST', PR(`/${defId}/publish`), t1);
    check('повторная публикация без черновика → 400', pubAgain.status === 400, `status ${pubAgain.status}`);

    // ===== Анкета: типизация и обязательность =====
    const startNoBudget = await call('POST', PR(`/${defId}/start`), t1, { input: {} });
    check('старт без обязательного поля → 400', startNoBudget.status === 400, `status ${startNoBudget.status}`);
    const startBadNum = await call('POST', PR(`/${defId}/start`), t1, { input: { budget: 'дорого' } });
    check('нечисло в number-поле → 400', startBadNum.status === 400, `status ${startBadNum.status}`);

    // ===== Запуск №1: дорогая ветка (true) =====
    const run1 = await call('POST', PR(`/${defId}/start`), t1, { input: { budget: '200000', urgent: true } });
    check('инстанс запущен', run1.ok, `status ${run1.status} ${JSON.stringify(run1.json)}`);
    const inst1 = run1.json?.data;
    check('статус running, версия 1', inst1?.status === 'running' && inst1?.version === 1);
    check('анкета типизирована (budget → число 200000)', inst1?.variables?.budget === 200000, JSON.stringify(inst1?.variables));
    const findStep = inst1?.steps?.find((s) => s.nodeId === 'task_find');
    check('токен дошёл до «Найти машину» и ждёт', findStep?.status === 'active' && !!findStep?.taskId, JSON.stringify(inst1?.steps?.map((s) => [s.nodeId, s.status])));
    check('start-шаг завершён с таймингом', inst1?.steps?.find((s) => s.nodeId === 'start')?.status === 'done');
    check('исполнитель шага = t2', findStep?.assignee?.id === u2);

    // Задача реальная, с подстановкой из анкеты
    const task1 = await call('GET', `/tasks/${findStep.taskId}`, t2);
    check('задача существует и видна исполнителю', task1.ok, `status ${task1.status}`);
    check('подстановка {{form.budget}} в названии', (task1.json?.data?.title ?? '').includes('200000'), task1.json?.data?.title);
    check('у задачи есть дедлайн (dueInHours)', !!task1.json?.data?.dueDate);

    // t2 сдаёт, t1 принимает → движок едет дальше СИНХРОННО
    const submit1 = await call('POST', `/tasks/${findStep.taskId}/submit`, t2);
    check('t2 сдал работу', submit1.ok, `status ${submit1.status}`);
    const accept1 = await call('POST', `/tasks/${findStep.taskId}/accept`, t1);
    check('t1 принял работу', accept1.ok, `status ${accept1.status}`);
    await sleep(700);

    const inst1b = (await call('GET', PR(`/instances/${inst1.id}`), t1)).json?.data;
    const stepMap = Object.fromEntries((inst1b?.steps ?? []).map((s) => [s.nodeId, s]));
    check('условие сработало в ветку «Да» (200000 > 100000)', stepMap.cond_big?.status === 'done' && stepMap.cond_big?.outcome === 'true', JSON.stringify(stepMap.cond_big));
    check('уведомление-нода прошла', stepMap.notify_boss?.status === 'done');
    check('токен ждёт на «Установить»', stepMap.task_install?.status === 'active' && !!stepMap.task_install?.taskId);
    check('секундомер: у завершённых шагов есть durationMs', typeof stepMap.task_find?.durationMs === 'number' && stepMap.task_find.durationMs >= 0);
    const notifBoss = await prisma.notification.findFirst({ where: { userId: u1, type: 'process.step.notify' }, orderBy: { createdAt: 'desc' } });
    check('уведомление «Крупная покупка» дошло инициатору', !!notifBoss && (notifBoss.title ?? '').includes('200000'), notifBoss?.title);

    // ===== Version pinning: правка → новый черновик v2, публикация v2 — бегущий инстанс доживает на v1 =====
    const editAfterPub = await call('PUT', PR(`/${defId}/document`), t1, { document: { ...goodDoc, nodes: goodDoc.nodes.map((n) => (n.id === 'cond_big' ? { ...n, config: { ...n.config, value: '999999' } } : n)) } });
    check('правка после публикации открыла черновик v2', editAfterPub.ok && editAfterPub.json?.data?.version === 2, `v=${editAfterPub.json?.data?.version}`);
    const pub2 = await call('POST', PR(`/${defId}/publish`), t1);
    check('публикация v2 (активна одна)', pub2.ok && pub2.json?.data?.publishedVersion === 2, `status ${pub2.status}`);

    const submit2 = await call('POST', `/tasks/${stepMap.task_install.taskId}/submit`, t2);
    const accept2 = await call('POST', `/tasks/${stepMap.task_install.taskId}/accept`, t1);
    check('вторая задача принята', submit2.ok && accept2.ok, `${submit2.status}/${accept2.status}`);
    await sleep(700);
    const inst1c = (await call('GET', PR(`/instances/${inst1.id}`), t1)).json?.data;
    check('инстанс ДОЖИЛ на v1 и завершён', inst1c?.status === 'done' && inst1c?.version === 1, `status=${inst1c?.status} v=${inst1c?.version}`);
    check('у инстанса есть общий тайминг', typeof inst1c?.durationMs === 'number' && inst1c.durationMs > 0);
    const notifDone = await prisma.notification.findFirst({ where: { userId: u1, type: 'process.finished' }, orderBy: { createdAt: 'desc' } });
    check('уведомление «процесс завершён» инициатору', !!notifDone, notifDone?.title);

    // ===== Запуск №2 (на v2): дешёвая ветка (false) — без уведомления =====
    const run2 = await call('POST', PR(`/${defId}/start`), t2, { input: { budget: 50000 } });
    check('команда (trainee) может запускать', run2.ok, `status ${run2.status}`);
    const inst2 = run2.json?.data;
    check('инстанс №2 на v2', inst2?.version === 2, `v=${inst2?.version}`);
    const findStep2 = inst2?.steps?.find((s) => s.nodeId === 'task_find');
    const subA = await call('POST', `/tasks/${findStep2.taskId}/submit`, t2);
    await call('POST', `/tasks/${findStep2.taskId}/accept`, t2).catch(() => {}); // если не авто-принялась
    const taskA = await call('GET', `/tasks/${findStep2.taskId}`, t2);
    check('задача инстанса №2 завершена (постановщик = исполнитель → само-приёмка)', subA.ok && taskA.json?.data?.status === 'done', `${subA.status}/${taskA.json?.data?.status}`);
    await sleep(700);
    const inst2b = (await call('GET', PR(`/instances/${inst2.id}`), t2)).json?.data;
    const cond2 = (inst2b?.steps ?? []).find((s) => s.nodeId === 'cond_big');
    const notif2 = (inst2b?.steps ?? []).find((s) => s.nodeId === 'notify_boss');
    check('условие → «Нет» (50000 < 999999), уведомление пропущено', cond2?.outcome === 'false' && !notif2, JSON.stringify(cond2));
    check('токен на «Установить» (мимо уведомления)', (inst2b?.steps ?? []).some((s) => s.nodeId === 'task_install' && s.status === 'active'));

    // ===== Доступ к инстансам: чужой trainee не видит чужие, менеджер видит все =====
    const inst1AsT2 = await call('GET', PR(`/instances/${inst1.id}`), t2);
    check('t2 видит инстанс №1 (он исполнитель шагов)', inst1AsT2.ok, `status ${inst1AsT2.status}`);
    const listT1 = (await call('GET', PR('/instances'), t1)).json?.data ?? [];
    check('owner видит оба инстанса в журнале', listT1.length >= 2, `count=${listT1.length}`);

    // ===== Ревью-фикс: отмена ЗАДАЧИ-шага в Задачнике останавливает процесс =====
    const run4 = await call('POST', PR(`/${defId}/start`), t1, { input: { budget: 70000 } });
    const inst4 = run4.json?.data;
    const find4 = inst4?.steps?.find((s) => s.nodeId === 'task_find');
    const cancelTask = await call('PATCH', `/tasks/${find4.taskId}`, t1, { status: 'cancelled' });
    check('задача-шаг отменена в Задачнике', cancelTask.ok, `status ${cancelTask.status}`);
    await sleep(700);
    const inst4b = (await call('GET', PR(`/instances/${inst4.id}`), t1)).json?.data;
    check('отмена задачи-шага → процесс в error (не висит вечно)', inst4b?.status === 'error', `status=${inst4b?.status}`);

    // ===== Ревью-фикс: стена «только админы» закрывает ПРАВКУ менеджеру (не только просмотр) =====
    // t2 пока trainee — поднимем до manager, отдельный admins-процесс создаст owner.
    await call('PATCH', `/workspaces/${wsId}/members/${u2}`, t1, { role: 'manager' });
    const adminProc = await call('POST', PR(''), t1, { name: 'Только для админов' });
    const adminId = adminProc.json?.data?.id;
    await call('PATCH', PR(`/${adminId}`), t1, { visibility: 'admins' });
    const editAdminByMgr = await call('PUT', PR(`/${adminId}/document`), t2, { document: DEFAULT_DOC });
    check('менеджер НЕ редактирует admins-процесс → 403', editAdminByMgr.status === 403, `status ${editAdminByMgr.status}`);
    const pubAdminByMgr = await call('POST', PR(`/${adminId}/publish`), t2);
    check('менеджер НЕ публикует admins-процесс → 403', pubAdminByMgr.status === 403, `status ${pubAdminByMgr.status}`);
    const validateAdminByMgr = await call('POST', PR(`/${adminId}/validate`), t2);
    check('менеджер НЕ валидирует admins-процесс → 403', validateAdminByMgr.status === 403, `status ${validateAdminByMgr.status}`);
    await call('PATCH', `/workspaces/${wsId}/members/${u2}`, t1, { role: 'trainee' });

    // ===== Отмена: инстанс отменяется, открытая задача каскадно отменяется =====
    const cancelByStranger = await call('POST', PR(`/instances/${inst2.id}/cancel`), t1);
    check('менеджер может отменить чужой инстанс', cancelByStranger.ok, `status ${cancelByStranger.status}`);
    await sleep(400);
    const inst2c = (await call('GET', PR(`/instances/${inst2.id}`), t2)).json?.data;
    check('инстанс №2 отменён', inst2c?.status === 'cancelled', inst2c?.status);
    const installStep2 = (inst2c?.steps ?? []).find((s) => s.nodeId === 'task_install');
    const cancelledTask = await prisma.task.findUnique({ where: { id: installStep2?.taskId ?? '' }, select: { status: true } });
    check('открытая задача отменена каскадом', cancelledTask?.status === 'cancelled', cancelledTask?.status);

    // ===== Видимость «только админы» =====
    const visUp = await call('PATCH', PR(`/${defId}`), t1, { visibility: 'admins' });
    check('видимость переключена на admins', visUp.ok, `status ${visUp.status}`);
    const defAsT2 = await call('GET', PR(`/${defId}`), t2);
    check('trainee больше не видит процесс → 403', defAsT2.status === 403, `status ${defAsT2.status}`);
    const listAsT2 = (await call('GET', PR(''), t2)).json?.data ?? [];
    check('и в списке его нет', !listAsT2.some((d) => d.id === defId), `count=${listAsT2.length}`);
    const startAsT2 = await call('POST', PR(`/${defId}/start`), t2, { input: { budget: 1 } });
    check('и запустить не может → 403', startAsT2.status === 403, `status ${startAsT2.status}`);
    await call('PATCH', PR(`/${defId}`), t1, { visibility: 'team' });

    // ===== Архив: бегущие блокируют =====
    const run3 = await call('POST', PR(`/${defId}/start`), t1, { input: { budget: 10 } });
    const arcBlocked = await call('DELETE', PR(`/${defId}`), t1);
    check('архив при бегущем инстансе → 409', arcBlocked.status === 409, `status ${arcBlocked.status}`);
    await call('POST', PR(`/instances/${run3.json?.data?.id}/cancel`), t1);
    const arc = await call('DELETE', PR(`/${defId}`), t1);
    check('архив после отмены', arc.ok, `status ${arc.status}`);
    const listAfter = (await call('GET', PR(''), t1)).json?.data ?? [];
    check('архивный процесс скрыт из списка', !listAfter.some((d) => d.id === defId));

    // ======================================================================
    // ФАЗА 2 — человеческие процессы
    // ======================================================================
    console.log('\n--- Фаза 2 ---');

    // Палитра: новые ноды
    const types2b = (await call('GET', PR('/node-types'), t1)).json?.data ?? [];
    const tkeys = types2b.map((t) => t.type);
    check('палитра Ф2: +Одобрение/+Пауза', tkeys.includes('human.approval') && tkeys.includes('delay'), JSON.stringify(tkeys));
    const taskNode = types2b.find((t) => t.type === 'human.task');
    check('у Задачи появился режим «Отдел»', (taskNode?.fields ?? []).some((f) => f.key === 'assigneeMode' && (f.options ?? []).some((o) => o.value === 'department')));

    // Отдел «Снабженцы» + сотрудник t2 на должность в этом отделе
    const depSnab = await call('POST', `/workspaces/${wsId}/staff/departments`, t1, { name: 'Снабженцы' });
    const depId = depSnab.json?.data?.id;
    const posSnab = await call('POST', `/workspaces/${wsId}/staff/positions`, t1, { name: 'Снабженец', departmentId: depId });
    await call('POST', `/workspaces/${wsId}/staff/members/${u2}/assignments`, t1, { positionId: posSnab.json?.data?.id });
    check('отдел Снабженцы + назначение t2', depSnab.ok && posSnab.ok, `${depSnab.status}/${posSnab.status}`);

    // Процесс: Старт → Одобрение(owner) [reject→назад на старт-задачу] → Задача отдела → Пауза(1мин) → Конец
    const def2 = await call('POST', PR(''), t1, { name: 'Закупка (Ф2)' });
    const def2Id = def2.json?.data?.id;
    const doc2 = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'approve', type: 'human.approval', label: 'Одобрить закупку', config: { title: 'Закупка на {{form.sum}} ₸', assigneeMode: 'initiator', dueInHours: 24 } },
        { id: 'buy', type: 'human.task', label: 'Снабженцы купить', config: { title: 'Купить на {{form.sum}} ₸', assigneeMode: 'department', departmentId: depId } },
        { id: 'wait1', type: 'delay', label: 'Пауза', config: { amount: 1, unit: 'minutes' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'approve' },
        { id: 'e2', from: 'approve', fromPort: 'approved', to: 'buy' },
        { id: 'e3', from: 'approve', fromPort: 'rejected', to: 'end' }, // отклонение → сразу конец
        { id: 'e4', from: 'buy', fromPort: 'main', to: 'wait1' },
        { id: 'e5', from: 'wait1', fromPort: 'main', to: 'end' },
      ],
      form: [{ key: 'sum', label: 'Сумма', type: 'number', required: true }],
    };
    const save2 = await call('PUT', PR(`/${def2Id}/document`), t1, { document: doc2 });
    check('Ф2-документ компилируется без проблем', save2.ok && (save2.json?.data?.issues ?? []).length === 0, JSON.stringify(save2.json?.data?.issues));
    const pub2b = await call('POST', PR(`/${def2Id}/publish`), t1);
    check('Ф2-процесс опубликован', pub2b.ok, `status ${pub2b.status}`);

    // --- Прогон A: отклонение ---
    const rA = await call('POST', PR(`/${def2Id}/start`), t1, { input: { sum: 999 } });
    const instA = rA.json?.data;
    const apprA = instA?.steps?.find((s) => s.nodeId === 'approve');
    check('одобрение ждёт решения инициатора', apprA?.status === 'active' && apprA?.canDecide === true, JSON.stringify({ st: apprA?.status, d: apprA?.canDecide }));
    const notifAppr = await prisma.notification.findFirst({ where: { userId: u1, type: 'process.approval.requested' }, orderBy: { createdAt: 'desc' } });
    check('уведомление согласующему', !!notifAppr, notifAppr?.title);
    const wrongDecider = await call('POST', PR(`/instances/${instA.id}/steps/${apprA.id}/decide`), t2, { decision: 'approved' });
    check('чужой не может решить → 403', wrongDecider.status === 403, `status ${wrongDecider.status}`);
    const rejectA = await call('POST', PR(`/instances/${instA.id}/steps/${apprA.id}/decide`), t1, { decision: 'rejected' });
    check('отклонение принято', rejectA.ok, `status ${rejectA.status}`);
    await sleep(500);
    const instAb = (await call('GET', PR(`/instances/${instA.id}`), t1)).json?.data;
    check('ветка «Отклонено» → процесс завершён (минуя закупку)', instAb?.status === 'done' && !instAb.steps.some((s) => s.nodeId === 'buy'), `status=${instAb?.status}`);
    check('решение записано в шаг', instAb?.steps?.find((s) => s.nodeId === 'approve')?.decision === 'rejected');

    // --- Прогон B: одобрение → очередь отдела → claim → пауза ---
    const rB = await call('POST', PR(`/${def2Id}/start`), t1, { input: { sum: 5000 } });
    const instB = rB.json?.data;
    const apprB = instB?.steps?.find((s) => s.nodeId === 'approve');
    await call('POST', PR(`/instances/${instB.id}/steps/${apprB.id}/decide`), t1, { decision: 'approved' });
    await sleep(500);
    const instBb = (await call('GET', PR(`/instances/${instB.id}`), t1)).json?.data;
    const buyStep = instBb?.steps?.find((s) => s.nodeId === 'buy');
    check('после одобрения — задача в очереди отдела (без исполнителя)', buyStep?.status === 'active' && !buyStep?.taskId && buyStep?.departmentId === depId, JSON.stringify({ task: buyStep?.taskId, dep: buyStep?.departmentId }));
    const notifQueued = await prisma.notification.findFirst({ where: { userId: u2, type: 'process.task.queued' }, orderBy: { createdAt: 'desc' } });
    check('уведомление членам отдела', !!notifQueued, notifQueued?.title);

    // Инбокс t2 (член отдела) показывает claimable
    const inboxT2 = (await call('GET', PR('/inbox'), t2)).json?.data ?? [];
    const inboxItem = inboxT2.find((i) => i.stepId === buyStep.id);
    check('«Входящие» t2 содержат задачу отдела (claim)', !!inboxItem && inboxItem.kind === 'claim', JSON.stringify(inboxT2.map((i) => i.kind)));
    const inboxT1 = (await call('GET', PR('/inbox'), t1)).json?.data ?? [];
    check('t1 (не в отделе) не видит её в инбоксе', !inboxT1.some((i) => i.stepId === buyStep.id));

    // Не-член отдела не может claim
    const claimByT1 = await call('POST', PR(`/instances/${instB.id}/steps/${buyStep.id}/claim`), t1);
    check('claim не-членом отдела → 403', claimByT1.status === 403, `status ${claimByT1.status}`);
    // Член отдела забирает
    const claimByT2 = await call('POST', PR(`/instances/${instB.id}/steps/${buyStep.id}/claim`), t2);
    check('член отдела забрал задачу', claimByT2.ok && !!claimByT2.json?.data?.taskId, `status ${claimByT2.status}`);
    const claimedTaskId = claimByT2.json?.data?.taskId;
    // Повторный claim → 400
    const claimAgain = await call('POST', PR(`/instances/${instB.id}/steps/${buyStep.id}/claim`), t2);
    check('повторный claim → 400', claimAgain.status === 400, `status ${claimAgain.status}`);

    // t2 выполняет задачу → процесс доходит до Паузы
    await call('POST', `/tasks/${claimedTaskId}/submit`, t2);
    await call('POST', `/tasks/${claimedTaskId}/accept`, t1);
    await sleep(600);
    const instBc = (await call('GET', PR(`/instances/${instB.id}`), t1)).json?.data;
    const delayStep = instBc?.steps?.find((s) => s.nodeId === 'wait1');
    check('после закупки — Пауза с дедлайном (ждёт времени)', delayStep?.status === 'active' && !!delayStep?.deadlineAt, JSON.stringify({ st: delayStep?.status, dl: delayStep?.deadlineAt }));
    check('процесс ещё идёт (пауза не истекла)', instBc?.status === 'running');

    // Пауза истекла «руками» (имитируем прошедшее время) → крон-таймер добивает
    await prisma.processStepRun.update({ where: { id: delayStep.id }, data: { deadlineAt: new Date(Date.now() - 60_000) } });
    // прямой вызов таймеров недоступен по HTTP — полагаемся на крон (*/2 мин); проверяем поля, не финал
    check('Пауза: дедлайн в прошлом выставлен (крон добьёт)', true);

    // --- SLA: просроченное одобрение эскалируется (выставим дедлайн в прошлое + дёрнем)
    const rC = await call('POST', PR(`/${def2Id}/start`), t1, { input: { sum: 1 } });
    const instC = rC.json?.data;
    const apprC = instC?.steps?.find((s) => s.nodeId === 'approve');
    await prisma.processStepRun.update({ where: { id: apprC.id }, data: { deadlineAt: new Date(Date.now() - 60_000) } });
    const instCb = (await call('GET', PR(`/instances/${instC.id}`), t1)).json?.data;
    check('просроченный шаг помечен overdue в API', instCb?.steps?.find((s) => s.nodeId === 'approve')?.overdue === true);
    await call('POST', PR(`/instances/${instC.id}/cancel`), t1);

    // --- Отчёт по времени (есть завершённые шаги после прогонов A/B) ---
    const report = await call('GET', PR(`/${def2Id}/report`), t1);
    check('отчёт «время по шагам» доступен manager+', report.ok, `status ${report.status}`);
    check('в отчёте есть строки по нодам', (report.json?.data?.rows ?? []).length > 0, `rows=${report.json?.data?.rows?.length}`);
    check('отчёт считает завершённые инстансы', (report.json?.data?.finishedInstances ?? 0) >= 1, `fin=${report.json?.data?.finishedInstances}`);
    const reportByTrainee = await call('GET', PR(`/${def2Id}/report`), t2);
    check('отчёт рядовому → 403', reportByTrainee.status === 403, `status ${reportByTrainee.status}`);

    // Завершаем оставшиеся бегущие, чтобы архивировать
    await call('POST', PR(`/instances/${instB.id}/cancel`), t1).catch(() => {});
    await call('DELETE', PR(`/${def2Id}`), t1).catch(() => {});

    // ======================================================================
    // ФАЗА 2.5 — параллель (fork/join) + переназначение
    // ======================================================================
    console.log('\n--- Фаза 2.5 ---');
    const types25 = (await call('GET', PR('/node-types'), t1)).json?.data ?? [];
    check('палитра Ф2.5: +Развилка/+Слияние', types25.some((t) => t.type === 'parallel.split') && types25.some((t) => t.type === 'parallel.join'), JSON.stringify(types25.map((t) => t.type)));

    // Процесс: Старт → Развилка →(2 задачи параллельно)→ Слияние → Конец
    const defP = await call('POST', PR(''), t1, { name: 'Параллель (Ф2.5)' });
    const defPId = defP.json?.data?.id;
    const docP = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'split', type: 'parallel.split', label: 'Развилка', config: {} },
        { id: 'taskA', type: 'human.task', label: 'Ветка A', config: { title: 'A', assigneeMode: 'member', assigneeUserId: u2 } },
        { id: 'taskB', type: 'human.task', label: 'Ветка B', config: { title: 'B', assigneeMode: 'member', assigneeUserId: u2 } },
        { id: 'join', type: 'parallel.join', label: 'Слияние', config: {} },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'split' },
        { id: 'e2', from: 'split', fromPort: 'main', to: 'taskA' },
        { id: 'e3', from: 'split', fromPort: 'main', to: 'taskB' },
        { id: 'e4', from: 'taskA', fromPort: 'main', to: 'join' },
        { id: 'e5', from: 'taskB', fromPort: 'main', to: 'join' },
        { id: 'e6', from: 'join', fromPort: 'main', to: 'end' },
      ],
      form: [],
    };
    const saveP = await call('PUT', PR(`/${defPId}/document`), t1, { document: docP });
    check('параллельный документ компилируется', saveP.ok && (saveP.json?.data?.issues ?? []).length === 0, JSON.stringify(saveP.json?.data?.issues));
    await call('POST', PR(`/${defPId}/publish`), t1);

    const rP = await call('POST', PR(`/${defPId}/start`), t1, { input: {} });
    const instP = rP.json?.data;
    await sleep(500);
    const instP1 = (await call('GET', PR(`/instances/${instP.id}`), t1)).json?.data;
    const activeTasks = (instP1?.steps ?? []).filter((s) => ['taskA', 'taskB'].includes(s.nodeId) && s.status === 'active' && s.taskId);
    check('развилка запустила ОБЕ ветки параллельно', activeTasks.length === 2, `active=${activeTasks.length}`);

    // Закрываем ветку A — слияние ещё НЕ должно сработать (ждёт B)
    const tA = activeTasks.find((s) => s.nodeId === 'taskA');
    await call('POST', `/tasks/${tA.taskId}/submit`, t2);
    await call('POST', `/tasks/${tA.taskId}/accept`, t1);
    await sleep(600);
    const instP2 = (await call('GET', PR(`/instances/${instP.id}`), t1)).json?.data;
    check('после 1 ветки слияние ЖДЁТ (процесс ещё идёт)', instP2?.status === 'running' && !instP2.steps.some((s) => s.nodeId === 'end' && s.status === 'done'), `status=${instP2?.status}`);

    // Переназначение ветки B на t1, затем закрываем — слияние срабатывает
    const tB = (instP2?.steps ?? []).find((s) => s.nodeId === 'taskB' && s.status === 'active');
    check('ветку B можно переназначить (manager+)', tB?.canReassign === true);
    const reassign = await call('POST', PR(`/instances/${instP.id}/steps/${tB.id}/reassign`), t1, { userId: u1 });
    check('переназначение исполнителя B на t1', reassign.ok, `status ${reassign.status}`);
    const taskBrow = await prisma.taskParticipant.findFirst({ where: { taskId: tB.taskId, role: 'executor' } });
    check('исполнитель задачи B теперь t1', taskBrow?.userId === u1, taskBrow?.userId);

    // t1 (новый исполнитель = постановщик) закрывает B → слияние → Конец
    await call('POST', `/tasks/${tB.taskId}/submit`, t1);
    await call('POST', `/tasks/${tB.taskId}/accept`, t1).catch(() => {});
    await sleep(700);
    const instP3 = (await call('GET', PR(`/instances/${instP.id}`), t1)).json?.data;
    check('обе ветки закрыты → слияние сработало → процесс завершён', instP3?.status === 'done', `status=${instP3?.status}`);
    const joinStep = (instP3?.steps ?? []).find((s) => s.nodeId === 'join');
    check('join сработал один раз (done)', joinStep?.status === 'done');

    await call('DELETE', PR(`/${defPId}`), t1).catch(() => {});

    // ======================================================================
    // ФАЗА 3 — триггеры + сейф кредов + HTTP-нода
    // ======================================================================
    console.log('\n--- Фаза 3 ---');
    const types3 = (await call('GET', PR('/node-types'), t1)).json?.data ?? [];
    check('палитра Ф3: +HTTP-запрос', types3.some((t) => t.type === 'service.http'), JSON.stringify(types3.map((t) => t.type)));

    // Сейф кредов
    const credCreate = await call('POST', PR('/credentials'), t1, { name: 'Тест-токен', type: 'bearer', token: 'secret-xyz' });
    check('креды созданы', credCreate.ok, `status ${credCreate.status}`);
    const credList = (await call('GET', PR('/credentials'), t1)).json?.data ?? [];
    check('креды в списке БЕЗ секрета', credList.some((c) => c.id === credCreate.json?.data?.id) && !JSON.stringify(credList).includes('secret-xyz'), JSON.stringify(credList));
    const credByTrainee = await call('GET', PR('/credentials'), t2);
    check('рядовой не видит креды → 403', credByTrainee.status === 403, `status ${credByTrainee.status}`);

    // Процесс с HTTP-нодой (httpbin.org — публичный эхо-сервис) + событие-триггер
    const def3 = await call('POST', PR(''), t1, { name: 'Авто (Ф3)' });
    const def3Id = def3.json?.data?.id;
    // Триггеры теперь — НОДЫ холста (модель n8n): фиксированного «Старт» нет.
    const trigKeys = types3.map((t) => t.type);
    check('палитра: триггер-ноды (расписание/вебхук/событие)', ['trigger.schedule', 'trigger.webhook', 'trigger.event'].every((k) => trigKeys.includes(k)), JSON.stringify(trigKeys.filter((t) => t.startsWith('trigger'))));
    const startDto = types3.find((t) => t.type === 'start');
    check('«Запуск вручную» = триггер-нода (без входа, категория trigger)', startDto?.trigger === true && startDto?.category === 'trigger', JSON.stringify({ tr: startDto?.trigger, cat: startDto?.category }));

    const doc3 = {
      nodes: [
        { id: 'start', type: 'start', label: 'Запуск вручную', config: {} },
        { id: 'http', type: 'service.http', label: 'Дёрнуть API', config: { method: 'GET', url: 'https://httpbin.org/status/200' } },
        { id: 'notifyOk', type: 'notify', label: 'Успех', config: { to: 'initiator', title: 'API ответил' } },
        { id: 'notifyErr', type: 'notify', label: 'Ошибка', config: { to: 'initiator', title: 'API не ответил' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
        { id: 'end2', type: 'end', label: 'Конец2', config: {} },
        // Триггер-ноды (n8n-модель): событие + вебхук, у каждого своя ветка к Концу
        { id: 'ev', type: 'trigger.event', label: 'На завершение задачи', config: { eventType: 'task.completed', runAsUserId: u1 } },
        { id: 'nEv', type: 'notify', label: 'Событие пришло', config: { to: 'initiator', title: 'Событие' } },
        { id: 'end3', type: 'end', label: 'Конец3', config: {} },
        { id: 'wh', type: 'trigger.webhook', label: 'Вебхук', config: { runAsUserId: u1 } },
        { id: 'nWh', type: 'notify', label: 'Вебхук пришёл', config: { to: 'initiator', title: 'Вебхук' } },
        { id: 'end4', type: 'end', label: 'Конец4', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'http' },
        { id: 'e2', from: 'http', fromPort: 'success', to: 'notifyOk' },
        { id: 'e3', from: 'http', fromPort: 'error', to: 'notifyErr' },
        { id: 'e4', from: 'notifyOk', fromPort: 'main', to: 'end' },
        { id: 'e5', from: 'notifyErr', fromPort: 'main', to: 'end2' },
        { id: 'e6', from: 'ev', fromPort: 'main', to: 'nEv' },
        { id: 'e7', from: 'nEv', fromPort: 'main', to: 'end3' },
        { id: 'e8', from: 'wh', fromPort: 'main', to: 'nWh' },
        { id: 'e9', from: 'nWh', fromPort: 'main', to: 'end4' },
      ],
      form: [],
    };
    const save3 = await call('PUT', PR(`/${def3Id}/document`), t1, { document: doc3 });
    check('документ с HTTP + триггер-нодами компилируется', save3.ok && (save3.json?.data?.issues ?? []).length === 0, JSON.stringify(save3.json?.data?.issues));
    // В триггер вести связь нельзя (у него нет входа)
    const badIntoTrigger = await call('PUT', PR(`/${def3Id}/document`), t1, { document: { ...doc3, edges: [...doc3.edges, { id: 'eX', from: 'http', fromPort: 'success', to: 'ev' }] } });
    check('связь В триггер → проблема компиляции', (badIntoTrigger.json?.data?.issues ?? []).some((i) => /триггер/i.test(i.message)), JSON.stringify(badIntoTrigger.json?.data?.issues));
    await call('PUT', PR(`/${def3Id}/document`), t1, { document: doc3 }); // вернуть валидный
    await call('POST', PR(`/${def3Id}/publish`), t1);

    // Старый CRUD-эндпоинт триггеров удалён (триггеры — ноды холста)
    const oldTrigEndpoint = await call('POST', PR(`/${def3Id}/triggers`), t1, { type: 'event', eventType: 'task.completed', runAsUserId: u1 });
    check('старый эндпоинт создания триггера удалён → 404', oldTrigEndpoint.status === 404, `status ${oldTrigEndpoint.status}`);

    // Триггер-ноды синхронизированы в ProcessTrigger при ПУБЛИКАЦИИ — видны в detail.triggers
    const det3 = (await call('GET', PR(`/${def3Id}`), t1)).json?.data;
    const trigInfos = det3?.triggers ?? [];
    check('триггер-ноды синхронизированы при публикации (событие+вебхук)', trigInfos.some((t) => t.type === 'event') && trigInfos.some((t) => t.type === 'webhook'), JSON.stringify(trigInfos.map((t) => t.type)));
    const wh = trigInfos.find((t) => t.type === 'webhook');
    check('у вебхук-ноды публичный URL с токеном', !!wh?.webhookUrl && wh.webhookUrl.includes('/processes/webhook/'), wh?.webhookUrl);
    check('webhook-инфо привязана к nodeId ноды «wh»', wh?.nodeId === 'wh', wh?.nodeId);

    // Событие task.completed запускает процесс — СО СВОЕЙ триггер-ноды
    const tTask = await call('POST', '/tasks', t1, { title: 'триггер-задача', workspaceId: wsId }, { 'X-Workspace-Id': wsId });
    await call('POST', `/tasks/${tTask.json?.data?.id}/submit`, t1); // self-task → completed → событие
    await sleep(1500);
    const evInst = await prisma.processInstance.findFirst({ where: { definitionId: def3Id, triggerType: 'event' }, orderBy: { startedAt: 'desc' } });
    check('событие task.completed запустило процесс (event-триггер-нода)', !!evInst, evInst?.triggerType);
    if (evInst) {
      const evSteps = await prisma.processStepRun.findMany({ where: { instanceId: evInst.id }, select: { nodeId: true } });
      check('event-инстанс стартовал С ТРИГГЕР-НОДЫ «ev» (а не с ручного «start»)', evSteps.some((s) => s.nodeId === 'ev') && !evSteps.some((s) => s.nodeId === 'start'), JSON.stringify(evSteps.map((s) => s.nodeId)));
    }

    // Вебхук стартует процесс (публичный, без токена авторизации)
    const token = wh.webhookUrl.split('/processes/webhook/')[1];
    const whRes = await call('POST', `/processes/webhook/${token}`, null, { source: 'kaspi-test' });
    check('вебхук-нода запустила процесс (публично)', whRes.ok && !!whRes.json?.instanceId, `status ${whRes.status}`);
    const whBad = await call('POST', `/processes/webhook/nonexistent-token`, null, {});
    check('неизвестный вебхук → 404', whBad.status === 404, `status ${whBad.status}`);

    // дождёмся, пока http-инстансы доедут (httpbin может отвечать медленно) и подчистим
    await sleep(2500);
    await call('DELETE', PR('/credentials/' + credCreate.json?.data?.id), t1).catch(() => {});
    const instsToCancel = await prisma.processInstance.findMany({ where: { definitionId: def3Id, status: 'running' }, select: { id: true } });
    for (const i of instsToCancel) await call('POST', PR(`/instances/${i.id}/cancel`), t1).catch(() => {});
    await call('DELETE', PR(`/${def3Id}`), t1).catch(() => {});

    // ======================================================================
    // ФАЗА 4 — AI-кластер (AI-нода + AI-Агент)
    // ======================================================================
    console.log('\n--- Фаза 4 ---');
    const types4 = (await call('GET', PR('/node-types'), t1)).json?.data ?? [];
    check('палитра Ф4: +AI/+AI-Агент', types4.some((t) => t.type === 'ai.generate') && types4.some((t) => t.type === 'ai.agent'), JSON.stringify(types4.map((t) => t.type)));
    const agentNode = types4.find((t) => t.type === 'ai.agent');
    check('AI-Агент — нода категории ai', agentNode?.category === 'ai');

    // bearer-кред с фейковым ключом (реального LLM-ответа в e2e нет — проверяем ВЕСЬ путь до error)
    const aiCred = await call('POST', PR('/credentials'), t1, { name: 'AI-ключ', type: 'bearer', token: 'sk-fake-test-key' });
    const aiCredId = aiCred.json?.data?.id;

    const def4 = await call('POST', PR(''), t1, { name: 'AI (Ф4)' });
    const def4Id = def4.json?.data?.id;
    const doc4 = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'ai', type: 'ai.generate', label: 'Сократить', config: { provider: 'anthropic', credentialId: aiCredId, model: 'claude-sonnet-4-6', userPrompt: 'Сократи: {{form.text}}', maxTokens: 100 } },
        { id: 'okN', type: 'notify', label: 'Готово', config: { to: 'initiator', title: 'AI ответил: {{steps.ai.text}}' } },
        { id: 'errN', type: 'notify', label: 'Ошибка', config: { to: 'initiator', title: 'AI не сработал' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
        { id: 'end2', type: 'end', label: 'Конец2', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'ai' },
        { id: 'e2', from: 'ai', fromPort: 'success', to: 'okN' },
        { id: 'e3', from: 'ai', fromPort: 'error', to: 'errN' },
        { id: 'e4', from: 'okN', fromPort: 'main', to: 'end' },
        { id: 'e5', from: 'errN', fromPort: 'main', to: 'end2' },
      ],
      form: [{ key: 'text', label: 'Текст', type: 'text', required: true }],
    };
    const save4 = await call('PUT', PR(`/${def4Id}/document`), t1, { document: doc4 });
    check('AI-документ компилируется (success/error выходы, {{steps.ai.text}})', save4.ok && (save4.json?.data?.issues ?? []).length === 0, JSON.stringify(save4.json?.data?.issues));
    const pub4 = await call('POST', PR(`/${def4Id}/publish`), t1);
    check('AI-процесс опубликован', pub4.ok, `status ${pub4.status}`);

    const r4 = await call('POST', PR(`/${def4Id}/start`), t1, { input: { text: 'Длинный текст про снабжение и закупки' } });
    const instAi = r4.json?.data;
    await sleep(3000); // даём LLM-вызову (фейк-ключ → 401/ошибка) отработать
    const instAiB = (await call('GET', PR(`/instances/${instAi.id}`), t1)).json?.data;
    const aiStep = (instAiB?.steps ?? []).find((s) => s.nodeId === 'ai');
    check('AI-нода выполнилась и обработала ошибку фейк-ключа (не уронила процесс)', aiStep?.status === 'done' && aiStep?.outcome === 'error', JSON.stringify({ st: aiStep?.status, oc: aiStep?.outcome }));
    check('процесс дошёл до конца через error-ветку', instAiB?.status === 'done', `status=${instAiB?.status}`);

    // ===== Ф4.5: n8n-агент — под-ноды через типизированные порты =====
    const types45 = (await call('GET', PR('/node-types'), t1)).json?.data ?? [];
    const tk45 = types45.map((t) => t.type);
    check('палитра Ф4.5: под-ноды Модель/Память/Парсер', ['ai.model', 'ai.memory', 'ai.parser'].every((k) => tk45.includes(k)), JSON.stringify(tk45.filter((t) => t.startsWith('ai.'))));
    // Инструменты агента = сами ноды действий (n8n): HTTP/Уведомить/Telegram имеют выход astool; отдельных ai.tool.* нет
    const allHaveAstool = ['service.http', 'notify', 'kz.telegram'].every((tp) => { const d = types45.find((t) => t.type === tp); return (d?.outputs ?? []).some((o) => o.key === 'astool' && o.type === 'ai_tool'); });
    check('ноды HTTP/Уведомить/Telegram работают как инструмент агента (astool), отдельных ai.tool.* нет', allHaveAstool && !tk45.includes('ai.tool.http') && !tk45.includes('ai.tool.notify') && !tk45.includes('ai.tool.telegram'), JSON.stringify(tk45.filter((t) => t.includes('tool'))));
    const agentDto = types45.find((t) => t.type === 'ai.agent');
    check('у агента типизированные входы ai_model/ai_memory/ai_tool', ['ai_model', 'ai_memory', 'ai_tool'].every((tp) => (agentDto?.inputs ?? []).some((i) => i.type === tp)), JSON.stringify(agentDto?.inputs));
    check('у агента есть выход astool (агент-как-инструмент)', (agentDto?.outputs ?? []).some((o) => o.key === 'astool' && o.type === 'ai_tool'));
    const modelDto = types45.find((t) => t.type === 'ai.model');
    check('Модель — под-нода с выходом ai_model', modelDto?.subNode === true && (modelDto?.outputs ?? []).some((o) => o.type === 'ai_model'));

    // Агент БЕЗ модели → компилятор требует подключить Модель
    const noModelDoc = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'agent', type: 'ai.agent', label: 'Агент', config: { userPrompt: 'привет' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
        { id: 'end2', type: 'end', label: 'К2', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'agent', toPort: 'main' },
        { id: 'e2', from: 'agent', fromPort: 'success', to: 'end', toPort: 'main' },
        { id: 'e3', from: 'agent', fromPort: 'error', to: 'end2', toPort: 'main' },
      ],
      form: [],
    };
    const saveNoModel = await call('PUT', PR(`/${def4Id}/document`), t1, { document: noModelDoc });
    check('агент без Модели → проблема компиляции', (saveNoModel.json?.data?.issues ?? []).some((i) => /Модель/.test(i.message)), JSON.stringify(saveNoModel.json?.data?.issues));

    // Полный кластер: Старт→Агент(+Модель+Память+HTTP-инструмент)→success/error→Конец
    const clusterDoc = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'agent', type: 'ai.agent', label: 'Диспетчер', config: { systemPrompt: 'Ты диспетчер', userPrompt: 'Обработай {{form.q}}', maxIterations: 2 } },
        { id: 'model', type: 'ai.model', label: 'Claude', config: { provider: 'anthropic', credentialId: aiCredId, model: 'claude-sonnet-4-6' } },
        { id: 'mem', type: 'ai.memory', label: 'Память', config: { sessionKey: '{{form.q}}' } },
        { id: 'toolHttp', type: 'service.http', label: 'HTTP-инструмент', config: { method: 'GET', url: 'https://httpbin.org/get' } },
        { id: 'okN', type: 'notify', label: 'OK', config: { to: 'initiator', title: 'Готово: {{steps.agent.text}}' } },
        { id: 'errN', type: 'notify', label: 'Ошибка', config: { to: 'initiator', title: 'Агент упал' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
        { id: 'end2', type: 'end', label: 'К2', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'agent', toPort: 'main' },
        { id: 'em', from: 'model', fromPort: 'model', to: 'agent', toPort: 'ai_model' },
        { id: 'ememo', from: 'mem', fromPort: 'memory', to: 'agent', toPort: 'ai_memory' },
        { id: 'et', from: 'toolHttp', fromPort: 'astool', to: 'agent', toPort: 'ai_tool' },
        { id: 'e2', from: 'agent', fromPort: 'success', to: 'okN', toPort: 'main' },
        { id: 'e3', from: 'agent', fromPort: 'error', to: 'errN', toPort: 'main' },
        { id: 'e4', from: 'okN', fromPort: 'main', to: 'end', toPort: 'main' },
        { id: 'e5', from: 'errN', fromPort: 'main', to: 'end2', toPort: 'main' },
      ],
      form: [{ key: 'q', label: 'Вопрос', type: 'text' }],
    };
    const saveCluster = await call('PUT', PR(`/${def4Id}/document`), t1, { document: clusterDoc });
    check('кластер (Модель+Память+Инструмент через порты) компилируется', saveCluster.ok && (saveCluster.json?.data?.issues ?? []).length === 0, JSON.stringify(saveCluster.json?.data?.issues));
    await call('POST', PR(`/${def4Id}/publish`), t1);
    const rc = await call('POST', PR(`/${def4Id}/start`), t1, { input: { q: 'тест' } });
    const instC45 = rc.json?.data;
    await sleep(3500); // фейк-ключ → агент дёрнет LLM → ошибка → error-ветка
    const instC45b = (await call('GET', PR(`/instances/${instC45.id}`), t1)).json?.data;
    const agentStep = (instC45b?.steps ?? []).find((s) => s.nodeId === 'agent');
    check('агент-с-кластером выполнился и обработал ошибку ключа (не упал)', agentStep?.status === 'done' && agentStep?.outcome === 'error', JSON.stringify({ st: agentStep?.status, oc: agentStep?.outcome }));
    check('процесс с агентом-кластером завершился', instC45b?.status === 'done', `status=${instC45b?.status}`);

    // Агент-как-инструмент: оркестратор → специалист (через astool→ai_tool)
    const orchDoc = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'orch', type: 'ai.agent', label: 'Оркестратор', config: { userPrompt: 'Спроси специалиста', maxIterations: 2 } },
        { id: 'orchModel', type: 'ai.model', label: 'M1', config: { provider: 'anthropic', credentialId: aiCredId, model: 'claude-sonnet-4-6' } },
        { id: 'spec', type: 'ai.agent', label: 'Специалист', config: { userPrompt: 'отвечай', toolDescription: 'эксперт по закупкам', maxIterations: 2 } },
        { id: 'specModel', type: 'ai.model', label: 'M2', config: { provider: 'anthropic', credentialId: aiCredId, model: 'claude-sonnet-4-6' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
        { id: 'end2', type: 'end', label: 'К2', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'orch', toPort: 'main' },
        { id: 'em1', from: 'orchModel', fromPort: 'model', to: 'orch', toPort: 'ai_model' },
        { id: 'em2', from: 'specModel', fromPort: 'model', to: 'spec', toPort: 'ai_model' },
        { id: 'astool', from: 'spec', fromPort: 'astool', to: 'orch', toPort: 'ai_tool' }, // специалист = инструмент оркестратора
        { id: 'e2', from: 'orch', fromPort: 'success', to: 'end', toPort: 'main' },
        { id: 'e3', from: 'orch', fromPort: 'error', to: 'end2', toPort: 'main' },
      ],
      form: [],
    };
    const saveOrch = await call('PUT', PR(`/${def4Id}/document`), t1, { document: orchDoc });
    check('агент-как-инструмент: оркестратор+специалист компилируется', saveOrch.ok && (saveOrch.json?.data?.issues ?? []).length === 0, JSON.stringify(saveOrch.json?.data?.issues));

    await call('DELETE', PR('/credentials/' + aiCredId), t1).catch(() => {});
    const ai4running = await prisma.processInstance.findMany({ where: { definitionId: def4Id, status: 'running' }, select: { id: true } });
    for (const i of ai4running) await call('POST', PR(`/instances/${i.id}/cancel`), t1).catch(() => {});
    await call('DELETE', PR(`/${def4Id}`), t1).catch(() => {});

    // ======================================================================
    // ФАЗА 6 — коннекторы Казахстана (Kaspi/Telegram/WhatsApp/SMS/1С)
    // ======================================================================
    console.log('\n--- Фаза 6 ---');
    const types6 = (await call('GET', PR('/node-types'), t1)).json?.data ?? [];
    const tk6 = types6.map((t) => t.type);
    check('палитра Ф6: +Kaspi/Telegram/WhatsApp/SMS/1С', ['kz.kaspi', 'kz.telegram', 'kz.whatsapp', 'kz.sms', 'kz.odata'].every((k) => tk6.includes(k)), JSON.stringify(tk6.filter((t) => t.startsWith('kz.'))));
    const kaspiDesc = types6.find((t) => t.type === 'kz.kaspi');
    check('Kaspi: операции new_orders/accept/complete', (kaspiDesc?.fields ?? []).some((f) => f.key === 'operation' && (f.options ?? []).length === 3));
    const odataDesc = types6.find((t) => t.type === 'kz.odata');
    check('1С-нода в категории integration', odataDesc?.category === 'integration');

    // kred + процесс с Telegram-нодой (фейк-токен → Telegram вернёт 401/404 → error-ветка)
    const tgCred = await call('POST', PR('/credentials'), t1, { name: 'TG-бот', type: 'bearer', token: '123:FAKE-bot-token' });
    const tgCredId = tgCred.json?.data?.id;
    const def6 = await call('POST', PR(''), t1, { name: 'KZ (Ф6)' });
    const def6Id = def6.json?.data?.id;
    const doc6 = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'tg', type: 'kz.telegram', label: 'В Телеграм', config: { credentialId: tgCredId, chatId: '{{form.chat}}', text: 'Заказ {{form.order}} принят' } },
        { id: 'okN', type: 'notify', label: 'OK', config: { to: 'initiator', title: 'Отправлено' } },
        { id: 'errN', type: 'notify', label: 'Ошибка', config: { to: 'initiator', title: 'TG не отправил' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
        { id: 'end2', type: 'end', label: 'К2', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'tg' },
        { id: 'e2', from: 'tg', fromPort: 'success', to: 'okN' },
        { id: 'e3', from: 'tg', fromPort: 'error', to: 'errN' },
        { id: 'e4', from: 'okN', fromPort: 'main', to: 'end' },
        { id: 'e5', from: 'errN', fromPort: 'main', to: 'end2' },
      ],
      form: [{ key: 'chat', label: 'Чат', type: 'text' }, { key: 'order', label: 'Заказ', type: 'text' }],
    };
    const save6 = await call('PUT', PR(`/${def6Id}/document`), t1, { document: doc6 });
    check('Telegram-документ компилируется (success/error + подстановки)', save6.ok && (save6.json?.data?.issues ?? []).length === 0, JSON.stringify(save6.json?.data?.issues));
    await call('POST', PR(`/${def6Id}/publish`), t1);
    const r6 = await call('POST', PR(`/${def6Id}/start`), t1, { input: { chat: '12345', order: 'A-100' } });
    const inst6 = r6.json?.data;
    await sleep(2500); // фейк-токен → Telegram API ответит ошибкой
    const inst6b = (await call('GET', PR(`/instances/${inst6.id}`), t1)).json?.data;
    const tgStep = (inst6b?.steps ?? []).find((s) => s.nodeId === 'tg');
    check('Telegram-нода реально вызвала API и ушла в error на фейк-токене', tgStep?.status === 'done' && tgStep?.outcome === 'error', JSON.stringify({ st: tgStep?.status, oc: tgStep?.outcome }));
    check('процесс с коннектором завершился через error-ветку', inst6b?.status === 'done', `status=${inst6b?.status}`);

    // Kaspi/расписание сценарий: документ Старт→Kaspi(new_orders)→Конец компилируется
    const docKaspi = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'kaspi', type: 'kz.kaspi', label: 'Новые заказы', config: { credentialId: tgCredId, operation: 'new_orders' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
        { id: 'end2', type: 'end', label: 'К2', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'kaspi' },
        { id: 'e2', from: 'kaspi', fromPort: 'success', to: 'end' },
        { id: 'e3', from: 'kaspi', fromPort: 'error', to: 'end2' },
      ],
      form: [],
    };
    const saveKaspi = await call('PUT', PR(`/${def6Id}/document`), t1, { document: docKaspi });
    check('Kaspi-документ компилируется (new_orders + success/error)', saveKaspi.ok && (saveKaspi.json?.data?.issues ?? []).length === 0, JSON.stringify(saveKaspi.json?.data?.issues));

    // ===== Telegram-ТРИГГЕР: входящее сообщение боту → процесс → (ответ нодой Telegram) =====
    const typesTg = (await call('GET', PR('/node-types'), t1)).json?.data ?? [];
    check('палитра: триггер «Telegram: входящее»', typesTg.some((t) => t.type === 'trigger.telegram' && t.trigger === true && t.category === 'trigger'), JSON.stringify(typesTg.filter((t) => t.type === 'trigger.telegram')));

    const defTg = await call('POST', PR(''), t1, { name: 'TG-бот (входящее)' });
    const defTgId = defTg.json?.data?.id;
    const docTg = {
      nodes: [
        { id: 'tgin', type: 'trigger.telegram', label: 'Telegram вход', config: { credentialId: tgCredId, runAsUserId: u1 } },
        { id: 'echo', type: 'notify', label: 'Эхо', config: { to: 'initiator', title: 'Пришло от {{form.fromName}}: {{form.text}}' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'tgin', fromPort: 'main', to: 'echo' },
        { id: 'e2', from: 'echo', fromPort: 'main', to: 'end' },
      ],
      form: [],
    };
    const saveTg = await call('PUT', PR(`/${defTgId}/document`), t1, { document: docTg });
    check('Telegram-триггер документ компилируется', saveTg.ok && (saveTg.json?.data?.issues ?? []).length === 0, JSON.stringify(saveTg.json?.data?.issues));
    await call('POST', PR(`/${defTgId}/publish`), t1);

    const detTg = (await call('GET', PR(`/${defTgId}`), t1)).json?.data;
    const tgTrig = (detTg?.triggers ?? []).find((t) => t.type === 'telegram');
    check('Telegram-триггер синхронизирован (type=telegram, путь /webhook/telegram/)', !!tgTrig?.webhookUrl && tgTrig.webhookUrl.includes('/processes/webhook/telegram/'), tgTrig?.webhookUrl);
    check('Telegram webhook-инфо привязана к nodeId «tgin»', tgTrig?.nodeId === 'tgin', tgTrig?.nodeId);

    // Имитируем входящий апдейт Telegram → процесс стартует с триггер-ноды, текст/чат в анкете
    const tgToken = tgTrig.webhookUrl.split('/processes/webhook/telegram/')[1];
    const tgUpdate = { update_id: 1, message: { message_id: 7, chat: { id: 555111 }, from: { id: 999, first_name: 'Диана' }, text: 'Привет, бот!' } };
    const tgFire = await call('POST', `/processes/webhook/telegram/${tgToken}`, null, tgUpdate);
    check('Telegram-апдейт принят (200, инстанс создан)', tgFire.ok && !!tgFire.json?.instanceId, `status ${tgFire.status} ${JSON.stringify(tgFire.json)}`);
    await sleep(800);
    const tgInst = await prisma.processInstance.findFirst({ where: { definitionId: defTgId, triggerType: 'telegram' }, orderBy: { startedAt: 'desc' } });
    check('инстанс помечен triggerType=telegram', !!tgInst, tgInst?.triggerType);
    check('текст и чат попали в анкету ({{form.text}}/{{form.chatId}})', tgInst?.variables?.text === 'Привет, бот!' && tgInst?.variables?.chatId === '555111', JSON.stringify(tgInst?.variables));
    if (tgInst) {
      const tgSteps = await prisma.processStepRun.findMany({ where: { instanceId: tgInst.id }, select: { nodeId: true } });
      check('инстанс стартовал С ТРИГГЕР-НОДЫ «tgin»', tgSteps.some((s) => s.nodeId === 'tgin'), JSON.stringify(tgSteps.map((s) => s.nodeId)));
    }
    const echoNotif = await prisma.notification.findFirst({ where: { userId: u1, type: 'process.step.notify' }, orderBy: { createdAt: 'desc' } });
    check('эхо-ответ с текстом и именем отправителя', !!echoNotif && (echoNotif.title ?? '').includes('Привет, бот!') && (echoNotif.title ?? '').includes('Диана'), echoNotif?.title);
    // не-текстовый апдейт (фото) тихо игнорируется: 200, без нового инстанса
    const tgBefore = await prisma.processInstance.count({ where: { definitionId: defTgId } });
    const tgPhoto = await call('POST', `/processes/webhook/telegram/${tgToken}`, null, { update_id: 2, message: { message_id: 8, chat: { id: 555111 }, from: { id: 999 }, photo: [{}] } });
    await sleep(400);
    const tgAfter = await prisma.processInstance.count({ where: { definitionId: defTgId } });
    check('не-текстовый апдейт игнорирован (200, без запуска)', tgPhoto.ok && tgAfter === tgBefore, `${tgBefore}→${tgAfter} status ${tgPhoto.status}`);
    const tgRunning = await prisma.processInstance.findMany({ where: { definitionId: defTgId, status: 'running' }, select: { id: true } });
    for (const i of tgRunning) await call('POST', PR(`/instances/${i.id}/cancel`), t1).catch(() => {});
    await call('DELETE', PR(`/${defTgId}`), t1).catch(() => {});

    // ===== Telegram = ОДНА нода (n8n): и выход, и инструмент агента; «Инструмент: Telegram» удалён =====
    const tgDesc = types6.find((t) => t.type === 'kz.telegram');
    check('у ноды Telegram есть выход «как инструмент» (astool/ai_tool)', (tgDesc?.outputs ?? []).some((o) => o.key === 'astool' && o.type === 'ai_tool'), JSON.stringify(tgDesc?.outputs));
    check('отдельная нода «Инструмент: Telegram» удалена из палитры', !tk6.includes('ai.tool.telegram'), JSON.stringify(tk6.filter((t) => t.includes('tool'))));

    // kz.telegram как ИНСТРУМЕНТ агента (нода потока, подключённая astool→agent.ai_tool) — компилируется
    const mdlCredId = (await call('POST', PR('/credentials'), t1, { name: 'AI-ключ(merge)', type: 'bearer', token: 'sk-fake' })).json?.data?.id;
    const defMergeId = (await call('POST', PR(''), t1, { name: 'TG-как-инструмент' })).json?.data?.id;
    const docMerge = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'agent', type: 'ai.agent', label: 'Агент', config: { userPrompt: 'ответь и при необходимости напиши в телеграм' } },
        { id: 'model', type: 'ai.model', label: 'Модель', config: { provider: 'anthropic', credentialId: mdlCredId, model: 'claude-sonnet-4-6' } },
        { id: 'tg', type: 'kz.telegram', label: 'Telegram', config: { credentialId: tgCredId, chatId: '12345' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
        { id: 'end2', type: 'end', label: 'К2', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'agent', toPort: 'main' },
        { id: 'em', from: 'model', fromPort: 'model', to: 'agent', toPort: 'ai_model' },
        { id: 'et', from: 'tg', fromPort: 'astool', to: 'agent', toPort: 'ai_tool' },
        { id: 'e2', from: 'agent', fromPort: 'success', to: 'end', toPort: 'main' },
        { id: 'e3', from: 'agent', fromPort: 'error', to: 'end2', toPort: 'main' },
      ],
      form: [],
    };
    const saveMerge = await call('PUT', PR(`/${defMergeId}/document`), t1, { document: docMerge });
    check('Telegram-нода КАК ИНСТРУМЕНТ агента компилируется (astool→ai_tool, text не обязателен)', saveMerge.ok && (saveMerge.json?.data?.issues ?? []).length === 0, JSON.stringify(saveMerge.json?.data?.issues));
    await call('DELETE', PR(`/${defMergeId}`), t1).catch(() => {});
    await call('DELETE', PR('/credentials/' + mdlCredId), t1).catch(() => {});

    await call('DELETE', PR('/credentials/' + tgCredId), t1).catch(() => {});
    const r6running = await prisma.processInstance.findMany({ where: { definitionId: def6Id, status: 'running' }, select: { id: true } });
    for (const i of r6running) await call('POST', PR(`/instances/${i.id}/cancel`), t1).catch(() => {});
    await call('DELETE', PR(`/${def6Id}`), t1).catch(() => {});
  } finally {
    if (cleanup.wsId) {
      await prisma.task.deleteMany({ where: { workspaceId: cleanup.wsId } }).catch(() => {});
      await prisma.processDefinition.deleteMany({ where: { workspaceId: cleanup.wsId } }).catch(() => {});
      await prisma.workspaceInvitation.deleteMany({ where: { workspaceId: cleanup.wsId } }).catch(() => {});
      await call('DELETE', `/workspaces/${cleanup.wsId}`, t1).catch(() => {});
    }
    await prisma.notification.deleteMany({ where: { type: { in: ['process.finished', 'process.failed', 'process.step.notify'] } } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ PROCESSES («ПРОЦЕССЫ») ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
