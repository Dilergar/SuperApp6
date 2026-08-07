'use client';

import { useQuery } from '@tanstack/react-query';
import {
  APPROVAL_LIMITS,
  type InboxCountDto,
} from '@superapp/shared';
import { apiGet } from '@/lib/api';
import { approvalCountKey, approvalScopeParams, type ApprovalScope } from '@/lib/queries';

// ============================================================
// Счётчик стопки «Ждут решения» для бейджа топбара.
//
// Ходит в ЛЁГКУЮ ручку `/approvals/inbox/count` (одно число, без списков) —
// как счётчик упоминаний. Сама стопка держит свой запрос и открывается по
// клику: держать её загруженной на каждой странице незачем.
// ============================================================

/**
 * Сколько решений ждёт этого человека. `enabled=false` пропускает запрос
 * (до гидратации авторизации). Число приходит сложенным ПО ВСЕМ источникам
 * реестра, поэтому бейдж не придётся менять, когда рядом с согласованиями
 * встанут очереди отделов и приёмка задач.
 *
 * Скоуп — обязательное решение вызывающего, а не деталь: топбар спрашивает
 * СКВОЗНО (`undefined`), витрина личного контекста — `{personal:true}`,
 * страница организации — `{workspaceId}`. См. `ApprovalScope` в lib/queries.
 */
export function useApprovalsCount(enabled = true, scope?: ApprovalScope): number {
  const { data } = useQuery({
    queryKey: approvalCountKey(scope),
    // Фетчер локальный, а не из lib/approvals-api: хук монтируется в AppShell —
    // корневом графе КАЖДОЙ страницы, и один импорт утащил бы туда весь клиент
    // вместе с типами движка (та же причина, что у счётчика упоминаний).
    queryFn: async () =>
      (await apiGet<InboxCountDto>('/approvals/inbox/count', { params: approvalScopeParams(scope) })).total,
    enabled,
    refetchInterval: APPROVAL_LIMITS.countPollMs,
    refetchOnWindowFocus: true,
  });
  return data ?? 0;
}
