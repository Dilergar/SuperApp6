'use client';

// ============================================================
// Галочки пакета согласий (core/consents): регистрация (две галочки, обе сняты) и создание
// организации (одна). Правила экрана:
//  - подпись короткая, документы — ссылками ВНУТРИ подписи; ссылка НЕ переключает галочку
//    и открывает документ поверх формы (введённое не теряется);
//  - ошибка — строкой под галочкой, не тостом;
//  - прокрутка документа до конца не требуется.
// Хук отдаёт то, что уходит на сервер: id версий, которые человеку ПОКАЗАЛИ, и язык показа.
// ============================================================

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import type { ConsentBundleDto, ConsentBundleKey, ConsentDocumentKey, ConsentSelectionInput, Locale } from '@superapp/shared';
import { Alert, Checkbox } from '@/components/ui';
import { fetchConsentBundle } from '@/lib/public-api';
import { consentBundleKey } from '@/lib/queries';
import { ConsentDocumentModal } from './ConsentDocumentModal';

export interface ConsentBundleState {
  bundle: ConsentBundleDto | undefined;
  loading: boolean;
  /** Пакет не отдался либо в нём нет обязательных документов — действие закрыто */
  unavailable: boolean;
  accepted: boolean;
  setAccepted: (v: boolean) => void;
  marketing: boolean;
  setMarketing: (v: boolean) => void;
  /** Поле `consents` запроса; null — обязательная галочка не стоит */
  selection: () => ConsentSelectionInput | null;
}

export function useConsentBundle(bundleKey: ConsentBundleKey): ConsentBundleState {
  const locale = useLocale() as Locale;
  const [accepted, setAccepted] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const query = useQuery({ queryKey: consentBundleKey(bundleKey), queryFn: () => fetchConsentBundle(bundleKey), staleTime: 60_000 });
  const bundle = query.data;

  const selection = useCallback((): ConsentSelectionInput | null => {
    if (!bundle || !accepted || bundle.documents.length === 0) return null;
    const versionIds = bundle.documents.map((d) => d.versionId);
    if (marketing) versionIds.push(...bundle.optional.filter((d) => d.documentKey === 'marketing').map((d) => d.versionId));
    return { versionIds, locale, channel: 'web' };
  }, [bundle, accepted, marketing, locale]);

  return {
    bundle,
    loading: query.isLoading,
    unavailable: query.isError || (!!bundle && bundle.documents.length === 0),
    accepted,
    setAccepted,
    marketing,
    setMarketing,
    selection,
  };
}

/** Ссылка внутри подписи галочки: кнопка, а не <a> — документ открывается поверх формы, галочка не трогается. */
function DocLink({ children, onOpen }: { children: ReactNode; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="consent-doc-link"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      }}
    >
      {children}
    </button>
  );
}

export function ConsentBundleField({ state, variant, error }: { state: ConsentBundleState; variant: 'registration' | 'workspace'; error?: string | null }) {
  const t = useTranslations('shell');
  const [openDoc, setOpenDoc] = useState<ConsentDocumentKey | null>(null);
  const versionOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of [...(state.bundle?.documents ?? []), ...(state.bundle?.optional ?? [])]) map.set(d.documentKey, d.versionId);
    return map;
  }, [state.bundle]);

  if (state.unavailable) return <Alert tone="warning">{t('consents.registration.unavailable')}</Alert>;

  const link = (key: ConsentDocumentKey) => (chunks: ReactNode) => <DocLink onOpen={() => setOpenDoc(key)}>{chunks}</DocLink>;
  const mainLabel =
    variant === 'registration'
      ? t.rich('consents.registration.main', { terms: link('terms'), privacy: link('privacy'), crossBorder: link('cross_border'), policy: link('privacy_policy') })
      : t.rich('consents.workspace.main', { businessTerms: link('business_terms'), dpa: link('dpa') });
  const errorId = `consent-error-${variant}`;

  return (
    <div className="consent-field">
      <Checkbox
        className="consent-check"
        checked={state.accepted}
        onChange={state.setAccepted}
        disabled={state.loading}
        label={mainLabel}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
      />
      {error && <p id={errorId} role="alert" className="consent-error">{error}</p>}
      {variant === 'registration' && <p className="label-sm consent-note">{t('consents.registration.minorNote')}</p>}
      {variant === 'registration' && versionOf.has('marketing') && (
        <Checkbox
          className="consent-check"
          checked={state.marketing}
          onChange={state.setMarketing}
          disabled={state.loading}
          label={t.rich('consents.registration.marketing', { marketing: link('marketing') })}
        />
      )}
      <ConsentDocumentModal open={!!openDoc} onClose={() => setOpenDoc(null)} versionId={openDoc ? versionOf.get(openDoc) : undefined} documentKey={openDoc ?? undefined} />
    </div>
  );
}
