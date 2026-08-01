'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, PageHeader, TickBar } from '@/components/ui';
import { driveNodeKey } from '@/lib/queries';
import { fetchDriveNode } from '@/lib/drive-api';
import { useDrive } from './drive-shell';
import { DriveBrowser } from './_components/DriveBrowser';
import { humanSize } from './_components/drive-ui';

export default function DriveHomePage() {
  const { ref, overview, canEdit, invalidate } = useDrive();
  const [folderId, setFolderId] = useState<string | null>(null);

  // Путь строим от открытой папки: у корня он состоит из одного звена.
  const { data: detail } = useQuery({
    queryKey: driveNodeKey(folderId ?? 'root'),
    queryFn: () => fetchDriveNode(folderId as string),
    enabled: !!folderId,
  });

  const rootName = overview?.space.title ?? 'Мой диск';
  const breadcrumbs = folderId
    ? [
        { id: null as string | null, name: rootName },
        ...(detail?.breadcrumbs ?? []).filter((b) => b.id !== overview?.space.rootId).map((b) => ({ id: b.id, name: b.name })),
        ...(detail ? [{ id: detail.node.id, name: detail.node.name }] : []),
      ]
    : [{ id: null as string | null, name: rootName }];

  const used = overview?.bytesUsed ?? 0;
  const limit = overview?.limitBytes ?? 1;
  const pct = Math.min(100, Math.round((used / limit) * 100));

  const onOpen = useCallback((id: string | null) => setFolderId(id), []);

  return (
    <>
      <PageHeader breadcrumb="Диск" title={rootName} />
      <Card>
        <DriveBrowser
          driveRef={ref}
          parentId={folderId}
          canEdit={canEdit}
          breadcrumbs={breadcrumbs}
          onOpenFolder={onOpen}
          onChanged={invalidate}
        />
      </Card>
      <Card small style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
          <span className="label-caps">Занято места</span>
          <span className="label-sm">
            {humanSize(used)} из {humanSize(limit)}
          </span>
        </div>
        {/* Прогресс в системе только штриховой */}
        <TickBar value={pct} tone={pct > 90 ? 'danger' : pct > 70 ? 'warning' : 'accent'} />
      </Card>
    </>
  );
}
