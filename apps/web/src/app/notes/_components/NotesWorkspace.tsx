'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NOTE_HOTKEYS, type NoteFolderDto, type NoteSpaceRef } from '@superapp/shared';
import { Button, Icon, Input, LoadingBlock, Modal, SearchField, useConfirm } from '@/components/ui';
import { NotesBoard } from '@/components/notes/NotesBoard';
import { NotesFolderTree, NotesTreeList, selectionFolderId, type NotesSelection } from '@/components/notes/NotesFolderTree';
import { NoteColorMenu } from '@/components/notes/NoteColorMenu';
import { NoteShareModal } from '@/components/notes/NoteShareModal';
import { apiErrorMessage } from '@/lib/api';
import { createNoteFolder, fetchNotesSidebar, noteScopeKey, trashNoteFolder, updateNoteFolder } from '@/lib/notes-api';
import { notesRootKey, notesSidebarKey } from '@/lib/queries';
import { toastError } from '@/lib/toast';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import '@/components/notes/notes.css';

// ============================================================
// Страница Заметок — рабочий стол на весь экран (`.canvas-layer`: всё правее сайдбара
// и ниже топбара; сайдбар каркаса входит сюда свёрнутым — `prefersRail` в app-nav).
// Слева проводник: строка поиска над деревом разделов и папок (раскрытые показывают свои
// заметки), справа доска ВЫБРАННОГО раздела. Отдельной колонки-списка нет: дерево и
// доска показывают один набор, просто по-разному. Один компонент для личного
// `/notes` и `/workspaces/[id]/notes`; состояние живёт в адресе (?folder= ?tag= ?view= ?note=).
// ============================================================

