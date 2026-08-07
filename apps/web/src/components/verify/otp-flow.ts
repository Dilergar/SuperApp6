'use client';

/**
 * Хук OTP-потока (движок core/verify): запуск цепочки → таймер ресенда → проверка
 * кода → verifyToken. Один хук кормит регистрацию, сброс пароля и step-up модалки
 * профиля (смена пароля/номера).
 *
 * Resume живой цепочки. Сервер на 429 отдаёт только «через сколько можно ещё раз» —
 * id цепочки НЕ отдаёт (иначе всякий, кто знает чужой номер, получал бы id живой
 * цепочки и мог сжечь её пятью неверными вводами). Поэтому id своей цепочки помнит
 * КЛИЕНТ: кладём его в sessionStorage при старте и подхватываем на 429 — двойной клик
 * и F5 посреди шага кода продолжают ту же цепочку, как и раньше.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { apiErrorDetails, apiErrorMessage, apiGet, apiPost } from '@/lib/api';
import {
  VERIFY_ERROR_CODES,
  maskPhone,
  type VerifyErrorCode,
  type VerifyErrorDetails,
  type VerifyPurpose,
  type VerifyStartResponse,
  type VerifyCheckResponse,
} from '@superapp/shared';

interface OtpState {
  challengeId: string | null;
  phoneMasked: string;
  resendLeft: number; // секунд до следующей отправки (тикает вниз)
  code: string;
  busy: boolean;
  error: string;
  /** Машинный код последней ошибки — ветвиться по нему, а не по тексту. */
  errorCode: VerifyErrorCode | null;
  attemptsLeft: number | null;
  /** dev-подсказка кода (API отдаёт только в NODE_ENV=development/test). */
  devCode: string | null;
}

const initial: OtpState = {
  challengeId: null,
  phoneMasked: '',
  resendLeft: 0,
  code: '',
  busy: false,
  error: '',
  errorCode: null,
  attemptsLeft: null,
  devCode: null,
};

/** Цепочка живёт 10 минут — держим запись ровно столько же. */
const RESUME_TTL_MS = 10 * 60_000;

interface ResumeEntry {
  challengeId: string;
  phoneMasked: string;
  at: number;
}

function resumeKey(purpose: string, phone?: string) {
  return `sa6_otp:${purpose}:${phone ?? 'self'}`;
}

function rememberChain(purpose: string, phone: string | undefined, entry: Omit<ResumeEntry, 'at'>) {
  try {
    sessionStorage.setItem(resumeKey(purpose, phone), JSON.stringify({ ...entry, at: Date.now() }));
  } catch {
    /* приватный режим / переполнение — resume просто не сработает */
  }
}

