'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LIFECYCLE_RESTORE_CHECKS } from '@superapp/shared';
import type {
  LifecycleBackupRunDto,
  LifecycleDataBackupsDto,
  LifecycleDataCanaryDto,
  LifecycleDataErasureDto,
  LifecycleDataRetentionDto,
  LifecycleDataStorageDto,
  LifecycleHoldDto,
  LifecycleRestoreArchiveDto,
  LifecycleUnusedIndexDto,
  PlatformCommandDto,
} from '@superapp/shared';
import {
  BentoGrid,
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Menu,
  SearchField,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  TickBar,
  Toggle,
  type TableColumn,
  type Tone,
} from '@/components/ui';
import { CommandRunner } from '@/components/platform/CommandRunner';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { fetchPlatformCommands, fetchPlatformDataRestores, platformCommandsKey, platformDataKey, runPlatformCommand } from '@/lib/platform/api';
import { useBytes, useFormatters } from '@/lib/format';
import { toastApiError } from '@/lib/api-errors';
import { useDurationLabel } from '@/components/lifecycle/duration';
import { Fact } from './data-ui';
import { erasureTone } from './LifecyclePanels';

const DAY_MS = 86_400_000;
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, monospace)', fontSize: '0.8rem', overflowWrap: 'anywhere' };

/** Команды Кабинета по ключу — витрина видимых сотруднику (нет права — нет кнопки). */
function useCommands() {
  const { can } = usePlatformAuth();
  const q = useQuery({ queryKey: platformCommandsKey, queryFn: fetchPlatformCommands, enabled: can('data.read') });
  return useMemo(() => new Map((q.data ?? []).map((c) => [c.key, c])), [q.data]);
}

/** Модалка команды с подставленным входом; после исполнения вкладки перечитываются. */
function useRunner() {
  const qc = useQueryClient();
  const [runner, setRunner] = useState<{ command: PlatformCommandDto; input: Record<string, unknown> } | null>(null);
  const ui = runner ? (
    <CommandRunner
      command={runner.command}
      open
      initialInput={runner.input}
      onClose={() => setRunner(null)}
      onDone={() => {
        void qc.invalidateQueries({ queryKey: ['platform', 'data'] });
        setRunner(null);
      }}
    />
  ) : null;
  return { open: (command: PlatformCommandDto | undefined, input: Record<string, unknown>) => command && setRunner({ command, input }), ui };
}

// ============================================================
// Хранилище
// ============================================================

type StorageRow = LifecycleDataStorageDto['tables'][number];
type StorageSortKey = 'size' | 'growth' | 'rows' | 'bloat';
const STORAGE_SORT: Record<StorageSortKey, (r: StorageRow) => number> = {
  size: (r) => r.bytes,
  // Рост без снимков неизвестен: −∞ ставит такие строки вниз при сортировке по убыванию
  growth: (r) => r.growth7dBytes ?? Number.NEGATIVE_INFINITY,
  rows: (r) => r.liveRows,
  bloat: (r) => r.bloatPct,
};

