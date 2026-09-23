'use client';

// ============================================================
// Журнал безопасности организации (core/audit): входы сотрудников с новых устройств, роли,
// ключи и интеграции, выгрузки, согласия — только события СВОЕГО контекста; личные входы
// людей организации не видны никогда, полный IP — тоже. Окно — тариф (`audit.retentionDays`).
// Доступ — владелец и админы (гейт серверный: 403; остальным пункта нет и в навигации).
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AUDIT_ORG_FILTERS, type AuditOrgFilter, type AuditOutcome, type SecurityEventDto, type SecurityEventPageDto, type Workspace, type WorkspaceRole } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiGet } from '@/lib/api';
import { fetchOrgSecurityEvent, fetchOrgSecurityEvents, fetchOrgSecurityOverview } from '@/lib/audit-api';
import { orgSecurityEventKey, orgSecurityEventsKey, orgSecurityOverviewKey, workspaceKey } from '@/lib/queries';
import { EntitlementLock, useEntitlementGate } from '@/components/entitlements';
import { ExportModal } from './ExportModal';
import { useFormatters } from '@/lib/format';
import { analytics } from '@/lib/analytics';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';
import { ActorView, SecurityEventModal } from '@/components/security/SecurityEventParts';
import { eventIcon, eventTone, outcomeTone } from '@/components/security/event-visuals';
import { Alert, BentoGrid, Button, Card, Chip, DatePicker, EmojiIcon, EmptyState, LoadingBlock, PageHeader, Table, TableCell, TableRow, type TableColumn } from '@/components/ui';

const OUTCOMES: AuditOutcome[] = ['success', 'failure'];
/** Самое длинное окно тарифа — у него плашки «на старших тарифах дольше» нет */
const MAX_WINDOW_DAYS = 1095;

