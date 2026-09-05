'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { NOTE_HOTKEYS } from '@superapp/shared';
import { CloseChip, IconButton } from '@/components/ui';
import { fetchNotesSidebar, noteScopeKey } from '@/lib/notes-api';
import { notesSidebarKey } from '@/lib/queries';
import { useNotesLayer } from '@/lib/stores/notes-layer';
import { NotesBoard } from './NotesBoard';
import { NotesFolderTree, selectionFolderId, type NotesSelection } from './NotesFolderTree';
import { noteScopeFromPath } from './note-target-from-path';
import './notes.css';

// ============================================================
// Доска поверх любой страницы (`Alt+N`): слева папки, справа — ТА ЖЕ доска, что и на
// странице Заметок (общий компонент NotesBoard). Контекст — из адреса (организация /
// личное), как у каркаса; новая заметка падает в выбранную папку и, если доска открыта
// на карточке сущности, сразу привязывается к ней.
// ============================================================

export function NotesStickyLayerInner() {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  // Селекторами, а не целым стором: подписка на весь объект перерисовывала доску и
  // переустанавливала слушатель Esc на любое изменение состояния слоя.
  const layerFolderId = useNotesLayer((s) => s.folderId);
  const setLayerFolder = useNotesLayer((s) => s.setFolder);
  const closeLayer = useNotesLayer((s) => s.close);
  const newNoteRequest = useNotesLayer((s) => s.newNoteRequest);
  const consumeNewNote = useNotesLayer((s) => s.consumeNewNote);
  const pinRequest = useNotesLayer((s) => s.pinRequest);
  const consumePin = useNotesLayer((s) => s.consumePin);
  const scope = useMemo(() => noteScopeFromPath(pathname), [pathname]);
  const scopeKey = noteScopeKey(scope);
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const [createNonce, setCreateNonce] = useState(0);

  const sidebar = useQuery({ queryKey: notesSidebarKey(scopeKey), queryFn: () => fetchNotesSidebar(scope), staleTime: 30_000 });
  // Папка из стора могла быть удалена / оказаться из другого пространства — тогда корень
  const folderId = useMemo(() => {
    const id = layerFolderId;
    if (!id || !sidebar.data) return id && !sidebar.data ? id : null;
    const all = [...sidebar.data.folders, ...sidebar.data.sharedFolders];
    return all.some((f) => f.id === id) ? id : null;
  }, [layerFolderId, sidebar.data]);
  const selection: NotesSelection = folderId ? `folder:${folderId}` : 'root';

  // Разовые команды стора: «новая заметка» (Alt+Shift+N) и «показать эту»
  useEffect(() => {
    if (newNoteRequest > 0) {
      consumeNewNote();
      setCreateNonce((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newNoteRequest]);
  useEffect(() => {
    const req = pinRequest;
    if (!req) return;
    consumePin();
    setFocusNoteId(req.noteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinRequest?.nonce]);

  // Esc закрывает доску, если фокус не в тексте (в тексте Esc сначала снимает фокус)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest('.ne-content')) {
        active.blur();
        return;
      }
      if (active?.closest('.ne-suggest, .card-elevated')) return;
      closeLayer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeLayer]);

  const openNote = (noteId: string) => {
    closeLayer();
    router.push(scope.workspaceId ? `/workspaces/${scope.workspaceId}/notes?note=${noteId}` : `/notes?note=${noteId}`);
  };

  return (
    <div className="notes-layer" role="dialog" aria-modal="true" aria-label="Доска заметок">
      <aside className="notes-layer-side">
        <div className="notes-layer-side-head">
          <span className="title-sm notes-layer-side-title">{sidebar.data?.space.title ?? 'Заметки'}</span>
          <IconButton
            icon="external"
            label="Открыть Заметки"
            size={28}
            iconSize={15}
            onClick={() => {
              closeLayer();
              router.push(scope.workspaceId ? `/workspaces/${scope.workspaceId}/notes` : '/notes');
            }}
          />
        </div>
        <div className="notes-layer-side-body">
          <NotesFolderTree
            scope={scope}
            scopeKey={scopeKey}
            sidebar={sidebar.data}
            selected={selection}
            onSelect={(sel) => {
              const f = selectionFolderId(sel);
              setLayerFolder(f === undefined ? null : f);
            }}
            boardsOnly
          />
        </div>
      </aside>
      <div className="notes-layer-board">
        <div className="notes-layer-top">
          <CloseChip label={`Закрыть доску (Esc, ${NOTE_HOTKEYS.toggleBoard})`} onClick={closeLayer} />
        </div>
        <NotesBoard
          scope={scope}
          scopeKey={scopeKey}
          selection={selection}
          focusNoteId={focusNoteId}
          createNonce={createNonce}
          onOpenNote={openNote}
          pathname={pathname}
          search={search?.toString()}
          className="notes-board--layer"
        />
      </div>
    </div>
  );
}
