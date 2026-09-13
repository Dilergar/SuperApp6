'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  ANALYTICS_AREA_KEYS,
  ENTITLEMENT_REGISTRY,
  isEntitlementKey,
  type AnalyticsBreakdownBy,
  type AnalyticsQueryType,
  type AnalyticsTrendMetric,
} from '@superapp/shared';
import { useDayLabel, useFormatters } from '@/lib/format';

const PLATFORM_ORDER = ['web', 'ios', 'android', 'server'];

/**
 * Слова и числа раздела «Аналитика»: подписи областей, событий, тарифов, платформ,
 * метрик, проценты и дельты — одним местом. Слоты цвета — закреплены за СУЩНОСТЬЮ
 * (порядок областей реестра, фиксированный порядок платформ), а не за местом в рейтинге.
 */
export function useAnalyticsText() {
  const t = useTranslations('analytics');
  const te = useTranslations('entitlements');
  const f = useFormatters();
  const dayLabel = useDayLabel();

  return useMemo(() => {
    const area = (k: string) => (t.has(`areas.${k}`) ? t(`areas.${k}`) : k);
    const event = (k: string) => (t.has(`events.${k}.title`) ? t(`events.${k}.title`) : k);
    const eventDescription = (k: string) => (t.has(`events.${k}.description`) ? t(`events.${k}.description`) : '');
    /** Подпись шага воронки: одно событие — его название; «любое из» — перечисление с союзом «или» языка */
    const stepLabel = (s: { eventKey: string; orEventKeys?: string[] }) =>
      s.orEventKeys?.length ? f.list([s.eventKey, ...s.orEventKeys].map(event), 'disjunction') : event(s.eventKey);
    const plan = (k: string) => (k === 'none' ? t('plans.none') : te.has(`plans.${k}`) ? te(`plans.${k}`) : k);
    const platform = (k: string) => (t.has(`platforms.${k}`) ? t(`platforms.${k}`) : k);
    const entitlementKey = (k: string) => (isEntitlementKey(k) ? te(ENTITLEMENT_REGISTRY[k].labelKey.replace(/^entitlements\./, '')) : k);
    const metric = (m: AnalyticsTrendMetric) => t(`metrics.${m}`);
    const queryType = (q: AnalyticsQueryType) => t(`types.${q}`);
    const number = (v: number) => f.number(v, { maximumFractionDigits: Math.abs(v) < 10 ? 2 : 0 });
    const percent = (share: number) => t('format.percent', { value: f.number(share * 100, { maximumFractionDigits: Math.abs(share) < 0.1 ? 1 : 0 }) });
    const seconds = (v: number) => t('format.seconds', { value: f.number(v, { maximumFractionDigits: 0 }) });
    const delta = (current: number | null, previous: number | null): { text: string; direction: 'up' | 'down' | 'flat' } | null => {
      if (current === null || previous === null) return null;
      if (previous === 0) return current === 0 ? { text: percent(0), direction: 'flat' } : null;
      const change = (current - previous) / Math.abs(previous);
      const direction = Math.abs(change) < 0.005 ? 'flat' : change > 0 ? 'up' : 'down';
      return { text: percent(Math.abs(change)), direction };
    };
    const period = (ymd: string, interval: 'day' | 'week' | 'month' = 'day') =>
      interval === 'month' ? `${f.month(ymd)}` : interval === 'week' ? f.date(ymd, 'short') : dayLabel(ymd);
    const shortDay = (ymd: string) => f.date(ymd, 'short');

    /** Подпись ключа разбиения. */
    const keyLabel = (by: AnalyticsBreakdownBy | 'workspace' | 'plan' | 'platform' | 'service', key: string) => {
      if (key === 'total') return t('series.total');
      if (key === 'other') return t('series.other');
      switch (by) {
        case 'service':
          return area(key);
        case 'plan':
          return plan(key);
        case 'platform':
          return platform(key);
        case 'workspace':
          return key === 'personal' ? t('context.personalSpaces') : t('context.workspaceShort', { id: key.slice(0, 8) });
        case 'event':
          return event(key);
        case 'denied_key':
          return entitlementKey(key);
        default:
          return key;
      }
    };

    /** Слот цвета сущности: области — порядок реестра, платформы — фиксированный порядок. */
    const preferredSlot = (by: string | undefined, key: string): number => {
      if (key === 'total') return 0;
      if (key === 'other') return 5;
      if (by === 'service') return Math.max(0, ANALYTICS_AREA_KEYS.indexOf(key as never));
      if (by === 'platform') return Math.max(0, PLATFORM_ORDER.indexOf(key));
      let h = 0;
      for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return h;
    };
    /** Разложить ключи по слотам без совпадений (≤ 6 серий). */
    const slotsFor = (by: string | undefined, keys: string[]): Map<string, number> => {
      const used = new Set<number>();
      const out = new Map<string, number>();
      for (const key of [...keys].sort((a, b) => preferredSlot(by, a) - preferredSlot(by, b))) {
        let s = preferredSlot(by, key) % 6;
        for (let i = 0; i < 6 && used.has(s); i++) s = (s + 1) % 6;
        used.add(s);
        out.set(key, s);
      }
      return out;
    };

    return { t, area, event, eventDescription, stepLabel, plan, platform, entitlementKey, metric, queryType, number, percent, seconds, delta, period, shortDay, keyLabel, slotsFor };
  }, [t, te, f, dayLabel]);
}

export type AnalyticsText = ReturnType<typeof useAnalyticsText>;
