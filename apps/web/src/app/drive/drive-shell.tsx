'use client';

// ============================================================
// DriveShell — контекст Диска для всех его разделов.
//
// Держит АДРЕС ПРОСТРАНСТВА (личное по умолчанию; чужое или организации — через
// ?space=/?ws=, чтобы ссылка переживала F5 и шарилась), обзор с занятым местом и
// общую инвалидацию. Разделы («Мой диск», «Фото», «Корзина»…) — отдельные URL и
// живут в ГЛОБАЛЬНОМ сайдбаре, поэтому свою навигацию shell не рисует.
// ============================================================

import { createContext, useCallback, useContext, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DriveOverviewDto } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { driveOverviewKey, driveRootKey } from '@/lib/queries';
import type { DriveSpaceRef } from '@superapp/shared';
import { fetchDriveOverview } from '@/lib/drive-api';
import { LoadingBlock } from '@/components/ui';

export interface DriveCtx {
  ref: DriveSpaceRef;
  overview: DriveOverviewDto | undefined;
  meId: string | null;
  /** Можно ли писать в это пространство (хотя бы где-то) */
  canEdit: boolean;
  invalidate: () => void;
  /** href с сохранением контекста пространства */
  withSpace: (href: string, extra?: Record<string, string>) => string;
}

const Ctx = createContext<DriveCtx | null>(null);

export function useDrive(): DriveCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDrive вне DriveShell');
  return v;
}

export function DriveShell({ children }: { defaultCollapsed?: boolean; children: React.ReactNode }) {
  const { isReady, user: me } = useRequireAuth();
  const qc = useQueryClient();
  const params = useSearchParams();
  const spaceId = params.get('space') ?? undefined;
  const workspaceId = params.get('ws') ?? undefined;

  const driveRef = useMemo<DriveSpaceRef>(() => ({ spaceId, workspaceId }), [spaceId, workspaceId]);

  const { data: overview } = useQuery({
    queryKey: driveOverviewKey(driveRef),
    queryFn: () => fetchDriveOverview(driveRef),
    enabled: isReady,
  });

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: driveRootKey });
  }, [qc]);

  const withSpace = useCallback(
    (href: string, extra?: Record<string, string>) => {
      const q = new URLSearchParams(extra ?? {});
      if (spaceId) q.set('space', spaceId);
      if (workspaceId) q.set('ws', workspaceId);
      const s = q.toString();
      return s ? `${href}?${s}` : href;
    },
    [spaceId, workspaceId],
  );

  const value = useMemo<DriveCtx>(
    () => ({
      ref: driveRef,
      overview,
      meId: me?.id ?? null,
      canEdit: overview ? overview.space.access !== 'viewer' : false,
      invalidate,
      withSpace,
    }),
    [driveRef, overview, me?.id, invalidate, withSpace],
  );

  if (!isReady) return <LoadingBlock />;

  // Смена пространства = чистый лист: выделение, курсоры и открытая папка от
  // прошлого диска здесь не имеют смысла (приём FinanceShell).
  return (
    <Ctx.Provider key={workspaceId ?? spaceId ?? 'own'} value={value}>
      {children}
    </Ctx.Provider>
  );
}
