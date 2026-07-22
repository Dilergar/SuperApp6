/* eslint-disable */
// E2E: Волна 1 движка джобов — создание уведомлений через джоб notifications.dispatch
// (замена шинного NotificationsEventsListener). Уведомление доезжает джобом; ровно одна
// строка (дубля листенера нет); ретрай джоба не дублит (dedupKey ON CONFLICT); актор
// не уведомляется о своём действии. Requires API on 3001 + testers.
// Run: node apps/api/scripts/verify-notify-jobs.cjs
const BASE = process.env.API_URL || 'http://localhost:3001/api';
const CREDS = {
  t1: { phone: '+77001234567', password: 'Test1234!' },
  t2: { phone: '+77012345678', password: 'Test1234!' },
};
async function http(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  return { token, id: me.json.data.id };
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
  const fs = require('fs'); const path = require('path');
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  const t1 = await login(CREDS.t1);
  const t2 = await login(CREDS.t2);
  console.log('logged in 2 testers');

  // Детерминированная связь t1↔t2 (назначение задачи требует окружения).
  const [a, b] = t1.id < t2.id ? [t1.id, t2.id] : [t2.id, t1.id];
  await prisma.contactLink.upsert({
    where: { userAId_userBId: { userAId: a, userBId: b } },
    update: {},
    create: { userAId: a, userBId: b, roleAForB: 'Коллега', roleBForA: 'Коллега', initiatedBy: t1.id },
  });

  const cleanup = { taskId: null, jobIds: [] };
  const notifCountFor = async (userId, taskId) =>
    prisma.notification.count({
      where: { userId, type: 'task.assigned', payload: { path: ['taskId'], equals: taskId } },
    });

  try {
    // ============================================================
    console.log('\n-- 1. событие → джоб → уведомление (task.assigned исполнителю) --');
    let r = await http('POST', '/tasks', {
      token: t1.token,
      body: { title: 'Notify-jobs e2e', executorId: t2.id },
    });
    check('задача создана', r.ok, `status ${r.status}`);
    const taskId = r.json?.data?.id;
    cleanup.taskId = taskId;

    const job = await waitFor(async () =>
      prisma.job.findFirst({
        where: { type: 'notifications.dispatch', payload: { path: ['data', 'taskId'], equals: taskId } },
        orderBy: { id: 'desc' },
      }), 8000);
    check('джоб notifications.dispatch поставлен', !!job, 'не появился за 8с');
    if (job) cleanup.jobIds.push(job.id);
    check('payload джоба несёт событие', job?.payload?.event === 'task.assigned', JSON.stringify(job?.payload?.event));

    const arrived = await waitFor(async () => (await notifCountFor(t2.id, taskId)) >= 1 ? true : null, 10_000);
    check('исполнитель получил уведомление (джобом)', !!arrived, 'нет строки за 10с');
    const jobDone = await waitFor(async () => {
      const j = await prisma.job.findUnique({ where: { id: job.id } });
      return j?.status === 'completed' ? j : null;
    }, 8000);
    check('джоб completed', !!jobDone, 'не completed за 8с');

    console.log('\n-- 2. ровно одна строка (дубля от старого листенера нет) --');
    await sleep(1500); // дать гипотетическому дублю шанс появиться
    let cnt = await notifCountFor(t2.id, taskId);
    check('строка ровно одна', cnt === 1, `count ${cnt}`);
    check('актор (постановщик) себя не уведомил', (await notifCountFor(t1.id, taskId)) === 0);

    // dedupKey проставлен по схеме j<jobId>:<userId>:<type>
    const row = await prisma.notification.findFirst({
      where: { userId: t2.id, type: 'task.assigned', payload: { path: ['taskId'], equals: taskId } },
    });
    check('dedupKey записан', row?.dedupKey === `j${job.id}:${t2.id}:task.assigned`, row?.dedupKey ?? 'null');

    // ============================================================
    console.log('\n-- 3. ретрай джоба НЕ дублит (dedupKey ON CONFLICT) --');
    // Возвращаем ГОТОВЫЙ джоб в очередь (симуляция ретрая после частичного фанаута) —
    // обработчик снова создаст все цели, dedupKey погасит существующие.
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'available', runAt: new Date(), leaseUntil: null, finishedAt: null },
    });
    const rerun = await waitFor(async () => {
      const j = await prisma.job.findUnique({ where: { id: job.id } });
      return j?.status === 'completed' && j.attempts >= 2 ? j : null;
    }, 10_000);
    check('джоб перепрогнан (attempt 2)', !!rerun, 'не перепрогнался за 10с');
    cnt = await notifCountFor(t2.id, taskId);
    check('дубля нет — строка по-прежнему одна', cnt === 1, `count ${cnt}`);

    // ============================================================
    console.log('\n-- 4. немаппленное событие джоб не ставит (emitEvent-гейт) --');
    // task.created не в карте: после создания задачи джоб был только по task.assigned.
    const extraJobs = await prisma.job.count({
      where: { type: 'notifications.dispatch', payload: { path: ['data', 'taskId'], equals: taskId } },
    });
    check('джоб один (только по assigned)', extraJobs === 1, `count ${extraJobs}`);
  } finally {
    if (cleanup.taskId) {
      await http('DELETE', `/tasks/${cleanup.taskId}`, { token: t1.token }).catch(() => {});
      await prisma.notification.deleteMany({
        where: { type: 'task.assigned', payload: { path: ['taskId'], equals: cleanup.taskId } },
      }).catch(() => {});
    }
    if (cleanup.jobIds.length) {
      await prisma.job.deleteMany({ where: { id: { in: cleanup.jobIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(`\nRESULT ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
