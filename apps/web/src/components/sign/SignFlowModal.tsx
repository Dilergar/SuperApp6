'use client';

/**
 * Окно подписания — единственное место, где человек ставит электронную подпись.
 *
 * Три способа (что доступно, решает заявка и окружение):
 *   · ЭЦП через eGov Mobile — QR, ключ в облаке НУЦ;
 *   · ЭЦП через NCALayer — ключ на компьютере человека, CMS собирается в браузере;
 *   · Простая подпись — соглашение сторон + код из SMS ПОД ЭТОТ документ.
 *
 * Что показывается ВСЕГДА и не прячется: какой именно уровень подписи ставится
 * и под каким отпечатком документа. ПЭП ≠ ЭЦП, и путать их в интерфейсе нельзя —
 * ст. 47 п. 4 ЦК РК прямо требует, чтобы человек понимал, чем подписан документ.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SIGN_LEVEL_LABELS,
  SIGN_METHOD_LABELS,
  type SignFlowDto,
  type SignMethod,
} from '@superapp/shared';
import { Alert, Button, Checkbox, Icon, Modal, Spinner, Textarea, type IconName } from '@/components/ui';
import { CodeInput } from '@/components/verify/CodeInput';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import {
  confirmPep,
  declineSign,
  fetchActState,
  fetchDevCode,
  fetchSignFlow,
  signFlowKey,
  startPep,
  startQr,
  submitCms,
} from './sign-api';
import { NcaLayerError, signWithNcaLayer } from './ncalayer';

type Screen = 'choose' | 'pep-consent' | 'pep-code' | 'qr' | 'ncalayer' | 'decline' | 'done';

export function SignFlowModal({
  requestId,
  onClose,
  onSigned,
}: {
  requestId: string;
  onClose: () => void;
  /** Подписано — родитель обновляет свои списки */
  onSigned?: () => void;
}) {
  const qc = useQueryClient();
  const [screen, setScreen] = useState<Screen>('choose');
  const [method, setMethod] = useState<SignMethod | null>(null);
  const [consent, setConsent] = useState(false);
  const [pdConsent, setPdConsent] = useState(false);
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const flowQuery = useQuery({
    queryKey: signFlowKey(requestId),
    queryFn: () => fetchSignFlow(requestId),
  });
  const flow = flowQuery.data;
  const actId = flow?.myAct?.id ?? null;

  const finish = () => {
    setScreen('done');
    qc.invalidateQueries({ queryKey: signFlowKey(requestId) });
    onSigned?.();
  };

  // ---- ПЭП ----
  const pepStart = useMutation({
    mutationFn: () => startPep(actId!, flow?.pdConsentText ? pdConsent : undefined),
    onSuccess: async (res) => {
      setChallengeId(res.challengeId);
      setScreen('pep-code');
      setError(null);
      // Подсказка кода живёт только в development (ручка есть лишь там).
      const dev = await fetchDevCode(res.challengeId).catch(() => ({ code: null }));
      setDevCode(dev.code);
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const pepConfirm = useMutation({
    mutationFn: (value: string) => confirmPep(actId!, challengeId!, value),
    onSuccess: finish,
    onError: (e) => {
      setError(apiErrorMessage(e));
      setCode('');
    },
  });

  // ---- ЭЦП через NCALayer ----
  const nca = useMutation({
    mutationFn: async () => {
      if (!flow) throw new Error('Документ не загружен');
      // Байты берём по подписанной ссылке движка файлов: подписывать нужно ровно
      // ту копию, которую человек видит на экране, а не «документ вообще».
      const res = await fetch(flow.subject.url);
      if (!res.ok) throw new Error('Не удалось прочитать документ для подписи');
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      const cms = await signWithNcaLayer({ dataBase64: btoa(binary) });
      return submitCms(actId!, cms);
    },
    onSuccess: finish,
    onError: (e) => {
      if (e instanceof NcaLayerError && e.cancelled) {
        setScreen('choose');
        return;
      }
      setError(e instanceof NcaLayerError ? e.message : apiErrorMessage(e));
    },
  });

  // ---- ЭЦП через eGov Mobile ----
  const qr = useMutation({
    mutationFn: () => startQr(actId!),
    onSuccess: () => {
      setScreen('qr');
      setError(null);
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  // Пока открыт QR — спрашиваем сервер, подписали ли уже: телефон нам не сообщит.
  const polling = screen === 'qr' && !!actId;
  const state = useQuery({
    queryKey: ['sign', 'act', actId, 'poll'],
    queryFn: () => fetchActState(actId!),
    enabled: polling,
    refetchInterval: polling ? (qr.data?.pollMs ?? 2000) : false,
  });
  const signedRef = useRef(false);
  useEffect(() => {
    if (state.data?.status === 'signed' && !signedRef.current) {
      signedRef.current = true;
      finish();
    }
    if (state.data?.status === 'failed' && state.data.errorCode) {
      setError('Подпись не принята. Проверьте, что подписывали именно этот документ своим ключом');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data?.status]);

  const decline = useMutation({
    mutationFn: () => declineSign(actId!, reason.trim()),
    onSuccess: () => {
      setScreen('done');
      qc.invalidateQueries({ queryKey: signFlowKey(requestId) });
      onSigned?.();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const busy =
    pepStart.isPending || pepConfirm.isPending || nca.isPending || qr.isPending || decline.isPending;

  return (
    <Modal open onClose={onClose} title="Подписание документа" size="md">
      {flowQuery.isPending && <Spinner />}
      {flowQuery.isError && <Alert tone="danger">{apiErrorMessage(flowQuery.error)}</Alert>}

      {flow && (
        <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
          <SubjectHeader flow={flow} />

          {error && <Alert tone="danger">{error}</Alert>}

          {screen === 'choose' && (
            <ChooseMethod
              flow={flow}
              busy={busy}
              onPick={(m) => {
                setMethod(m);
                setError(null);
                if (m === 'pep_otp') setScreen('pep-consent');
                if (m === 'ncalayer') {
                  setScreen('ncalayer');
                  nca.mutate();
                }
                if (m === 'qr') qr.mutate();
              }}
              onDecline={() => setScreen('decline')}
            />
          )}

          {screen === 'pep-consent' && (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
              <ConsentBox text={flow.consentText ?? ''} />
              <Checkbox
                checked={consent}
                onChange={setConsent}
                label="Я прочитал(а) документ и согласен(на) подписать его простой электронной подписью"
              />
              {flow.pdConsentText && (
                <>
                  <ConsentBox text={flow.pdConsentText} />
                  <Checkbox
                    checked={pdConsent}
                    onChange={setPdConsent}
                    label="Согласен(на) на обработку персональных данных"
                  />
                </>
              )}
              <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
                <Button
                  onClick={() => pepStart.mutate()}
                  disabled={!consent || (!!flow.pdConsentText && !pdConsent) || busy}
                  loading={pepStart.isPending}
                >
                  Получить код
                </Button>
                <Button variant="ghost" onClick={() => setScreen('choose')} disabled={busy}>
                  Назад
                </Button>
              </div>
            </div>
          )}

          {screen === 'pep-code' && (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
              <p className="body-sm" style={{ margin: 0 }}>
                Код отправлен на ваш подтверждённый номер. Ввод кода = подпись документа.
              </p>
              <CodeInput
                value={code}
                onChange={setCode}
                onComplete={(v) => pepConfirm.mutate(v)}
                error={!!error}
                disabled={pepConfirm.isPending}
              />
              {devCode && (
                <Alert tone="accent">
                  [dev] код: <b>{devCode}</b>
                </Alert>
              )}
              <Button variant="ghost" onClick={() => setScreen('pep-consent')} disabled={busy}>
                Назад
              </Button>
            </div>
          )}

          {screen === 'ncalayer' && (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)', justifyItems: 'center' }}>
              <Spinner />
              <p className="body-sm" style={{ margin: 0, textAlign: 'center' }}>
                Откройте окно NCALayer и выберите свой ключ подписи.
                <br />
                Пароль от ключа вводится только там — мы его не видим и не спрашиваем.
              </p>
              <Button variant="ghost" onClick={() => setScreen('choose')}>
                Отмена
              </Button>
            </div>
          )}

          {screen === 'qr' && qr.data && (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)', justifyItems: 'center' }}>
              {/* QR рисует сервер (data-URL) — генератор в браузерный бандл не тащим */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qr.data.qrDataUrl}
                alt="QR-код для подписания в eGov Mobile"
                style={{ width: 220, height: 220, background: '#fff', borderRadius: 12, padding: 8 }}
              />
              <p className="body-sm" style={{ margin: 0, textAlign: 'center' }}>
                Отсканируйте код в приложении <b>eGov Mobile</b> и подтвердите подпись.
              </p>
              {qr.data.mock && (
                <Alert tone="warning">
                  Мост eGov Mobile ещё не подключён — код работает только в тестовом режиме.
                </Alert>
              )}
              <Button variant="ghost" onClick={() => setScreen('choose')}>
                Другой способ
              </Button>
            </div>
          )}

          {screen === 'decline' && (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
              <Textarea
                label="Причина отказа"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Например: неверная сумма в пункте 3"
                rows={3}
              />
              <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
                <Button
                  variant="matte"
                  tone="danger"
                  onClick={() => decline.mutate()}
                  disabled={reason.trim().length < 3 || busy}
                  loading={decline.isPending}
                >
                  Отказаться от подписи
                </Button>
                <Button variant="ghost" onClick={() => setScreen('choose')} disabled={busy}>
                  Назад
                </Button>
              </div>
            </div>
          )}

          {screen === 'done' && (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)', justifyItems: 'center' }}>
              <Icon name="sealCheck" size={48} />
              <p className="title-sm" style={{ margin: 0 }}>Готово</p>
              <Button onClick={onClose}>Закрыть</Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Шапка: что подписываем, каким уровнем и под каким отпечатком */
function SubjectHeader({ flow }: { flow: SignFlowDto }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--spacing-1)',
        padding: 'var(--spacing-3)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-panel)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
        <Icon name="signature" size={18} />
        <b>{flow.request.refTitle}</b>
      </div>
      <div className="body-sm">{SIGN_LEVEL_LABELS[flow.request.level].full}</div>
      <a href={flow.subject.url} target="_blank" rel="noreferrer" className="body-sm">
        Открыть документ ({formatSize(flow.subject.size)})
      </a>
      <div className="body-xs" style={{ wordBreak: 'break-all', opacity: 0.7 }}>
        Отпечаток SHA-256: {flow.subject.sha256}
      </div>
    </div>
  );
}

function ChooseMethod({
  flow,
  busy,
  onPick,
  onDecline,
}: {
  flow: SignFlowDto;
  busy: boolean;
  onPick: (m: SignMethod) => void;
  onDecline: () => void;
}) {
  if (!flow.canSign) {
    return (
      <Alert tone="accent">
        {flow.myAct?.status === 'signed'
          ? 'Вы уже подписали этот документ.'
          : 'Подписание по этому документу закрыто.'}
      </Alert>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
      {flow.request.methods.map((m) => (
        <Button
          key={m}
          variant="outline"
          block
          onClick={() => onPick(m)}
          disabled={busy}
          icon={SIGN_METHOD_LABELS[m].icon as IconName}
          style={{ justifyContent: 'flex-start', height: 'auto', paddingBlock: 'var(--spacing-3)' }}
        >
          <span style={{ display: 'grid', textAlign: 'left', gap: 2 }}>
            <b>{SIGN_METHOD_LABELS[m].title}</b>
            <span className="body-xs">{SIGN_METHOD_LABELS[m].hint}</span>
          </span>
        </Button>
      ))}
      <Button variant="ghost" tone="danger" onClick={onDecline} disabled={busy}>
        Отказаться от подписи
      </Button>
    </div>
  );
}

/** Размер документа. Мелкий файл — в байтах: «0 КБ» читается как поломка */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Текст соглашения показывается ЦЕЛИКОМ: он же уходит снимком в акт */
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
