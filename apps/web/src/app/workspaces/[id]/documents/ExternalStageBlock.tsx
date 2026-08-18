'use client';

// ============================================================
// Внешний этап документа «С контрагентами»: ЭТАП и ДОСТАВКА.
//
// Подписи (акты, протокол, экспорт, штамп) здесь НЕ дублируются — их рисует
// существующий SignaturesBlock из dto.sign. Этот блок отвечает за то, чего там
// нет: статус этапа и срок, вторая сторона, копируемая ссылка, SMS, счётчик
// открытий и кнопки «Отозвать» / «Вернуть в черновик».
// ============================================================

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  SIGN_ACT_STATUS_LABELS,
  SIGN_LEVEL_LABELS,
  type OrgDocumentDto,
  type OrgDocumentExternalDto,
  type SignActStatus,
  type SignLevel,
} from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import { Alert, Button, Card, CardHeader, Chip, Divider, useConfirm } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { documentsApi } from './documents-api';

const ACT_TONE: Record<SignActStatus, 'success' | 'danger' | 'neutral' | 'waiting'> = {
  pending: 'waiting',
  signed: 'success',
  declined: 'danger',
  failed: 'danger',
  expired: 'neutral',
};

export function ExternalStageBlock({
  workspaceId,
  doc,
  external,
  onChanged,
}: {
  workspaceId: string;
  doc: OrgDocumentDto;
  external: OrgDocumentExternalDto;
  onChanged: () => void;
}) {
  const [confirm, confirmUI] = useConfirm();
  const [copied, setCopied] = useState(false);

  const revoke = useMutation({
    mutationFn: () => documentsApi.revokeExternal(workspaceId, doc.id),
    onSuccess: onChanged,
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const sms = useMutation({
    mutationFn: () => documentsApi.resendExternalSms(workspaceId, doc.id),
    onSuccess: () => toast('SMS со ссылкой отправлена'),
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const copyLink = async () => {
    if (!external.link?.url) return;
    try {
      await navigator.clipboard.writeText(external.link.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toastError('Не удалось скопировать — выделите ссылку вручную');
    }
  };

  const stage =
    external.status === 'pending'
      ? { label: 'Ждём подписи', tone: 'waiting' as const }
      : external.status === 'completed'
        ? { label: 'Подписано всеми', tone: 'success' as const }
        : external.status === 'declined'
          ? { label: 'Контрагент отказал', tone: 'danger' as const }
          : external.status === 'cancelled'
            ? { label: 'Отправка отозвана', tone: 'neutral' as const }
            : { label: 'Срок истёк', tone: 'neutral' as const };

  return (
    <Card span={12}>
      <CardHeader
        title="Отправка контрагенту"
        subtitle={`${SIGN_LEVEL_LABELS[external.level as SignLevel]?.short ?? external.level}${
          external.expiresAt ? ` · срок до ${new Date(external.expiresAt).toLocaleDateString('ru-RU')}` : ''
        }`}
        actions={
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip tone={stage.tone} size="sm">
              {stage.label}
            </Chip>
            {doc.can?.revokeExternal && (
              <Button
                variant="ghost"
                size="sm"
                icon="close"
                loading={revoke.isPending}
                onClick={() =>
                  confirm(
                    {
                      title: 'Отозвать отправку?',
                      message:
                        'Ссылка контрагента погаснет, сбор подписей прекратится, документ вернётся в черновик. Уже поставленные подписи останутся в истории.',
                      confirmLabel: 'Отозвать',
                      danger: true,
                    },
                    async () => {
                      await revoke.mutateAsync();
                    },
                  )
                }
              >
                Отозвать отправку
              </Button>
            )}
          </div>
        }
      />

      <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
        {/* Вторая сторона */}
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text-muted)', minWidth: 130 }}>Вторая сторона</span>
          <Chip size="sm" icon="workspace">
            {doc.counterparty?.name ?? 'Контрагент'}
          </Chip>
          {doc.counterpartyContact && (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              подписант: {doc.counterpartyContact.name}
              {doc.counterpartyContact.position ? ` · ${doc.counterpartyContact.position}` : ''}
            </span>
          )}
        </div>

        {/* Ссылка + SMS + счётчик открытий */}
        {external.link && (
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-muted)', minWidth: 130 }}>Ссылка</span>
            <code
              style={{
                padding: '4px 10px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-input)',
                background: 'var(--surface-container)',
                fontSize: '0.82rem',
                maxWidth: 360,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textDecoration: external.link.revoked ? 'line-through' : undefined,
              }}
            >
              {external.link.url}
            </code>
            {!external.link.revoked && (
              <>
                <Button variant="ghost" size="sm" icon="copy" onClick={() => void copyLink()}>
                  {copied ? 'Скопировано' : 'Копировать'}
                </Button>
                {external.smsAvailable && external.status === 'pending' && (
                  <Button variant="ghost" size="sm" icon="sms" loading={sms.isPending} onClick={() => sms.mutate()}>
                    Отправить SMS
                  </Button>
                )}
              </>
            )}
            {external.opens && external.opens.count > 0 && (
              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                открыто {external.opens.count} раз
                {external.opens.lastOpenedAt
                  ? ` · последний: ${new Date(external.opens.lastOpenedAt).toLocaleString('ru-RU')}`
                  : ''}
              </span>
            )}
          </div>
        )}

        <Divider />

        {/* Кто что подписал: коротко, по сторонам (полные акты — в блоке «Подписи») */}
        <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
          {external.internalActs.map((a) => (
            <div key={a.userId} style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 130 }}>Наша сторона</span>
              <PersonChip size="M" userId={a.userId} firstName={a.name} />
              <Chip size="sm" tone={ACT_TONE[a.status] ?? 'neutral'}>
                {SIGN_ACT_STATUS_LABELS[a.status] ?? a.status}
              </Chip>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-muted)', minWidth: 130 }}>Контрагент</span>
            {external.guestAct ? (
              <>
                <span style={{ fontWeight: 600 }}>{external.guestAct.name}</span>
                {external.guestAct.phoneMasked && (
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{external.guestAct.phoneMasked}</span>
                )}
                <Chip size="sm" tone={ACT_TONE[external.guestAct.status] ?? 'neutral'}>
                  {SIGN_ACT_STATUS_LABELS[external.guestAct.status] ?? external.guestAct.status}
                </Chip>
                {external.guestAct.signedAt && (
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    {new Date(external.guestAct.signedAt).toLocaleString('ru-RU')}
                  </span>
                )}
              </>
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>ещё не открывал документ</span>
            )}
          </div>
        </div>

        {/* Мягкая сверка ПЭП: подписал не тот номер, что у контакта, — предупреждаем */}
        {external.guestAct &&
          external.guestAct.status === 'signed' &&
          external.level === 'pep' &&
          !external.guestAct.matchesContact && (
            <Alert tone="warning">
              Номер подписанта не совпадает с телефоном контактного лица из справочника — проверьте, тот ли
              человек подписал
            </Alert>
          )}
        {external.guestAct?.declineReason && (
          <Alert tone="danger">Причина отказа: {external.guestAct.declineReason}</Alert>
        )}
      </div>

      {confirmUI}
    </Card>
  );
}