export default function WorkspaceSecurityPage() {
  const t = useTranslations('audit');
  const tw = useTranslations('workspaces');
  const tc = useTranslations('common');
  const fmt = useFormatters();
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const [filter, setFilter] = useState<AuditOrgFilter>('all');
  const [who, setWho] = useState<Principal[]>([]);
  const [from, setFrom] = useState<Date | null>(null);
  const [to, setTo] = useState<Date | null>(null);
  const [outcome, setOutcome] = useState<AuditOutcome | null>(null);
  const [opened, setOpened] = useState<SecurityEventDto | null>(null);
  const [exporting, setExporting] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  // Ссылка из уведомления («выгрузка готова», событие) — `?e=<id>` открывает событие
  const linkedId = search.get('e');
  const exportGate = useEntitlementGate('audit.export', id, 'ent-lock-audit-export');
  const streamGate = useEntitlementGate('audit.stream', id, 'ent-lock-audit-stream');

  const wsQuery = useQuery({ queryKey: workspaceKey(id), queryFn: async () => await apiGet<Workspace>(`/workspaces/${id}`), enabled: isReady });
  const myRole = wsQuery.data?.myRole as WorkspaceRole | undefined;
  const isManager = myRole === 'owner' || myRole === 'admin';

  const overview = useQuery({ queryKey: orgSecurityOverviewKey(id), queryFn: () => fetchOrgSecurityOverview(id), enabled: isManager });
  const query = useMemo(
    () => ({
      filter,
      ...(who[0] ? { actorId: who[0].id } : {}),
      ...(from ? { from: from.toISOString() } : {}),
      ...(to ? { to: new Date(to.getTime() + 86_399_000).toISOString() } : {}),
      ...(outcome ? { outcome } : {}),
    }),
    [filter, who, from, to, outcome],
  );
  const q = useInfiniteQuery({
    queryKey: orgSecurityEventsKey(id, query),
    queryFn: ({ pageParam }) => fetchOrgSecurityEvents(id, { ...query, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: SecurityEventPageDto) => last.nextCursor,
    enabled: isManager,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const linked = useQuery({ queryKey: orgSecurityEventKey(id, linkedId ?? '-'), queryFn: () => fetchOrgSecurityEvent(id, linkedId!), enabled: isManager && !!linkedId, retry: false });
  const shown = opened ?? (linkedId ? (linked.data ?? null) : null);
  const closeEvent = () => {
    setOpened(null);
    if (linkedId) router.replace(pathname, { scroll: false });
  };
  const windowDays = q.data?.pages[0]?.windowDays ?? overview.data?.retentionDays ?? null;

  useEffect(() => {
    if (isManager) analytics.track('audit.feed.viewed', { viewer: 'workspace', filter });
  }, [isManager, filter]);

  if (!isReady || wsQuery.isPending) return <LoadingBlock />;

  const header = (
    <PageHeader
      breadcrumb={wsQuery.data?.name ?? tw('orgFallback')}
      title={t('org.title')}
      description={t('org.description')}
      actions={
        isManager ? (
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="outline" icon="download" disabled={exportGate.blocked} aria-describedby={exportGate.describedBy} onClick={() => setExporting(true)}>
              {t('org.export.open')}
            </Button>
            <EntitlementLock keyName="audit.export" workspaceId={id} id="ent-lock-audit-export" />
            <Button variant="ghost" icon="broadcast" disabled={streamGate.blocked} aria-describedby={streamGate.describedBy} href={streamGate.blocked ? undefined : `/workspaces/${id}/integrations?tab=webhooks`}>
              {t('org.stream')}
            </Button>
            <EntitlementLock keyName="audit.stream" workspaceId={id} id="ent-lock-audit-stream" />
          </div>
        ) : undefined
      }
    />
  );

  if (wsQuery.isError || !isManager) {
    return (
      <>
        {header}
        <BentoGrid>
          <Card span={12}>
            <EmptyState icon="lock" title={t('org.noAccess')} />
          </Card>
        </BentoGrid>
      </>
    );
  }

  const columns: TableColumn[] = [
    { key: 'time', label: t('org.col.time'), width: '8.5rem' },
    { key: 'event', label: t('org.col.event') },
    { key: 'who', label: t('org.col.who'), width: 'max-content' },
    { key: 'where', label: t('org.col.where'), hideOnMobile: true, width: 'max-content' },
    { key: 'outcome', label: t('org.col.outcome'), width: 'max-content' },
  ];
  const dirty = filter !== 'all' || who.length > 0 || !!from || !!to || !!outcome;

  return (
    <>
      {header}
      {windowDays !== null && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <Alert tone="accent" icon="info" action={windowDays < MAX_WINDOW_DAYS ? <Button size="sm" variant="ghost" href={`/workspaces/${id}/profile/subscription`}>{t('org.plan')}</Button> : undefined}>
            {t('org.window', { days: windowDays })}
            {windowDays < MAX_WINDOW_DAYS ? ` ${t('org.windowMore')}` : ''}
          </Alert>
        </div>
      )}
      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
          <div role="group" aria-label={t('ui.feed.filters')} style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
            {AUDIT_ORG_FILTERS.map((f) => (
              <Chip key={f} size="sm" selected={filter === f} onClick={() => setFilter(f)}>{t(`filters.org.${f}`)}</Chip>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ minWidth: 220, flex: '1 1 220px', maxWidth: 360 }}>
              <div className="label-caps" style={{ marginBottom: 6 }}>{t('org.who')}</div>
              <EntitySelector types={['user']} multi={false} value={who} onChange={(v) => setWho(v.slice(-1))} context={{ workspaceId: id }} />
            </div>
            <DatePicker label={t('org.from')} value={from} onChange={setFrom} clearable width={160} />
            <DatePicker label={t('org.to')} value={to} onChange={setTo} clearable width={160} />
            <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', paddingBottom: '0.5rem' }}>
              {OUTCOMES.map((o) => (
                <Chip key={o} size="sm" tone={outcomeTone(o)} selected={outcome === o} onClick={() => setOutcome(outcome === o ? null : o)}>{t(`outcomes.${o}`)}</Chip>
              ))}
            </div>
            {dirty && (
              <Button variant="ghost" size="sm" icon="close" onClick={() => { setFilter('all'); setWho([]); setFrom(null); setTo(null); setOutcome(null); }}>
                {tc('actions.reset')}
              </Button>
            )}
          </div>
        </div>

        {q.isPending ? (
          <LoadingBlock />
        ) : q.isError ? (
          <Alert tone="danger" action={<Button size="sm" variant="ghost" icon="refresh" onClick={() => void q.refetch()}>{tc('actions.retry')}</Button>}>{t('ui.feed.loadFailed')}</Alert>
        ) : items.length === 0 ? (
          <EmptyState icon="shield" title={t('org.empty')} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table columns={columns} lines aria-label={t('org.title')}>
              {items.map((e, i) => (
                <TableRow key={e.id} rowIndex={i + 2} onClick={() => setOpened(e)}>
                  <TableCell><span className="label-sm">{fmt.dateTime(e.occurredAt, 'short')}</span></TableCell>
                  <TableCell>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                      <EmojiIcon emoji={eventIcon(e)} tone={eventTone(e)} size={28} />
                      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span className="body-sm" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{e.title}</span>
                        {e.target?.label && <span className="label-sm" style={{ overflowWrap: 'anywhere' }}>{e.target.label}</span>}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell><ActorView actor={e.actor} /></TableCell>
                  <TableCell hideOnMobile>
                    <span className="label-sm">{[e.location.country ? fmt.country(e.location.country) : null, e.device.class ? t(`deviceClasses.${e.device.class}`) : null].filter(Boolean).join(' · ') || '—'}</span>
                  </TableCell>
                  <TableCell><Chip size="sm" tone={outcomeTone(e.outcome)}>{t(`outcomes.${e.outcome}`)}</Chip></TableCell>
                </TableRow>
              ))}
            </Table>
          </div>
        )}
        {q.hasNextPage && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--spacing-4)' }}>
            <Button variant="outline" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>{tc('actions.loadMore')}</Button>
          </div>
        )}
      </Card>
      <SecurityEventModal event={shown} open={!!shown} viewer="workspace" onClose={closeEvent} />
      {exporting && <ExportModal workspaceId={id} windowDays={windowDays ?? 90} onClose={() => setExporting(false)} />}
    </>
  );
}
