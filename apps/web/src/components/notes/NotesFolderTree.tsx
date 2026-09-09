'use client';

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { NoteFolderDto, NoteSidebarDto, NoteSpaceRef } from '@superapp/shared';
import { Icon, IconButton } from '@/components/ui';
import type { NotesListFilter } from '@/lib/notes-api';
import { notesListInfinite } from '@/lib/queries';

// ============================================================
// Левая панель Заметок — проводник (модель Obsidian): разделы и папки сворачиваются
// шевроном, раскрытый узел показывает СВОИ заметки по названию (подпапки — выше
// заметок). Раскрытие — не выбор: на доске справа лежит ВЫБРАННЫЙ раздел, а раскрытых
// узлов может быть сколько угодно; набор раскрытых запоминается на пространство.
// Выбор — строка `NotesSelection`: 'root' | 'pinned' | 'shared' | 'trash' |
// 'folder:<id>' | 'tag:<name>'. Раздела «все заметки» нет — доска всегда смотрит на
// конкретный раздел, а поиск по всему пространству живёт в строке над деревом.
// ============================================================

export type NotesSelection = 'root' | 'pinned' | 'shared' | 'trash' | `folder:${string}` | `tag:${string}`;

export function selectionFolderId(sel: NotesSelection): string | null | undefined {
  if (sel === 'root') return null;
  if (sel.startsWith('folder:')) return sel.slice(7);
  return undefined;
}

/** Раздел → фильтр выборки. ОДНО место: и дерево, и доска читают один и тот же набор. */
export function selectionFilter(sel: NotesSelection): NotesListFilter {
  if (sel === 'root') return { folderId: 'root' };
  if (sel === 'pinned') return { pinned: true };
  if (sel === 'shared') return { shared: true };
  if (sel === 'trash') return { trashed: true };
  if (sel.startsWith('folder:')) return { folderId: sel.slice(7) };
  if (sel.startsWith('tag:')) return { tag: sel.slice(4) };
  return {};
}

type IconName = Parameters<typeof Icon>[0]['name'];

interface ListProps {
  scope: NoteSpaceRef;
  scopeKey: string;
  filter: NotesListFilter;
  /** Раздел, которому принадлежит список: клик по заметке переключает доску на него */
  sel: NotesSelection;
  depth?: number;
  activeNoteId?: string | null;
  onSelectNote: (noteId: string, sel: NotesSelection) => void;
  emptyText?: string;
}

/**
 * Заметки одного раздела — своим бесконечным запросом (страницы по «Ещё…»): грузятся
 * только раскрытые узлы, а большая папка не тянет всё разом. Тот же компонент рисует
 * результаты поиска над деревом.
 */
export function NotesTreeList({ scope, scopeKey, filter, sel, depth = 0, activeNoteId, onSelectNote, emptyText }: ListProps) {
  const t = useTranslations('notes');
  const list = useInfiniteQuery(notesListInfinite(scope, scopeKey, filter));
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const indent = { paddingLeft: depth * 12 + 18 };
  if (list.isPending) {
    return (
      <div className="notes-tree-notes" style={indent}>
        <span className="notes-tree-muted">{t('tree.loading')}</span>
      </div>
    );
  }
  if (!items.length) {
    return (
      <div className="notes-tree-notes" style={indent}>
        <span className="notes-tree-muted">{emptyText ?? t('tree.empty')}</span>
      </div>
    );
  }
  return (
    <div className="notes-tree-notes" style={indent}>
      {items.map((n) => (
        <button
          key={n.id}
          type="button"
          className="notes-tree-note"
          aria-current={activeNoteId === n.id}
          onClick={() => onSelectNote(n.id, sel)}
          title={n.title || t('untitled')}
        >
          <span className="notes-tree-dot" style={n.color ? ({ ['--note-color' as string]: n.color } as React.CSSProperties) : undefined} aria-hidden />
          <span className="notes-tree-label">{n.title || t('untitled')}</span>
          {n.pinnedAt && <Icon name="pin" size={12} />}
          {n.shared && <Icon name="share" size={12} />}
        </button>
      ))}
      {list.hasNextPage && (
        <button type="button" className="notes-tree-note notes-tree-more" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          <span className="notes-tree-label">{list.isFetchingNextPage ? t('tree.loading') : t('tree.more')}</span>
        </button>
      )}
    </div>
  );
}

