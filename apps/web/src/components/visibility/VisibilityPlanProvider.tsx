'use client';

// ============================================================
// План зрителя по типу записи для «шляпы» страницы (core/visibility, R14): таблица и фильтры
// не предлагают сортировку/фильтр/колонку по полю, которое зритель видит не полностью
// («пикер не предлагает того, что сервер отвергнет»; сервер всё равно проверяет `assertQueryable`).
// План — `GET /visibility/plan` в кэше RQ, сокет `visibility:changed` его инвалидирует.
// Пока план грузится, ничего не предлагается (fail-closed), а не всё подряд.
// ============================================================

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { VisibilityFieldCap, VisibilityPlanDto } from '@superapp/shared';
import { planAllows, planShows, useVisibilityPlan } from '@/lib/hooks/useVisibility';

export interface VisibilityPlanApi {
  plan: VisibilityPlanDto | null;
  /** Поле видно хоть в каком-то виде (полностью или маской) — колонка имеет смысл */
  shows: (fieldKey: string) => boolean;
  /** Поле видно полностью и операция разрешена (sort / filter / search / group / aggregate) */
  allows: (fieldKey: string, cap: VisibilityFieldCap) => boolean;
}

const Ctx = createContext<VisibilityPlanApi | null>(null);

export function VisibilityPlanProvider({
  recordType,
  workspaceId,
  children,
}: {
  recordType: string;
  workspaceId: string | null;
  children: ReactNode;
}) {
  const q = useVisibilityPlan(recordType, workspaceId);
  const plan = q.data ?? null;
  const api = useMemo<VisibilityPlanApi>(
    () => ({
      plan,
      shows: (k) => planShows(plan ?? undefined, k),
      allows: (k, cap) => planAllows(plan ?? undefined, k, cap),
    }),
    [plan],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** План страницы; вне провайдера — ничего не предлагать (fail-closed). */
export function useFieldPlan(): VisibilityPlanApi {
  return useContext(Ctx) ?? { plan: null, shows: () => false, allows: () => false };
}
