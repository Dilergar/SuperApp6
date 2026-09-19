'use client';

// ============================================================
// Просмотр документа платформы (core/consents): «Коротко о главном» → «Что изменилось» →
// полный текст; переключатель языка ДОКУМЕНТА (не интерфейса: человек вправе прочитать
// текст на любом из трёх языков, а принятым считается тот, что был на экране); печать.
// Один компонент на все входы: регистрация (поверх формы), блокирующий экран, баннер,
// «Мои данные», публичная витрина /legal.
// ============================================================

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { LOCALE_DISPLAY_ORDER, LOCALE_NAMES, type ConsentDocumentDto, type ConsentDocumentKey, type Locale } from '@superapp/shared';
import { Alert, Button, Chip, LoadingBlock, SegmentedControl } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { useFormatters } from '@/lib/format';
import { fetchConsentDocument, fetchConsentVersion } from '@/lib/public-api';
import { consentDocumentKey, consentVersionKey } from '@/lib/queries';
import { LegalMarkdown } from './LegalMarkdown';

export interface ConsentDocumentViewProps {
  /** Конкретная версия по id (экраны приёмки) … */
  versionId?: string;
  /** … либо документ по ключу: действующая версия или номер из архива (витрина) */
  documentKey?: ConsentDocumentKey;
  version?: number;
  /** «Что изменилось» наверху и раскрыто (блокирующий экран новой версии) */
  emphasizeChanges?: boolean;
  /** Ссылка на архив версий (витрина и «Мои данные») */
  showArchiveLink?: boolean;
  /** Сообщить наружу, какой язык сейчас на экране: он уйдёт в запись приёмки */
  onLocaleChange?: (locale: Locale) => void;
  /** Сообщить загруженный документ (контрольная сумма, версия) */
  onLoaded?: (doc: ConsentDocumentDto) => void;
}

export function ConsentDocumentView({ versionId, documentKey, version, emphasizeChanges, showArchiveLink, onLocaleChange, onLoaded }: ConsentDocumentViewProps) {
  const t = useTranslations('shell');
  const uiLocale = useLocale() as Locale;
  const fmt = useFormatters();
  const [locale, setLocale] = useState<Locale>(uiLocale);

  const query = useQuery({
    queryKey: versionId ? consentVersionKey(versionId, locale) : consentDocumentKey(documentKey ?? 'terms', locale, version ?? null),
    queryFn: () => (versionId ? fetchConsentVersion(versionId, locale) : fetchConsentDocument(documentKey ?? 'terms', locale, version)),
    enabled: !!versionId || !!documentKey,
    staleTime: 60_000,
  });
  const doc = query.data;

  useEffect(() => {
    onLocaleChange?.(locale);
  }, [locale, onLocaleChange]);
  useEffect(() => {
    if (doc) onLoaded?.(doc);
  }, [doc, onLoaded]);

  if (query.isLoading) return <LoadingBlock text={t('consents.viewer.loading')} />;
  if (query.isError || !doc) {
    return (
      <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t('consents.viewer.retry')}</Button>}>
        {query.error ? apiErrorMessage(query.error) : t('consents.viewer.failed')}
      </Alert>
    );
  }

  const changes = doc.changeSummary ? (
    <section className="legal-block legal-block--changes" aria-labelledby={`chg-${doc.versionId}`}>
      <h3 id={`chg-${doc.versionId}`} className="legal-block-title">{t('consents.viewer.changesTitle')}</h3>
      <LegalMarkdown source={doc.changeSummary} />
    </section>
  ) : null;

  return (
    <article className="legal-doc" lang={doc.locale}>
      <header className="legal-doc-head">
        <div className="legal-doc-meta">
          <h2 className="title-lg" style={{ margin: 0 }}>{t(`consents.documents.${doc.documentKey}`)}</h2>
          <div className="legal-doc-chips">
            <Chip size="sm" tone="neutral">{t('consents.viewer.version', { version: doc.version })}</Chip>
            <Chip size="sm" tone={doc.isCurrent ? 'success' : 'waiting'}>
              {doc.isCurrent ? t('consents.viewer.effectiveFrom', { date: fmt.date(doc.effectiveFrom) }) : new Date(doc.effectiveFrom).getTime() > Date.now() ? t('consents.viewer.effectiveFrom', { date: fmt.date(doc.effectiveFrom) }) : t('consents.viewer.notCurrent')}
            </Chip>
          </div>
        </div>
        <div className="legal-doc-tools no-print">
          <SegmentedControl
            aria-label={t('consents.viewer.language')}
            items={LOCALE_DISPLAY_ORDER.map((l) => ({ key: l, label: LOCALE_NAMES[l] }))}
            value={locale}
            onChange={(l) => setLocale(l as Locale)}
          />
          <Button size="sm" variant="ghost" icon="file" onClick={() => window.print()}>{t('consents.viewer.print')}</Button>
        </div>
      </header>

      {emphasizeChanges && changes}

      <section className="legal-block legal-block--summary" aria-labelledby={`sum-${doc.versionId}`}>
        <h3 id={`sum-${doc.versionId}`} className="legal-block-title">{t('consents.viewer.summaryTitle')}</h3>
        <LegalMarkdown source={doc.summary} />
      </section>

      {!emphasizeChanges && changes}

      <section aria-labelledby={`full-${doc.versionId}`}>
        <h3 id={`full-${doc.versionId}`} className="legal-block-title">{t('consents.viewer.fullTitle')}</h3>
        <LegalMarkdown source={doc.body} />
      </section>

      {showArchiveLink && (
        <p className="no-print" style={{ marginTop: 'var(--spacing-6)' }}>
          <Link href={`/legal/${doc.documentKey}#archive`} style={{ fontWeight: 600 }}>{t('consents.viewer.archive')}</Link>
        </p>
      )}
    </article>
  );
}
