'use client';

// ============================================================
// Выгрузки данных целиком (core/lifecycle Э6, план §11.2–11.3): один компонент на два места —
// «Мои данные целиком» в профиле и раздел «Выгрузки» данных организации.
//  - заказ и КАЖДАЯ ссылка на скачивание — под окном SMS-подтверждения `data_export`
//    (15 минут; угнанная сессия без SIM архив не унесёт);
//  - ход сборки — штриховой прогресс по фазам; готовый архив — части, у каждой счёт «N из 5»,
//    ссылка живёт 5 минут и выдаётся на нажатие;
//  - статус — Chip, действие — Button; качает только заказавший (у организации список видят
//    владелец и админы, заказывает владелец);
//  - сокет `lifecycle:export.updated` перечитывает список, пока идёт сборка — и опрос.
// ============================================================

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { LifecycleExportDto, LifecycleExportStatus, WorkspaceMember } from '@superapp/shared';
import { Button, Card, CardHeader, Chip, EmptyState, LoadingBlock, TickBar, type Tone } from '@/components/ui';
import { EntitlementLock, useEntitlementGate } from '@/components/entitlements/EntitlementLock';
import { useStepUp } from '@/components/verify/useStepUp';
import { PersonChip } from '@/app/circles/PersonCard';
import { splitName } from '@/app/workspaces/[id]/members/members-lib';
import { toastApiError } from '@/lib/api-errors';
import { useBytes, useFormatters } from '@/lib/format';
import { useEntitlementDenied } from '@/lib/hooks/useEntitlements';
import { exportPartLink, fetchMyExports, fetchWorkspaceExports, requestMyExport, requestWorkspaceExport } from '@/lib/lifecycle-api';
import { myExportsKey, workspaceExportsKey } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime/useRealtime';

export type DataExportsScope =
  | { kind: 'user' }
  | { kind: 'workspace'; workspaceId: string; isOwner: boolean; member: (userId: string) => WorkspaceMember | undefined };

const STATUS_TONE: Record<LifecycleExportStatus, Tone> = {
  queued: 'waiting',
  running: 'accent',
  ready: 'success',
  failed: 'warning',
  expired: 'neutral',
};

const live = (e: LifecycleExportDto) => e.status === 'queued' || e.status === 'running';

