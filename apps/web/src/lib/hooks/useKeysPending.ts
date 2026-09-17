'use client';

// Значок «N ботов ждут решения владельца» (core/keys): запрос + сокет `keys:changed`,
// чтобы бейдж обновлялся без перезагрузки. Сервер отдаёт 403 не владельцу/админу —
// хук включают только для них (тихий ноль, как у остальных счётчиков шапки).

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchKeysPending } from '@/lib/keys-api';
import { keysPendingKey, keysRegistryRootKey } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime/useRealtime';

export function useKeysPending(workspaceId: string | null | undefined, enabled: boolean): number {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: workspaceId ? keysPendingKey(workspaceId) : ['keys-pending-none'],
    queryFn: () => fetchKeysPending(workspaceId!),
    enabled: enabled && !!workspaceId,
    staleTime: 60_000,
    retry: false,
  });
  useRealtime({
    onKeysChanged: (p) => {
      if (workspaceId && p.workspaceId === workspaceId) {
        qc.setQueryData(keysPendingKey(workspaceId), { frozenBots: p.frozenBots });
        void qc.invalidateQueries({ queryKey: keysRegistryRootKey(workspaceId) });
      }
    },
    onReconnect: () => {
      if (workspaceId) void qc.invalidateQueries({ queryKey: keysPendingKey(workspaceId) });
    },
  });
  return q.data?.frozenBots ?? 0;
}
