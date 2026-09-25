/* eslint-disable */
// E2E: core/notifications — движок уведомлений (17-й). Сьют suite1–3, API на :3001.
// Покрывает: send → фанаут → строка у адресата (не у актора); ретрай джоба не дублит
// (леджер); схлопывание (два события одного ключа → одна строка count=2); предпочтения
// личного и организационного контекста независимы; critical создаётся при любых
// настройках; замок политики → личное выключение 403 и строка есть; mute объекта →
// строки нет, но упоминание доходит; seen/read/archive/save/snooze + counts.unseen;
// ретеншн не трогает saved; чужой endpoint web push → 400; SMS для critical при opt-in
// (dev-mock) и `skipped: pref_off` без; /mentions отсутствует, `mentions=1` фильтрует;
// X-Locale kk/ru/en → текст в языке запроса; бюджет продюсера отдаёт rateLimited.
// Run: node apps/api/scripts/verify-notifications.cjs
const { SUITE, call, login, makeChecker, createSuiteWorkspace, crash } = require('./_lib.cjs');
const { PrismaClient, Prisma } = require('@prisma/client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10_000, intervalMs = 400) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(intervalMs);
  }
}

/**
 * Настройки уведомлений аккаунтов сьюта — к снимку начала прогона: удаляется ТОЛЬКО созданное
 * прогоном, прежние значения возвращаются. Не голый deleteMany по userId (правило сьютов:
 * база живая, чистого старта через удаление нет).
 */
async function snapshotSettings(prisma, userIds) {
  return {
    prefs: await prisma.notificationPreference.findMany({ where: { userId: { in: userIds } } }),
    subs: await prisma.notificationSubscription.findMany({ where: { userId: { in: userIds } } }),
    settings: await prisma.userNotificationSettings.findMany({ where: { userId: { in: userIds } } }),
  };
}

async function restoreSettings(prisma, userIds, base) {
  const ids = (rows) => rows.map((r) => r.id);
  await prisma.notificationPreference.deleteMany({ where: { userId: { in: userIds }, id: { notIn: ids(base.prefs) } } });
  for (const { updatedAt, ...row } of base.prefs) {
    await prisma.notificationPreference.upsert({ where: { id: row.id }, update: { enabled: row.enabled }, create: row });
  }
  await prisma.notificationSubscription.deleteMany({ where: { userId: { in: userIds }, id: { notIn: ids(base.subs) } } });
  for (const row of base.subs) {
    await prisma.notificationSubscription.upsert({ where: { id: row.id }, update: { mode: row.mode }, create: row });
  }
  const hadSettings = new Set(base.settings.map((s) => s.userId));
  await prisma.userNotificationSettings.deleteMany({ where: { userId: { in: userIds.filter((id) => !hadSettings.has(id)) } } });
  for (const { updatedAt, ...row } of base.settings) {
    const data = { quietSchedule: row.quietSchedule ?? Prisma.DbNull, pausedUntil: row.pausedUntil };
    await prisma.userNotificationSettings.upsert({ where: { userId: row.userId }, update: data, create: { userId: row.userId, ...data } });
  }
}

