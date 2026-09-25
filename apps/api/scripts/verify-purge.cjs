/* eslint-disable */
// verify-purge — движок сроков core/lifecycle (Э3): раннер purge, каскад организации по реестру,
// loose FK, уборка временного каталога.
//
// Проверяет на ЖИВОЙ базе dev-стенда (API поднят):
//   - план: что раннер ведёт, порядок каскада организации (строка организации — последней,
//     владельцы ссылок на файлы — раньше файлов), триггер учёта на каждом родителе loose FK;
//   - общая пачка: dry-run только считает; прогон удаляет старше срока; заморозка пространства
//     держит строки (NOT EXISTS в самом DELETE); снятая — отпускает; прогон доказан журналом;
//   - здоровье: каждый сигнал (реплики, архив WAL, VACUUM, темп WAL, ожидания блокировок, цикл
//     событий) останавливает пачки, прогон закрывается, строки целы; в норме — удаляет;
//   - гонка: заморозка, поставленная ВО ВРЕМЯ прогона, держит строку (пачка ждёт её коммита);
//   - кэп радиуса: к удалению разом больше порога организаций — ретеншн архива стоит;
//   - loose FK: сырой DELETE задачи → учёт → воркер убирает её хронику и права;
//   - каскад организации: чат задачи знает организацию; предпросмотр без пропусков; заморозка
//     организации — 409 и строка на месте; после снятия — каскад проходит все шаги плана;
//   - шаг модуля через раннер (корзина задач), временный каталог, очередь и окно, метрики;
//   - команда Кабинета lifecycle.workspace.purge: critical + «четыре глаза», своя организация —
//     отказ, предпросмотр ничего не ставит (строка прогона откатывается), исполнение — каскад джобом.
// Посаженные строки — свои (метки сьюта), заморозки снимаются, организации прогона уходят.
//
// Запуск: node scripts/verify-purge.cjs
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LIFECYCLE_LIMITS, LIFECYCLE_PURGE_WINDOW } = require('@superapp/shared');
const { BASE, SUITE, login, call, makeChecker, crash, createSuiteWorkspace, consoleLogin, consoleSudo } = require('./_lib.cjs');

const { check, finish } = makeChecker();
const DAY = 864e5;
const HOLD_LOCK = 0x4c465948;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd4 = () => String(Math.floor(Math.random() * 1e4)).padStart(4, '0');

/** Час по Алматы — окно массового ретеншна. */
function inWindow(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: LIFECYCLE_PURGE_WINDOW.timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now)) % 24;
  return hour >= LIFECYCLE_PURGE_WINDOW.startHour && hour < LIFECYCLE_PURGE_WINDOW.endHour;
}

