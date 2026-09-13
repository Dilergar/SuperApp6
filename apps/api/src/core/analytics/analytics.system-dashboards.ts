import type { AnalyticsQueryDraft, AnalyticsViz } from '@superapp/shared';

// ============================================================
// Системные дашборды и отчёты — засев из кода (`systemKey`)
// ============================================================
// Подписи — ключи каталога `analytics.system.reports.<key>` / `analytics.system.dashboards.<key>`
// (в строке БД `title` пуст). Диапазон, сравнение, фильтры и исключение внутренних
// аккаунтов у плитки подставляет панель управления раздела — в запросе это заготовка.
// Правка кода + рестарт = засев обновляет запросы и плитки (идемпотентно).

export interface SystemReportDef {
  systemKey: string;
  viz: AnalyticsViz;
  query: AnalyticsQueryDraft;
}

export interface SystemDashboardDef {
  systemKey: string;
  tiles: Array<{ report: string; span: 4 | 6 | 12 }>;
}

const range = { from: '2026-01-01', to: '2026-01-28' };

export const SYSTEM_REPORTS: SystemReportDef[] = [
  { systemKey: 'dau', viz: 'stat', query: { type: 'trend', range, metric: 'dau' } },
  { systemKey: 'wau', viz: 'stat', query: { type: 'trend', range, metric: 'wau' } },
  { systemKey: 'mau', viz: 'stat', query: { type: 'trend', range, metric: 'mau' } },
  { systemKey: 'active_workspaces', viz: 'stat', query: { type: 'trend', range, metric: 'active_workspaces' } },
  { systemKey: 'new_users', viz: 'stat', query: { type: 'trend', range, metric: 'new_users' } },
  { systemKey: 'active_by_day', viz: 'line', query: { type: 'trend', range, metric: 'dau', compare: true } },
  { systemKey: 'lifecycle', viz: 'stack', query: { type: 'lifecycle', range, interval: 'week' } },
  { systemKey: 'engagement_matrix', viz: 'scatter', query: { type: 'adoption', range } },
  { systemKey: 'adoption', viz: 'bar', query: { type: 'adoption', range, compare: true } },
  { systemKey: 'journeys', viz: 'bar', query: { type: 'journeys', range, limit: 10 } },
  {
    systemKey: 'funnel_registration',
    viz: 'funnel',
    query: {
      type: 'funnel',
      range,
      windowDays: 1,
      breakdown: 'platform',
      steps: [
        { eventKey: 'auth.registration.opened' },
        { eventKey: 'auth.registration.phone_submitted' },
        { eventKey: 'auth.registration.code_submitted' },
        { eventKey: 'auth.user.registered' },
      ],
    },
  },
  {
    systemKey: 'funnel_first_value',
    viz: 'funnel',
    query: {
      type: 'funnel',
      range,
      windowDays: 7,
      breakdown: 'platform',
      // Первая ценность — первое «своё» в любом из основных сервисов: задача, событие календаря или чат
      steps: [{ eventKey: 'auth.user.registered' }, { eventKey: 'tasks.task.created', orEventKeys: ['calendar.event.created', 'messenger.chat.created'] }],
    },
  },
  {
    systemKey: 'funnel_monetization',
    viz: 'funnel',
    query: {
      type: 'funnel',
      range,
      windowDays: 30,
      breakdown: 'plan',
      steps: [
        { eventKey: 'entitlements.paywall.shown' },
        { eventKey: 'entitlements.subscription.changed', where: { prop: 'direction', value: 'up' } },
      ],
    },
  },
  // Кривая по умолчанию; когортная сетка — переключатель в самой плитке (тот же ответ запроса)
  { systemKey: 'retention_curve', viz: 'curve', query: { type: 'retention', range, mode: 'n_day', days: 28 } },
  { systemKey: 'plans_table', viz: 'table', query: { type: 'adoption', range, unit: 'workspace', byPlan: true } },
  { systemKey: 'plan_limits', viz: 'bar', query: { type: 'breakdown', range, by: 'denied_key', metric: 'events', limit: 10 } },
  {
    systemKey: 'plans_active_workspaces',
    viz: 'bar',
    query: { type: 'breakdown', range, by: 'plan', metric: 'workspaces', limit: 10 },
  },
  {
    systemKey: 'plans_events_per_workspace',
    viz: 'bar',
    query: { type: 'breakdown', range, by: 'plan', metric: 'events', perActiveWorkspace: true, limit: 10 },
  },
];

export const SYSTEM_DASHBOARDS: SystemDashboardDef[] = [
  {
    systemKey: 'overview',
    tiles: [
      { report: 'dau', span: 4 },
      { report: 'wau', span: 4 },
      { report: 'mau', span: 4 },
      { report: 'active_workspaces', span: 6 },
      { report: 'new_users', span: 6 },
      { report: 'active_by_day', span: 12 },
      { report: 'lifecycle', span: 12 },
    ],
  },
  {
    systemKey: 'services',
    tiles: [
      { report: 'engagement_matrix', span: 12 },
      { report: 'adoption', span: 6 },
      { report: 'journeys', span: 6 },
    ],
  },
  {
    systemKey: 'funnels',
    tiles: [
      { report: 'funnel_registration', span: 12 },
      { report: 'funnel_first_value', span: 6 },
      { report: 'funnel_monetization', span: 6 },
    ],
  },
  {
    systemKey: 'retention',
    tiles: [
      { report: 'retention_curve', span: 12 },
    ],
  },
  {
    systemKey: 'plans',
    tiles: [
      { report: 'plans_table', span: 12 },
      { report: 'plans_active_workspaces', span: 6 },
      { report: 'plans_events_per_workspace', span: 6 },
      { report: 'plan_limits', span: 6 },
      { report: 'funnel_monetization', span: 6 },
    ],
  },
];

/** Порядок системных дашбордов в переключателе раздела. */
export const SYSTEM_DASHBOARD_ORDER = SYSTEM_DASHBOARDS.map((d) => d.systemKey);
