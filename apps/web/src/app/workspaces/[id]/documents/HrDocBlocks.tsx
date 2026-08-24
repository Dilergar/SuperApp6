'use client';

// ============================================================
// КЭДО-блоки карточки документа: задание кампании ознакомления («Ознакомлен»
// прямо с карточки) и фиксация вручения (специальный режим — ст. 61 п. 3 /
// ст. 65 ТК РК: лично, отказ актом, заказное письмо с треком).
// ============================================================

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DOC_DELIVERY_METHODS, signRequestHref, type OrgDocumentDto } from '@superapp/shared';
import { apiErrorMessage, apiPost } from '@/lib/api';
import { acknowledgeCampaign, fetchMyCampaignTask } from '@/lib/hr-api';
import { approvalsRootKey, myCampaignTaskKey, orgDocumentKey } from '@/lib/queries';
import { toast, toastError } from '@/lib/toast';
import { Alert, Button, Card, CardHeader, Chip, Input, Modal, Select } from '@/components/ui';

/** Баннер адресата кампании: «Ознакомьтесь» с кнопкой (click) или ссылкой (sms) */
export function CampaignAckBanner({ workspaceId, documentId }: { workspaceId: string; documentId: string }) {
  const qc = useQueryClient();
  const taskQ = useQuery({
    queryKey: myCampaignTaskKey(documentId),
    queryFn: () => fetchMyCampaignTask(documentId),
  });
  const ack = useMutation({
    mutationFn: (campaignId: string) => acknowledgeCampaign(campaignId),
    onSuccess: () => {
      toast('Ознакомление зафиксировано', 'success');
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
        title="Вам направлен этот документ на ознакомление"
        action={
          task.fixMode === 'sms' && task.signRequestId ? (
            <Button variant="primary" size="sm" icon="signature" href={signRequestHref(task.signRequestId, workspaceId)}>
              Подтвердить кодом из SMS
            </Button>
          ) : (
            <Button variant="primary" size="sm" icon="check" loading={ack.isPending} onClick={() => ack.mutate(task.campaignId)}>
              Ознакомлен
            </Button>
          )
        }
      >
        {task.fixMode === 'sms'
          ? 'Факт ознакомления в этой кампании подтверждается кодом из SMS (усиленное доказательство).'
          : 'Нажатие фиксирует момент и отпечаток документа — этого требует ст. 23 п. 2 пп. 6 ТК РК.'}
      </Alert>
    </div>
  );
}

const METHOD_LABEL: Record<string, string> = DOC_DELIVERY_METHODS.reduce(
  (acc, m) => ({ ...acc, [m.value]: m.label }),
  {} as Record<string, string>,
);

/** Блок вручения: фиксация (Менеджер+) и след уже зафиксированного */
export function DeliveryBlock({ workspaceId, doc }: { workspaceId: string; doc: OrgDocumentDto }) {
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
            <span style={{ fontWeight: 700 }}>Вручение работнику</span>
            {nonElectronic && (
              <Chip tone="warning">
                {doc.deliveryMode === 'paper' ? 'На бумаге' : 'Гибрид: без ЭЦП, с бумажным дублем'}
              </Chip>
            )}
          </div>
          <div className="meta">
            {doc.deliveredAt
              ? `Вручено ${new Date(doc.deliveredAt).toLocaleDateString('ru-RU')} · ${METHOD_LABEL[doc.deliveryMethod ?? ''] ?? doc.deliveryMethod}${doc.deliveryTrackNumber ? ` · трек ${doc.deliveryTrackNumber}` : ''}`
              : doc.can?.fixDelivery
                ? 'Акт вручается в течение 3 рабочих дней со дня издания — лично либо заказным письмом с уведомлением (ст. 61 п. 3 ТК РК)'
                : 'У работника нет ЭЦП: подпись работника заменяют печать экземпляра («Скачать PDF») и фиксация вручения'}
          </div>
        </div>
        {doc.deliveredAt ? (
          <Chip tone="success" icon="check">Вручено</Chip>
        ) : doc.can?.fixDelivery ? (
          <Button variant="primary" size="sm" icon="check" onClick={() => setOpen(true)}>
            Зафиксировать вручение
          </Button>
        ) : null}
      </div>

      {open && (
        <Modal open onClose={() => setOpen(false)} title="Зафиксировать вручение" size="sm">
          <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
            <Select
              label="Способ"
              value={method}
              onChange={setMethod}
              options={DOC_DELIVERY_METHODS.map((m) => ({ value: m.value, label: m.label }))}
            />
            {method === 'registered_mail' && (
              <Input label="Трек-номер письма" value={track} onChange={(e) => setTrack(e.target.value)} placeholder="KZ123456789" />
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-2)' }}>
              <Button variant="ghost" onClick={() => setOpen(false)}>Отмена</Button>
              <Button variant="primary" loading={fix.isPending} onClick={() => fix.mutate()}>Зафиксировать</Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
