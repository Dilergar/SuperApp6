'use client';

import { useTranslations } from 'next-intl';
import { Card, PageHeader } from '@/components/ui';
import { useDrive } from '../drive-shell';
import { PhotoTimeline } from '../_components/PhotoTimeline';

export default function DrivePhotosPage() {
  const t = useTranslations('drive');
  const { ref } = useDrive();
  return (
    <>
      <PageHeader breadcrumb={t('breadcrumb')} title={t('page.photos')} />
      <Card>
        <PhotoTimeline driveRef={ref} />
      </Card>
    </>
  );
}
