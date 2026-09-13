'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ANALYTICS_AREA_KEYS, type AnalyticsEventCatalogItemDto, type AnalyticsEventStatus, type PlatformCommandDto } from '@superapp/shared';
import {
  Alert,
  Button,
  Chip,
  EmptyState,
  LoadingBlock,
  SearchField,
  Sparkline,
  Table,
  TableCell,
  TableGroupRow,
  TableHeader,
  TableRow,
  Tabs,
  Toggle,
  type TableColumn,
  type Tone,
} from '@/components/ui';
import { CommandRunner } from '@/components/platform/CommandRunner';
import { analyticsEventsKey, analyticsQualityKey, fetchAnalyticsEvents, fetchAnalyticsQuality } from '@/lib/platform/analytics';
import { fetchPlatformCommands, platformCommandsKey } from '@/lib/platform/api';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { useDayLabel, useFormatters } from '@/lib/format';
import { useAnalyticsText } from './useAnalyticsText';

const STATUS_TONE: Record<AnalyticsEventStatus, Tone> = { live: 'success', planned: 'accent', deprecated: 'warning', blocked: 'neutral' };

/**
 * «Что мы измеряем»: каталог событий по сервисам (название и описание из каталога, ключ
 * мелко, класс, статус, источник, объём 14 дней, «последний раз») и карантин — неизвестные
 * ключи и нарушения схемы с подсказкой разработчику. Рубильник — команда реестра.
 */
