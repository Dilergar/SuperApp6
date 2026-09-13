'use client';

import { useTranslations } from 'next-intl';
import {
  ANALYTICS_PRODUCT_AREAS,
  type AnalyticsQueryInput,
  type AnalyticsQueryResponseDto,
  type AnalyticsQueryResultDto,
  type AnalyticsViz,
} from '@superapp/shared';
import {
  BarChart,
  Button,
  Chip,
  CohortGrid,
  EmptyState,
  FunnelChart,
  LineChart,
  ScatterLabeled,
  Spinner,
  StackedBars,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Tooltip,
  type LineSeries,
} from '@/components/ui';
import type { AnalyticsText } from './useAnalyticsText';

/** Вид по умолчанию для типа запроса. */
export function defaultViz(q: AnalyticsQueryInput): AnalyticsViz {
  switch (q.type) {
    case 'trend':
      return 'line';
    case 'funnel':
      return 'funnel';
    case 'retention':
      return 'curve';
    case 'lifecycle':
      return 'stack';
    case 'adoption':
      return q.byPlan ? 'table' : 'bar';
    default:
      return 'bar';
  }
}

/** Пустой ли результат (за период событий нет). */
export function isEmptyResult(r: AnalyticsQueryResultDto): boolean {
  switch (r.type) {
    case 'trend':
      return r.series.every((s) => s.points.every((p) => !p.value));
    case 'funnel':
      return (r.steps[0]?.count ?? 0) === 0;
    case 'retention':
      return r.cohorts.length === 0;
    case 'breakdown':
      return r.rows.length === 0;
    case 'lifecycle':
      return r.buckets.every((b) => b.new + b.current + b.resurrected + b.dormant === 0);
    case 'adoption':
      // Активные могли касаться только служебных областей (вход, профиль) — сервисов нет
      return r.activeTotal === 0 || r.services.length === 0;
    case 'journeys':
      return r.pairs.length === 0;
  }
}

/**
 * Результат запроса → график кита. ОДИН компонент на плитку дашборда и предпросмотр
 * конструктора: что собрал человек, то и увидит на дашборде.
 */
