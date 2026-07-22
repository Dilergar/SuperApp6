/* eslint-disable */
// E2E: core/chatter («Хроника записи», 9-й движок) — записи задач + плашки-проекция
// в чат джобами core/jobs (замена TaskSystemListener, тексты 1:1), B2B-аудит +
// «Журнал организации» (manager+), курсор BigInt. Requires API on 3001 + 3 seeded testers.
// Run: node apps/api/scripts/verify-chatter.cjs
const BASE = process.env.API_URL || 'http://localhost:3001/api';
const CREDS = {
  t1: { phone: '+77001234567', password: 'Test1234!' },
  t2: { phone: '+77012345678', password: 'Test1234!' },
  t3: { phone: '+77023456789', password: 'Test1234!' },
};
async function http(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, json };
}
async function login(creds) {
  const { json } = await http('POST', '/auth/login', { body: creds });
  const token = json.data.accessToken;
  const me = await http('GET', '/users/me', { token });
  const u = me.json.data;
  return { token, id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() };
}
let passed = 0, failed = 0;
const check = (n, c, extra) => {
  if (c) { passed++; console.log(`  PASS ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${extra ? `  (${extra})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(intervalMs);
  }
}

async function main() {
  // .env → DATABASE_URL для Prisma (детерминированные фикстуры + редрайв-инъекция).
  const fs = require('fs'); const path = require('path');
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  const t1 = await login(CREDS.t1); // постановщик / владелец организации
  const t2 = await login(CREDS.t2); // исполнитель / нанятый сотрудник
  const t3 = await login(CREDS.t3); // чужак
  console.log('logged in 3 testers');

  // Детерминированное окружение: t1↔t2 связаны (t3 для задачи A — чужой).
  const link = async (x, y, by) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    await prisma.contactLink.upsert({
      where: { userAId_userBId: { userAId: a, userBId: b } },
      update: {},
      create: { userAId: a, userBId: b, roleAForB: 'Коллега', roleBForA: 'Коллега', initiatedBy: by },
    });
  };
  await link(t1.id, t2.id, t1.id);

  const cleanup = { taskIds: [], wsId: null };
  try {
    // ============================================================
    console.log('\n-- 1. createTask → записи хроники (created + assigned), id = string DESC --');
    let r = await http('POST', '/tasks', {
      token: t1.token,
      body: { title: 'Хроника e2e', executorId: t2.id },
    });
    check('createTask ok', r.status === 200 || r.status === 201, `status ${r.status}`);
    const taskA = r.json?.data?.id;
    cleanup.taskIds.push(taskA);

    r = await http('GET', `/chatter/task/${taskA}`, { token: t1.token });
    check('GET /chatter/task/:id → 200', r.status === 200, `status ${r.status}`);
    let page = r.json?.data;
    const keys = (page?.items ?? []).map((e) => e.typeKey);
    check('есть task.created', keys.includes('task.created'));
    check('есть task.assigned', keys.includes('task.assigned'));
    check('id — строки цифр (BigInt→string)', (page?.items ?? []).every((e) => typeof e.id === 'string' && /^\d+$/.test(e.id)));
    const ids = (page?.items ?? []).map((e) => BigInt(e.id));
    check('порядок DESC', ids.every((v, i) => i === 0 || ids[i - 1] > v));
    check('actors несёт постановщика', !!page?.actors?.[t1.id]);

    // ============================================================
    console.log('\n-- 2. плашка-проекция в чате задачи (паритет текста 1:1) --');
    r = await http('GET', `/messenger/tasks/${taskA}/chat`, { token: t1.token });
    check('чат задачи существует', r.status === 200, `status ${r.status}`);
    const chatA = r.json?.data?.id;
    const sysMessages = async () => {
      const rr = await http('GET', `/messenger/chats/${chatA}/messages`, { token: t1.token });
      return (rr.json?.data ?? []).filter((m) => m.type === 'system');
    };
    const assignedPlaque = await waitFor(async () => {
      const sys = await sysMessages();
      return sys.find((m) => m.payload?.eventType === 'task.assigned') ?? null;
    }, 8000);
    check('плашка task.assigned появилась', !!assignedPlaque);
    check('текст 1:1 «назначил(а) задачу»', assignedPlaque?.payload?.text === `${t1.name} назначил(а) задачу`,
      `got: ${assignedPlaque?.payload?.text}`);
    check('плашка несёт chatterEntryId', typeof assignedPlaque?.payload?.chatterEntryId === 'string');
    const createdPlaque = (await sysMessages()).find((m) => m.payload?.eventType === 'task.created');
    check('task.created БЕЗ плашки (chatPost:false)', !createdPlaque);

    // ============================================================
    console.log('\n-- 3. PATCH срок/приоритет/название → диффы «было → стало» + плашки --');
    r = await http('PATCH', `/tasks/${taskA}`, {
      token: t1.token,
      body: { dueDate: '2026-07-25T10:00:00.000Z', priority: 'high', title: 'Хроника e2e v2' },
    });
    check('PATCH ok', r.status === 200, `status ${r.status}`);
    r = await http('GET', `/chatter/task/${taskA}`, { token: t1.token });
    page = r.json?.data;
    const byKey = (k) => (page?.items ?? []).find((e) => e.typeKey === k);
    const dl = byKey('task.deadline_changed');
    check('deadline_changed: from=«без срока»', dl?.changes?.[0]?.from === 'без срока', `got: ${dl?.changes?.[0]?.from}`);
    // Формат детерминирован в APP_TIMEZONE: дата (+ время у не-allDay задач).
    check('deadline_changed: to=дата(+время)', /^\d{2}\.\d{2}\.\d{4}( \d{2}:\d{2})?$/.test(dl?.changes?.[0]?.to ?? ''), `got: ${dl?.changes?.[0]?.to}`);
    const pr = byKey('task.priority_changed');
    check('priority_changed есть + from/to', !!pr && !!pr.changes?.[0]?.from && !!pr.changes?.[0]?.to);
    const tt = byKey('task.title_changed');
    check('title_changed: to=новое название', tt?.changes?.[0]?.to === 'Хроника e2e v2', `got: ${tt?.changes?.[0]?.to}`);
    const dlPlaque = await waitFor(async () => {
      const sys = await sysMessages();
      return sys.find((m) => m.payload?.eventType === 'task.deadline_changed') ?? null;
    }, 8000);
    check('плашка смены срока в чате', !!dlPlaque && dlPlaque.payload.text.includes('изменил(а) срок:') && dlPlaque.payload.text.includes('→'),
      `got: ${dlPlaque?.payload?.text}`);

    // ============================================================
    console.log('\n-- 4. жизненный цикл: submit → return → submit → accept (тексты 1:1) --');
    r = await http('POST', `/tasks/${taskA}/submit`, { token: t2.token });
    check('submit ok', r.status === 200 || r.status === 201, `status ${r.status}`);
    const submittedPlaque = await waitFor(async () => {
      const sys = await sysMessages();
      return sys.find((m) => m.payload?.eventType === 'task.submitted') ?? null;
    }, 8000);
    check('плашка «сдал(а) работу на проверку» 1:1', submittedPlaque?.payload?.text === `${t2.name} сдал(а) работу на проверку`,
      `got: ${submittedPlaque?.payload?.text}`);

    r = await http('POST', `/tasks/${taskA}/return`, { token: t1.token });
    check('return ok', r.status === 200 || r.status === 201, `status ${r.status}`);
    const returnedPlaque = await waitFor(async () => {
      const sys = await sysMessages();
      return sys.find((m) => m.payload?.eventType === 'task.returned') ?? null;
    }, 8000);
    check('плашка «Работа возвращена на доработку» 1:1', returnedPlaque?.payload?.text === 'Работа возвращена на доработку',
      `got: ${returnedPlaque?.payload?.text}`);

    await http('POST', `/tasks/${taskA}/submit`, { token: t2.token });
    r = await http('POST', `/tasks/${taskA}/accept`, { token: t1.token });
    check('accept ok', r.status === 200 || r.status === 201, `status ${r.status}`);
    const acceptedPlaque = await waitFor(async () => {
      const sys = await sysMessages();
      return sys.find((m) => m.payload?.eventType === 'task.accepted') ?? null;
    }, 8000);
    check('плашка «Работа принята» 1:1', acceptedPlaque?.payload?.text === 'Работа принята', `got: ${acceptedPlaque?.payload?.text}`);
    const completedPlaque = await waitFor(async () => {
      const sys = await sysMessages();
      return sys.find((m) => m.payload?.eventType === 'task.completed') ?? null;
    }, 8000);
    check('плашка «Задача выполнена» 1:1', completedPlaque?.payload?.text === 'Задача выполнена', `got: ${completedPlaque?.payload?.text}`);
    r = await http('GET', `/chatter/task/${taskA}`, { token: t1.token });
    const keys4 = (r.json?.data?.items ?? []).map((e) => e.typeKey);
    check('хроника несёт submitted/returned/accepted/completed',
      ['task.submitted', 'task.returned', 'task.accepted', 'task.completed'].every((k) => keys4.includes(k)));
    const acceptedEntry = (r.json?.data?.items ?? []).find((e) => e.typeKey === 'task.accepted');
    check('accepted несёт target (для журнала)', acceptedEntry?.payload?.targetUserId === t2.id);

    // ============================================================
    console.log('\n-- 4b. правки состава: participant_added только для РЕАЛЬНО новых (фикс фантома) --');
    await link(t1.id, t3.id, t1.id);
    let rb = await http('POST', '/tasks', { token: t1.token, body: { title: 'Состав e2e', executorId: t2.id } });
    check('taskB создана', rb.status === 200 || rb.status === 201, `status ${rb.status}`);
    const taskB = rb.json?.data?.id; cleanup.taskIds.push(taskB);
    // Реальное добавление наблюдателя t3 → одна запись participant_added.
    rb = await http('PATCH', `/tasks/${taskB}`, { token: t1.token, body: { addObserverIds: [t3.id] } });
    check('PATCH add observer ok', rb.status === 200, `status ${rb.status}`);
    let pb = (await http('GET', `/chatter/task/${taskB}`, { token: t1.token })).json?.data?.items ?? [];
    const addedT3 = pb.filter((e) => e.typeKey === 'task.participant_added' && e.payload?.targetUserId === t3.id);
    check('participant_added для t3 (реальное добавление, ровно 1)', addedT3.length === 1, `count ${addedT3.length}`);
    check('роль=Наблюдатель', addedT3[0]?.payload?.roleLabel === 'Наблюдатель', `got ${addedT3[0]?.payload?.roleLabel}`);
    // Повторное добавление уже существующего t2 (Исполнитель) как соисполнителя → applyRoleEdits
    // сделает no-op/смену роли, но плашки «добавил(а)» быть НЕ должно (иначе хроника лжёт).
    rb = await http('PATCH', `/tasks/${taskB}`, { token: t1.token, body: { addCoExecutorIds: [t2.id] } });
    check('PATCH re-add existing ok', rb.status === 200, `status ${rb.status}`);
    pb = (await http('GET', `/chatter/task/${taskB}`, { token: t1.token })).json?.data?.items ?? [];
    const addedT2 = pb.filter((e) => e.typeKey === 'task.participant_added' && e.payload?.targetUserId === t2.id);
    check('НЕТ фантомной participant_added для уже существующего t2', addedT2.length === 0, `count ${addedT2.length}`);

    // ============================================================
    console.log('\n-- 5. курсор-пагинация (limit=3, страницы не пересекаются) --');
    r = await http('GET', `/chatter/task/${taskA}?limit=3`, { token: t1.token });
    const p1 = r.json?.data;
    check('страница 1: 3 записи + nextCursor', p1?.items?.length === 3 && !!p1?.nextCursor);
    r = await http('GET', `/chatter/task/${taskA}?limit=3&cursor=${p1.nextCursor}`, { token: t1.token });
    const p2 = r.json?.data;
    const set1 = new Set((p1?.items ?? []).map((e) => e.id));
    check('страница 2 не пересекается с 1', (p2?.items ?? []).length > 0 && (p2?.items ?? []).every((e) => !set1.has(e.id)));

    // ============================================================
    console.log('\n-- 6. доступ: чужак 403, неизвестный refType 404 --');
    r = await http('GET', `/chatter/task/${taskA}`, { token: t3.token });
    check('чужак t3 → 403', r.status === 403, `status ${r.status}`);
    r = await http('GET', `/chatter/nonsense/${taskA}`, { token: t1.token });
    check('неизвестный refType → 404', r.status === 404, `status ${r.status}`);

    // ============================================================
    console.log('\n-- 7. B2B: найм/роль/должность пишутся в хронику организации --');
    r = await http('POST', '/workspaces', { token: t1.token, body: { name: `chatter-e2e-${Date.now()}` } });
    check('организация создана', r.ok, `status ${r.status}`);
    const wsId = r.json?.data?.id; cleanup.wsId = wsId;
    const WS = { 'X-Workspace-Id': wsId };

    r = await http('POST', `/workspaces/${wsId}/invitations`, { token: t1.token, body: { phone: CREDS.t2.phone } });
    check('приглашение отправлено (staff.invited)', r.ok, `status ${r.status}`);
    const invs = await http('GET', '/workspaces/invitations/incoming', { token: t2.token });
    const inv = (invs.json?.data ?? []).find((i) => i.workspaceId === wsId || i.workspace?.id === wsId);
    r = await http('POST', `/workspaces/invitations/${inv?.id}/accept`, { token: t2.token });
    check('t2 принял найм (staff.hired)', r.ok, `status ${r.status}`);

    console.log('\n-- 8. журнал: Стажёр/чужак 403, Менеджер 200 --');
    r = await http('GET', `/workspaces/${wsId}/journal`, { token: t2.token });
    check('Стажёр → 403', r.status === 403, `status ${r.status}`);
    r = await http('GET', `/workspaces/${wsId}/journal`, { token: t3.token });
    check('не член → 403', r.status === 403, `status ${r.status}`);

    r = await http('PATCH', `/workspaces/${wsId}/members/${t2.id}`, { token: t1.token, body: { role: 'manager' } });
    check('роль поднята до Менеджера (staff.role_changed)', r.ok, `status ${r.status}`);
    r = await http('GET', `/workspaces/${wsId}/journal`, { token: t2.token });
    check('Менеджер видит журнал → 200', r.status === 200, `status ${r.status}`);
    let jr = r.json?.data;
    const jKeys = (jr?.items ?? []).map((e) => e.typeKey);
    check('журнал: staff.invited', jKeys.includes('staff.invited'));
    check('журнал: staff.hired', jKeys.includes('staff.hired'));
    check('журнал: staff.role_changed', jKeys.includes('staff.role_changed'));
    const roleEntry = (jr?.items ?? []).find((e) => e.typeKey === 'staff.role_changed');
    check('role_changed: чипы «Стажёр → Менеджер»',
      roleEntry?.changes?.[0]?.from === 'Стажёр' && roleEntry?.changes?.[0]?.to === 'Менеджер',
      `got: ${roleEntry?.changes?.[0]?.from} → ${roleEntry?.changes?.[0]?.to}`);
    check('журнал: actors несёт владельца', !!jr?.actors?.[t1.id]);

    console.log('\n-- 9. должности: назначение/аттестация/снятие --');
    r = await http('POST', `/workspaces/${wsId}/staff/positions`, { token: t1.token, body: { name: 'Бариста' } });
    check('должность создана', r.ok, `status ${r.status}`);
    const posId = r.json?.data?.id;
    r = await http('POST', `/workspaces/${wsId}/staff/members/${t2.id}/assignments`, { token: t1.token, body: { positionId: posId } });
    check('назначение создано (staff.position_assigned)', r.ok, `status ${r.status}`);
    const assignmentId = r.json?.data?.id;
    r = await http('PATCH', `/workspaces/${wsId}/staff/assignments/${assignmentId}`, { token: t1.token, body: { status: 'certified' } });
    check('аттестация (staff.position_certified)', r.ok, `status ${r.status}`);
    r = await http('DELETE', `/workspaces/${wsId}/staff/assignments/${assignmentId}`, { token: t1.token });
    check('снятие (staff.position_removed)', r.ok, `status ${r.status}`);

    r = await http('GET', `/workspaces/${wsId}/journal`, { token: t1.token });
    const jKeys2 = (r.json?.data?.items ?? []).map((e) => e.typeKey);
    check('журнал: position_assigned/certified/removed',
      ['staff.position_assigned', 'staff.position_certified', 'staff.position_removed'].every((k) => jKeys2.includes(k)));
    const posEntry = (r.json?.data?.items ?? []).find((e) => e.typeKey === 'staff.position_assigned');
    check('position_assigned несёт positionName', posEntry?.payload?.positionName === 'Бариста');

    console.log('\n-- 10. задача организации в журнале + фильтр category --');
    r = await http('POST', '/tasks', { token: t1.token, body: { title: 'Орг-задача хроники', executorId: t2.id }, headers: WS });
    check('орг-задача создана', r.status === 200 || r.status === 201, `status ${r.status}`);
    const wsTaskId = r.json?.data?.id;
    r = await http('GET', `/workspaces/${wsId}/journal?category=tasks`, { token: t1.token });
    const taskJournal = r.json?.data?.items ?? [];
    check('category=tasks: орг-задача в журнале', taskJournal.some((e) => e.refId === wsTaskId && e.typeKey === 'task.created'));
    check('category=tasks: только task.*', taskJournal.every((e) => e.typeKey.startsWith('task.')));
    r = await http('GET', `/workspaces/${wsId}/journal?category=staff`, { token: t1.token });
    const staffJournal = r.json?.data?.items ?? [];
    check('category=staff: только staff.*', staffJournal.length > 0 && staffJournal.every((e) => e.typeKey.startsWith('staff.')));

    console.log('\n-- 11. увольнение и выход в журнале --');
    r = await http('DELETE', `/workspaces/${wsId}/members/${t2.id}`, { token: t1.token });
    check('увольнение ok (staff.fired)', r.ok, `status ${r.status}`);
    r = await http('GET', `/workspaces/${wsId}/journal`, { token: t1.token });
    check('журнал: staff.fired', (r.json?.data?.items ?? []).some((e) => e.typeKey === 'staff.fired' && e.payload?.targetUserId === t2.id));

    // ============================================================
    console.log('\n-- 12. потерянная плашка: запись без джоба + джоб (как бэкфилл) → обработчик допостил --');
    // Инъекция мимо log() = запись без джоба (доджобовая эра / потерянный джоб).
    // Джоб вставляем руками — ровно то, что делает bootstrap-бэкфилл ChatterService.
    const injected = await prisma.chatterEntry.create({
      data: {
        refType: 'task',
        refId: taskA,
        actorId: t1.id,
        actorName: 'Крон Тест',
        typeKey: 'task.priority_changed',
        changes: [{ field: 'priority', label: 'Приоритет', from: 'Тест-А', to: 'Тест-Б' }],
        payload: { taskTitle: 'Хроника e2e v2' },
        needsChatPost: true,
      },
    });
    await prisma.job.create({
      data: {
        type: 'chatter.chatpost',
        payload: { entryId: injected.id.toString() },
        uniqueKey: `ce:${injected.id.toString()}`,
        maxAttempts: 8,
      },
    });
    const redriven = await waitFor(async () => {
      const sys = await sysMessages();
      return sys.find((m) => m.payload?.chatterEntryId === injected.id.toString()) ?? null;
    }, 15_000, 1000);
    check('джоб допостил потерянную плашку', !!redriven, 'не появилась за 15с');
    check('текст плашки корректен', redriven?.payload?.text === 'Крон Тест изменил(а) приоритет: Тест-А → Тест-Б',
      `got: ${redriven?.payload?.text}`);
    const injectedRow = await prisma.chatterEntry.findUnique({ where: { id: injected.id } });
    check('терминал успеха выставлен (chatPostedAt)', !!injectedRow?.chatPostedAt);
    const jobRow = await prisma.job.findFirst({
      where: { type: 'chatter.chatpost', uniqueKey: `ce:${injected.id.toString()}` },
      orderBy: { id: 'desc' },
    });
    check('джоб completed (попытка учтена)', jobRow?.status === 'completed' && (jobRow?.attempts ?? 0) >= 1,
      `status ${jobRow?.status}, attempts ${jobRow?.attempts}`);
    const dupCount = (await sysMessages()).filter((m) => m.payload?.chatterEntryId === injected.id.toString()).length;
    check('плашка не задвоена', dupCount === 1, `count ${dupCount}`);

    // ============================================================
    console.log('\n-- 13. дедуп: краш «после поста, до отметки» → повторный джоб НЕ дублит --');
    // Сбрасываем терминал (как будто инстанс умер после поста, не отметив успех) и ставим
    // НОВЫЙ джоб того же ключа (старый терминален — partial unique не мешает): обработчик
    // снова позовёт синк, но дедуп мессенджера по chatterEntryId не создаст 2-ю плашку.
    await prisma.chatterEntry.update({
      where: { id: injected.id },
      data: { chatPostedAt: null },
    });
    await prisma.job.create({
      data: {
        type: 'chatter.chatpost',
        payload: { entryId: injected.id.toString() },
        uniqueKey: `ce:${injected.id.toString()}`,
        maxAttempts: 8,
      },
    });
    const reposted = await waitFor(async () => {
      const row = await prisma.chatterEntry.findUnique({ where: { id: injected.id } });
      return row?.chatPostedAt ? row : null; // снова обработана и отмечена
    }, 15_000, 1000);
    check('запись повторно обработана джобом', !!reposted, 'не переотмечена за 15с');
    const dupCount2 = (await sysMessages()).filter((m) => m.payload?.chatterEntryId === injected.id.toString()).length;
    check('дедуп: повторный джоб НЕ задвоил плашку', dupCount2 === 1, `count ${dupCount2}`);
  } finally {
    for (const id of cleanup.taskIds) await http('DELETE', `/tasks/${id}`, { token: t1.token }).catch(() => {});
    if (cleanup.wsId) await http('DELETE', `/workspaces/${cleanup.wsId}`, { token: t1.token }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\nRESULT ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
