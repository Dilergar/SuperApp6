'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, PageHeader } from '@/components/ui';
import { driveRecentKey } from '@/lib/queries';
import { fetchDriveRecent } from '@/lib/drive-api';
import { DriveNodeList } from '../_components/DriveNodeList';

export default function DriveRecentPage() {
  const { data, isPending } = useQuery({ queryKey: driveRecentKey, queryFn: fetchDriveRecent });
  return (
    <>
      <PageHeader breadcrumb="Диск" title="Недавние" />
      <Card>
        <DriveNodeList
          nodes={data}
          loading={isPending}
          emptyIcon="clock"
          emptyTitle="Пока ничего не открывали"
        />
      </Card>
    </>
  );
}