export function DataExports({ scope }: { scope: DataExportsScope }) {
  const t = useTranslations('dataExports');
  const fmt = useFormatters();
  const bytes = useBytes();
  const qc = useQueryClient();
  const denied = useEntitlementDenied();
  const workspaceId = scope.kind === 'workspace' ? scope.workspaceId : null;
  const key = workspaceId ? workspaceExportsKey(workspaceId) : myExportsKey;
  const gate = useEntitlementGate('lifecycle.export', workspaceId);
  const stepUp = useStepUp('data_export', { title: t('stepUpTitle'), body: t('stepUpBody') });

  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => (workspaceId ? fetchWorkspaceExports(workspaceId, pageParam) : fetchMyExports(pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Пока идёт сборка — опрос (сокет может пропасть); готово — только по событию
    refetchInterval: (query) => ((query.state.data?.pages ?? []).some((p) => p.items.some(live)) ? 5_000 : false),
  });
  const items = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items), [q.data]);
  const building = items.some(live);

  useRealtime({
    onLifecycleExportUpdated: (p) => {
      if (p.subjectType === (workspaceId ? 'workspace' : 'user')) void qc.invalidateQueries({ queryKey: key });
    },
  });

  const request = () =>
    stepUp
      .withStepUp(() => (workspaceId ? requestWorkspaceExport(workspaceId) : requestMyExport()))
      .then(() => qc.invalidateQueries({ queryKey: key }))
      .catch((err: unknown) => {
        if (!denied(err)) toastApiError(err);
      });

  const download = (e: LifecycleExportDto, part: number) =>
    stepUp
      .withStepUp(() => exportPartLink(e.id, part))
      .then((link) => {
        if (link) window.location.assign(link.url);
        return qc.invalidateQueries({ queryKey: key });
      })
      .catch((err: unknown) => {
        toastApiError(err);
        void qc.invalidateQueries({ queryKey: key });
      });

  const person = (userId: string) => {
    if (scope.kind !== 'workspace') return null;
    const m = scope.member(userId);
    if (!m) return null;
    const [fn, ln] = splitName(m.userName);
    return <PersonChip size="XS" userId={m.userId} firstName={fn} lastName={ln} avatar={m.userAvatar} />;
  };

  const canRequest = scope.kind === 'user' || scope.isOwner;

  return (
    <Card span={12} id="exports">
      <CardHeader
        title={t(workspaceId ? 'titleWorkspace' : 'titleUser')}
        actions={
          canRequest ? (
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {workspaceId && <EntitlementLock keyName="lifecycle.export" workspaceId={workspaceId} id={gate.lockId} />}
              <Button variant="primary" icon="download" disabled={building || (!!workspaceId && gate.blocked)} aria-describedby={workspaceId ? gate.describedBy : undefined} onClick={() => void request()}>
                {t('request')}
              </Button>
            </div>
          ) : undefined
        }
      />
      <p className="body-sm" style={{ margin: '0 0 var(--spacing-3)' }}>{t(workspaceId ? 'descriptionWorkspace' : 'descriptionUser')}</p>
      {!canRequest && <p className="label-sm" style={{ margin: '0 0 var(--spacing-3)' }}>{t('ownerOnly')}</p>}
      {q.isPending ? (
        <LoadingBlock />
      ) : items.length === 0 ? (
        <EmptyState icon="download" title={t('empty')} description={t('emptyText')} />
      ) : (
        <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
          {items.map((e) => (
            <div key={e.id} className="ui-stack" style={{ gap: 'var(--spacing-2)', paddingTop: 'var(--spacing-3)', borderTop: '1px solid var(--divider)' }}>
              <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                  <span className="title-sm">{t('archiveOf', { date: fmt.dateTime(e.createdAt) })}</span>
                  <Chip size="sm" tone={STATUS_TONE[e.status]} icon={e.status === 'ready' ? 'check' : e.status === 'expired' ? 'clock' : undefined}>{t(`status.${e.status}`)}</Chip>
                </div>
                {workspaceId && (
                  <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center' }}>
                    <span className="label-sm">{t('requestedBy')}</span>
                    {person(e.requestedById)}
                  </div>
                )}
              </div>
              {live(e) && e.progress && (
                <TickBar
                  value={e.progress.total ? (e.progress.done / e.progress.total) * 100 : 0}
                  label={e.progress.phase === 'finish' ? t('phase.finish') : t(`phase.${e.progress.phase}`, { done: e.progress.done, total: e.progress.total })}
                />
              )}
              {e.status === 'failed' && <span className="label-sm">{t(`errors.${e.errorCode ?? 'internal'}`)}</span>}
              {e.status === 'expired' && <span className="label-sm">{t('expiredText')}</span>}
              {e.status === 'ready' && (
                <>
                  <span className="label-sm">{t('readyUntil', { size: bytes(e.bytes), date: e.expiresAt ? fmt.dateTime(e.expiresAt) : '—' })}</span>
                  {e.canDownload ? (
                    <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                      {e.parts.map((p) => {
                        const exhausted = p.downloads >= p.maxDownloads;
                        return (
                          <div key={p.index} style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                            <Button size="sm" variant="matte" icon="download" disabled={exhausted} onClick={() => void download(e, p.index)} aria-label={t('downloadPart', { n: p.index })}>
                              {e.parts.length > 1 ? `${t('part', { n: p.index })} · ${bytes(p.bytes)}` : bytes(p.bytes)}
                            </Button>
                            <Chip size="sm" tone={exhausted ? 'neutral' : 'accent'}>{exhausted ? t('exhausted') : t('downloads', { used: p.downloads, max: p.maxDownloads })}</Chip>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="label-sm">{t('requesterDownloads')}</span>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {q.hasNextPage && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--spacing-4)' }}>
          <Button variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('more')}
          </Button>
        </div>
      )}
      {stepUp.dialog}
    </Card>
  );
}
