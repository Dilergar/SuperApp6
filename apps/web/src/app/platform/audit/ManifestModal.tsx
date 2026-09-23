'use client';

// Манифест архива месяца журнала безопасности: файл читается сервером из хранилища и сверяется
// с подписью, записанной в базе при выгрузке, и со строкой архива. Подменённый в хранилище файл
// показывается «подпись не сходится» — консоль не доверяет содержимому манифеста на слово.

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Chip, Divider, LoadingBlock, Modal } from '@/components/ui';
import { fetchPlatformSecurityManifest, platformSecurityManifestKey } from '@/lib/platform/api';
import { useBytes, useFormatters } from '@/lib/format';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(7rem, 30%) 1fr', gap: 'var(--spacing-3)', alignItems: 'baseline', padding: '0.375rem 0' }}>
      <span className="label-caps">{label}</span>
      <span className="body-sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

export function ManifestModal({ partition, month, onClose }: { partition: string; month: string; onClose: () => void }) {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const fmt = useFormatters();
  const bytes = useBytes();
  const q = useQuery({ queryKey: platformSecurityManifestKey(partition), queryFn: () => fetchPlatformSecurityManifest(partition), retry: false });
  const m = q.data;

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('security.integrity.manifest.title', { month })}
      footer={<Button variant="ghost" onClick={onClose}>{tc('actions.close')}</Button>}
    >
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError || !m ? (
        <Alert tone="danger">{t('security.integrity.manifest.notFound')}</Alert>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Chip size="sm" tone={m.signatureOk ? 'success' : 'danger'}>{t(m.signatureOk ? 'security.integrity.manifest.signatureOk' : 'security.integrity.manifest.signatureBad')}</Chip>
            <Chip size="sm" tone={m.matchesRecord ? 'success' : 'danger'}>{t(m.matchesRecord ? 'security.integrity.manifest.recordOk' : 'security.integrity.manifest.recordBad')}</Chip>
          </div>
          <p className="label-sm" style={{ margin: 'var(--spacing-3) 0 0', lineHeight: 1.5 }}>{t('security.integrity.manifest.hint')}</p>
          <Divider />
          <Row label={t('security.integrity.manifest.format')}><code>{m.format}</code></Row>
          <Row label={t('security.integrity.manifest.period')}>{m.from && m.to ? fmt.timeRange(m.from, Date.parse(m.to) - 1) : '—'}</Row>
          <Row label={t('security.integrity.manifest.rows')}>{fmt.number(m.rows)}</Row>
          <Row label={t('security.integrity.manifest.size')}>{bytes(m.bytes)}</Row>
          <Row label={t('security.integrity.manifest.sha256')}><code style={{ fontSize: '0.75rem' }}>{m.sha256}</code></Row>
          <Row label={t('security.integrity.manifest.root')}><code style={{ fontSize: '0.75rem' }}>{m.merkleRoot}</code></Row>
          <Row label={t('security.integrity.manifest.object')}><code style={{ fontSize: '0.75rem' }}>{m.objectKey}</code></Row>
          <Row label={t('security.integrity.manifest.kid')}><code style={{ fontSize: '0.75rem' }}>{m.kid}</code></Row>
          <Row label={t('security.integrity.manifest.archivedAt')}>{fmt.dateTime(m.archivedAt)}</Row>
          {m.droppedAt && <Row label={t('security.integrity.manifest.droppedAt')}>{fmt.dateTime(m.droppedAt)}</Row>}
        </>
      )}
    </Modal>
  );
}
