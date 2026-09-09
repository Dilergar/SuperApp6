'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NoteBlock, NoteDoc, NoteSpaceRef } from '@superapp/shared';
import { Button, Modal, Textarea } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { createNote } from '@/lib/notes-api';
import { notesRootKey } from '@/lib/queries';
import { useNotesLayer } from '@/lib/stores/notes-layer';
import { toastError } from '@/lib/toast';
import { noteScopeFromPath } from './note-target-from-path';

// ============================================================
// Быстрое действие чата «В заметку» (core/quick-actions, scope=message): текст
// сообщения становится цитатой новой заметки в пространстве чата (организация или
// личное) и сразу ложится стикером на доску — слой открывается, чтобы дописать мысль.
// ============================================================

export function NoteFromMessageModal({ text, scope: scopeProp, onClose }: { text: string; scope?: NoteSpaceRef; onClose: () => void }) {
  const t = useTranslations('notes');
  const tc = useTranslations('common');
  const pathname = usePathname();
  const scope: NoteSpaceRef = scopeProp ?? noteScopeFromPath(pathname);
  const qc = useQueryClient();
  const layer = useNotesLayer();
  const [comment, setComment] = useState('');
  const create = useMutation({
    mutationFn: () => {
      // Документ собираем САМИ, а не через Markdown: чужое сообщение — это данные, и
      // «**жирный**» или «[текст](адрес)» из него не должны превращаться в разметку.
      const paragraphs = (value: string): NoteBlock[] =>
        value
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }) as NoteBlock);
      const quoted = paragraphs(text);
      const content: NoteDoc = {
        type: 'doc',
        content: [
          ...(comment.trim() ? paragraphs(comment) : []),
          { type: 'blockquote', content: quoted.length ? quoted : [{ type: 'paragraph' }] },
        ],
      };
      return createNote({ ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}), content });
    },
    onSuccess: (note) => {
      void qc.invalidateQueries({ queryKey: notesRootKey });
      onClose();
      layer.requestPin(note.id);
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('fromMessage.title')}
      subtitle={t('fromMessage.subtitle')}
      size="sm"
      footer={
        <>
          <Button variant="matte" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button icon="stickyNote" onClick={() => create.mutate()} loading={create.isPending}>
            {t('fromMessage.create')}
          </Button>
        </>
      }
    >
      <blockquote className="body-sm" style={{ margin: '0 0 var(--spacing-3)', paddingLeft: '0.75rem', borderLeft: '2px solid var(--primary-border)', color: 'var(--on-surface-variant)', whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>
        {text}
      </blockquote>
      <Textarea label={t('fromMessage.commentLabel')} value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder={t('fromMessage.commentPlaceholder')} />
    </Modal>
  );
}
