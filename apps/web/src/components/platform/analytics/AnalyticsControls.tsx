'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { parsePlatformQuery, type AnalyticsQualityDto, opaqueIdTail } from '@superapp/shared';
import { Chip, DatePicker, SearchField, SegmentedControl, Select, Toggle } from '@/components/ui';
import { fetchPlatformLookup, platformLookupKey } from '@/lib/platform/api';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { RANGE_PRESETS, type RangePreset, useAnalyticsParams } from './useAnalyticsParams';

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/**
 * ОДНА панель управления на весь раздел (липкая под шапкой): период пресетами и свой,
 * сравнение с прошлым периодом, контекст (всё · личное · организации · одна организация
 * через поиск кабинета), платформа, внутренние аккаунты. Справа — «обновлено N мин назад
 * · пояс». Всё состояние — в адресе (useAnalyticsParams).
 */
export function AnalyticsControls({ quality }: { quality?: AnalyticsQualityDto | null }) {
  const t = useTranslations('analytics');
  const p = useAnalyticsParams();
  const { can } = usePlatformAuth();
  const [wsQuery, setWsQuery] = useState('');
  const [wsName, setWsName] = useState<string | null>(null);
  const parsed = parsePlatformQuery(wsQuery);
  const searchable = parsed.kind !== 'empty' && parsed.kind !== 'tooShort';
  const lookup = useQuery({
    queryKey: platformLookupKey(wsQuery.trim()),
    queryFn: () => fetchPlatformLookup(wsQuery.trim()),
    enabled: searchable && can('platform.lookup.read') && p.context === 'workspace' && !p.workspaceId,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const rollupAt = quality?.rollupAt ? Date.parse(quality.rollupAt) : null;
  const minutes = rollupAt ? Math.max(0, Math.round((now - rollupAt) / 60_000)) : null;

  return (
    <div
      className="ui-sticky-bar"
      style={{ padding: 'var(--spacing-3) 0', marginBottom: 'var(--spacing-4)', borderBottom: '1px solid var(--divider)' }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--spacing-3)' }}>
        <SegmentedControl<RangePreset>
          value={p.preset}
          onChange={(v) => p.update(v === 'custom' ? { range: v, from: p.range.from, to: p.range.to } : { range: v, from: null, to: null })}
          items={RANGE_PRESETS.map((k) => ({ key: k, label: t(`controls.presets.${k}`) }))}
          aria-label={t('controls.period')}
        />
        {p.preset === 'custom' && (
          <>
            <DatePicker width="10rem" label={t('controls.from')} value={parseYmd(p.range.from)} max={parseYmd(p.range.to)} onChange={(d) => d && p.update({ from: ymd(d) })} />
            <DatePicker width="10rem" label={t('controls.to')} value={parseYmd(p.range.to)} min={parseYmd(p.range.from)} onChange={(d) => d && p.update({ to: ymd(d) })} />
          </>
        )}
        <Toggle checked={p.compare} onChange={(v) => p.update({ compare: v ? '1' : null })} label={t('controls.compare')} />
        <div role="group" aria-label={t('controls.context')} style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {(['all', 'personal', 'workspace'] as const).map((c) => (
            <Chip key={c} size="sm" tone={c === p.context ? 'accent' : 'neutral'} selected={c === p.context} onClick={() => p.update({ ctx: c === 'all' ? null : c, ws: null })}>
              {t(`controls.contexts.${c}`)}
            </Chip>
          ))}
          {p.workspaceId && (
            <Chip size="sm" tone="accent" icon="workspace" onRemove={() => p.update({ ws: null })} removeLabel={t('controls.clearWorkspace')}>
              {wsName ?? t('context.workspaceShort', { id: opaqueIdTail(p.workspaceId, 8) })}
            </Chip>
          )}
        </div>
        <Select<string>
          width="11rem"
          value={p.platform}
          onChange={(v) => p.update({ platform: v === 'all' ? null : v })}
          options={['all', 'web', 'ios', 'android', 'server'].map((k) => ({ value: k, label: t(`platforms.${k}`) }))}
          aria-label={t('controls.platform')}
        />
        <Toggle checked={p.includeInternal} onChange={(v) => p.update({ internal: v ? '1' : null })} label={t('controls.internal')} />
        <span className="label-sm" style={{ marginInlineStart: 'auto' }}>
          {minutes === null
            ? t('controls.notUpdated', { timezone: quality?.timezone ?? '' })
            : minutes < 60
              ? t('controls.updatedMinutes', { minutes, timezone: quality?.timezone ?? '' })
              : t('controls.updatedHours', { hours: Math.round(minutes / 60), timezone: quality?.timezone ?? '' })}
        </span>
      </div>
      {p.context === 'workspace' && !p.workspaceId && can('platform.lookup.read') && (
        <div style={{ marginTop: 'var(--spacing-2)', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <SearchField width="22rem" value={wsQuery} onChange={(e) => setWsQuery(e.target.value)} onClear={() => setWsQuery('')} placeholder={t('controls.workspaceSearch')} aria-label={t('controls.workspaceSearch')} />
          {(lookup.data?.workspaces ?? []).map((w) => (
            <Chip
              key={w.id}
              size="sm"
              tone="neutral"
              icon="workspace"
              onClick={() => {
                setWsName(w.name);
                setWsQuery('');
                p.update({ ws: w.id });
              }}
            >
              {w.name}
            </Chip>
          ))}
        </div>
      )}
      {!p.includeInternal && <p className="label-sm" style={{ margin: 'var(--spacing-2) 0 0' }}>{t('controls.internalNote')}</p>}
    </div>
  );
}
