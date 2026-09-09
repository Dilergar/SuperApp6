'use client';

// ============================================================
// Гостевая страница /s/<токен> — единственный экран человека БЕЗ аккаунта.
//
// Поток: peek (жива ли ссылка, нужен ли пароль) → открытие (засчитывается ОДНО
// открытие, выдаётся пропуск на час) → отрисовка по типу объекта.
//
// Пропуск лежит в sessionStorage: обновление страницы в течение часа не накручивает
// счётчик открытий — «открытие» это человек, а не клик по F5.
//
// Все тупики (нет ссылки, отозвали, истекла, лимит, объект удалён) рисуются ЗДЕСЬ:
// глобальная страница 404 не годится — она часть каркаса приложения и уводила бы
// постороннего человека внутрь продукта.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  SHARE_LINK_ERROR_CODES,
  SHARE_LINK_LIMITS,
  normalizePhone,
  type ShareDocGuestView,
  type ShareDriveGuestView,
  type ShareGuestIdentityStartDto,
  type ShareGuestSessionDto,
} from '@superapp/shared';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Feedback';
import { CodeInput } from '@/components/verify/CodeInput';
import {
  apiErrorCode,
  apiErrorDetails,
  sharePeek,
  shareIdentityStart,
  shareOpenSession,
  shareRefreshView,
  shareVerifyCheck,
  shareVerifyDevCode,
} from '@/lib/public-api';
import { ShareGuestError, ShareGuestShell } from '../_components/ShareGuestShell';
import { ShareDriveView } from '../_components/ShareDriveView';
import { ShareDocView } from '../_components/ShareDocView';
import { ShareSignView, type ShareSignGuestView } from './ShareSignView';
import { formatCountdown, useFormatters } from '@/lib/format';

type Stage = 'loading' | 'password' | 'identity' | 'ready' | 'error';

/**
 * Текст ошибки из конверта API — локальный, чтобы не тащить клиент с перехватчиками.
 * Фразу сервер уже перевёл в языке запроса; общий фолбэк приходит ПАРАМЕТРОМ —
 * функция не React и каталога не знает.
 */
function guestErrText(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof msg === 'string' && msg ? msg : fallback;
}

/**
 * Тупик ссылки → ВЕТКА каталога (`share.guest.dead.<ветка>`), а не пара фраз:
 * слова у каждого тупика свои, но берутся они одним правилом, и новый код отказа
 * стоит одной строки здесь плюс двух ключей в каталоге.
 */
const DEAD_LINK_BRANCH: Record<string, string> = {
  [SHARE_LINK_ERROR_CODES.notFound]: 'notFound',
  [SHARE_LINK_ERROR_CODES.revoked]: 'revoked',
  [SHARE_LINK_ERROR_CODES.expired]: 'expired',
  [SHARE_LINK_ERROR_CODES.exhausted]: 'exhausted',
  [SHARE_LINK_ERROR_CODES.refGone]: 'refGone',
  [SHARE_LINK_ERROR_CODES.sessionInvalid]: 'sessionInvalid',
};

const storageKey = (token: string) => `share:${token}`;

