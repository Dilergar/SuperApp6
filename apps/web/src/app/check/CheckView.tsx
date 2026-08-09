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
import {
  SIGN_LEVEL_LABELS,
  SIGN_METHOD_LABELS,
  type SignCheckResultDto,
} from '@superapp/shared';
import { Alert, Button, Card, Chip, Dropzone, Icon, Spinner } from '@/components/ui';
import { signCheck } from '@/lib/public-api';

export function CheckView({ actId, token }: { actId?: string; token?: string }) {
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
      setError('Не удалось проверить подпись. Попробуйте позже.');
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
        setError(
          'Проверка возможна только на защищённом соединении (https). Откройте страницу по https-адресу.',
        );
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
      setError('Не удалось прочитать файл или связаться с сервисом проверки.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--spacing-6) var(--spacing-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-2)' }}>
        <Icon name="sealCheck" size={26} />
        <h1 className="title-lg" style={{ margin: 0 }}>Проверка электронной подписи</h1>
      </div>
      <p className="body-sm" style={{ marginTop: 0, marginBottom: 'var(--spacing-5)' }}>
        Загрузите подписанный документ — браузер посчитает его отпечаток и найдёт подписи.
        <b> Сам файл на сервер не отправляется.</b>
      </p>

      {!actId && (
        <Card>
          <Dropzone
            onFiles={checkFile}
            accept="*/*"
            multiple={false}
            icon="sealCheck"
            tone="accent"
            title="Перетащите подписанный документ или выберите файл"
            note="ФАЙЛ ОСТАЁТСЯ В БРАУЗЕРЕ — НА СЕРВЕР УХОДИТ ТОЛЬКО ОТПЕЧАТОК"
          />
          {fileName && (
            <p className="body-sm" style={{ marginBottom: 0 }}>
              Проверяем: <b>{fileName}</b>
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
            <Alert tone="warning">
              Подписи на этот документ не найдены. Возможно, файл изменяли после подписания —
              достаточно одного добавленного пробела, чтобы отпечаток перестал совпадать.
            </Alert>
          ) : (
            <>
              <Alert tone="success">Документ подписан в SuperApp6. Найдено подписей: {result.signatures.length}</Alert>

              {result.subject && (
                <Card style={{ marginTop: 'var(--spacing-3)' }}>
                  <b>{result.subject.title}</b>
                  <div className="body-sm">
                    {[result.subject.kindLabel, result.subject.orgLabel].filter(Boolean).join(' · ')}
                  </div>
                  <div className="body-xs" style={{ wordBreak: 'break-all', opacity: 0.7 }}>
                    Отпечаток: {result.subject.sha256}
                  </div>
                </Card>
              )}

              {result.signatures.map((s) => (
                <Card key={s.actId} style={{ marginTop: 'var(--spacing-3)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                    <b>{s.signerName}</b>
                    <Chip tone={s.level === 'ecp' ? 'accent' : 'neutral'}>{SIGN_LEVEL_LABELS[s.level].short}</Chip>
                    {s.chainValid === false && <Chip tone="danger">Цепочка не подтверждена</Chip>}
                    {s.ocspStatus === 'revoked' && <Chip tone="danger">Сертификат был отозван</Chip>}
                  </div>
                  <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: 'var(--spacing-2) 0 0' }}>
                    <Row label="Подписано">
                      {s.signedAt ? new Date(s.signedAt).toLocaleString('ru-RU') : '—'}
                    </Row>
                    <Row label="Способ">{s.method ? SIGN_METHOD_LABELS[s.method].title : '—'}</Row>
                    {s.iinMasked && <Row label="ИИН">{s.iinMasked}</Row>}
                    {s.issuerCn && <Row label="Издатель сертификата">{s.issuerCn}</Row>}
                    {s.certSerial && <Row label="Серийный номер">{s.certSerial}</Row>}
                    {s.ocspAt && (
                      <Row label="Статус на момент подписания">
                        {s.ocspStatus === 'good' ? 'действителен' : (s.ocspStatus ?? 'не проверялся')}
                      </Row>
                    )}
                  </dl>
                  {s.level === 'pep' && (
                    <p className="body-xs" style={{ marginBottom: 0, opacity: 0.8 }}>
                      Простая электронная подпись: личность подтверждена входом в систему и кодом из SMS,
                      целостность документа обеспечивает информационная система (ст. 46–47 Цифрового кодекса РК).
                    </p>
                  )}
                </Card>
              ))}

              {result.downloads.length > 0 && (
                <Card style={{ marginTop: 'var(--spacing-3)' }}>
                  <b>Для сторонней проверки</b>
                  <p className="body-sm">
                    Контейнеры подписи и квитанции можно проверить независимо — например, на портале eGov.
                  </p>
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
