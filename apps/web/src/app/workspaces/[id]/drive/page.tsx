'use client';

// ============================================================
// Диск организации — ОДИН маршрут с вкладками внутри.
//
// Так устроены все сервисы организации (Сотрудники, Процессы, Офис): второй уровень
// сайдбара в контексте организации не заводится, разделы живут вкладками.
// ============================================================

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DriveNodeDto } from '@superapp/shared';
import { DRIVE_LIMITS } from '@superapp/shared';
import { Alert, Button, Card, PageHeader, Tabs, TickBar, useConfirm } from '@/components/ui';
import { EntitlementLock } from '@/components/entitlements';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import {
  driveNodeKey,
  driveOverviewKey,
  driveRootKey,
  driveTrashKey,
} from '@/lib/queries';
import type { DriveSpaceRef } from '@superapp/shared';
import {
  fetchDriveNode,
  fetchDriveOverview,
  fetchDriveTrash,
  purgeDriveNodes,
  restoreDriveNodes,
} from '@/lib/drive-api';
import { DriveBrowser } from '../../../drive/_components/DriveBrowser';
import { DriveNodeList } from '../../../drive/_components/DriveNodeList';
import { PhotoTimeline } from '../../../drive/_components/PhotoTimeline';
import { useBytes } from '@/lib/format';

type Tab = 'files' | 'photos' | 'trash';

export default function WorkspaceDrivePage() {
  const t = useTranslations('drive');
  const humanSize = useBytes();
  const { id: workspaceId } = useParams<{ id: string }>();
  const { isReady } = useRequireAuth();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [tab, setTab] = useState<Tab>('files');
  const [folderId, setFolderId] = useState<string | null>(null);

  const driveRef: DriveSpaceRef = { workspaceId };

  const { data: overview } = useQuery({
    queryKey: driveOverviewKey(driveRef),
    queryFn: () => fetchDriveOverview(driveRef),
    enabled: isReady,
  });

  const { data: detail } = useQuery({
    queryKey: driveNodeKey(folderId ?? 'root'),
    queryFn: () => fetchDriveNode(folderId as string),
    enabled: !!folderId,
  });

  const { data: trash, isPending: trashPending } = useQuery({
    queryKey: driveTrashKey(driveRef),
    queryFn: () => fetchDriveTrash(driveRef),
    enabled: isReady && tab === 'trash',
  });

  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: driveRootKey }), [qc]);

  const rootName = overview?.space.title ?? t('rootNameOrg');
  const breadcrumbs = folderId
    ? [
        { id: null as string | null, name: rootName },
        ...(detail?.breadcrumbs ?? [])
          .filter((b) => b.id !== overview?.space.rootId)
          .map((b) => ({ id: b.id, name: b.name })),
        ...(detail ? [{ id: detail.node.id, name: detail.node.name }] : []),
      ]
    : [{ id: null as string | null, name: rootName }];

  const used = overview?.bytesUsed ?? 0;
  const limit = overview?.limitBytes ?? null;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const canEdit = overview ? overview.space.access !== 'viewer' : false;

  const trashActions = (node: DriveNodeDto) => (
    <>
      <Button
        variant="outline"
        size="sm"
        icon="restore"
        onClick={() =>
          void restoreDriveNodes([node.id]).then(refresh).catch((e) => toastError(apiErrorMessage(e)))
        }
      >
        {t('page.restore')}
      </Button>
      <Button
        variant="matte"
        tone="danger"
        size="sm"
        onClick={() =>
          confirm(
            {
              title: t('page.purgeConfirm.title', { name: node.name }),
              message: t('page.purgeConfirm.message'),
              confirmLabel: t('page.purge'),
              danger: true,
            },
            async () => {
              await purgeDriveNodes([node.id]);
              refresh();
            },
          )
        }
      >
        {t('page.purge')}
      </Button>
    </>
  );

  return (
    <>
      <PageHeader breadcrumb={t('orgBreadcrumb')} title={rootName} />
      <Tabs
        items={[
          { key: 'files', label: t('tab.files'), icon: 'folder' },
          { key: 'photos', label: t('page.photos'), icon: 'image' },
          { key: 'trash', label: t('page.trash'), icon: 'delete' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
      />

      <Card style={{ marginTop: 16 }}>
        {tab === 'files' && (
          <DriveBrowser
            driveRef={driveRef}
            parentId={folderId}
            canEdit={canEdit}
            breadcrumbs={breadcrumbs}
            onOpenFolder={setFolderId}
            onChanged={refresh}
          />
        )}
        {tab === 'photos' && <PhotoTimeline driveRef={driveRef} />}
        {tab === 'trash' && (
          <>
            <div style={{ marginBottom: 12 }}>
            <Alert tone="neutral">{t('org.trashHint', { days: DRIVE_LIMITS.trashRetentionDays })}</Alert>
            </div>
            <DriveNodeList
              nodes={trash?.items}
              loading={trashPending}
              emptyIcon="delete"
              emptyTitle={t('page.trashEmpty')}
              renderActions={trashActions}
            />
          </>
        )}
      </Card>

      <Card small style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
          <span className="label-caps">{t('org.usedSpace')}</span>
          <span className="label-sm">{limit === null ? t('page.usedNoLimit', { used: humanSize(used) }) : t('page.usedOf', { used: humanSize(used), limit: humanSize(limit) })}</span>
          <EntitlementLock keyName="files.storageBytes" workspaceId={workspaceId} id="ent-lock-drive" />
        </div>
        <TickBar value={pct} tone={pct > 90 ? 'danger' : pct > 70 ? 'warning' : 'accent'} />
      </Card>
      {confirmUI}
    </>
  );
}
