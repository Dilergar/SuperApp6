'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notificationDevicesKey, notificationVapidKey } from '@/lib/queries';
import { fetchVapidPublicKey, registerNotificationDevice, removeNotificationDevice } from '@/lib/notifications-api';

// ============================================================
// Web push в браузере (VAPID + service worker `/sw.js`). Разрешение НЕ спрашивается
// при загрузке — только по явному действию человека (карточка в панели / тумблер в
// настройках): Chrome best practice, иначе первый же визит выпрашивает разрешение,
// и его запрещают навсегда. Подписка регистрируется устройством у движка
// (`POST /notifications/devices`); повторный визит освежает `lastSeenAt`.
// ============================================================

export type PushStatus =
  | 'loading'
  /** Браузер не умеет push (Safari на iOS вне «домашнего экрана», старые WebView) */
  | 'unsupported'
  /** На сервере нет VAPID-ключей — фичи нет, UI не показываем */
  | 'unavailable'
  /** Человек запретил уведомления в браузере — включить можно только в его настройках */
  | 'denied'
  /** Разрешение ещё не спрашивали */
  | 'default'
  | 'subscribed'
  | 'unsubscribed';

const SW_PATH = '/sw.js';
const TOUCHED_KEY = 'sa6_push_touched';

function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function usePushSubscription(): {
  status: PushStatus;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  busy: boolean;
} {
  const qc = useQueryClient();
  const vapid = useQuery({ queryKey: notificationVapidKey, queryFn: fetchVapidPublicKey, staleTime: 3600_000 });
  const [status, setStatus] = useState<PushStatus>('loading');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported()) return setStatus('unsupported');
    if (vapid.isLoading) return;
    if (!vapid.data?.publicKey) return setStatus('unavailable');
    const perm = Notification.permission;
    if (perm === 'denied') return setStatus('denied');
    if (perm === 'default') return setStatus('default');
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) return setStatus('unsubscribed');
      setStatus('subscribed');
      // Освежить lastSeenAt раз в сессию — окно свежести устройств (60 дней)
      try {
        if (!sessionStorage.getItem(TOUCHED_KEY)) {
          sessionStorage.setItem(TOUCHED_KEY, '1');
          await registerNotificationDevice({ platform: 'web', provider: 'webpush', token: sub.endpoint, subscription: sub.toJSON() as never });
        }
      } catch {
        /* best-effort */
      }
    } catch {
      setStatus('unsubscribed');
    }
  }, [vapid.data, vapid.isLoading]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!supported() || !vapid.data?.publicKey) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.register(SW_PATH);
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setStatus(perm === 'denied' ? 'denied' : 'default');
        return;
      }
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapid.data.publicKey) as BufferSource }));
      await registerNotificationDevice({
        platform: 'web',
        provider: 'webpush',
        token: sub.endpoint,
        subscription: sub.toJSON() as never,
      });
      setStatus('subscribed');
      void qc.invalidateQueries({ queryKey: notificationDevicesKey });
    } finally {
      setBusy(false);
    }
  }, [vapid.data, qc]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await removeNotificationDevice({ provider: 'webpush', token: sub.endpoint }).catch(() => undefined);
        await sub.unsubscribe();
      }
      setStatus('unsubscribed');
      void qc.invalidateQueries({ queryKey: notificationDevicesKey });
    } finally {
      setBusy(false);
    }
  }, [qc]);

  return { status, enable, disable, busy };
}
