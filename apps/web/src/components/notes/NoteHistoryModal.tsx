'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { NoteRevisionDto } from '@superapp/shared';
import { Button, Chip, EmptyState, LoadingBlock, Modal, useConfirm } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';

import { fetchNoteRevisions, restoreNoteRevision } from '@/lib/notes-api';
import { useFormatters } from '@/lib/format';
import { noteDetailKey, noteRevisionsKey, notesRootKey } from '@/lib/queries';

import { toastApiError } from '@/lib/api-errors';
// ============================================================
// История версий заметки: снимки сохранений (кап — 30). Откат делает НОВУЮ версию,
// а не переписывает историю (модель Google Docs), поэтому вернуться можно и обратно.
// ============================================================

export function NoteHistoryModal({ open, onClose, noteId, canEdit }: { open: boolean; onClose: () => void; noteId: string; canEdit: boolean }) {
  const t = useTranslations('notes');
  // Дата СО ВРЕМЕНЕМ — форматтерами языка и региона: пояс браузер знает сам.
  const fmt = useFormatters();
  const stamp = (iso: string): string => fmt.dateTime(iso);
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
    onError: (e) => toastApiError(e),
  });

  return (
    <Modal open={open} onClose={onClose} title={t('history.title')} subtitle={t('history.subtitle')} size="md">
      {list.isPending ? (
        <LoadingBlock />
      ) : !list.data?.length ? (
        <EmptyState icon="notes" title={t('history.emptyTitle')} description={t('history.emptyHint')} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
          {list.data.map((r: NoteRevisionDto) => (
            <div key={r.version} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
              <span className="label-sm" style={{ minWidth: 44 }}>№{r.version}</span>
              <span className="label-sm" style={{ minWidth: 116, color: 'var(--on-surface-variant)' }}>{stamp(r.createdAt)}</span>
              <PersonChip size="XS" userId={r.author.id} firstName={r.author.firstName} lastName={r.author.lastName} avatar={r.author.avatar} />
              <span className="body-sm" style={{ flex: '1 1 200px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.preview || t('history.emptyNote')}
              </span>
              {r.current ? (
                <Chip size="sm" tone="accent">{t('history.current')}</Chip>
              ) : (
                canEdit && (
                  <Button
                    size="sm"
                    variant="matte"
                    icon="restore"
                    loading={restore.isPending}
                    onClick={() =>
                      confirm(
                        {
                        title: t('history.restoreConfirm.title', { n: r.version }),
                        message: t('history.restoreConfirm.message'),
                      },
                        async () => {
                          await restore.mutateAsync(r.version);
                        },
                      )
                    }
                  >
                    {t('history.restore')}
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
