/* eslint-disable */
// E2E: продюсер → `NotificationsService.send` → джоб `notifications.fanout` → строка у
// адресата (не у актора). Ретрай джоба не дублит и не накручивает счётчик (леджер
// доставки); событие ровно одно на назначение задачи. Requires API on 3001 + suite accounts.
// Run: node apps/api/scripts/verify-notify-jobs.cjs
const { SUITE, call, login, makeChecker } = require('./_lib.cjs');
const { PrismaClient } = require('@prisma/client');
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
  const { check, finish } = makeChecker();
  const prisma = new PrismaClient();
  const t1 = await login(SUITE.p1);
  const t2 = await login(SUITE.p2);
  console.log('logged in 2 suite accounts');

  const [a, b] = t1.id < t2.id ? [t1.id, t2.id] : [t2.id, t1.id];
  await prisma.contactLink.upsert({
    where: { userAId_userBId: { userAId: a, userBId: b } },
    update: {},
    create: { userAId: a, userBId: b, roleAForB: 'Коллега', roleBForA: 'Коллега', initiatedBy: t1.id },
  });

  const cleanup = { taskId: null, eventIds: [] };
  const rowsFor = (userId, taskId) =>
    prisma.notification.findMany({
      where: { userId, type: 'task.assigned', event: { refType: 'task', refId: taskId } },
    });

  try {
    console.log('\n-- 1. назначение → событие → джоб → строка у исполнителя --');
    let r = await call('POST', '/tasks', t1.token, { title: 'Notify-jobs e2e', executorId: t2.id });
    check('задача создана', r.ok, `status ${r.status}`);
    const taskId = r.json?.data?.id;
    cleanup.taskId = taskId;

    const event = await waitFor(async () =>
      prisma.notificationEvent.findFirst({ where: { type: 'task.assigned', refType: 'task', refId: taskId }, orderBy: { createdAt: 'desc' } }), 8000);
    check('событие task.assigned записано', !!event, 'не появилось за 8с');
    if (event) cleanup.eventIds.push(event.id);
    check('актор события — постановщик', event?.actorId === t1.id);

    const job = await waitFor(async () =>
      prisma.job.findFirst({ where: { type: 'notifications.fanout', payload: { path: ['eventId'], equals: event?.id ?? '' } }, orderBy: { id: 'desc' } }), 8000);
    check('джоб notifications.fanout поставлен', !!job);

    const arrived = await waitFor(async () => ((await rowsFor(t2.id, taskId)).length >= 1 ? true : null), 10_000);
    check('исполнитель получил строку (джобом)', !!arrived, 'нет строки за 10с');
    const done = await waitFor(async () => { const j = await prisma.job.findUnique({ where: { id: job.id } }); return j?.status === 'completed' ? j : null; }, 8000);
    check('джоб completed', !!done);

    console.log('\n-- 2. ровно одна строка, актор не уведомлён --');
    await sleep(1200);
    let rows = await rowsFor(t2.id, taskId);
    check('строка ровно одна', rows.length === 1, `count ${rows.length}`);
    check('актор (постановщик) себя не уведомил', (await rowsFor(t1.id, taskId)).length === 0);
    const ledger = await prisma.notificationDelivery.findFirst({ where: { eventId: event.id, recipient: `user:${t2.id}`, channel: 'inapp' } });
    check('леджер доставки inapp записан (sent)', ledger?.status === 'sent' && ledger?.notificationId === rows[0]?.id, JSON.stringify(ledger?.status));

    console.log('\n-- 3. ретрай джоба НЕ дублит и не накручивает счётчик (леджер) --');
    await prisma.job.update({ where: { id: job.id }, data: { status: 'available', runAt: new Date(), leaseUntil: null, finishedAt: null } });
    const rerun = await waitFor(async () => { const j = await prisma.job.findUnique({ where: { id: job.id } }); return j?.status === 'completed' && j.attempts >= 2 ? j : null; }, 10_000);
    check('джоб перепрогнан (attempt 2)', !!rerun);
    rows = await rowsFor(t2.id, taskId);
    check('дубля нет — строка по-прежнему одна, collapseCount=1', rows.length === 1 && rows[0].collapseCount === 1, `count ${rows.length}, collapse ${rows[0]?.collapseCount}`);

    console.log('\n-- 4. событие одно на назначение (не на каждое task.* событие) --');
    const events = await prisma.notificationEvent.count({ where: { refType: 'task', refId: taskId } });
    check('событий уведомлений по задаче — одно (только assigned)', events === 1, `count ${events}`);
  } finally {
    if (cleanup.taskId) await call('DELETE', `/tasks/${cleanup.taskId}`, t1.token).catch(() => {});
    if (cleanup.eventIds.length) await prisma.notificationEvent.deleteMany({ where: { id: { in: cleanup.eventIds } } }).catch(() => {});
    await prisma.$disconnect();
  }
  finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
