'use client';

// Публичная страница документа платформы: действующая версия (или номер из архива) + архив версий.
// Без аккаунта; текст — контент из БД, проверенный сервером по хэшу и подписи перед выдачей.

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { CONSENT_TEXT_DOCUMENT_KEYS, isConsentDocumentKey, type ConsentDocumentDto, type ConsentDocumentKey } from '@superapp/shared';
import { Alert, Card, Chip } from '@/components/ui';
import { ConsentDocumentView } from '@/components/consents/ConsentDocumentView';
import { useFormatters } from '@/lib/format';
import { fetchConsentArchive } from '@/lib/public-api';
import { consentArchiveKey } from '@/lib/queries';

export function LegalDocumentPage({ doc, version }: { doc: string; version?: string }) {
  const t = useTranslations('consents');
  const shell = useTranslations('shell');
  const fmt = useFormatters();
  // Контрольная сумма показанного текста — её же несёт запись приёмки и «Лист согласия»
  const [loaded, setLoaded] = useState<ConsentDocumentDto | null>(null);
  const known = isConsentDocumentKey(doc) && (CONSENT_TEXT_DOCUMENT_KEYS as string[]).includes(doc);
  const documentKey = (known ? doc : 'terms') as ConsentDocumentKey;
  const versionNumber = version && /^\d{1,6}$/.test(version) ? Number(version) : undefined;
  const archive = useQuery({ queryKey: consentArchiveKey(documentKey), queryFn: () => fetchConsentArchive(documentKey), enabled: known, staleTime: 60_000 });
  const now = Date.now();
  const currentVersion = (archive.data ?? []).filter((v) => new Date(v.effectiveFrom).getTime() <= now).sort((a, b) => b.version - a.version)[0]?.version;

  return (
    <main className="legal-page">
      <nav className="legal-page-nav no-print" aria-label={t('legal.title')}>
        <Link href="/" style={{ fontWeight: 700 }}>{t('legal.home')}</Link>
        {CONSENT_TEXT_DOCUMENT_KEYS.map((k) => (
          <Link key={k} href={`/legal/${k}`} aria-current={k === documentKey && known ? 'page' : undefined} className="legal-page-link">
            {shell(`consents.documents.${k}`)}
          </Link>
        ))}
      </nav>

      {!known ? (
        <Alert tone="warning">{t('legal.notFound')}</Alert>
      ) : (
        <>
          <Card>
            <ConsentDocumentView documentKey={documentKey} version={versionNumber} onLoaded={setLoaded} />
          </Card>
          {loaded && (
            <p className="label-sm" style={{ margin: 'var(--spacing-3) 0 0', display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)', alignItems: 'center' }}>
              <span>{t('legal.hash')}:</span>
              <span className="receipt-mono" style={{ overflowWrap: 'anywhere' }}>{loaded.contentHash}</span>
              {loaded.attested && <Chip size="sm" tone="success" icon="sealCheck">{t('legal.attested')}</Chip>}
            </p>
          )}

          <section id="archive" className="no-print" aria-labelledby="legal-archive-title">
            <h2 id="legal-archive-title" className="title-md" style={{ margin: 'var(--spacing-6) 0 var(--spacing-3)' }}>{t('legal.archiveTitle')}</h2>
            <p className="label-sm" style={{ margin: '0 0 var(--spacing-3)' }}>{t('legal.subtitle')}</p>
            <ul className="legal-archive">
              {(archive.data ?? []).map((v) => {
                const upcoming = new Date(v.effectiveFrom).getTime() > now;
                const isCurrent = v.version === currentVersion;
                return (
                  <li key={v.versionId}>
                    <Link href={isCurrent ? `/legal/${documentKey}` : `/legal/${documentKey}/v/${v.version}`} style={{ fontWeight: 600 }}>
                      {shell('consents.viewer.version', { version: v.version })}
                    </Link>
                    <span className="label-sm">{fmt.date(v.effectiveFrom)}</span>
                    <Chip size="sm" tone={isCurrent ? 'success' : upcoming ? 'waiting' : 'neutral'}>
                      {isCurrent ? t('legal.current') : upcoming ? t('legal.upcoming', { date: fmt.date(v.effectiveFrom) }) : t('legal.superseded')}
                    </Chip>
                  </li>
                );
              })}
            </ul>
            {versionNumber !== undefined && (
              <p style={{ marginTop: 'var(--spacing-4)' }}>
                <Link href={`/legal/${documentKey}`} style={{ fontWeight: 700 }}>{t('legal.backToCurrent')}</Link>
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
