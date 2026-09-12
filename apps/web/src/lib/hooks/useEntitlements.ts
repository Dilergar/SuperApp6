'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import {
  ENTITLEMENT_REGISTRY,
  type EntitlementKey,
  type EntitlementSnapshotDto,
  type EntitlementUnlockDto,
  type EntitlementValueDto,
} from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { fetchEntitlements } from '@/lib/entitlements-api';
import { entitlementsKey, entitlementsRootKey } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime/useRealtime';
import { useAuthStore } from '@/lib/stores/auth';
import { toastError } from '@/lib/toast';

// ============================================================
// Тариф и лимиты на клиенте (core/entitlements).
//
// Один снимок на контекст страницы (личный | организация), кэш React Query по ключу
// контекста, инвалидация — сокет-событием `entitlements:changed`, на reconnect и после
// отказа 402 (снимок мог устареть). Замок и счётчик у действия читают ОДИН хук
// `useEntitlement(key)`; пикер/кнопка не предлагают того, что сервер отвергнет.
// ============================================================

const EMPTY_UNLOCK: EntitlementUnlockDto = { by: 'self', plan: null };

export function useEntitlements(workspaceId?: string | null, enabled = true) {
  const qc = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const context = workspaceId ?? 'personal';
  const query = useQuery({
    queryKey: entitlementsKey(context),
    queryFn: () => fetchEntitlements(workspaceId ?? null),
    enabled: enabled && isAuthenticated,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  useRealtime({
    onEntitlementsChanged: () => {
      void qc.invalidateQueries({ queryKey: entitlementsRootKey });
    },
    onReconnect: () => {
      void qc.invalidateQueries({ queryKey: entitlementsRootKey });
    },
  });
  return query;
}

export interface EntitlementView {
  loading: boolean;
  dto: EntitlementValueDto | null;
  kind: EntitlementValueDto['kind'] | null;
  unit: EntitlementValueDto['unit'];
  /** Потолок; null — без ограничения (или снимок ещё не пришёл) */
  value: number | boolean | null;
  used: number | null;
  remaining: number | null;
  /** 0..1 (0, если считать не по чему) */
  ratio: number;
  unlimited: boolean;
  /** Фича включена / лимит ещё не достигнут */
  allowed: boolean;
  /** Действие создания предлагать нельзя: на лимите, квота исчерпана или фича выключена */
  blocked: boolean;
  unlock: EntitlementUnlockDto;
  source: EntitlementValueDto['source'] | null;
  sourceKind: EntitlementValueDto['sourceKind'];
  sourceUntil: string | null;
  labelKey: string;
}

export function viewOf(snapshot: EntitlementSnapshotDto | undefined, key: EntitlementKey, loading: boolean): EntitlementView {
  const def = ENTITLEMENT_REGISTRY[key];
  const dto = snapshot?.values?.[key] ?? null;
  if (!dto) {
    return {
      loading,
      dto: null,
      kind: null,
      unit: def.unit ?? null,
      value: null,
      used: null,
      remaining: null,
      ratio: 0,
      unlimited: false,
      allowed: true,
      blocked: false,
      unlock: EMPTY_UNLOCK,
      source: null,
      sourceKind: null,
      sourceUntil: null,
      labelKey: def.labelKey,
    };
  }
  const numeric = typeof dto.value === 'number' ? dto.value : null;
  const unlimited = dto.kind !== 'feature' && dto.value === null;
  const used = dto.used;
  const ratio = numeric !== null && numeric > 0 && used !== null ? Math.min(1, used / numeric) : numeric === 0 ? 1 : 0;
  const allowed = dto.kind === 'feature' ? dto.value === true : unlimited || numeric === null || used === null || used < numeric;
  return {
    loading: false,
    dto,
    kind: dto.kind,
    unit: dto.unit,
    value: dto.value,
    used,
    remaining: numeric !== null && used !== null ? Math.max(0, numeric - used) : null,
    ratio,
    unlimited,
    allowed,
    blocked: !allowed,
    unlock: dto.unlock,
    source: dto.source,
    sourceKind: dto.sourceKind,
    sourceUntil: dto.sourceUntil,
    labelKey: def.labelKey,
  };
}

/** Одно значение снимка с готовыми производными для замка и счётчика. */
export function useEntitlement(key: EntitlementKey, workspaceId?: string | null): EntitlementView {
  const q = useEntitlements(workspaceId);
  return viewOf(q.data, key, q.isPending);
}

export function invalidateEntitlements(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: entitlementsRootKey });
}

/**
 * Отказ тарифа (402): тост с переведённым текстом сервера и инвалидация снимка —
 * счётчик у действия догоняет правду. Возвращает true, если ошибка была тарифной.
 */
export function useEntitlementDenied(): (err: unknown) => boolean {
  const qc = useQueryClient();
  return useCallback(
    (err: unknown) => {
      if (!isAxiosError(err) || err.response?.status !== 402) return false;
      toastError(apiErrorMessage(err));
      invalidateEntitlements(qc);
      return true;
    },
    [qc],
  );
}
