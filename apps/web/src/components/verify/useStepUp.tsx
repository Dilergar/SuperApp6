'use client';

// ============================================================
// Окно «сильного подтверждения» по ЦЕЛИ (core/verify/step-up): пароль + код из SMS → окно
// 15 минут. Один хук на все цели (ключи, раскрытие строгих полей, правила видимости):
// `withStepUp(() => …)` — окно открыто → действие сразу; иначе диалог, потом действие; тот
// же 403 `<цель>.step_up_required` от сервера хук ловит сам и повторяет действие.
// Хук возвращает `dialog` — страница рисует его один раз.
// ============================================================

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { STEP_UP_REQUIRED_CODES, STEP_UP_WINDOW_MINUTES, type StepUpWindowPurpose } from '@superapp/shared';
import { apiErrorDetails } from '@/lib/api';
import { confirmStepUp, endStepUp, fetchStepUp } from '@/lib/visibility-api';
import { visibilityStepUpKey } from '@/lib/queries';
import { StepUpDialog } from './StepUpDialog';

export interface StepUpTexts {
  title?: string;
  body?: ReactNode;
  codeTitle?: string;
}

export interface StepUpApi {
  until: string | null;
  /** Выполнить действие под окном цели (диалог откроется сам, если окна нет). */
  withStepUp: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  /** Действие сразу; диалог — только по отказу сервера «нужно подтверждение». */
  withStepUpOnDemand: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  end: () => Promise<void>;
  dialog: ReactNode;
}

export function isStepUpRequired(err: unknown, purpose: StepUpWindowPurpose): boolean {
  return apiErrorDetails(err)?.code === STEP_UP_REQUIRED_CODES[purpose];
}

export function useStepUp(purpose: StepUpWindowPurpose, texts: StepUpTexts = {}): StepUpApi {
  const qc = useQueryClient();
  const key = visibilityStepUpKey(purpose);
  const status = useQuery({ queryKey: key, queryFn: () => fetchStepUp(purpose), staleTime: 30_000 });
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
          if (!isStepUpRequired(err, purpose)) throw err;
          // Окно закрылось между проверкой и действием — спросить и повторить
          void qc.invalidateQueries({ queryKey: key });
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
    [until, ask, qc, key, purpose],
  );

  /** Сначала действие; диалог — только если сервер ответил «нужно подтверждение» (цель задана полем). */
  const withStepUpOnDemand = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action();
      } catch (err) {
        if (!isStepUpRequired(err, purpose)) throw err;
        void qc.invalidateQueries({ queryKey: key });
        const ok = await ask();
        if (!ok) return undefined;
        return action();
      }
    },
    [ask, qc, key, purpose],
  );

  const end = useCallback(async () => {
    await endStepUp(purpose);
    qc.setQueryData(key, { until: null });
  }, [qc, key, purpose]);

  const dialog = (
    <StepUpDialog
      open={open}
      purpose={purpose}
      onClose={() => close(false)}
      title={texts.title}
      body={texts.body}
      codeTitle={texts.codeTitle}
      onVerified={async (verifyToken) => {
        const res = await confirmStepUp(purpose, verifyToken);
        qc.setQueryData(key, { until: res.until ?? new Date(Date.now() + STEP_UP_WINDOW_MINUTES[purpose] * 60_000).toISOString() });
        close(true);
      }}
    />
  );

  return useMemo(() => ({ until, withStepUp, withStepUpOnDemand, end, dialog }), [until, withStepUp, withStepUpOnDemand, end, dialog]);
}
