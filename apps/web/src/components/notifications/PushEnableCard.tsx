'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { toastError } from '@/lib/toast';
import { apiErrorMessage } from '@/lib/api';
import { usePushSubscription } from '@/lib/notifications/usePushSubscription';

const DISMISS_KEY = 'sa6_push_card_dismissed';

/**
 * Карточка «Включить уведомления в браузере» в панели колокольчика: показывается,
 * пока разрешение не спрашивали и устройства нет; «Позже» прячет её (localStorage).
 * Разрешение спрашивается ТОЛЬКО отсюда или из настроек — не при загрузке страницы.
 */
export function PushEnableCard() {
  const t = useTranslations('shell');
  const { status, enable, busy } = usePushSubscription();
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);
  if (dismissed || status !== 'default') return null;
  const later = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode */
    }
    setDismissed(true);
  };
  return (
    <div style={{ padding: '0.25rem 0.5rem 0.5rem' }}>
      <Alert
        tone="accent"
        icon="bellRinging"
        title={t('notifications.pushCard.title')}
        action={
          <span style={{ display: 'inline-flex', gap: '0.375rem' }}>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void enable().catch((e) => toastError(apiErrorMessage(e)))}>
              {t('notifications.pushCard.enable')}
            </Button>
            <Button size="sm" variant="ghost" onClick={later}>
              {t('notifications.pushCard.later')}
            </Button>
          </span>
        }
      >
        {t('notifications.pushCard.description')}
      </Alert>
    </div>
  );
}
