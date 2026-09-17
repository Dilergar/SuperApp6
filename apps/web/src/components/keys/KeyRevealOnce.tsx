'use client';

// ============================================================
// Show-once: секрет показывается ОДИН раз (решение грилла №8, модель GitHub/Stripe).
// Скопировать, отметить «я сохранил» — и закрыть. Повторно секрет не показывается
// нигде: сервер хранит только HMAC-хеш. Закрыть без отметки нельзя — это защита от
// «случайно закрыл, а ключ уже не достать» (тогда — ротация).
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button, Checkbox } from '@/components/ui';
import { toast } from '@/lib/toast';

export function KeyRevealOnce({
  secret,
  title,
  note,
  onDone,
}: {
  secret: string;
  title?: string;
  note?: string;
  onDone: () => void;
}) {
  const t = useTranslations('keys');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast(t('reveal.copied'), 'success');
    } catch {
      // Буфер недоступен (http без TLS, iframe) — человек выделит и скопирует руками
      toast(t('reveal.copyFailed'), 'danger');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
      <h3 className="title-md">{title ?? t('reveal.title')}</h3>
      <Alert tone="warning" icon="warning">
        {note ?? t('reveal.note')}
      </Alert>
      <div
        role="textbox"
        aria-readonly="true"
        aria-label={t('reveal.secretLabel')}
        tabIndex={0}
        onFocus={(e) => {
          const range = document.createRange();
          range.selectNodeContents(e.currentTarget);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
        }}
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '0.86rem',
          lineHeight: 1.5,
          wordBreak: 'break-all',
          padding: 'var(--spacing-3) var(--spacing-4)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface-container)',
          border: '1px solid var(--outline-variant)',
          userSelect: 'all',
        }}
      >
        {secret}
      </div>
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center' }}>
        <Button variant="matte" icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
          {copied ? t('reveal.copied') : t('reveal.copy')}
        </Button>
      </div>
      <Checkbox checked={saved} onChange={setSaved} label={t('reveal.savedCheck')} />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" disabled={!saved} onClick={onDone}>
          {t('reveal.done')}
        </Button>
      </div>
    </div>
  );
}
