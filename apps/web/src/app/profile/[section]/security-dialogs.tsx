'use client';

import { Input, ModalShell } from '@/components/ui';
/**
 * Диалоги безопасности профиля (движок core/verify):
 *  - Смена пароля: текущий пароль + SMS-код на свой номер (Kaspi-модель step-up);
 *    другие сессии отзываются, текущая живёт.
 *  - Смена номера (строгий v1): пароль + SMS-код на СТАРЫЙ номер + SMS-код на НОВЫЙ.
 *    Старый номер недоступен → смена пока невозможна (честный текст, без мёртвых кнопок).
 *
 * Пароль уходит уже в /verify/step-up: сервер проверяет его ДО отправки SMS. Раньше
 * «неверный текущий пароль» выяснялось после сожжённого кода — человек платил за SMS
 * и начинал сначала.
 */

import { useState } from 'react';
import { normalizePhone } from '@superapp/shared';
import { api, apiErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/lib/stores/auth';
import { useOtpFlow } from '@/components/verify/otp-flow';
import { OtpStep } from '@/components/verify/OtpStep';

function DialogFrame({ children, onClose, busy }: { children: React.ReactNode; onClose: () => void; busy: boolean }) {
  return (
    <ModalShell onClose={() => !busy && onClose()} zIndex={200}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: '460px', width: '100%', padding: 'var(--spacing-6)' }}>
        {children}
      </div>
    </ModalShell>
  );
}

const refreshToken = () => (typeof window === 'undefined' ? undefined : localStorage.getItem('refreshToken') || undefined);

// ============================================================
// Смена пароля
// ============================================================

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const flow = useOtpFlow();
  const [step, setStep] = useState<'form' | 'code' | 'done'>('form');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      // Пароль проверит сервер до отправки кода — неверный вернётся сюда же, без SMS.
      await flow.startStepUp('password_change', currentPassword);
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
    setError('');
    try {
      await api.post('/users/me/change-password', {
        currentPassword,
        newPassword,
        verifyToken,
        currentRefreshToken: refreshToken(),
      });
      setStep('done');
    } catch (err) {
      setError(apiErrorMessage(err));
      setStep('form'); // неверный текущий пароль и т.п. — назад к форме
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogFrame onClose={onClose} busy={busy}>
      {step === 'form' && (
        <form onSubmit={requestCode}>
          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Смена пароля</h3>
          {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 'var(--spacing-3)' }}>{error}</p>}
          <Input
            label="Текущий пароль"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
            wrapClassName="mb-5"
          />
          <Input
            label="Новый пароль"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            placeholder="Минимум 8 символов"
            autoComplete="new-password"
          />
          <p className="label-sm" style={{ marginTop: 'var(--spacing-2)', marginBottom: 'var(--spacing-5)', opacity: 0.7 }}>
            Подтвердим SMS-кодом на ваш номер. Остальные сессии будут завершены
          </p>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
            <button type="button" className="btn-ghost-inline" disabled={busy} style={{ fontSize: '0.85rem' }} onClick={onClose}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={busy || !currentPassword || !newPassword} style={{ fontSize: '0.85rem', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Отправка…' : 'Получить код'}
            </button>
          </div>
        </form>
      )}

      {step === 'code' && (
        <OtpStep
          flow={flow}
          onSubmit={submitCode}
          onBack={() => { flow.reset(); setStep('form'); }}
          backLabel="← назад"
          title="Подтвердите смену пароля"
        />
      )}

      {step === 'done' && (
        <div>
          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Пароль изменён 🔒</h3>
          <p className="label-md" style={{ marginBottom: 'var(--spacing-5)', lineHeight: 1.55 }}>
            Все остальные сессии завершены. Эта — продолжает работать.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn-primary" style={{ fontSize: '0.85rem' }} onClick={onClose}>Готово</button>
          </div>
        </div>
      )}
    </DialogFrame>
  );
}

// ============================================================
// Смена номера
// ============================================================

