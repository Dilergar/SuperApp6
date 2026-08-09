'use client';

/**
 * ВНЕШНИЙ ПОДПИСАНТ: страница подписания по гостевой ссылке.
 *
 * Отдельный экран, а не переиспользование `SignFlowModal`: у гостя нет аккаунта
 * и нет обычного транспорта — все действия идут через `POST /share-links/guest/
 * :token/actions/*` с гостевым пропуском в заголовке (перехватчик с редиректом
 * на /login здесь недопустим). Логика та же, клиент другой.
 *
 * Порядок шагов не сокращается: сначала читаем документ, потом принимаем
 * соглашение сторон и согласие на обработку ПД, и только потом приходит код.
 */

import { useState } from 'react';
import { SIGN_LEVEL_LABELS, SIGN_METHOD_LABELS, type SignMethod } from '@superapp/shared';
import { Alert, Button, Checkbox, Icon } from '@/components/ui';
import { CodeInput } from '@/components/verify/CodeInput';
import { NcaLayerError, signWithNcaLayer } from '@/components/sign/ncalayer';
import { shareAction, shareVerifyDevCode } from '@/lib/public-api';

/** Что отдаёт резолвер подписи в `session.view` */
export interface ShareSignGuestView {
  kind: 'sign';
  requestId: string;
  title: string;
  status: string;
  level: 'ecp' | 'pep';
  methods: SignMethod[];
  subject: { fileId: string; name: string; mime: string; size: number; sha256: string; url: string };
  signed: { name: string; at: string | null }[];
  consentText: string;
  consentVersion: string;
  pdConsentText: string;
}

type Screen = 'read' | 'consent' | 'code' | 'qr' | 'done' | 'declined';