export function NotesWorkspace({ scope }: { scope: NoteSpaceRef }) {
  const { isReady: ready } = useRequireAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [confirm, confirmUi] = useConfirm();
  const scopeKey = noteScopeKey(scope);

  // ---- состояние из адреса
  const selection: NotesSelection = useMemo(() => {
    const folder = params.get('folder');
    const tag = params.get('tag');
    const view = params.get('view');
    if (folder) return `folder:${folder}` as NotesSelection;
    if (tag) return `tag:${tag}` as NotesSelection;
    if (view === 'root' || view === 'pinned' || view === 'shared' || view === 'trash') return view as NotesSelection;
    // Раздела «все заметки» нет: по умолчанию — корень пространства (заметки без папки)
    return 'root' as NotesSelection;
  }, [params]);
  const noteId = params.get('note');
  const [q, setQ] = useState('');
  // Повторный клик по той же заметке в дереве обязан снова прокрутить доску к ней
  const [focusNonce, setFocusNonce] = useState(0);
  const [mobilePane, setMobilePane] = useState<'side' | 'board'>('board');
  // Ширина — только из эффекта: на сервере window нет, чтение в теле рендера расходится с гидратацией
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const navigate = useCallback(
    (next: { selection?: NotesSelection; note?: string | null }) => {
      const sp = new URLSearchParams();
      const sel = next.selection ?? selection;
      if (sel.startsWith('folder:')) sp.set('folder', sel.slice(7));
      else if (sel.startsWith('tag:')) sp.set('tag', sel.slice(4));
      else if (sel !== 'root') sp.set('view', sel);
      const n = next.note === undefined ? noteId : next.note;
      if (n) sp.set('note', n);
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, selection, noteId],
  );

  // ---- данные
  const sidebar = useQuery({ queryKey: notesSidebarKey(scopeKey), queryFn: () => fetchNotesSidebar(scope), enabled: ready, staleTime: 30_000 });
  // Поиск — по всему пространству: вместо дерева слева плоский список найденного,
  // справа те же заметки на доске (NotesBoard сам строит фильтр по `q`)
  const searchQ = q.trim();
  const searching = searchQ.length > 0;
  const currentFolderId = selectionFolderId(selection);
  const canCreateHere = sidebar.data ? sidebar.data.space.access !== 'viewer' : false;

  // ---- папки
  const invalidate = () => void qc.invalidateQueries({ queryKey: notesRootKey });
  const [folderModal, setFolderModal] = useState<{ mode: 'create'; parentId: string | null } | { mode: 'rename'; folder: NoteFolderDto } | null>(null);
  const [folderShare, setFolderShare] = useState<NoteFolderDto | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folder: NoteFolderDto; anchor: HTMLElement } | null>(null);
  const folderMutation = useMutation({
    mutationFn: async (
      input:
        | { mode: 'create'; parentId: string | null; name: string }
        | { mode: 'rename'; id: string; name: string }
        | { mode: 'color'; id: string; color: string | null }
        | { mode: 'move'; id: string; parentId: string | null }
        | { mode: 'trash'; id: string },
    ) => {
      if (input.mode === 'create') return createNoteFolder({ ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}), parentId: input.parentId, name: input.name });
      if (input.mode === 'rename') return updateNoteFolder(input.id, { name: input.name });
      if (input.mode === 'color') return updateNoteFolder(input.id, { color: input.color });
      if (input.mode === 'move') return updateNoteFolder(input.id, { parentId: input.parentId });
      await trashNoteFolder(input.id);
      return null;
    },
    onSuccess: (res, input) => {
      invalidate();
      setFolderModal(null);
      if (input.mode === 'create' && res) navigate({ selection: `folder:${res.id}`, note: null });
      if (input.mode === 'trash' && selection === `folder:${input.id}`) navigate({ selection: 'root', note: null });
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  if (!ready) return <LoadingBlock />;

  const sectionTitle = searching
    ? `Поиск: «${searchQ}»`
    : selection === 'root'
      ? 'Без папки'
      : selection === 'pinned'
        ? 'Закреплённые'
        : selection === 'shared'
          ? 'Поделились со мной'
          : selection === 'trash'
            ? 'Корзина'
            : selection.startsWith('tag:')
              ? `#${selection.slice(4)}`
              : ([...(sidebar.data?.folders ?? []), ...(sidebar.data?.sharedFolders ?? [])].find((f) => f.id === selection.slice(7))?.name ?? 'Папка');

  const selectNote = (id: string, sel?: NotesSelection) => {
    navigate({ ...(sel ? { selection: sel } : {}), note: id });
    setFocusNonce((n) => n + 1);
    setMobilePane('board');
  };

  return (
    <div className="canvas-layer notes-canvas">
      <div className="notes-ws">
        <aside className="notes-ws-side" hidden={mobile && mobilePane !== 'side'} aria-label="Проводник заметок">
          <div className="notes-side-head">
            <SearchField value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ('')} placeholder="Поиск по заметкам…" width="100%" />
          </div>
          <div className="notes-side-body">
            {searching ? (
              <NotesTreeList scope={scope} scopeKey={scopeKey} filter={{ q: searchQ }} sel={selection} activeNoteId={noteId} onSelectNote={(id) => selectNote(id)} emptyText="Ничего не найдено" />
            ) : (
              <NotesFolderTree
                scope={scope}
                scopeKey={scopeKey}
                sidebar={sidebar.data}
                selected={selection}
                onSelect={(sel) => {
                  navigate({ selection: sel, note: null });
                  setMobilePane('board');
                }}
                activeNoteId={noteId}
                onSelectNote={selectNote}
                onCreateFolder={canCreateHere ? (parentId) => setFolderModal({ mode: 'create', parentId: parentId ?? currentFolderId ?? null }) : undefined}
                onFolderMenu={(folder, anchor) => setFolderMenu({ folder, anchor })}
              />
            )}
          </div>
        </aside>

        <section className="notes-ws-board" hidden={mobile && mobilePane !== 'board'} aria-label={`Доска: ${sectionTitle}`}>
          <div className="notes-board-head">
            <button type="button" className="notes-tree-item notes-mobile-only" style={{ width: 'auto' }} onClick={() => setMobilePane('side')}>
              <Icon name="arrowLeft" size={14} /> Папки
            </button>
            <span className="title-sm">{sectionTitle}</span>
            <span className="label-sm" style={{ marginLeft: 'auto', color: 'var(--on-surface-variant)' }}>
              {NOTE_HOTKEYS.toggleBoard} — доска на любой странице
            </span>
          </div>
          <NotesBoard
            scope={scope}
            scopeKey={scopeKey}
            selection={selection}
            q={q}
            focusNoteId={noteId}
            focusNonce={focusNonce}
            pathname={pathname}
            search={params?.toString()}
            onTagClick={(name) => navigate({ selection: `tag:${name}`, note: null })}
          />
        </section>
      </div>

      {folderModal && (
        <FolderNameModal
          title={folderModal.mode === 'create' ? 'Новая папка' : 'Переименовать папку'}
          initial={folderModal.mode === 'rename' ? folderModal.folder.name : ''}
          busy={folderMutation.isPending}
          onClose={() => setFolderModal(null)}
          onSubmit={(name) =>
            folderMutation.mutate(folderModal.mode === 'create' ? { mode: 'create', parentId: folderModal.parentId, name } : { mode: 'rename', id: folderModal.folder.id, name })
          }
        />
      )}
      {folderMenu && (
        <FolderActionsMenu
          folder={folderMenu.folder}
          anchor={folderMenu.anchor}
          onClose={() => setFolderMenu(null)}
          onRename={() => setFolderModal({ mode: 'rename', folder: folderMenu.folder })}
          onColor={(c) => folderMutation.mutate({ mode: 'color', id: folderMenu.folder.id, color: c })}
          onSubfolder={() => setFolderModal({ mode: 'create', parentId: folderMenu.folder.id })}
          onShare={() => setFolderShare(folderMenu.folder)}
          onToRoot={folderMenu.folder.parentId ? () => folderMutation.mutate({ mode: 'move', id: folderMenu.folder.id, parentId: null }) : undefined}
          onTrash={() =>
            confirm({ title: `Удалить папку «${folderMenu.folder.name}»?`, message: 'Папка и заметки внутри уедут в корзину на 30 дней', danger: true }, () =>
              folderMutation.mutateAsync({ mode: 'trash', id: folderMenu.folder.id }).then(() => undefined),
            )
          }
        />
      )}
      {folderShare && (
        <NoteShareModal
          open
          onClose={() => setFolderShare(null)}
          scope={scope}
          target={{ kind: 'folder', id: folderShare.id, title: folderShare.name }}
          canManage={folderShare.access === 'manager' || folderShare.access === 'owner'}
        />
      )}
      {confirmUi}
    </div>
  );
}

