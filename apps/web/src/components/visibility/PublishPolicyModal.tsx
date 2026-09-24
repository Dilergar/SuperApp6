'use client';

// ============================================================
// «Опубликовать» (§5.10 B.3): дифф черновика с действующей версией — сколько полей станут
// виднее и для скольких человек, сколько скроются; нарушения обязательной видимости
// публикацию запрещают. Ослабление строгих полей — пароль + SMS (окно `visibility_manage`);
// при «четырёх глазах» — заявка второму владельцу/админу в «Ждут решения».
// Публикуется ровно то, что показал дифф (токен черновика), повтор — тот же ключ намерения.
// ============================================================

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, LoadingBlock, Modal } from '@/components/ui';
import { useStepUp } from '@/components/verify/useStepUp';
import { fetchVisibilityDiff, publishVisibilityPolicy } from '@/lib/visibility-api';
import { wsVisibilityDiffKey } from '@/lib/queries';
import { useIdempotencyIntent } from '@/lib/useIdempotencyKey';
import { toast } from '@/lib/toast';
import { toastApiError } from '@/lib/api-errors';

export function PublishPolicyModal({
  workspaceId,
  recordType,
  onClose,
  onDone,
}: {
  workspaceId: string;
  recordType: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('visibility');
  const tc = useTranslations('common');
  const diff = useQuery({ queryKey: wsVisibilityDiffKey(workspaceId, recordType), queryFn: () => fetchVisibilityDiff(workspaceId, recordType), staleTime: 0 });
  const stepUp = useStepUp('visibility_manage', { title: t('org.publish.stepUpTitle') });
  const intent = useIdempotencyIntent();
  const [busy, setBusy] = useState(false);
  const d = diff.data;
  const nothing = !!d && d.widened.length === 0 && d.narrowed.length === 0;
  const blocked = !!d && d.mandatoryViolations.length > 0;
  const fieldLabel = (k: string) => t(`types.${recordType}.fields.${k}.label`);

  const publish = async () => {
    if (!d) return;
    setBusy(true);
    try {
      const run = () => publishVisibilityPolicy(workspaceId, recordType, d.draftToken, intent.keyFor('visibility-publish', recordType, d.draftToken));
      const res = d.weakensRestricted ? await stepUp.withStepUp(run) : await stepUp.withStepUpOnDemand(run);
      if (!res) return;
      intent.reset();
      toast(res.status === 'pending_approval' ? t('org.publish.sentForApproval') : t('org.publish.published'), 'success');
      onDone();
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={t('org.publish.title')}
      footer={
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end', width: '100%' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{tc('actions.cancel')}</Button>
          <Button variant="primary" tone="success" loading={busy} disabled={!d || blocked} onClick={() => void publish()}>
            {t('org.publish.confirm')}
          </Button>
        </div>
      }
    >
      {diff.isPending ? (
        <LoadingBlock />
      ) : !d ? null : (
        <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
          {nothing && <p className="label-md" style={{ margin: 0 }}>{t('org.publish.noChanges')}</p>}
          {d.widened.length > 0 && (
            <p className="body-md" style={{ margin: 0 }}>
              {t('org.publish.widened', { n: d.widened.length })} {t('org.publish.people', { n: d.widenPeople })}
            </p>
          )}
          {d.narrowed.length > 0 && (
            <p className="body-md" style={{ margin: 0 }}>
              {t('org.publish.narrowed', { n: d.narrowed.length })} {t('org.publish.people', { n: d.narrowPeople })}
            </p>
          )}
          {d.weakensRestricted && <Alert tone="warning">{t('org.publish.weakensRestricted')}</Alert>}
          {blocked && (
            <Alert tone="danger">{t('org.publish.mandatory', { fields: d.mandatoryViolations.map(fieldLabel).join(', ') })}</Alert>
          )}
        </div>
      )}
      {stepUp.dialog}
    </Modal>
  );
}
