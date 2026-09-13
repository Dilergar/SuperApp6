import { createAnalytics, webStorageAdapter } from '@superapp/analytics';
import { ACCESS_TOKEN_KEY } from '@superapp/api-client';
import { ANALYTICS_LIMITS, analyticsEventDef, routeTemplateOf } from '@superapp/shared';
import { readLocaleCookie } from '@/i18n/locale';

// Веб-экземпляр SDK аналитики (core/analytics). Лимиты и признаки событий — из реестра
// @superapp/shared: у SDK нет своих копий. Отказ SDK никогда не всплывает в интерфейс.

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';
const WORKSPACE_ROUTE = /^\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export const analytics = createAnalytics({
  baseURL: API_URL,
  getToken: () => (typeof window === 'undefined' ? null : localStorage.getItem(ACCESS_TOKEN_KEY)),
  // Контекст организации на вебе живёт в адресе страницы (как и у запросов API):
  // сервер проверит членство сам, заявленный id ему — только подсказка
  getWorkspaceId: () => (typeof window === 'undefined' ? null : (WORKSPACE_ROUTE.exec(window.location.pathname)?.[1] ?? null)),
  getLocale: () => readLocaleCookie(),
  getRoute: () => (typeof window === 'undefined' ? null : routeTemplateOf(window.location.pathname)),
  storage: webStorageAdapter(),
  app: { platform: 'web' },
  limits: ANALYTICS_LIMITS,
  traits: (key) => {
    const def = analyticsEventDef(key);
    return def ? { anonymous: def.anonymous, sample: def.sample } : undefined;
  },
});
