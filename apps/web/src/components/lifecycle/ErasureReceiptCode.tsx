'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { toastError } from '@/lib/toast';

/**
 * Код квитанции стирания (core/lifecycle) — показывается ОДИН раз: после удаления аккаунта или
 * архивации организации. В базе лежит только его отпечаток, поэтому скопировать и сохранить код
 * может лишь человек; по нему публичная страница `/legal/erasure/<код>` показывает этапы и
 * подписанный сертификат. В адрес страницы (кроме самой квитанции) код не кладётся.
 */
export function ErasureReceiptCode({ code, caption }: { code: string; caption?: string }) {
  const t = useTranslations('common');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toastError(t('erasureReceipt.copyFailed'));
    }
  };

  return (
    <div className="card ui-stack" style={{ padding: 'var(--spacing-4)', gap: 'var(--spacing-3)' }}>
      <p style={{ margin: 0, fontWeight: 700 }}>
        {t('erasureReceipt.title')}
        {caption ? <span className="label-sm" style={{ fontWeight: 500 }}> · {caption}</span> : null}
      </p>
      <p className="label-sm" style={{ margin: 0, lineHeight: 1.5 }}>{t('erasureReceipt.text')}</p>
      <code className="receipt-mono" style={{ fontSize: '1rem', letterSpacing: '0.06em', overflowWrap: 'anywhere', padding: 'var(--spacing-2) var(--spacing-3)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-container)' }}>
        {code}
      </code>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
        <Button size="sm" variant="outline" icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
          {copied ? t('erasureReceipt.copied') : t('actions.copy')}
        </Button>
        <Button size="sm" variant="ghost" icon="certificate" href={`/legal/erasure/${code}`}>{t('erasureReceipt.open')}</Button>
      </div>
    </div>
  );
}
