'use client';

import { Card, PageHeader } from '@/components/ui';
import { useDrive } from '../drive-shell';
import { PhotoTimeline } from '../_components/PhotoTimeline';

export default function DrivePhotosPage() {
  const { ref } = useDrive();
  return (
    <>
      <PageHeader breadcrumb="Диск" title="Фото" />
      <Card>
        <PhotoTimeline driveRef={ref} />
      </Card>
    </>
  );
}
