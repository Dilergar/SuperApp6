'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Card, PageHeader } from '@/components/ui';
import { driveStarredKey } from '@/lib/queries';
import { fetchDriveStarred } from '@/lib/drive-api';
import { DriveNodeList } from '../_components/DriveNodeList';

export default function DriveStarredPage() {
  const t = useTranslations('drive');
  const { data, isPending } = useQuery({ queryKey: driveStarredKey, queryFn: fetchDriveStarred });
  return (
    <>
      <PageHeader breadcrumb={t('breadcrumb')} title={t('page.starred')} />
      <Card>
        <DriveNodeList
          nodes={data}
          loading={isPending}
          emptyIcon="star"
          emptyTitle={t('page.starredEmpty')}
          emptyText={t('page.starredEmptyHint')}
        />
      </Card>
    </>
  );
}
