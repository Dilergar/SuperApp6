/* eslint-disable */
// E2E: core/analytics (21-й движок). Сьют suite1 (владелец кабинета, внутренний номер),
// suite2, suite3. API на :3001, dev-режим (троттлер выключен — 429 не проверяется).
// Покрывает: приём (личность из JWT, поле личности в теле → dropped + карантин,
// неизвестный ключ, серверный ключ с HTTP, рубильник blocked, редакция PII, анонимная
// ручка и склейка с оспариванием, отказ человека против business-фактов, заголовок
// сессии в серверном событии, дедуп ретрая), роллап дня и все виды запросов
// (trend/funnel/retention/breakdown/lifecycle/adoption/journeys, k-анонимность, фоновая
// воронка, недопустимый фильтр шага), каталог и качество, панель «Активность»,
// отчёты и дашборды (личный отчёт на общем дашборде, системный read-only, отвязка при
// удалении), забвение человека командой, партиции (создание вперёд, сброс по ретенции).
// Run: node apps/api/scripts/verify-analytics.cjs
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { SUITE, call, login, makeChecker, consoleLogin, consoleSudo } = require('./_lib.cjs');

const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 15_000, intervalMs = 500) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(intervalMs);
  }
}
const TZ = process.env.APP_TIMEZONE || 'Asia/Almaty';
const today = () => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

