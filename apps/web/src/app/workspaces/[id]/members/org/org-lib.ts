'use client';

// ============================================================
// Общее для витрины «Орг. структура»: выбор на схеме, инвалидация после мутаций,
// подписи людей и периодов. Мутации структуры идут через фетчеры lib/org-api
// (PATCH справочников /staff и ручки /org); после любой — один общий refresh.
// ============================================================

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage } from '@/lib/api';
import { invalidateEntities } from '@/lib/entities';
import { orgRootKey, workspaceMembersKey, workspaceStaffKey } from '@/lib/queries';
import { toastError } from '@/lib/toast';
import type { OrgChartDto, OrgManagerDto, OrgPersonLite } from '@superapp/shared';

/** Что выбрано на схеме: должность, рамка отдела, объект (из фильтра), панель «Вне структуры». */
export type OrgSelection =
  | { type: 'position'; id: string }
  | { type: 'department'; id: string }
  | { type: 'branch'; id: string }
  | { type: 'unassigned' };

/** Цель фокуса из адреса `?focus=position:<id>|department:<id>|user:<id>` */
export interface OrgFocusTarget {
  type: 'position' | 'department' | 'user';
  id: string;
}

export function parseFocus(raw: string | null): OrgFocusTarget | null {
  if (!raw) return null;
  const i = raw.indexOf(':');
  if (i <= 0) return null;
  const type = raw.slice(0, i);
  const id = raw.slice(i + 1);
  if (!id || (type !== 'position' && type !== 'department' && type !== 'user')) return null;
  return { type, id };
}

/** Узел схемы, на который ведёт цель фокуса (человек → его первая должность). */
export function focusNodeId(chart: OrgChartDto, target: OrgFocusTarget | null): string | null {
  if (!target) return null;
  if (target.type === 'position') return chart.positions.some((p) => p.id === target.id) ? target.id : null;
  if (target.type === 'user') {
    const p = chart.positions.find((x) => x.holders.some((h) => h.userId === target.id));
    return p?.id ?? null;
  }
  // Отдел: рамка (если нарисована — решает канвас) либо первая должность отдела
  return `dept:${target.id}`;
}

export const personName = (p: OrgPersonLite | undefined, fallback = 'Без имени'): string =>
  p ? `${p.firstName} ${p.lastName ?? ''}`.trim() || fallback : fallback;

/**
 * Человек — вершина структуры: вертикаль упёрлась в корень, и фолбэк вернул ЕГО САМОГО
 * (владелец организации). Сервер отдаёт это честно (`reason: 'owner_fallback'`, движки
 * трактуют как «решает владелец»), но показывать человеку его же карточку в графе
 * «Мой руководитель» нельзя. Одно определение на все витрины: профиль и мобильное
 * дерево расходились — на десктопе стояла заглушка, на телефоне человек видел себя.
 */
export const isTopOfStructure = (manager: Pick<OrgManagerDto, 'reason' | 'userIds'>, userId: string): boolean =>
  manager.reason === 'owner_fallback' && manager.userIds.length === 1 && manager.userIds[0] === userId;

/**
 * Инвалидация после любой правки структуры: снимок схемы (orgRootKey — чарт всех
 * объектов, «вне структуры», заместители, «место в структуре»), ростер и справочники,
 * кэш EntitySelector четырёх типов.
 */
export function useOrgRefresh(workspaceId: string) {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: orgRootKey(workspaceId) });
    qc.invalidateQueries({ queryKey: workspaceStaffKey(workspaceId) });
    qc.invalidateQueries({ queryKey: workspaceMembersKey(workspaceId) });
    invalidateEntities('position');
    invalidateEntities('department');
    invalidateEntities('branch');
    invalidateEntities('user');
  }, [qc, workspaceId]);
}

/** Единый обработчик ошибки API: текст сервера всплывашкой (400/403/409 — все). */
export const showApiError = (e: unknown) => toastError(apiErrorMessage(e));
