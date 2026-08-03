import type {
  ShareLinkActorLite,
  ShareLinkDto,
  ShareLinkMineDto,
  ShareLinkStatsDto,
  ShareLinksPage,
  ShareLinkVisitDto,
} from '@superapp/shared';
import { api } from './api';

// ============================================================
// Управление гостевыми ссылками (для того, кто внутри платформы).
// Гостевая половина живёт в lib/public-api.ts — у неё свой клиент без перехватчиков.
// ============================================================

export async function fetchShareLinks(refType: string, refId: string): Promise<ShareLinksPage> {
  const { data } = await api.get('/share-links', { params: { refType, refId } });
  return { items: data.data, total: data.total ?? data.data.length };
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
  const { data } = await api.post('/share-links', body);
  return data.data;
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
  const { data } = await api.patch(`/share-links/${id}`, body);
  return data.data;
}

export async function revokeShareLink(id: string): Promise<ShareLinkDto> {
  const { data } = await api.post(`/share-links/${id}/revoke`);
  return data.data;
}

export async function fetchShareLinkVisits(id: string): Promise<ShareLinkVisitDto[]> {
  const { data } = await api.get(`/share-links/${id}/visits`);
  return data.data;
}

/** Сменить адрес, сохранив настройки и журнал: старый адрес умирает сразу */
export async function rotateShareLink(id: string): Promise<ShareLinkDto> {
  const { data } = await api.post(`/share-links/${id}/rotate`);
  return data.data;
}

// ============================================================
// «Мои ссылки» — всё, что человек раздал наружу, из всех сервисов сразу
// ============================================================

export async function fetchMyShareLinks(params: {
  status?: 'active' | 'inactive' | 'all';
  cursor?: string;
}): Promise<{ items: ShareLinkMineDto[]; nextCursor: string | null }> {
  const { data } = await api.get('/share-links/mine', { params });
  return { items: data.data, nextCursor: data.nextCursor ?? null };
}

export async function fetchMyShareStats(): Promise<ShareLinkStatsDto> {
  const { data } = await api.get('/share-links/mine/stats');
  return data.data;
}

export async function revokeMyShareLinks(ids: string[]): Promise<number> {
  const { data } = await api.post('/share-links/mine/revoke', { ids });
  return data.data.revoked;
}

// ============================================================
// «Ссылки организации» — всё, что раздала наружу команда (Менеджер+)
// ============================================================

export async function fetchWorkspaceShareLinks(
  workspaceId: string,
  params: { status?: 'active' | 'inactive' | 'all'; cursor?: string },
): Promise<{ items: ShareLinkMineDto[]; nextCursor: string | null; actors: Record<string, ShareLinkActorLite> }> {
  const { data } = await api.get(`/workspaces/${workspaceId}/share-links`, { params });
  return { items: data.data, nextCursor: data.nextCursor ?? null, actors: data.actors ?? {} };
}

export async function fetchWorkspaceShareStats(workspaceId: string): Promise<ShareLinkStatsDto> {
  const { data } = await api.get(`/workspaces/${workspaceId}/share-links/stats`);
  return data.data;
}

/** Отзыв ЧУЖИХ ссылок организации — то, ради чего раздел и заводится (уволенный автор) */
export async function revokeWorkspaceShareLinks(workspaceId: string, ids: string[]): Promise<number> {
  const { data } = await api.post(`/workspaces/${workspaceId}/share-links/revoke`, { ids });
  return data.data.revoked;
}
