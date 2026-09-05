'use client';

import { useEffect, useState } from 'react';
import { NOTE_RELATED_TARGET_TYPES, NOTE_TARGET_LABELS, type NoteRelatedRefInput, type NoteRelatedTargetType, type NoteSpaceRef, type NoteTargetSearchItemDto } from '@superapp/shared';
import { EmptyState, Icon, LoadingBlock, Modal, SearchField, SegmentedControl, type IconName } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { searchNoteTargets } from '@/lib/notes-api';
import { toastError } from '@/lib/toast';

// ============================================================
// «Привязать к…»: задача / контрагент / объект / документ. Кандидаты приходят от
// модулей-целей уже обрезанными правами (сервер), пикер их только показывает.
// В личном пространстве доступны только задачи (остальное — сущности организации).
// ============================================================

const ICONS: Record<NoteRelatedTargetType, IconName> = { task: 'tasks', counterparty: 'workspace', branch: 'storefront', document: 'file' };

export function NoteRelatedPicker({ open, onClose, scope, onPick }: { open: boolean; onClose: () => void; scope: NoteSpaceRef; onPick: (ref: NoteRelatedRefInput, title: string) => void | Promise<void> }) {
  const types = scope.workspaceId ? [...NOTE_RELATED_TARGET_TYPES] : (['task'] as NoteRelatedTargetType[]);
  const [type, setType] = useState<NoteRelatedTargetType>('task');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<NoteTargetSearchItemDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(() => {
      searchNoteTargets(scope, type, q.trim())
        .then((rows) => {
          if (!cancelled) setItems(rows);
        })
        .catch((e) => {
          if (!cancelled) toastError(apiErrorMessage(e));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, type, q, scope]);

  return (
    <Modal open={open} onClose={onClose} title="Привязать заметку" size="md">
      <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
        {types.length > 1 && (
          <SegmentedControl aria-label="Тип сущности" value={type} onChange={(v) => setType(v as NoteRelatedTargetType)} items={types.map((t) => ({ key: t, label: NOTE_TARGET_LABELS[t], icon: ICONS[t] }))} />
        )}
        <SearchField value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ('')} placeholder={`Найти: ${NOTE_TARGET_LABELS[type].toLowerCase()}…`} width="100%" />
        {busy && !items ? (
          <LoadingBlock />
        ) : !items?.length ? (
          <EmptyState icon={ICONS[type]} title="Ничего не найдено" description={q ? 'Попробуйте другое слово' : 'Начните вводить название'} />
        ) : (
          <div style={{ display: 'grid', gap: 'var(--spacing-1)', maxHeight: 360, overflowY: 'auto' }}>
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                className="notes-tree-item"
                onClick={() => {
                  void onPick({ targetType: it.targetType, targetId: it.id }, it.title);
                  onClose();
                }}
              >
                <Icon name={ICONS[it.targetType]} size={16} />
                <span className="notes-tree-label">{it.title}</span>
                {it.subtitle && <span className="notes-tree-count">{it.subtitle}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
