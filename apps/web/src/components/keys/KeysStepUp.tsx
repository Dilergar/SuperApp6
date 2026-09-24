'use client';

// ============================================================
// «Сильное подтверждение» управления ключами (решение грилла №8): пароль + SMS-код
// (core/verify, цель keys_manage) → окно 15 минут. Один хук на все действия: страница
// зовёт `withStepUp(() => …)` — если окно открыто, действие идёт сразу; иначе
// открывается диалог, и действие выполняется после подтверждения. Ту же дверь сервер
// требует и по 403 keys.step_up_required — хук ловит его и повторяет действие.
// ============================================================

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useStepUp } from '@/components/verify/useStepUp';
import { Button, Chip } from '@/components/ui';
import { useFormatters } from '@/lib/format';

interface StepUpApi {
  until: string | null;
  open: boolean;
  /** Выполнить действие под окном step-up (диалог откроется сам, если окна нет). */
  withStepUp: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  end: () => Promise<void>;
}

const Ctx = createContext<StepUpApi | null>(null);

/** Ключи — первый потребитель общего окна `useStepUp` (цель `keys_manage`). */
export function KeysStepUpProvider({ children }: { children: ReactNode }) {
  const t = useTranslations('keys');
  const step = useStepUp('keys_manage', { title: t('stepUp.title'), body: t('stepUp.body'), codeTitle: t('stepUp.confirmTitle') });
  const api = useMemo<StepUpApi>(() => ({ until: step.until, open: false, withStepUp: step.withStepUp, end: step.end }), [step.until, step.withStepUp, step.end]);
  return (
    <Ctx.Provider value={api}>
      {children}
      {step.dialog}
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
