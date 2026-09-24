/* eslint-disable */
// verify-trash — корзина корневых сущностей (core/lifecycle, Э2): задачи и события календаря.
//
//   Задачи: в корзину — постановщик; задача с подзадачей скрывается у ВСЕХ (карточка, списки,
//   счётчики, календарь); корзина показывает корень с числом подзадач; подзадача одна не
//   восстанавливается; восстановление возвращает поддерево; «навсегда» — только из корзины;
//   после «навсегда» строк нет.
//   События: в корзину — организатор; участник получает «отменено» (строка жива — фанаут её
//   видит; прежде удаление стирало строку раньше проверки и отмена не доходила никому); событие
//   пропадает из диапазона и карточки; восстановление возвращает его и шлёт «изменено»;
//   «навсегда» — только из корзины.
//
// Запуск (API поднят): node scripts/verify-trash.cjs
const { PrismaClient } = require('@prisma/client');
const { SUITE, call, login, makeChecker, crash } = require('./_lib.cjs');

const { check, finish } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 15000, stepMs = 500) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(stepMs);
  }
}

async function main() {
  const prisma = new PrismaClient();
  const s1 = await login(SUITE.p1);
  const s2 = await login(SUITE.p2);
  const [a, b] = s1.id < s2.id ? [s1.id, s2.id] : [s2.id, s1.id];
  await prisma.contactLink.upsert({
    where: { userAId_userBId: { userAId: a, userBId: b } },
    update: {},
    create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: s1.id },
  });
  const cleanup = { tasks: [], events: [] };
  try {
    // ============================================================
    console.log('\n-- 1. задача с подзадачей: в корзину скрывает у всех --');
    const tag = `trash-${Date.now()}`;
    const root = await call('POST', '/tasks', s1.token, { title: `${tag} корень`, executorId: s2.id, dueDate: new Date(Date.now() + 86_400_000).toISOString() });
    check('создана задача с исполнителем', root.ok, `${root.status} ${root.code ?? ''}`);
    const rootId = root.json?.data?.id;
    cleanup.tasks.push(rootId);
    const sub = await call('POST', '/tasks', s1.token, { title: `${tag} подзадача`, parentId: rootId });
    check('создана подзадача', sub.ok, `${sub.status} ${sub.code ?? ''}`);
    const subId = sub.json?.data?.id;
    const statsBefore = (await call('GET', '/tasks/stats', s2.token)).json?.data;

    let r = await call('POST', `/tasks/${rootId}/trash`, s2.token, {});
    check('исполнитель не может отправить задачу в корзину (403)', r.status === 403, `${r.status} ${r.code ?? ''}`);
    r = await call('POST', `/tasks/${rootId}/trash`, s1.token, {});
    check('постановщик отправил задачу в корзину', r.ok, `${r.status} ${r.code ?? ''}`);
    r = await call('POST', `/tasks/${rootId}/trash`, s1.token, {});
    check('повтор «в корзину» безвреден', r.ok, `${r.status}`);

    r = await call('GET', `/tasks/${rootId}`, s1.token);
    check('карточка задачи в корзине — 404 постановщику', r.status === 404, `${r.status}`);
    r = await call('GET', `/tasks/${rootId}`, s2.token);
    check('карточка задачи в корзине — 404 исполнителю', r.status === 404, `${r.status}`);
    r = await call('GET', `/tasks/${subId}`, s1.token);
    check('подзадача ушла в корзину вместе с корнем', r.status === 404, `${r.status}`);
    const listed = (await call('GET', `/tasks?search=${encodeURIComponent(tag)}&limit=50`, s1.token)).json?.data?.items ?? [];
    check('списки задачу не показывают', !listed.some((t) => t.id === rootId), listed.map((t) => t.id).join(','));
    const statsAfter = (await call('GET', '/tasks/stats', s2.token)).json?.data;
    check('счётчики исполнителя уменьшились', statsBefore && statsAfter && statsAfter.assignedToMe === statsBefore.assignedToMe - 1, `${statsBefore?.assignedToMe} → ${statsAfter?.assignedToMe}`);
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const cal = (await call('GET', `/calendar/events?from=${from}&to=${to}`, s2.token)).json?.data;
    check('слой задач календаря задачу не показывает', !JSON.stringify(cal ?? {}).includes(rootId));

    r = await call('GET', '/tasks/trash', s1.token);
    const item = r.json?.data?.find?.((t) => t.id === rootId);
    check('корзина постановщика: корень с одной подзадачей и датой окончательного удаления', !!item && item.subtasksCount === 1 && !!item.purgeAt, JSON.stringify(item ?? null));
    check('подзадача отдельной строкой в корзине не показывается', !(r.json?.data ?? []).some((t) => t.id === subId));
    r = await call('GET', '/tasks/trash', s2.token);
    check('в корзине исполнителя чужой задачи нет', !(r.json?.data ?? []).some((t) => t.id === rootId));

    // ============================================================
    console.log('\n-- 2. восстановление и «навсегда» --');
    r = await call('POST', `/tasks/${subId}/restore`, s1.token, {});
    check('подзадачу при корне в корзине отдельно не вернуть (400)', r.status === 400 && r.code === 'task.restoreParentFirst', `${r.status} ${r.code}`);
    r = await call('POST', `/tasks/${rootId}/restore`, s1.token, {});
    check('корень восстановлен', r.ok && r.json?.data?.id === rootId, `${r.status} ${r.code ?? ''}`);
    r = await call('GET', `/tasks/${subId}`, s1.token);
    check('подзадача вернулась вместе с корнем', r.ok, `${r.status}`);
    r = await call('GET', `/tasks/${rootId}`, s2.token);
    check('исполнитель снова видит задачу', r.ok, `${r.status}`);
    r = await call('DELETE', `/tasks/${rootId}`, s1.token);
    check('«навсегда» живой задачи — отказ (сначала в корзину)', r.status === 400 && r.code === 'task.trashFirst', `${r.status} ${r.code}`);
    await call('POST', `/tasks/${rootId}/trash`, s1.token, {});
    r = await call('DELETE', `/tasks/${rootId}`, s1.token);
    check('«навсегда» из корзины прошло', r.ok, `${r.status} ${r.code ?? ''}`);
    const rows = await prisma.task.count({ where: { id: { in: [rootId, subId] } } });
    check('строк задачи и подзадачи больше нет', rows === 0, `rows=${rows}`);
    cleanup.tasks = cleanup.tasks.filter((id) => id !== rootId);

    // ============================================================
    console.log('\n-- 3. событие с участником: отмена доходит, восстановление возвращает --');
    const start = new Date(Date.now() + 2 * 3_600_000);
    const ev = await call('POST', '/calendar/events', s1.token, {
      title: `${tag} встреча`,
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 3_600_000).toISOString(),
    });
    check('событие создано', ev.ok, `${ev.status} ${ev.code ?? ''}`);
    const evId = ev.json?.data?.id;
    cleanup.events.push(evId);
    r = await call('POST', `/calendar/events/${evId}/participants`, s1.token, { userIds: [s2.id] });
    check('участник приглашён', r.ok, `${r.status} ${r.code ?? ''}`);

    r = await call('POST', `/calendar/events/${evId}/trash`, s2.token, {});
    check('участник не может отправить событие в корзину', r.status === 403 || r.status === 404, `${r.status}`);
    r = await call('POST', `/calendar/events/${evId}/trash`, s1.token, {});
    check('организатор отправил событие в корзину', r.ok, `${r.status} ${r.code ?? ''}`);
    r = await call('GET', `/calendar/events/${evId}`, s2.token);
    check('карточка события в корзине — 404 участнику', r.status === 404, `${r.status}`);
    const range = (await call('GET', `/calendar/events?from=${from}&to=${to}`, s2.token)).json?.data;
    check('диапазон участника событие не показывает', !JSON.stringify(range ?? {}).includes(evId));
    const cancelled = await waitFor(async () => {
      const feed = (await call('GET', '/notifications?limit=50', s2.token)).json?.data?.items ?? [];
      return feed.find((n) => n.type === 'calendar.event.cancelled' && JSON.stringify(n).includes(evId)) ?? null;
    });
    check('участник получил «отменено» (строка жива — фанаут видит право)', !!cancelled);
    const reminders = await prisma.calendarEventReminder.count({ where: { eventId: evId, sentAt: null } });
    check('напоминания события в корзине сняты', reminders === 0, `rows=${reminders}`);

    r = await call('GET', '/calendar/trash', s1.token);
    check('корзина организатора показывает событие', (r.json?.data ?? []).some((e) => e.id === evId));
    r = await call('POST', `/calendar/events/${evId}/restore`, s1.token, {});
    check('событие восстановлено (в ответе — карточка)', r.ok && r.json?.data?.id === evId, `${r.status} ${r.code ?? ''}`);
    r = await call('GET', `/calendar/events/${evId}`, s2.token);
    check('участник снова видит событие', r.ok, `${r.status}`);
    r = await call('DELETE', `/calendar/events/${evId}`, s1.token);
    check('«навсегда» живого события — отказ (сначала в корзину)', r.status === 400 && r.code === 'calendar.trashFirst', `${r.status} ${r.code}`);
    await call('POST', `/calendar/events/${evId}/trash`, s1.token, {});
    r = await call('DELETE', `/calendar/events/${evId}`, s1.token);
    check('«навсегда» из корзины прошло', r.ok, `${r.status} ${r.code ?? ''}`);
    check('строки события больше нет', (await prisma.calendarEvent.count({ where: { id: evId } })) === 0);
    cleanup.events = cleanup.events.filter((id) => id !== evId);
  } finally {
    for (const id of cleanup.tasks) await call('POST', `/tasks/${id}/trash`, s1.token, {}).then(() => call('DELETE', `/tasks/${id}`, s1.token)).catch(() => {});
    for (const id of cleanup.events) await call('POST', `/calendar/events/${id}/trash`, s1.token, {}).then(() => call('DELETE', `/calendar/events/${id}`, s1.token)).catch(() => {});
    await prisma.$disconnect().catch(() => undefined);
  }
  await finish();
}

main().catch(crash);
