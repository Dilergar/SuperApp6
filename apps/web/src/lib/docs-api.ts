// ============================================================
// Docs Engine (core/docs) — клиент. Документ = ЖИВОЙ файл: id вложения не меняется,
// поэтому чат и задача продолжают отдавать актуальное содержимое сами по себе.
// ============================================================

import { apiGet, apiPatch, apiPost } from './api';
import { DOCS_LIMITS, documentFormatForFile } from '@superapp/shared';
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
  return apiGet<DocsStatusDto>('/docs/status');
}

/** Оживить файл в документ (идемпотентно: у файла один документ навсегда) */
export async function createDocumentFromFile(input: {
  fileId: string;
  title?: string;
  refType?: string;
  refId?: string;
}): Promise<DocumentDto> {
  return apiPost<DocumentDto>('/docs/from-file', input);
}

export async function getDocument(id: string, place?: DocsPlace | null): Promise<DocumentDto> {
  return apiGet<DocumentDto>(`/docs/${id}`, { params: place ?? undefined });
}

export async function openDocument(
  id: string,
  input: { refType?: string; refId?: string; readonly?: boolean },
): Promise<DocumentOpenDto> {
  return apiPost<DocumentOpenDto>(`/docs/${id}/open`, input);
}

export async function listDocumentVersions(
  id: string,
  place?: DocsPlace | null,
): Promise<DocumentVersionDto[]> {
  return apiGet<DocumentVersionDto[]>(`/docs/${id}/versions`, { params: place ?? undefined });
}

/** Место передаём и сюда: право «сохранить версию» = право правки, а оно от места */
export async function saveDocumentVersion(id: string, place?: DocsPlace | null): Promise<void> {
  await apiPost(`/docs/${id}/versions`, { reason: 'manual', ...(place ?? {}) });
}

/** Вернуть веху как текущее содержимое (место — как и везде, несёт право правки) */
export async function restoreDocumentVersion(
  id: string,
  versionId: string,
  place?: DocsPlace | null,
): Promise<void> {
  await apiPost(`/docs/${id}/versions/${versionId}/restore`, { ...(place ?? {}) });
}

export async function setDocumentMode(id: string, mode: 'edit' | 'readonly'): Promise<DocumentDto> {
  return apiPatch<DocumentDto>(`/docs/${id}`, { mode });
}

/**
 * Можно ли этот файл открыть в редакторе: формат из реестра движка И размер в пределах
 * потолка. Потолок проверяем и здесь: сервер откажет всё равно, но лучше не показывать
 * кнопку, которая заведомо ответит отказом — скачивание такому файлу никто не запрещает.
 */
export function isEditableDocument(file: {
  name?: string | null;
  mime?: string | null;
  size?: number | null;
}): boolean {
  if (!documentFormatForFile(file)) return false;
  return !file.size || file.size <= DOCS_LIMITS.openHardLimitBytes;
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