async function main() {
  const prisma = new PrismaClient();
  const { token: t1, id: u1 } = await login(SUITE.p1);
  const run = (policyId, extra = {}) => call('POST', '/lifecycle/dev/purge/run', t1, { policyId, ...extra });
  const holds = [];
  const hold = async (workspaceId) => {
    const h = await prisma.lifecycleHold.create({ data: { scope: 'space', workspaceId, spaceType: 'workspace', spaceId: workspaceId, reasonCode: 'suite', createdById: u1 } });
    holds.push(h.id);
    return h;
  };
  const release = (id) => prisma.lifecycleHold.update({ where: { id }, data: { releasedAt: new Date(), releasedById: u1 } });
  const oldDate = new Date(Date.now() - 400 * DAY);
  const guest = (ownerType, ownerId) =>
    prisma.shareLinkGuest.create({ data: { ownerType, ownerId, phone: `+7700977${rnd4()}`, name: 'Сьют purge', firstVerifiedAt: oldDate, lastVerifiedAt: oldDate } });
  const alive = async (ids) => prisma.shareLinkGuest.count({ where: { id: { in: ids } } });

  try {
    // ============================================================
    console.log('\n-- 1. план раннера и каскада --');
    let r = await call('GET', '/lifecycle/dev/plan', t1);
    check('план отвечает', r.ok, `${r.status}`);
    const plan = r.json?.data ?? {};
    const enforced = new Map((plan.enforced ?? []).map((p) => [p.id, p.mode]));
    check('раннер ведёт общие политики (ShareLinkGuest, CalendarEventReminder, ChatterEntry)', enforced.get('ShareLinkGuest') === 'generic' && enforced.get('CalendarEventReminder') === 'generic' && enforced.get('ChatterEntry') === 'generic');
    check('и шаги модулей (корзины, файлы, джобы, ретеншн архива)', ['Task', 'CalendarEvent', 'VoiceRecording', 'Note', 'DriveNode', 'FileObject', 'Job', 'Workspace'].every((id) => enforced.get(id) === 'handler'));
    const steps = (plan.tenantPlan ?? []).map((s) => s.key);
    check('каскад организации: строка организации — последний шаг', steps[steps.length - 1] === 'workspaces.row', steps.slice(-2).join(','));
    check('владельцы ссылок на файлы (Диск, Заметки, Мессенджер, Задачи) — раньше файлов', ['drive.workspace', 'notes.workspace', 'messenger.workspace-chats', 'tasks.workspace'].every((k) => steps.indexOf(k) >= 0 && steps.indexOf(k) < steps.indexOf('files.owned')));
    const tracked = plan.looseFkTables ?? [];
    const trig = await prisma.$queryRaw`SELECT c.relname::text AS t FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid WHERE tg.tgname = 'lifecycle_track_delete' AND tg.tgenabled = 'A'`;
    const trigSet = new Set(trig.map((x) => x.t));
    check('триггер учёта (ENABLE ALWAYS) стоит на каждом родителе воркера loose FK', tracked.length >= 8 && tracked.every((t) => trigSet.has(t)), tracked.filter((t) => !trigSet.has(t)).join(',') || `${tracked.length} таблиц`);

    // ============================================================
    console.log('\n-- 2. общая пачка: dry-run, прогон, заморозка --');
    const W = crypto.randomUUID();
    const userGuests = [(await guest('user', u1)).id, (await guest('user', u1)).id];
    const heldGuests = [(await guest('workspace', W)).id, (await guest('workspace', W)).id];
    r = await run('ShareLinkGuest', { dryRun: true });
    const dry = r.json?.data ?? {};
    check('dry-run: только счёт — ожидание ≥ посаженных, удалено 0', r.ok && dry.status === 'done' && dry.expectedRows >= 4 && dry.rows === 0, `${dry.status} expected=${dry.expectedRows} rows=${dry.rows}`);
    check('dry-run: строки на месте', (await alive([...userGuests, ...heldGuests])) === 4);
    const h1 = await hold(W);
    const startedAt = new Date();
    r = await run('ShareLinkGuest');
    const res = r.json?.data ?? {};
    check('прогон завершён (status done)', r.ok && res.status === 'done' && res.outcome === 'done', `${res.status}/${res.outcome}`);
    check('строки старше срока удалены', (await alive(userGuests)) === 0);
    check('заморозка пространства организации держит её строки (NOT EXISTS в самом DELETE)', (await alive(heldGuests)) === 2);
    const proof = await prisma.securityEvent.findFirst({ where: { eventKey: 'lifecycle.purge.run', targetId: 'ShareLinkGuest', occurredAt: { gte: new Date(startedAt.getTime() - 5000) } } });
    check('прогон доказан журналом безопасности (lifecycle.purge.run)', !!proof);
    await release(h1.id);
    r = await run('ShareLinkGuest');
    check('снятая заморозка — строки уходят следующим прогоном', r.ok && (await alive(heldGuests)) === 0);

    // ============================================================
    console.log('\n-- 3. здоровье БД останавливает пачки --');
    const signals = [
      [{ replicationLagSec: 99 }, 'replication_lag'],
      [{ archiverFailing: true }, 'archiver_failing'],
      [{ vacuumRunning: true }, 'vacuum_running'],
      [{ walBytesPerSec: 1e12 }, 'wal_rate'],
      [{ lockWaiters: 9999 }, 'lock_waiters'],
      [{ eventLoopP99Ms: 99999 }, 'event_loop'],
    ];
    const probe = (await guest('user', u1)).id;
    for (const [signal, reason] of signals) {
      await call('POST', '/lifecycle/dev/health', t1, signal);
      r = await run('ShareLinkGuest');
      const d = r.json?.data ?? {};
      check(`${reason}: пачки ждут — ни строки не удалено, прогон закрыт`, r.ok && d.healthReason === reason && d.rows === 0 && d.status === 'stopped' && (await alive([probe])) === 1, `${d.healthReason} rows=${d.rows} ${d.status}`);
    }
    await call('POST', '/lifecycle/dev/health', t1, {});
    r = await run('ShareLinkGuest');
    check('здоровье в норме — прогон удаляет', r.ok && (await alive([probe])) === 0);

    // ============================================================
    console.log('\n-- 4. гонка: заморозка во время прогона --');
    const W2 = crypto.randomUUID();
    const raced = (await guest('workspace', W2)).id;
    let h2Id = null;
    const holdTx = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HOLD_LOCK})`;
        const h = await tx.lifecycleHold.create({ data: { scope: 'space', workspaceId: W2, spaceType: 'workspace', spaceId: W2, reasonCode: 'suite', createdById: u1 } });
        h2Id = h.id;
        await sleep(1500);
      },
      { timeout: 15_000 },
    );
    await sleep(200);
    const t0 = Date.now();
    const runP = run('ShareLinkGuest');
    await holdTx;
    holds.push(h2Id);
    r = await runP;
    check('пачка ждала коммита постановки заморозки (общий замок против исключительного)', Date.now() - t0 >= 1000, `${Date.now() - t0} мс`);
    check('заморозка, поставленная во время прогона, удержала строку', r.ok && (await alive([raced])) === 1);
    await release(h2Id);
    await run('ShareLinkGuest');
    check('после снятия строка уходит', (await alive([raced])) === 0);

    // ============================================================
    console.log('\n-- 5. кэп радиуса: ретеншн архива --');
    const planted = Array.from({ length: LIFECYCLE_LIMITS.tenantPurgeHaltAbove + 1 }, () => crypto.randomUUID());
    const archivedLongAgo = new Date(Date.now() - 400 * DAY);
    await prisma.workspace.createMany({ data: planted.map((id) => ({ id, name: `Сьют-Purge-кэп ${id.slice(-6)}`, ownerId: u1, isActive: false, archivedAt: archivedLongAgo })) });
    try {
      r = await run('Workspace');
      const d = r.json?.data ?? {};
      check('к удалению разом больше порога — прогон остановлен (blast_radius)', r.ok && d.status === 'stopped' && d.stoppedReason === 'blast_radius', `${d.status}/${d.stoppedReason}`);
      const queued = await prisma.lifecycleRun.count({ where: { kind: 'tenant_purge', subjectId: { in: planted } } });
      check('ни одного каскада не поставлено', queued === 0, `${queued}`);
    } finally {
      await prisma.workspace.deleteMany({ where: { id: { in: planted }, ownerId: u1, isActive: false } });
    }

    // ============================================================
    console.log('\n-- 6. loose FK: сырой DELETE родителя --');
    const task = await call('POST', '/tasks', t1, { title: 'Сьют loose FK' });
    const taskId = task.json?.data?.id;
    await call('PATCH', `/tasks/${taskId}`, t1, { title: 'Сьют loose FK — правка' });
    const chatterBefore = await prisma.chatterEntry.count({ where: { refType: 'task', refId: taskId } });
    const tuplesBefore = await prisma.relationTuple.count({ where: { resourceType: 'task', resourceId: taskId } });
    check('у задачи есть хроника и права', !!taskId && chatterBefore > 0 && tuplesBefore > 0, `chatter=${chatterBefore} tuples=${tuplesBefore}`);
    await prisma.task.delete({ where: { id: taskId } });
    const trackedRow = await prisma.lifecycleDeletedRow.findFirst({ where: { tableName: 'tasks', rowId: taskId } });
    check('триггер записал удалённую строку в учёт', !!trackedRow && !trackedRow.processedAt);
    r = await call('POST', '/lifecycle/dev/loose-fk/run', t1);
    check('воркер отработал', r.ok, JSON.stringify(r.json?.data ?? r.json).slice(0, 160));
    check('хроника удалённой задачи убрана', (await prisma.chatterEntry.count({ where: { refType: 'task', refId: taskId } })) === 0);
    check('права удалённой задачи сняты', (await prisma.relationTuple.count({ where: { resourceType: 'task', resourceId: taskId } })) === 0);
    const processed = await prisma.lifecycleDeletedRow.findFirst({ where: { tableName: 'tasks', rowId: taskId } });
    check('строка учёта помечена обработанной', !!processed?.processedAt);

    // ============================================================
    console.log('\n-- 7. каскад организации по реестру --');
    const ws = await createSuiteWorkspace(t1, 'Сьют-Purge');
    const wsId = ws.json?.data?.id;
    check('организация прогона создана', !!wsId, `${ws.status} ${ws.code ?? ''}`);
    const WSH = { 'X-Workspace-Id': wsId };
    const orgTask = await call('POST', '/tasks', t1, { title: 'Сьют задача организации' }, WSH);
    const orgTaskId = orgTask.json?.data?.id;
    await call('GET', `/messenger/tasks/${orgTaskId}/chat`, t1, undefined, WSH);
    const orgChat = await prisma.chat.findFirst({ where: { parentType: 'task', parentId: orgTaskId } });
    check('чат задачи организации знает свою организацию (Chat.workspaceId)', orgChat?.workspaceId === wsId, `${orgChat?.workspaceId}`);
    await call('DELETE', `/workspaces/${wsId}`, t1);
    r = await call('GET', `/lifecycle/dev/tenant/${wsId}/preview`, t1);
    const prev = r.json?.data ?? {};
    check('предпросмотр каскада: все шаги плана зарегистрированы', r.ok && Array.isArray(prev.missing) && prev.missing.length === 0, (prev.missing ?? []).join(','));
    check('предпросмотр считает строки ДО удаления (задачи организации)', (prev.steps ?? []).some((s) => s.key === 'tasks.workspace' && s.rows >= 1));
    const h3 = await hold(wsId);
    r = await call('POST', '/workspaces/dev/purge-archives', t1, { workspaceId: wsId });
    check('организация под заморозкой не удаляется (409 lifecycle.tenantHeld)', r.status === 409 && r.code === 'lifecycle.tenantHeld', `${r.status} ${r.code}`);
    check('строка организации на месте', (await prisma.workspace.count({ where: { id: wsId } })) === 1);
    await release(h3.id);
    r = await call('POST', '/workspaces/dev/purge-archives', t1, { workspaceId: wsId });
    check('после снятия заморозки каскад прошёл', r.ok && (await prisma.workspace.count({ where: { id: wsId } })) === 0, `${r.status} ${r.code ?? ''}`);
    const tenantRun = await prisma.lifecycleRun.findFirst({ where: { kind: 'tenant_purge', subjectId: wsId, status: 'done' }, orderBy: { startedAt: 'desc' } });
    const done = Array.isArray(tenantRun?.report?.done) ? tenantRun.report.done : [];
    check('прогон каскада прошёл ВСЕ шаги плана, строка организации — последней', done.length === steps.length && done[done.length - 1] === 'workspaces.row', `${done.length}/${steps.length}`);
    check('задача организации и её чат удалены', (await prisma.task.count({ where: { id: orgTaskId } })) === 0 && (await prisma.chat.count({ where: { id: orgChat?.id ?? crypto.randomUUID() } })) === 0);

    // ============================================================
    console.log('\n-- 8. шаг модуля через раннер: корзина задач --');
    const trashed = await call('POST', '/tasks', t1, { title: 'Сьют корзина раннера' });
    const trashedId = trashed.json?.data?.id;
    await call('POST', `/tasks/${trashedId}/trash`, t1);
    await prisma.task.update({ where: { id: trashedId }, data: { deletedAt: new Date(Date.now() - 31 * DAY) } });
    r = await run('Task');
    check('tasks.trash через раннер: задача старше срока корзины удалена', r.ok && r.json?.data?.status === 'done' && (await prisma.task.count({ where: { id: trashedId } })) === 0);

    // ============================================================
    console.log('\n-- 9. временный каталог --');
    const tmpDir = path.join(os.tmpdir(), 'superapp6');
    fs.mkdirSync(tmpDir, { recursive: true });
    const stale = path.join(tmpDir, `suite-stale-${crypto.randomUUID()}`);
    const fresh = path.join(tmpDir, `suite-fresh-${crypto.randomUUID()}`);
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    const twoDaysAgo = new Date(Date.now() - 2 * DAY);
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
    r = await run('derived:upload_tmp');
    check('брошенный временный файл старше суток убран', r.ok && !fs.existsSync(stale));
    check('свежий временный файл цел', fs.existsSync(fresh));
    fs.rmSync(fresh, { force: true });

    // ============================================================
    console.log('\n-- 10. очередь и окно --');
    r = await call('POST', '/lifecycle/dev/purge/schedule', t1, { policyId: 'LifecycleBackupRun' });
    check('прогон поставлен джобом', r.ok && r.json?.data?.queued === true && !!r.json?.data?.runId, JSON.stringify(r.json?.data ?? r.json));
    const runId = r.json?.data?.runId;
    const again = await call('POST', '/lifecycle/dev/purge/schedule', t1, { policyId: 'LifecycleBackupRun' });
    const opened = inWindow();
    if (opened) {
      let st = null;
      for (let i = 0; i < 30 && st !== 'done'; i++) {
        await sleep(500);
        st = (await prisma.lifecycleRun.findUnique({ where: { id: runId } }))?.status;
      }
      check('в окне ретеншна джоб отработал прогон', st === 'done', st);
    } else {
      await sleep(2500);
      const job = await prisma.job.findFirst({ where: { type: 'lifecycle.purge', uniqueKey: 'purge:LifecycleBackupRun', status: 'available' }, orderBy: { createdAt: 'desc' } });
      check('вне окна джоб ждёт открытия (runAt в будущем)', !!job && job.runAt.getTime() > Date.now() + 60_000, job ? job.runAt.toISOString() : 'нет джоба');
      check('повторная постановка при живом джобе — no-op', again.ok && again.json?.data?.queued === false);
      if (job) await prisma.job.updateMany({ where: { id: job.id, status: 'available' }, data: { status: 'cancelled', finishedAt: new Date() } });
      await prisma.lifecycleRun.updateMany({ where: { id: runId, status: 'running' }, data: { status: 'stopped', stoppedReason: 'cancelled', finishedAt: new Date() } });
    }

    // ============================================================
    console.log('\n-- 11. метрики --');
    const metricsUrl = BASE.replace(/\/api\/?$/, '') + '/metrics';
    const m = await fetch(metricsUrl, { headers: process.env.METRICS_TOKEN ? { Authorization: `Bearer ${process.env.METRICS_TOKEN}` } : {} });
    const text = m.ok ? await m.text() : '';
    check('метрики раннера и loose FK в /metrics', /lifecycle_purge_rows_total/.test(text) && /lifecycle_purge_halted_total/.test(text) && /lifecycle_loose_fk_backlog/.test(text), `${m.status}`);

    // ============================================================
    console.log('\n-- 12. команда Кабинета lifecycle.workspace.purge --');
    const { token: t2 } = await login(SUITE.p2);
    const foreign = await createSuiteWorkspace(t2, 'Сьют-Purge-Кабинет');
    const foreignId = foreign.json?.data?.id;
    await call('DELETE', `/workspaces/${foreignId}`, t2);
    const own = await createSuiteWorkspace(t1, 'Сьют-Purge-Своя');
    const ownId = own.json?.data?.id;
    await call('DELETE', `/workspaces/${ownId}`, t1);
    const c1 = await consoleLogin(SUITE.p1);
    const ct = c1.token;
    check('вход в Кабинет (сотрудник платформы)', !!ct, JSON.stringify(c1.login?.json ?? c1.start?.json ?? {}).slice(0, 120));
    if (ct) {
      await consoleSudo(ct);
      const cmds = await call('GET', '/platform/commands', ct);
      const cmd = (cmds.json?.data ?? []).find((c) => c.key === 'lifecycle.workspace.purge');
      check('команда в реестре: risk critical, «четыре глаза»', !!cmd && cmd.risk === 'critical' && cmd.dualControl === true, JSON.stringify(cmd ?? null).slice(0, 160));
      const selfTarget = await call('POST', '/platform/commands/lifecycle.workspace.purge', ct, { input: { workspaceId: ownId }, idempotencyKey: crypto.randomUUID(), reason: 'suite: purge own organisation' });
      check('своя организация — отказ (403 platform.self_target)', selfTarget.status === 403 && selfTarget.code === 'platform.self_target', `${selfTarget.status} ${selfTarget.code}`);
      const prev = await call('POST', '/platform/commands/lifecycle.workspace.purge/preview', ct, { input: { workspaceId: foreignId } });
      check('предпросмотр: план каскада с числом строк по шагам, без пропусков', prev.ok && Array.isArray(prev.json?.data?.result?.steps) && prev.json.data.result.steps.length === steps.length && prev.json.data.result.missing.length === 0 && prev.json.data.result.held === false, `${prev.status} ${prev.code ?? ''}`);
      check('предпросмотр ничего не поставил', (await prisma.lifecycleRun.count({ where: { kind: 'tenant_purge', subjectId: foreignId } })) === 0);
      // Два исполнения разом (ретеншн архива и оркестратор стирания ставят каскад одновременно):
      // постановка идёт под замком строки организации — один прогон, один джоб, без сирот «running»
      const [ex, ex2] = await Promise.all([
        call('POST', '/platform/commands/lifecycle.workspace.purge', ct, { input: { workspaceId: foreignId }, idempotencyKey: crypto.randomUUID(), reason: 'suite: purge archived organisation' }),
        call('POST', '/platform/commands/lifecycle.workspace.purge', ct, { input: { workspaceId: foreignId }, idempotencyKey: crypto.randomUUID(), reason: 'suite: purge archived organisation (race)' }),
      ]);
      const queuedBoth = [ex, ex2].filter((x) => x.ok && x.json?.data?.result?.queued === true).length;
      check('исполнение поставило каскад джобом', (ex.ok || ex2.ok) && queuedBoth === 1, `${ex.status}/${ex2.status} ${ex.code ?? ''}${ex2.code ?? ''} queued=${queuedBoth}`);
      const tenantRuns = await prisma.lifecycleRun.count({ where: { kind: 'tenant_purge', subjectId: foreignId } });
      check('параллельная постановка — одна строка прогона (без сироты «running» без джоба)', tenantRuns === 1, tenantRuns);
      let gone = false;
      for (let i = 0; i < 60 && !gone; i++) {
        await sleep(500);
        gone = (await prisma.workspace.count({ where: { id: foreignId } })) === 0;
      }
      check('джоб каскада удалил организацию', gone);
    }

    // ============================================================
    console.log('\n-- 13. заморозка организации держит её данные с владельцем через родителя --');
    // Заметка организации принадлежит ей через пространство (ownerKey via NoteSpace): заморозка
    // организации (с её workspace_id) обязана держать и такую строку — корзину раннера и «навсегда»
    const hw = await createSuiteWorkspace(t1, 'Сьют-Purge-Заморозка');
    const hwId = hw.json?.data?.id;
    const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const orgNote = (await call('POST', '/notes', t1, { workspaceId: hwId, content: { type: 'doc', content: [para(`Сьют заморозка через родителя ${rnd4()}`)] } })).json?.data;
    check('заметка организации создана', !!orgNote?.id && orgNote.ownerType === 'workspace', JSON.stringify(orgNote ?? null).slice(0, 120));
    if (orgNote?.id) {
      await call('POST', `/notes/${orgNote.id}/trash`, t1);
      await prisma.note.update({ where: { id: orgNote.id }, data: { deletedAt: new Date(Date.now() - 400 * DAY) } });
      const hOrg = await prisma.lifecycleHold.create({ data: { scope: 'space', workspaceId: hwId, spaceType: 'workspace', spaceId: hwId, reasonCode: 'suite', createdById: u1 } });
      holds.push(hOrg.id);
      const forever = await call('DELETE', `/notes/${orgNote.id}`, t1);
      check('«удалить навсегда» заметку организации под её заморозкой → 409 lifecycle.held', forever.status === 409 && forever.code === 'lifecycle.held', `${forever.status} ${forever.code}`);
      r = await run('Note');
      check('корзина раннера: заметка организации под её заморозкой остаётся', r.ok && (await prisma.note.count({ where: { id: orgNote.id } })) === 1, `${r.status} ${r.json?.data?.status}`);
      await release(hOrg.id);
      r = await run('Note');
      check('после снятия — корзина раннера удаляет её', r.ok && (await prisma.note.count({ where: { id: orgNote.id } })) === 0, `${r.status} ${r.json?.data?.status}`);
    }
    if (hwId) await call('DELETE', `/workspaces/${hwId}`, t1);

    // ============================================================
    console.log('\n-- 14. одна дверь: сроки модулей принуждает раннер --');
    r = await call('GET', '/lifecycle/dev/plan', t1);
    const enforced2 = new Map((r.json?.data?.enforced ?? []).map((p) => [p.id, p.mode]));
    check('роллап «субъект × день» — шаг модуля (срок сырья), карантин / визиты / цепочки SMS / тревоги — общая пачка', enforced2.get('AnalyticsRollupActorDay') === 'handler' && ['AnalyticsQuarantine', 'ShareLinkVisit', 'VerifyChallenge', 'SecurityAlert', 'PlatformSession', 'UserDevice'].every((id) => enforced2.get(id) === 'generic'));
    // Забытое устройство — год после отметки (раньше — свой крон core/audit мимо реестра)
    const devRecent = await prisma.userDevice.create({ data: { userId: u1, deviceId: crypto.randomUUID(), label: 'suite purge forgotten', lastSeenAt: new Date(), forgottenAt: new Date(Date.now() - 400 * DAY) } });
    const devKept = await prisma.userDevice.create({ data: { userId: u1, deviceId: crypto.randomUUID(), label: 'suite purge kept', lastSeenAt: new Date(), forgottenAt: new Date(Date.now() - 10 * DAY) } });
    r = await run('UserDevice');
    check('забытое больше года назад устройство удалено раннером; забытое недавно — на месте', r.ok && (await prisma.userDevice.count({ where: { id: devRecent.id } })) === 0 && (await prisma.userDevice.count({ where: { id: devKept.id } })) === 1, `${r.status} ${r.json?.data?.status}`);
    await prisma.userDevice.delete({ where: { id: devKept.id } }).catch(() => undefined);
    // Отозванная сессия Кабинета — сутки после отзыва (правило revokedAt), даже если срок жизни впереди
    const ps = await prisma.platformSession.create({ data: { userId: u1, expiresAt: new Date(Date.now() + 3_600_000), revokedAt: new Date(Date.now() - 2 * DAY), userAgent: 'suite purge' } });
    r = await run('PlatformSession');
    check('отозванная двое суток назад сессия Кабинета удалена раннером', r.ok && (await prisma.platformSession.count({ where: { id: ps.id } })) === 0, `${r.status} ${r.json?.data?.status}`);
  } finally {
    await call('POST', '/lifecycle/dev/health', t1, {}).catch(() => undefined);
    for (const id of holds) await prisma.lifecycleHold.updateMany({ where: { id, releasedAt: null }, data: { releasedAt: new Date(), releasedById: u1 } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  await finish();
}

main().catch(crash);
