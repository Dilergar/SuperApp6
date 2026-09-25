'use client';

// ============================================================
// Квитанция стирания (core/lifecycle): публичная страница по коду из мастера удаления.
// Аккаунта к этому времени уже нет — код единственный ключ человека к этапам и сертификату.
// Персональных данных на странице нет: псевдоним, даты, счётчики, подпись.
//
// Подпись проверяется В БРАУЗЕРЕ по JWKS платформы (Ed25519, WebCrypto) — человеку не нужно
// верить серверу на слово. Ключа в JWKS уже нет (ротация) или браузер не умеет Ed25519 —
// архивная проверка сервером (`/verification`), и страница честно говорит, кто проверял.
// ============================================================

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  LIFECYCLE_RECEIPT_RE,
  lifecycleCertificatePayload,
  type LifecycleErasureCertificate,
  type LifecycleErasureReceiptDto,
} from '@superapp/shared';
import { Alert, Button, Card, Chip, Icon, LoadingBlock, TickBar, type Tone } from '@/components/ui';
import { useFormatters } from '@/lib/format';
import { apiErrorCode, fetchErasureReceipt, fetchErasureVerification, fetchJwks } from '@/lib/public-api';
import { erasureReceiptKey } from '@/lib/queries';

type VerifyState = 'idle' | 'checking' | 'valid' | 'validServer' | 'invalid';

const STATUS_TONE: Record<LifecycleErasureReceiptDto['status'], Tone> = {
  scheduled: 'waiting',
  held: 'waiting',
  running: 'waiting',
  hot_purged: 'waiting',
  keys_destroyed: 'waiting',
  completed: 'success',
  cancelled: 'neutral',
  failed: 'waiting',
};

function base64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Проверка подписи в браузере: `null` — проверить здесь нельзя (ключа нет в JWKS, браузер без Ed25519). */
async function verifyInBrowser(rc: LifecycleErasureReceiptDto): Promise<boolean | null> {
  if (!rc.certificate || !rc.signature || !rc.kid || !globalThis.crypto?.subtle) return null;
  const jwk = (await fetchJwks()).keys.find((k) => k.kid === rc.kid);
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
    const data = new TextEncoder().encode(lifecycleCertificatePayload(rc.certificate));
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, base64urlBytes(rc.signature), data);
  } catch {
    return null;
  }
}

