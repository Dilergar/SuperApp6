'use client';

// ============================================================
// Правила видимости на клиенте (core/visibility).
//
// - `useVisibilityInvalidation` — ОДИН подписчик сокета `visibility:changed` (монтирует
//   AppShell): политика организации сменилась → её ключи (ростер, анкета, план, матрица);
//   личная политика человека → карточки (Окружение, Группы, ростеры), свой план.
// - `useVisibilityPlan` — план зрителя по типу записи в «шляпе» страницы (R14): таблица
//   не предлагает сортировку/фильтр по полю, которое зритель видит не полностью
//   («пикер не предлагает того, что сервер отвергнет»; сервер всё равно проверяет).
// ============================================================

import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { VisibilityFieldCap, VisibilityPlanDto } from '@superapp/shared';
import { fetchVisibilityPlan } from '@/lib/visibility-api';
import { visibilityPlanKey, visibilityRootKey } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime/useRealtime';
import { useAuthStore } from '@/lib/stores/auth';

const startsWith = (key: QueryKey, head: readonly unknown[]) => head.every((h, i) => key[i] === h);

export function useVisibilityInvalidation(): void {
  const qc = useQueryClient();
  useRealtime({
    onVisibilityChanged: (p) => {
      void qc.invalidateQueries({ queryKey: visibilityRootKey });
      if (p.ownerKind === 'workspace') {
        // Всё, что организация показывает: ростер, карточки сотрудников, анкета, её матрица
        void qc.invalidateQueries({ queryKey: ['workspaces', p.ownerId] });
        return;
      }
      // Личная карточка человека: Окружение, Группы и ростеры, где он виден коллегам
      void qc.invalidateQueries({
        predicate: (q) =>
          startsWith(q.queryKey, ['contacts']) ||
          startsWith(q.queryKey, ['circles']) ||
          (q.queryKey[0] === 'workspaces' && q.queryKey.includes('members')),
      });
    },
    onReconnect: () => void qc.invalidateQueries({ queryKey: visibilityRootKey }),
  });
}

export function useVisibilityPlan(recordType: string, workspaceId: string | null, enabled = true) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery({
    queryKey: visibilityPlanKey(recordType, workspaceId),
    queryFn: () => fetchVisibilityPlan(recordType),
    enabled: enabled && isAuthenticated,
    staleTime: 60_000,
  });
}

/** Поле видно зрителю полностью и ему разрешена операция (сортировка/фильтр/поиск). */
export function planAllows(plan: VisibilityPlanDto | undefined, fieldKey: string, cap: VisibilityFieldCap): boolean {
  const f = plan?.fields[fieldKey];
  return !!f && f.level === 'full' && f.caps.includes(cap);
}

/** Поле видно зрителю хоть в каком-то виде (полностью или маской) — колонка имеет смысл. */
export function planShows(plan: VisibilityPlanDto | undefined, fieldKey: string): boolean {
  const f = plan?.fields[fieldKey];
  return !!f && f.level !== 'hidden';
}
