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
import { useTranslations } from 'next-intl';
import type { OrgDocumentDto, OrgDocumentExternalDto, SignActStatus } from '@superapp/shared';

import { useFormatters } from '@/lib/format';
import { toastApiError } from '@/lib/api-errors';
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
  const t = useTranslations('documents');
  const ts = useTranslations('sign');
  const tc = useTranslations('common');
  const f = useFormatters();
  const [confirm, confirmUI] = useConfirm();
  const [copied, setCopied] = useState(false);

  const revoke = useMutation({
    mutationFn: () => documentsApi.revokeExternal(workspaceId, doc.id),
    onSuccess: onChanged,
    onError: (e) => toastApiError(e),
  });
  const sms = useMutation({
    mutationFn: () => documentsApi.resendExternalSms(workspaceId, doc.id),
    onSuccess: () => toast(t('external.smsSent')),
    onError: (e) => toastApiError(e),
  });

  const copyLink = async () => {
    if (!external.link?.url) return;
    try {
      await navigator.clipboard.writeText(external.link.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toastError(t('external.copyFailed'));
    }
  };

  const STAGE_TONE = {
    pending: 'waiting',
    completed: 'success',
    declined: 'danger',
    cancelled: 'neutral',
    expired: 'neutral',
  } as const;
  const stageKey = (external.status in STAGE_TONE ? external.status : 'expired') as keyof typeof STAGE_TONE;
  const stage = { label: t(`external.stage.${stageKey}`), tone: STAGE_TONE[stageKey] };

  return (
    <Card span={12}>
      <CardHeader
        title={t('external.title')}
        subtitle={`${ts(`level.${external.level}.short`)}${
          external.expiresAt ? ` · ${t('external.dueUntil', { date: f.date(external.expiresAt) })}` : ''
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
                      title: t('external.revokeConfirm.title'),
                      message: t('external.revokeConfirm.message'),
                      confirmLabel: t('external.revokeConfirm.action'),
                      danger: true,
                    },
                    async () => {
                      await revoke.mutateAsync();
                    },
                  )
                }
              >
                {t('external.revoke')}
              </Button>
            )}
          </div>
        }
      />

      <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
        {/* Вторая сторона */}
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text-muted)', minWidth: 130 }}>{t('external.otherParty')}</span>
          <Chip size="sm" icon="workspace">
            {doc.counterparty?.name ?? t('external.counterparty')}
          </Chip>
          {doc.counterpartyContact && (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              {t('external.signerIs', { name: doc.counterpartyContact.name })}
              {doc.counterpartyContact.position ? ` · ${doc.counterpartyContact.position}` : ''}
            </span>
          )}
        </div>

        {/* Ссылка + SMS + счётчик открытий */}
        {external.link && (
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-muted)', minWidth: 130 }}>{t('external.link')}</span>
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
                  {copied ? t('external.copied') : tc('actions.copy')}
                </Button>
                {external.smsAvailable && external.status === 'pending' && (
                  <Button variant="ghost" size="sm" icon="sms" loading={sms.isPending} onClick={() => sms.mutate()}>
                    {t('external.sendSms')}
                  </Button>
                )}
              </>
            )}
            {external.opens && external.opens.count > 0 && (
              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                {t('external.opens', { count: external.opens.count })}
                {external.opens.lastOpenedAt
                  ? ` · ${t('external.lastOpen', { at: f.dateTime(external.opens.lastOpenedAt) })}`
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
              <span style={{ color: 'var(--text-muted)', minWidth: 130 }}>{t('external.ourParty')}</span>
              <PersonChip size="M" userId={a.userId} firstName={a.name} />
              <Chip size="sm" tone={ACT_TONE[a.status] ?? 'neutral'}>
                {ts(`actStatus.${a.status}`)}
              </Chip>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-muted)', minWidth: 130 }}>{t('external.counterparty')}</span>
            {external.guestAct ? (
              <>
                <span style={{ fontWeight: 600 }}>{external.guestAct.name}</span>
                {external.guestAct.phoneMasked && (
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{external.guestAct.phoneMasked}</span>
                )}
                <Chip size="sm" tone={ACT_TONE[external.guestAct.status] ?? 'neutral'}>
                  {ts(`actStatus.${external.guestAct.status}`)}
                </Chip>
                {external.guestAct.signedAt && (
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    {f.dateTime(external.guestAct.signedAt)}
                  </span>
                )}
              </>
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>{t('external.notOpenedYet')}</span>
            )}
          </div>
        </div>

        {/* Мягкая сверка ПЭП: подписал не тот номер, что у контакта, — предупреждаем */}
        {external.guestAct &&
          external.guestAct.status === 'signed' &&
          external.level === 'pep' &&
          !external.guestAct.matchesContact && (
            <Alert tone="warning">{t('external.phoneMismatch')}</Alert>
          )}
        {external.guestAct?.declineReason && (
          <Alert tone="danger">{t('external.declineReason', { reason: external.guestAct.declineReason })}</Alert>
        )}
      </div>

      {confirmUI}
    </Card>
  );
}
