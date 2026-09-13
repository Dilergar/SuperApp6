// Ключи React Query и загрузчики раздела «Аналитика» кабинета платформы.
// Один ключ = одна форма кэша (useQuery; бесконечных списков здесь нет).
import type {
  AnalyticsDashboardCreateInput,
  AnalyticsDashboardDetailDto,
  AnalyticsDashboardDto,
  AnalyticsDashboardUpdateInput,
  AnalyticsEventCatalogItemDto,
  AnalyticsQualityDto,
  AnalyticsQueryInput,
  AnalyticsQueryResponseDto,
  AnalyticsReportCreateInput,
  AnalyticsReportDto,
  AnalyticsReportUpdateInput,
} from '@superapp/shared';
import { platformDelete, platformGet, platformPatch, platformPost } from '@/lib/platform-api';

export const analyticsRootKey = ['platform', 'analytics'] as const;
export const analyticsQueryKey = (q: AnalyticsQueryInput) => ['platform', 'analytics', 'query', q] as const;
export const analyticsDashboardsKey = ['platform', 'analytics', 'dashboards'] as const;
export const analyticsDashboardKey = (idOrKey: string) => ['platform', 'analytics', 'dashboard', idOrKey] as const;
export const analyticsReportsKey = ['platform', 'analytics', 'reports'] as const;
export const analyticsReportKey = (id: string) => ['platform', 'analytics', 'report', id] as const;
export const analyticsEventsKey = ['platform', 'analytics', 'events'] as const;
export const analyticsQualityKey = ['platform', 'analytics', 'quality'] as const;

export const runAnalyticsQuery = (q: AnalyticsQueryInput) => platformPost<AnalyticsQueryResponseDto>('/platform/analytics/query', q);
export const fetchAnalyticsEvents = () => platformGet<AnalyticsEventCatalogItemDto[]>('/platform/analytics/events');
export const fetchAnalyticsQuality = () => platformGet<AnalyticsQualityDto>('/platform/analytics/quality');

export const fetchAnalyticsReports = () => platformGet<AnalyticsReportDto[]>('/platform/analytics/reports');
export const fetchAnalyticsReport = (id: string) => platformGet<AnalyticsReportDto>(`/platform/analytics/reports/${encodeURIComponent(id)}`);
export const createAnalyticsReport = (input: AnalyticsReportCreateInput) => platformPost<AnalyticsReportDto>('/platform/analytics/reports', input);
export const updateAnalyticsReport = (id: string, input: AnalyticsReportUpdateInput) =>
  platformPatch<AnalyticsReportDto>(`/platform/analytics/reports/${encodeURIComponent(id)}`, input);
export const deleteAnalyticsReport = (id: string) => platformDelete<null>(`/platform/analytics/reports/${encodeURIComponent(id)}`);

export const fetchAnalyticsDashboards = () => platformGet<AnalyticsDashboardDto[]>('/platform/analytics/dashboards');
export const fetchAnalyticsDashboard = (idOrKey: string) =>
  platformGet<AnalyticsDashboardDetailDto>(`/platform/analytics/dashboards/${encodeURIComponent(idOrKey)}`);
export const createAnalyticsDashboard = (input: AnalyticsDashboardCreateInput) => platformPost<AnalyticsDashboardDto>('/platform/analytics/dashboards', input);
export const updateAnalyticsDashboard = (id: string, input: AnalyticsDashboardUpdateInput) =>
  platformPatch<AnalyticsDashboardDto>(`/platform/analytics/dashboards/${encodeURIComponent(id)}`, input);
export const deleteAnalyticsDashboard = (id: string) => platformDelete<null>(`/platform/analytics/dashboards/${encodeURIComponent(id)}`);
