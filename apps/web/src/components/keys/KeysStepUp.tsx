'use client';

// ============================================================
// «Сильное подтверждение» управления ключами (решение грилла №8): пароль + SMS-код
// (core/verify, цель keys_manage) → окно 15 минут. Один хук на все действия: страница
// зовёт `withStepUp(() => …)` — если окно открыто, действие идёт сразу; иначе
// открывается диалог, и действие выполняется после подтверждения. Ту же дверь сервер
// требует и по 403 keys.step_up_required — хук ловит его и повторяет действие.
// ============================================================

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KEYS_ERROR_CODES } from '@superapp/shared';
import { apiErrorDetails, apiErrorMessage } from '@/lib/api';
import { confirmKeysStepUp, endKeysStepUp, fetchKeysStepUp } from '@/lib/keys-api';
import { keysStepUpKey } from '@/lib/queries';
import { useOtpFlow } from '@/components/verify/otp-flow';
import { OtpStep } from '@/components/verify/OtpStep';
import { Button, Chip, Input, Modal } from '@/components/ui';
import { useFormatters } from '@/lib/format';

interface StepUpApi {
  until: string | null;
  open: boolean;
  /** Выполнить действие под окном step-up (диалог откроется сам, если окна нет). */
  withStepUp: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  end: () => Promise<void>;
}

const Ctx = createContext<StepUpApi | null>(null);

function isStepUpRequired(err: unknown): boolean {
  return apiErrorDetails(err)?.code === KEYS_ERROR_CODES.stepUpRequired;
}

export function KeysStepUpProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: keysStepUpKey, queryFn: fetchKeysStepUp, staleTime: 30_000 });
  const [open, setOpen] = useState(false);
  const pending = useRef<{ resolve: (ok: boolean) => void } | null>(null);

  const until = status.data?.until && Date.parse(status.data.until) > Date.now() ? status.data.until : null;

  const ask = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      pending.current?.resolve(false);
      pending.current = { resolve };
      setOpen(true);
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    setOpen(false);
    pending.current?.resolve(ok);
    pending.current = null;
  }, []);

  const withStepUp = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      const run = async (): Promise<T | undefined> => {
        try {
          return await action();
        } catch (err) {
          if (!isStepUpRequired(err)) throw err;
          // Окно закрылось между проверкой и действием — спросить и повторить
          void qc.invalidateQueries({ queryKey: keysStepUpKey });
          const ok = await ask();
          if (!ok) return undefined;
          return action();
        }
      };
      if (until) return run();
      const ok = await ask();
      if (!ok) return undefined;
      return run();
    },
    [until, ask, qc],
  );

  const end = useCallback(async () => {
    await endKeysStepUp();
    qc.setQueryData(keysStepUpKey, { until: null });
  }, [qc]);

  const api = useMemo<StepUpApi>(() => ({ until, open, withStepUp, end }), [until, open, withStepUp, end]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <KeysStepUpDialog open={open} onClose={() => close(false)} onConfirmed={(u) => { qc.setQueryData(keysStepUpKey, { until: u }); close(true); }} />
    </Ctx.Provider>
  );
}

export function useKeysStepUp(): StepUpApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useKeysStepUp: wrap the page in <KeysStepUpProvider>');
  return api;
}

/** Чип «Окно подтверждения открыто до HH:MM · Завершить». */
export function StepUpWindowChip() {
  const t = useTranslations('keys');
  const fmt = useFormatters();
  const { until, end } = useKeysStepUp();
  if (!until) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
      <Chip tone="success" icon="shield" size="sm">{t('stepUp.windowUntil', { time: fmt.time(until) })}</Chip>
      <Button size="sm" variant="ghost" onClick={() => void end()}>{t('stepUp.end')}</Button>
    </span>
  );
}

function KeysStepUpDialog({ open, onClose, onConfirmed }: { open: boolean; onClose: () => void; onConfirmed: (until: string) => void }) {
  const t = useTranslations('keys');
  const common = useTranslations('common');
  const flow = useOtpFlow();
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reset = () => {
    flow.reset();
    setStep('password');
    setPassword('');
    setError('');
  };

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      await flow.startStepUp('keys_manage', password);
      setStep('code');
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (code: string) => {
    const verifyToken = await flow.check(code);
    if (!verifyToken) return;
    setBusy(true);
    try {
      const res = await confirmKeysStepUp(verifyToken);
      reset();
      onConfirmed(res.until ?? new Date(Date.now() + 15 * 60_000).toISOString());
    } catch (err) {
      setError(apiErrorMessage(err));
      setStep('password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={() => { if (!busy) { reset(); onClose(); } }} title={t('stepUp.title')} size="sm">
      {step === 'password' && (
        <form onSubmit={requestCode} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          <p className="label-md" style={{ lineHeight: 1.55 }}>{t('stepUp.body')}</p>
          {error && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
          <Input
            label={t('stepUp.password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
          />
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => { reset(); onClose(); }}>{common('actions.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={busy || !password} loading={busy}>{t('stepUp.getCode')}</Button>
          </div>
        </form>
      )}
      {step === 'code' && (
        <OtpStep flow={flow} onSubmit={submitCode} onBack={() => { flow.reset(); setStep('password'); }} backLabel={t('stepUp.back')} title={t('stepUp.confirmTitle')} />
      )}
    </Modal>
  );
}
