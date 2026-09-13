'use client';

import { useTranslations } from 'next-intl';
import type { AnalyticsActivityPanelDto } from '@superapp/shared';
import { Button, Chip, TickBar } from '@/components/ui';
import { useDayLabel } from '@/lib/format';
import { useAnalyticsText } from './useAnalyticsText';

/**
 * Панель «Активность» карточки 360 — ТОЛЬКО агрегаты за 28 дней: последняя активность,
 * активные дни фирменным штриховым прогрессом, сервисы и платформы по дням, упоры в
 * тариф по ключу со ссылкой на панель тарифов той же карточки; у организации — активные
 * участники и доля по сервисам. Ни одной строки-события: это не лента действий человека.
 */
export function ActivityPanel({ data, onOpenPlans }: { data: AnalyticsActivityPanelDto; /** Показать панель тарифов карточки (нет панели — нет ссылки) */ onOpenPlans?: () => void }) {
  const t = useTranslations('analytics');
  const text = useAnalyticsText();
  const dayLabel = useDayLabel();
  const row = (label: string, body: React.ReactNode) => (
    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span className="label-caps" style={{ minWidth: '9rem' }}>{label}</span>
      <span style={{ display: 'inline-flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>{body}</span>
    </div>
  );
  return (
    <div className="ui-stack" style={{ gap: '0.625rem' }}>
      <p className="label-sm" style={{ margin: 0 }}>{t('panel.subtitle')}</p>
      {row(t('panel.lastActive'), <span className="body-sm">{data.lastActiveDay ? dayLabel(data.lastActiveDay) : t('panel.never')}</span>)}
      <TickBar value={(data.activeDays28 / 28) * 100} label={t('panel.activeDays', { days: data.activeDays28 })} aria-label={t('panel.activeDays', { days: data.activeDays28 })} />
      {data.members && row(t('panel.members'), <span className="body-sm">{t('panel.membersActive', { active: data.members.active28, total: data.members.total })}</span>)}
      {row(
        t('panel.services'),
        data.topServices28.length ? data.topServices28.map((s) => <Chip key={s.service} size="sm" tone="neutral">{t('panel.serviceDays', { name: text.area(s.service), days: s.days })}</Chip>) : <span className="label-sm">{t('panel.none')}</span>,
      )}
      {data.adoption28 && data.adoption28.length > 0 &&
        row(t('panel.adoption'), data.adoption28.map((a) => <Chip key={a.service} size="sm" tone="neutral">{`${text.area(a.service)} · ${text.percent(a.share)}`}</Chip>))}
      {row(
        t('panel.platforms'),
        data.platforms28.length ? data.platforms28.map((p) => <Chip key={p.platform} size="sm" tone="neutral">{t('panel.serviceDays', { name: text.platform(p.platform), days: p.days })}</Chip>) : <span className="label-sm">{t('panel.none')}</span>,
      )}
      {row(
        t('panel.denied'),
        data.deniedKeys28.length ? (
          <>
            {data.deniedKeys28.map((d) => <Chip key={d.key} size="sm" tone="warning" icon="lock">{t('panel.deniedCount', { name: text.entitlementKey(d.key), count: d.count })}</Chip>)}
            {onOpenPlans && <Button size="sm" variant="ghost" icon="arrowUp" onClick={onOpenPlans}>{t('panel.openPlans')}</Button>}
          </>
        ) : (
          <span className="label-sm">{t('panel.noDenied')}</span>
        ),
      )}
    </div>
  );
}
