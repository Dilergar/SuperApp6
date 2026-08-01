'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DriveNodeDto } from '@superapp/shared';
import { DRIVE_LIMITS } from '@superapp/shared';
import { Alert, Button, Card, PageHeader, useConfirm } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { driveRootKey, driveTrashKey } from '@/lib/queries';
import { fetchDriveTrash, purgeDriveNodes, restoreDriveNodes } from '@/lib/drive-api';
import { useDrive } from '../drive-shell';
import { DriveNodeList } from '../_components/DriveNodeList';

export default function DriveTrashPage() {
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
            .catch((e) => toastError(apiErrorMessage(e)))
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
              message:
                'Файл перестанет открываться везде, где на него ссылались, — включая вложения в чатах. Отменить это будет нельзя.',
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
      <PageHeader breadcrumb="Диск" title="Корзина" />
      <div style={{ marginBottom: 16 }}>
      <Alert tone="neutral">
        Объекты хранятся {DRIVE_LIMITS.trashRetentionDays} дней и всё это время занимают место. Пока
        объект в корзине, вложение в чате продолжает работать — оно перестанет открываться только
        после окончательного удаления.
      </Alert>
      </div>
      <Card>
        <DriveNodeList
          nodes={data?.items}
          loading={isPending}
          emptyIcon="delete"
          emptyTitle="Корзина пуста"
          renderActions={actions}
        />
      </Card>
      {confirmUI}
    </>
  );
}
