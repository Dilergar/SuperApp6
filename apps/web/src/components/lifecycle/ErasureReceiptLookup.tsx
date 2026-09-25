'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LIFECYCLE_RECEIPT_RE } from '@superapp/shared';
import { Button, Input } from '@/components/ui';

/** Код из письма, SMS или заметки: пробелы, дефисы и регистр — не часть кода. */
function normalize(raw: string): string {
  return raw.toLowerCase().replace(/[\s-]+/g, '');
}

/**
 * Открыть квитанцию стирания по коду (core/lifecycle): владелец стёртой организации или
 * человек, сохранивший код, попадает на публичную страницу `/legal/erasure/<код>`. Код
 * проверяется формой (26 знаков base32) до перехода — опечатка не уходит запросом. Слова —
 * `common.erasureReceipt.*`: компонент живёт и в «Моих данных», и на публичной странице.
 */
export function ErasureReceiptLookup() {
  const t = useTranslations('common');
  const router = useRouter();
  const [code, setCode] = useState('');
  const norm = normalize(code);
  const valid = LIFECYCLE_RECEIPT_RE.test(norm);
  const invalid = norm.length > 0 && norm.length >= 26 && !valid;

  const open = () => {
    if (valid) router.push(`/legal/erasure/${norm}`);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        open();
      }}
      style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}
    >
      <div style={{ flex: '1 1 16rem', minWidth: 0 }}>
        <Input
          label={t('erasureReceipt.lookupLabel')}
          hint={invalid ? undefined : t('erasureReceipt.lookupHint')}
          error={invalid ? t('erasureReceipt.lookupBad') : null}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
        />
      </div>
      <Button type="submit" variant="primary" icon="certificate" disabled={!valid}>{t('erasureReceipt.open')}</Button>
    </form>
  );
}
