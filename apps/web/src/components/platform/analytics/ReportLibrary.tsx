'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ANALYTICS_QUERY_TYPES, type AnalyticsQueryType, type AnalyticsReportDto } from '@superapp/shared';
import { BentoGrid, Card, CardHeader, Chip, EmptyState, LoadingBlock, SearchField, Select, Sparkline } from '@/components/ui';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { analyticsQueryKey, analyticsReportsKey, fetchAnalyticsReports, runAnalyticsQuery } from '@/lib/platform/analytics';
import { reportTitle } from './ReportTile';
import { useAnalyticsParams } from './useAnalyticsParams';

/** Библиотека отчётов: поиск, тип, автор; карточка с мини-графиком для трендов. */
export function ReportLibrary() {
  const t = useTranslations('analytics');
  const router = useRouter();
  const params = useAnalyticsParams();
  const { me } = usePlatformAuth();
  const reports = useQuery({ queryKey: analyticsReportsKey, queryFn: fetchAnalyticsReports });
  const [search, setSearch] = useState('');
  const [type, setType] = useState<AnalyticsQueryType | 'all'>('all');
  const [author, setAuthor] = useState<'all' | 'mine'>('all');

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (reports.data ?? [])
      .filter((r) => type === 'all' || r.query.type === type)
      .filter((r) => author === 'all' || r.createdBy === me?.userId)
      .map((r) => ({ r, title: reportTitle(r, t) }))
      .filter((x) => !needle || x.title.toLowerCase().includes(needle));
  }, [reports.data, type, author, search, me?.userId, t]);

  if (reports.isPending) return <LoadingBlock />;

  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--spacing-4)' }}>
        <SearchField width="18rem" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} placeholder={t('library.search')} aria-label={t('library.search')} />
        <Select<string>
          width="12rem"
          value={type}
          onChange={(v) => setType(v as AnalyticsQueryType | 'all')}
          options={[{ value: 'all', label: t('library.allTypes') }, ...ANALYTICS_QUERY_TYPES.map((q) => ({ value: q, label: t(`types.${q}`) }))]}
          aria-label={t('library.type')}
        />
        <div role="group" aria-label={t('library.author')} style={{ display: 'flex', gap: '0.375rem' }}>
          {(['all', 'mine'] as const).map((a) => (
            <Chip key={a} size="sm" tone={author === a ? 'accent' : 'neutral'} selected={author === a} onClick={() => setAuthor(a)}>{t(`library.authors.${a}`)}</Chip>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="chart" title={t('library.empty')} />
      ) : (
        <BentoGrid>
          {rows.map(({ r, title }) => (
            <Card key={r.id} span={4} hoverable onClick={() => router.push(params.href(`/platform/analytics/reports/${r.id}`))}>
              <CardHeader title={title} />
              <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginBottom: 'var(--spacing-3)' }}>
                <Chip size="sm" tone="neutral">{t(`types.${r.query.type}`)}</Chip>
                {r.systemKey && <Chip size="sm" tone="neutral">{t('dashboards.system')}</Chip>}
                {r.visibility === 'private' && <Chip size="sm" tone="neutral" icon="lock">{t('library.private')}</Chip>}
              </div>
              {r.query.type === 'trend' && <TrendSparkline report={r} />}
            </Card>
          ))}
        </BentoGrid>
      )}
    </>
  );
}

function TrendSparkline({ report }: { report: AnalyticsReportDto }) {
  const params = useAnalyticsParams();
  const q = params.apply({ ...report.query, ...(report.query.type === 'trend' ? { breakdown: undefined } : {}) } as AnalyticsReportDto['query']);
  const res = useQuery({ queryKey: analyticsQueryKey(q), queryFn: () => runAnalyticsQuery(q), staleTime: 60_000 });
  const data = res.data;
  if (!data || data.status !== 'ready' || data.result.type !== 'trend') return <div style={{ height: 28 }} />;
  const values = (data.result.series[0]?.points ?? []).map((p) => p.value ?? 0);
  return <Sparkline values={values} />;
}
