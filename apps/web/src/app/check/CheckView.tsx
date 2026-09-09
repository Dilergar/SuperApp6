'use client';

/**
 * Проверка электронной подписи — открытая страница (ст. 61 ЦК РК).
 *
 * ГЛАВНОЕ СВОЙСТВО: проверяемый файл НЕ ПОКИДАЕТ БРАУЗЕР. Отпечаток SHA-256
 * считает Web Crypto прямо здесь, на сервер уходят только 64 символа хэша.
 * Иначе «проверка подписи» означала бы «загрузите нам ваш договор», и
 * пользоваться ею было бы нельзя ровно тем, кому она нужнее всего.
 *
 * Вердикты показываем ЗАМОРОЖЕННЫЕ — какими они были в момент подписания
 * (приказ № 1187): сертификат мог истечь с тех пор, но подпись от этого
 * недействительной не становится.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { SignCheckResultDto } from '@superapp/shared';
import { Alert, Button, Card, Chip, Dropzone, Icon, Spinner } from '@/components/ui';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useFormatters } from '@/lib/format';
import { signCheck } from '@/lib/public-api';

export function CheckView({ actId, token }: { actId?: string; token?: string }) {
  const t = useTranslations('sign');
  const tc = useTranslations('common');
  const f = useFormatters();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SignCheckResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const runByToken = useCallback(async () => {
    if (!actId || !token) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await signCheck({ actId, k: token }));
    } catch {
      setError(t('check.failed'));
    } finally {
      setBusy(false);
    }
  }, [actId, token]);

  useEffect(() => {
    void runByToken();
  }, [runByToken]);

  const checkFile = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setFileName(file.name);
    try {
      // Web Crypto существует только в защищённом контексте (HTTPS или localhost).
      // Без этой проверки на http-стенде страница ловила бы TypeError и говорила
      // «не удалось прочитать файл» — то есть винила бы файл проверяющего в том,
      // что развёрнуто без сертификата.
      if (!globalThis.crypto?.subtle) {
        setError(t('check.needsHttps'));
        return;
      }
      // Отпечаток считается ЗДЕСЬ. Файл никуда не отправляется — это и есть
      // обещание страницы, и нарушать его нельзя ни ради удобства, ни ради
      // «а давайте заодно покажем предпросмотр».
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      setResult(await signCheck({ sha256 }));
    } catch {
      setError(t('check.readFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--spacing-6) var(--spacing-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-2)' }}>
        <Icon name="sealCheck" size={26} />
        <h1 className="title-lg" style={{ margin: 0 }}>{t('check.title')}</h1>
      </div>
      <p className="body-sm" style={{ marginTop: 0, marginBottom: 'var(--spacing-5)' }}>
        {t('check.lead')} <b>{t('check.leadNote')}</b>
      </p>

      {!actId && (
        <Card>
          <Dropzone
            onFiles={checkFile}
            accept="*/*"
            multiple={false}
            icon="sealCheck"
            tone="accent"
            title={t('check.dropTitle')}
            note={t('check.dropNote')}
          />
          {fileName && (
            <p className="body-sm" style={{ marginBottom: 0 }}>
              {t('check.checking')} <b>{fileName}</b>
            </p>
          )}
        </Card>
      )}

      {busy && (
        <div style={{ padding: 'var(--spacing-5)', textAlign: 'center' }}>
          <Spinner />
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      {result && !busy && (
        <div style={{ marginTop: 'var(--spacing-4)' }}>
          {!result.found ? (
            <Alert tone="warning">{t('check.notFound')}</Alert>
          ) : (
            <>
              <Alert tone="success">{t('check.found', { count: result.signatures.length })}</Alert>

              {/* Принесли ШТАМПОВАННУЮ копию: у неё свой отпечаток, а подписи стоят
                  под оригиналом — без объяснения несовпадение хэшей читается как
                  подделка, хотя это самый частый файл в обороте. */}
              {result.matchedBy === 'stamped_copy' && (
                <Alert tone="accent">{t('check.stampedNotice')}</Alert>
              )}

              {result.subject && (
                <Card style={{ marginTop: 'var(--spacing-3)' }}>
                  <b>{result.subject.title}</b>
                  <div className="body-sm">
                    {[result.subject.kindLabel, result.subject.orgLabel].filter(Boolean).join(' · ')}
                  </div>
                  <div className="body-xs" style={{ wordBreak: 'break-all', opacity: 0.7 }}>
                    {result.matchedBy === 'stamped_copy'
                      ? t('check.originalFingerprint', { sha256: result.subject.sha256 })
                      : t('fingerprint', { sha256: result.subject.sha256 })}
                  </div>
                </Card>
              )}

              {result.signatures.map((s) => (
                <Card key={s.actId} style={{ marginTop: 'var(--spacing-3)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                    <b>{s.signerName}</b>
                    <Chip tone={s.level === 'ecp' ? 'accent' : 'neutral'}>{t(`level.${s.level}.short`)}</Chip>
                    {s.chainValid === false && <Chip tone="danger">{t('check.chainBad')}</Chip>}
                    {s.ocspStatus === 'revoked' && <Chip tone="danger">{t('check.revoked')}</Chip>}
                  </div>
                  <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: 'var(--spacing-2) 0 0' }}>
                    <Row label={t('check.rowSignedAt')}>
                      {s.signedAt ? f.dateTime(s.signedAt) : tc('labels.dash')}
                    </Row>
                    <Row label={t('check.rowMethod')}>
                      {s.method ? t(`method.${s.method}.title`) : tc('labels.dash')}
                    </Row>
                    {s.iinMasked && <Row label={t('check.rowIin')}>{s.iinMasked}</Row>}
                    {s.issuerCn && <Row label={t('check.rowIssuer')}>{s.issuerCn}</Row>}
                    {s.certSerial && <Row label={t('check.rowSerial')}>{s.certSerial}</Row>}
                    {s.ocspAt && (
                      <Row label={t('check.rowStatus')}>
                        {s.ocspStatus === 'good'
                          ? t('check.statusGood')
                          : (s.ocspStatus ?? t('protocol.ocspUnchecked'))}
                      </Row>
                    )}
                  </dl>
                  {s.level === 'pep' && (
                    <p className="body-xs" style={{ marginBottom: 0, opacity: 0.8 }}>
                      {t('check.pepNote')}
                    </p>
                  )}
                </Card>
              ))}

              {result.downloads.length > 0 && (
                <Card style={{ marginTop: 'var(--spacing-3)' }}>
                  <b>{t('check.thirdParty')}</b>
                  <p className="body-sm">{t('check.thirdPartyNote')}</p>
                  <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                    {result.downloads.map((d) => (
                      <Button key={`${d.kind}-${d.url}`} variant="outline" size="sm" href={d.url}>
                        {d.label}
                      </Button>
                    ))}
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      )}

      {/*
        Открытая страница проверки подписи: сюда приходит человек ИЗВНЕ, без
        аккаунта, и другого места сменить язык у него нет.
      */}
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--spacing-6)' }}>
        <LanguageSwitcher width={180} />
      </div>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="body-sm" style={{ opacity: 0.7 }}>{label}</dt>
      <dd className="body-sm" style={{ margin: 0 }}>{children}</dd>
    </>
  );
}