(async () => {
  const { check, finish } = makeChecker();
  const started = new Date();
  const eventIds = [];
  const anonIds = [];
  const createdTasks = [];
  let T = null;
  let s1;
  let s2;
  let s3;
  // Монотонное время: события одного батча, созданные в одну миллисекунду, давали воронке
  // равные ts, а шаг воронки строго позже предыдущего — на быстрой машине шаг 2 выпадал (флак)
  let lastMs = 0;
  const now = () => {
    lastMs = Math.max(Date.now(), lastMs + 1);
    return new Date(lastMs).toISOString();
  };
  const ev = (key, props, extra = {}) => {
    const eventId = randomUUID();
    eventIds.push(eventId);
    return { eventId, key, occurredAt: now(), props, ...extra };
  };
  const body = (batch) => ({ sentAt: now(), app: { platform: 'web', version: 'suite' }, context: { locale: 'ru', tz: TZ }, batch });
  const rows = (ids) =>
    prisma.$queryRawUnsafe(
      `SELECT event_id::text, event_key, user_id::text, anonymous_id::text, workspace_id::text, session_id::text, route, props, owner_type, is_internal
       FROM analytics.events WHERE event_id = ANY($1::uuid[])`,
      ids,
    );
  const quarantine = (key, reason) =>
    prisma.analyticsQuarantine.findFirst({ where: { eventKey: key, reason, lastSeenAt: { gte: new Date(started.getTime() - 5_000) } } });
  const runCommand = (key, input, reason) =>
    call('POST', `/platform/commands/${key}`, T, { input, idempotencyKey: randomUUID(), ...(reason ? { reason } : {}) });
  const q = (query) => call('POST', '/platform/analytics/query', T, query);

  try {
    s1 = await login(SUITE.p1);
    s2 = await login(SUITE.p2);
    s3 = await login(SUITE.p3);
    const con = await consoleLogin(SUITE.p1);
    T = con.token;
    check('вход в кабинет suite1 (владелец)', !!T, con.start?.status);

    // ---- 1. Приём: личность из JWT, шаблон маршрута, редакция PII ----
    const sessionA = randomUUID();
    const deviceA = randomUUID();
    const b1 = [
      ev('navigation.page.viewed', { route: `/tasks/${randomUUID()}`, service: 'tasks' }, { sessionId: sessionA, deviceId: deviceA, route: `/tasks/${randomUUID()}` }),
      ev('entitlements.paywall.shown', { key: '990101300123', surface: 'inline' }, { sessionId: sessionA, deviceId: deviceA }),
      ev('auth.login.opened', {}, { sessionId: sessionA, deviceId: deviceA }),
    ];
    const r1 = await call('POST', '/analytics/collect', s1.token, body(b1));
    check('collect 3 события → 202 accepted 3', r1.status === 202 && r1.json?.data?.accepted === 3 && r1.json?.data?.dropped === 0, JSON.stringify(r1.json?.data));
    const got1 = await waitFor(async () => {
      const r = await rows(b1.map((e) => e.eventId));
      return r.length === 3 ? r : null;
    });
    check('строки легли с user_id из JWT', !!got1 && got1.every((r) => r.user_id === s1.id));
    const page = got1?.find((r) => r.event_key === 'navigation.page.viewed');
    check('маршрут без UUID (шаблон сервером)', page?.props?.route === '/tasks/:id' && page?.route === '/tasks/:id', page?.props?.route);
    check('сессия из тела', page?.session_id === sessionA);
    check('внутренний аккаунт помечен (префикс номера сьюта)', page?.is_internal === true);
    const pii = got1?.find((r) => r.event_key === 'entitlements.paywall.shown');
    check('значение, похожее на ИИН, редактировано', pii?.props?.key === '[redacted]', pii?.props?.key);
    check('PII-срабатывание в карантине', !!(await waitFor(() => quarantine('entitlements.paywall.shown', 'pii'))));

    const withIdentity = { ...ev('auth.login.opened', {}), userId: s2.id };
    const r2 = await call('POST', '/analytics/collect', s1.token, body([withIdentity]));
    check('поле личности в теле → dropped', r2.status === 202 && r2.json?.data?.dropped === 1 && r2.json?.data?.accepted === 0);
    check('… и карантин schema', !!(await waitFor(() => quarantine('auth.login.opened', 'schema'))));

    // ---- 2. Реестр: неизвестный ключ, серверный ключ с HTTP, рубильник ----
    const r3 = await call('POST', '/analytics/collect', s1.token, body([ev('suite.unknown.key', {}), ev('tasks.task.created', { hasAssignee: false, hasDue: false, hasReward: false, contextType: 'personal' })]));
    check('неизвестный + серверный ключ → оба dropped', r3.json?.data?.dropped === 2 && r3.json?.data?.accepted === 0);
    check('карантин unknown_key', !!(await waitFor(() => quarantine('suite.unknown.key', 'unknown_key'))));
    check('карантин server_key_from_client', !!(await waitFor(() => quarantine('tasks.task.created', 'server_key_from_client'))));

    const block = await runCommand('analytics.event.setStatus', { eventKey: 'entitlements.paywall.clicked', status: 'blocked' }, 'suite: проверка рубильника события');
    check('команда analytics.event.setStatus blocked', block.ok, JSON.stringify(block.json?.details ?? block.json?.data?.status));
    const blockedWorks = await waitFor(
      async () => {
        const e = ev('entitlements.paywall.clicked', { key: 'suite.key', surface: 'inline' });
        await call('POST', '/analytics/collect', s1.token, body([e]));
        await sleep(2500);
        return (await rows([e.eventId])).length === 0;
      },
      45_000,
      0,
    );
    check('событие с рубильником blocked не пишется', !!blockedWorks);
    const unblock = await runCommand('analytics.event.setStatus', { eventKey: 'entitlements.paywall.clicked', status: 'live' }, 'suite: вернуть событие после проверки');
    check('рубильник снят (live)', unblock.ok);

    // ---- 4. Анонимная ручка и склейка ----
    const anonA = randomUUID();
    anonIds.push(anonA);
    const okAnon = ev('auth.registration.opened', {}, { anonymousId: anonA });
    const r4 = await call('POST', '/analytics/collect/anon', null, body([okAnon, ev('tasks.task.created', {}, { anonymousId: anonA })]));
    check('anon: разрешённый принят, серверный отвергнут', r4.status === 202 && r4.json?.data?.accepted === 1 && r4.json?.data?.dropped === 1, JSON.stringify(r4.json?.data));
    const anonRow = await waitFor(async () => (await rows([okAnon.eventId]))[0]);
    check('anon: строка без личности, owner_type=anonymous', anonRow?.user_id === null && anonRow?.anonymous_id === anonA && anonRow?.owner_type === 2);
    const id1 = await call('POST', '/analytics/identify', s1.token, { anonymousId: anonA });
    check('identify: первая привязка', id1.ok && id1.json?.data?.linked === true, JSON.stringify(id1.json?.data));
    const id2 = await call('POST', '/analytics/identify', s2.token, { anonymousId: anonA });
    check('identify другим аккаунтом → contested', id2.ok && id2.json?.data?.contested === true);
    const link = await prisma.analyticsIdentityLink.findUnique({ where: { anonymousId: anonA } });
    check('первая связь неизменна, помечена contested', link?.userId === s1.id && link?.contested === true);

    // ---- 5. Отказ человека: клиентское не пишется, серверный факт пишется с сессией ----
    // Отказ — согласие вида `analytics` движка согласий (правда), `users.analyticsOptOut` — его зеркало
    const off = await call('POST', '/consents/revoke', s2.token, { documentKey: 'analytics' });
    check('отказ от аналитики записан движком согласий', off.ok && off.json?.data?.revoked === 1, JSON.stringify(off.json).slice(0, 160));
    const consent = await call('GET', '/analytics/consent', s2.token);
    check('consent читается', consent.json?.data?.optOut === true);
    const optedEvent = ev('navigation.page.viewed', { route: '/dashboard', service: 'dashboard' });
    await call('POST', '/analytics/collect', s2.token, body([optedEvent]));
    await sleep(3000);
    check('после отказа product/telemetry не пишется', (await rows([optedEvent.eventId])).length === 0);
    const sessionB = randomUUID();
    const task = await call('POST', '/tasks', s2.token, { title: 'suite analytics fact' }, { 'X-Analytics-Session': sessionB });
    if (task.json?.data?.id) createdTasks.push({ id: task.json.data.id, token: s2.token });
    check('POST /tasks (suite2)', task.ok, task.status);
    await call('POST', '/platform/analytics/dev/drain', T, {});
    const fact = await waitFor(async () => {
      const r = await prisma.$queryRawUnsafe(
        `SELECT session_id::text, ref_id::text FROM analytics.events WHERE event_key = 'tasks.task.created' AND user_id = $1::uuid AND received_at >= $2::timestamptz`,
        s2.id,
        started.toISOString(),
      );
      return r.find((x) => x.ref_id === task.json?.data?.id);
    });
    check('business-факт записан несмотря на отказ', !!fact);
    check('серверное событие несёт сессию из X-Analytics-Session', fact?.session_id === sessionB, fact?.session_id);
    {
      const doc = await call('GET', '/consents/documents/analytics', null);
      await call('POST', '/consents/accept', s2.token, { versionIds: [doc.json?.data?.versionId], locale: 'ru', channel: 'api' });
    }

    // ---- 6. Ретрай того же батча ----
    await call('POST', '/analytics/collect', s1.token, body(b1));
    await sleep(2500);
    check('ретрай тех же event_id → по одной строке', (await rows(b1.map((e) => e.eventId))).length === 3);

    // ---- 7. Роллап и запросы ----
    const day = today();
    const roll = await call('POST', '/platform/analytics/dev/rollup', T, { day });
    check('роллап дня', roll.ok, JSON.stringify(roll.json?.data ?? roll.json?.details));
    const actorRows = await prisma.analyticsRollupActorDay.count({ where: { actorId: s1.id, day: new Date(`${day}T00:00:00Z`) } });
    check('actor_day для suite1 за сегодня', actorRows > 0);
    const range = { from: day, to: day };
    const dauAll = await q({ type: 'trend', range, metric: 'dau', excludeInternal: false });
    check('trend dau (с внутренними) ≥ 1', dauAll.ok && (dauAll.json?.data?.result?.current ?? 0) >= 1, JSON.stringify(dauAll.json?.details ?? dauAll.json?.data?.result?.current));
    const dauExt = await q({ type: 'trend', range, metric: 'dau' });
    check('исключение внутренних уменьшает DAU', dauExt.ok && (dauExt.json?.data?.result?.current ?? 0) <= (dauAll.json?.data?.result?.current ?? 0));
    check('meta: пояс и порог k', dauAll.json?.data?.meta?.timezone === TZ && typeof dauAll.json?.data?.meta?.kAnon === 'number');
    const funnel = await q({
      type: 'funnel',
      range,
      excludeInternal: false,
      windowDays: 1,
      steps: [{ eventKey: 'navigation.page.viewed' }, { eventKey: 'entitlements.paywall.shown' }],
    });
    const steps = funnel.json?.data?.result?.steps ?? [];
    check('funnel: оба шага ≥ 1', funnel.ok && steps[0]?.count >= 1 && steps[1]?.count >= 1, JSON.stringify(funnel.json?.details ?? steps.map((s) => s.count)));
    const badFilter = await q({ type: 'funnel', range, steps: [{ eventKey: 'auth.login.opened', where: { prop: 'secret', value: 'x' } }, { eventKey: 'auth.user.logged_in' }] });
    check('фильтр шага по не-enum свойству → 400', badFilter.status === 400 && badFilter.code === 'analytics.invalid_filter', badFilter.code);
    // Шаг «любое из»: засчитывается альтернативой (как «первая ценность» — задача, событие или чат)
    const anyOf = await q({
      type: 'funnel',
      range,
      excludeInternal: false,
      windowDays: 1,
      steps: [{ eventKey: 'navigation.page.viewed' }, { eventKey: 'auth.registration.opened', orEventKeys: ['entitlements.paywall.shown'] }],
    });
    const anySteps = anyOf.json?.data?.result?.steps ?? [];
    check('funnel: шаг «любое из» засчитан альтернативой', anyOf.ok && anySteps[1]?.count >= 1 && anySteps[1]?.orEventKeys?.[0] === 'entitlements.paywall.shown', JSON.stringify(anyOf.json?.details ?? anySteps));
    const anyOfWhere = await q({ type: 'funnel', range, steps: [{ eventKey: 'auth.login.opened' }, { eventKey: 'entitlements.paywall.shown', orEventKeys: ['auth.user.logged_in'], where: { prop: 'surface', value: 'inline' } }] });
    check('фильтр свойства у шага «любое из» → 400', anyOfWhere.status === 400, anyOfWhere.status);
    // Окно И глубина диапазона — случайные: результат фонового расчёта живёт в кэше час,
    // и джоб прошлого прогона иначе уже положил бы этот же запрос туда (сразу `ready`)
    const windowDays = 2 + Math.floor(Math.random() * 80);
    const longRange = { from: addDays(day, -(91 + Math.floor(Math.random() * 200))), to: day };
    const longFunnel = await q({ type: 'funnel', range: longRange, windowDays, steps: [{ eventKey: 'auth.user.registered' }, { eventKey: 'tasks.task.created' }] });
    check('воронка > 90 дней → pending (report job)', longFunnel.ok && longFunnel.json?.data?.status === 'pending' && !!longFunnel.json?.data?.jobId, JSON.stringify(longFunnel.json?.data?.status ?? longFunnel.json?.details));
    const jobDone = await waitFor(async () => {
      const again = await q({ type: 'funnel', range: longRange, windowDays, steps: [{ eventKey: 'auth.user.registered' }, { eventKey: 'tasks.task.created' }] });
      return again.json?.data?.status === 'ready';
    }, 30_000, 1500);
    check('report job досчитал воронку — повтор отдаёт ready', !!jobDone);
    const retention = await q({ type: 'retention', range, days: 7, excludeInternal: false });
    check('retention: 8 колонок (день 0..7)', retention.ok && retention.json?.data?.result?.columns?.length === 8, JSON.stringify(retention.json?.details));
    const lifecycle = await q({ type: 'lifecycle', range, interval: 'day', excludeInternal: false });
    check('lifecycle: одна корзина за день', lifecycle.ok && lifecycle.json?.data?.result?.buckets?.length === 1);
    const adoption = await q({ type: 'adoption', range, excludeInternal: false, byPlan: true });
    check('adoption: активных ≥ 1', adoption.ok && adoption.json?.data?.result?.activeTotal >= 1);
    const journeys = await q({ type: 'journeys', range, excludeInternal: false });
    check('journeys отвечает', journeys.ok && Array.isArray(journeys.json?.data?.result?.pairs));
    const byPlan = await q({ type: 'breakdown', range, by: 'plan', metric: 'users', excludeInternal: false });
    const planRows = byPlan.json?.data?.result?.rows ?? [];
    // Инвариант, не зависящий от объёма данных дня: ячейка либо скрыта (значения нет), либо в ней ≥ 20 человек.
    // Прежняя форма («скрыты все») краснела в любой день, когда активных набиралось двадцать.
    check('k-анонимность: ячейки тарифа < 20 человек скрыты', byPlan.ok && planRows.length > 0 && planRows.some((r) => r.masked) && planRows.every((r) => (r.masked ? r.value === null : r.value >= 20)), JSON.stringify(planRows));
    const byWs = await q({ type: 'breakdown', range, by: 'workspace', metric: 'users', excludeInternal: false });
    check('k-анонимность: организации скрыты, «личное» — нет', byWs.ok && (byWs.json?.data?.result?.rows ?? []).every((r) => r.key === 'personal' || r.masked));
    const eu = await q({ type: 'trend', range, metric: 'event_users', eventKey: 'tasks.task.created', excludeInternal: false });
    check('trend event_users по сырью', eu.ok && (eu.json?.data?.result?.current ?? 0) >= 1);
    // Сессии: роллап сквозной. × организация — людей в нём нет, k-анонимность считается по
    // роллапу субъектов («личное» — агрегат, не маскируется); × тариф — разбиения нет,
    // серия одна и БЕЗ маски (раньше единственная серия «total» пряталась как ячейка < K)
    const sesWs = await q({ type: 'trend', range, metric: 'sessions', breakdown: 'workspace', excludeInternal: false });
    const sesWsSeries = sesWs.json?.data?.result?.series ?? [];
    check(
      'sessions × организация: организации скрыты k-анонимностью, «личное» — нет',
      sesWs.ok && sesWsSeries.length > 0 && sesWsSeries.every((s) => (s.key === 'personal' ? !s.masked : s.masked)),
      JSON.stringify(sesWsSeries.map((s) => [s.key, !!s.masked])),
    );
    const sesPlan = await q({ type: 'trend', range, metric: 'sessions', breakdown: 'plan', excludeInternal: false });
    const sesPlanSeries = sesPlan.json?.data?.result?.series ?? [];
    check(
      'sessions × тариф: одна серия total без маски',
      sesPlan.ok && sesPlanSeries.length === 1 && sesPlanSeries[0]?.key === 'total' && !sesPlanSeries[0]?.masked && sesPlanSeries[0]?.total !== null,
      JSON.stringify(sesPlanSeries.map((s) => [s.key, !!s.masked, s.total])),
    );
    const cached = await q({ type: 'trend', range, metric: 'dau', excludeInternal: false });
    check('повтор запроса — из кэша', cached.json?.data?.meta?.cached === true);
    const longJourneys = await q({ type: 'journeys', range: { from: addDays(day, -120), to: day } });
    check('journeys > 90 дней → 400', longJourneys.status === 400 && longJourneys.code === 'analytics.range_too_long');
    const productToken = await call('POST', '/platform/analytics/query', s1.token, { type: 'trend', range, metric: 'dau' });
    check('продуктовый токен на /platform/analytics → 401', productToken.status === 401);

    const catalog = await call('GET', '/platform/analytics/events', T);
    check('каталог событий: весь реестр', catalog.ok && catalog.json?.data?.length >= 30 && catalog.json.data.some((e) => e.key === 'tasks.task.completed'));
    const quality = await call('GET', '/platform/analytics/quality', T);
    check('качество: карантин показывает неизвестный ключ', quality.ok && quality.json?.data?.quarantine?.some((x) => x.eventKey === 'suite.unknown.key'));

    // ---- 8. Панель «Активность» ----
    const panel = await call('GET', `/platform/entities/user/${s1.id}/panels/user.analytics`, T);
    const pd = panel.json?.data?.data;
    check('панель user.analytics: агрегаты', panel.ok && pd?.activeDays28 >= 1 && Array.isArray(pd?.topServices28), JSON.stringify(panel.json?.details));
    check('панель без ленты событий', pd && !('events' in pd) && Object.keys(pd).every((k) => ['entity', 'lastActiveDay', 'activeDays28', 'topServices28', 'platforms28', 'deniedKeys28', 'members', 'adoption28'].includes(k)));
    console.log('   (пропуск) 403 без analytics.person.read: в реестре одна роль platform_owner — узкой роли для проверки нет');

    // ---- Отчёты и дашборды ----
    const report = await call('POST', '/platform/analytics/reports', T, { title: 'suite report', query: { type: 'trend', range, metric: 'dau' }, visibility: 'private' });
    check('создан личный отчёт', report.ok && report.json?.data?.canEdit === true);
    const reportId = report.json?.data?.id;
    const badBoard = await call('POST', '/platform/analytics/dashboards', T, { title: 'suite board', tiles: [{ reportId, span: 6 }], visibility: 'shared' });
    check('личный отчёт на общем дашборде → 400', badBoard.status === 400 && badBoard.code === 'analytics.private_tile', badBoard.code);
    const shared = await call('PATCH', `/platform/analytics/reports/${reportId}`, T, { visibility: 'shared' });
    check('отчёт стал общим', shared.ok && shared.json?.data?.visibility === 'shared');
    const board = await call('POST', '/platform/analytics/dashboards', T, { title: 'suite board', tiles: [{ reportId, span: 6 }], visibility: 'shared' });
    check('создан дашборд', board.ok);
    const boardId = board.json?.data?.id;
    const detail = await call('GET', `/platform/analytics/dashboards/${boardId}`, T);
    check('дашборд отдаёт отчёты плиток одним ответом', detail.ok && detail.json?.data?.reports?.length === 1);
    const overview = await call('GET', '/platform/analytics/dashboards/overview', T);
    check('системный «Обзор» по ключу', overview.ok && overview.json?.data?.systemKey === 'overview' && overview.json?.data?.tiles?.length >= 5);
    const retentionBoard = await call('GET', '/platform/analytics/dashboards/retention', T);
    const allReports = (await call('GET', '/platform/analytics/reports', T)).json?.data ?? [];
    check(
      '«Удержание»: одна плитка (сетка — переключатель), убранный из кода системный отчёт удалён',
      retentionBoard.ok && retentionBoard.json?.data?.tiles?.length === 1 && !allReports.some((r) => r.systemKey === 'retention_grid'),
      JSON.stringify(retentionBoard.json?.data?.tiles),
    );
    const sysReport = (await call('GET', '/platform/analytics/reports', T)).json?.data?.find((r) => r.systemKey === 'dau');
    const sysPatch = await call('PATCH', `/platform/analytics/reports/${sysReport?.id}`, T, { title: 'x' });
    check('системный отчёт не правится → 403', sysPatch.status === 403 && sysPatch.code === 'analytics.system_read_only', sysPatch.code);
    const del = await call('DELETE', `/platform/analytics/reports/${reportId}`, T);
    const afterDel = await call('GET', `/platform/analytics/dashboards/${boardId}`, T);
    check('удалённый отчёт ушёл с дашборда', del.ok && afterDel.json?.data?.tiles?.length === 0);
    const delBoard = await call('DELETE', `/platform/analytics/dashboards/${boardId}`, T);
    check('дашборд удалён', delBoard.ok);

    // ---- 9. Забвение человека ----
    const anonC = randomUUID();
    anonIds.push(anonC);
    const e3 = ev('navigation.page.viewed', { route: '/tasks', service: 'tasks' }, { anonymousId: anonC });
    await call('POST', '/analytics/collect', s3.token, body([e3]));
    await call('POST', '/analytics/identify', s3.token, { anonymousId: anonC });
    check('события suite3 легли', !!(await waitFor(async () => (await rows([e3.eventId])).length === 1)));
    const su = await consoleSudo(T);
    check('step-up для high-команды', su.ok, su.status);
    const forget = await runCommand('analytics.user.forget', { userId: s3.id }, 'suite: проверка забвения аналитики человека');
    check('команда analytics.user.forget', forget.ok, JSON.stringify(forget.json?.details ?? forget.json?.data?.status));
    const erased = await waitFor(async () => {
      const [ev3] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM analytics.events WHERE user_id = $1::uuid`, s3.id);
      const links = await prisma.analyticsIdentityLink.count({ where: { userId: s3.id } });
      const actors = await prisma.analyticsRollupActorDay.count({ where: { actorId: s3.id } });
      return ev3.n === 0 && links === 0 && actors === 0;
    }, 30_000);
    check('после забвения: нет событий, склеек и агрегатов человека', !!erased);

    // ---- 10. Партиции ----
    // Лист заводит функция владельца данных (core/lifecycle): лист чужой роли функция
    // сброса не тронет — так и задумано (DDL журналов — только от владельца)
    await prisma.$queryRawUnsafe(`SELECT lifecycle_ensure_partition('analytics.events', '2020-01-15 00:00:00+00'::timestamptz)`);
    const parts = await call('POST', '/platform/analytics/dev/partitions', T, {});
    const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
    const nextName = `events_${nextMonth.getUTCFullYear()}_${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}`;
    check('партиции: следующий месяц есть', parts.ok && parts.json?.data?.partitions?.includes(nextName), JSON.stringify(parts.json?.data?.partitions));
    check('партиции: старше ретенции сброшена', parts.json?.data?.dropped?.includes('events_2020_01'));

    console.log('   (пропуск) 429 троттлинга: в development троттлер выключен (проверяется только вне dev)');
  } catch (err) {
    console.error(err);
    check('сьют без исключений', false, err?.message);
  } finally {
    // ---- Уборка СВОИХ строк ----
    try {
      if (T) await runCommand('analytics.event.setStatus', { eventKey: 'entitlements.paywall.clicked', status: 'live' }, 'suite: уборка рубильника после прогона');
      await prisma.analyticsEventOverride.deleteMany({ where: { eventKey: 'entitlements.paywall.clicked', setBy: s1?.id } });
      for (const t of createdTasks) await call('POST', `/tasks/${t.id}/trash`, t.token, {}).then(() => call('DELETE', `/tasks/${t.id}`, t.token));
      const suiteUsers = [s1?.id, s2?.id, s3?.id].filter(Boolean);
      await prisma.$executeRawUnsafe(`DELETE FROM analytics.events WHERE event_id = ANY($1::uuid[])`, eventIds);
      await prisma.$executeRawUnsafe(
        `DELETE FROM analytics.events WHERE user_id = ANY($1::uuid[]) AND received_at >= $2::timestamptz`,
        suiteUsers,
        started.toISOString(),
      );
      await prisma.analyticsIdentityLink.deleteMany({ where: { anonymousId: { in: anonIds } } });
      await prisma.analyticsQuarantine.deleteMany({ where: { eventKey: 'suite.unknown.key' } });
      await prisma.analyticsReport.deleteMany({ where: { title: 'suite report', createdBy: s1?.id } });
      await prisma.analyticsDashboard.deleteMany({ where: { title: 'suite board', createdBy: s1?.id } });
      if (s2) {
        const doc = await call('GET', '/consents/documents/analytics', null);
        await call('POST', '/consents/accept', s2.token, { versionIds: [doc.json?.data?.versionId], locale: 'ru', channel: 'api' });
      }
    } catch (err) {
      console.error('cleanup failed:', err?.message);
    }
    await prisma.$disconnect();
    finish();
  }
})();
