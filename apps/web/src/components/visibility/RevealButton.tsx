'use client';

// ============================================================
// Раскрытие маски ОДНОЙ записи (core/visibility, break-glass). Правила размещения (§5.10 C):
// кнопка «Показать» — ТОЛЬКО в карточке одной записи, в списках и на сетках её нет.
//
// `RevealScope` — область карточки: держит раскрытые значения (в памяти вкладки, не в кэше
// React Query — раскрытое никуда не копируется) и окно SMS-подтверждения. Строгие поля
// (ИИН, удостоверение, адрес, IBAN) сервер раскрывает только при открытом окне — диалог
// появляется по его отказу, а не заранее. Через `showUntil` значение снова становится маской.
// ============================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { isMasked, type Guarded } from '@superapp/shared';
import { Chip, GuardedValue, IconButton } from '@/components/ui';
import { useStepUp } from '@/components/verify/useStepUp';
import { revealFields } from '@/lib/visibility-api';
import { toastApiError } from '@/lib/api-errors';

interface Revealed {
  value: unknown;
  until: number;
}

interface RevealApi {
  get: (recordType: string, recordId: string, field: string) => Revealed | null;
  reveal: (recordType: string, recordId: string, fields: string[]) => Promise<void>;
  busy: boolean;
}

const Ctx = createContext<RevealApi | null>(null);
const keyOf = (t: string, id: string, f: string) => `${t}|${id}|${f}`;

export function RevealScope({ children }: { children: ReactNode }) {
  const t = useTranslations('visibility');
  const step = useStepUp('visibility_reveal', { title: t('reveal.stepUpTitle') });
  const [values, setValues] = useState<Map<string, Revealed>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);

  // Раз в 15 секунд перерисовать: истёкшие значения снова становятся маской
  useEffect(() => {
    if (!values.size) return;
    const id = setInterval(() => {
      const now = Date.now();
      setValues((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [k, v] of prev) if (v.until <= now) {
          next.delete(k);
          changed = true;
        }
        return changed ? next : prev;
      });
      tick((x) => x + 1);
    }, 15_000);
    return () => clearInterval(id);
  }, [values.size]);

  const reveal = useCallback(
    async (recordType: string, recordId: string, fields: string[]) => {
      setBusy(true);
      try {
        const res = await step.withStepUpOnDemand(() => revealFields({ recordType, recordId, fields }));
        if (!res) return;
        const until = Date.parse(res.showUntil);
        setValues((prev) => {
          const next = new Map(prev);
          for (const [f, v] of Object.entries(res.values)) next.set(keyOf(recordType, recordId, f), { value: v, until });
          return next;
        });
      } catch (err) {
        toastApiError(err);
      } finally {
        setBusy(false);
      }
    },
    [step],
  );

  const get = useCallback(
    (recordType: string, recordId: string, field: string) => {
      const v = values.get(keyOf(recordType, recordId, field));
      return v && v.until > Date.now() ? v : null;
    },
    [values],
  );

  const api = useMemo<RevealApi>(() => ({ get, reveal, busy }), [get, reveal, busy]);
  return (
    <Ctx.Provider value={api}>
      {children}
      {step.dialog}
    </Ctx.Provider>
  );
}

export function useReveal(): RevealApi | null {
  return useContext(Ctx);
}

/** Кнопка «Показать» у маски (IconButton `eye`, подпись обязательна). */
export function RevealButton({ recordType, recordId, fields }: { recordType: string; recordId: string; fields: string[] }) {
  const tc = useTranslations('common');
  const scope = useReveal();
  if (!scope) return null;
  return (
    <IconButton
      icon="eye"
      size={28}
      iconSize={16}
      round={false}
      label={tc('guarded.show')}
      disabled={scope.busy}
      onClick={() => void scope.reveal(recordType, recordId, fields)}
    />
  );
}

/**
 * Защищённое значение ОДНОЙ записи: маска + «Показать» (если план зрителя даёт раскрытие),
 * после раскрытия — значение и чип «показано · N мин», по истечении — снова маска.
 */
export function RevealableValue<T>({
  value,
  recordType,
  recordId,
  field,
  render,
  placeholder,
  empty,
}: {
  value: Guarded<T>;
  recordType: string;
  recordId: string;
  field: string;
  render?: (v: T) => ReactNode;
  placeholder?: boolean;
  empty?: ReactNode;
}) {
  const t = useTranslations('visibility');
  const scope = useReveal();
  const revealed = scope?.get(recordType, recordId, field) ?? null;
  if (revealed && isMasked(value)) {
    const min = Math.max(1, Math.ceil((revealed.until - Date.now()) / 60_000));
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
        <span className="tabular-nums">{render ? render(revealed.value as T) : String(revealed.value ?? '')}</span>
        <Chip size="sm" tone="waiting" icon="eye">{t('reveal.shownFor', { min })}</Chip>
      </span>
    );
  }
  return (
    <GuardedValue
      value={value}
      render={render}
      placeholder={placeholder}
      empty={empty}
      maskAction={scope ? <RevealButton recordType={recordType} recordId={recordId} fields={[field]} /> : undefined}
    />
  );
}