export function ShareSignView({
  view,
  token,
  session,
  onRefresh,
}: {
  view: ShareSignGuestView;
  token: string;
  session: string;
  onRefresh: () => void;
}) {
  const [screen, setScreen] = useState<Screen>(view.status === 'pending' ? 'read' : 'done');
  const [consent, setConsent] = useState(false);
  const [pdConsent, setPdConsent] = useState(false);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [qrData, setQrData] = useState<{ qrDataUrl: string; mock: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async <T,>(key: string, body?: unknown): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await shareAction<T>(token, session, key, body);
    } catch (e) {
      setError(messageOf(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const startPep = async () => {
    const res = await act<{ challengeId: string }>('sign.pep.start', {
      consentAccepted: true,
      pdConsentAccepted: true,
    });
    if (!res) return;
    setChallengeId(res.challengeId);
    setDevCode(await shareVerifyDevCode(res.challengeId));
    setScreen('code');
  };

  const confirmPep = async (value: string) => {
    const res = await act<{ status: string }>('sign.pep.confirm', { challengeId, code: value });
    if (!res) {
      setCode('');
      return;
    }
    setScreen('done');
    onRefresh();
  };

  const startNca = async () => {
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await (await fetch(view.subject.url)).arrayBuffer());
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      const cms = await signWithNcaLayer({ dataBase64: btoa(binary) });
      const res = await shareAction<{ status: string }>(token, session, 'sign.cms', {
        cms,
        consentAccepted: true,
        pdConsentAccepted: true,
      });
      if (res) {
        setScreen('done');
        onRefresh();
      }
    } catch (e) {
      if (!(e instanceof NcaLayerError && e.cancelled)) setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const startQr = async () => {
    const res = await act<{ qrDataUrl: string; mock: boolean }>('sign.qr.start');
    if (!res) return;
    setQrData(res);
    setScreen('qr');
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
      <div
        style={{
          display: 'grid',
          gap: 4,
          padding: 'var(--spacing-3)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-panel)',
        }}
      >
        <div className="body-sm">{SIGN_LEVEL_LABELS[view.level].full}</div>
        <div className="body-xs" style={{ wordBreak: 'break-all', opacity: 0.7 }}>
          Отпечаток SHA-256: {view.subject.sha256}
        </div>
      </div>

      {/* Документ показываем ЦЕЛИКОМ здесь же: подписывать то, что не открыл, — */}
      {/* именно та практика, из-за которой электронной подписи и не доверяют.   */}
      <iframe
        src={view.subject.url}
        title={view.title}
        style={{ width: '100%', height: '60vh', border: '1px solid var(--border)', borderRadius: 12 }}
      />
      <Button variant="outline" href={view.subject.url} icon="download">
        Скачать документ
      </Button>

      {view.signed.length > 0 && (
        <div className="body-sm">
          Уже подписали: {view.signed.map((s) => s.name).join(', ')}
        </div>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {screen === 'read' && (
        <Button variant="primary" icon="signature" onClick={() => setScreen('consent')}>
          Перейти к подписанию
        </Button>
      )}

      {screen === 'consent' && (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          <ConsentBox text={view.consentText} />
          <Checkbox
            checked={consent}
            onChange={setConsent}
            label="Я прочитал(а) документ и согласен(на) подписать его электронной подписью"
          />
          <ConsentBox text={view.pdConsentText} />
          <Checkbox
            checked={pdConsent}
            onChange={setPdConsent}
            label="Согласен(на) на обработку персональных данных"
          />
          <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
            {view.methods.map((m) => (
              <Button
                key={m}
                variant="outline"
                block
                disabled={!consent || !pdConsent || busy}
                onClick={() => (m === 'pep_otp' ? startPep() : m === 'ncalayer' ? startNca() : startQr())}
                style={{ justifyContent: 'flex-start', height: 'auto', paddingBlock: 'var(--spacing-3)' }}
              >
                <span style={{ display: 'grid', textAlign: 'left', gap: 2 }}>
                  <b>{SIGN_METHOD_LABELS[m].title}</b>
                  <span className="body-xs">{SIGN_METHOD_LABELS[m].hint}</span>
                </span>
              </Button>
            ))}
          </div>
        </div>
      )}

      {screen === 'code' && (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          <p className="body-sm" style={{ margin: 0 }}>
            Код отправлен на подтверждённый вами номер. Ввод кода = подпись документа.
          </p>
          <CodeInput value={code} onChange={setCode} onComplete={confirmPep} error={!!error} disabled={busy} />
          {devCode && (
            <Alert tone="accent">
              [dev] код: <b>{devCode}</b>
            </Alert>
          )}
        </div>
      )}

      {screen === 'qr' && qrData && (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)', justifyItems: 'center' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrData.qrDataUrl}
            alt="QR для подписания в eGov Mobile"
            style={{ width: 220, height: 220, background: '#fff', borderRadius: 12, padding: 8 }}
          />
          <p className="body-sm" style={{ margin: 0, textAlign: 'center' }}>
            Отсканируйте код в приложении <b>eGov Mobile</b>. После подписания обновите страницу.
          </p>
          <Button variant="ghost" onClick={onRefresh}>
            Обновить
          </Button>
        </div>
      )}

      {screen === 'done' && (
        <div style={{ display: 'grid', gap: 'var(--spacing-2)', justifyItems: 'center' }}>
          <Icon name="sealCheck" size={44} />
          <p className="title-sm" style={{ margin: 0 }}>Документ подписан</p>
          <p className="body-sm" style={{ margin: 0, textAlign: 'center' }}>
            Копию с подписями можно запросить у отправителя — она проверяется на странице /check.
          </p>
        </div>
      )}
    </div>
  );
}

function ConsentBox({ text }: { text: string }) {
  return (
    <div
      className="body-sm"
      style={{
        maxHeight: 160,
        overflowY: 'auto',
        padding: 'var(--spacing-3)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-panel)',
        whiteSpace: 'pre-wrap',
      }}
    >
      {text}
    </div>
  );
}

/** Сообщение об ошибке гостевого действия — без раскрытия внутренностей */
function messageOf(err: unknown): string {
  if (err instanceof NcaLayerError) return err.message;
  const response = (err as { response?: { data?: { message?: string } } }).response;
  return response?.data?.message ?? 'Не удалось выполнить действие. Попробуйте ещё раз';
}