export function ChangePhoneDialog({ onClose }: { onClose: () => void }) {
  const flow = useOtpFlow();
  const fetchProfile = useAuthStore((s) => s.fetchProfile);
  const [step, setStep] = useState<'form' | 'code_old' | 'code_new' | 'done'>('form');
  const [password, setPassword] = useState('');
  const [newPhone, setNewPhone] = useState('+7');
  const [oldToken, setOldToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /**
   * Шаг «форма». Если старый номер в этой же модалке уже подтверждён (например,
   * новый номер оказался занят и мы вернулись сюда), второй SMS на старый номер не
   * шлём — пропуск живёт 15 минут, сразу запрашиваем код на новый номер.
   */
  const submitForm = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (oldToken) {
        flow.reset();
        await flow.startStepUp('phone_change_new', password, normalizePhone(newPhone));
        setStep('code_new');
      } else {
        await flow.startStepUp('phone_change_old', password);
        setStep('code_old');
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitOldCode = async (code: string) => {
    const token = await flow.check(code);
    if (!token) return;
    setOldToken(token);
    setError('');
    setBusy(true);
    try {
      flow.reset();
      await flow.startStepUp('phone_change_new', password, normalizePhone(newPhone));
      setStep('code_new');
    } catch (err) {
      // Номер занят и т.п. — назад к форме с сообщением (старый пропуск сохранён)
      setError(apiErrorMessage(err));
      setStep('form');
    } finally {
      setBusy(false);
    }
  };

  const submitNewCode = async (code: string) => {
    const newToken = await flow.check(code);
    if (!newToken) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/users/me/change-phone', {
        password,
        newPhone: normalizePhone(newPhone),
        oldVerifyToken: oldToken,
        newVerifyToken: newToken,
        currentRefreshToken: refreshToken(),
      });
      await fetchProfile();
      setStep('done');
    } catch (err) {
      setError(apiErrorMessage(err));
      setStep('form');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogFrame onClose={onClose} busy={busy}>
      {step === 'form' && (
        <form onSubmit={submitForm}>
          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Смена номера</h3>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)', lineHeight: 1.5, opacity: 0.8 }}>
            Подтвердим кодами ОБА номера: сначала текущий, затем новый. Если доступа к текущему
            номеру больше нет — смена пока невозможна.
          </p>
          {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 'var(--spacing-3)' }}>{error}</p>}
          <Input
            label="Пароль"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
            wrapClassName="mb-5"
          />
          <Input
            label="Новый номер"
            type="tel"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
            required
            placeholder="+77001234567"
            autoComplete="tel"
          />
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end', marginTop: 'var(--spacing-5)' }}>
            <button type="button" className="btn-ghost-inline" disabled={busy} style={{ fontSize: '0.85rem' }} onClick={onClose}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={busy || !password} style={{ fontSize: '0.85rem', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Отправка…' : oldToken ? 'Код на новый номер' : 'Код на текущий номер'}
            </button>
          </div>
        </form>
      )}

      {step === 'code_old' && (
        <OtpStep
          flow={flow}
          onSubmit={submitOldCode}
          onBack={() => { flow.reset(); setStep('form'); }}
          backLabel="← назад"
          title="Код на ТЕКУЩИЙ номер"
        />
      )}

      {step === 'code_new' && (
        <OtpStep
          flow={flow}
          onSubmit={submitNewCode}
          onBack={() => { flow.reset(); setStep('form'); }}
          backLabel="← назад"
          title="Код на НОВЫЙ номер"
        />
      )}

      {step === 'done' && (
        <div>
          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Номер изменён 📱</h3>
          <p className="label-md" style={{ marginBottom: 'var(--spacing-5)', lineHeight: 1.55 }}>
            Теперь вход — по новому номеру. Остальные сессии завершены.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn-primary" style={{ fontSize: '0.85rem' }} onClick={onClose}>Готово</button>
          </div>
        </div>
      )}
    </DialogFrame>
  );
}
