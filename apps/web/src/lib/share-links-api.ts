import type {
  ShareLinkDto,
  ShareLinkMinePage,
  ShareLinkOrgPage,
  ShareLinkStatsDto,
  ShareLinksPage,
  ShareLinkVisitsPage,
} from '@superapp/shared';
import { apiGet, apiPatch, apiPost } from './api';

// ============================================================
// Управление гостевыми ссылками (для того, кто внутри платформы).
// Гостевая половина живёт в lib/public-api.ts — у неё свой клиент без перехватчиков.
// ============================================================

export async function fetchShareLinks(refType: string, refId: string): Promise<ShareLinksPage> {
  return apiGet<ShareLinksPage>('/share-links', { params: { refType, refId } });
}

export interface CreateShareLinkBody {
  refType: string;
  refId: string;
  label?: string;
  expiresAt?: string;
  password?: string;
  maxOpens?: number;
  allowDownload?: boolean;
  notifyOnOpen?: boolean;
  requireIdentity?: boolean;
}

export async function createShareLink(body: CreateShareLinkBody): Promise<ShareLinkDto> {
  return apiPost<ShareLinkDto>('/share-links', body);
}

/** null очищает поле, отсутствие ключа — сохраняет как было (тумблеры не очищаются, только меняются) */
export interface UpdateShareLinkBody {
  label?: string | null;
  expiresAt?: string | null;
  password?: string | null;
  maxOpens?: number | null;
  allowDownload?: boolean;
  notifyOnOpen?: boolean;
  requireIdentity?: boolean;
}

export async function updateShareLink(id: string, body: UpdateShareLinkBody): Promise<ShareLinkDto> {
  return apiPatch<ShareLinkDto>(`/share-links/${id}`, body);
}

export async function revokeShareLink(id: string): Promise<ShareLinkDto> {
  return apiPost<ShareLinkDto>(`/share-links/${id}/revoke`);
}

export async function fetchShareLinkVisits(id: string): Promise<ShareLinkVisitsPage> {
  return apiGet<ShareLinkVisitsPage>(`/share-links/${id}/visits`);
}

/** Сменить адрес, сохранив настройки и журнал: старый адрес умирает сразу */
export async function rotateShareLink(id: string): Promise<ShareLinkDto> {
  return apiPost<ShareLinkDto>(`/share-links/${id}/rotate`);
}

// ============================================================
// «Мои ссылки» — всё, что человек раздал наружу, из всех сервисов сразу
// ============================================================

export async function fetchMyShareLinks(params: {
  status?: 'active' | 'inactive' | 'all';
  cursor?: string;
}): Promise<ShareLinkMinePage> {
  return apiGet<ShareLinkMinePage>('/share-links/mine', { params });
}

export async function fetchMyShareStats(): Promise<ShareLinkStatsDto> {
  return apiGet<ShareLinkStatsDto>('/share-links/mine/stats');
}

export async function revokeMyShareLinks(ids: string[]): Promise<number> {
  return (await apiPost<{ revoked: number }>('/share-links/mine/revoke', { ids })).revoked;
}

// ============================================================
// «Ссылки организации» — всё, что раздала наружу команда (Менеджер+)
// ============================================================

export async function fetchWorkspaceShareLinks(
  workspaceId: string,
  params: { status?: 'active' | 'inactive' | 'all'; cursor?: string },
): Promise<ShareLinkOrgPage> {
  return apiGet<ShareLinkOrgPage>(`/workspaces/${workspaceId}/share-links`, { params });
}

export async function fetchWorkspaceShareStats(workspaceId: string): Promise<ShareLinkStatsDto> {
  return apiGet<ShareLinkStatsDto>(`/workspaces/${workspaceId}/share-links/stats`);
}

/** Отзыв ЧУЖИХ ссылок организации — то, ради чего раздел и заводится (уволенный автор) */
export async function revokeWorkspaceShareLinks(workspaceId: string, ids: string[]): Promise<number> {
  return (await apiPost<{ revoked: number }>(`/workspaces/${workspaceId}/share-links/revoke`, { ids })).revoked;
}
