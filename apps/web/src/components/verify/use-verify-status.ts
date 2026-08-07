'use client';

/**
 * Режим движка подтверждений (GET /verify/status) — один общий запрос на вкладку.
 * Нужен, чтобы шаг кода честно говорил, что SMS сейчас никуда не уходят (dev/mock):
 * иначе человек десять минут ждёт сообщение, которого не будет.
 */

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import type { VerifyStatusResponse } from '@superapp/shared';

export function useVerifyStatus() {
  const { data } = useQuery<VerifyStatusResponse>({
    queryKey: ['verify', 'status'],
    queryFn: async () => await apiGet('/verify/status'),
    staleTime: Infinity, // режим меняется только рестартом API
    retry: false,
  });
  return data ?? null;
}
