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
import {
  SHARE_LINK_ERROR_CODES,
  type ShareDocGuestView,
  type ShareDriveGuestView,
  type ShareGuestSessionDto,
} from '@superapp/shared';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Feedback';
import { apiErrorCode, apiErrorDetails, sharePeek, shareOpenSession, shareRefreshView } from '@/lib/public-api';
import { ShareGuestError, ShareGuestShell } from '../_components/ShareGuestShell';
import { ShareDriveView } from '../_components/ShareDriveView';
import { ShareDocView } from '../_components/ShareDocView';

type Stage = 'loading' | 'password' | 'ready' | 'error';

const DEAD_LINK_TEXT: Record<string, { title: string; description: string }> = {
  [SHARE_LINK_ERROR_CODES.notFound]: {
    title: 'Ссылка не найдена',
    description: 'Возможно, адрес скопирован не полностью или ссылку удалили.',
  },
  [SHARE_LINK_ERROR_CODES.revoked]: {
    title: 'Доступ по ссылке закрыт',
    description: 'Тот, кто поделился, отозвал эту ссылку. Попросите новую.',
  },
  [SHARE_LINK_ERROR_CODES.expired]: {
    title: 'Срок действия ссылки истёк',
    description: 'Ссылка была временной. Попросите новую у того, кто ею поделился.',
  },
  [SHARE_LINK_ERROR_CODES.exhausted]: {
    title: 'Лимит открытий исчерпан',
    description: 'Эту ссылку можно было открыть ограниченное число раз.',
  },
  [SHARE_LINK_ERROR_CODES.refGone]: {
    title: 'Объект больше недоступен',
    description: 'Его удалили или переместили в корзину.',
  },
  [SHARE_LINK_ERROR_CODES.sessionInvalid]: {
    title: 'Сессия просмотра истекла',
    description: 'Обновите страницу, чтобы открыть ссылку заново.',
  },
};

const FALLBACK_ERROR = {
  title: 'Не удалось открыть ссылку',
  description: 'Попробуйте обновить страницу через минуту.',
};

const storageKey = (token: string) => `share:${token}`;

export default function SharePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';

  const [stage, setStage] = useState<Stage>('loading');
  const [session, setSession] = useState<ShareGuestSessionDto | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
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
    async (pwd?: string) => {
      setBusy(true);
      setPasswordError(null);
      try {
        const data = await shareOpenSession(token, pwd);
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
          setPasswordError(`Слишком много неверных попыток. Попробуйте через ${min} мин.`);
          setStage('password');
        } else if (code === SHARE_LINK_ERROR_CODES.passwordWrong) {
          const left = details?.attemptsLeft;
          setPasswordError(
            typeof left === 'number' ? `Неверный пароль — осталось попыток: ${left}` : 'Неверный пароль',
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
        if (peek.state === 'password_required') {
          setStage('password');
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
    const text = (errorCode && DEAD_LINK_TEXT[errorCode]) || FALLBACK_ERROR;
    return <ShareGuestError title={text.title} description={text.description} />;
  }

  if (stage === 'password') {
    return (
      <ShareGuestShell title="Ссылка защищена паролем" subtitle="Введите пароль, который вам передали">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void open(password);
          }}
        >
          <Input
            label="Пароль"
            type="password"
            value={password}
            autoFocus
            autoComplete="off"
            onChange={(e) => setPassword(e.target.value)}
            error={passwordError ?? undefined}
          />
          <div style={{ marginTop: 'var(--spacing-5)' }}>
            <Button type="submit" variant="primary" block loading={busy} disabled={!password}>
              Открыть
            </Button>
          </div>
        </form>
      </ShareGuestShell>
    );
  }

  // refresh передаём КАК ЕСТЬ, без обёртки-стрелки: новая функция на каждый рендер
  // меняла бы зависимость эффекта опроса у ShareDocView и сбрасывала его таймер.
  return <ShareContent session={session!} onRefresh={refresh} />;
}

/** Отрисовка по типу объекта — здесь же место будущих потребителей (счета, витрины) */
function ShareContent({ session, onRefresh }: { session: ShareGuestSessionDto; onRefresh: () => void }) {
  const until = session.linkExpiresAt
    ? `Доступно до ${new Date(session.linkExpiresAt).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })}`
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

  // Ссылка на тип, которого эта версия интерфейса ещё не знает: сервер уже умеет,
  // клиент — нет. Честная заглушка лучше пустого экрана.
  return (
    <ShareGuestError
      title="Эта ссылка не поддерживается"
      description="Обновите страницу позже — возможно, приложение ещё не знает такой тип содержимого."
    />
  );
}
