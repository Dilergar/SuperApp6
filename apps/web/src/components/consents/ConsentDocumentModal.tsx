'use client';

// Документ платформы ПОВЕРХ текущего экрана: форма под модалкой остаётся смонтированной,
// введённое не теряется. Прокрутка до конца не требуется — закрыть можно в любой момент.

import { useTranslations } from 'next-intl';
import type { ConsentDocumentKey } from '@superapp/shared';
import { Button, Modal } from '@/components/ui';
import { ConsentDocumentView } from './ConsentDocumentView';

export function ConsentDocumentModal({ open, onClose, versionId, documentKey }: { open: boolean; onClose: () => void; versionId?: string; documentKey?: ConsentDocumentKey }) {
  const t = useTranslations('shell');
  return (
    <Modal open={open} onClose={onClose} size="xl" footer={<Button variant="primary" onClick={onClose}>{t('consents.viewer.close')}</Button>}>
      {open && <ConsentDocumentView versionId={versionId} documentKey={documentKey} />}
    </Modal>
  );
}
