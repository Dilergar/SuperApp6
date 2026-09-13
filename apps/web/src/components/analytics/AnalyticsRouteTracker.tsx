'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { routeTemplateOf, serviceOfRoute } from '@superapp/shared';
import { analytics } from '@/lib/analytics';

/** Разделы, чьи переходы продуктовой аналитикой не считаются: кабинет сотрудников и витрина кита. */
const UNTRACKED = /^\/(platform|dev)(\/|$)/;

/**
 * Единственный автоматический клиентский вид — `navigation.page.viewed`. В событие
 * уезжает ШАБЛОН маршрута (`/tasks/:id`), не адрес: id и строка запроса — не аналитика.
 * Живёт внутри `<Suspense>`: `useSearchParams` без него выбивает статический рендер.
 * Дедуп `pathname+search` в ref — StrictMode монтирует эффект дважды.
 */
export function AnalyticsRouteTracker() {
  const pathname = usePathname();
  const search = useSearchParams();
  const last = useRef<string | null>(null);
  const previousRoute = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || UNTRACKED.test(pathname)) return;
    const key = `${pathname}?${search?.toString() ?? ''}`;
    if (last.current === key) return;
    last.current = key;
    const route = routeTemplateOf(pathname);
    analytics.track('navigation.page.viewed', {
      route,
      service: serviceOfRoute(route),
      ...(previousRoute.current ? { referrerRoute: previousRoute.current } : {}),
    });
    previousRoute.current = route;
  }, [pathname, search]);

  return null;
}
