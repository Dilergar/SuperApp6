import type { ShareLinkDto, ShareLinksPage, ShareLinkVisitDto } from '@superapp/shared';
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
}

export async function createShareLink(body: CreateShareLinkBody): Promise<ShareLinkDto> {
  const { data } = await api.post('/share-links', body);
  return data.data;
}

/** null очищает поле, отсутствие ключа — сохраняет как было */
export interface UpdateShareLinkBody {
  label?: string | null;
  expiresAt?: string | null;
  password?: string | null;
  maxOpens?: number | null;
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
