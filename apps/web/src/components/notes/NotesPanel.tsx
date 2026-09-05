'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NoteListItemDto, NoteRelatedTargetType, NoteSpaceRef } from '@superapp/shared';
import { Button, EmptyState, Icon, LoadingBlock, Modal, SearchField } from '@/components/ui';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { apiErrorMessage } from '@/lib/api';
import { addNoteRelated, createNote, fetchNotes, fetchNotesByTarget, noteScopeKey } from '@/lib/notes-api';
import { notesAttachPickerKey, notesByTargetKey, notesRootKey } from '@/lib/queries';
import { useNotesLayer } from '@/lib/stores/notes-layer';
import { toastError } from '@/lib/toast';
import { dmyOrDash } from '@/lib/dates';
import './notes.css';

// ============================================================
// Панель «Заметки» на карточке сущности (задача, контрагент, объект, документ) —
// модель Salesforce «Notes» related list: что записано об этой сущности, новая
// заметка стикером сразу привязана, существующую можно прикрепить.
// ============================================================

export function NotesPanel({ target, scope }: { target: { type: NoteRelatedTargetType; id: string }; scope: NoteSpaceRef }) {
  const router = useRouter();
  const qc = useQueryClient();
  const layer = useNotesLayer();
  const [attachOpen, setAttachOpen] = useState(false);
  const q = useQuery({ queryKey: notesByTargetKey(target.type, target.id), queryFn: () => fetchNotesByTarget(target.type, target.id) });

  const create = useMutation({
    mutationFn: () =>
      createNote({
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        related: [{ targetType: target.type, targetId: target.id }],
      }),
    onSuccess: (note) => {
      void qc.invalidateQueries({ queryKey: notesRootKey });
      layer.requestPin(note.id);
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const attach = useMutation({
    mutationFn: (noteId: string) => addNoteRelated(noteId, { targetType: target.type, targetId: target.id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: notesRootKey });
      setAttachOpen(false);
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const openNote = (n: NoteListItemDto) => router.push(scope.workspaceId ? `/workspaces/${scope.workspaceId}/notes?note=${n.id}` : `/notes/${n.id}`);

  return (
    <div>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <Button size="sm" icon="stickyNote" onClick={() => create.mutate()} loading={create.isPending} disabled={q.data ? !q.data.canAttach : false}>
          Новая заметка
        </Button>
        <Button size="sm" variant="matte" icon="link" onClick={() => setAttachOpen(true)} disabled={q.data ? !q.data.canAttach : false}>
          Прикрепить существующую
        </Button>
      </div>
      {q.isPending ? (
        <LoadingBlock />
      ) : !q.data?.items.length ? (
        <EmptyState icon="notes" title="Заметок пока нет" description="Запишите договорённости, детали и мысли — они останутся здесь" />
      ) : (
        <div className="notes-panel-list">
          {q.data.items.map((n) => (
            <button key={n.id} type="button" className="note-card" onClick={() => openNote(n)} style={n.color ? ({ ['--note-color' as string]: n.color } as React.CSSProperties) : undefined}>
              <span className="note-card-color" aria-hidden />
              <div className="note-card-main">
                <div className="note-card-title">
                  {n.pinnedAt && <Icon name="pin" size={14} />}
                  <span>{n.title || n.snippet || 'Без названия'}</span>
                </div>
                {n.title && n.snippet && <div className="note-card-snippet">{n.snippet}</div>}
                <div className="note-card-meta">
                  <PersonAvatar userId={n.createdBy.id} name={`${n.createdBy.firstName} ${n.createdBy.lastName ?? ''}`.trim()} avatar={n.createdBy.avatar} size="sm" />
                  <span>{dmyOrDash(n.updatedAt.slice(0, 10))}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      <AttachNoteModal open={attachOpen} onClose={() => setAttachOpen(false)} scope={scope} onPick={(id) => attach.mutate(id)} />
    </div>
  );
}

function AttachNoteModal({ open, onClose, scope, onPick }: { open: boolean; onClose: () => void; scope: NoteSpaceRef; onPick: (noteId: string) => void }) {
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: notesAttachPickerKey(noteScopeKey(scope), q.trim()),
    queryFn: () => fetchNotes(scope, { q: q.trim() || undefined }),
    enabled: open,
  });
  return (
    <Modal open={open} onClose={onClose} title="Прикрепить заметку" size="md">
      <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
        <SearchField value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ('')} placeholder="Найти заметку…" width="100%" />
        {list.isPending ? (
          <LoadingBlock />
        ) : !list.data?.items.length ? (
          <EmptyState icon="notes" title="Заметок не найдено" />
        ) : (
          <div style={{ display: 'grid', gap: 'var(--spacing-1)', maxHeight: 360, overflowY: 'auto' }}>
            {list.data.items.map((n) => (
              <button key={n.id} type="button" className="notes-tree-item" onClick={() => onPick(n.id)}>
                <span className="notes-tree-dot" style={n.color ? ({ ['--note-color' as string]: n.color } as React.CSSProperties) : undefined} aria-hidden />
                <span className="notes-tree-label">{n.title || n.snippet || 'Без названия'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
