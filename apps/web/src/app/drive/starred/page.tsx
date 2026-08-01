'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, PageHeader } from '@/components/ui';
import { driveStarredKey } from '@/lib/queries';
import { fetchDriveStarred } from '@/lib/drive-api';
import { DriveNodeList } from '../_components/DriveNodeList';

export default function DriveStarredPage() {
  const { data, isPending } = useQuery({ queryKey: driveStarredKey, queryFn: fetchDriveStarred });
  return (
    <>
      <PageHeader breadcrumb="Диск" title="Избранное" />
      <Card>
        <DriveNodeList
          nodes={data}
          loading={isPending}
          emptyIcon="star"
          emptyTitle="Тут пока пусто"
          emptyText="Отмечайте звёздочкой то, к чему возвращаетесь чаще всего"
        />
      </Card>
    </>
  );
}
