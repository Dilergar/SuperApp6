'use client';

// ============================================================
// Обозреватель Диска: путь, панель действий, виртуализированный список.
//
// Список ВИРТУАЛИЗИРОВАН (react-virtuoso, конвенции ленты мессенджера): в папке
// бывает десять тысяч файлов, и держать их все в DOM нельзя. Отсюда же строчная
// таблица кита на CSS-grid — внутрь <tbody> «окошко» виртуализатора не вставить.
// ============================================================

import { useCallback, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Virtuoso } from 'react-virtuoso';
import { pluralRu, type DriveNodeDto, type DriveSort, type DriveSortDir } from '@superapp/shared';
import {
  Button,
  Chip,
  EmptyState,
  Icon,
  Input,
  Menu,
  Modal,
  Spinner,
  TableCell,
  TableHeader,
  TableRow,
  useConfirm,
  type MenuAction,
  type TableColumn,
} from '@/components/ui';
import { UploadProgressList } from '@/components/files/UploadProgressList';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import {
  createDriveFolder,
  fetchDriveList,
  renameDriveNode,
  setDriveStar,
  trashDriveNodes,
} from '@/lib/drive-api';
import { getDownloadUrl } from '@/lib/files-api';
import { driveListKey } from '@/lib/queries';
import type { DriveSpaceRef } from '@superapp/shared';
import { useDriveUpload } from './useDriveUpload';
import { DriveShareModal } from './DriveShareModal';
import { driveIcon, humanSize, shortDate } from './drive-ui';

const COLUMNS: TableColumn[] = [
  { key: 'name', label: 'Название', sortable: true },
  { key: 'size', label: 'Размер', width: 'auto', align: 'end', sortable: true, hideOnMobile: true },
  { key: 'updated', label: 'Изменён', width: 'auto', align: 'end', sortable: true, hideOnMobile: true },
  { key: 'actions', label: '', width: '40px', align: 'end' },
];

export interface DriveBrowserProps {
  driveRef: DriveSpaceRef;
  /** null — корень пространства */
  parentId: string | null;
  canEdit: boolean;
  breadcrumbs: Array<{ id: string | null; name: string }>;
  onOpenFolder: (id: string | null) => void;
  onChanged: () => void;
}

