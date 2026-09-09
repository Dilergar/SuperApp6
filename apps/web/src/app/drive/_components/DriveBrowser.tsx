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
import type { DriveNodeDto, DriveSort, DriveSortDir } from '@superapp/shared';
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
import { useTranslations } from 'next-intl';
import { useBytes, useShortDate } from '@/lib/format';
import { driveIcon } from './drive-ui';

/** Колонки таблицы: заголовки — ключи каталога, слово подставляет компонент. */
const COLUMN_KEYS = [
  { key: 'name', labelKey: 'browser.colName', sortable: true },
  { key: 'size', labelKey: 'browser.colSize', width: 'auto', align: 'end', sortable: true, hideOnMobile: true },
  { key: 'updated', labelKey: 'browser.colUpdated', width: 'auto', align: 'end', sortable: true, hideOnMobile: true },
  { key: 'actions', labelKey: null, width: '40px', align: 'end' },
] as const;

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
  const t = useTranslations('drive');
  const tc = useTranslations('common');
  const humanSize = useBytes();
  const shortDate = useShortDate();
  const COLUMNS: TableColumn[] = useMemo(
    () => COLUMN_KEYS.map((c) => ({ ...c, label: c.labelKey ? t(c.labelKey) : '' })),
    [t],
  );
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
          label: t('browser.download'),
          icon: 'download',
          onClick: () => void openNode(node),
        });
      }
      actions.push({
        key: 'star',
        label: node.starred ? t('browser.unstar') : t('browser.star'),
        icon: 'star',
        onClick: () => void setDriveStar(node.id, !node.starred).then(refresh).catch((e) => toastError(apiErrorMessage(e))),
      });
      if (!canEdit || node.systemKey) return actions;
      actions.push(
        { key: 'rename', label: t('browser.rename'), icon: 'edit', onClick: () => setRenaming(node) },
        { key: 'share', label: t('browser.share'), icon: 'share', onClick: () => setSharing(node) },
        {
          key: 'trash',
          label: tc('actions.delete'),
          icon: 'delete',
          danger: true,
          onClick: () =>
            confirm(
              {
                title: t('browser.deleteConfirm.title', { name: node.name }),
                message:
                  t('browser.deleteConfirm.message'),
                confirmLabel: t('browser.toTrash'),
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
        toastError(t('browser.noUploadRights'));
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
              {node.systemKey && <Chip tone="neutral">{t('systemFolder.chip')}</Chip>}
              {node.starred && <Icon name="star" size={13} style={{ color: 'var(--warning-base)' }} />}
              {/* Объект раздан НАРУЖУ по гостевой ссылке — это видно прямо в списке:
                  иначе узнать об этом можно было только открыв модалку у каждой строки. */}
              {node.shareLinks > 0 && (
                <Icon
                  name="link"
                  size={13}
                  style={{ color: 'var(--primary-dim)' }}
                  aria-label={t('browser.publicLink')}
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
              <Menu items={rowActions(node)} label={t('browser.rowActions', { name: node.name })} />
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
      <nav aria-label={t('browser.pathAria')} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', marginBottom: 12 }}>
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
              {t('browser.upload')}
            </Button>
            <Button variant="outline" icon="folderPlus" onClick={() => setNewFolder('')}>
              {t('browser.newFolder')}
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
          {rows.length ? t('browser.itemCount', { n: rows.length }) : t('browser.empty')}
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
            title={t('browser.emptyTitle')}
            description={canEdit ? t('browser.emptyEditable') : t('browser.emptyReadonly')}
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
        <Modal open onClose={() => setNewFolder(null)} title={t('browser.newFolder')} size="sm">
          <Input
            label={t('browser.name')}
            value={newFolder}
            autoFocus
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doCreateFolder();
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <Button variant="ghost" onClick={() => setNewFolder(null)}>
              {tc('actions.cancel')}
            </Button>
            <Button tone="success" onClick={() => void doCreateFolder()}>
              {tc('actions.create')}
            </Button>
          </div>
        </Modal>
      )}

      {/* Переименование */}
      {renaming && (
        <Modal open onClose={() => setRenaming(null)} title={t('browser.rename')} size="sm">
          <Input
            label={t('browser.name')}
            value={renaming.name}
            autoFocus
            onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doRename();
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              {tc('actions.cancel')}
            </Button>
            <Button tone="success" onClick={() => void doRename()}>
              {tc('actions.save')}
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
