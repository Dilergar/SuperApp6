'use client';

import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DriveNodeDto } from '@superapp/shared';
import { DRIVE_LIMITS } from '@superapp/shared';
import { Alert, Button, Card, PageHeader, useConfirm } from '@/components/ui';

import { driveRootKey, driveTrashKey } from '@/lib/queries';
import { fetchDriveTrash, purgeDriveNodes, restoreDriveNodes } from '@/lib/drive-api';
import { useDrive } from '../drive-shell';
import { DriveNodeList } from '../_components/DriveNodeList';

import { toastApiError } from '@/lib/api-errors';
export default function DriveTrashPage() {
  const t = useTranslations('drive');
  const { ref } = useDrive();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();

  const { data, isPending } = useQuery({
    queryKey: driveTrashKey(ref),
    queryFn: () => fetchDriveTrash(ref),
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: driveRootKey });

  const actions = (node: DriveNodeDto) => (
    <>
      <Button
        variant="outline"
        size="sm"
        icon="restore"
        onClick={() =>
          void restoreDriveNodes([node.id])
            .then(refresh)
            .catch((e) => toastApiError(e))
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
              message:
                t('page.purgeConfirm.message'),
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
      <PageHeader breadcrumb={t('breadcrumb')} title={t('page.trash')} />
      <div style={{ marginBottom: 16 }}>
      <Alert tone="neutral">
        {t('page.trashHint', { days: DRIVE_LIMITS.trashRetentionDays })}
      </Alert>
      </div>
      <Card>
        <DriveNodeList
          nodes={data?.items}
          loading={isPending}
          emptyIcon="delete"
          emptyTitle={t('page.trashEmpty')}
          renderActions={actions}
        />
      </Card>
      {confirmUI}
    </>
  );
}
