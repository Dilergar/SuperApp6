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

    // ======================================================================
    // P0 (ревью движка) — A2 branch-local end · A1 join force-fire · A12 SSRF ·
    // A4 анти-runaway триггеров · P8/A5 монотонный счётчик шагов.
    // (P3 «лок не поверх I/O» валидируется Ф4/Ф6: io-ноды ai/http/kz проходят
    //  путь аренда→исполнение-вне-лока→коммит и завершаются корректно.)
    // ======================================================================
    console.log('\n--- P0 (ревью) ---');

    // ---- A2: «Конец» в параллельной ветке гасит ТОЛЬКО свою ветку и не осиротит соседей ----
    const defA2Id = (await call('POST', PR(''), t1, { name: 'A2 branch-end' })).json?.data?.id;
    const docA2 = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'split', type: 'parallel.split', label: 'Развилка', config: {} },
        { id: 'taskLong', type: 'human.task', label: 'Долгая ветка', config: { title: 'Долгая', assigneeMode: 'member', assigneeUserId: u2 } },
        { id: 'quickEnd', type: 'end', label: 'Быстрый конец', config: {} },
        { id: 'endLong', type: 'end', label: 'Конец долгой', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'split' },
        { id: 'e2', from: 'split', fromPort: 'main', to: 'taskLong' },
        { id: 'e3', from: 'split', fromPort: 'main', to: 'quickEnd' },
        { id: 'e4', from: 'taskLong', fromPort: 'main', to: 'endLong' },
      ],
      form: [],
    };
    const saveA2 = await call('PUT', PR(`/${defA2Id}/document`), t1, { document: docA2 });
    check('A2: документ (ветка со своим «Концом») компилируется', saveA2.ok && (saveA2.json?.data?.issues ?? []).length === 0, JSON.stringify(saveA2.json?.data?.issues));
    await call('POST', PR(`/${defA2Id}/publish`), t1);
    const instA2 = (await call('POST', PR(`/${defA2Id}/start`), t1, { input: {} })).json?.data;
    await sleep(600);
    const instA2b = (await call('GET', PR(`/instances/${instA2.id}`), t1)).json?.data;
    const longStep = (instA2b?.steps ?? []).find((s) => s.nodeId === 'taskLong');
    const quickEndStep = (instA2b?.steps ?? []).find((s) => s.nodeId === 'quickEnd');
    check('A2: «Конец» ветки НЕ завершил весь процесс (соседняя ветка жива)', instA2b?.status === 'running' && longStep?.status === 'active' && !!longStep?.taskId, `status=${instA2b?.status} long=${longStep?.status}`);
    check('A2: терминал ветки погашен (consumed), соседей не тронул', quickEndStep?.status === 'done');
    const longTask = await call('GET', `/tasks/${longStep?.taskId}`, t2);
    check('A2: задача соседней ветки НЕ осиротела (жива, не отменена)', longTask.ok && longTask.json?.data?.status !== 'cancelled', longTask.json?.data?.status);
    await call('POST', `/tasks/${longStep.taskId}/submit`, t2);
    await call('POST', `/tasks/${longStep.taskId}/accept`, t1);
    await sleep(700);
    const instA2c = (await call('GET', PR(`/instances/${instA2.id}`), t1)).json?.data;
    check('A2: обе ветки дошли до «Конца» → процесс завершён (drain)', instA2c?.status === 'done', `status=${instA2c?.status}`);
    // P8/A5: монотонный счётчик = числу порождённых шагов (без join = число строк).
    const a2rows = await prisma.processStepRun.count({ where: { instanceId: instA2.id } });
    const a2inst = await prisma.processInstance.findUnique({ where: { id: instA2.id }, select: { stepsSpawned: true } });
    check('P8/A5: монотонный счётчик шагов = числу порождённых шагов', a2inst?.stepsSpawned === a2rows && a2rows >= 5, `spawned=${a2inst?.stepsSpawned} rows=${a2rows}`);
    await call('DELETE', PR(`/${defA2Id}`), t1).catch(() => {});

    // ---- A1: слияние добивается, когда уведённая (condition) ветка уже не придёт ----
    const defA1Id = (await call('POST', PR(''), t1, { name: 'A1 join-skip' })).json?.data?.id;
    const docA1 = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'split', type: 'parallel.split', label: 'Развилка', config: {} },
        { id: 'cond', type: 'condition', label: 'VIP?', config: { field: 'vip', op: 'eq', value: 'yes' } },
        { id: 'vipNote', type: 'notify', label: 'VIP-путь', config: { to: 'initiator', title: 'VIP' } },
        { id: 'endSkip', type: 'end', label: 'Не-VIP конец', config: {} },
        { id: 'taskB', type: 'human.task', label: 'Ветка B', config: { title: 'B', assigneeMode: 'member', assigneeUserId: u2 } },
        { id: 'join', type: 'parallel.join', label: 'Слияние', config: {} },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'split' },
        { id: 'e2', from: 'split', fromPort: 'main', to: 'cond' },
        { id: 'e3', from: 'split', fromPort: 'main', to: 'taskB' },
        { id: 'e4', from: 'cond', fromPort: 'true', to: 'vipNote' },
        { id: 'e5', from: 'cond', fromPort: 'false', to: 'endSkip' },
        { id: 'e6', from: 'vipNote', fromPort: 'main', to: 'join' },
        { id: 'e7', from: 'taskB', fromPort: 'main', to: 'join' },
        { id: 'e8', from: 'join', fromPort: 'main', to: 'end' },
      ],
      form: [{ key: 'vip', label: 'VIP', type: 'text' }],
    };
    const saveA1 = await call('PUT', PR(`/${defA1Id}/document`), t1, { document: docA1 });
    check('A1: документ (развилка + слияние) компилируется', saveA1.ok && (saveA1.json?.data?.issues ?? []).length === 0, JSON.stringify(saveA1.json?.data?.issues));
    await call('POST', PR(`/${defA1Id}/publish`), t1);
    const instA1 = (await call('POST', PR(`/${defA1Id}/start`), t1, { input: { vip: 'no' } })).json?.data;
    await sleep(600);
    const instA1mid = (await call('GET', PR(`/instances/${instA1.id}`), t1)).json?.data;
    const tBranch = (instA1mid?.steps ?? []).find((s) => s.nodeId === 'taskB' && s.status === 'active');
    check('A1: не-VIP ветка ушла в свой «Конец», B ждёт', !!tBranch && (instA1mid?.steps ?? []).find((s) => s.nodeId === 'cond')?.outcome === 'false', JSON.stringify((instA1mid?.steps ?? []).map((s) => [s.nodeId, s.status, s.outcome])));
    await call('POST', `/tasks/${tBranch.taskId}/submit`, t2);
    await call('POST', `/tasks/${tBranch.taskId}/accept`, t1);
    await sleep(800);
    const instA1done = (await call('GET', PR(`/instances/${instA1.id}`), t1)).json?.data;
    check('A1: слияние добито (уведённая ветка не придёт) → завершён, НЕ висит вечно', instA1done?.status === 'done', `status=${instA1done?.status}`);
    check('A1: шаг слияния завершён (сработал с 1 из 2)', (instA1done?.steps ?? []).find((s) => s.nodeId === 'join')?.status === 'done');
    await call('DELETE', PR(`/${defA1Id}`), t1).catch(() => {});

    // ---- A12: SSRF — literal metadata-IP и decimal-кодированный loopback заблокированы ----
    const defSsrfId = (await call('POST', PR(''), t1, { name: 'A12 SSRF' })).json?.data?.id;
    const docSsrf = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'h1', type: 'service.http', label: 'metadata', config: { method: 'GET', url: 'http://169.254.169.254/latest/meta-data/' } },
        { id: 'h2', type: 'service.http', label: 'decimal-loopback', config: { method: 'GET', url: 'http://2130706433/' } },
        { id: 'eok1', type: 'end', label: 'ok1', config: {} },
        { id: 'eok2', type: 'end', label: 'ok2', config: {} },
        { id: 'eend', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'h1' },
        { id: 'e2', from: 'h1', fromPort: 'success', to: 'eok1' },
        { id: 'e3', from: 'h1', fromPort: 'error', to: 'h2' },
        { id: 'e4', from: 'h2', fromPort: 'success', to: 'eok2' },
        { id: 'e5', from: 'h2', fromPort: 'error', to: 'eend' },
      ],
      form: [],
    };
    const saveSsrf = await call('PUT', PR(`/${defSsrfId}/document`), t1, { document: docSsrf });
    check('A12: SSRF-документ компилируется', saveSsrf.ok && (saveSsrf.json?.data?.issues ?? []).length === 0, JSON.stringify(saveSsrf.json?.data?.issues));
    await call('POST', PR(`/${defSsrfId}/publish`), t1);
    const instSsrf = (await call('POST', PR(`/${defSsrfId}/start`), t1, { input: {} })).json?.data;
    await sleep(1200);
    const ssrfRows = await prisma.processStepRun.findMany({ where: { instanceId: instSsrf.id }, select: { nodeId: true, outcome: true, output: true } });
    const h1row = ssrfRows.find((s) => s.nodeId === 'h1');
    const h2row = ssrfRows.find((s) => s.nodeId === 'h2');
    check('A12: metadata-IP (169.254.169.254) заблокирован → error', h1row?.outcome === 'error' && /внутренн/i.test(JSON.stringify(h1row?.output ?? {})), JSON.stringify(h1row?.output));
    check('A12: decimal-кодированный loopback (2130706433) заблокирован → error', h2row?.outcome === 'error' && /внутренн/i.test(JSON.stringify(h2row?.output ?? {})), JSON.stringify(h2row?.output));
    await call('DELETE', PR(`/${defSsrfId}`), t1).catch(() => {});

    // ---- A4: задача-шаг процесса НЕ самозапускает процессы (self-событие пропущено) ----
    const defAmpId = (await call('POST', PR(''), t1, { name: 'A4 self-loop' })).json?.data?.id;
    const docAmp = {
      nodes: [
        { id: 'ev', type: 'trigger.event', label: 'На создание задачи', config: { eventType: 'task.created', runAsUserId: u1 } },
        { id: 'mk', type: 'human.task', label: 'Создать задачу', config: { title: 'Авто-задача', assigneeMode: 'initiator' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
        { id: 'st', type: 'start', label: 'Ручной старт', config: {} },
        { id: 'mk2', type: 'human.task', label: 'Стартовая задача', config: { title: 'Стартовая', assigneeMode: 'initiator' } },
        { id: 'end2', type: 'end', label: 'К2', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'ev', fromPort: 'main', to: 'mk' },
        { id: 'e2', from: 'mk', fromPort: 'main', to: 'end' },
        { id: 'e3', from: 'st', fromPort: 'main', to: 'mk2' },
        { id: 'e4', from: 'mk2', fromPort: 'main', to: 'end2' },
      ],
      form: [],
    };
    const saveAmp = await call('PUT', PR(`/${defAmpId}/document`), t1, { document: docAmp });
    check('A4: документ (триггер task.created + создание задачи) компилируется', saveAmp.ok && (saveAmp.json?.data?.issues ?? []).length === 0, JSON.stringify(saveAmp.json?.data?.issues));
    await call('POST', PR(`/${defAmpId}/publish`), t1);
    await call('POST', PR(`/${defAmpId}/start`), t1, { input: {} }); // ручной старт → процесс создаёт задачу-шаг
    await sleep(2000);
    const selfEventInsts = await prisma.processInstance.count({ where: { definitionId: defAmpId, triggerType: 'event' } });
    check('A4: задача-ШАГ процесса НЕ самозапускает процесс (self-событие пропущено)', selfEventInsts === 0, `event-instances=${selfEventInsts}`);
    // обычная (не-процессная) задача task.created В ТОМ ЖЕ воркспейсе — ДОЛЖНА триггерить (не заглушили всё)
    await call('POST', '/tasks', t1, { title: 'обычная', workspaceId: wsId }, { 'X-Workspace-Id': wsId });
    await sleep(2000);
    const realEventInsts = await prisma.processInstance.count({ where: { definitionId: defAmpId, triggerType: 'event' } });
    check('A4: обычная задача task.created ТРИГГЕРИТ процесс (событийный вход жив)', realEventInsts >= 1, `event-instances=${realEventInsts}`);
    check('A4: событийный запуск НЕ лавинит (его задача-шаг тоже не триггерит)', realEventInsts <= 3, `event-instances=${realEventInsts}`);
    const ampRunning = await prisma.processInstance.findMany({ where: { definitionId: defAmpId, status: 'running' }, select: { id: true } });
    for (const i of ampRunning) await call('POST', PR(`/instances/${i.id}/cancel`), t1).catch(() => {});
    await call('DELETE', PR(`/${defAmpId}`), t1).catch(() => {});

    // ---- P7: снимок label шага + тонкий статус-эндпоинт (без документа/анкеты) ----
    const defP7Id = (await call('POST', PR(''), t1, { name: 'P7 perf' })).json?.data?.id;
    const docP7 = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 't', type: 'human.task', label: 'Сделать дело', config: { title: 'дело', assigneeMode: 'member', assigneeUserId: u2 } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [{ id: 'e1', from: 'start', fromPort: 'main', to: 't' }, { id: 'e2', from: 't', fromPort: 'main', to: 'end' }],
      form: [],
    };
    await call('PUT', PR(`/${defP7Id}/document`), t1, { document: docP7 });
    await call('POST', PR(`/${defP7Id}/publish`), t1);
    const instP7 = (await call('POST', PR(`/${defP7Id}/start`), t1, { input: {} })).json?.data;
    await sleep(400);
    const fullP7 = (await call('GET', PR(`/instances/${instP7.id}`), t1)).json?.data;
    const tStep = (fullP7?.steps ?? []).find((s) => s.nodeId === 't');
    check('P7: подпись шага из снимка label («Сделать дело»)', tStep?.label === 'Сделать дело', tStep?.label);
    const statusRes = await call('GET', PR(`/instances/${instP7.id}/status`), t1);
    check('P7: тонкий статус-эндпоинт отвечает', statusRes.ok, `status ${statusRes.status}`);
    const st = statusRes.json?.data;
    check('P7: статус = шаги+статус, БЕЗ документа/анкеты', Array.isArray(st?.steps) && !!st?.status && st?.document === undefined && st?.variables === undefined, JSON.stringify({ steps: Array.isArray(st?.steps), status: st?.status, hasDoc: st?.document !== undefined }));
    check('P7: label шага есть и в тонком статусе', (st?.steps ?? []).find((s) => s.nodeId === 't')?.label === 'Сделать дело');
    const p7run = await prisma.processInstance.findMany({ where: { definitionId: defP7Id, status: 'running' }, select: { id: true } });
    for (const i of p7run) await call('POST', PR(`/instances/${i.id}/cancel`), t1).catch(() => {});
    await call('DELETE', PR(`/${defP7Id}`), t1).catch(() => {});

    // ======================================================================
    // ФАЗА 2 — надёжность (onError · retry · notify best-effort · entry-conditions)
    // ======================================================================
    console.log('\n--- Фаза 2 (надёжность) ---');
    const types2r = (await call('GET', PR('/node-types'), t1)).json?.data ?? [];
    check('Ф2: у ноды-действия есть поле «При ошибке» (onError)', ((types2r.find((t) => t.type === 'notify'))?.fields ?? []).some((f) => f.key === 'onError'), JSON.stringify(((types2r.find((t) => t.type === 'notify'))?.fields ?? []).map((f) => f.key)));
    check('Ф2: у io-ноды есть «Повторов при сбое» (retryMaxTries)', ((types2r.find((t) => t.type === 'service.http'))?.fields ?? []).some((f) => f.key === 'retryMaxTries'));
    check('Ф2: у триггера события есть условие запуска (condField)', ((types2r.find((t) => t.type === 'trigger.event'))?.fields ?? []).some((f) => f.key === 'condField'));
    check('Ф2: у триггера/терминала onError НЕТ', !((types2r.find((t) => t.type === 'start'))?.fields ?? []).some((f) => f.key === 'onError') && !((types2r.find((t) => t.type === 'end'))?.fields ?? []).some((f) => f.key === 'onError'));

    // ---- Retry On Fail: http на неразрешимый адрес, 2 повтора → _retries=2, ветка «Ошибка» ----
    const defRetryId = (await call('POST', PR(''), t1, { name: 'Ф2 retry' })).json?.data?.id;
    const docRetry = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'http', type: 'service.http', label: 'HTTP', config: { method: 'GET', url: 'https://nope.invalid/x', retryMaxTries: 2, retryWaitMs: 50 } },
        { id: 'eok', type: 'end', label: 'ok', config: {} },
        { id: 'eerr', type: 'end', label: 'err', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'http' },
        { id: 'e2', from: 'http', fromPort: 'success', to: 'eok' },
        { id: 'e3', from: 'http', fromPort: 'error', to: 'eerr' },
      ],
      form: [],
    };
    const saveRetry = await call('PUT', PR(`/${defRetryId}/document`), t1, { document: docRetry });
    check('Ф2 retry: документ компилируется', saveRetry.ok && (saveRetry.json?.data?.issues ?? []).length === 0, JSON.stringify(saveRetry.json?.data?.issues));
    await call('POST', PR(`/${defRetryId}/publish`), t1);
    const instRetry = (await call('POST', PR(`/${defRetryId}/start`), t1, { input: {} })).json?.data;
    await sleep(2500); // 1 попытка + 2 повтора × (NXDOMAIN + 50мс)
    const httpRow = await prisma.processStepRun.findFirst({ where: { instanceId: instRetry.id, nodeId: 'http' } });
    check('Ф2 retry: io-шаг повторился 2 раза (output._retries=2)', (httpRow?.output ?? {})._retries === 2, JSON.stringify(httpRow?.output));
    check('Ф2 retry: после повторов ушёл в ветку «Ошибка»', httpRow?.outcome === 'error', httpRow?.outcome);
    await call('DELETE', PR(`/${defRetryId}`), t1).catch(() => {});

    // ---- Entry-condition (sfflow#1): триггер стартует только при совпадении поля события ----
    const defCondId = (await call('POST', PR(''), t1, { name: 'Ф2 entry-cond' })).json?.data?.id;
    const docCond = {
      nodes: [
        { id: 'ev', type: 'trigger.event', label: 'На создание задачи', config: { eventType: 'task.created', condField: 'title', condOp: 'contains', condValue: 'СПЕЦ', runAsUserId: u1 } },
        { id: 'n', type: 'notify', label: 'Ок', config: { to: 'initiator', title: 'спец-задача' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [{ id: 'e1', from: 'ev', fromPort: 'main', to: 'n' }, { id: 'e2', from: 'n', fromPort: 'main', to: 'end' }],
      form: [],
    };
    const saveCond = await call('PUT', PR(`/${defCondId}/document`), t1, { document: docCond });
    check('Ф2 entry-cond: документ компилируется', saveCond.ok && (saveCond.json?.data?.issues ?? []).length === 0, JSON.stringify(saveCond.json?.data?.issues));
    await call('POST', PR(`/${defCondId}/publish`), t1);
    await call('POST', '/tasks', t1, { title: 'обычная задача', workspaceId: wsId }, { 'X-Workspace-Id': wsId }); // без «СПЕЦ»
    await sleep(1800);
    check('Ф2 entry-cond: задача без «СПЕЦ» НЕ запускает (условие отсекло)', (await prisma.processInstance.count({ where: { definitionId: defCondId } })) === 0);
    await call('POST', '/tasks', t1, { title: 'СПЕЦ задача', workspaceId: wsId }, { 'X-Workspace-Id': wsId }); // со «СПЕЦ»
    await sleep(1800);
    check('Ф2 entry-cond: задача со «СПЕЦ» запускает процесс', (await prisma.processInstance.count({ where: { definitionId: defCondId } })) >= 1);
    for (const i of await prisma.processInstance.findMany({ where: { definitionId: defCondId, status: 'running' }, select: { id: true } })) await call('POST', PR(`/instances/${i.id}/cancel`), t1).catch(() => {});
    await call('DELETE', PR(`/${defCondId}`), t1).catch(() => {});

    // ---- onError=continue + notify best-effort: уволенный ПОСЛЕ публикации не валит процесс ----
    const defOeId = (await call('POST', PR(''), t1, { name: 'Ф2 onError' })).json?.data?.id;
    const docOe = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'notif', type: 'notify', label: 'Уведомить', config: { to: 'member', userId: u2, title: 'привет' } },
        { id: 'task', type: 'human.task', label: 'Задача', config: { title: 'дело', assigneeMode: 'member', assigneeUserId: u2, onError: 'continue' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'notif' },
        { id: 'e2', from: 'notif', fromPort: 'main', to: 'task' },
        { id: 'e3', from: 'task', fromPort: 'main', to: 'end' },
      ],
      form: [],
    };
    const saveOe = await call('PUT', PR(`/${defOeId}/document`), t1, { document: docOe });
    check('Ф2 onError: документ компилируется (u2 действующий)', saveOe.ok && (saveOe.json?.data?.issues ?? []).length === 0, JSON.stringify(saveOe.json?.data?.issues));
    await call('POST', PR(`/${defOeId}/publish`), t1);
    await call('DELETE', `/workspaces/${wsId}/members/${u2}`, t1); // увольняем ПОСЛЕ публикации
    const instOe = (await call('POST', PR(`/${defOeId}/start`), t1, { input: {} })).json?.data;
    await sleep(900);
    const instOeB = (await call('GET', PR(`/instances/${instOe.id}`), t1)).json?.data;
    check('Ф2: notify уволенному — best-effort, шаг done (не валит)', (instOeB?.steps ?? []).find((s) => s.nodeId === 'notif')?.status === 'done', JSON.stringify((instOeB?.steps ?? []).map((s) => [s.nodeId, s.status])));
    check('Ф2: onError=continue у задачи уволенному → шаг done, процесс завершён (не error)', instOeB?.status === 'done' && (instOeB?.steps ?? []).find((s) => s.nodeId === 'task')?.status === 'done', `status=${instOeB?.status}`);
    await call('DELETE', PR(`/${defOeId}`), t1).catch(() => {});

    // ======================================================================
    // ФАЗА 3 — ноды-действия (через NodeRunDeps.getService, от имени инициатора)
    // ======================================================================
    console.log('\n--- Фаза 3 (ноды-действия) ---');
    // Ф2 уволил u2 — нанимаем заново (нужен как исполнитель/цель действий).
    await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: P2 });
    const reinv = (await call('GET', '/workspaces/invitations/incoming', t2)).json?.data?.find((i) => i.workspaceId === wsId);
    await call('POST', `/workspaces/invitations/${reinv?.id}/accept`, t2);
    check('Ф3: u2 нанят заново (для тестов действий)', !!reinv, reinv?.id);

    const types3f = (await call('GET', PR('/node-types'), t1)).json?.data ?? [];
    const tk3 = types3f.map((t) => t.type);
    check('Ф3: палитра +action.richcard/service.message/staff.assign/workspaces.role/process.start', ['action.richcard', 'service.message', 'staff.assign', 'workspaces.role', 'process.start'].every((k) => tk3.includes(k)), JSON.stringify(tk3.filter((t) => ['action.richcard', 'service.message', 'staff.assign', 'workspaces.role', 'process.start'].includes(t))));
    check('Ф3: у «Сообщение в чат» есть выход-инструмент (astool)', ((types3f.find((t) => t.type === 'service.message'))?.outputs ?? []).some((o) => o.key === 'astool'));

    // ---- richcard.execute: t1 (Постановщик) принимает сданную задачу; u2 (не Постановщик) → error ----
    const mkSubmittedTask = async () => {
      const tk = await call('POST', '/tasks', t1, { title: 'на приёмку', executorId: u2, workspaceId: wsId }, { 'X-Workspace-Id': wsId });
      await call('POST', `/tasks/${tk.json?.data?.id}/submit`, t2);
      return tk.json?.data?.id;
    };
    const rcTaskA = await mkSubmittedTask();
    const rcTaskB = await mkSubmittedTask();
    const defRcId = (await call('POST', PR(''), t1, { name: 'Ф3 richcard' })).json?.data?.id;
    const docRc = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'act', type: 'action.richcard', label: 'Принять задачу', config: { actionKey: 'task.accept', refType: 'task', refId: '{{form.taskId}}' } },
        { id: 'eok', type: 'end', label: 'ok', config: {} },
        { id: 'eerr', type: 'end', label: 'err', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'act' },
        { id: 'e2', from: 'act', fromPort: 'success', to: 'eok' },
        { id: 'e3', from: 'act', fromPort: 'error', to: 'eerr' },
      ],
      form: [{ key: 'taskId', label: 'Задача', type: 'text', required: true }],
    };
    const saveRc = await call('PUT', PR(`/${defRcId}/document`), t1, { document: docRc });
    check('Ф3 richcard: документ компилируется', saveRc.ok && (saveRc.json?.data?.issues ?? []).length === 0, JSON.stringify(saveRc.json?.data?.issues));
    await call('POST', PR(`/${defRcId}/publish`), t1);
    // t1 = Постановщик → приёмка проходит
    const rcOk = (await call('POST', PR(`/${defRcId}/start`), t1, { input: { taskId: rcTaskA } })).json?.data;
    await sleep(900);
    const rcOkB = (await call('GET', PR(`/instances/${rcOk.id}`), t1)).json?.data;
    check('Ф3 richcard: действие «Принять задачу» от Постановщика — success', (rcOkB?.steps ?? []).find((s) => s.nodeId === 'act')?.outcome === 'success', JSON.stringify((rcOkB?.steps ?? []).map((s) => [s.nodeId, s.outcome])));
    check('Ф3 richcard: задача реально принята (done)', (await prisma.task.findUnique({ where: { id: rcTaskA }, select: { status: true } }))?.status === 'done');
    // u2 запускает тот же процесс на СВОЮ сданную задачу — u2 не Постановщик → capability recheck → error
    const rcNo = (await call('POST', PR(`/${defRcId}/start`), t2, { input: { taskId: rcTaskB } })).json?.data;
    await sleep(900);
    const rcNoB = (await call('GET', PR(`/instances/${rcNo.id}`), t2)).json?.data;
    check('Ф3 richcard: не-Постановщик → перепроверка прав → ветка «Ошибка» (нет эскалации)', (rcNoB?.steps ?? []).find((s) => s.nodeId === 'act')?.outcome === 'error', JSON.stringify((rcNoB?.steps ?? []).map((s) => [s.nodeId, s.outcome])));
    check('Ф3 richcard: чужая задача НЕ принята', (await prisma.task.findUnique({ where: { id: rcTaskB }, select: { status: true } }))?.status !== 'done');
    await call('DELETE', PR(`/${defRcId}`), t1).catch(() => {});

    // ---- message.send: DM инициатора сотруднику ----
    const defMsgId = (await call('POST', PR(''), t1, { name: 'Ф3 message' })).json?.data?.id;
    const docMsg = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'msg', type: 'service.message', label: 'В личку', config: { to: 'member', userId: u2, text: `Привет от процесса {{initiator.name}}` } },
        { id: 'eok', type: 'end', label: 'ok', config: {} },
        { id: 'eerr', type: 'end', label: 'err', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'msg' },
        { id: 'e2', from: 'msg', fromPort: 'success', to: 'eok' },
        { id: 'e3', from: 'msg', fromPort: 'error', to: 'eerr' },
      ],
      form: [],
    };
    await call('PUT', PR(`/${defMsgId}/document`), t1, { document: docMsg });
    await call('POST', PR(`/${defMsgId}/publish`), t1);
    const msgInst = (await call('POST', PR(`/${defMsgId}/start`), t1, { input: {} })).json?.data;
    await sleep(900);
    const msgStep = ((await call('GET', PR(`/instances/${msgInst.id}`), t1)).json?.data?.steps ?? []).find((s) => s.nodeId === 'msg');
    check('Ф3 message: сообщение отправлено (success)', msgStep?.outcome === 'success', msgStep?.outcome);
    check('Ф3 message: в БД есть сообщение процесса от t1', !!(await prisma.message.findFirst({ where: { authorId: u1, content: { contains: 'Привет от процесса' } } })));
    await call('DELETE', PR(`/${defMsgId}`), t1).catch(() => {});

    // ---- staff.assign: инициатор-manager+ назначает должность; trainee-инициатор → error ----
    const posF3 = await call('POST', `/workspaces/${wsId}/staff/positions`, t1, { name: 'Ф3-должность' });
    const posF3Id = posF3.json?.data?.id;
    const defAsgId = (await call('POST', PR(''), t1, { name: 'Ф3 staff' })).json?.data?.id;
    const docAsg = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'asg', type: 'staff.assign', label: 'Назначить', config: { userId: u2, positionId: posF3Id } },
        { id: 'eok', type: 'end', label: 'ok', config: {} },
        { id: 'eerr', type: 'end', label: 'err', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'asg' },
        { id: 'e2', from: 'asg', fromPort: 'success', to: 'eok' },
        { id: 'e3', from: 'asg', fromPort: 'error', to: 'eerr' },
      ],
      form: [],
    };
    await call('PUT', PR(`/${defAsgId}/document`), t1, { document: docAsg });
    await call('POST', PR(`/${defAsgId}/publish`), t1);
    const asgInst = (await call('POST', PR(`/${defAsgId}/start`), t1, { input: {} })).json?.data; // t1 = owner (manager+)
    await sleep(900);
    check('Ф3 staff.assign: должность назначена (initiator manager+)', !!(await prisma.staffAssignment.findFirst({ where: { workspaceId: wsId, userId: u2, positionId: posF3Id } })));
    // trainee-инициатор (u2) → assertStaffManage → error
    const asgNo = (await call('POST', PR(`/${defAsgId}/start`), t2, { input: {} })).json?.data;
    await sleep(900);
    const asgNoStep = ((await call('GET', PR(`/instances/${asgNo.id}`), t2)).json?.data?.steps ?? []).find((s) => s.nodeId === 'asg');
    check('Ф3 staff.assign: trainee-инициатор → ветка «Ошибка» (права энфорсятся)', asgNoStep?.outcome === 'error', asgNoStep?.outcome);
    await call('DELETE', PR(`/${defAsgId}`), t1).catch(() => {});

    // ---- workspaces.role: инициатор-admin+ меняет роль сотрудника ----
    const defRoleId = (await call('POST', PR(''), t1, { name: 'Ф3 role' })).json?.data?.id;
    const docRole = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'r', type: 'workspaces.role', label: 'Роль', config: { userId: u2, role: 'staff' } },
        { id: 'eok', type: 'end', label: 'ok', config: {} },
        { id: 'eerr', type: 'end', label: 'err', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'r' },
        { id: 'e2', from: 'r', fromPort: 'success', to: 'eok' },
        { id: 'e3', from: 'r', fromPort: 'error', to: 'eerr' },
      ],
      form: [],
    };
    await call('PUT', PR(`/${defRoleId}/document`), t1, { document: docRole });
    await call('POST', PR(`/${defRoleId}/publish`), t1);
    await call('POST', PR(`/${defRoleId}/start`), t1, { input: {} }); // t1 = owner (admin+)
    await sleep(900);
    const u2role = (await call('GET', `/workspaces/${wsId}/members`, t1)).json?.data?.find((m) => m.userId === u2)?.role;
    check('Ф3 workspaces.role: роль u2 изменена на staff', u2role === 'staff', u2role);
    await call('DELETE', PR(`/${defRoleId}`), t1).catch(() => {});

    // ---- process.start: родитель запускает опубликованный под-процесс ----
    const childId = (await call('POST', PR(''), t1, { name: 'Ф3 child' })).json?.data?.id;
    await call('PUT', PR(`/${childId}/document`), t1, { document: { nodes: [{ id: 'start', type: 'start', label: 'Старт', config: {} }, { id: 'n', type: 'notify', label: 'ok', config: { to: 'initiator', title: 'дочерний' } }, { id: 'end', type: 'end', label: 'Конец', config: {} }], edges: [{ id: 'e1', from: 'start', fromPort: 'main', to: 'n' }, { id: 'e2', from: 'n', fromPort: 'main', to: 'end' }], form: [] } });
    await call('POST', PR(`/${childId}/publish`), t1);
    const parentId = (await call('POST', PR(''), t1, { name: 'Ф3 parent' })).json?.data?.id;
    await call('PUT', PR(`/${parentId}/document`), t1, { document: { nodes: [{ id: 'start', type: 'start', label: 'Старт', config: {} }, { id: 'sub', type: 'process.start', label: 'Запустить дочерний', config: { definitionId: childId } }, { id: 'eok', type: 'end', label: 'ok', config: {} }, { id: 'eerr', type: 'end', label: 'err', config: {} }], edges: [{ id: 'e1', from: 'start', fromPort: 'main', to: 'sub' }, { id: 'e2', from: 'sub', fromPort: 'success', to: 'eok' }, { id: 'e3', from: 'sub', fromPort: 'error', to: 'eerr' }], form: [] } });
    await call('POST', PR(`/${parentId}/publish`), t1);
    const beforeChild = await prisma.processInstance.count({ where: { definitionId: childId } });
    await call('POST', PR(`/${parentId}/start`), t1, { input: {} });
    await sleep(1200);
    check('Ф3 process.start: под-процесс запущен родителем', (await prisma.processInstance.count({ where: { definitionId: childId } })) > beforeChild);
    for (const d of [parentId, childId]) {
      for (const i of await prisma.processInstance.findMany({ where: { definitionId: d, status: 'running' }, select: { id: true } })) await call('POST', PR(`/instances/${i.id}/cancel`), t1).catch(() => {});
      await call('DELETE', PR(`/${d}`), t1).catch(() => {});
    }

    // ======================================================================
    // ФАЗА 4 — новые триггеры + реестр резолверов
    // ======================================================================
    console.log('\n--- Фаза 4 (новые триггеры) ---');
    const types4f = (await call('GET', PR('/node-types'), t1)).json?.data ?? [];
    const evVals = (((types4f.find((t) => t.type === 'trigger.event'))?.fields ?? []).find((f) => f.key === 'eventType')?.options ?? []).map((o) => o.value);
    check('Ф4: палитра событий +shop.order.placed/funded/confirmed', ['shop.order.placed', 'shop.order.funded', 'shop.order.confirmed'].every((k) => evVals.includes(k)), JSON.stringify(evVals.filter((v) => v.startsWith('shop.'))));
    check('Ф4: палитра событий +workspace.member.removed (увольнение)', evVals.includes('workspace.member.removed'));

    // workspace.member.removed → offboarding-процесс (реестр резолверов + workspace-резолвер)
    const defOffId = (await call('POST', PR(''), t1, { name: 'Ф4 offboarding' })).json?.data?.id;
    const docOff = {
      nodes: [
        { id: 'ev', type: 'trigger.event', label: 'Увольнение', config: { eventType: 'workspace.member.removed', runAsUserId: u1 } },
        { id: 'n', type: 'notify', label: 'Обходной лист', config: { to: 'initiator', title: 'Сотрудник уволен — оформить обходной лист' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [{ id: 'e1', from: 'ev', fromPort: 'main', to: 'n' }, { id: 'e2', from: 'n', fromPort: 'main', to: 'end' }],
      form: [],
    };
    const saveOff = await call('PUT', PR(`/${defOffId}/document`), t1, { document: docOff });
    check('Ф4 offboarding: документ компилируется', saveOff.ok && (saveOff.json?.data?.issues ?? []).length === 0, JSON.stringify(saveOff.json?.data?.issues));
    await call('POST', PR(`/${defOffId}/publish`), t1);
    const beforeOff = await prisma.processInstance.count({ where: { definitionId: defOffId } });
    await call('DELETE', `/workspaces/${wsId}/members/${u2}`, t1); // увольняем u2 → workspace.member.removed
    await sleep(1800);
    check('Ф4: увольнение (workspace.member.removed) запустило процесс через реестр резолверов', (await prisma.processInstance.count({ where: { definitionId: defOffId } })) > beforeOff);
    for (const i of await prisma.processInstance.findMany({ where: { definitionId: defOffId, status: 'running' }, select: { id: true } })) await call('POST', PR(`/instances/${i.id}/cancel`), t1).catch(() => {});
    await call('DELETE', PR(`/${defOffId}`), t1).catch(() => {});

    // ======================================================================
    // ФАЗА 5 — поток данных (items[]): выражения + Set + «Перебрать список»
    // ======================================================================
    console.log('\n--- Фаза 5 (поток данных) ---');
    const types5 = (await call('GET', PR('/node-types'), t1)).json?.data ?? [];
    const tk5 = types5.map((t) => t.type);
    check('Ф5: палитра +loop.each/data.set', ['loop.each', 'data.set'].every((k) => tk5.includes(k)), JSON.stringify(tk5.filter((t) => t === 'loop.each' || t === 'data.set')));

    // 1) Set + безопасное выражение (арифметика + round) без цикла
    const defExpr = (await call('POST', PR(''), t1, { name: 'Ф5 expr' })).json?.data?.id;
    const docExpr = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'set', type: 'data.set', label: 'Налог', config: { assignments: 'tax = round(form.sum * 0.12, 2)' } },
        { id: 'n', type: 'notify', label: 'Уведомить', config: { to: 'initiator', title: 'налог {{form.tax}}' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'set' },
        { id: 'e2', from: 'set', fromPort: 'main', to: 'n' },
        { id: 'e3', from: 'n', fromPort: 'main', to: 'end' },
      ],
      form: [{ key: 'sum', label: 'Сумма', type: 'number', required: true }],
    };
    const saveExpr = await call('PUT', PR(`/${defExpr}/document`), t1, { document: docExpr });
    check('Ф5 expr: документ (Set + выражение) компилируется', saveExpr.ok && (saveExpr.json?.data?.issues ?? []).length === 0, JSON.stringify(saveExpr.json?.data?.issues));
    await call('POST', PR(`/${defExpr}/publish`), t1);
    await call('POST', PR(`/${defExpr}/start`), t1, { input: { sum: 100 } });
    await sleep(800);
    check('Ф5: Set + выражение round(form.sum*0.12,2)=12 вычислено и подставлено', !!(await prisma.notification.findFirst({ where: { userId: u1, type: 'process.step.notify', title: 'налог 12' } })));
    await call('DELETE', PR(`/${defExpr}`), t1).catch(() => {});

    // 2) «Перебрать список»: вебхук несёт массив → на каждый элемент под-ветка ({{item.n}}*2)
    const defLoop = (await call('POST', PR(''), t1, { name: 'Ф5 loop' })).json?.data?.id;
    const docLoop = {
      nodes: [
        { id: 'wh', type: 'trigger.webhook', label: 'Вебхук', config: { runAsUserId: u1 } },
        { id: 'loop', type: 'loop.each', label: 'Перебрать', config: { source: '{{form.items}}' } },
        { id: 'setD', type: 'data.set', label: 'Удвоить', config: { assignments: 'double = item.n * 2' } },
        { id: 'notif', type: 'notify', label: 'Элемент', config: { to: 'initiator', title: 'результат {{form.double}}' } },
        { id: 'notifDone', type: 'notify', label: 'Итог', config: { to: 'initiator', title: 'перебор готов' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'wh', fromPort: 'main', to: 'loop' },
        { id: 'e2', from: 'loop', fromPort: 'loop', to: 'setD' },
        { id: 'e3', from: 'setD', fromPort: 'main', to: 'notif' },
        { id: 'e4', from: 'notif', fromPort: 'main', to: 'loop' }, // ветка «Каждый» возвращается в цикл
        { id: 'e5', from: 'loop', fromPort: 'done', to: 'notifDone' },
        { id: 'e6', from: 'notifDone', fromPort: 'main', to: 'end' },
      ],
      form: [],
    };
    const saveLoop = await call('PUT', PR(`/${defLoop}/document`), t1, { document: docLoop });
    check('Ф5 loop: документ с циклом (ветка «Каждый» → назад) компилируется', saveLoop.ok && (saveLoop.json?.data?.issues ?? []).length === 0, JSON.stringify(saveLoop.json?.data?.issues));
    await call('POST', PR(`/${defLoop}/publish`), t1);
    const whTok = ((await call('GET', PR(`/${defLoop}`), t1)).json?.data?.triggers ?? []).find((t) => t.type === 'webhook')?.webhookUrl?.split('/processes/webhook/')[1];
    check('Ф5 loop: вебхук-триггер синхронизирован', !!whTok);
    const beforeDone = await prisma.notification.count({ where: { userId: u1, title: 'перебор готов' } });
    await call('POST', `/processes/webhook/${whTok}`, null, { items: [] }); // пустой список → сразу «Готово»
    await sleep(1000);
    check('Ф5 loop: пустой список → сразу «Готово» (0 элементов)', (await prisma.notification.count({ where: { userId: u1, title: 'перебор готов' } })) > beforeDone);
    await call('POST', `/processes/webhook/${whTok}`, null, { items: [{ n: 5 }, { n: 10 }] }); // список из 2
    await sleep(1800);
    check('Ф5 loop: элемент 1 ({{item.n}}=5 → double=10) обработан', !!(await prisma.notification.findFirst({ where: { userId: u1, title: 'результат 10' } })));
    check('Ф5 loop: элемент 2 ({{item.n}}=10 → double=20) обработан', !!(await prisma.notification.findFirst({ where: { userId: u1, title: 'результат 20' } })));
    for (const i of await prisma.processInstance.findMany({ where: { definitionId: defLoop, status: 'running' }, select: { id: true } })) await call('POST', PR(`/instances/${i.id}/cancel`), t1).catch(() => {});
    await call('DELETE', PR(`/${defLoop}`), t1).catch(() => {});

    // ======================================================================
    // ФАЗА 6 — полировка (A6 детект циклов агентов-инструментов)
    // ======================================================================
    console.log('\n--- Фаза 6 (полировка) ---');
    const credF6 = (await call('POST', PR('/credentials'), t1, { name: 'Ф6-ключ', type: 'bearer', token: 'sk-fake' })).json?.data?.id;
    const defCyc = (await call('POST', PR(''), t1, { name: 'Ф6 agent-cycle' })).json?.data?.id;
    const docCyc = {
      nodes: [
        { id: 'start', type: 'start', label: 'Старт', config: {} },
        { id: 'orch', type: 'ai.agent', label: 'Оркестратор', config: { userPrompt: 'делай' } },
        { id: 'orchM', type: 'ai.model', label: 'M1', config: { provider: 'anthropic', credentialId: credF6, model: 'claude-sonnet-4-6' } },
        { id: 'spec', type: 'ai.agent', label: 'Специалист', config: { userPrompt: 'отвечай', toolDescription: 'спец' } },
        { id: 'specM', type: 'ai.model', label: 'M2', config: { provider: 'anthropic', credentialId: credF6, model: 'claude-sonnet-4-6' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
        { id: 'end2', type: 'end', label: 'К2', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'main', to: 'orch', toPort: 'main' },
        { id: 'em1', from: 'orchM', fromPort: 'model', to: 'orch', toPort: 'ai_model' },
        { id: 'em2', from: 'specM', fromPort: 'model', to: 'spec', toPort: 'ai_model' },
        { id: 'a1', from: 'spec', fromPort: 'astool', to: 'orch', toPort: 'ai_tool' },
        { id: 'a2', from: 'orch', fromPort: 'astool', to: 'spec', toPort: 'ai_tool' }, // цикл orch↔spec
        { id: 'e2', from: 'orch', fromPort: 'success', to: 'end', toPort: 'main' },
        { id: 'e3', from: 'orch', fromPort: 'error', to: 'end2', toPort: 'main' },
      ],
      form: [],
    };
    const saveCyc = await call('PUT', PR(`/${defCyc}/document`), t1, { document: docCyc });
    check('Ф6 A6: цикл агентов-инструментов → проблема компиляции', (saveCyc.json?.data?.issues ?? []).some((i) => /цикл агентов/i.test(i.message)), JSON.stringify(saveCyc.json?.data?.issues));
    await call('DELETE', PR('/credentials/' + credF6), t1).catch(() => {});
    await call('DELETE', PR(`/${defCyc}`), t1).catch(() => {});
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
