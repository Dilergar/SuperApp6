'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ANALYTICS_LIMITS, type AnalyticsPlatform, type AnalyticsQueryInput, type AnalyticsRange } from '@superapp/shared';

// ============================================================
// Состояние панели управления раздела — ТОЛЬКО в адресе (`?range=28d&compare=1&ws=…`):
// ссылку можно отправить коллеге, «назад» работает, дашборд и конструктор читают одни
// и те же параметры. Изменение — `router.push` (каждый шаг — запись истории).
// ============================================================

export const RANGE_PRESETS = ['7d', '28d', '90d', '12m', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export type ContextFilter = 'all' | 'personal' | 'workspace';

const PRESET_DAYS: Record<Exclude<RangePreset, 'custom'>, number> = { '7d': 7, '28d': 28, '90d': 90, '12m': 365 };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORMS: AnalyticsPlatform[] = ['web', 'ios', 'android', 'server'];

/** Сегодня по часам устройства — `YYYY-MM-DD` без литерала локали. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysIn = (r: AnalyticsRange) => Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) + 1;

/** Сравнение с прошлым периодом имеет смысл не у всех видов запроса. */
const COMPARABLE = new Set<AnalyticsQueryInput['type']>(['trend', 'funnel', 'breakdown', 'adoption']);

export interface AnalyticsParams {
  preset: RangePreset;
  range: AnalyticsRange;
  compare: boolean;
  context: ContextFilter;
  workspaceId: string | null;
  platform: AnalyticsPlatform | 'all';
  includeInternal: boolean;
  /** Строка запроса текущего состояния — для ссылок между страницами раздела */
  search: string;
  update: (patch: Record<string, string | null>) => void;
  /** Подставить состояние панели в запрос отчёта */
  apply: (q: AnalyticsQueryInput, opts?: { forceCompare?: boolean }) => AnalyticsQueryInput;
  href: (path: string) => string;
}

export function useAnalyticsParams(): AnalyticsParams {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const search = sp?.toString() ?? '';

  return useMemo(() => {
    const get = (k: string) => sp?.get(k) ?? null;
    const rawPreset = get('range');
    const preset: RangePreset = (RANGE_PRESETS as readonly string[]).includes(rawPreset ?? '') ? (rawPreset as RangePreset) : '28d';
    const today = localToday();
    let range: AnalyticsRange;
    const from = get('from');
    const to = get('to');
    if (preset === 'custom' && from && to && DAY_RE.test(from) && DAY_RE.test(to) && from <= to) {
      range = { from, to };
      if (daysIn(range) > ANALYTICS_LIMITS.queryMaxRangeDays) range = { from: addDays(to, -(ANALYTICS_LIMITS.queryMaxRangeDays - 1)), to };
    } else {
      const n = PRESET_DAYS[preset === 'custom' ? '28d' : preset];
      range = { from: addDays(today, -(n - 1)), to: today };
    }
    const ctx = get('ctx');
    const context: ContextFilter = ctx === 'personal' || ctx === 'workspace' ? ctx : 'all';
    const ws = get('ws');
    const workspaceId = ws && UUID_RE.test(ws) ? ws : null;
    const p = get('platform');
    const platform = PLATFORMS.includes(p as AnalyticsPlatform) ? (p as AnalyticsPlatform) : 'all';
    const includeInternal = get('internal') === '1';
    const compare = get('compare') === '1';

    const update = (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.push(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    };

    const apply = (q: AnalyticsQueryInput, opts: { forceCompare?: boolean } = {}): AnalyticsQueryInput => {
      const { context: _c, workspaceId: _w, platforms: _p, ...rest } = q.filters ?? {};
      let r = range;
      // Переходы между сервисами считаются по сырью не дальше 90 дней — берём хвост периода
      if (q.type === 'journeys' && daysIn(r) > ANALYTICS_LIMITS.journeysMaxDays) r = { from: addDays(r.to, -(ANALYTICS_LIMITS.journeysMaxDays - 1)), to: r.to };
      return {
        ...q,
        range: r,
        // Сравнение, объявленное самим отчётом («активные по дням» с пунктиром прошлого
        // периода), тумблер панели не выключает — только добавляет остальным
        compare: COMPARABLE.has(q.type) && (compare || q.compare || !!opts.forceCompare),
        excludeInternal: !includeInternal,
        filters: {
          ...rest,
          ...(workspaceId ? { workspaceId } : context !== 'all' ? { context } : {}),
          ...(platform !== 'all' ? { platforms: [platform] } : {}),
        },
      } as AnalyticsQueryInput;
    };

    const href = (path: string) => `${path}${search ? `?${search}` : ''}`;

    return { preset, range, compare, context, workspaceId, platform, includeInternal, search, update, apply, href };
  }, [sp, search, router, pathname]);
}

/** Хук-обёртка для колбэка обновления (стабильная ссылка в эффектах). */
export function useUpdateParams() {
  const params = useAnalyticsParams();
  return useCallback((patch: Record<string, string | null>) => params.update(patch), [params]);
}
