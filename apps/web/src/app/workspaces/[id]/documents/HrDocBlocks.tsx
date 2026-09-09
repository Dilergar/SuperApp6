'use client';

// ============================================================
// КЭДО-блоки карточки документа: задание кампании ознакомления («Ознакомлен»
// прямо с карточки) и фиксация вручения (специальный режим — ст. 61 п. 3 /
// ст. 65 ТК РК: лично, отказ актом, заказное письмо с треком).
// ============================================================

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { DOC_DELIVERY_METHODS, signRequestHref, type OrgDocumentDto } from '@superapp/shared';
import { apiErrorMessage, apiPost } from '@/lib/api';
import { useFormatters } from '@/lib/format';
import { acknowledgeCampaign, fetchMyCampaignTask } from '@/lib/hr-api';
import { approvalsRootKey, myCampaignTaskKey, orgDocumentKey } from '@/lib/queries';
import { toast, toastError } from '@/lib/toast';
import { Alert, Button, Card, CardHeader, Chip, Input, Modal, Select } from '@/components/ui';

/** Баннер адресата кампании: «Ознакомьтесь» с кнопкой (click) или ссылкой (sms) */
export function CampaignAckBanner({ workspaceId, documentId }: { workspaceId: string; documentId: string }) {
  const t = useTranslations('hr');
  const qc = useQueryClient();
  const taskQ = useQuery({
    queryKey: myCampaignTaskKey(documentId),
    queryFn: () => fetchMyCampaignTask(documentId),
  });
  const ack = useMutation({
    mutationFn: (campaignId: string) => acknowledgeCampaign(campaignId),
    onSuccess: () => {
      toast(t('campaign.ackRecorded'), 'success');
      void qc.invalidateQueries({ queryKey: myCampaignTaskKey(documentId) });
      void qc.invalidateQueries({ queryKey: approvalsRootKey });
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const task = taskQ.data;
  if (!task) return null;
  return (
    <div style={{ marginBottom: 'var(--gap-grid)' }}>
      <Alert
        tone="accent"
        title={t('campaign.ackBannerTitle')}
        action={
          task.fixMode === 'sms' && task.signRequestId ? (
            <Button variant="primary" size="sm" icon="signature" href={signRequestHref(task.signRequestId, workspaceId)}>
              {t('campaign.confirmBySms')}
            </Button>
          ) : (
            <Button variant="primary" size="sm" icon="check" loading={ack.isPending} onClick={() => ack.mutate(task.campaignId)}>
              {t('campaign.acknowledged')}
            </Button>
          )
        }
      >
        {t(task.fixMode === 'sms' ? 'campaign.ackHintSms' : 'campaign.ackHintClick')}
      </Alert>
    </div>
  );
}

/** Блок вручения: фиксация (Менеджер+) и след уже зафиксированного */
export function DeliveryBlock({ workspaceId, doc }: { workspaceId: string; doc: OrgDocumentDto }) {
  const t = useTranslations('hr');
  const tc = useTranslations('common');
  const f = useFormatters();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState('in_person');
  const [track, setTrack] = useState('');

  const fix = useMutation({
    mutationFn: () =>
      apiPost<OrgDocumentDto>(`/workspaces/${workspaceId}/documents/${doc.id}/delivery`, {
        method,
        ...(track.trim() ? { trackNumber: track.trim() } : {}),
      }),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: orgDocumentKey(workspaceId, doc.id) });
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  // Гибрид/бумага видны и БЕЗ specialDelivery: режим доставки — часть правды
  // о документе (paperMode работника), а не только про акты ст. 61
  const nonElectronic = doc.deliveryMode && doc.deliveryMode !== 'electronic';
  if (!doc.deliveredAt && !doc.can?.fixDelivery && !nonElectronic) return null;

  return (
    <Card span={12} small>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700 }}>{t('delivery.title')}</span>
            {nonElectronic && (
              <Chip tone="warning">
                {t(`deliveryMode.${doc.deliveryMode}`)}
              </Chip>
            )}
          </div>
          <div className="meta">
            {doc.deliveredAt
              ? t('delivery.doneAt', {
                  date: f.date(doc.deliveredAt),
                  method: doc.deliveryMethod ? t(`deliveryMethod.${doc.deliveryMethod}`) : '',
                  trackSuffix: doc.deliveryTrackNumber
                    ? t('delivery.trackSuffix', { track: doc.deliveryTrackNumber })
                    : '',
                })
              : t(doc.can?.fixDelivery ? 'delivery.hintManager' : 'delivery.hintPaper')}
          </div>
        </div>
        {doc.deliveredAt ? (
          <Chip tone="success" icon="check">{t('delivery.doneChip')}</Chip>
        ) : doc.can?.fixDelivery ? (
          <Button variant="primary" size="sm" icon="check" onClick={() => setOpen(true)}>
            {t('delivery.fix')}
          </Button>
        ) : null}
      </div>

      {open && (
        <Modal open onClose={() => setOpen(false)} title={t('delivery.fix')} size="sm">
          <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
            <Select
              label={t('delivery.method')}
              value={method}
              onChange={setMethod}
              options={DOC_DELIVERY_METHODS.map((m) => ({ value: m, label: t(`deliveryMethod.${m}`) }))}
            />
            {method === 'registered_mail' && (
              <Input label={t('delivery.trackNumber')} value={track} onChange={(e) => setTrack(e.target.value)} placeholder="KZ123456789" />
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-2)' }}>
              <Button variant="ghost" onClick={() => setOpen(false)}>{tc('actions.cancel')}</Button>
              <Button variant="primary" loading={fix.isPending} onClick={() => fix.mutate()}>{t('delivery.fixShort')}</Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