export function EventCatalog() {
  const t = useTranslations('analytics');
  const text = useAnalyticsText();
  const f = useFormatters();
  const dayLabel = useDayLabel();
  const router = useRouter();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const { can } = usePlatformAuth();
  const tab = sp?.get('tab') === 'quarantine' ? 'quarantine' : 'catalog';
  const events = useQuery({ queryKey: analyticsEventsKey, queryFn: fetchAnalyticsEvents, enabled: tab === 'catalog' });
  const quality = useQuery({ queryKey: analyticsQualityKey, queryFn: fetchAnalyticsQuality });
  const commands = useQuery({ queryKey: platformCommandsKey, queryFn: fetchPlatformCommands, enabled: can('analytics.manage') });
  const [search, setSearch] = useState('');
  const [onlyNoData, setOnlyNoData] = useState(false);
  const [runner, setRunner] = useState<{ command: PlatformCommandDto; input: Record<string, unknown> } | null>(null);
  const setStatusCommand = (commands.data ?? []).find((c) => c.key === 'analytics.event.setStatus') ?? null;

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = (events.data ?? []).filter(
      (e) => (!onlyNoData || e.volume7d === 0) && (!needle || e.key.includes(needle) || text.event(e.key).toLowerCase().includes(needle)),
    );
    return ANALYTICS_AREA_KEYS.map((area) => ({ area, items: list.filter((e) => e.service === area) })).filter((g) => g.items.length);
  }, [events.data, search, onlyNoData, text]);

  const switchTab = (next: 'catalog' | 'quarantine') => {
    const qs = new URLSearchParams(sp?.toString() ?? '');
    if (next === 'quarantine') qs.set('tab', 'quarantine');
    else qs.delete('tab');
    router.push(`/platform/analytics/events${qs.toString() ? `?${qs}` : ''}`, { scroll: false });
  };

  const columns: TableColumn[] = [
    { key: 'event', label: t('catalog.columns.event'), width: 'minmax(14rem, 2fr)' },
    { key: 'class', label: t('catalog.columns.class'), width: 'max-content' },
    { key: 'status', label: t('catalog.columns.status'), width: 'max-content' },
    { key: 'source', label: t('catalog.columns.source'), width: 'max-content', hideOnMobile: true },
    { key: 'volume', label: t('catalog.columns.volume'), width: 'minmax(8rem, 1fr)' },
    { key: 'last', label: t('catalog.columns.lastSeen'), width: 'max-content', hideOnMobile: true },
    { key: 'action', label: '', width: 'max-content' },
  ];

  return (
    <>
      <div style={{ marginBottom: 'var(--spacing-4)' }}>
        <Tabs<'catalog' | 'quarantine'>
          value={tab}
          onChange={switchTab}
          items={[
            { key: 'catalog', label: t('catalog.tab'), icon: 'list' },
            { key: 'quarantine', label: t('quarantine.tab'), icon: 'warning', count: quality.data?.quarantine.length || undefined },
          ]}
          aria-label={t('catalog.title')}
        />
      </div>

      {tab === 'catalog' ? (
        events.isPending ? (
          <LoadingBlock />
        ) : (
          <>
            <div style={{ display: 'flex', gap: 'var(--spacing-4)', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--spacing-4)' }}>
              <SearchField width="20rem" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} placeholder={t('builder.findEvent')} aria-label={t('builder.findEvent')} />
              <Toggle checked={onlyNoData} onChange={setOnlyNoData} label={t('catalog.onlyNoData')} />
            </div>
            <div style={{ overflowX: 'auto' }}>
              <Table columns={columns} lines>
                <TableHeader columns={columns} />
                {groups.map((g) => (
                  <GroupRows key={g.area} label={text.area(g.area)} items={g.items}>
                    {(e) => (
                      <TableRow key={e.key}>
                        <TableCell>
                          <span style={{ display: 'block', minWidth: 0 }}>
                            <span className="body-sm" style={{ fontWeight: 700, display: 'block' }}>{text.event(e.key)}</span>
                            <span className="label-sm" style={{ display: 'block', whiteSpace: 'normal' }}>{text.eventDescription(e.key)}</span>
                            <code style={{ fontSize: '0.6875rem', color: 'var(--muted)' }}>{e.key}</code>
                          </span>
                        </TableCell>
                        <TableCell><Chip size="sm" tone="neutral">{t(`classes.${e.class}`)}</Chip></TableCell>
                        <TableCell><Chip size="sm" tone={STATUS_TONE[e.status]} icon={e.status === 'blocked' ? 'lock' : undefined}>{t(`statuses.${e.status}`)}</Chip></TableCell>
                        <TableCell hideOnMobile><span className="label-sm">{t(`sources.${e.source}`)}</span></TableCell>
                        <TableCell>
                          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                            <span style={{ flex: 1, minWidth: 60 }}><Sparkline values={e.volume14d} /></span>
                            <span className="label-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>{f.number(e.volume7d)}</span>
                          </span>
                        </TableCell>
                        <TableCell hideOnMobile><span className="label-sm">{e.lastSeenDay ? dayLabel(e.lastSeenDay) : t('catalog.never')}</span></TableCell>
                        <TableCell>
                          {setStatusCommand && (
                            <Button
                              size="sm"
                              variant="outline"
                              icon={e.status === 'blocked' ? 'play' : 'blocked'}
                              onClick={() => setRunner({ command: setStatusCommand, input: { eventKey: e.key, status: e.status === 'blocked' ? 'live' : 'blocked' } })}
                            >
                              {e.status === 'blocked' ? t('catalog.enable') : t('catalog.block')}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </GroupRows>
                ))}
              </Table>
            </div>
          </>
        )
      ) : quality.isPending ? (
        <LoadingBlock />
      ) : (
        <>
          <Alert tone="accent" icon="info">{t('quarantine.hint')}</Alert>
          {(quality.data?.quarantine.length ?? 0) === 0 ? (
            <EmptyState icon="checkCircle" title={t('quarantine.empty')} />
          ) : (
            <div style={{ overflowX: 'auto', marginTop: 'var(--spacing-4)' }}>
              <Table
                lines
                columns={[
                  { key: 'key', label: t('quarantine.columns.key'), width: 'minmax(12rem, 1.5fr)' },
                  { key: 'reason', label: t('quarantine.columns.reason'), width: 'max-content' },
                  { key: 'count', label: t('quarantine.columns.count'), width: 'max-content', align: 'end' },
                  { key: 'last', label: t('quarantine.columns.lastSeen'), width: 'max-content' },
                  { key: 'shape', label: t('quarantine.columns.shape'), width: 'minmax(10rem, 2fr)', hideOnMobile: true },
                ]}
              >
                <TableHeader
                  columns={[
                    { key: 'key', label: t('quarantine.columns.key') },
                    { key: 'reason', label: t('quarantine.columns.reason') },
                    { key: 'count', label: t('quarantine.columns.count'), align: 'end' },
                    { key: 'last', label: t('quarantine.columns.lastSeen') },
                    { key: 'shape', label: t('quarantine.columns.shape'), hideOnMobile: true },
                  ]}
                />
                {quality.data!.quarantine.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell><code style={{ fontSize: '0.75rem' }}>{q.eventKey}</code></TableCell>
                    <TableCell><Chip size="sm" tone={q.reason === 'pii' ? 'warning' : 'neutral'}>{t(`quarantine.reasons.${q.reason}`)}</Chip></TableCell>
                    <TableCell align="end">{f.number(q.count)}</TableCell>
                    <TableCell><span className="label-sm">{f.dateTime(q.lastSeenAt)}</span></TableCell>
                    <TableCell hideOnMobile>
                      <span style={{ display: 'inline-flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                        {Object.entries(q.sampleShape).slice(0, 8).map(([k, v]) => (
                          <Chip key={k} size="sm" tone="neutral">{`${k}: ${v}`}</Chip>
                        ))}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </Table>
            </div>
          )}
        </>
      )}

      {runner && (
        <CommandRunner
          command={runner.command}
          open
          initialInput={runner.input}
          onClose={() => setRunner(null)}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: analyticsEventsKey });
            setRunner(null);
          }}
        />
      )}
    </>
  );
}

/** Группа сервиса с разворотом (строки — через рендер-функцию, чтобы оставаться прямыми детьми таблицы). */
function GroupRows({ label, items, children }: { label: string; items: AnalyticsEventCatalogItemDto[]; children: (e: AnalyticsEventCatalogItemDto) => React.ReactNode }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <>
      <TableGroupRow expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
        <span className="label-caps">{label}</span>
        <Chip size="sm" tone="neutral">{String(items.length)}</Chip>
      </TableGroupRow>
      {expanded && items.map((e) => children(e))}
    </>
  );
}
