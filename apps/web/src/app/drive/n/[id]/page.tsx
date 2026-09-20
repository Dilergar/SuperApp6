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

import { getDownloadUrl } from '@/lib/files-api';
import { driveNodeKey } from '@/lib/queries';
import { fetchDriveNode } from '@/lib/drive-api';
import { useTranslations } from 'next-intl';
import { useBytes, useShortDate } from '@/lib/format';
import { driveIcon } from '../../_components/drive-ui';

import { toastApiError } from '@/lib/api-errors';
export default function DriveNodePage() {
  const t = useTranslations('drive');
  const humanSize = useBytes();
  const shortDate = useShortDate();
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
        title={t('node.unavailable')}
        description={t('node.unavailableHint')}
        action={<Button href="/drive">{t('node.toMyDrive')}</Button>}
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
              {node.kind === 'folder' ? t('kind.folder') : t('kind.file')}
              {node.subtreeBytes !== null && ` · ${humanSize(node.subtreeBytes)}`}
              {t('node.changed', { date: shortDate(node.updatedAt) })}
            </p>
          </div>
          <span style={{ flex: 1 }} />
          <Chip tone="accent">
            {access === 'owner' ? t('role.owner') : t(`role.${access}`)}
          </Chip>
        </div>

        {breadcrumbs.length > 0 && (
          <p className="label-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
            {t('node.path', { path: breadcrumbs.map((b) => b.name).join(' / ') })}
          </p>
        )}

        {usedElsewhere > 0 && (
          <p className="body-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
            {t('node.usedElsewhere', { n: usedElsewhere })}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {node.file && (
            <Button
              icon="download"
              onClick={() =>
                void getDownloadUrl(node.file!.id)
                  .then(({ url }) => window.open(url, '_blank', 'noopener'))
                  .catch((e) => toastApiError(e))
              }
            >
              {t('node.download')}
            </Button>
          )}
          <Link href={space.ownerType === 'workspace' ? `/workspaces/${space.ownerId}/drive` : `/drive?space=${space.id}`}>
            <Button variant="outline" icon="drive">
              {t('node.openDrive')}
            </Button>
          </Link>
        </div>
      </Card>
    </>
  );
}