export default function SharePage() {
  const t = useTranslations('share');
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';

  const [stage, setStage] = useState<Stage>('loading');
  const [session, setSession] = useState<ShareGuestSessionDto | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  // Ссылка требует назвать имя и подтвердить номер SMS-кодом (после пароля, если есть).
  const [identityRequired, setIdentityRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  // StrictMode в разработке монтирует эффект дважды: без засова открытие
  // засчиталось бы двумя и счётчик врал бы вдвое.
  const startedRef = useRef(false);

  const fail = useCallback((err: unknown) => {
    setErrorCode(apiErrorCode(err));
    setStage('error');
  }, []);

  /** Открыть ссылку (считается открытием) и запомнить пропуск на время вкладки */
  const open = useCallback(
    async (opts: { password?: string; verifyToken?: string; guestName?: string } = {}) => {
      setBusy(true);
      setPasswordError(null);
      try {
        const data = await shareOpenSession(token, opts);
        sessionStorage.setItem(storageKey(token), data.sessionToken);
        setSession(data);
        setStage('ready');
      } catch (err) {
        const details = apiErrorDetails(err);
        const code = details?.code ?? null;
        if (code === SHARE_LINK_ERROR_CODES.passwordLocked) {
          // Подбор заблокирован: без срока человек не поймёт, ждать ему минуту или день.
          // «мин.» не склоняется — числа тут любые.
          const min = Math.max(1, Math.ceil((details?.retryInSec ?? 0) / 60));
          setPasswordError(t('guest.passwordLocked', { min }));
          setStage('password');
        } else if (code === SHARE_LINK_ERROR_CODES.passwordWrong) {
          const left = details?.attemptsLeft;
          setPasswordError(
            typeof left === 'number' ? t('guest.passwordWrongLeft', { n: left }) : t('guest.passwordWrong'),
          );
          setStage('password');
        } else if (code === SHARE_LINK_ERROR_CODES.passwordRequired) {
          setStage('password');
        } else {
          fail(err);
        }
      } finally {
        setBusy(false);
      }
    },
    [token, fail],
  );

  useEffect(() => {
    if (!token || startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      // Пропуск этой вкладки ещё жив — показываем содержимое без нового открытия.
      const saved = sessionStorage.getItem(storageKey(token));
      if (saved) {
        try {
          setSession(await shareRefreshView(token, saved));
          setStage('ready');
          return;
        } catch {
          sessionStorage.removeItem(storageKey(token));
        }
      }

      try {
        const peek = await sharePeek(token);
        setIdentityRequired(peek.identityRequired);
        if (peek.state === 'password_required') {
          setStage('password');
          return;
        }
        if (peek.identityRequired) {
          setStage('identity');
          return;
        }
        await open();
      } catch (err) {
        fail(err);
      }
    })();
  }, [token, open, fail]);

  /** Перезапросить содержимое (протухшие ссылки на байты, готовность PDF) */
  const refresh = useCallback(async () => {
    const saved = sessionStorage.getItem(storageKey(token));
    if (!saved) return;
    try {
      setSession(await shareRefreshView(token, saved));
    } catch (err) {
      fail(err);
    }
  }, [token, fail]);

  if (stage === 'loading') {
    return (
      <ShareGuestShell>
        <div style={{ textAlign: 'center', padding: 'var(--spacing-6) 0' }}>
          <Spinner />
        </div>
      </ShareGuestShell>
    );
  }

  if (stage === 'error') {
    const branch = (errorCode && DEAD_LINK_BRANCH[errorCode]) || 'fallback';
    return (
      <ShareGuestError
        title={t(`guest.dead.${branch}.title`)}
        description={t(`guest.dead.${branch}.description`)}
      />
    );
  }

  if (stage === 'password') {
    return (
      <ShareGuestShell title={t('guest.passwordTitle')} subtitle={t('guest.passwordSubtitle')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // Пароль проверит сервер: у обычной ссылки — при открытии, у ссылки с
            // подтверждением номера — при запросе SMS-кода (шаг «кто вы»).
            if (identityRequired) {
              setPasswordError(null);
              setStage('identity');
            } else {
              void open({ password });
            }
          }}
        >
          <Input
            label={t('guest.passwordLabel')}
            type="password"
            value={password}
            autoFocus
            autoComplete="off"
            onChange={(e) => setPassword(e.target.value)}
            error={passwordError ?? undefined}
          />
          <div style={{ marginTop: 'var(--spacing-5)' }}>
            <Button type="submit" variant="primary" block loading={busy} disabled={!password}>
              {identityRequired ? t('guest.next') : t('guest.open')}
            </Button>
          </div>
        </form>
      </ShareGuestShell>
    );
  }

  if (stage === 'identity') {
    return (
      <IdentityStep
        token={token}
        password={password || undefined}
        busy={busy}
        onDone={(identity) => open({ ...(password ? { password } : {}), ...identity })}
        onPasswordRejected={(message) => {
          setPasswordError(message);
          setStage('password');
        }}
      />
    );
  }

  // refresh передаём КАК ЕСТЬ, без обёртки-стрелки: новая функция на каждый рендер
  // меняла бы зависимость эффекта опроса у ShareDocView и сбрасывала его таймер.
  return <ShareContent session={session!} token={token} onRefresh={refresh} />;
}

/**
 * Шаг «кто вы»: имя + номер → SMS-код (движок core/verify, цель share_link_guest).
 * Проверка кода идёт публичным /verify/check; полученный одноразовый пропуск гасится
 * сервером в транзакции открытия — несостоявшееся открытие кода не сжигает.
 */
