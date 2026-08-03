// ============================================================
// Сервис «Документы» — тонкий слой запросов раздела.
//
// Держим отдельно от страниц: тем же вызовам ходят карточка документа,
// конструктор шаблона и модалка «Подать заявление», а ключи кэша лежат
// в общем реестре (lib/queries.ts) — иначе мутация обновляла бы свою копию,
// а соседний список жил бы со старой до перезагрузки.
// ============================================================

import type {
  AvailableTemplateDto,
  DocTemplateDto,
  DocTemplateGrantDto,
  DocTypeDto,
  OrgDocumentDto,
  OrgDocumentListDto,
  TemplateFieldGroupDto,
} from '@superapp/shared';
import { api } from '@/lib/api';

const base = (wsId: string) => `/workspaces/${wsId}/documents`;

export async function fetchDocTypes(wsId: string): Promise<DocTypeDto[]> {
  return (await api.get(`${base(wsId)}/doc-types`)).data.data;
}

export async function fetchDocTemplates(wsId: string): Promise<DocTemplateDto[]> {
  return (await api.get(`${base(wsId)}/templates`)).data.data;
}

export async function fetchAvailableTemplates(wsId: string): Promise<AvailableTemplateDto[]> {
  return (await api.get(`${base(wsId)}/available-templates`)).data.data;
}

export async function fetchOrgDocuments(
  wsId: string,
  params: Record<string, string | number | undefined>,
): Promise<OrgDocumentListDto> {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  return (await api.get(base(wsId), { params: clean })).data.data;
}

export async function fetchOrgDocument(wsId: string, docId: string): Promise<OrgDocumentDto> {
  return (await api.get(`${base(wsId)}/${docId}`)).data.data;
}

export async function fetchTemplateFieldGroups(): Promise<TemplateFieldGroupDto[]> {
  return (await api.get('/templates/field-groups')).data.data.groups;
}

/**
 * Кому выдан бланк. Тип берём ОБЩИЙ (`DocTemplateGrantDto`), а не переобъявляем
 * свой: местный урезанный тип уже однажды спрятал расхождение — сервер поля `label`
 * не отдавал, а список рисовал вид принципала вместо имени получателя.
 */
export async function fetchTemplateGrants(wsId: string, tplId: string): Promise<DocTemplateGrantDto[]> {
  return (await api.get(`${base(wsId)}/templates/${tplId}/grants`)).data.data;
}

/**
 * Найти процесс, который уже слушает отправку по этому шаблону. Связь «шаблон →
 * маршрут» живёт в конфиге триггер-ноды опубликованного процесса, поэтому ищем по
 * списку процессов организации, а не по своей таблице.
 */
export async function findRouteDefinitionId(wsId: string, templateId: string): Promise<string | null> {
  const list = (await api.get(`/workspaces/${wsId}/processes`)).data.data as { id: string }[];
  for (const def of list) {
    const detail = (await api.get(`/workspaces/${wsId}/processes/${def.id}`)).data.data as {
      document?: { nodes?: { type: string; config?: Record<string, unknown> }[] };
    };
    const hit = (detail.document?.nodes ?? []).some(
      (n) => n.type === 'trigger.document' && n.config?.templateId === templateId,
    );
    if (hit) return def.id;
  }
  return null;
}

export const documentsApi = {
  base,
  createType: (wsId: string, body: Record<string, unknown>) => api.post(`${base(wsId)}/doc-types`, body),
  updateType: (wsId: string, typeId: string, body: Record<string, unknown>) =>
    api.patch(`${base(wsId)}/doc-types/${typeId}`, body),
  archiveType: (wsId: string, typeId: string) => api.delete(`${base(wsId)}/doc-types/${typeId}`),

  createTemplate: (wsId: string, body: Record<string, unknown>) => api.post(`${base(wsId)}/templates`, body),
  updateTemplate: (wsId: string, tplId: string, body: Record<string, unknown>) =>
    api.patch(`${base(wsId)}/templates/${tplId}`, body),
  publishTemplate: (wsId: string, tplId: string) => api.post(`${base(wsId)}/templates/${tplId}/publish`),
  addGrant: (wsId: string, tplId: string, body: { principalType: string; principalId: string }) =>
    api.post(`${base(wsId)}/templates/${tplId}/grants`, body),
  removeGrant: (wsId: string, tplId: string, principalType: string, principalId: string) =>
    api.delete(`${base(wsId)}/templates/${tplId}/grants/${principalType}/${principalId}`),

  createDocument: (wsId: string, body: Record<string, unknown>) => api.post(base(wsId), body),
  updateDocument: (wsId: string, docId: string, body: Record<string, unknown>) =>
    api.patch(`${base(wsId)}/${docId}`, body),
  submit: (wsId: string, docId: string) => api.post(`${base(wsId)}/${docId}/submit`),
  cancel: (wsId: string, docId: string) => api.post(`${base(wsId)}/${docId}/cancel`),
  /** Вернуть с маршрута в черновик — пока по документу никто не начал решать */
  withdraw: (wsId: string, docId: string) => api.post(`${base(wsId)}/${docId}/withdraw`),
  requestPdf: (wsId: string, docId: string) => api.post(`${base(wsId)}/${docId}/pdf`),
};
