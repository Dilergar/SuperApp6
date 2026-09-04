'use client';

// ============================================================
// Оборудование объекта — плитки с фото, статусом и ответственным.
// Список — infinite-запрос (свой ключ), карточка — отдельный ключ:
// один RQ-ключ = одна форма кэша.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSET_STATUSES, type AssetDto, type CursorPage } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Icon,
  LoadingBlock,
  SearchField,
  SegmentedControl,
} from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { useFileDisplayUrl } from '@/lib/hooks/useFileUrl';
import { objectAssetsKey, objectKey } from '@/lib/queries';
import { fetchAssets, fetchObject } from '../../objects-api';
import { AssetForm } from '../../_components/AssetForm';

const STATUS_META = new Map(ASSET_STATUSES.map((s) => [s.value, s]));

export default function AssetsPage() {
  const { isReady } = useRequireAuth();
  const { id, objectId } = useParams<{ id: string; objectId: string }>();
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>('');
  const [search, setSearch] = useState('');
  // Запрос — по УСПОКОИВШЕЙСЯ строке: search попадает прямо в ключ, и без
  // задержки «кофемашина» уходила на сервер одиннадцатью запросами.
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const [creating, setCreating] = useState(false);

  const { data: node } = useQuery({
    queryKey: objectKey(id, objectId),
    queryFn: () => fetchObject(id, objectId),
    enabled: isReady && !!objectId,
  });

  const filter = `${status}|${query}`;
  const { data, isPending, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: objectAssetsKey(id, objectId, filter),
    queryFn: ({ pageParam }) =>
      fetchAssets(id, objectId, { status: status || undefined, search: query || undefined, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CursorPage<AssetDto>) => last.nextCursor ?? undefined,
    enabled: isReady && !!objectId,
  });

  const items = useMemo(() => (data?.pages ?? []).flatMap((p) => p.items), [data]);
  const canManage = !!node?.caps.manage;

  const invalidate = () => {
    // Префикс всех фильтров ленты — из общего ключа, без литерала на странице.
    void qc.invalidateQueries({ queryKey: objectAssetsKey(id, objectId, '').slice(0, -1) });
    void qc.invalidateQueries({ queryKey: objectKey(id, objectId) });
  };

  if (!isReady) return null;

  return (
    <>
      <Card>
        <CardHeader
          title="Оборудование"
          subtitle="Оборудование объекта: где стоит, кто отвечает, что с ним было"
          actions={
            <>
              <Button size="sm" variant="ghost" icon="toolbox" href={`/workspaces/${id}/objects/models`}>
                Справочник моделей
              </Button>
              {canManage && (
                <Button size="sm" variant="primary" icon="add" onClick={() => setCreating(true)}>
                  Оборудование
                </Button>
              )}
            </>
          }
        />

        <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
          <SegmentedControl
            value={status}
            onChange={setStatus}
            items={[{ key: '', label: 'Все' }, ...ASSET_STATUSES.map((s) => ({ key: s.value, label: s.label }))]}
          />
          <SearchField
            placeholder="Название, инвентарный, серийный…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {isPending ? (
          <LoadingBlock />
        ) : items.length === 0 ? (
          <EmptyState
            icon="wrench"
            title="Оборудования пока нет"
            description="Добавьте первую единицу — кофемашину, холодильник, кассу. Модель можно создать прямо в форме."
            action={
              canManage ? (
                <Button variant="primary" icon="add" onClick={() => setCreating(true)}>
                  Добавить оборудование
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 'var(--spacing-4)',
              }}
            >
              {items.map((a) => (
                <AssetTile key={a.id} workspaceId={id} objectId={objectId} asset={a} />
              ))}
            </div>
            {hasNextPage && (
              <div style={{ marginTop: 'var(--spacing-4)', display: 'flex', justifyContent: 'center' }}>
                <Button variant="ghost" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                  Показать ещё
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {creating && (
        <AssetForm
          workspaceId={id}
          objectId={objectId}
          open
          canSeeMoney={!!node?.caps.payrollView}
          onClose={() => setCreating(false)}
          onSaved={invalidate}
        />
      )}
    </>
  );
}

/** Обложка: приватное фото тянется через движок файлов (ссылка временная). */
function AssetCover({ asset }: { asset: AssetDto }) {
  const { url } = useFileDisplayUrl(asset.photo ?? null, 'thumb');
  if (!asset.photo || !url) return <Icon name="wrench" size={32} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={asset.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />;
}

function AssetTile({
  workspaceId,
  objectId,
  asset,
}: {
  workspaceId: string;
  objectId: string;
  asset: AssetDto;
}) {
  const meta = STATUS_META.get(asset.status);
  return (
    <Link
      href={`/workspaces/${workspaceId}/objects/${objectId}/assets/${asset.id}`}
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      <Card hoverable>
        <div
          style={{
            height: 120,
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-container)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 'var(--spacing-3)',
            overflow: 'hidden',
            color: 'var(--muted)',
          }}
        >
          <AssetCover asset={asset} />
        </div>
        <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{asset.name}</div>
        <div className="label-sm" style={{ opacity: 0.7, marginBottom: '0.5rem' }}>
          {[asset.modelName, asset.inventoryNumber ? `инв. ${asset.inventoryNumber}` : null]
            .filter(Boolean)
            .join(' · ')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Chip tone={(meta?.tone ?? 'neutral') as 'success' | 'warning' | 'neutral'}>{meta?.label ?? asset.status}</Chip>
          {asset.custodianUserId && asset.custodianName && (
            <PersonChip size="XS" userId={asset.custodianUserId} firstName={asset.custodianName} />
          )}
        </div>
      </Card>
    </Link>
  );
}
