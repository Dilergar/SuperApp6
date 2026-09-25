'use client';

import { useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { ChatterActorLite, Workspace, WorkspaceMember } from '@superapp/shared';
import { BentoGrid, Button, Card, CardHeader, Chip, EmptyState, LoadingBlock, PageHeader, StatTile, Tabs, type TabItem } from '@/components/ui';
import { ChronicleFeed } from '@/components/chatter/ChronicleFeed';
import { apiGet } from '@/lib/api';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useBytes, useFormatters } from '@/lib/format';
import { chronicleKey, fetchChronicle, lifecycleSettingsKey, lifecycleSummaryKey, workspaceKey, workspaceMembersKey } from '@/lib/queries';
import { fetchLifecycleSettings, fetchLifecycleSummary } from '@/lib/lifecycle-api';
import { DataExports } from './DataExports';
import { RetentionClassCard } from './RetentionClassCard';
import { WorkspaceHolds } from './WorkspaceHolds';
import { useDurationLabel } from './duration';

export type WorkspaceDataTab = 'retention' | 'holds' | 'exports' | 'history';
export const WORKSPACE_DATA_TABS: readonly WorkspaceDataTab[] = ['retention', 'holds', 'exports', 'history'];

/**
 * «Данные и сроки хранения» организации (core/lifecycle Э5, план §11.2) — владелец и админ.
 * Четыре плитки сводки, разделы по URL: сроки хранения (пресеты, последствия до действия,
 * отложенное сокращение), заморозки, выгрузки (архив данных организации — заказывает
 * владелец, видят владелец и админы), история изменений.
 */