function IdentityStep({
  token,
  password,
  busy,
  onDone,
  onPasswordRejected,
}: {
  token: string;
  password?: string;
  /** Родитель открывает ссылку — его занятость показываем на автосабмите кода */
  busy: boolean;
  onDone: (identity: { verifyToken: string; guestName: string }) => Promise<void> | void;
  onPasswordRejected: (message: string) => void;
}) {
  const t = useTranslations('share');
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<ShareGuestIdentityStartDto | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  // Тикающий таймер ресенда — серверное значение, по секунде вниз.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((v) => v - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const normalized = normalizePhone(phone);
  const phoneOk = /^\+77\d{9}$/.test(normalized);

  const requestCode = async () => {
    setSending(true);
    setError(null);
    try {
      const started = await shareIdentityStart(token, normalized, password);
      setChallenge(started);
      setResendIn(started.resendInSec);
      setCode('');
      setCodeError(null);
      // Дев-подсказка кода (в production ручка отвечает 404 и подсказки просто нет).
      setDevCode(await shareVerifyDevCode(started.challengeId));
    } catch (err) {
      const code = apiErrorCode(err);
      if (
        code === SHARE_LINK_ERROR_CODES.passwordWrong ||
        code === SHARE_LINK_ERROR_CODES.passwordRequired ||
        code === SHARE_LINK_ERROR_CODES.passwordLocked
      ) {
        // Пароль ссылки не подошёл — возвращаем человека на шаг пароля с причиной.
        onPasswordRejected(guestErrText(err, t('guest.genericError')));
        return;
      }
      const details = apiErrorDetails(err);
      if (typeof details?.resendInSec === 'number' && details.resendInSec > 0) {
        setResendIn(details.resendInSec);
      }
      setError(guestErrText(err, t('guest.genericError')));
    } finally {
      setSending(false);
    }
  };

  const submitCode = async (value: string) => {
    if (!challenge || checking) return;
    setChecking(true);
    setCodeError(null);
    try {
      const { verifyToken } = await shareVerifyCheck(challenge.challengeId, value);
      await onDone({ verifyToken, guestName: name.trim() });
    } catch (err) {
      const details = apiErrorDetails(err);
      setCodeError(
        typeof details?.attemptsLeft === 'number'
          ? t('guest.codeWrongLeft', { n: details.attemptsLeft })
          : guestErrText(err, t('guest.genericError')),
      );
      setCode('');
    } finally {
      setChecking(false);
    }
  };

  if (challenge) {
    return (
      <ShareGuestShell
        title={tc('otp.title')}
        subtitle={t('guest.codeSentTo', { phone: challenge.phoneMasked })}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)', alignItems: 'center' }}>
          <CodeInput
            value={code}
            onChange={setCode}
            onComplete={(v) => void submitCode(v)}
            error={!!codeError}
            disabled={checking || busy}
          />
          {codeError && (
            <p className="body-sm" style={{ margin: 0, color: 'var(--danger)' }}>
              {codeError}
            </p>
          )}
          {devCode && (
            <p className="meta" style={{ margin: 0 }}>
              {t('guest.devCode', { code: devCode })}
            </p>
          )}
          {(checking || busy) && <Spinner />}
          <div style={{ display: 'flex', gap: 'var(--spacing-4)', alignItems: 'center' }}>
            <Button
              size="sm"
              variant="ghost"
              disabled={resendIn > 0 || sending}
              loading={sending}
              onClick={() => void requestCode()}
            >
              {resendIn > 0 ? tc('otp.resendIn', { time: formatCountdown(resendIn) }) : tc('otp.resend')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setChallenge(null)}>
              ← {tc('otp.changeNumber')}
            </Button>
          </div>
        </div>
      </ShareGuestShell>
    );
  }

  return (
    <ShareGuestShell
      title={t('guest.identityTitle')}
      subtitle={t('guest.identitySubtitle')}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void requestCode();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}
      >
        <Input
          label={t('guest.nameLabel')}
          value={name}
          autoFocus
          maxLength={SHARE_LINK_LIMITS.guestNameMaxLength}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label={t('guest.phoneLabel')}
          type="tel"
          inputMode="tel"
          placeholder="+7 7__ ___ __ __"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          hint={t('guest.phoneHint')}
          error={error ?? undefined}
        />
        <div style={{ marginTop: 'var(--spacing-2)' }}>
          <Button type="submit" variant="primary" block loading={sending} disabled={!name.trim() || !phoneOk}>
            {t('guest.getCode')}
          </Button>
        </div>
      </form>
    </ShareGuestShell>
  );
}

/** Отрисовка по типу объекта — здесь же место будущих потребителей (счета, витрины) */
function ShareContent({
  session,
  token,
  onRefresh,
}: {
  session: ShareGuestSessionDto;
  token: string;
  onRefresh: () => void;
}) {
  const t = useTranslations('share');
  const f = useFormatters();
  const until = session.linkExpiresAt
    ? t('guest.availableUntil', { date: f.date(session.linkExpiresAt, 'long') })
    : undefined;

  if (session.refType === 'drive_node') {
    const view = session.view as ShareDriveGuestView;
    return (
      <ShareGuestShell title={view.name} subtitle={until} wide={view.kind === 'folder'}>
        <ShareDriveView view={view} session={session.sessionToken} />
      </ShareGuestShell>
    );
  }

  if (session.refType === 'document') {
    const view = session.view as ShareDocGuestView;
    return (
      <ShareGuestShell title={view.title} subtitle={until} wide>
        <ShareDocView view={view} onRefresh={onRefresh} />
      </ShareGuestShell>
    );
  }

  if (session.refType === 'sign_request') {
    const view = session.view as ShareSignGuestView;
    return (
      <ShareGuestShell title={view.title} subtitle={until} wide>
        <ShareSignView view={view} token={token} session={session.sessionToken} onRefresh={onRefresh} />
      </ShareGuestShell>
    );
  }

  // Ссылка на тип, которого эта версия интерфейса ещё не знает: сервер уже умеет,
  // клиент — нет. Честная заглушка лучше пустого экрана.
  return (
    <ShareGuestError
      title={t('guest.unsupported.title')}
      description={t('guest.unsupported.description')}
    />
  );
}
