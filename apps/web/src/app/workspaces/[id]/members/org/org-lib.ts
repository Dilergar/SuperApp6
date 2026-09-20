'use client';

// ============================================================
// Общее для витрины «Орг. структура»: выбор на схеме, инвалидация после мутаций,
// подписи людей и периодов. Мутации структуры идут через фетчеры lib/org-api
// (PATCH справочников /staff и ручки /org); после любой — один общий refresh.
// ============================================================

import { useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { dm } from '@/lib/dates';
import { invalidateEntities } from '@/lib/entities';
import { orgRootKey, workspaceMembersKey, workspaceStaffKey } from '@/lib/queries';

import type { OrgLayoutLabels } from './org-layout';
import type { OrgChartDto, OrgManagerDto, OrgPersonLite } from '@superapp/shared';

import { toastApiError } from '@/lib/api-errors';
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

/** Имя человека из лайт-профиля; пусто — фолбэк каталога (язык зрителя). */
export function usePersonName(): (p: OrgPersonLite | undefined) => string {
  const t = useTranslations('staff');
  return useCallback(
    (p: OrgPersonLite | undefined) => (p ? `${p.firstName} ${p.lastName ?? ''}`.trim() || t('noName') : t('noName')),
    [t],
  );
}

/** Подпись периода замещения: «01.09–15.09», «с 01.09», «до 15.09», «запасной». */
export function useDeputyPeriodLabel(): (startsOn?: string | null, endsOn?: string | null) => string {
  const t = useTranslations('staff');
  return useCallback(
    (startsOn?: string | null, endsOn?: string | null) => {
      if (startsOn && endsOn) return `${dm(startsOn)}–${dm(endsOn)}`;
      if (startsOn) return t('org.deputyFrom', { date: dm(startsOn) });
      if (endsOn) return t('org.deputyUntil', { date: dm(endsOn) });
      return t('org.deputyStanding');
    },
    [t],
  );
}

/** Слова для чистой раскладки схемы (`layoutOrg` языка не знает). */
export function useOrgLayoutLabels(): OrgLayoutLabels {
  const t = useTranslations('staff');
  const deputyPeriod = useDeputyPeriodLabel();
  return useMemo(
    () => ({
      deptAria: (name: string, count: number) => t('org.deptAria', { name, count }),
      positionAria: (name: string, count: number, vacant: boolean) =>
        vacant ? t('org.positionAriaVacant', { name }) : t('org.positionAria', { name, count }),
      deputyPeriod,
    }),
    [t, deputyPeriod],
  );
}

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
export const showApiError = (e: unknown) => toastApiError(e);