function FolderNameModal({ title, initial, busy, onClose, onSubmit }: { title: string; initial: string; busy: boolean; onClose: () => void; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(initial);
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="matte" onClick={onClose}>Отмена</Button>
          <Button onClick={() => name.trim() && onSubmit(name.trim())} loading={busy} disabled={!name.trim()}>Готово</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSubmit(name.trim());
        }}
      >
        <Input label="Название" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} placeholder="Например, Клиенты" />
      </form>
    </Modal>
  );
}

function FolderActionsMenu({
  folder,
  anchor,
  onClose,
  onRename,
  onColor,
  onSubfolder,
  onShare,
  onToRoot,
  onTrash,
}: {
  folder: NoteFolderDto;
  anchor: HTMLElement;
  onClose: () => void;
  onRename: () => void;
  onColor: (c: string | null) => void;
  onSubfolder: () => void;
  onShare: () => void;
  onToRoot?: () => void;
  onTrash: () => void;
}) {
  // Меню кита открывается кликом по своему триггеру; здесь якорь уже нажат — рисуем меню
  // сразу поверх той же точки (портал через Menu с невидимым триггером неудобен), поэтому
  // используем простой слой действий у якоря.
  const rect = anchor.getBoundingClientRect();
  const canManage = folder.access === 'manager' || folder.access === 'owner';
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.notes-folder-menu')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const item = (label: string, icon: Parameters<typeof Icon>[0]['name'], onClick: () => void, danger?: boolean) => (
    <button
      key={label}
      type="button"
      className={`ui-menu-item${danger ? ' ui-menu-item--danger' : ''}`}
      role="menuitem"
      onClick={() => {
        onClick();
        onClose();
      }}
    >
      <Icon name={icon} size={16} /> {label}
    </button>
  );
  return (
    <div
      className="notes-folder-menu card-elevated"
      role="menu"
      aria-label={`Папка «${folder.name}»`}
      style={{
        position: 'fixed',
        top: Math.min(rect.bottom + 4, window.innerHeight - 260),
        left: Math.min(rect.left, window.innerWidth - 240),
        zIndex: 320,
        background: 'var(--block)',
        borderRadius: 'var(--radius-md)',
        padding: 4,
        minWidth: 220,
      }}
    >
      {item('Новая подпапка', 'folderPlus', onSubfolder)}
      {canManage && item('Переименовать', 'edit', onRename)}
      {canManage && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.35rem 0.5rem' }}>
          <span className="label-sm">Цвет</span>
          <NoteColorMenu value={folder.color} onChange={onColor} size={26} />
        </div>
      )}
      {item('Доступ', 'share', onShare)}
      {canManage && onToRoot && item('Вынести в корень', 'arrowUp', onToRoot)}
      {canManage && <span className="ui-menu-sep" />}
      {canManage && item('В корзину', 'delete', onTrash, true)}
    </div>
  );
}
