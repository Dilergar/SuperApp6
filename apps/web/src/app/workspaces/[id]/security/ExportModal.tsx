'use client';

// Экспорт журнала безопасности организации (core/audit): формат, период (не шире окна тарифа),
// группа событий → джоб на сервере, файл ляжет на Диск организации в «Безопасность» и придёт
// уведомлением. Ключ повтора формы: двойной клик — один заказ.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AUDIT_ORG_FILTERS, type AuditExportFormat, type AuditOrgFilter } from '@superapp/shared';
import { Alert, Button, Chip, DatePicker, Modal, SegmentedControl } from '@/components/ui';
import { requestOrgSecurityExport } from '@/lib/audit-api';
import { toastApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';
import { useIdempotencyKey } from '@/lib/useIdempotencyKey';

export function ExportModal({ workspaceId, windowDays, onClose }: { workspaceId: string; windowDays: number; onClose: () => void }) {
  const t = useTranslations('audit');
  const tc = useTranslations('common');
  const minDate = new Date(Date.now() - windowDays * 86_400_000);
  const [format, setFormat] = useState<AuditExportFormat>('csv');
  const [from, setFrom] = useState<Date | null>(minDate);
  const [to, setTo] = useState<Date | null>(new Date());
  const [filter, setFilter] = useState<AuditOrgFilter>('all');
  const [busy, setBusy] = useState(false);
  const idem = useIdempotencyKey([format, from?.toISOString(), to?.toISOString(), filter]);

  const submit = async () => {
    if (!from || !to) return;
    setBusy(true);
    try {
      // «По» — включительно до конца дня; «С» — не раньше начала окна тарифа
      const start = new Date(Math.max(from.getTime(), minDate.getTime() + 60_000));
      const end = new Date(Math.min(to.getTime() + 86_399_000, Date.now()));
      await requestOrgSecurityExport(workspaceId, { format, from: start.toISOString(), to: end.toISOString(), ...(filter !== 'all' ? { filter } : {}) }, idem.key);
      idem.reset();
      toast(t('org.export.queued'), 'success');
      onClose();
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose(); }}
      size="md"
      title={t('org.export.title')}
      footer={
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" tone="success" icon="download" loading={busy} disabled={!from || !to || from > to} onClick={() => void submit()}>
            {t('org.export.submit')}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <div>
          <div className="label-caps" style={{ marginBottom: 6 }}>{t('org.export.format')}</div>
          <SegmentedControl<AuditExportFormat>
            aria-label={t('org.export.format')}
            items={[{ key: 'csv', label: 'CSV' }, { key: 'ndjson', label: 'NDJSON' }]}
            value={format}
            onChange={setFormat}
          />
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <DatePicker label={t('org.export.from')} value={from} onChange={setFrom} width={180} />
          <DatePicker label={t('org.export.to')} value={to} onChange={setTo} width={180} />
        </div>
        <div>
          <div className="label-caps" style={{ marginBottom: 6 }}>{t('org.export.categories')}</div>
          <div role="group" aria-label={t('org.export.categories')} style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
            {AUDIT_ORG_FILTERS.map((f) => (
              <Chip key={f} size="sm" selected={filter === f} onClick={() => setFilter(f)}>{t(`filters.org.${f}`)}</Chip>
            ))}
          </div>
        </div>
        <Alert tone="accent" icon="info">{t('org.export.note')}</Alert>
      </div>
    </Modal>
  );
}