interface Props {
  scope: NoteSpaceRef;
  scopeKey: string;
  sidebar: NoteSidebarDto | undefined;
  selected: NotesSelection;
  onSelect: (sel: NotesSelection) => void;
  /** Режим слоя `Alt+N`: только папки-доски, без тегов, корзины и списков заметок */
  boardsOnly?: boolean;
  activeNoteId?: string | null;
  /** Клик по заметке: заметка И раздел, в котором она показана — доска переключается на него */
  onSelectNote?: (noteId: string, sel: NotesSelection) => void;
  onCreateFolder?: (parentId: string | null) => void;
  onFolderMenu?: (folder: NoteFolderDto, anchor: HTMLElement) => void;
}

export function NotesFolderTree({ scope, scopeKey, sidebar, selected, onSelect, boardsOnly, activeNoteId, onSelectNote, onCreateFolder, onFolderMenu }: Props) {
  const t = useTranslations('notes');
  const folders = sidebar?.folders ?? [];
  const shared = sidebar?.sharedFolders ?? [];
  const withNotes = !boardsOnly && !!onSelectNote;

  // ---- раскрытые узлы (ключ узла = его выбор `NotesSelection`). Запоминаются на
  // пространство; читаются в эффекте — на сервере localStorage нет, а чтение в теле
  // рендера расходилось бы с гидратацией.
  const storageKey = `sa6.notes.tree.${scopeKey}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let saved: unknown = [];
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) saved = JSON.parse(raw);
    } catch {
      saved = [];
    }
    setExpanded(new Set(Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string') : []));
  }, [storageKey]);
  // Выбранный раздел всегда раскрыт: его заметки — те же, что лежат на доске
  useEffect(() => {
    setExpanded((s) => (s.has(selected) ? s : new Set(s).add(selected)));
  }, [selected]);
  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...n]));
      } catch {
        /* приватный режим: просто не запомним */
      }
      return n;
    });

  /** Клик по имени: чужой раздел — выбрать (раскрытие догонит эффект), выбранный — свернуть/развернуть */
  const pick = (sel: NotesSelection) => {
    if (selected === sel) toggle(sel);
    else onSelect(sel);
  };

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, NoteFolderDto[]>();
    for (const f of folders) map.set(f.parentId, [...(map.get(f.parentId) ?? []), f]);
    return map;
  }, [folders]);
  const known = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);

  const caret = (sel: NotesSelection, isOpen: boolean, label: string) => (
    <button
      type="button"
      className="notes-tree-caret"
      aria-label={isOpen ? t('tree.collapse', { name: label }) : t('tree.expand', { name: label })}
      aria-expanded={isOpen}
      onClick={() => toggle(sel)}
    >
      <Icon name={isOpen ? 'caretDown' : 'caretRight'} size={12} />
    </button>
  );

  const notesOf = (sel: NotesSelection, depth: number, emptyText?: string) =>
    withNotes ? (
      <NotesTreeList scope={scope} scopeKey={scopeKey} filter={selectionFilter(sel)} sel={sel} depth={depth} activeNoteId={activeNoteId} onSelectNote={onSelectNote!} emptyText={emptyText} />
    ) : null;

  const section = (sel: 'root' | 'pinned' | 'shared' | 'trash', icon: IconName, label: string, count?: number, emptyText?: string) => {
    const isOpen = expanded.has(sel);
    return (
      <div key={sel}>
        <div className="notes-tree-row">
          {withNotes ? caret(sel, isOpen, label) : <span className="notes-tree-caret-gap" />}
          <button type="button" className="notes-tree-item" aria-current={selected === sel} onClick={() => pick(sel)}>
            <Icon name={icon} size={16} />
            <span className="notes-tree-label">{label}</span>
            {count ? <span className="notes-tree-count">{count}</span> : null}
          </button>
        </div>
        {withNotes && isOpen && notesOf(sel, 0, emptyText)}
      </div>
    );
  };

  const renderFolder = (f: NoteFolderDto, depth: number) => {
    const kids = childrenOf.get(f.id) ?? [];
    const sel: NotesSelection = `folder:${f.id}`;
    const isOpen = expanded.has(sel);
    // В слое раскрывать нечего, кроме подпапок; на странице внутри папки лежат её заметки
    const foldable = withNotes || kids.length > 0;
    return (
      <div key={f.id}>
        <div className="notes-tree-row" style={{ paddingLeft: depth * 12 }}>
          {foldable ? caret(sel, isOpen, f.name) : <span className="notes-tree-caret-gap" />}
          <button
            type="button"
            className="notes-tree-item"
            aria-current={selected === sel}
            onClick={() => pick(sel)}
            onContextMenu={(e) => {
              if (!onFolderMenu) return;
              e.preventDefault();
              onFolderMenu(f, e.currentTarget);
            }}
          >
            <span className="notes-tree-dot" style={f.color ? ({ ['--note-color' as string]: f.color } as React.CSSProperties) : undefined} aria-hidden />
            <span className="notes-tree-label">{f.name}</span>
            {f.notesCount > 0 && <span className="notes-tree-count">{f.notesCount}</span>}
          </button>
          {onFolderMenu && (
            <IconButton icon="more" label={t('tree.folderActions', { name: f.name })} size={24} iconSize={14} onClick={(e) => onFolderMenu(f, e.currentTarget)} />
          )}
        </div>
        {isOpen && kids.map((k) => renderFolder(k, depth + 1))}
        {isOpen && notesOf(sel, depth)}
      </div>
    );
  };

  // Корни: parentId null ИЛИ родитель не виден (чужая подпапка, открытая мне)
  const roots = folders.filter((f) => f.parentId === null || !known.has(f.parentId));

  return (
    <nav className="notes-tree" aria-label={t('tree.foldersAria')}>
      {section('root', 'file', t('section.root'), sidebar?.rootNotesCount)}
      {!boardsOnly && (
        <>
          {section('pinned', 'pin', t('section.pinned'), undefined, t('tree.pinnedEmpty'))}
          {(sidebar?.sharedNotesCount ?? 0) > 0 && section('shared', 'share', t('section.shared'), sidebar?.sharedNotesCount)}
        </>
      )}

      <div className="notes-tree-section">
        <span className="label-sm">{t('tree.folders')}</span>
        {onCreateFolder && <IconButton icon="folderPlus" label={t('tree.newFolder')} size={24} iconSize={14} onClick={() => onCreateFolder(null)} />}
      </div>
      {roots.length === 0 && <div className="notes-tree-muted">{t('tree.noFolders')}</div>}
      {roots.map((f) => renderFolder(f, 0))}

      {shared.length > 0 && (
        <>
          <div className="notes-tree-section">
            <span className="label-sm">{t('tree.sharedFolders')}</span>
          </div>
          {shared.map((f) => renderFolder(f, 0))}
        </>
      )}

      {!boardsOnly && (sidebar?.tags.length ?? 0) > 0 && (
        <>
          <div className="notes-tree-section">
            <span className="label-sm">{t('tree.tags')}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '0 0.5rem' }}>
            {sidebar!.tags.slice(0, 40).map((tag) => (
              <button
                key={tag.name}
                type="button"
                className="notes-tree-item"
                style={{ width: 'auto', padding: '0.2rem 0.5rem' }}
                aria-current={selected === `tag:${tag.name}`}
                onClick={() => onSelect(`tag:${tag.name}`)}
              >
                <Icon name="hash" size={12} />
                <span className="notes-tree-label">{tag.name}</span>
                <span className="notes-tree-count">{tag.count}</span>
              </button>
            ))}
          </div>
          {selected.startsWith('tag:') && notesOf(selected, 0)}
        </>
      )}

      {!boardsOnly && (
        <>
          <div className="notes-tree-section" />
          {section('trash', 'delete', t('section.trash'), sidebar?.trashCount, t('tree.trashEmpty'))}
        </>
      )}
    </nav>
  );
}