export function ReportViz({
  response,
  query,
  viz,
  title,
  text,
  dimmed,
  onIsolate,
  onChangePeriod,
}: {
  response: AnalyticsQueryResponseDto;
  query: AnalyticsQueryInput;
  viz: AnalyticsViz;
  title: string;
  text: AnalyticsText;
  dimmed?: boolean;
  onIsolate?: (by: string, key: string) => void;
  onChangePeriod?: () => void;
}) {
  const t = useTranslations('analytics');
  const tc = useTranslations('common');
  if (response.status === 'pending') {
    return (
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: 'var(--spacing-8) 0', justifyContent: 'center' }}>
        <Spinner />
        <span className="body-sm">{t('tile.pending')}</span>
      </div>
    );
  }
  const r = response.result;
  if (isEmptyResult(r)) {
    return (
      <EmptyState
        icon="chart"
        title={t('tile.empty')}
        action={onChangePeriod ? <Button size="sm" variant="outline" icon="calendar" onClick={onChangePeriod}>{t('tile.changePeriod')}</Button> : undefined}
      />
    );
  }
  const maskedHint = t('tile.maskedHint', { k: response.meta.kAnon });
  const barColumns = (value: string): [string, string] => [title, value];

  switch (r.type) {
    case 'trend': {
      const by = query.type === 'trend' ? query.breakdown : undefined;
      const fmt = r.metric === 'stickiness' ? (v: number) => text.percent(v) : r.metric === 'session_p50' ? text.seconds : text.number;
      const slots = text.slotsFor(by, r.series.map((s) => s.key));
      const labelOf = (key: string) => (key === 'total' ? text.metric(r.metric) : text.keyLabel(by ?? 'service', key));
      if (viz === 'bar') {
        return (
          <BarChart
            ariaLabel={title}
            columns={barColumns(text.metric(r.metric))}
            maskedHint={maskedHint}
            formatValue={fmt}
            dimmed={dimmed}
            rows={r.series.map((s) => ({ key: s.key, label: labelOf(s.key), text: labelOf(s.key), value: s.total, masked: s.masked }))}
          />
        );
      }
      const labels = (r.series[0]?.points ?? []).map((p) => text.period(p.period, r.interval));
      const series: LineSeries[] = r.series.map((s) => ({ key: s.key, label: labelOf(s.key), slot: slots.get(s.key) ?? 0, values: s.points.map((p) => p.value) }));
      for (const prev of r.previous ?? []) {
        series.push({ key: `prev:${prev.key}`, label: `${labelOf(prev.key)} · ${tc('charts.previous')}`, slot: prev.key === 'total' ? 5 : (slots.get(prev.key) ?? 0), values: prev.points.map((p) => p.value), dashed: true });
      }
      return <LineChart ariaLabel={title} labels={labels} series={series} formatValue={fmt} dimmed={dimmed} integer={r.metric !== 'stickiness' && r.metric !== 'session_p50'} onIsolate={by && onIsolate ? (key) => !key.startsWith('prev:') && onIsolate(by, key) : undefined} />;
    }

    case 'lifecycle':
      return (
        <StackedBars
          ariaLabel={title}
          dimmed={dimmed}
          formatValue={text.number}
          labels={r.buckets.map((b) => text.period(b.period, r.interval))}
          segments={[
            { key: 'new', label: t('lifecycle.new'), slot: 0, values: r.buckets.map((b) => b.new) },
            { key: 'current', label: t('lifecycle.current'), slot: 1, values: r.buckets.map((b) => b.current) },
            { key: 'resurrected', label: t('lifecycle.resurrected'), slot: 2, values: r.buckets.map((b) => b.resurrected) },
            { key: 'dormant', label: t('lifecycle.dormant'), slot: 3, values: r.buckets.map((b) => b.dormant), negative: true },
          ]}
        />
      );

    case 'funnel': {
      const breakdownBy = query.type === 'funnel' ? query.breakdown : undefined;
      return (
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <FunnelChart
            ariaLabel={title}
            dimmed={dimmed}
            steps={r.steps.map((s, i) => ({ key: `${i}`, label: text.stepLabel(s), count: s.count, fromPrevious: s.fromPrevious, fromStart: s.fromStart, previousCount: s.previousCount }))}
            biggestDropIndex={r.biggestDropIndex}
            formatNumber={text.number}
            formatPercent={text.percent}
            dropLabel={(share) => t('format.drop', { value: text.percent(share) })}
            columns={[t('funnel.step'), t(r.unit === 'workspace' ? 'units.workspace' : 'units.user'), t('funnel.fromStart')]}
          />
          {r.breakdown && breakdownBy && r.breakdown.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <Table
                lines
                columns={[
                  { key: 'k', label: t(`breakdown.${breakdownBy}`), width: 'minmax(8rem, 1.4fr)' },
                  ...r.steps.map((s, i) => ({ key: `s${i}`, label: text.stepLabel(s), align: 'end' as const, width: 'minmax(5rem, 1fr)' })),
                ]}
              >
                <TableHeader
                  columns={[
                    { key: 'k', label: t(`breakdown.${breakdownBy}`) },
                    ...r.steps.map((s, i) => ({ key: `s${i}`, label: text.stepLabel(s), align: 'end' as const })),
                  ]}
                />
                {r.breakdown.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell>{text.keyLabel(breakdownBy, row.key)}</TableCell>
                    {row.counts.map((c, i) => (
                      <TableCell key={i} align="end">
                        {c === null ? (
                          <Tooltip content={maskedHint}>
                            <span tabIndex={0}>—</span>
                          </Tooltip>
                        ) : (
                          text.number(c)
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </Table>
            </div>
          )}
        </div>
      );
    }

    case 'retention': {
      const colLabel = (c: string) => (r.mode === 'bracket' ? t('retention.bracket', { range: c }) : t('retention.day', { n: c }));
      // Все когорты скрыты (людей меньше k): пустые оси читались бы как «никто не вернулся»
      if (viz !== 'cohort' && r.curve.every((v) => v === null)) {
        return <EmptyState icon="lock" title={t('tile.maskedTitle')} description={maskedHint} />;
      }
      if (viz === 'cohort') {
        return (
          <CohortGrid
            ariaLabel={title}
            dimmed={dimmed}
            columns={r.columns.map((c) => c)}
            rows={r.cohorts.map((c) => ({ key: c.cohort, label: text.shortDay(c.cohort), size: c.size, masked: c.masked, values: c.values }))}
            formatNumber={text.number}
            formatPercent={text.percent}
            maskedHint={maskedHint}
            headers={{ cohort: t('retention.cohort'), size: t(r.unit === 'workspace' ? 'units.workspace' : 'units.user') }}
          />
        );
      }
      return (
        <LineChart
          ariaLabel={title}
          dimmed={dimmed}
          labels={r.columns.map(colLabel)}
          formatValue={(v) => text.percent(v / 100)}
          series={[{ key: 'curve', label: t('retention.curve'), slot: 0, values: r.curve.map((v) => (v === null ? null : v * 100)) }]}
        />
      );
    }

    case 'breakdown': {
      const rows = r.rows.map((row) => ({
        key: row.key,
        label: text.keyLabel(r.by, row.key),
        text: text.keyLabel(r.by, row.key),
        value: row.value,
        previous: row.previous,
        masked: row.masked,
      }));
      if (r.other !== null) rows.push({ key: 'other', label: text.keyLabel(r.by, 'other'), text: text.keyLabel(r.by, 'other'), value: r.other, previous: null, masked: false });
      return (
        <BarChart
          ariaLabel={title}
          dimmed={dimmed}
          rows={rows}
          formatValue={text.number}
          maskedHint={maskedHint}
          previousLabel={query.compare ? tc('charts.previous') : undefined}
          columns={barColumns(t(`breakdownMetrics.${r.metric}${r.perActiveWorkspace ? 'PerWorkspace' : ''}`))}
        />
      );
    }

    case 'adoption': {
      if (viz === 'scatter') {
        return (
          <ScatterLabeled
            ariaLabel={title}
            dimmed={dimmed}
            xLabel={t('adoption.share')}
            yLabel={t('adoption.medianDays')}
            formatX={(v) => text.percent(v / 100)}
            formatY={(v) => t('format.days', { value: text.number(v) })}
            points={r.services
              .filter((s) => s.share !== null)
              .map((s) => ({ key: s.service, label: text.area(s.service), slot: ANALYTICS_PRODUCT_AREAS.indexOf(s.service), x: (s.share ?? 0) * 100, y: s.medianDays ?? 0 }))}
          />
        );
      }
      if (viz === 'table' && r.byPlan) {
        const services = ANALYTICS_PRODUCT_AREAS.filter((a) => r.byPlan!.some((p) => p.services.some((s) => s.service === a && (s.active ?? 0) > 0))).slice(0, 6);
        const columns = [
          { key: 'plan', label: t('breakdown.plan'), width: 'minmax(8rem, 1.2fr)' },
          { key: 'active', label: t(r.unit === 'workspace' ? 'adoption.activeWorkspaces' : 'adoption.activePeople'), align: 'end' as const, width: 'minmax(5rem, 1fr)' },
          ...services.map((s) => ({ key: s, label: text.area(s), align: 'end' as const, width: 'minmax(5rem, 1fr)' })),
        ];
        return (
          <div style={{ overflowX: 'auto' }}>
            <Table lines columns={columns}>
              <TableHeader columns={columns} />
              {r.byPlan.map((p) => (
                <TableRow key={p.planKey}>
                  <TableCell>
                    <span style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center' }}>
                      {text.plan(p.planKey)}
                      {p.masked && (
                        <Tooltip content={maskedHint}>
                          <span tabIndex={0}>
                            <Chip size="sm" tone="neutral" icon="lock">{t('tile.masked')}</Chip>
                          </span>
                        </Tooltip>
                      )}
                    </span>
                  </TableCell>
                  <TableCell align="end">{p.activeTotal === null ? '—' : text.number(p.activeTotal)}</TableCell>
                  {services.map((s) => {
                    const cell = p.services.find((x) => x.service === s);
                    return (
                      <TableCell key={s} align="end">
                        {cell?.share === null || cell?.share === undefined ? '—' : text.percent(cell.share)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </Table>
          </div>
        );
      }
      return (
        <BarChart
          ariaLabel={title}
          dimmed={dimmed}
          formatValue={(v) => text.percent(v / 100)}
          maskedHint={maskedHint}
          previousLabel={query.compare ? tc('charts.previous') : undefined}
          columns={barColumns(t('adoption.share'))}
          rows={r.services.map((s) => ({
            key: s.service,
            label: text.area(s.service),
            text: text.area(s.service),
            value: s.share === null ? null : s.share * 100,
            previous: s.previousShare === null ? null : s.previousShare * 100,
            masked: s.masked,
          }))}
        />
      );
    }

    case 'journeys':
      return (
        <BarChart
          ariaLabel={title}
          dimmed={dimmed}
          formatValue={text.number}
          maskedHint={maskedHint}
          columns={barColumns(t('journeys.moves'))}
          rows={r.pairs.map((p) => {
            const label = t('journeys.pair', { from: text.area(p.from), to: text.area(p.to) });
            return { key: `${p.from}>${p.to}`, label, text: label, value: p.count, masked: p.masked };
          })}
        />
      );
  }
}