export function WorkspaceDataPage({ workspaceId, tab }: { workspaceId: string; tab: WorkspaceDataTab }) {
  const t = useTranslations('lifecycle');
  const tw = useTranslations('workspaces');
  const router = useRouter();
  const fmt = useFormatters();
  const bytes = useBytes();
  const label = useDurationLabel();
  const { isReady } = useRequireAuth();

  const wsQ = useQuery({ queryKey: workspaceKey(workspaceId), queryFn: () => apiGet<Workspace>(`/workspaces/${workspaceId}`), enabled: isReady });
  const canManage = wsQ.data?.myRole === 'owner' || wsQ.data?.myRole === 'admin';
  const settingsQ = useQuery({ queryKey: lifecycleSettingsKey(workspaceId), queryFn: () => fetchLifecycleSettings(workspaceId), enabled: isReady && canManage });
  const summaryQ = useQuery({ queryKey: lifecycleSummaryKey(workspaceId), queryFn: () => fetchLifecycleSummary(workspaceId), enabled: isReady && canManage });
  const membersQ = useQuery({ queryKey: workspaceMembersKey(workspaceId), queryFn: () => apiGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`), enabled: isReady && canManage });
  const byUser = useMemo(() => new Map((membersQ.data ?? []).map((m) => [m.userId, m])), [membersQ.data]);
  const member = useCallback((userId: string) => byUser.get(userId), [byUser]);

  const historyQ = useInfiniteQuery({
    queryKey: chronicleKey('lifecycle_settings', workspaceId),
    queryFn: ({ pageParam }) => fetchChronicle('lifecycle_settings', workspaceId, { ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isReady && canManage && tab === 'history',
  });
  const history = useMemo(() => (historyQ.data?.pages ?? []).flatMap((p) => p.items), [historyQ.data]);
  const actors = useMemo(() => {
    const merged: Record<string, ChatterActorLite> = {};
    for (const p of historyQ.data?.pages ?? []) Object.assign(merged, p.actors);
    return merged;
  }, [historyQ.data]);

  const tabs: TabItem<WorkspaceDataTab>[] = [
    { key: 'retention', label: t('data.tabs.retention'), icon: 'archive' },
    { key: 'holds', label: t('data.tabs.holds'), icon: 'lock', count: summaryQ.data?.activeHolds || undefined },
    { key: 'exports', label: t('data.tabs.exports'), icon: 'download' },
    { key: 'history', label: t('data.tabs.history'), icon: 'history' },
  ];

  if (wsQ.isPending) return <LoadingBlock />;
  if (!canManage) return <EmptyState icon="lock" title={t('data.noAccess')} description={t('data.noAccessText')} />;

  const s = summaryQ.data;
  const records = s ? s.counts.reduce((a, c) => a + c.rows, 0) : null;
  const recordsCapped = !!s?.counts.some((c) => c.capped);
  const next = s?.nextDeletion ?? null;

  return (
    <>
      <PageHeader breadcrumb={tw('profile.title')} title={t('data.title')} description={t('data.description')} />
      <BentoGrid>
        <StatTile
          span={3}
          label={s?.storage.limitBytes ? t('data.tiles.storageOf', { limit: bytes(s.storage.limitBytes) }) : t('data.tiles.storage')}
          value={s ? bytes(s.storage.usedBytes) : '—'}
          icon="drive"
          tone="accent"
        />
        <StatTile
          span={3}
          label={t('data.tiles.records')}
          value={records === null ? '—' : `${fmt.number(records)}${recordsCapped ? '+' : ''}`}
          icon="database"
          tone="accent"
        />
        <StatTile
          span={3}
          label={next ? t(next.reason === 'pending' ? 'data.tiles.nextPending' : 'data.tiles.nextNightly', { classLabel: t(`settings.classes.${next.dataClass}.title`) }) : t('data.tiles.next')}
          value={next ? fmt.date(next.at) : t('data.tiles.nextNone')}
          icon="clock"
          tone={next ? 'waiting' : 'success'}
        />
        <StatTile span={3} label={t('data.tiles.holds')} value={s ? fmt.number(s.activeHolds) : '—'} icon="lock" tone="neutral" />
      </BentoGrid>

      <div style={{ margin: 'var(--spacing-5) 0 var(--spacing-4)' }}>
        <Tabs<WorkspaceDataTab> items={tabs} value={tab} onChange={(k) => router.push(`/workspaces/${workspaceId}/profile/data/${k}`)} aria-label={t('data.title')} />
      </div>

      {tab === 'retention' &&
        (settingsQ.isPending ? (
          <LoadingBlock />
        ) : settingsQ.data ? (
          <BentoGrid>
            {settingsQ.data.classes.map((cls) => (
              <RetentionClassCard
                key={cls.dataClass}
                workspaceId={workspaceId}
                workspaceName={wsQ.data?.name ?? ''}
                cls={cls}
                presets={settingsQ.data.presets}
                delayDays={settingsQ.data.shorteningDelayDays}
                member={member}
              />
            ))}
            <Card span={12}>
              <CardHeader title={t('retention.lawTitle')} />
              <p className="body-sm" style={{ margin: '0 0 var(--spacing-3)' }}>{t('retention.lawText')}</p>
              <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
                {settingsQ.data.law.map((l) => (
                  <div key={l.dataClass} style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                    <div className="ui-stack" style={{ gap: 2, minWidth: 0 }}>
                      <span className="title-sm">{t(`classes.${l.dataClass}.title`)}</span>
                      {l.citation && <span className="label-sm">{t(`citations.${l.citation}`)}</span>}
                    </div>
                    {l.floorDays !== null && <Chip tone="neutral" icon="lock" size="sm">{t('retention.lawFloor', { duration: label(l.floorDays) })}</Chip>}
                  </div>
                ))}
              </div>
            </Card>
          </BentoGrid>
        ) : null)}

      {tab === 'holds' && (
        <BentoGrid>
          <WorkspaceHolds workspaceId={workspaceId} member={member} />
        </BentoGrid>
      )}

      {tab === 'exports' && (
        <BentoGrid>
          <DataExports scope={{ kind: 'workspace', workspaceId, isOwner: wsQ.data?.myRole === 'owner', member }} />
        </BentoGrid>
      )}

      {tab === 'history' && (
        <BentoGrid>
          <Card span={12}>
            <CardHeader title={t('data.tabs.history')} />
            {historyQ.isPending ? (
              <LoadingBlock />
            ) : (
              <ChronicleFeed entries={history as never[]} actors={actors} emptyText={t('data.historyEmpty')} />
            )}
            {historyQ.hasNextPage && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--spacing-4)' }}>
                <Button variant="ghost" loading={historyQ.isFetchingNextPage} onClick={() => void historyQ.fetchNextPage()}>{t('holds.more')}</Button>
              </div>
            )}
          </Card>
        </BentoGrid>
      )}
    </>
  );
}
