/* eslint-disable */
// E2E: core/jobs (10-й движок) — transactional outbox + at-least-once исполнение.
// Транзакционность (rollback → джоба нет), ретраи с бэкоффом, dead-letter, JobDiscard,
// uniqueKey-дедуп + отмена, reaper протухшей аренды + клейм-токен (зомби-врайт = no-op),
// отложенный runAt, /jobs/stats. Requires API on 3001 (NODE_ENV=development) + tester1.
// Run: node apps/api/scripts/verify-jobs.cjs
const BASE = process.env.API_URL || 'http://localhost:3001/api';
const CREDS = { t1: { phone: '+77001234567', password: 'Test1234!' } };
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
  return { token: json.data.accessToken };
}
let passed = 0, failed = 0;
const check = (n, c, extra) => {
  if (c) { passed++; console.log(`  PASS ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${extra ? `  (${extra})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, intervalMs = 300) {
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
  console.log('logged in tester1');
  const K = (s) => `vjobs:${s}:${Date.now()}`;
  const byKey = async (uniqueKey) =>
    (await http('GET', `/jobs/dev/by-key?uniqueKey=${encodeURIComponent(uniqueKey)}`, { token: t1.token })).json?.data ?? null;
  const enq = (body) => http('POST', '/jobs/dev/enqueue', { token: t1.token, body });

  await prisma.job.deleteMany({ where: { type: 'jobs.dev.echo' } }); // чистый полигон

  try {
    // ============================================================
    console.log('\n-- 1. transactional outbox: откат транзакции = джоба нет --');
    const k1 = K('rollback');
    let r = await enq({ uniqueKey: k1, rollback: true });
    check('enqueue+rollback ok', r.ok, `status ${r.status}`);
    await sleep(1500);
    check('джоб НЕ существует после отката', (await byKey(k1)) === null);

    // ============================================================
    console.log('\n-- 2. happy path: коммит → джоб выполнен --');
    const k2 = K('happy');
    r = await enq({ uniqueKey: k2 });
    check('enqueue ok', r.ok, `status ${r.status}`);
    const done2 = await waitFor(async () => {
      const j = await byKey(k2);
      return j?.status === 'completed' ? j : null;
    }, 8000);
    check('джоб completed (нудж+поллер ≤8с)', !!done2, `got ${(await byKey(k2))?.status}`);
    check('одна попытка', done2?.attempts === 1, `attempts ${done2?.attempts}`);

    // ============================================================
    console.log('\n-- 3. ретраи с бэкоффом: 2 фейла → успех с 3-й попытки --');
    const k3 = K('retry');
    await enq({ uniqueKey: k3, failTimes: 2 });
    const done3 = await waitFor(async () => {
      const j = await byKey(k3);
      return j?.status === 'completed' ? j : null;
    }, 20_000, 500);
    check('джоб completed после ретраев', !!done3, `got ${(await byKey(k3))?.status}`);
    check('3 попытки', done3?.attempts === 3, `attempts ${done3?.attempts}`);
    check('lastError хранит последний фейл', (done3?.lastError ?? '').includes('dev fail'), done3?.lastError ?? 'null');

    // ============================================================
    console.log('\n-- 4. dead-letter: фейлит всегда → discarded после maxAttempts --');
    const k4 = K('dead');
    r = await enq({ uniqueKey: k4, failTimes: 10 }); // 10 > maxAttempts(3) дев-типа → dead-letter
    check('enqueue ok', r.ok, `status ${r.status}`);
    const dead4 = await waitFor(async () => {
      const j = await byKey(k4);
      return j?.status === 'discarded' ? j : null;
    }, 20_000, 500);
    check('джоб discarded', !!dead4, `got ${(await byKey(k4))?.status}`);
    check('попытки исчерпаны (3 у дев-типа)', dead4?.attempts === 3, `attempts ${dead4?.attempts}`);

    // ============================================================
    console.log('\n-- 5. JobDiscardError: постоянная ошибка → discarded сразу, без ретраев --');
    const k5 = K('discard');
    await enq({ uniqueKey: k5, discard: true });
    const dead5 = await waitFor(async () => {
      const j = await byKey(k5);
      return j?.status === 'discarded' ? j : null;
    }, 8000);
    check('джоб discarded сразу', !!dead5, `got ${(await byKey(k5))?.status}`);
    check('одна попытка (без ретраев)', dead5?.attempts === 1, `attempts ${dead5?.attempts}`);

    // ============================================================
    console.log('\n-- 6. uniqueKey: повторная постановка = тихий no-op (живой джоб один) --');
    const k6 = K('unique');
    await enq({ uniqueKey: k6, runInSec: 3600 });
    r = await enq({ uniqueKey: k6, runInSec: 3600 });
    check('повторный enqueue не падает (ON CONFLICT DO NOTHING)', r.ok, `status ${r.status}`);
    let cnt = await prisma.job.count({ where: { type: 'jobs.dev.echo', uniqueKey: k6 } });
    check('строка одна', cnt === 1, `count ${cnt}`);

    console.log('\n-- 7. cancelByUniqueKey + повторная постановка после терминала --');
    r = await http('POST', '/jobs/dev/cancel', { token: t1.token, body: { uniqueKey: k6 } });
    check('cancel ok (1 отменён)', r.ok && r.json?.data?.cancelled === 1, JSON.stringify(r.json?.data));
    check('статус cancelled', (await byKey(k6))?.status === 'cancelled');
    r = await enq({ uniqueKey: k6, runInSec: 3600 });
    cnt = await prisma.job.count({ where: { type: 'jobs.dev.echo', uniqueKey: k6 } });
    check('терминальный ключ не мешает новой постановке', r.ok && cnt === 2, `count ${cnt}`);
    await http('POST', '/jobs/dev/cancel', { token: t1.token, body: { uniqueKey: k6 } });

    // ============================================================
    console.log('\n-- 8. reaper протухшей аренды + клейм-токен (зомби-врайт = no-op) --');
    const k7 = K('reaper');
    await enq({ uniqueKey: k7, sleepMs: 5000 });
    const executing = await waitFor(async () => {
      const j = await byKey(k7);
      return j?.status === 'executing' ? j : null;
    }, 8000);
    check('джоб взят в исполнение', !!executing, `got ${(await byKey(k7))?.status}`);
    r = await http('POST', '/jobs/dev/expire-lease', { token: t1.token, body: { uniqueKey: k7 } });
    check('аренда протушена', r.json?.data?.expired === 1, JSON.stringify(r.json?.data));
    const reapAt = Date.now();
    await http('POST', '/jobs/dev/reap', { token: t1.token });
    let j7 = await byKey(k7);
    check('reaper вернул джоб в очередь (available, попытка учтена)', j7?.status === 'available' && j7?.attempts === 1,
      `status ${j7?.status}, attempts ${j7?.attempts}`);
    // Бэкофф reaper считает по базе ТИПА (у дев-типа она намеренно мала — 500мс, чтобы
    // verify не ждал минутами), поэтому сравниваем с моментом реапа, а не с «сейчас»:
    // к моменту чтения короткая пауза уже могла истечь.
    check('бэкофф назначен (runAt сдвинут вперёд от момента реапа)',
      new Date(j7?.runAt ?? 0).getTime() >= reapAt, j7?.runAt);
    // Отодвигаем повтор, чтобы вторая попытка не стартовала, пока мы ждём зомби:
    // проверяем именно клейм-токен, а не гонку с ретраем.
    await prisma.job.updateMany({
      where: { type: 'jobs.dev.echo', uniqueKey: k7 },
      data: { runAt: new Date(Date.now() + 60_000) },
    });
    // Спящий «зомби»-заход (5с) сейчас завершится и попробует complete с ПРОШЛЫМ
    // номером попытки: клейм-токен (attempts в WHERE) обязан превратить его в no-op.
    // Признак того, что зомби ПРОШЁЛ бы, — ровно completed при attempts === 1.
    await sleep(6500);
    j7 = await byKey(k7);
    check('зомби-врайт не прошёл (джоб не завершён прошлой попыткой)',
      !(j7?.status === 'completed' && j7?.attempts === 1), `got ${j7?.status}/${j7?.attempts}`);
    // Ускоряем ретрай: runAt → сейчас; вторая попытка отрабатывает штатно.
    await prisma.job.updateMany({
      where: { type: 'jobs.dev.echo', uniqueKey: k7 },
      data: { runAt: new Date() },
    });
    const done7 = await waitFor(async () => {
      const j = await byKey(k7);
      return j?.status === 'completed' ? j : null;
    }, 15_000, 500);
    check('вторая попытка добила джоб', !!done7 && done7.attempts === 2,
      `status ${done7?.status}, attempts ${done7?.attempts}`);

    // ============================================================
    console.log('\n-- 9. отложенный runAt: невидим до срока, выполняется после --');
    const k8 = K('delayed');
    const t0 = Date.now();
    await enq({ uniqueKey: k8, runInSec: 3 });
    await sleep(800);
    const early = await byKey(k8);
    check('до срока джоб available (не executing)', early?.status === 'available', `got ${early?.status}`);
    const done8 = await waitFor(async () => {
      const j = await byKey(k8);
      return j?.status === 'completed' ? j : null;
    }, 12_000, 400);
    check('выполнен после срока', !!done8, `got ${(await byKey(k8))?.status}`);
    check('не раньше срока (≥2.5с от постановки)', !!done8 && Date.now() - t0 >= 2500);

    // ============================================================
    console.log('\n-- 10. /jobs/stats (dev-наблюдаемость) --');
    r = await http('GET', '/jobs/stats', { token: t1.token });
    check('stats ok', r.ok, `status ${r.status}`);
    const counts = r.json?.data?.counts ?? [];
    check('счётчики по типу/статусу есть', counts.some((c) => c.type === 'jobs.dev.echo' && c.count > 0));
    check('recentDiscarded непуст (после секций 4–5)', (r.json?.data?.recentDiscarded ?? []).length >= 2);

    // Джоб типа без обработчика бессмертен (claim идёт по реестру, ретеншн — только
    // терминальные). Движок обязан его ВИДЕТЬ, не пускать в прибор «очередь встала»
    // и давать похоронить осознанно — но не убивать сам (чаще это выключенная фича).
    console.log('\n-- 11. тип без обработчика: виден, не портит прибор, чистится осознанно --');
    const ghostType = 'jobs.dev.ghost';
    await prisma.job.deleteMany({ where: { type: ghostType } });
    const ghostAge = new Date(Date.now() - 72 * 3600 * 1000); // «висит трое суток»
    await prisma.job.create({
      data: { type: ghostType, queue: 'default', status: 'available', runAt: ghostAge, createdAt: ghostAge, updatedAt: ghostAge },
    });
    await sleep(1500); // поллер обязан его ПРОИГНОРИРОВАТЬ, а не взять в работу
    let ghost = await prisma.job.findFirst({ where: { type: ghostType } });
    check('бесхозный джоб не взят в работу', ghost?.status === 'available' && ghost?.attempts === 0, `${ghost?.status}/${ghost?.attempts}`);

    r = await http('GET', '/jobs/stats', { token: t1.token });
    const unhandled = r.json?.data?.unhandled ?? [];
    const ghostRow = unhandled.find((u) => u.type === ghostType);
    check('бесхозный тип назван в stats.unhandled', !!ghostRow && ghostRow.count === 1, JSON.stringify(unhandled));
    check('его возраст показан (~72ч)', !!ghostRow && ghostRow.oldestAgeSec > 71 * 3600);
    const oldestSec = r.json?.data?.oldestAvailableAgeSec;
    check(
      'прибор «очередь встала» им НЕ отравлен',
      oldestSec === null || oldestSec < 71 * 3600,
      `oldestAvailableAgeSec=${oldestSec}`,
    );

    r = await http('POST', '/jobs/dev/purge-unhandled', { token: t1.token, body: { type: 'jobs.dev.echo' } });
    check('чистка ЗАРЕГИСТРИРОВАННОГО типа запрещена', !r.ok, `status ${r.status}`);

    r = await http('POST', '/jobs/dev/purge-unhandled', { token: t1.token, body: { type: ghostType } });
    check('осознанная чистка бесхозного типа прошла', r.ok && r.json?.data?.purged === 1, JSON.stringify(r.json));
    ghost = await prisma.job.findFirst({ where: { type: ghostType } });
    check('строка похоронена как cancelled + finishedAt (заберёт ретеншн)', ghost?.status === 'cancelled' && !!ghost?.finishedAt, ghost?.status);

    r = await http('GET', '/jobs/stats', { token: t1.token });
    check('после чистки тип ушёл из unhandled', !(r.json?.data?.unhandled ?? []).some((u) => u.type === ghostType));
  } finally {
    await prisma.job.deleteMany({ where: { type: { in: ['jobs.dev.echo', 'jobs.dev.ghost'] } } });
    await prisma.$disconnect();
  }

  console.log(`\nRESULT ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
