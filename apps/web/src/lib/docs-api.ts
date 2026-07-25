// ============================================================
// Docs Engine (core/docs) — клиент. Документ = ЖИВОЙ файл: id вложения не меняется,
// поэтому чат и задача продолжают отдавать актуальное содержимое сами по себе.
// ============================================================

import { api } from './api';
import { documentFormatForFile } from '@superapp/shared';
import type {
  DocsStatusDto,
  DocumentDto,
  DocumentOpenDto,
  DocumentVersionDto,
} from '@superapp/shared';

/** Место, откуда человек пришёл к документу — от него наследуется ПРАВКА */
export interface DocsPlace {
  refType: string;
  refId: string;
}

export async function getDocsStatus(): Promise<DocsStatusDto> {
  const res = await api.get('/docs/status');
  return res.data.data;
}

/** Оживить файл в документ (идемпотентно: у файла один документ навсегда) */
export async function createDocumentFromFile(input: {
  fileId: string;
  title?: string;
  refType?: string;
  refId?: string;
}): Promise<DocumentDto> {
  const res = await api.post('/docs/from-file', input);
  return res.data.data;
}

export async function getDocument(id: string, place?: DocsPlace | null): Promise<DocumentDto> {
  const res = await api.get(`/docs/${id}`, { params: place ?? undefined });
  return res.data.data;
}

export async function openDocument(
  id: string,
  input: { refType?: string; refId?: string; readonly?: boolean },
): Promise<DocumentOpenDto> {
  const res = await api.post(`/docs/${id}/open`, input);
  return res.data.data;
}

export async function listDocumentVersions(
  id: string,
  place?: DocsPlace | null,
): Promise<DocumentVersionDto[]> {
  const res = await api.get(`/docs/${id}/versions`, { params: place ?? undefined });
  return res.data.data;
}

export async function saveDocumentVersion(id: string): Promise<void> {
  await api.post(`/docs/${id}/versions`, { reason: 'manual' });
}

export async function setDocumentMode(id: string, mode: 'edit' | 'readonly'): Promise<DocumentDto> {
  const res = await api.patch(`/docs/${id}`, { mode });
  return res.data.data;
}

/** Можно ли этот файл открыть в редакторе (формат из реестра движка) */
export function isEditableDocument(file: { name?: string | null; mime?: string | null }): boolean {
  return !!documentFormatForFile(file);
}

/**
 * Ссылка на страницу документа: место (от него наследуется право правки) + режим.
 * `readonly` — осознанный выбор человека «просто посмотреть»: он ОГРАНИЧИВАЕТ права,
 * а не расширяет, поэтому в адресе ему место (сервер всё равно решает потолок сам).
 */
export function documentHref(
  documentId: string,
  place?: DocsPlace | null,
  opts?: { readonly?: boolean },
): string {
  const params = new URLSearchParams();
  if (place) {
    params.set('refType', place.refType);
    params.set('refId', place.refId);
  }
  if (opts?.readonly) params.set('readonly', '1');
  const query = params.toString();
  return `/docs/${documentId}${query ? `?${query}` : ''}`;
}