export function DataStorageTab({ data }: { data: LifecycleDataStorageDto }) {
  const t = useTranslations('platformData');
  const tl = useTranslations('lifecycle');
  const fmt = useFormatters();
  const bytes = useBytes();
  const commands = useCommands();
  const [unused, setUnused] = useState<LifecycleUnusedIndexDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: StorageSortKey; dir: 'asc' | 'desc' }>({ key: 'size', dir: 'desc' });

  // Поиск — по имени таблицы; сортировка — по колонке, по умолчанию крупнейшие сверху
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? data.tables.filter((r) => r.table.toLowerCase().includes(q)) : [...data.tables];
    const val = STORAGE_SORT[sort.key];
    list.sort((a, b) => (sort.dir === 'desc' ? val(b) - val(a) : val(a) - val(b)));
    return list;
  }, [data.tables, search, sort]);
  const onSort = (key: string) =>
    setSort((s) => (s.key === key ? { key: s.key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: key as StorageSortKey, dir: 'desc' }));

  const report = async () => {
    setBusy(true);
    try {
      const res = await runPlatformCommand('lifecycle.indexes.report', { input: {}, idempotencyKey: crypto.randomUUID() });
      setUnused(((res.result ?? {}) as { indexes?: LifecycleUnusedIndexDto[] }).indexes ?? []);
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn[] = [
    { key: 'table', label: t('storage.table'), width: 'minmax(12rem, 2fr)' },
    { key: 'size', label: t('storage.size'), width: 'max-content', align: 'end', sortable: true },
    { key: 'growth', label: t('storage.growth'), width: 'max-content', align: 'end', hideOnMobile: true, sortable: true },
    { key: 'rows', label: t('storage.rows'), width: 'max-content', align: 'end', hideOnMobile: true, sortable: true },
    { key: 'bloat', label: t('storage.bloat'), width: 'max-content', align: 'end', sortable: true },
    { key: 'vacuum', label: t('storage.vacuum'), width: 'max-content', hideOnMobile: true },
  ];
  return (
    <BentoGrid>
      <Card span={6}>
        <CardHeader title={t('storage.connections')} />
        <TickBar value={data.connections.max ? (data.connections.total / data.connections.max) * 100 : 0} label={`${fmt.number(data.connections.total)} / ${fmt.number(data.connections.max)}`} />
        <div className="ui-stack" style={{ gap: 'var(--spacing-2)', marginTop: 'var(--spacing-3)' }}>
          <Fact label={t('storage.active')} value={fmt.number(data.connections.active)} />
          <Fact label={t('storage.idleInTx')} value={fmt.number(data.connections.idleInTransaction)} />
        </div>
      </Card>
      <Card span={6}>
        <CardHeader title={t('storage.locks')} />
        <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
          <Fact label={t('storage.lockWaiters')} value={fmt.number(data.locks.waiters)} />
          <Fact label={t('storage.lockManager')} value={fmt.number(data.locks.lockManager)} />
        </div>
      </Card>
      <Card span={12}>
        <CardHeader
          title={t('storage.title')}
          actions={commands.has('lifecycle.indexes.report') ? <Button size="sm" variant="outline" icon="list" loading={busy} onClick={() => void report()}>{t('storage.unusedIndexes')}</Button> : null}
        />
        <SearchField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          placeholder={t('storage.search')}
          aria-label={t('storage.search')}
          width="100%"
          style={{ maxWidth: '22rem', marginBottom: 'var(--spacing-3)' }}
        />
        {rows.length === 0 ? (
          <EmptyState icon="search" title={t('storage.noMatch')} />
        ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table columns={columns} lines aria-label={t('storage.title')}>
            <TableHeader sortKey={sort.key} sortDir={sort.dir} onSort={onSort} />
            {rows.map((r, i) => (
              <TableRow key={r.table} rowIndex={i + 2}>
                <TableCell>
                  <div className="ui-stack" style={{ gap: 2 }}>
                    <span style={mono}>{r.table}</span>
                    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {r.dataClass && <Chip size="sm" tone="neutral">{r.dataClass === 'unclassified' ? t('unclassified') : tl(`classes.${r.dataClass}.title`)}</Chip>}
                      {r.invalidIndexes > 0 && <Chip size="sm" tone="danger" icon="warningCircle">{t('storage.invalid', { count: r.invalidIndexes })}</Chip>}
                    </span>
                  </div>
                </TableCell>
                <TableCell align="end">{bytes(r.bytes)}</TableCell>
                <TableCell align="end" hideOnMobile>{r.growth7dBytes === null ? '—' : `${r.growth7dBytes >= 0 ? '+' : '−'}${bytes(Math.abs(r.growth7dBytes))}`}</TableCell>
                <TableCell align="end" hideOnMobile>{fmt.number(r.liveRows)}</TableCell>
                <TableCell align="end">
                  <Chip size="sm" tone={r.bloatPct >= 30 ? 'warning' : 'neutral'}>{fmt.number(r.bloatPct, { maximumFractionDigits: 1 })}%</Chip>
                </TableCell>
                <TableCell hideOnMobile><span className="label-sm">{r.lastAutovacuumAt ? fmt.dateTime(r.lastAutovacuumAt, 'short') : '—'}</span></TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
        )}
      </Card>
      {unused && (
        <Card span={12}>
          <CardHeader title={t('storage.unusedIndexes')} />
          {unused.length === 0 ? (
            <EmptyState icon="checkCircle" title={t('storage.unusedNone')} />
          ) : (
            <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
              {unused.map((u) => (
                <Fact key={`${u.table}.${u.index}`} label={`${u.table} · ${u.index}`} value={bytes(u.bytes)} />
              ))}
            </div>
          )}
        </Card>
      )}
    </BentoGrid>
  );
}

// ============================================================
// Сроки хранения
// ============================================================

export function DataRetentionTab({ data }: { data: LifecycleDataRetentionDto }) {
  const t = useTranslations('platformData');
  const tl = useTranslations('lifecycle');
  const fmt = useFormatters();
  const label = useDurationLabel();
  const commands = useCommands();
  const runner = useRunner();
  const [laggingOnly, setLaggingOnly] = useState(false);
  const rows = laggingOnly ? data.rows.filter((r) => (r.lagDays ?? 0) > 1) : data.rows;

  const columns: TableColumn[] = [
    { key: 'policy', label: t('retention.policy'), width: 'minmax(12rem, 2fr)' },
    { key: 'term', label: t('retention.term'), width: 'minmax(9rem, 1fr)' },
    { key: 'rows', label: t('retention.rows'), width: 'max-content', align: 'end', hideOnMobile: true },
    { key: 'lag', label: t('retention.lag'), width: 'max-content' },
    { key: 'run', label: t('retention.lastRun'), width: 'max-content', hideOnMobile: true },
    { key: 'actions', label: '', width: 'max-content', align: 'end' },
  ];
  return (
    <Card span={12}>
      <CardHeader
        title={t('retention.title')}
        actions={<Toggle checked={laggingOnly} onChange={setLaggingOnly} label={t('retention.laggingOnly')} />}
      />
      <p className="label-sm" style={{ margin: '0 0 var(--spacing-3)' }}>
        {t('retention.subtitle', { next: fmt.dateTime(data.nextRunAt, 'short'), snapshot: data.snapshotDay ? fmt.date(data.snapshotDay) : '—' })}
      </p>
      {rows.length === 0 ? (
        <EmptyState icon="checkCircle" title={t('retention.noneLagging')} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table columns={columns} lines aria-label={t('retention.title')}>
            <TableHeader />
            {rows.map((r, i) => {
              const items = [
                commands.get('lifecycle.retention.dryRun') && r.runnable && { key: 'dry', label: t('retention.dryRun'), icon: 'play' as const, onClick: () => runner.open(commands.get('lifecycle.retention.dryRun'), { policyId: r.policyId }) },
                commands.get('lifecycle.retention.pause') && (r.runnable || r.override?.paused) && {
                  key: 'pause',
                  label: r.override?.paused ? t('retention.resume') : t('retention.pause'),
                  icon: 'hourglass' as const,
                  onClick: () => runner.open(commands.get('lifecycle.retention.pause'), { policyId: r.policyId, paused: !r.override?.paused }),
                },
                commands.get('lifecycle.retention.override') && r.overridable && {
                  key: 'override',
                  label: t('retention.override'),
                  icon: 'edit' as const,
                  onClick: () => runner.open(commands.get('lifecycle.retention.override'), { policyId: r.policyId, days: r.override?.days ?? null }),
                },
              ].filter(Boolean) as Array<{ key: string; label: string; icon: 'play' | 'hourglass' | 'edit'; onClick: () => void }>;
              return (
                <TableRow key={r.policyId} rowIndex={i + 2}>
                  <TableCell>
                    <div className="ui-stack" style={{ gap: 2 }}>
                      <span style={mono}>{r.policyId}</span>
                      <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <Chip size="sm" tone="neutral">{tl(`classes.${r.dataClass}.title`)}</Chip>
                        <Chip size="sm" tone="neutral">{t(`enforcement.${r.enforcement}`)}</Chip>
                        {r.tenantConfigurable && <Chip size="sm" tone="accent">{t('retention.tenant')}</Chip>}
                        {r.override?.paused && <Chip size="sm" tone="waiting" icon="hourglass">{t('retention.paused')}</Chip>}
                        {r.override?.days && <Chip size="sm" tone="warning">{t('retention.overridden', { duration: label(r.override.days) })}</Chip>}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="label-sm">
                      {label(r.retention.defaultDays)}
                      {r.retention.floorDays !== null ? ` · ${t('retention.floor', { duration: label(r.retention.floorDays) })}` : ''}
                    </span>
                  </TableCell>
                  <TableCell align="end" hideOnMobile>{r.rows === null ? '—' : fmt.number(r.rows)}</TableCell>
                  <TableCell>
                    {r.lagDays === null ? <span className="label-sm">—</span> : <Chip size="sm" tone={r.lagDays > 7 ? 'danger' : r.lagDays > 1 ? 'warning' : 'success'}>{tl('duration.days', { days: r.lagDays })}</Chip>}
                  </TableCell>
                  <TableCell hideOnMobile>
                    {r.lastRun ? (
                      <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Chip size="sm" tone={runTone(r.lastRun.status)}>{t(`runStatus.${r.lastRun.status}`)}</Chip>
                        {r.lastRun.dryRun && <Chip size="sm" tone="neutral">{t('retention.dry')}</Chip>}
                        <span className="label-sm">{fmt.dateTime(r.lastRun.startedAt, 'short')}</span>
                      </span>
                    ) : (
                      <span className="label-sm">—</span>
                    )}
                  </TableCell>
                  <TableCell align="end">{items.length > 0 && <Menu items={items} label={t('retention.actions')} />}</TableCell>
                </TableRow>
              );
            })}
          </Table>
        </div>
      )}
      {runner.ui}
    </Card>
  );
}

function runTone(status: string): Tone {
  if (status === 'done') return 'success';
  if (status === 'running') return 'waiting';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

// ============================================================
// Стирания и заморозки
// ============================================================

const ERASURE_STAGES = ['hiddenAt', 'hotPurgedAt', 'keysDestroyedAt', 'backupsClearAt', 'completedAt'] as const;

export function DataErasureTab({ data }: { data: LifecycleDataErasureDto }) {
  const t = useTranslations('platformData');
  // Статусы стирания — общий словарь Кабинета: их же показывает панель карточки 360
  const tp = useTranslations('platform');
  const tl = useTranslations('lifecycle');
  const fmt = useFormatters();
  const commands = useCommands();
  const runner = useRunner();

  const queueColumns: TableColumn[] = [
    { key: 'subject', label: t('erasure.subject'), width: 'minmax(9rem, 1fr)' },
    { key: 'status', label: t('erasure.status'), width: 'max-content' },
    { key: 'stages', label: t('erasure.stages'), width: 'minmax(8rem, 1.2fr)', hideOnMobile: true },
    { key: 'age', label: t('erasure.age'), width: 'max-content', hideOnMobile: true },
    { key: 'actions', label: '', width: 'max-content', align: 'end' },
  ];
  const holdColumns: TableColumn[] = [
    { key: 'scope', label: t('erasure.holdScope'), width: 'minmax(9rem, 1fr)' },
    { key: 'reason', label: t('erasure.holdReason'), width: 'max-content', hideOnMobile: true },
    { key: 'since', label: t('erasure.holdSince'), width: 'max-content' },
    { key: 'actions', label: '', width: 'max-content', align: 'end' },
  ];
  return (
    <BentoGrid>
      <Card span={12}>
        <CardHeader title={t('erasure.queue')} actions={<Chip size="sm" tone="neutral">{t('erasure.completed90d', { count: data.completed90d })}</Chip>} />
        {data.queue.length === 0 ? (
          <EmptyState icon="checkCircle" title={t('erasure.empty')} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table columns={queueColumns} lines aria-label={t('erasure.queue')}>
              <TableHeader />
              {data.queue.map((r, i) => {
                const done = ERASURE_STAGES.filter((k) => !!r[k]).length;
                const age = Math.floor((Date.now() - new Date(r.requestedAt).getTime()) / DAY_MS);
                return (
                  <TableRow key={r.id} rowIndex={i + 2}>
                    <TableCell>
                      <div className="ui-stack" style={{ gap: 2 }}>
                        <span style={mono}>{r.pseudonym}…</span>
                        <Chip size="sm" tone="neutral" icon={r.subjectType === 'user' ? 'user' : 'workspace'}>{tl(`receipt.subject.${r.subjectType}`)}</Chip>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <Chip size="sm" tone={erasureTone(r.status)}>{tp(`data.erasureStatus.${r.status}`)}</Chip>
                        {r.stuck && <Chip size="sm" tone="danger" icon="warningCircle">{t('erasure.stuck')}</Chip>}
                      </span>
                    </TableCell>
                    <TableCell hideOnMobile>
                      <TickBar value={(done / ERASURE_STAGES.length) * 100} label={t('erasure.stagesDone', { done, total: ERASURE_STAGES.length })} />
                    </TableCell>
                    <TableCell hideOnMobile><span className="label-sm">{tl('duration.days', { days: Math.max(age, 0) })}</span></TableCell>
                    <TableCell align="end">
                      {commands.get('lifecycle.erasure.retry') && (
                        <Button size="sm" variant="outline" icon="refresh" onClick={() => runner.open(commands.get('lifecycle.erasure.retry'), { requestId: r.id })}>{t('erasure.retry')}</Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </Table>
          </div>
        )}
      </Card>
      <Card span={12}>
        <CardHeader
          title={t('erasure.platformHolds')}
          actions={
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              <Chip size="sm" tone="neutral" icon="lock">{t('erasure.orgHolds', { count: data.organizationHolds })}</Chip>
              {commands.get('lifecycle.hold.create') && (
                <Button size="sm" variant="primary" icon="lock" onClick={() => runner.open(commands.get('lifecycle.hold.create'), {})}>{t('erasure.holdCreate')}</Button>
              )}
            </div>
          }
        />
        {data.platformHolds.length === 0 ? (
          <EmptyState icon="lock" title={t('erasure.noHolds')} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table columns={holdColumns} lines aria-label={t('erasure.platformHolds')}>
              <TableHeader />
              {data.platformHolds.map((h, i) => (
                <TableRow key={h.id} rowIndex={i + 2}>
                  <TableCell>
                    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Chip size="sm" tone="neutral" icon="lock">{tl(`holds.scopes.${h.scope}`)}</Chip>
                      {h.dataClass && <Chip size="sm" tone="neutral">{tl(`classes.${h.dataClass}.title`)}</Chip>}
                      <HoldTarget hold={h} />
                    </span>
                  </TableCell>
                  <TableCell hideOnMobile><Chip size="sm" tone="neutral">{tl(`holds.reasons.${h.reasonCode}`)}</Chip></TableCell>
                  <TableCell><span className="label-sm">{fmt.date(h.createdAt)}</span></TableCell>
                  <TableCell align="end">
                    {commands.get('lifecycle.hold.release') && (
                      <Button size="sm" variant="matte" tone="danger" onClick={() => runner.open(commands.get('lifecycle.hold.release'), { holdId: h.id })}>{t('erasure.holdRelease')}</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </div>
        )}
      </Card>
      {runner.ui}
    </BentoGrid>
  );
}

/**
 * Предмет заморозки. Имён здесь нет намеренно: дашборд открыт праву `data.read` (эксплуатация
 * базы), а личность — дело карточки 360 со своим правом `platform.lookup.read` и журналом
 * просмотра. Человек и организация — ссылкой на карточку, запись — коротким id.
 */
function HoldTarget({ hold }: { hold: LifecycleHoldDto }) {
  const t = useTranslations('platformData');
  const { can } = usePlatformAuth();
  const short = (id: string) => `${id.slice(0, 8)}…`;
  const card = (href: string, icon: 'user' | 'workspace', id: string) =>
    can('platform.lookup.read') ? (
      <Button size="sm" variant="ghost" icon={icon} href={href}>{t('erasure.openCard')}</Button>
    ) : (
      <span style={mono}>{short(id)}</span>
    );
  if (hold.custodianUserId) return card(`/platform/users/${hold.custodianUserId}`, 'user', hold.custodianUserId);
  if (hold.workspaceId && hold.scope !== 'record') return card(`/platform/workspaces/${hold.workspaceId}`, 'workspace', hold.workspaceId);
  const id = hold.recordId ?? hold.spaceId;
  return id ? <span style={mono}>{short(id)}</span> : null;
}

// ============================================================
// Бэкапы и восстановление
// ============================================================

export function DataBackupsTab({ data }: { data: LifecycleDataBackupsDto }) {
  const t = useTranslations('platformData');
  const fmt = useFormatters();
  const bytes = useBytes();
  if (data.empty) {
    return (
      <BentoGrid>
        <Card span={12}>
          <EmptyState icon="database" title={t('backups.emptyTitle')} description={t('backups.emptyText')} />
        </Card>
        <RestoresCard />
      </BentoGrid>
    );
  }
  const columns: TableColumn[] = [
    { key: 'kind', label: t('backups.kind'), width: 'minmax(8rem, 1fr)' },
    { key: 'repo', label: t('backups.repo'), width: 'max-content' },
    { key: 'when', label: t('backups.when'), width: 'max-content' },
    { key: 'duration', label: t('backups.duration'), width: 'max-content', align: 'end', hideOnMobile: true },
    { key: 'size', label: t('backups.size'), width: 'max-content', align: 'end', hideOnMobile: true },
    { key: 'status', label: t('backups.status'), width: 'max-content' },
  ];
  // Учения несут проверки восстановленной копии (строки, Σ=0 книги, корень Меркла журнала,
  // повтор журнала стираний) и фактический RTO — колонка вместо размера
  const drillColumns: TableColumn[] = [
    ...columns.filter((c) => c.key !== 'size' && c.key !== 'status'),
    { key: 'checks', label: t('backups.checks'), width: 'minmax(10rem, 1.5fr)' },
    { key: 'status', label: t('backups.status'), width: 'max-content' },
  ];
  const minutes = (r: LifecycleBackupRunDto): string => {
    if (!r.finishedAt) return '—';
    const sec = Math.max(0, (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000);
    return t('backups.minutes', { minutes: fmt.number(sec / 60, { maximumFractionDigits: sec < 600 ? 1 : 0 }) });
  };
  const runRows = (rows: LifecycleBackupRunDto[], drill = false) =>
    rows.map((r, i) => (
      <TableRow key={r.id} rowIndex={i + 2}>
        <TableCell>{t(`backupKind.${r.kind}`)}</TableCell>
        <TableCell><span style={mono}>{r.repo}</span></TableCell>
        <TableCell><span className="label-sm">{fmt.dateTime(r.startedAt, 'short')}</span></TableCell>
        <TableCell align="end" hideOnMobile>{minutes(r)}</TableCell>
        {drill ? (
          <TableCell>
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {LIFECYCLE_RESTORE_CHECKS.filter((c) => r.details?.checks?.[c] !== undefined).map((c) => (
                <Chip key={c} size="sm" tone={r.details?.checks?.[c] ? 'success' : 'danger'} icon={r.details?.checks?.[c] ? 'checkCircle' : 'warningCircle'}>
                  {t(`backups.check.${c}`)}
                </Chip>
              ))}
              {typeof r.details?.rtoSeconds === 'number' && (
                <Chip size="sm" tone="neutral">{t('backups.rto', { minutes: fmt.number(r.details.rtoSeconds / 60, { maximumFractionDigits: 1 }) })}</Chip>
              )}
            </span>
          </TableCell>
        ) : (
          <TableCell align="end" hideOnMobile>{r.bytes === null ? '—' : bytes(r.bytes)}</TableCell>
        )}
        <TableCell>
          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip size="sm" tone={r.status === 'ok' ? 'success' : 'danger'}>{t(`backupStatus.${r.status}`)}</Chip>
            {r.details?.errorCode && <span style={mono}>{r.details.errorCode}</span>}
          </span>
        </TableCell>
      </TableRow>
    ));
  return (
    <BentoGrid>
      <Card span={12}>
        <CardHeader title={t('backups.coverage', { window: data.windowDays })} />
        <div role="img" aria-label={t('backups.coverageAria', { covered: data.coverage.filter((c) => c.backup).length, window: data.windowDays })} style={{ display: 'grid', gridTemplateColumns: `repeat(${data.coverage.length}, minmax(0, 1fr))`, gap: 2 }}>
          {data.coverage.map((c) => (
            <span
              key={c.day}
              title={`${fmt.date(c.day)} · ${c.backup ? t('backups.dayOk') : t('backups.dayMissing')}`}
              style={{ height: 28, borderRadius: 'var(--radius-sm)', background: `color-mix(in srgb, var(${c.backup ? '--success-base' : '--danger-base'}) ${c.backup ? 55 : 35}%, transparent)` }}
            />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-2)', flexWrap: 'wrap' }}>
          <Chip size="sm" tone="success">{t('backups.dayOk')}</Chip>
          <Chip size="sm" tone="danger">{t('backups.dayMissing')}</Chip>
          {data.replication.lagSeconds !== null && (
            <Chip size="sm" tone={data.replication.lagSeconds > 3600 ? 'warning' : 'neutral'}>{t('backups.replication', { minutes: Math.round(data.replication.lagSeconds / 60) })}</Chip>
          )}
        </div>
      </Card>
      <Card span={12}>
        <CardHeader title={t('backups.drills')} />
        {data.drills.length === 0 ? (
          <EmptyState icon="refresh" title={t('backups.noDrills')} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table columns={drillColumns} lines aria-label={t('backups.drills')}>
              <TableHeader />
              {runRows(data.drills, true)}
            </Table>
          </div>
        )}
      </Card>
      <Card span={12}>
        <CardHeader title={t('backups.runs')} />
        <div style={{ overflowX: 'auto' }}>
          <Table columns={columns} lines aria-label={t('backups.runs')}>
            <TableHeader />
            {runRows(data.runs)}
          </Table>
        </div>
      </Card>
      <RestoresCard />
    </BentoGrid>
  );
}

/**
 * Восстановление организаций (Э6): архивы, извлечённые из кластера на точку времени, и их
 * импорты. Действия — команды Кабинета (critical, через второго сотрудника): извлечь
 * организацию, вернуть строки архива. Нет источника PITR в production — только пояснение.
 */
function RestoresCard() {
  const t = useTranslations('platformData');
  const fmt = useFormatters();
  const commands = useCommands();
  const runner = useRunner();
  const q = useQuery({ queryKey: platformDataKey('restores'), queryFn: fetchPlatformDataRestores, refetchInterval: 30_000 });
  const extract = commands.get('lifecycle.restore.extract');
  const importCmd = commands.get('lifecycle.restore.import');
  const statusTone = (s: string): Tone => (s === 'ready' || s === 'done' ? 'success' : s === 'failed' ? 'warning' : s === 'expired' ? 'neutral' : 'accent');
  const columns: TableColumn[] = [
    { key: 'ws', label: t('restores.workspace'), width: 'minmax(10rem, 1.2fr)' },
    { key: 'snapshot', label: t('restores.snapshot'), width: 'max-content' },
    { key: 'rows', label: t('restores.rows'), width: 'max-content', align: 'end', hideOnMobile: true },
    { key: 'status', label: t('restores.status'), width: 'max-content' },
    { key: 'imports', label: t('restores.imports'), width: 'minmax(12rem, 1.6fr)' },
    { key: 'actions', label: '', width: 'max-content', align: 'end' },
  ];
  const archives: LifecycleRestoreArchiveDto[] = q.data?.archives ?? [];
  return (
    <Card span={12}>
      <CardHeader
        title={t('restores.title')}
        actions={
          extract ? (
            <Button variant="primary" icon="download" disabled={!q.data?.sourceConfigured} onClick={() => runner.open(extract, {})}>
              {t('restores.extract')}
            </Button>
          ) : undefined
        }
      />
      <p className="body-sm" style={{ margin: '0 0 var(--spacing-3)' }}>{t(q.data && !q.data.sourceConfigured ? 'restores.noSource' : 'restores.description')}</p>
      {archives.length === 0 ? (
        <EmptyState icon="archive" title={t('restores.empty')} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table columns={columns} lines aria-label={t('restores.title')}>
            <TableHeader />
            {archives.map((a, i) => (
              <TableRow key={a.exportId} rowIndex={i + 2}>
                <TableCell><span style={mono}>{a.workspaceId}</span></TableCell>
                <TableCell><span className="label-sm">{a.snapshotAt ? fmt.dateTime(a.snapshotAt) : '—'}</span></TableCell>
                <TableCell hideOnMobile align="end"><span className="label-sm">{a.rows === null ? '—' : fmt.number(a.rows)}</span></TableCell>
                <TableCell><Chip size="sm" tone={statusTone(a.status)}>{t(`restores.archiveStatus.${a.status}`)}</Chip></TableCell>
                <TableCell>
                  {a.imports.length === 0 ? (
                    <span className="label-sm">—</span>
                  ) : (
                    <div className="ui-stack" style={{ gap: 4 }}>
                      {a.imports.map((r) => {
                        const sum = (k: 'inserted' | 'skipped' | 'failed') => r.tables.reduce((acc, x) => acc + x[k], 0);
                        return (
                          <div key={r.runId} style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                            <Chip size="sm" tone={statusTone(r.status)}>{t(`restores.runStatus.${r.status}`)}</Chip>
                            <span className="label-sm">{t('restores.importSummary', { inserted: sum('inserted'), skipped: sum('skipped'), failed: sum('failed'), replayed: r.erasuresReplayed })}</span>
                            {r.missingBlobs > 0 && <Chip size="sm" tone="warning">{t('restores.missingBlobs', { count: r.missingBlobs })}</Chip>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </TableCell>
                <TableCell align="end">
                  {importCmd && a.status === 'ready' && (
                    <Button size="sm" variant="matte" onClick={() => runner.open(importCmd, { exportId: a.exportId })}>{t('restores.import')}</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      )}
      {runner.ui}
    </Card>
  );
}

// ============================================================
// Канарейка
// ============================================================

export function DataCanaryTab({ data }: { data: LifecycleDataCanaryDto }) {
  const t = useTranslations('platformData');
  const fmt = useFormatters();
  const { can } = usePlatformAuth();
  // Провал канарейки — критическое событие журнала безопасности: разбор идёт там
  const journal = can('security.read') ? '/platform/audit?tab=events&key=lifecycle.canary.failed' : null;
  if (data.runs.length === 0) {
    return (
      <Card>
        <EmptyState icon="fingerprint" title={t('canary.empty')} description={t('canary.emptyText')} />
      </Card>
    );
  }
  const columns: TableColumn[] = [
    { key: 'when', label: t('canary.when'), width: 'max-content' },
    { key: 'status', label: t('canary.status'), width: 'max-content' },
    { key: 'stores', label: t('canary.stores'), width: 'max-content', align: 'end', hideOnMobile: true },
    { key: 'findings', label: t('canary.findings'), width: 'minmax(10rem, 2fr)' },
    { key: 'duration', label: t('canary.duration'), width: 'max-content', align: 'end', hideOnMobile: true },
  ];
  return (
    <Card>
      <CardHeader title={t('canary.title')} />
      <div style={{ overflowX: 'auto' }}>
        <Table columns={columns} lines aria-label={t('canary.title')}>
          <TableHeader />
          {data.runs.map((r, i) => (
            <TableRow key={r.id} rowIndex={i + 2}>
              <TableCell><span className="label-sm">{fmt.dateTime(r.startedAt, 'short')}</span></TableCell>
              <TableCell><Chip size="sm" tone={runTone(r.status)}>{t(`runStatus.${r.status}`)}</Chip></TableCell>
              <TableCell align="end" hideOnMobile>{fmt.number(r.stores)}</TableCell>
              <TableCell>
                {r.findings === 0 ? (
                  <Chip size="sm" tone="success">{t('canary.clean')}</Chip>
                ) : (
                  <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    {r.details.map((d, k) => (
                      <Chip key={k} size="sm" tone="danger">{`${d.store} · ${t.has(`canaryKind.${d.kind}`) ? t(`canaryKind.${d.kind}`) : d.kind}`}</Chip>
                    ))}
                    {journal && <Button size="sm" variant="ghost" icon="shieldWarning" href={journal}>{t('canary.openJournal')}</Button>}
                  </span>
                )}
              </TableCell>
              <TableCell align="end" hideOnMobile>{r.durationMs === null ? '—' : t('canary.seconds', { seconds: Math.round(r.durationMs / 100) / 10 })}</TableCell>
            </TableRow>
          ))}
        </Table>
      </div>
    </Card>
  );
}
