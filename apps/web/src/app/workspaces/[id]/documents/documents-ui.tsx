'use client';

// ============================================================
// Мелкие общие детали раздела «Документы».
//
// Правило DESIGN.md: смысл несёт ФОРМА, а не покрашенное слово — статус
// это Chip, а не цветной текст.
// ============================================================

import { DOC_STATUS_LABELS, type DocStatus } from '@superapp/shared';
import { Chip } from '@/components/ui';
import type { Tone } from '@/components/ui';

/**
 * Тон статуса. Красный — только отказ: он и есть опасное состояние документа.
 * «У контрагента» — существующий жёлтый тон «Ожидание» (утверждён в ревью
 * дизайна): документ ждёт вторую сторону. Новых цветов не заводим.
 */
const STATUS_TONE: Record<DocStatus, Tone> = {
  draft: 'neutral',
  in_review: 'accent',
  sent: 'waiting',
  rejected: 'danger',
  declined_external: 'danger',
  signed: 'success',
  registered: 'success',
  active: 'success',
  cancelled: 'neutral',
  archived: 'neutral',
};

export function DocStatusChip({ status }: { status: DocStatus }) {
  return (
    <Chip tone={STATUS_TONE[status] ?? 'neutral'} size="sm">
      {DOC_STATUS_LABELS[status] ?? status}
    </Chip>
  );
}
