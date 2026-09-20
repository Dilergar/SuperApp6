'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { NOTE_RELATED_TARGET_TYPES, type NoteRelatedRefInput, type NoteRelatedTargetType, type NoteSpaceRef, type NoteTargetSearchItemDto } from '@superapp/shared';
import { EmptyState, Icon, LoadingBlock, Modal, SearchField, SegmentedControl, type IconName } from '@/components/ui';

import { searchNoteTargets } from '@/lib/notes-api';

import { toastApiError } from '@/lib/api-errors';
// ============================================================
// «Привязать к…»: задача / контрагент / объект / документ. Кандидаты приходят от
// модулей-целей уже обрезанными правами (сервер), пикер их только показывает.
// В личном пространстве доступны только задачи (остальное — сущности организации).
// ============================================================

const ICONS: Record<NoteRelatedTargetType, IconName> = { task: 'tasks', counterparty: 'workspace', branch: 'storefront', document: 'file' };

export function NoteRelatedPicker({ open, onClose, scope, onPick }: { open: boolean; onClose: () => void; scope: NoteSpaceRef; onPick: (ref: NoteRelatedRefInput, title: string) => void | Promise<void> }) {
  const t = useTranslations('notes');
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
          if (!cancelled) toastApiError(e);
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
    <Modal open={open} onClose={onClose} title={t('related.title')} size="md">
      <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
        {types.length > 1 && (
          <SegmentedControl aria-label={t('related.typeAria')} value={type} onChange={(v) => setType(v as NoteRelatedTargetType)} items={types.map((k) => ({ key: k, label: t(`target.${k}`), icon: ICONS[k] }))} />
        )}
        <SearchField value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ('')} placeholder={t('related.searchPlaceholder', { type: t(`target.${type}`).toLowerCase() })} width="100%" />
        {busy && !items ? (
          <LoadingBlock />
        ) : !items?.length ? (
          <EmptyState icon={ICONS[type]} title={t('related.nothingFound')} description={q ? t('board.searchHint') : t('related.startTyping')} />
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
