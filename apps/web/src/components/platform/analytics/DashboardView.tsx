'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import type { AnalyticsDashboardDto, AnalyticsTile } from '@superapp/shared';
import {
  Alert,
  BentoGrid,
  Button,
  Chip,
  EmptyState,
  Input,
  LoadingBlock,
  Menu,
  Modal,
  SearchField,
  Toggle,
  useConfirm,
  type MenuAction,
} from '@/components/ui';
import {
  analyticsDashboardKey,
  analyticsDashboardsKey,
  analyticsQualityKey,
  analyticsReportsKey,
  createAnalyticsDashboard,
  deleteAnalyticsDashboard,
  fetchAnalyticsDashboard,
  fetchAnalyticsDashboards,
  fetchAnalyticsQuality,
  fetchAnalyticsReports,
  updateAnalyticsDashboard,
} from '@/lib/platform/analytics';
import { useFormatters } from '@/lib/format';

import { ReportTile, reportTitle } from './ReportTile';
import { useAnalyticsParams } from './useAnalyticsParams';

import { toastApiError } from '@/lib/api-errors';
export function dashboardTitle(d: Pick<AnalyticsDashboardDto, 'title' | 'systemKey'>, t: ReturnType<typeof useTranslations<'analytics'>>): string {
  if (d.systemKey && t.has(`system.dashboards.${d.systemKey}`)) return t(`system.dashboards.${d.systemKey}`);
  return d.title ?? '';
}

