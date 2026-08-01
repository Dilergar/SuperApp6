'use client';

// Прямая ссылка на объект Диска (`/drive/n/<id>`): её раздают уведомление о шеринге,
// поиск и rich card в чате. Здесь показываем карточку объекта и путь — открывать
// сразу папку нельзя, потому что зритель мог получить доступ к ОДНОМУ файлу глубоко
// внутри чужого дерева, и «подняться на уровень выше» ему не положено.

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Chip, EmptyState, Icon, LoadingBlock, PageHeader } from '@/components/ui';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { getDownloadUrl } from '@/lib/files-api';
import { driveNodeKey } from '@/lib/queries';
import { fetchDriveNode } from '@/lib/drive-api';
import { driveIcon, humanSize, shortDate } from '../../_components/drive-ui';

export default function DriveNodePage() {
  const { id } = useParams<{ id: string }>();
  const { isReady } = useRequireAuth();

  const { data, isPending, isError } = useQuery({
    queryKey: driveNodeKey(id),
    queryFn: () => fetchDriveNode(id),
    enabled: isReady,
    retry: false,
  });

  if (!isReady || isPending) return <LoadingBlock />;
  if (isError || !data) {
    return (
      <EmptyState
        icon="blocked"
        title="Объект недоступен"
        description="Его удалили или доступ закрыли"
        action={<Button href="/drive">На мой диск</Button>}
      />
    );
  }

  const { node, breadcrumbs, space, access, usedElsewhere } = data;

  return (
    <>
      <PageHeader breadcrumb={space.title} title={node.name} />
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <Icon name={driveIcon(node)} size={28} style={{ color: 'var(--primary-dim)' }} />
          <div style={{ minWidth: 0 }}>
            <p className="title-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</p>
            <p className="label-sm" style={{ color: 'var(--muted)' }}>
              {node.kind === 'folder' ? 'Папка' : 'Файл'}
              {node.subtreeBytes !== null && ` · ${humanSize(node.subtreeBytes)}`}
              {` · изменён ${shortDate(node.updatedAt)}`}
            </p>
          </div>
          <span style={{ flex: 1 }} />
          <Chip tone="accent">
            {access === 'owner' ? 'Владелец' : access === 'manager' ? 'Управляет доступом' : access === 'editor' ? 'Правит' : 'Смотрит'}
          </Chip>
        </div>

        {breadcrumbs.length > 0 && (
          <p className="label-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
            Путь: {breadcrumbs.map((b) => b.name).join(' / ')}
          </p>
        )}

        {usedElsewhere > 0 && (
          <p className="body-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
            Этот файл используется ещё в {usedElsewhere} мест{usedElsewhere === 1 ? 'е' : 'ах'} —
            например, вложением в чате.
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {node.file && (
            <Button
              icon="download"
              onClick={() =>
                void getDownloadUrl(node.file!.id)
                  .then(({ url }) => window.open(url, '_blank', 'noopener'))
                  .catch((e) => toastError(apiErrorMessage(e)))
              }
            >
              Скачать
            </Button>
          )}
          <Link href={space.ownerType === 'workspace' ? `/workspaces/${space.ownerId}/drive` : `/drive?space=${space.id}`}>
            <Button variant="outline" icon="drive">
              Открыть диск
            </Button>
          </Link>
        </div>
      </Card>
    </>
  );
}
