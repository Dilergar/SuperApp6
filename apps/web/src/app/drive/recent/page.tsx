'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Card, PageHeader } from '@/components/ui';
import { driveRecentKey } from '@/lib/queries';
import { fetchDriveRecent } from '@/lib/drive-api';
import { DriveNodeList } from '../_components/DriveNodeList';

export default function DriveRecentPage() {
  const t = useTranslations('drive');
  const { data, isPending } = useQuery({ queryKey: driveRecentKey, queryFn: fetchDriveRecent });
  return (
    <>
      <PageHeader breadcrumb={t('breadcrumb')} title={t('page.recent')} />
      <Card>
        <DriveNodeList
          nodes={data}
          loading={isPending}
          emptyIcon="clock"
          emptyTitle={t('page.recentEmpty')}
        />
      </Card>
    </>
  );
}
