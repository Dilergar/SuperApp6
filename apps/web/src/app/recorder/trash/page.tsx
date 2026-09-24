'use client';

import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RECORDER_LIMITS } from '@superapp/shared';
import { Alert, Card, PageHeader } from '@/components/ui';
import { TrashTable, type TrashRow } from '@/components/trash/TrashTable';
import { listRecorderTrash, purgeRecording, restoreRecording } from '@/lib/voice-api';
import { recorderRecordingsKey, recorderTrashKey } from '@/lib/queries';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { formatDuration } from '@/components/files/files-ui';

export default function RecorderTrashPage() {
  const t = useTranslations('recorder');
  const { isReady } = useRequireAuth();
  const qc = useQueryClient();
  const { data, isPending } = useQuery({ queryKey: recorderTrashKey, queryFn: listRecorderTrash, enabled: isReady });

  const rows: TrashRow[] | undefined = data?.map((rec) => ({
    id: rec.id,
    title: rec.title,
    icon: 'recorder',
    meta: rec.durationMs != null ? formatDuration(rec.durationMs) ?? undefined : undefined,
    deletedAt: rec.deletedAt,
    purgeAt: rec.purgeAt,
  }));

  return (
    <div style={{ padding: 'var(--spacing-6)', maxWidth: 1100 }}>
      <PageHeader breadcrumb={t('trash.breadcrumb')} title={t('trash.title')} description={t('trash.description')} />
      <div style={{ marginBottom: 16 }}>
        <Alert tone="neutral">{t('trash.hint', { days: RECORDER_LIMITS.trashRetentionDays })}</Alert>
      </div>
      <Card>
        <TrashTable
          rows={rows}
          loading={isPending}
          purgeConfirm={(row) => ({ title: t('trash.purgeConfirm.title', { name: row.title }), message: t('trash.purgeConfirm.message') })}
          onRestore={(row) => restoreRecording(row.id)}
          onPurge={(row) => purgeRecording(row.id)}
          onChanged={() => {
            void qc.invalidateQueries({ queryKey: recorderTrashKey });
            void qc.invalidateQueries({ queryKey: recorderRecordingsKey });
          }}
        />
      </Card>
    </div>
  );
}
