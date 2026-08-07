'use client';

// ============================================================
// Диск организации — ОДИН маршрут с вкладками внутри.
//
// Так устроены все сервисы организации (Сотрудники, Процессы, Офис): второй уровень
// сайдбара в контексте организации не заводится, разделы живут вкладками.
// ============================================================

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DriveNodeDto } from '@superapp/shared';
import { DRIVE_LIMITS } from '@superapp/shared';
import { Alert, Button, Card, PageHeader, Tabs, TickBar, useConfirm } from '@/components/ui';
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
import { humanSize } from '../../../drive/_components/drive-ui';

type Tab = 'files' | 'photos' | 'trash';

export default function WorkspaceDrivePage() {
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

  const rootName = overview?.space.title ?? 'Диск организации';
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
  const limit = overview?.limitBytes ?? 1;
  const pct = Math.min(100, Math.round((used / limit) * 100));
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
        Восстановить
      </Button>
      <Button
        variant="matte"
        tone="danger"
        size="sm"
        onClick={() =>
          confirm(
            {
              title: `Удалить «${node.name}» навсегда?`,
              message: 'Файл перестанет открываться везде, где на него ссылались, включая вложения в чатах.',
              confirmLabel: 'Удалить навсегда',
              danger: true,
            },
            async () => {
              await purgeDriveNodes([node.id]);
              refresh();
            },
          )
        }
      >
        Удалить навсегда
      </Button>
    </>
  );

  return (
    <>
      <PageHeader breadcrumb="Организация" title={rootName} />
      <Tabs
        items={[
          { key: 'files', label: 'Файлы', icon: 'folder' },
          { key: 'photos', label: 'Фото', icon: 'image' },
          { key: 'trash', label: 'Корзина', icon: 'delete' },
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
            <Alert tone="neutral">
              Объекты хранятся {DRIVE_LIMITS.trashRetentionDays} дней и всё это время занимают место
              организации.
            </Alert>
            </div>
            <DriveNodeList
              nodes={trash?.items}
              loading={trashPending}
              emptyIcon="delete"
              emptyTitle="Корзина пуста"
              renderActions={trashActions}
            />
          </>
        )}
      </Card>

      <Card small style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
          <span className="label-caps">Занято места организацией</span>
          <span className="label-sm">
            {humanSize(used)} из {humanSize(limit)}
          </span>
        </div>
        <TickBar value={pct} tone={pct > 90 ? 'danger' : pct > 70 ? 'warning' : 'accent'} />
      </Card>
      {confirmUI}
    </>
  );
}
