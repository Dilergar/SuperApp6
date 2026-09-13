'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { AnalyticsReportDto, AnalyticsTile, AnalyticsTrendResultDto } from '@superapp/shared';
import { Alert, Button, Card, CardHeader, Menu, SegmentedControl, Skeleton, Sparkline, StatTile, type MenuAction } from '@/components/ui';
import { analyticsQueryKey, runAnalyticsQuery } from '@/lib/platform/analytics';
import { ReportViz, defaultViz } from './ReportViz';
import { useAnalyticsParams } from './useAnalyticsParams';
import { useAnalyticsText, type AnalyticsText } from './useAnalyticsText';

export function reportTitle(r: Pick<AnalyticsReportDto, 'title' | 'systemKey'>, t: AnalyticsText['t']): string {
  if (r.systemKey && t.has(`system.reports.${r.systemKey}`)) return t(`system.reports.${r.systemKey}`);
  return r.title ?? '';
}

const scrollToControls = () => window.scrollTo({ top: 0, behavior: 'smooth' });

/**
 * Плитка дашборда — свой запрос, свой скелет, своя ошибка с «повторить»: медленная
 * воронка не задерживает соседей. Повторная загрузка держит прошлую картинку
 * приглушённой (без мигания скелетом). Воронка длиннее 90 дней — «считаем…», плитка
 * сама дозаполняется, когда фоновый расчёт готов. Удержание переключается «кривая ↔
 * когортная сетка» прямо в плитке: это один и тот же ответ запроса, второй не нужен.
 */
export function ReportTile({ report, tile, menu }: { report: AnalyticsReportDto; tile: AnalyticsTile; menu?: MenuAction[] }) {
  const t = useTranslations('analytics');
  const tc = useTranslations('common');
  const text = useAnalyticsText();
  const params = useAnalyticsParams();
  const router = useRouter();
  const baseViz = tile.viz ?? report.viz ?? defaultViz(report.query);
  const switchable = report.query.type === 'retention' && (baseViz === 'curve' || baseViz === 'cohort');
  const [view, setView] = useState<'curve' | 'cohort'>(baseViz === 'cohort' ? 'cohort' : 'curve');
  const viz = switchable ? view : baseViz;
  const q = params.apply(report.query, { forceCompare: viz === 'stat' });
  const query = useQuery({
    queryKey: analyticsQueryKey(q),
    queryFn: () => runAnalyticsQuery(q),
    placeholderData: keepPreviousData,
    refetchInterval: (state) => (state.state.data?.status === 'pending' ? 4000 : false),
    retry: 1,
  });
  const title = reportTitle(report, t);
  const openReport = () => router.push(params.href(`/platform/analytics/reports/${report.id}`));
  const items: MenuAction[] = menu ?? [{ key: 'open', label: t('tile.openReport'), icon: 'external', onClick: openReport }];
  const actions = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {switchable && (
        <SegmentedControl<'curve' | 'cohort'>
          aria-label={t('tile.view')}
          value={view}
          onChange={setView}
          items={[
            { key: 'curve', label: t('viz.curve') },
            { key: 'cohort', label: t('viz.cohort') },
          ]}
        />
      )}
      <Menu items={items} label={t('tile.actions')} />
    </span>
  );

  const failed = query.isError && !query.data;
  const loading = query.isPending;
  const dimmed = query.isFetching && !query.isPending;

  if (viz === 'stat' && !menu && query.data?.status === 'ready' && query.data.result.type === 'trend') {
    const r = query.data.result as AnalyticsTrendResultDto;
    const fmt = r.metric === 'stickiness' ? text.percent : r.metric === 'session_p50' ? text.seconds : text.number;
    const d = text.delta(r.current, r.previousValue);
    const values = (r.series[0]?.points ?? []).map((p) => p.value ?? 0);
    return (
      <StatTile
        span={tile.span}
        label={title}
        value={r.current === null ? '—' : fmt(r.current)}
        onClick={openReport}
        delta={d ? { text: d.text, direction: d.direction, good: true, title: t('tile.deltaHint') } : undefined}
        sparkline={values.length > 1 ? <Sparkline values={values} /> : undefined}
      />
    );
  }

  return (
    <Card span={tile.span} style={{ minWidth: 0 }}>
      <CardHeader title={title} actions={actions} />
      {loading ? (
        <Skeleton height={viz === 'stat' ? 64 : 180} />
      ) : failed ? (
        <Alert tone="danger" action={<Button size="sm" variant="outline" icon="refresh" onClick={() => void query.refetch()}>{tc('actions.retry')}</Button>}>
          {t('tile.failed')}
        </Alert>
      ) : query.data ? (
        viz === 'stat' && query.data.status === 'ready' && query.data.result.type === 'trend' ? (
          <div className={dimmed ? 'ui-chart-refetch' : undefined} style={{ fontFamily: 'var(--font-display)', fontSize: '1.875rem', fontWeight: 800 }}>
            {query.data.result.current === null ? '—' : text.number(query.data.result.current)}
          </div>
        ) : (
          <ReportViz
            response={query.data}
            query={q}
            viz={viz}
            title={title}
            text={text}
            dimmed={dimmed}
            onChangePeriod={scrollToControls}
            onIsolate={(by, key) => {
              if (by === 'platform') params.update({ platform: key });
              else if (by === 'workspace' && key !== 'personal') params.update({ ws: key, ctx: 'workspace' });
            }}
          />
        )
      ) : null}
    </Card>
  );
}
