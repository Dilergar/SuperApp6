'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ErasureReceiptLookup } from '@/components/lifecycle/ErasureReceiptLookup';

/**
 * Вход к квитанции стирания без кода в адресе (core/lifecycle): сюда ведёт уведомление
 * «организация стёрта» — код знает только владелец, в уведомление он не кладётся.
 */
export default function ErasureReceiptIndex() {
  const t = useTranslations('lifecycle');
  return (
    <main className="legal-page">
      <nav className="legal-page-nav no-print" aria-label={t('receipt.title')}>
        <Link href="/" style={{ fontWeight: 700 }}>{t('receipt.home')}</Link>
        <Link href="/legal" className="legal-page-link">{t('receipt.legal')}</Link>
      </nav>
      <header style={{ marginBottom: 'var(--spacing-5)' }}>
        <h1 className="title-lg" style={{ margin: '0 0 var(--spacing-2)' }}>{t('receipt.title')}</h1>
        <p className="body-md" style={{ margin: 0, color: 'var(--on-surface-variant)' }}>{t('receipt.lookupIntro')}</p>
      </header>
      <ErasureReceiptLookup />
    </main>
  );
}