function downloadCertificate(code: string, rc: LifecycleErasureReceiptDto & { certificate: LifecycleErasureCertificate }) {
  const body = JSON.stringify(
    { certificate: rc.certificate, payload: lifecycleCertificatePayload(rc.certificate), signature: rc.signature, kid: rc.kid, algorithm: 'Ed25519', jwks: '/.well-known/jwks.json' },
    null,
    2,
  );
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `erasure-certificate-${code}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ErasureReceiptPage({ code }: { code: string }) {
  const t = useTranslations('lifecycle');
  const fmt = useFormatters();
  const valid = LIFECYCLE_RECEIPT_RE.test(code);
  const receipt = useQuery({ queryKey: erasureReceiptKey(code), queryFn: () => fetchErasureReceipt(code), enabled: valid, retry: false, staleTime: 60_000 });
  const [verify, setVerify] = useState<VerifyState>('idle');
  const rc = receipt.data;

  const runVerify = async () => {
    if (!rc) return;
    setVerify('checking');
    const local = await verifyInBrowser(rc).catch(() => null);
    if (local !== null) {
      setVerify(local ? 'valid' : 'invalid');
      return;
    }
    const server = await fetchErasureVerification(code).catch(() => null);
    setVerify(server?.state === 'valid' ? 'validServer' : 'invalid');
  };

  const stages: Array<{ key: string; at: string | null; planned?: string | null }> = rc
    ? [
        { key: 'requested', at: rc.requestedAt },
        { key: 'effective', at: new Date(rc.effectiveAt).getTime() <= Date.now() ? rc.effectiveAt : null, planned: rc.effectiveAt },
        { key: 'hidden', at: rc.hiddenAt },
        { key: 'hotPurged', at: rc.hotPurgedAt },
        { key: 'keysDestroyed', at: rc.keysDestroyedAt },
        { key: 'backupsClear', at: rc.status === 'completed' ? rc.backupsClearAt : null, planned: rc.backupsClearAt },
        { key: 'completed', at: rc.completedAt },
      ]
    : [];
  const done = stages.filter((s) => !!s.at).length;
  const cert = rc?.certificate ?? null;
  const counts = cert ? Object.entries(cert.counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]) : [];
  const total = counts.reduce((sum, [, n]) => sum + n, 0);

  return (
    <main className="legal-page">
      <nav className="legal-page-nav no-print" aria-label={t('receipt.title')}>
        <Link href="/" style={{ fontWeight: 700 }}>{t('receipt.home')}</Link>
        <Link href="/legal" className="legal-page-link">{t('receipt.legal')}</Link>
      </nav>

      <header style={{ marginBottom: 'var(--spacing-5)' }}>
        <h1 className="title-lg" style={{ margin: '0 0 var(--spacing-2)' }}>{t('receipt.title')}</h1>
        <p className="body-md" style={{ margin: 0, color: 'var(--on-surface-variant)' }}>{t('receipt.subtitle')}</p>
      </header>

      {!valid ? (
        <Alert tone="warning">{t('receipt.badCode')}</Alert>
      ) : receipt.isLoading ? (
        <LoadingBlock />
      ) : receipt.isError || !rc ? (
        <Alert tone="warning">{apiErrorCode(receipt.error) === 'lifecycle.receiptNotFound' ? t('receipt.notFound') : t('receipt.loadFailed')}</Alert>
      ) : (
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <Card>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="ui-stack" style={{ gap: 'var(--spacing-1)' }}>
                <span className="label-caps">{t('receipt.code')}</span>
                <span className="receipt-mono" style={{ fontSize: '0.9375rem', overflowWrap: 'anywhere' }}>{code}</span>
              </div>
              <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                <Chip tone="neutral">{t(`receipt.subject.${rc.subjectType}`)}</Chip>
                <Chip tone={STATUS_TONE[rc.status]} icon={rc.status === 'completed' ? 'sealCheck' : 'clock'}>{t(`receipt.status.${rc.status}`)}</Chip>
              </div>
            </div>
            {rc.status === 'cancelled' ? (
              <div style={{ marginTop: 'var(--spacing-4)' }}>
                <Alert tone="neutral">{t('receipt.cancelled')}</Alert>
              </div>
            ) : (
              <>
                <TickBar value={(done / stages.length) * 100} tone={rc.status === 'completed' ? 'success' : 'waiting'} label={t('receipt.progress')} style={{ margin: 'var(--spacing-4) 0' }} />
                <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--spacing-2)' }}>
                  {stages.map((s) => (
                    <li key={s.key} style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', fontSize: '0.875rem' }}>
                      <Icon name={s.at ? 'check' : 'clock'} size={16} color={s.at ? 'var(--success-base)' : 'var(--muted)'} style={{ flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>{t(`receipt.stages.${s.key}`)}</span>
                      <span className="label-sm">{s.at ? fmt.date(s.at) : s.planned ? t('receipt.planned', { date: fmt.date(s.planned) }) : t('receipt.pending')}</span>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </Card>

          {cert && (
            <Card>
              <h2 className="title-md" style={{ margin: '0 0 var(--spacing-2)' }}>{t('receipt.certificate.title')}</h2>
              <p className="label-sm" style={{ margin: '0 0 var(--spacing-4)', lineHeight: 1.5 }}>{t('receipt.certificate.text')}</p>
              <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 'var(--spacing-2) var(--spacing-4)', margin: 0, fontSize: '0.875rem' }}>
                {counts.map(([cls, n]) => (
                  <div key={cls} style={{ display: 'contents' }}>
                    <dt>{t(`classes.${cls}.title`)}</dt>
                    <dd style={{ margin: 0, textAlign: 'right' }}>{fmt.number(n)}</dd>
                  </div>
                ))}
                <dt style={{ fontWeight: 700 }}>{t('receipt.certificate.total')}</dt>
                <dd style={{ margin: 0, textAlign: 'right', fontWeight: 700 }}>{fmt.number(total)}</dd>
                <dt>{t('receipt.certificate.policies')}</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>{fmt.number(Object.keys(cert.policies).length)}</dd>
                <dt>{t('receipt.certificate.keys')}</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>{fmt.number(cert.keyIds.length)}</dd>
                <dt>{t('receipt.certificate.pseudonym')}</dt>
                <dd className="receipt-mono" style={{ margin: 0, textAlign: 'right', overflowWrap: 'anywhere' }}>{cert.pseudonym.slice(0, 16)}…</dd>
              </dl>
              <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', alignItems: 'center', marginTop: 'var(--spacing-4)' }}>
                <Button variant="primary" icon="sealCheck" loading={verify === 'checking'} onClick={() => void runVerify()}>{t('receipt.verify.action')}</Button>
                <Button variant="outline" icon="download" onClick={() => downloadCertificate(code, { ...rc, certificate: cert })}>{t('receipt.download')}</Button>
                {(verify === 'valid' || verify === 'validServer') && (
                  <Chip tone="success" icon="sealCheck">{t(verify === 'valid' ? 'receipt.verify.valid' : 'receipt.verify.validServer')}</Chip>
                )}
                {verify === 'invalid' && <Chip tone="warning" icon="warning">{t('receipt.verify.invalid')}</Chip>}
              </div>
            </Card>
          )}
        </div>
      )}
    </main>
  );
}