const withParam = (href: string, key: string, value: string) => `${href}${href.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;

/**
 * Дашборд: переключатель (системные · общие · личные · «＋ Новый»), «здоровье данных»
 * строкой, честные пустые состояния, сетка независимых плиток. Системный дашборд не
 * правится: «Изменить» создаёт копию. Режим правки — ширина плитки, порядок, «открыть как
 * отчёт», «убрать», «＋ Плитка» (из библиотеки или новый отчёт); каждое изменение
 * сохраняется сразу.
 */
export function DashboardView({ idOrKey }: { idOrKey: string }) {
  const t = useTranslations('analytics');
  const tc = useTranslations('common');
  const f = useFormatters();
  const router = useRouter();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const params = useAnalyticsParams();
  const [confirm, confirmUI] = useConfirm();
  const list = useQuery({ queryKey: analyticsDashboardsKey, queryFn: fetchAnalyticsDashboards });
  const detail = useQuery({ queryKey: analyticsDashboardKey(idOrKey), queryFn: () => fetchAnalyticsDashboard(idOrKey) });
  const quality = useQuery({ queryKey: analyticsQualityKey, queryFn: fetchAnalyticsQuality, staleTime: 60_000 });
  const d = detail.data;
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (sp?.get('edit') === '1' && d?.canEdit) setEditing(true);
  }, [sp, d?.canEdit]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: analyticsDashboardKey(idOrKey) });
    void qc.invalidateQueries({ queryKey: analyticsDashboardsKey });
  };
  const saveTiles = useMutation({
    mutationFn: (tiles: AnalyticsTile[]) => updateAnalyticsDashboard(d!.id, { tiles }),
    onSuccess: refresh,
    onError: (e) => toastApiError(e),
  });
  const copySystem = useMutation({
    mutationFn: () => createAnalyticsDashboard({ title: t('dashboards.copyOf', { name: dashboardTitle(d!, t) }), tiles: d!.tiles, visibility: 'shared' }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: analyticsDashboardsKey });
      router.push(withParam(params.href(`/platform/analytics/d/${created.id}`), 'edit', '1'));
    },
    onError: (e) => toastApiError(e),
  });

  const reportsById = useMemo(() => new Map((d?.reports ?? []).map((r) => [r.id, r])), [d?.reports]);

  if (detail.isPending) return <LoadingBlock />;
  if (detail.isError || !d) return <Alert tone="danger">{t('dashboards.notFound')}</Alert>;

  const tiles = d.tiles;
  const setSpan = (i: number, span: 4 | 6 | 12) => saveTiles.mutate(tiles.map((x, j) => (j === i ? { ...x, span } : x)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= tiles.length) return;
    const next = [...tiles];
    [next[i], next[j]] = [next[j], next[i]];
    saveTiles.mutate(next);
  };
  const menuFor = (i: number, reportId: string): MenuAction[] => [
    { key: 'w4', label: t('dashboards.widthNarrow'), icon: 'arrowsIn', onClick: () => setSpan(i, 4), disabled: tiles[i].span === 4 },
    { key: 'w6', label: t('dashboards.widthMedium'), icon: 'grid', onClick: () => setSpan(i, 6), disabled: tiles[i].span === 6 },
    { key: 'w12', label: t('dashboards.widthWide'), icon: 'arrowsOut', onClick: () => setSpan(i, 12), disabled: tiles[i].span === 12 },
    { key: 'up', label: t('dashboards.moveUp'), icon: 'arrowUp', onClick: () => move(i, -1), disabled: i === 0, separatorBefore: true },
    { key: 'down', label: t('dashboards.moveDown'), icon: 'arrowDown', onClick: () => move(i, 1), disabled: i === tiles.length - 1 },
    { key: 'open', label: t('tile.openReport'), icon: 'external', onClick: () => router.push(params.href(`/platform/analytics/reports/${reportId}`)), separatorBefore: true },
    { key: 'remove', label: t('dashboards.removeTile'), icon: 'remove', danger: true, separatorBefore: true, onClick: () => saveTiles.mutate(tiles.filter((_, j) => j !== i)) },
  ];

  const q = quality.data;
  const collecting = q && q.firstEventAt && !q.rollupAt;
  const noEvents = q && !q.firstEventAt;

  const headerActions: MenuAction[] = d.canEdit
    ? [
        {
          key: 'delete',
          label: t('dashboards.delete'),
          icon: 'delete',
          danger: true,
          onClick: () =>
            confirm({ title: t('dashboards.deleteTitle'), message: t('dashboards.deleteText'), danger: true }, async () => {
              try {
                await deleteAnalyticsDashboard(d.id);
                void qc.invalidateQueries({ queryKey: analyticsDashboardsKey });
                router.push(params.href('/platform/analytics'));
              } catch (e) {
                toastApiError(e);
              }
            }),
        },
      ]
    : [];

  return (
    <>
      <div role="navigation" aria-label={t('dashboards.switcher')} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', alignItems: 'center', marginBottom: 'var(--spacing-4)' }}>
        {(list.data ?? []).map((x) => {
          const active = x.id === d.id;
          return (
            <Chip
              key={x.id}
              tone={active ? 'accent' : 'neutral'}
              selected={active}
              icon={x.visibility === 'private' ? 'lock' : undefined}
              onClick={() => router.push(params.href(x.systemKey === 'overview' ? '/platform/analytics' : `/platform/analytics/d/${x.systemKey ?? x.id}`))}
            >
              {dashboardTitle(x, t)}
            </Chip>
          );
        })}
        <Button size="sm" variant="outline" icon="add" onClick={() => setCreating(true)}>{t('dashboards.new')}</Button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
        <h2 className="title-md" style={{ margin: 0 }}>{dashboardTitle(d, t)}</h2>
        {d.systemKey && <Chip size="sm" tone="neutral">{t('dashboards.system')}</Chip>}
        {d.visibility === 'private' && <Chip size="sm" tone="neutral" icon="lock">{t('library.private')}</Chip>}
        <span style={{ marginInlineStart: 'auto', display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {d.systemKey ? (
            <Button size="sm" variant="outline" icon="copy" loading={copySystem.isPending} onClick={() => copySystem.mutate()}>{t('dashboards.editCopy')}</Button>
          ) : d.canEdit ? (
            <>
              {editing && <Button size="sm" variant="outline" icon="add" onClick={() => setAdding(true)}>{t('dashboards.addTile')}</Button>}
              <Button size="sm" variant={editing ? 'primary' : 'outline'} icon={editing ? 'check' : 'edit'} onClick={() => setEditing((v) => !v)}>
                {editing ? tc('actions.done') : tc('actions.edit')}
              </Button>
            </>
          ) : null}
          {headerActions.length > 0 && <Menu items={headerActions} label={t('dashboards.actions')} />}
        </span>
      </div>

      {q && (
        <p className="label-sm" style={{ margin: '0 0 var(--spacing-4)', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{t('health.line', { events: f.number(q.eventsLastHour), lag: q.stream.lagSeconds ?? 0 })}</span>
          {q.quarantine.length > 0 && (
            <Chip size="sm" tone="warning" icon="warning" onClick={() => router.push(withParam(params.href('/platform/analytics/events'), 'tab', 'quarantine'))}>
              {t('health.quarantine', { count: q.quarantine.length })}
            </Chip>
          )}
        </p>
      )}

      {noEvents ? (
        <EmptyState icon="chart" title={t('empty.noEventsTitle')} description={t('empty.noEventsText')} />
      ) : collecting ? (
        <EmptyState icon="hourglass" title={t('empty.collectingTitle')} description={t('empty.collectingText', { date: f.date(q!.firstEventAt!) })} />
      ) : tiles.length === 0 ? (
        <EmptyState
          icon="dashboard"
          title={t('dashboards.emptyTiles')}
          action={d.canEdit ? <Button variant="outline" icon="add" onClick={() => { setEditing(true); setAdding(true); }}>{t('dashboards.addTile')}</Button> : undefined}
        />
      ) : (
        <BentoGrid>
          {tiles.map((tile, i) => {
            const report = reportsById.get(tile.reportId);
            if (!report) return null;
            return <ReportTile key={`${tile.reportId}-${i}`} report={report} tile={tile} menu={editing ? menuFor(i, report.id) : undefined} />;
          })}
        </BentoGrid>
      )}

      <AddTileModal
        open={adding}
        onClose={() => setAdding(false)}
        sharedOnly={d.visibility === 'shared'}
        onPick={(reportId) => {
          saveTiles.mutate([...tiles, { reportId, span: 6 }]);
          setAdding(false);
        }}
        onNewReport={() => router.push(withParam(params.href('/platform/analytics/reports/new'), 'dashboard', d.id))}
      />
      <CreateDashboardModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          void qc.invalidateQueries({ queryKey: analyticsDashboardsKey });
          router.push(withParam(params.href(`/platform/analytics/d/${created.id}`), 'edit', '1'));
        }}
      />
      {confirmUI}
    </>
  );
}

function AddTileModal({ open, onClose, sharedOnly, onPick, onNewReport }: { open: boolean; onClose: () => void; sharedOnly: boolean; onPick: (id: string) => void; onNewReport: () => void }) {
  const t = useTranslations('analytics');
  const reports = useQuery({ queryKey: analyticsReportsKey, queryFn: fetchAnalyticsReports, enabled: open });
  const [search, setSearch] = useState('');
  const rows = (reports.data ?? [])
    .filter((r) => !sharedOnly || r.visibility === 'shared')
    .map((r) => ({ r, title: reportTitle(r, t) }))
    .filter((x) => x.title.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <Modal open={open} onClose={onClose} title={t('dashboards.addTile')} subtitle={sharedOnly ? t('dashboards.sharedOnlyHint') : undefined} footer={<Button variant="outline" icon="add" onClick={onNewReport}>{t('dashboards.newReport')}</Button>}>
      <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
        <SearchField width="100%" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} placeholder={t('library.search')} aria-label={t('library.search')} />
        {reports.isPending ? (
          <LoadingBlock />
        ) : (
          <div className="ui-stack" style={{ gap: '0.25rem', maxHeight: '50vh', overflowY: 'auto' }}>
            {rows.map(({ r, title }) => (
              <Button key={r.id} variant="ghost" icon="chart" onClick={() => onPick(r.id)} style={{ justifyContent: 'flex-start', width: '100%' }}>
                <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  {title}
                  <Chip size="sm" tone="neutral">{t(`types.${r.query.type}`)}</Chip>
                </span>
              </Button>
            ))}
            {rows.length === 0 && <p className="label-sm">{t('library.empty')}</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function CreateDashboardModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (d: AnalyticsDashboardDto) => void }) {
  const t = useTranslations('analytics');
  const tc = useTranslations('common');
  const [title, setTitle] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const create = useMutation({
    mutationFn: () => createAnalyticsDashboard({ title: title.trim(), tiles: [], visibility: isPrivate ? 'private' : 'shared' }),
    onSuccess: (d) => {
      setTitle('');
      onClose();
      onCreated(d);
    },
    onError: (e) => toastApiError(e),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('dashboards.new')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" tone="success" icon="check" disabled={!title.trim()} loading={create.isPending} onClick={() => create.mutate()}>{tc('actions.create')}</Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <Input label={t('builder.nameLabel')} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <Toggle checked={isPrivate} onChange={setPrivate} label={t('builder.private')} description={t('builder.privateHint')} />
      </div>
    </Modal>
  );
}