async function main() {
  const { check, finish } = makeChecker();
  const prisma = new PrismaClient();
  const s1 = await login(SUITE.p1);
  const s2 = await login(SUITE.p2);
  const s3 = await login(SUITE.p3);
  console.log('logged in suite1..3');
  const suiteIds = [s1.id, s2.id, s3.id];
  const baseline = await snapshotSettings(prisma, suiteIds);

  const tag = `ntf-${Date.now()}`;
  const feed = async (u, q = '') => (await call('GET', `/notifications${q}`, u.token)).json?.data;
  const counts = async (u) => (await call('GET', '/notifications/counts', u.token)).json?.data;
  const deliveries = async (eventId) => (await call('GET', `/notifications/dev/deliveries?eventId=${eventId}`, s1.token)).json?.data ?? [];
  const rowFor = (page, eventIdOrPred) =>
    (page?.items ?? []).find((n) => (typeof eventIdOrPred === 'function' ? eventIdOrPred(n) : n.payload?.tag === eventIdOrPred));
  const send = async (u, body) => call('POST', '/notifications/dev/send', u.token, body);
  const waitRow = (u, pred, q = '') => waitFor(async () => rowFor(await feed(u, q), pred));

  // Организация для контекстных сценариев: suite1 — владелец, suite2 — сотрудник.
  let wsId = null;
  {
    const r = await createSuiteWorkspace(s1.token, 'Сьют-Уведомления');
    wsId = r.json?.data?.id ?? null;
    check('организация создана', !!wsId, JSON.stringify(r.json).slice(0, 200));
    if (wsId) {
      // Приём напрямую ролью (сьют не проходит SMS-приглашение)
      await prisma.userRole.upsert({
        where: { userId_role_context_tenantId: { userId: s2.id, role: 'staff', context: 'workspace', tenantId: wsId } },
        update: { isActive: true },
        create: { userId: s2.id, role: 'staff', context: 'workspace', tenantId: wsId },
      });
      await prisma.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: wsId, userId: s2.id } },
        update: {},
        create: { workspaceId: wsId, userId: s2.id, role: 'staff' },
      }).catch(() => undefined);
    }
  }
  const cleanupIds = { events: [] };

  try {
    // ============================================================
    console.log('\n-- 1. send → фанаут → строка у адресата, не у актора --');
    let r = await send(s1, { type: 'task.assigned', to: [s2.id], payload: { taskId: 'x', taskTitle: `T1 ${tag}`, tag: `${tag}-1` }, ref: { type: 'task_dev', id: `${tag}-t1` }, reason: 'assigned' });
    check('dev/send отвечает eventId', !!r.json?.data?.eventId, JSON.stringify(r.json).slice(0, 200));
    const ev1 = r.json?.data?.eventId;
    cleanupIds.events.push(ev1);
    const row1 = await waitRow(s2, `${tag}-1`);
    check('строка у адресата (suite2)', !!row1, 'не появилась за 10с');
    check('строка НЕ у актора (suite1)', !rowFor(await feed(s1), `${tag}-1`));
    check('title в языке запроса (ru)', !!row1 && /задач/i.test(row1.title), row1?.title);
    check('reason и ref едут в DTO', row1?.reason === 'assigned' && row1?.ref?.type === 'task_dev');
    check('строка unseen/unread', !!row1 && row1.seenAt === null && row1.readAt === null);
    const c1 = await counts(s2);
    check('counts.unseen ≥ 1 и byContext.personal', (c1?.unseen ?? 0) >= 1 && (c1?.byContext?.personal ?? 0) >= 1, JSON.stringify(c1));

    // ============================================================
    console.log('\n-- 2. ретрай джоба фанаута не дублит (леджер доставки) --');
    const job = await prisma.job.findFirst({ where: { type: 'notifications.fanout', payload: { path: ['eventId'], equals: ev1 } }, orderBy: { id: 'desc' } });
    check('джоб notifications.fanout существует', !!job);
    if (job) {
      await prisma.job.update({ where: { id: job.id }, data: { status: 'available', runAt: new Date(), leaseUntil: null, finishedAt: null } });
      const rerun = await waitFor(async () => {
        const j = await prisma.job.findUnique({ where: { id: job.id } });
        return j?.status === 'completed' && j.attempts >= 2 ? j : null;
      }, 12_000);
      check('джоб перепрогнан', !!rerun);
      const rows = await prisma.notification.findMany({ where: { userId: s2.id, eventId: ev1 } });
      check('строка одна и collapseCount = 1', rows.length === 1 && rows[0].collapseCount === 1, `rows=${rows.length} count=${rows[0]?.collapseCount}`);
    }

    // ============================================================
    console.log('\n-- 3. схлопывание: два события одного ключа → одна строка count=2 --');
    r = await send(s1, { type: 'task.due_soon', to: [s2.id], payload: { taskId: 'c', taskTitle: `C ${tag}`, tag: `${tag}-c` }, ref: { type: 'task_dev', id: `${tag}-collapse` } });
    const evC1 = r.json?.data?.eventId;
    await waitRow(s2, `${tag}-c`);
    r = await send(s1, { type: 'task.due_soon', to: [s2.id], payload: { taskId: 'c', taskTitle: `C ${tag}`, tag: `${tag}-c` }, ref: { type: 'task_dev', id: `${tag}-collapse` } });
    const evC2 = r.json?.data?.eventId;
    cleanupIds.events.push(evC1, evC2);
    const collapsed = await waitFor(async () => {
      const row = rowFor(await feed(s2), `${tag}-c`);
      return row && row.collapseCount === 2 ? row : null;
    }, 10_000);
    check('одна строка с collapseCount=2', !!collapsed, 'не схлопнулось за 10с');
    const dupRows = await prisma.notification.count({ where: { userId: s2.id, collapseKey: `task.due_soon:task_dev:${tag}-collapse` } });
    check('в БД ровно одна живая строка ключа', dupRows === 1, `rows=${dupRows}`);

    // ============================================================
    console.log('\n-- 4. предпочтения: личный контекст выключен, организация — нет (наборы независимы) --');
    r = await call('PUT', '/notifications/preferences', s2.token, {
      context: 'personal',
      overrides: [{ subjectKind: 'service', subjectKey: 'tasks', channel: 'inapp', enabled: false }],
    });
    check('PUT preferences personal ok', r.ok, JSON.stringify(r.json).slice(0, 200));
    const prefs = r.json?.data;
    const tasksSvc = prefs?.services?.find((s) => s.service === 'tasks');
    check('матрица: tasks.inapp выключен, override=false', tasksSvc && tasksSvc.channels.inapp.enabled === false && tasksSvc.channels.inapp.override === false);
    r = await send(s1, { type: 'task.assigned', to: [s2.id], payload: { taskTitle: 'off', tag: `${tag}-off` }, ref: { type: 'task_dev', id: `${tag}-off` } });
    const evOff = r.json?.data?.eventId; cleanupIds.events.push(evOff);
    const offDeliv = await waitFor(async () => { const d = await deliveries(evOff); return d.find((x) => x.channel === 'inapp') ?? null; });
    check('inapp skipped: pref_off', offDeliv?.status === 'skipped' && offDeliv?.skipReason === 'pref_off', JSON.stringify(offDeliv));
    check('строки в ленте нет', !rowFor(await feed(s2), `${tag}-off`));
    if (wsId) {
      r = await send(s1, { type: 'task.assigned', to: [s2.id], payload: { taskTitle: 'ws', tag: `${tag}-ws` }, ref: { type: 'task_dev', id: `${tag}-ws` }, workspaceId: wsId });
      const evWs = r.json?.data?.eventId; cleanupIds.events.push(evWs);
      const wsRow = await waitRow(s2, `${tag}-ws`);
      check('в контексте организации строка есть (наборы независимы)', !!wsRow && wsRow.workspaceId === wsId, JSON.stringify(wsRow?.workspaceId));
      const cW = await counts(s2);
      check('counts.byContext[ws] ≥ 1', (cW?.byContext?.[wsId] ?? 0) >= 1, JSON.stringify(cW));
      // фильтр контекста
      const onlyWs = await feed(s2, `?context=${wsId}`);
      check('фильтр context=ws отдаёт только строки организации', (onlyWs?.items ?? []).every((n) => n.workspaceId === wsId) && (onlyWs?.items ?? []).length >= 1);
    }
    // снять переопределение
    await call('PUT', '/notifications/preferences', s2.token, { context: 'personal', overrides: [{ subjectKind: 'service', subjectKey: 'tasks', channel: 'inapp', enabled: null }] });

    // ============================================================
    console.log('\n-- 5. critical создаётся при любых настройках; SMS opt-in --');
    r = await call('PUT', '/notifications/preferences', s2.token, { context: 'personal', overrides: [{ subjectKind: 'type', subjectKey: 'auth.password.changed', channel: 'inapp', enabled: false }] });
    check('critical нельзя переопределить (400 immutable)', r.status === 400 && r.code === 'notification.critical.immutable', `${r.status} ${r.code}`);
    r = await call('PUT', '/notifications/preferences', s2.token, { context: 'personal', overrides: [{ subjectKind: 'service', subjectKey: 'security', channel: 'inapp', enabled: false }] });
    r = await send(s1, { type: 'auth.password.changed', to: [s2.id], payload: { tag: `${tag}-crit` }, includeActor: true });
    const evCrit = r.json?.data?.eventId; cleanupIds.events.push(evCrit);
    const critRow = await waitRow(s2, `${tag}-crit`);
    check('critical-строка создана при выключенном сервисе', !!critRow && critRow.priority === 'critical');
    const critDeliv = await deliveries(evCrit);
    const smsOff = critDeliv.find((d) => d.channel === 'sms');
    check('SMS без opt-in: skipped pref_off', smsOff?.status === 'skipped' && smsOff?.skipReason === 'pref_off', JSON.stringify(smsOff));
    r = await call('PUT', '/notifications/preferences', s2.token, { context: 'personal', overrides: [{ subjectKind: 'type', subjectKey: 'auth.password.changed', channel: 'sms', enabled: true }] });
    check('SMS opt-in принят', r.ok && r.json?.data?.critical?.some((c) => c.type === 'auth.password.changed' && c.smsOptIn === true));
    // Суточный анти-абьюз-потолок SMS на человека (10/сутки) выжигают прошлые прогоны сьютов
    // того же дня — окно СВОЕГО аккаунта сьюта сбрасывается (как квитанции в verify-lifecycle)
    {
      const Redis = require('ioredis');
      const st = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
      let cur = '0';
      do {
        const [next, keys] = await st.scan(cur, 'MATCH', `ntf:sms:u:${s2.id}:*`, 'COUNT', 1000);
        cur = next;
        if (keys.length) await st.del(...keys);
      } while (cur !== '0');
      await st.quit();
    }
    r = await send(s1, { type: 'auth.password.changed', to: [s2.id], payload: { tag: `${tag}-crit2` }, includeActor: true });
    const evCrit2 = r.json?.data?.eventId; cleanupIds.events.push(evCrit2);
    const smsOn = await waitFor(async () => {
      const d = (await deliveries(evCrit2)).find((x) => x.channel === 'sms');
      return d && d.status !== 'queued' ? d : null;
    }, 15_000);
    check('SMS при opt-in: sent (dev-mock) либо skipped:no_phone для не-KZ номера', smsOn && (smsOn.status === 'sent' || smsOn.skipReason === 'no_phone' || smsOn.skipReason === 'driver_not_configured'), JSON.stringify(smsOn));
    await call('PUT', '/notifications/preferences', s2.token, { context: 'personal', overrides: [
      { subjectKind: 'type', subjectKey: 'auth.password.changed', channel: 'sms', enabled: null },
      { subjectKind: 'service', subjectKey: 'security', channel: 'inapp', enabled: null },
    ] });

    // ============================================================
    console.log('\n-- 6. политика организации: замок → личное выключение 403, строка есть --');
    if (wsId) {
      r = await call('GET', `/workspaces/${wsId}/notification-policy`, s2.token);
      check('политика недоступна staff (403)', r.status === 403, `${r.status}`);
      r = await call('PUT', `/workspaces/${wsId}/notification-policy`, s1.token, { rules: [{ subjectKind: 'type', subjectKey: 'objects.shift.changed', channel: 'inapp', mode: 'locked_on' }] });
      check('владелец запер objects.shift.changed', r.ok && r.json?.data?.rules?.length === 1, JSON.stringify(r.json).slice(0, 200));
      r = await call('PUT', `/workspaces/${wsId}/notification-policy`, s1.token, { rules: [{ subjectKind: 'type', subjectKey: 'task.completed', channel: 'inapp', mode: 'locked_on' }] });
      check('не-lockable тип запереть нельзя (400)', r.status === 400 && r.code === 'notification.policy.notLockable', `${r.status} ${r.code}`);
      r = await call('PUT', '/notifications/preferences', s2.token, { context: wsId, overrides: [{ subjectKind: 'type', subjectKey: 'objects.shift.changed', channel: 'inapp', enabled: false }] });
      check('личное выключение запертого → 403 policy.forbidden', r.status === 403 && r.code === 'notification.policy.forbidden', `${r.status} ${r.code}`);
      r = await call('GET', `/notifications/preferences?context=${wsId}`, s2.token);
      const objSvc = r.json?.data?.services?.find((s) => s.service === 'objects');
      const lockedType = objSvc?.types?.find((t) => t.type === 'objects.shift.changed');
      check('матрица показывает замок', lockedType?.channels?.inapp?.locked === true, JSON.stringify(lockedType?.channels));
      r = await send(s1, { type: 'objects.shift.changed', to: [s2.id], payload: { dateLabel: '01.01', tag: `${tag}-lock` }, workspaceId: wsId, ref: { type: 'shift_dev', id: `${tag}-s1` } });
      const evLock = r.json?.data?.eventId; cleanupIds.events.push(evLock);
      check('запертая строка пришла', !!(await waitRow(s2, `${tag}-lock`)));
      // 12 смен → одна строка (collapse: type в контексте организации)
      for (let i = 0; i < 3; i++) {
        r = await send(s1, { type: 'objects.shift.changed', to: [s2.id], payload: { dateLabel: `0${i + 2}.01`, tag: `${tag}-lock` }, workspaceId: wsId, ref: { type: 'shift_dev', id: `${tag}-s${i + 2}` } });
        cleanupIds.events.push(r.json?.data?.eventId);
      }
      const shiftRow = await waitFor(async () => { const row = rowFor(await feed(s2), `${tag}-lock`); return row && row.collapseCount === 4 ? row : null; }, 12_000);
      check('4 смены → одна строка count=4 (collapse: type)', !!shiftRow, JSON.stringify((await feed(s2))?.items?.filter((n) => n.type === 'objects.shift.changed').map((n) => n.collapseCount)));
      check('collapsed-текст «Изменено 4 ваших смен»', !!shiftRow && /4/.test(shiftRow.title) && /смен/i.test(shiftRow.title), shiftRow?.title);
      await call('PUT', `/workspaces/${wsId}/notification-policy`, s1.token, { rules: [] });
    }

    // ============================================================
    console.log('\n-- 7. mute объекта: строки нет, упоминание доходит --');
    const mutedRef = { type: 'task_dev', id: `${tag}-muted` };
    r = await call('POST', '/notifications/mute', s2.token, { refType: mutedRef.type, refId: mutedRef.id });
    check('mute ok', r.ok);
    r = await send(s1, { type: 'task.returned', to: [s2.id], payload: { taskTitle: 'm', tag: `${tag}-m1` }, ref: mutedRef });
    const evM1 = r.json?.data?.eventId; cleanupIds.events.push(evM1);
    const mDeliv = await waitFor(async () => (await deliveries(evM1)).find((d) => d.channel === 'inapp') ?? null);
    check('inapp skipped: muted', mDeliv?.status === 'skipped' && mDeliv?.skipReason === 'muted', JSON.stringify(mDeliv));
    r = await send(s1, { type: 'mention.received', to: [s2.id], payload: { mentionerName: 'S1', snippet: 'hi', tag: `${tag}-m2` }, ref: mutedRef, reason: 'mention' });
    const evM2 = r.json?.data?.eventId; cleanupIds.events.push(evM2);
    check('упоминание пробивает mute', !!(await waitRow(s2, `${tag}-m2`)));
    const mentionsOnly = await feed(s2, '?mentions=1');
    check('фильтр mentions=1 отдаёт только reason=mention', (mentionsOnly?.items ?? []).length >= 1 && mentionsOnly.items.every((n) => n.reason === 'mention'));
    r = await call('GET', '/mentions', s2.token);
    check('старый /mentions отсутствует (404)', r.status === 404, `${r.status}`);
    await call('DELETE', '/notifications/mute', s2.token, { refType: mutedRef.type, refId: mutedRef.id });

    // ============================================================
    console.log('\n-- 8. seen / read / archive / save / snooze + counts --');
    const before = await counts(s2);
    r = await call('POST', '/notifications/seen', s2.token, { ids: [row1.id] });
    check('seen ok', r.ok && r.json?.data?.updated === 1, JSON.stringify(r.json));
    const afterSeen = await counts(s2);
    check('unseen уменьшился на 1', afterSeen.unseen === before.unseen - 1, `${before.unseen} → ${afterSeen.unseen}`);
    let fresh = rowFor(await feed(s2), `${tag}-1`);
    check('после seen строка ещё unread', fresh?.seenAt && fresh?.readAt === null);
    r = await call('POST', `/notifications/${row1.id}/read`, s2.token);
    check('read ok', r.ok && r.json?.data?.readAt);
    r = await call('POST', `/notifications/${row1.id}/save`, s2.token);
    check('save ok', r.ok && r.json?.data?.savedAt);
    r = await call('POST', `/notifications/${row1.id}/archive`, s2.token);
    check('archive ok', r.ok && r.json?.data?.archivedAt);
    check('архивной нет в основном виде', !rowFor(await feed(s2), `${tag}-1`));
    check('архивная есть в state=archived', !!rowFor(await feed(s2, '?state=archived'), `${tag}-1`));
    check('сохранённая есть в state=saved', !!rowFor(await feed(s2, '?state=saved'), `${tag}-1`));
    // snooze
    const until = new Date(Date.now() + 5_000).toISOString();
    r = await call('POST', `/notifications/${collapsed.id}/snooze`, s2.token, { until });
    check('snooze ok', r.ok && r.json?.data?.snoozedUntil, JSON.stringify(r.json).slice(0, 150));
    check('отложенной нет в основном виде', !rowFor(await feed(s2), `${tag}-c`));
    check('отложенная есть в state=snoozed', !!rowFor(await feed(s2, '?state=snoozed'), `${tag}-c`));
    r = await call('POST', `/notifications/${collapsed.id}/snooze`, s2.token, { until: new Date(Date.now() + 40 * 86_400_000).toISOString() });
    check('snooze > 30 дней → 400', r.status === 400 && r.code === 'notification.snooze.tooFar', `${r.status} ${r.code}`);
    const woke = await waitFor(async () => { const row = rowFor(await feed(s2), `${tag}-c`); return row && row.snoozedUntil === null ? row : null; }, 20_000, 800);
    check('строка проснулась джобом и вернулась наверх (unseen)', !!woke && woke.seenAt === null, woke ? 'seenAt=' + woke.seenAt : 'не проснулась за 20с');
    // «Прочитать все» в контексте
    r = await call('POST', '/notifications/read', s2.token, { all: true, context: 'personal' });
    check('read all (personal) ok', r.ok);
    const unreadLeft = await feed(s2, '?state=unread&context=personal');
    check('непрочитанных в личном не осталось', (unreadLeft?.items ?? []).length === 0);
    // чужую строку тронуть нельзя
    r = await call('POST', `/notifications/${collapsed.id}/archive`, s3.token);
    check('чужая строка → 404', r.status === 404);

    // ============================================================
    console.log('\n-- 9. ретеншн не трогает saved --');
    const old = new Date(Date.now() - 100 * 86_400_000);
    await prisma.notification.update({ where: { id: row1.id }, data: { createdAt: old } });
    await prisma.notification.update({ where: { id: collapsed.id }, data: { createdAt: old, savedAt: null } });
    r = await call('POST', '/notifications/dev/retention', s1.token);
    check('ретеншн отработал', r.ok, JSON.stringify(r.json));
    check('saved-строка жива', !!(await prisma.notification.findUnique({ where: { id: row1.id } })));
    check('старая несохранённая удалена', !(await prisma.notification.findUnique({ where: { id: collapsed.id } })));

    // ============================================================
    console.log('\n-- 10. устройства: чужой endpoint → 400; VAPID-ключ --');
    r = await call('GET', '/notifications/vapid-public-key', s2.token);
    check('vapid-public-key отвечает', r.ok && 'publicKey' in (r.json?.data ?? {}));
    const pushLive = !!r.json?.data?.publicKey;
    r = await call('POST', '/notifications/devices', s2.token, { platform: 'web', provider: 'webpush', token: 'https://evil.example.com/push/abc', subscription: { endpoint: 'https://evil.example.com/push/abc', keys: { p256dh: 'x', auth: 'y' } } });
    check('чужой хост endpoint → 400 invalidEndpoint', r.status === 400 && r.code === 'notification.device.invalidEndpoint', `${r.status} ${r.code}`);
    r = await call('POST', '/notifications/devices', s2.token, { platform: 'web', provider: 'webpush', token: `https://fcm.googleapis.com/fcm/send/${tag}`, subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${tag}`, keys: { p256dh: 'x', auth: 'y' } } });
    if (pushLive) {
      check('допустимый endpoint зарегистрирован', r.ok && r.json?.data?.id, JSON.stringify(r.json).slice(0, 150));
      const devs = (await call('GET', '/notifications/devices', s2.token)).json?.data ?? [];
      check('устройство в списке', devs.some((d) => d.provider === 'webpush'));
      await call('DELETE', '/notifications/devices', s2.token, { provider: 'webpush', token: `https://fcm.googleapis.com/fcm/send/${tag}` });
    } else {
      check('без VAPID регистрация web push отвергается (400 notConfigured)', r.status === 400 && r.code === 'notification.push.notConfigured', `${r.status} ${r.code}`);
    }

    // ============================================================
    console.log('\n-- 11. тишина: пауза и расписание --');
    r = await call('POST', '/notifications/quiet/pause', s2.token, { minutes: 30 });
    check('пауза 30 мин', r.ok && r.json?.data?.pausedUntil && r.json.data.activeNow === true, JSON.stringify(r.json?.data));
    r = await call('POST', '/notifications/quiet/pause', s2.token, { clear: true });
    check('пауза снята', r.ok && r.json?.data?.pausedUntil === null);
    r = await call('PUT', '/notifications/quiet', s2.token, { schedule: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '00:00' }] });
    check('расписание «сутки целиком» → activeNow', r.ok && r.json?.data?.activeNow === true, JSON.stringify(r.json?.data));
    r = await call('PUT', '/notifications/quiet', s2.token, { schedule: null });
    check('расписание снято', r.ok && r.json?.data?.schedule === null && r.json.data.activeNow === false);

    // ============================================================
    console.log('\n-- 12. язык: X-Locale kk / en --');
    r = await send(s1, { type: 'task.assigned', to: [s3.id], payload: { taskTitle: `L ${tag}`, tag: `${tag}-l` }, ref: { type: 'task_dev', id: `${tag}-l` } });
    cleanupIds.events.push(r.json?.data?.eventId);
    await waitRow(s3, `${tag}-l`);
    const kk = (await call('GET', '/notifications', s3.token, null, { 'X-Locale': 'kk' })).json?.data;
    const en = (await call('GET', '/notifications', s3.token, null, { 'X-Locale': 'en' })).json?.data;
    const rowKk = rowFor(kk, `${tag}-l`); const rowEn = rowFor(en, `${tag}-l`);
    check('kk: заголовок по-казахски', !!rowKk && /тапсырма/i.test(rowKk.title), rowKk?.title);
    check('en: заголовок по-английски', !!rowEn && /task/i.test(rowEn.title), rowEn?.title);

    // ============================================================
    console.log('\n-- 13. бюджет программируемого продюсера --');
    if (wsId) {
      // Redis-окно: подкрутить нельзя без Redis — проверяем контракт: сверх бюджета → 400 rateLimited.
      const Redis = require('ioredis');
      const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
      const nowSec = Date.now() / 1000; const bucket = Math.floor(nowSec / 3600);
      await redis.set(`ntf:budget:ws:${wsId}:${bucket}`, '10000', 'EX', 7200);
      r = await send(s1, { type: 'process.step.notify', to: [s2.id], payload: { title: 'b', message: '', tag: `${tag}-b` }, workspaceId: wsId, budget: 'workspace' });
      check('сверх бюджета → 400 rateLimited', r.status === 400 && r.code === 'notification.rateLimited', `${r.status} ${r.code}`);
      await redis.del(`ntf:budget:ws:${wsId}:${bucket}`);
      await redis.quit();
    }

    // ============================================================
    console.log('\n-- 14. идемпотентность у источника --');
    r = await send(s1, { type: 'task.accepted', to: [s2.id], payload: { taskTitle: 'i', tag: `${tag}-i` }, ref: { type: 'task_dev', id: `${tag}-i` }, idempotencyKey: `${tag}-idem` });
    const evI = r.json?.data?.eventId; cleanupIds.events.push(evI);
    r = await send(s1, { type: 'task.accepted', to: [s2.id], payload: { taskTitle: 'i', tag: `${tag}-i` }, ref: { type: 'task_dev', id: `${tag}-i` }, idempotencyKey: `${tag}-idem` });
    check('повтор с тем же idempotencyKey → null', r.ok && r.json?.data === null, JSON.stringify(r.json));
    await waitRow(s2, `${tag}-i`);
    const idemRows = await prisma.notification.count({ where: { userId: s2.id, eventId: evI } });
    check('строка одна', idemRows === 1);
  } finally {
    // Чистка СВОИХ событий (каскад удалит строки и доставки) и организации сьюта
    const ids = cleanupIds.events.filter(Boolean);
    if (ids.length) await prisma.notificationEvent.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    await prisma.notificationEvent.deleteMany({ where: { payload: { path: ['tag'], string_starts_with: tag } } }).catch(() => undefined);
    await restoreSettings(prisma, suiteIds, baseline).catch((e) => check('настройки уведомлений сьюта возвращены к снимку', false, e.message));
    // Организацию прогона архивирует finish()/crash()
    await prisma.$disconnect();
  }
  finish();
}

main().catch(crash);