export function DriveBrowser({
  driveRef,
  parentId,
  canEdit,
  breadcrumbs,
  onOpenFolder,
  onChanged,
}: DriveBrowserProps) {
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [sort, setSort] = useState<DriveSort>('name');
  const [dir, setDir] = useState<DriveSortDir>('asc');
  const [dragOver, setDragOver] = useState(false);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<DriveNodeDto | null>(null);
  const [sharing, setSharing] = useState<DriveNodeDto | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const query = useInfiniteQuery({
    queryKey: driveListKey(driveRef, parentId, sort, dir),
    queryFn: ({ pageParam }) =>
      fetchDriveList(driveRef, { parentId, sort, dir, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['drive'] });
    onChanged();
  }, [qc, onChanged]);

  const upload = useDriveUpload({ ref: driveRef, parentId, onDone: refresh });

  // ---- действия ----

  const openNode = useCallback(
    async (node: DriveNodeDto) => {
      if (node.kind === 'folder') {
        onOpenFolder(node.id);
        return;
      }
      if (!node.file) return;
      try {
        const { url } = await getDownloadUrl(node.file.id);
        window.open(url, '_blank', 'noopener');
      } catch (err) {
        toastError(apiErrorMessage(err));
      }
    },
    [onOpenFolder],
  );

  const doRename = useCallback(async () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) return;
    try {
      await renameDriveNode(renaming.id, name);
      setRenaming(null);
      refresh();
    } catch (err) {
      toastError(apiErrorMessage(err));
    }
  }, [renaming, refresh]);

  const doCreateFolder = useCallback(async () => {
    const name = (newFolder ?? '').trim();
    if (!name) return;
    try {
      await createDriveFolder(driveRef, { parentId, name });
      setNewFolder(null);
      refresh();
    } catch (err) {
      toastError(apiErrorMessage(err));
    }
  }, [newFolder, driveRef, parentId, refresh]);

  const rowActions = useCallback(
    (node: DriveNodeDto): MenuAction[] => {
      const actions: MenuAction[] = [];
      if (node.file) {
        actions.push({
          key: 'open',
          label: 'Скачать',
          icon: 'download',
          onClick: () => void openNode(node),
        });
      }
      actions.push({
        key: 'star',
        label: node.starred ? 'Убрать из избранного' : 'В избранное',
        icon: 'star',
        onClick: () => void setDriveStar(node.id, !node.starred).then(refresh).catch((e) => toastError(apiErrorMessage(e))),
      });
      if (!canEdit || node.systemKey) return actions;
      actions.push(
        { key: 'rename', label: 'Переименовать', icon: 'edit', onClick: () => setRenaming(node) },
        { key: 'share', label: 'Настроить доступ', icon: 'share', onClick: () => setSharing(node) },
        {
          key: 'trash',
          label: 'Удалить',
          icon: 'delete',
          danger: true,
          onClick: () =>
            confirm(
              {
                title: `Удалить «${node.name}»?`,
                message:
                  'Объект отправится в корзину на 30 дней. Пока он там, вложение в чате продолжает работать.',
                confirmLabel: 'В корзину',
                danger: true,
              },
              async () => {
                await trashDriveNodes([node.id]);
                refresh();
              },
            ),
        },
      );
      return actions;
    },
    [canEdit, confirm, openNode, refresh],
  );

  // ---- перетаскивание ----

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (!canEdit) {
        toastError('Нет прав добавлять файлы в эту папку');
        return;
      }
      void upload.addDrop(e.dataTransfer);
    },
    [canEdit, upload],
  );

  const itemContent = useCallback(
    (index: number, node: DriveNodeDto) => (
      // Отступ ВНУТРИ строки: виртуализатор меряет offsetHeight, внешние margin
      // в него не входят и лента «дышала» бы на каждом перемере.
      <div style={{ paddingBottom: 2 }}>
        <TableRow
          columns={COLUMNS}
          rowIndex={index + 2}
          onClick={() => void openNode(node)}
        >
          <TableCell title={node.name}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <Icon name={driveIcon(node)} size={18} style={{ color: 'var(--primary-dim)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
              {node.systemKey && <Chip tone="neutral">системная</Chip>}
              {node.starred && <Icon name="star" size={13} style={{ color: 'var(--warning-base)' }} />}
              {/* Объект раздан НАРУЖУ по гостевой ссылке — это видно прямо в списке:
                  иначе узнать об этом можно было только открыв модалку у каждой строки. */}
              {node.shareLinks > 0 && (
                <Icon
                  name="link"
                  size={13}
                  style={{ color: 'var(--primary-dim)' }}
                  aria-label="Доступно по ссылке наружу"
                />
              )}
            </span>
          </TableCell>
          <TableCell align="end" hideOnMobile>
            {node.subtreeBytes === null ? '—' : humanSize(node.subtreeBytes)}
          </TableCell>
          <TableCell align="end" hideOnMobile>
            {shortDate(node.updatedAt)}
          </TableCell>
          <TableCell align="end">
            <span onClick={(e) => e.stopPropagation()}>
              <Menu items={rowActions(node)} label={`Действия: ${node.name}`} />
            </span>
          </TableCell>
        </TableRow>
      </div>
    ),
    [openNode, rowActions],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        outline: dragOver ? '2px dashed var(--primary)' : 'none',
        outlineOffset: 6,
        borderRadius: 'var(--radius-lg)',
      }}
    >
      {/* Путь */}
      <nav aria-label="Путь" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', marginBottom: 12 }}>
        {breadcrumbs.map((b, i) => (
          <span key={b.id ?? 'root'} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {i > 0 && <span className="label-sm" style={{ color: 'var(--muted)' }}>/</span>}
            <Button variant="ghost" size="sm" onClick={() => onOpenFolder(b.id)}>
              {b.name}
            </Button>
          </span>
        ))}
      </nav>

      {/* Действия */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {canEdit && (
          <>
            <Button icon="upload" onClick={() => fileInput.current?.click()}>
              Загрузить
            </Button>
            <Button variant="outline" icon="folderPlus" onClick={() => setNewFolder('')}>
              Новая папка
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files?.length) upload.addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}
        <span style={{ flex: 1 }} />
        <Chip tone="neutral">
          {rows.length ? `${rows.length} ${pluralRu(rows.length, ['объект', 'объекта', 'объектов'])}` : 'пусто'}
        </Chip>
      </div>

      {upload.items.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <UploadProgressList items={upload.items} onCancel={upload.cancel} onRemove={upload.remove} />
        </div>
      )}

      {/* Список */}
      <div role="table" aria-rowcount={rows.length + 1} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <TableHeader
          columns={COLUMNS}
          sortKey={sort}
          sortDir={dir}
          onSort={(key) => {
            if (key === 'actions') return;
            if (key === sort) setDir(dir === 'asc' ? 'desc' : 'asc');
            else {
              setSort(key as DriveSort);
              setDir(key === 'name' ? 'asc' : 'desc');
            }
          }}
        />
        {query.isPending ? (
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="folder"
            title="Здесь пока пусто"
            description={canEdit ? 'Перетащите сюда файлы или целую папку' : 'В этой папке нет доступных вам объектов'}
          />
        ) : (
          <Virtuoso
            data={rows}
            style={{ height: 'min(60vh, 640px)' }}
            computeItemKey={(_i, node) => node.id}
            itemContent={itemContent}
            increaseViewportBy={{ top: 400, bottom: 600 }}
            endReached={() => {
              if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
            }}
          />
        )}
      </div>

      {/* Новая папка */}
      {newFolder !== null && (
        <Modal open onClose={() => setNewFolder(null)} title="Новая папка" size="sm">
          <Input
            label="Название"
            value={newFolder}
            autoFocus
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doCreateFolder();
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <Button variant="ghost" onClick={() => setNewFolder(null)}>
              Отмена
            </Button>
            <Button tone="success" onClick={() => void doCreateFolder()}>
              Создать
            </Button>
          </div>
        </Modal>
      )}

      {/* Переименование */}
      {renaming && (
        <Modal open onClose={() => setRenaming(null)} title="Переименовать" size="sm">
          <Input
            label="Название"
            value={renaming.name}
            autoFocus
            onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doRename();
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Отмена
            </Button>
            <Button tone="success" onClick={() => void doRename()}>
              Сохранить
            </Button>
          </div>
        </Modal>
      )}

      {sharing && (
        <DriveShareModal node={sharing} isWorkspace={!!driveRef.workspaceId} workspaceId={driveRef.workspaceId} onClose={() => setSharing(null)} />
      )}
      {confirmUI}
    </div>
  );
}