function recallChain(purpose: string, phone?: string): ResumeEntry | null {
  try {
    const raw = sessionStorage.getItem(resumeKey(purpose, phone));
    if (!raw) return null;
    const entry = JSON.parse(raw) as ResumeEntry;
    if (!entry?.challengeId || Date.now() - entry.at > RESUME_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

// Конверт разбирает общий apiErrorDetails транспорта — здесь только сужение до
// формы деталей core/verify (второй разбор конверта был копией и мог разъехаться).
function errorDetails(err: unknown): VerifyErrorDetails | undefined {
  return apiErrorDetails(err) as VerifyErrorDetails | undefined;
}

export function useOtpFlow() {
  const [s, setS] = useState<OtpState>(initial);
  const lastStart = useRef<{ path: string; body: Record<string, unknown> } | null>(null);

  // Тикающий таймер ресенда
  useEffect(() => {
    if (s.resendLeft <= 0) return;
    const t = setInterval(() => setS((p) => ({ ...p, resendLeft: Math.max(0, p.resendLeft - 1) })), 1000);
    return () => clearInterval(t);
  }, [s.resendLeft > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchDevCode = useCallback(async (challengeId: string) => {
    try {
      const { code } = await apiGet<{ code: string | null }>('/verify/dev/last-code', {
        params: { challengeId },
      });
      if (code) setS((p) => (p.challengeId === challengeId ? { ...p, devCode: code } : p));
    } catch {
      /* production — ручки нет, подсказки нет */
    }
  }, []);

  const runStart = useCallback(
    async (path: string, body: Record<string, unknown>): Promise<boolean> => {
      lastStart.current = { path, body };
      const purpose = String(body.purpose);
      const phone = (body.newPhone ?? body.phone) as string | undefined;
      setS((p) => ({ ...p, busy: true, error: '', errorCode: null, code: '', attemptsLeft: null, devCode: null }));
      try {
        const r = await apiPost<VerifyStartResponse>(path, body);
        rememberChain(purpose, phone, { challengeId: r.challengeId, phoneMasked: r.phoneMasked });
        setS({ ...initial, challengeId: r.challengeId, phoneMasked: r.phoneMasked, resendLeft: r.resendInSec });
        void fetchDevCode(r.challengeId);
        return true;
      } catch (err) {
        // Живая цепочка (двойной клик / F5) → продолжаем СВОЮ, запомненную локально.
        if (isAxiosError(err) && err.response?.status === 429) {
          const details = errorDetails(err);
          const saved = recallChain(purpose, phone);
          if (saved) {
            setS({
              ...initial,
              challengeId: saved.challengeId,
              // Маску берём из запомненного ответа сервера, а если её нет — считаем
              // сами: показывать сырой номер вместо маски на этом шаге некрасиво.
              phoneMasked: saved.phoneMasked || (phone ? maskPhone(phone) : ''),
              resendLeft: details?.resendInSec ?? 60,
            });
            void fetchDevCode(saved.challengeId);
            return true;
          }
        }
        setS((p) => ({ ...p, busy: false, error: apiErrorMessage(err), errorCode: errorDetails(err)?.code ?? null }));
        throw err;
      }
    },
    [fetchDevCode],
  );

  /** Запуск для анонимных целей (register | password_reset). */
  const startPublic = useCallback(
    (phone: string, purpose: Extract<VerifyPurpose, 'register' | 'password_reset'>) =>
      runStart('/verify/start', { phone, purpose }),
    [runStart],
  );

  /**
   * Запуск step-up для залогиненных (смена пароля/номера). Пароль обязателен: сервер
   * проверяет его ДО отправки SMS — «неверный пароль» больше не всплывает после
   * сожжённого кода.
   */
  const startStepUp = useCallback(
    (
      purpose: Extract<VerifyPurpose, 'password_change' | 'phone_change_old' | 'phone_change_new'>,
      password: string,
      newPhone?: string,
    ) => runStart('/verify/step-up', newPhone ? { purpose, password, newPhone } : { purpose, password }),
    [runStart],
  );

  /** Повторная отправка = тот же start (сервер сам решает, ресенд это или отказ). */
  const resend = useCallback(async () => {
    if (!lastStart.current) return;
    try {
      await runStart(lastStart.current.path, lastStart.current.body);
    } catch {
      /* сообщение уже в state.error */
    }
  }, [runStart]);

  /** Проверка кода → verifyToken (null, если код не подошёл — ошибка уже в state). */
  const check = useCallback(
    async (code: string): Promise<string | null> => {
      if (!s.challengeId) return null;
      setS((p) => ({ ...p, busy: true, error: '', errorCode: null }));
      try {
        const r = await apiPost<VerifyCheckResponse>('/verify/check', {
          challengeId: s.challengeId,
          code,
        });
        setS((p) => ({ ...p, busy: false }));
        return r.verifyToken;
      } catch (err) {
        const details = errorDetails(err);
        setS((p) => ({
          ...p,
          busy: false,
          code: '',
          error: apiErrorMessage(err),
          errorCode: details?.code ?? null,
          attemptsLeft: details?.attemptsLeft ?? p.attemptsLeft,
        }));
        return null;
      }
    },
    [s.challengeId],
  );

  const setCode = useCallback((code: string) => setS((p) => ({ ...p, code, error: '', errorCode: null })), []);
  const reset = useCallback(() => {
    lastStart.current = null;
    setS(initial);
  }, []);

  return { ...s, startPublic, startStepUp, resend, check, setCode, reset };
}

export type OtpFlow = ReturnType<typeof useOtpFlow>;

/** Пропуск истёк/потрачен — предложить получить новый код (машинный код, не текст). */
export function isTokenStale(err: unknown): boolean {
  return errorDetails(err)?.code === VERIFY_ERROR_CODES.tokenStale;
}
