'use client';

import { useTranslations } from 'next-intl';
import { Alert, Toggle } from '@/components/ui';
import { toastError } from '@/lib/toast';
import { apiErrorMessage } from '@/lib/api';
import { usePushSubscription } from '@/lib/notifications/usePushSubscription';

/**
 * Тумблер «Уведомления в этом браузере» (настройки). Без VAPID на сервере или без
 * поддержки push в браузере — не рисуется/объясняется: UI несуществующих фич не показываем.
 */
export function PushToggle() {
  const t = useTranslations('notifications');
  const { status, enable, disable, busy } = usePushSubscription();
  if (status === 'loading' || status === 'unavailable') return null;
  if (status === 'unsupported') return <p className="body-sm" style={{ color: 'var(--on-surface-variant)' }}>{t('settings.devices.unsupported')}</p>;
  if (status === 'denied') return <Alert tone="warning">{t('settings.devices.blocked')}</Alert>;
  const on = status === 'subscribed';
  return (
    <Toggle
      checked={on}
      disabled={busy}
      onChange={(next) => {
        void (next ? enable() : disable()).catch((e) => toastError(apiErrorMessage(e)));
      }}
      label={t('settings.devices.browser')}
      description={t('settings.devices.browserHint')}
    />
  );
}
