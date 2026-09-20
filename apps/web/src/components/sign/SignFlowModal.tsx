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
import { useLocale, useTranslations } from 'next-intl';
import { SIGN_METHOD_ICONS, type SignFlowDto, type SignMethod } from '@superapp/shared';
import { Alert, Button, Checkbox, Icon, Modal, Spinner, Textarea, type IconName } from '@/components/ui';
import { CodeInput } from '@/components/verify/CodeInput';
import { apiErrorMessage } from '@/lib/api';
import { useBytes } from '@/lib/format';

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

import { apiErrorCode, toastApiError } from '@/lib/api-errors';
import { useIdempotencyKey } from '@/lib/useIdempotencyKey';
import { OutcomeUnknownAlert, SlowRequestNote, useOutcomeUnknown } from '@/components/idempotency/OutcomeUnknownAlert';
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
  const t = useTranslations('sign');
  const tc = useTranslations('common');
  const locale = useLocale();
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

  // Ключи НАМЕРЕНИЯ необратимых шагов подписания: «подписать ЭТОТ акт по ЭТОЙ
  // цепочке» и «отказаться от ЭТОГО акта с ЭТОЙ причиной». Двойной клик по
  // «Подписать» обязан дать одну подпись, а не две попытки по одному коду.
  const confirmKey = useIdempotencyKey([actId, challengeId]);
  const declineKey = useIdempotencyKey([actId, reason]);
  // «Исход неизвестен» за кнопкой подписи тостом не показывают: акт МОГ быть
  // подписан, и подталкивать к повтору здесь — худшее, что может сделать экран.
  const outcome = useOutcomeUnknown();

  const finish = () => {
    setScreen('done');
    qc.invalidateQueries({ queryKey: signFlowKey(requestId) });
    onSigned?.();
  };

  /**
   * Единая развилка отказов окна. Исходы движка повторов несут СВОЙ тон: «уже
   * выполнено» — это про состояние мира (акт подписан), а не про ошибку формы, и
   * красная строка под кнопкой соврала бы. Плюс перечитываем заявку: экран мог
   * остаться со старым состоянием.
   */
  const onFail = (e: unknown, fallback?: (e: unknown) => void) => {
    if (outcome.capture(e)) return;
    if (apiErrorCode(e)?.startsWith('idempotency.')) {
      toastApiError(e);
      void qc.invalidateQueries({ queryKey: signFlowKey(requestId) });
      return;
    }
    (fallback ?? ((err: unknown) => setError(apiErrorMessage(err))))(e);
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
    mutationFn: (value: string) => confirmPep(actId!, challengeId!, value, confirmKey.key),
    onSuccess: () => {
      confirmKey.reset();
      finish();
    },
    onError: (e) =>
      onFail(e, (err) => {
        setError(apiErrorMessage(err));
        setCode('');
      }),
  });

  // ---- ЭЦП через NCALayer ----
  const nca = useMutation({
    mutationFn: async () => {
      if (!flow) throw new Error(t('flow.notLoaded'));
      // Байты берём по подписанной ссылке движка файлов: подписывать нужно ровно
      // ту копию, которую человек видит на экране, а не «документ вообще».
      const res = await fetch(flow.subject.url);
      if (!res.ok) throw new Error(t('flow.unreadable'));
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      const cms = await signWithNcaLayer({ dataBase64: btoa(binary), locale });
      return submitCms(actId!, cms);
    },
    onSuccess: finish,
    onError: (e) => {
      if (e instanceof NcaLayerError && e.cancelled) {
        setScreen('choose');
        return;
      }
      onFail(e, (err) => setError(err instanceof NcaLayerError ? t(err.key) : apiErrorMessage(err)));
    },
  });

  // ---- ЭЦП через eGov Mobile ----
  const qr = useMutation({
    mutationFn: () => startQr(actId!),
    onSuccess: () => {
      setScreen('qr');
      setError(null);
    },
    onError: (e) => onFail(e),
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
      setError(t('flow.rejected'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data?.status]);

  const decline = useMutation({
    mutationFn: () => declineSign(actId!, reason.trim(), declineKey.key),
    onSuccess: () => {
      declineKey.reset();
      setScreen('done');
      qc.invalidateQueries({ queryKey: signFlowKey(requestId) });
      onSigned?.();
    },
    onError: (e) => onFail(e, (err) => toastApiError(err)),
  });

  const busy =
    pepStart.isPending || pepConfirm.isPending || nca.isPending || qr.isPending || decline.isPending;

  return (
    <Modal open onClose={onClose} title={t('flow.title')} size="md">
      {flowQuery.isPending && <Spinner />}
      {flowQuery.isError && <Alert tone="danger">{apiErrorMessage(flowQuery.error)}</Alert>}

      {flow && (
        <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
          <SubjectHeader flow={flow} />

          {/* Проверить, прошло ли, можно ровно здесь: экран выбора способа сам
              скажет «уже подписано», если подпись всё-таки легла. */}
          <OutcomeUnknownAlert
            error={outcome.error}
            onOpenHistory={() => {
              void qc.invalidateQueries({ queryKey: signFlowKey(requestId) });
              outcome.clear();
              setScreen('choose');
            }}
            onDismiss={outcome.clear}
          />

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
              <Checkbox checked={consent} onChange={setConsent} label={t('flow.consentPep')} />
              {flow.pdConsentText && (
                <>
                  <ConsentBox text={flow.pdConsentText} />
                  <Checkbox checked={pdConsent} onChange={setPdConsent} label={t('flow.consentPd')} />
                </>
              )}
              <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
                <Button
                  onClick={() => pepStart.mutate()}
                  disabled={!consent || (!!flow.pdConsentText && !pdConsent) || busy}
                  loading={pepStart.isPending}
                >
                  {t('flow.getCode')}
                </Button>
                <Button variant="ghost" onClick={() => setScreen('choose')} disabled={busy}>
                  {tc('actions.back')}
                </Button>
              </div>
            </div>
          )}

          {screen === 'pep-code' && (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
              <p className="body-sm" style={{ margin: 0 }}>
                {t('flow.codeSent')}
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
                  {t('flow.devCode')} <b>{devCode}</b>
                </Alert>
              )}
              <SlowRequestNote pending={pepConfirm.isPending} />
              <Button variant="ghost" onClick={() => setScreen('pep-consent')} disabled={busy}>
                {tc('actions.back')}
              </Button>
            </div>
          )}

          {screen === 'ncalayer' && (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)', justifyItems: 'center' }}>
              <Spinner />
              <p className="body-sm" style={{ margin: 0, textAlign: 'center' }}>
                {t('flow.ncaOpen')}
                <br />
                {t('flow.ncaPassword')}
              </p>
              <Button variant="ghost" onClick={() => setScreen('choose')}>
                {tc('actions.cancel')}
              </Button>
            </div>
          )}

          {screen === 'qr' && qr.data && (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)', justifyItems: 'center' }}>
              {/* QR рисует сервер (data-URL) — генератор в браузерный бандл не тащим */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qr.data.qrDataUrl}
                alt={t('flow.qrAlt')}
                style={{ width: 220, height: 220, background: '#fff', borderRadius: 12, padding: 8 }}
              />
              <p className="body-sm" style={{ margin: 0, textAlign: 'center' }}>
                {t('flow.qrHint')}
              </p>
              {qr.data.mock && <Alert tone="warning">{t('flow.qrMock')}</Alert>}
              <Button variant="ghost" onClick={() => setScreen('choose')}>
                {t('flow.otherMethod')}
              </Button>
            </div>
          )}

          {screen === 'decline' && (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
              <Textarea
                label={t('flow.declineReason')}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('flow.declinePlaceholder')}
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
                  {t('flow.decline')}
                </Button>
                <Button variant="ghost" onClick={() => setScreen('choose')} disabled={busy}>
                  {tc('actions.back')}
                </Button>
                <SlowRequestNote pending={decline.isPending} />
              </div>
            </div>
          )}

          {screen === 'done' && (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)', justifyItems: 'center' }}>
              <Icon name="sealCheck" size={48} />
              <p className="title-sm" style={{ margin: 0 }}>
                {tc('actions.done')}
              </p>
              <Button onClick={onClose}>{tc('actions.close')}</Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Шапка: что подписываем, каким уровнем и под каким отпечатком */
function SubjectHeader({ flow }: { flow: SignFlowDto }) {
  const t = useTranslations('sign');
  const bytes = useBytes();
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
      <div className="body-sm">{t(`level.${flow.request.level}.full`)}</div>
      <a href={flow.subject.url} target="_blank" rel="noreferrer" className="body-sm">
        {t('flow.openDocument', { size: bytes(flow.subject.size) })}
      </a>
      <div className="body-xs" style={{ wordBreak: 'break-all', opacity: 0.7 }}>
        {t('fingerprint', { sha256: flow.subject.sha256 })}
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
  const t = useTranslations('sign');
  if (!flow.canSign) {
    return (
      <Alert tone="accent">
        {flow.myAct?.status === 'signed' ? t('flow.alreadySigned') : t('flow.closed')}
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
          icon={SIGN_METHOD_ICONS[m] as IconName}
          style={{ justifyContent: 'flex-start', height: 'auto', paddingBlock: 'var(--spacing-3)' }}
        >
          <span style={{ display: 'grid', textAlign: 'left', gap: 2 }}>
            <b>{t(`method.${m}.title`)}</b>
            <span className="body-xs">{t(`method.${m}.hint`)}</span>
          </span>
        </Button>
      ))}
      <Button variant="ghost" tone="danger" onClick={onDecline} disabled={busy}>
        {t('flow.decline')}
      </Button>
    </div>
  );
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
