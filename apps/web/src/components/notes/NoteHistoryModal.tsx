'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NoteRevisionDto } from '@superapp/shared';
import { Button, Chip, EmptyState, LoadingBlock, Modal, useConfirm } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { apiErrorMessage } from '@/lib/api';
import { fetchNoteRevisions, restoreNoteRevision } from '@/lib/notes-api';
import { noteDetailKey, noteRevisionsKey, notesRootKey } from '@/lib/queries';
import { toastError } from '@/lib/toast';

/** Дата СО ВРЕМЕНЕМ форматируется по месту — часовой пояс решает клиент (см. lib/dates) */
const stamp = (iso: string): string =>
  new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

// ============================================================
// История версий заметки: снимки сохранений (кап — 30). Откат делает НОВУЮ версию,
// а не переписывает историю (модель Google Docs), поэтому вернуться можно и обратно.
// ============================================================

export function NoteHistoryModal({ open, onClose, noteId, canEdit }: { open: boolean; onClose: () => void; noteId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const [confirm, confirmUi] = useConfirm();
  const list = useQuery({ queryKey: noteRevisionsKey(noteId), queryFn: () => fetchNoteRevisions(noteId), enabled: open });

  const restore = useMutation({
    mutationFn: (version: number) => restoreNoteRevision(noteId, version),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: notesRootKey });
      void qc.invalidateQueries({ queryKey: noteDetailKey(noteId) });
      onClose();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal open={open} onClose={onClose} title="История версий" subtitle="Последние сохранения этой заметки" size="md">
      {list.isPending ? (
        <LoadingBlock />
      ) : !list.data?.length ? (
        <EmptyState icon="notes" title="История пуста" description="Версии появятся после первых сохранений" />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
          {list.data.map((r: NoteRevisionDto) => (
            <div key={r.version} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
              <span className="label-sm" style={{ minWidth: 44 }}>№{r.version}</span>
              <span className="label-sm" style={{ minWidth: 116, color: 'var(--on-surface-variant)' }}>{stamp(r.createdAt)}</span>
              <PersonChip size="XS" userId={r.author.id} firstName={r.author.firstName} lastName={r.author.lastName} avatar={r.author.avatar} />
              <span className="body-sm" style={{ flex: '1 1 200px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.preview || 'Пустая заметка'}
              </span>
              {r.current ? (
                <Chip size="sm" tone="accent">сейчас</Chip>
              ) : (
                canEdit && (
                  <Button
                    size="sm"
                    variant="matte"
                    icon="restore"
                    loading={restore.isPending}
                    onClick={() =>
                      confirm(
                        { title: `Вернуть версию №${r.version}?`, message: 'Текущий текст останется в истории — вернуться обратно можно будет так же' },
                        async () => {
                          await restore.mutateAsync(r.version);
                        },
                      )
                    }
                  >
                    Вернуть
                  </Button>
                )
              )}
            </div>
          ))}
        </div>
      )}
      {confirmUi}
    </Modal>
  );
}
