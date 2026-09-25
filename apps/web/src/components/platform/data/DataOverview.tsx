'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { LifecycleDataOverviewDto } from '@superapp/shared';
import { BentoGrid, Button, Card, CardHeader, Chip, EmptyState, LineChart, StackedBars, TickBar, type StackSegment } from '@/components/ui';
import type { Formatters } from '@superapp/i18n/format';
import { useBytes, useFormatters } from '@/lib/format';
import { ATTENTION_TAB, Fact, LevelChip } from './data-ui';

/** Серий цвета шесть: пять крупнейших классов, хвост — в «Прочее» (DESIGN.md: седьмая серия цвет не получает). */
const MAX_SEGMENTS = 5;

/** Числа — как есть, момент (`at`) — датой зрителя: сервер шлёт ISO, в текст он не вставляется. */
function attentionParams(params: Record<string, string | number>, fmt: Formatters): Record<string, string | number> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, k === 'at' && typeof v === 'string' ? fmt.dateTime(v, 'short') : v]));
}

/**
 * Вкладка «Обзор» — «всё ли хорошо» за 5 секунд: шесть плиток-светофоров в фиксированном
 * порядке, рост хранилища по классам за 90 дней, удалено строк в сутки, лента «Нужно внимание».
 */
export function DataOverview({ data }: { data: LifecycleDataOverviewDto }) {
  const t = useTranslations('platformData');
  const tl = useTranslations('lifecycle');
  const fmt = useFormatters();
  const bytes = useBytes();

  const growth = useMemo(() => {
    const days = [...new Set(data.growth.map((g) => g.day))].sort();
    const total = new Map<string, number>();
    for (const g of data.growth) total.set(g.dataClass, (total.get(g.dataClass) ?? 0) + g.bytes);
    const classes = [...total.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const top = classes.slice(0, MAX_SEGMENTS);
    const segments: StackSegment[] = top.map((c, i) => ({
      key: c,
      label: c === 'unclassified' ? t('unclassified') : tl(`classes.${c}.title`),
      slot: i + 1,
      values: days.map((d) => data.growth.filter((g) => g.day === d && g.dataClass === c).reduce((a, g) => a + g.bytes, 0)),
    }));
    if (classes.length > MAX_SEGMENTS) {
      segments.push({
        key: 'other',
        label: t('other'),
        slot: 6,
        values: days.map((d) => data.growth.filter((g) => g.day === d && !top.includes(g.dataClass)).reduce((a, g) => a + g.bytes, 0)),
      });
    }
    return { labels: days.map((d) => fmt.date(d, 'short')), segments };
  }, [data.growth, fmt, t, tl]);

  const deleted = useMemo(
    () => ({ labels: data.deletedPerDay.map((d) => fmt.date(d.day, 'short')), values: data.deletedPerDay.map((d) => d.rows) }),
    [data.deletedPerDay, fmt],
  );

  const db = data.database;
  const bk = data.backups;
  return (
    <>
      <BentoGrid>
        <Card span={4}>
          <CardHeader title={t('tiles.database')} actions={<LevelChip level={db.level} />} />
          <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
            <TickBar value={(db.xidAge / db.xidLimit) * 100} tone={db.level === 'critical' ? 'danger' : db.level === 'warning' ? 'warning' : 'accent'} label={t('facts.xidAge', { millions: Math.round(db.xidAge / 1_000_000) })} />
            <Fact label={t('facts.size')} value={bytes(db.dbBytes)} />
            <Fact label={t('facts.connections')} value={`${fmt.number(db.connections)} / ${fmt.number(db.maxConnections)}`} />
            <Fact label={t('facts.replicas')} value={db.replicas ? t('facts.replicasLag', { count: db.replicas, seconds: Math.round(db.maxReplayLagSeconds) }) : t('facts.none')} />
          </div>
        </Card>
        <Card span={4}>
          <CardHeader title={t('tiles.backups')} actions={<LevelChip level={bk.level} />} />
          <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
            <TickBar value={(bk.coveredDays / bk.windowDays) * 100} tone={bk.level === 'critical' ? 'danger' : 'success'} label={t('facts.pitr', { covered: bk.coveredDays, window: bk.windowDays })} />
            <Fact label={t('facts.lastBackup')} value={bk.lastSuccessAt ? fmt.dateTime(bk.lastSuccessAt, 'short') : t('facts.never')} />
            <Fact
              label={t('facts.lastDrill')}
              value={bk.lastDrill ? <Chip size="sm" tone={bk.lastDrill.ok ? 'success' : 'danger'}>{fmt.date(bk.lastDrill.at)}</Chip> : t('facts.never')}
            />
            {bk.repos.length > 0 && <Fact label={t('facts.repos')} value={bk.repos.map((r) => r.repo).join(' · ')} />}
          </div>
        </Card>
        <Card span={4}>
          <CardHeader title={t('tiles.partitions')} actions={<LevelChip level={data.partitions.level} />} />
          <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
            <Fact label={t('facts.parents')} value={fmt.number(data.partitions.parents)} />
            <Fact label={t('facts.minAhead')} value={data.partitions.minAhead === null ? '—' : fmt.number(data.partitions.minAhead)} />
            <Fact label={t('facts.detachPending')} value={fmt.number(data.partitions.detachPending)} />
          </div>
        </Card>
        <Card span={4}>
          <CardHeader title={t('tiles.retention')} actions={<LevelChip level={data.retention.level} />} />
          <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
            <Fact label={t('facts.lagging')} value={fmt.number(data.retention.lagging)} />
            <Fact label={t('facts.maxLag')} value={tl('duration.days', { days: data.retention.maxLagDays })} />
            <Fact label={t('facts.nextRun')} value={fmt.dateTime(data.retention.nextRunAt, 'short')} />
          </div>
        </Card>
        <Card span={4}>
          <CardHeader title={t('tiles.erasure')} actions={<LevelChip level={data.erasure.level} />} />
          <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
            <Fact label={t('facts.queued')} value={fmt.number(data.erasure.queued)} />
            <Fact label={t('facts.stuck')} value={fmt.number(data.erasure.stuck)} />
            <Fact label={t('facts.held')} value={fmt.number(data.erasure.held)} />
            <Fact label={t('facts.avgToPurge')} value={data.erasure.avgDaysToHotPurge === null ? '—' : tl('duration.days', { days: Math.round(data.erasure.avgDaysToHotPurge) })} />
          </div>
        </Card>
        <Card span={4}>
          <CardHeader title={t('tiles.canary')} actions={<LevelChip level={data.canary.level} />} />
          <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
            <Fact label={t('facts.lastRun')} value={data.canary.lastRunAt ? fmt.dateTime(data.canary.lastRunAt, 'short') : t('facts.never')} />
            <Fact label={t('facts.findings')} value={fmt.number(data.canary.findings)} />
            <Fact label={t('facts.unseeded')} value={fmt.number(data.canary.unseeded)} />
          </div>
        </Card>

        <Card span={8}>
          <CardHeader title={t('charts.growth')} />
          {growth.labels.length ? (
            <StackedBars labels={growth.labels} segments={growth.segments} formatValue={(v) => bytes(v)} ariaLabel={t('charts.growth')} />
          ) : (
            <EmptyState icon="chart" title={t('charts.noSnapshots')} description={t('charts.noSnapshotsText')} />
          )}
        </Card>
        <Card span={4}>
          <CardHeader title={t('charts.deleted')} />
          {deleted.labels.length ? (
            <LineChart labels={deleted.labels} series={[{ key: 'rows', label: t('charts.rows'), slot: 1, values: deleted.values }]} formatValue={(v) => fmt.number(v)} ariaLabel={t('charts.deleted')} integer height={180} />
          ) : (
            <EmptyState icon="chart" title={t('charts.noDeletes')} />
          )}
        </Card>

        <Card span={12}>
          <CardHeader title={t('attention.title')} />
          {data.attention.length === 0 ? (
            <EmptyState icon="checkCircle" title={t('attention.empty')} />
          ) : (
            <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
              {data.attention.map((a, i) => (
                <div key={`${a.code}-${i}`} style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', minWidth: 0, flexWrap: 'wrap' }}>
                    <Chip size="sm" tone={a.severity === 'critical' ? 'danger' : 'warning'}>{t(`severity.${a.severity}`)}</Chip>
                    <span className="body-sm">{t(`attention.codes.${a.code}`, attentionParams(a.params, fmt))}</span>
                  </div>
                  <Button size="sm" variant="ghost" href={`/platform/data?tab=${ATTENTION_TAB[a.code]}`}>{t('attention.open')}</Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </BentoGrid>
    </>
  );
}
