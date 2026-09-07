'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationCountsDto } from '@superapp/shared';
import { apiGet } from '@/lib/api';
import { notificationCountsKey, notificationsRootKey } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime/useRealtime';

// ============================================================
// Бейдж колокольчика = unseen + точки по контекстам. Ходит в ЛЁГКУЮ ручку
// `/notifications/counts`; realtime (`notification:new` / `notification:counts`) гасит
// кэш сразу — две вкладки видят один бейдж. Поллинг раз в минуту — страховка
// at-most-once шины. Фетчер локальный: хук сидит в AppShell (корневой граф каждой
// страницы), и импорт notifications-api утащил бы туда клиент центра целиком.
// ============================================================

const EMPTY: NotificationCountsDto = { unseen: 0, byContext: {} };

export function useNotificationCounts(enabled = true): NotificationCountsDto {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: notificationCountsKey,
    queryFn: () => apiGet<NotificationCountsDto>('/notifications/counts'),
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  useRealtime({
    onNotificationNew: () => {
      void qc.invalidateQueries({ queryKey: notificationsRootKey });
    },
    onNotificationCounts: () => {
      void qc.invalidateQueries({ queryKey: notificationsRootKey });
    },
    onReconnect: () => {
      void qc.invalidateQueries({ queryKey: notificationsRootKey });
    },
  });
  return data ?? EMPTY;
}
