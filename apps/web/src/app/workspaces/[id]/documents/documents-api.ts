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
  ProcessDefinitionDto,
  ProcessDefinitionDetailDto,
} from '@superapp/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';

const base = (wsId: string) => `/workspaces/${wsId}/documents`;

export async function fetchDocTypes(wsId: string): Promise<DocTypeDto[]> {
  return await apiGet(`${base(wsId)}/doc-types`);
}

export async function fetchDocTemplates(wsId: string): Promise<DocTemplateDto[]> {
  return await apiGet(`${base(wsId)}/templates`);
}

export async function fetchAvailableTemplates(wsId: string): Promise<AvailableTemplateDto[]> {
  return await apiGet(`${base(wsId)}/available-templates`);
}

export async function fetchOrgDocuments(
  wsId: string,
  params: Record<string, string | number | undefined>,
): Promise<OrgDocumentListDto> {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  return await apiGet(base(wsId), { params: clean });
}

export async function fetchOrgDocument(wsId: string, docId: string): Promise<OrgDocumentDto> {
  return await apiGet(`${base(wsId)}/${docId}`);
}

export async function fetchTemplateFieldGroups(): Promise<TemplateFieldGroupDto[]> {
  return (await apiGet<{ groups: TemplateFieldGroupDto[] }>('/templates/field-groups')).groups;
}

/**
 * Кому выдан бланк. Тип берём ОБЩИЙ (`DocTemplateGrantDto`), а не переобъявляем
 * свой: местный урезанный тип уже однажды спрятал расхождение — сервер поля `label`
 * не отдавал, а список рисовал вид принципала вместо имени получателя.
 */
export async function fetchTemplateGrants(wsId: string, tplId: string): Promise<DocTemplateGrantDto[]> {
  return await apiGet(`${base(wsId)}/templates/${tplId}/grants`);
}

/**
 * Найти процесс, который уже слушает отправку по этому шаблону. Связь «шаблон →
 * маршрут» живёт в конфиге триггер-ноды опубликованного процесса, поэтому ищем по
 * списку процессов организации, а не по своей таблице.
 */
export async function findRouteDefinitionId(wsId: string, templateId: string): Promise<string | null> {
  const list = await apiGet<Pick<ProcessDefinitionDto, 'id'>[]>(`/workspaces/${wsId}/processes`);
  for (const def of list) {
    const detail = await apiGet<ProcessDefinitionDetailDto>(`/workspaces/${wsId}/processes/${def.id}`);
    // Ноды теперь типизированы (ProcessNode), а не Record<string, unknown>.
    const hit = (detail.document?.nodes ?? []).some(
      (n) => n.type === 'trigger.document' && n.config?.templateId === templateId,
    );
    if (hit) return def.id;
  }
  return null;
}

export const documentsApi = {
  base,
  createType: (wsId: string, body: Record<string, unknown>) => apiPost(`${base(wsId)}/doc-types`, body),
  updateType: (wsId: string, typeId: string, body: Record<string, unknown>) =>
    apiPatch(`${base(wsId)}/doc-types/${typeId}`, body),
  archiveType: (wsId: string, typeId: string) => apiDelete(`${base(wsId)}/doc-types/${typeId}`),

  createTemplate: (wsId: string, body: Record<string, unknown>) =>
    apiPost<DocTemplateDto>(`${base(wsId)}/templates`, body),
  updateTemplate: (wsId: string, tplId: string, body: Record<string, unknown>) =>
    apiPatch(`${base(wsId)}/templates/${tplId}`, body),
  publishTemplate: (wsId: string, tplId: string) => apiPost(`${base(wsId)}/templates/${tplId}/publish`),
  addGrant: (wsId: string, tplId: string, body: { principalType: string; principalId: string }) =>
    apiPost(`${base(wsId)}/templates/${tplId}/grants`, body),
  removeGrant: (wsId: string, tplId: string, principalType: string, principalId: string) =>
    apiDelete(`${base(wsId)}/templates/${tplId}/grants/${principalType}/${principalId}`),

  createDocument: (wsId: string, body: Record<string, unknown>) => apiPost<OrgDocumentDto>(base(wsId), body),
  updateDocument: (wsId: string, docId: string, body: Record<string, unknown>) =>
    apiPatch(`${base(wsId)}/${docId}`, body),
  submit: (wsId: string, docId: string) => apiPost(`${base(wsId)}/${docId}/submit`),
  cancel: (wsId: string, docId: string) => apiPost(`${base(wsId)}/${docId}/cancel`),
  /** Вернуть с маршрута в черновик — пока по документу никто не начал решать */
  withdraw: (wsId: string, docId: string) => apiPost(`${base(wsId)}/${docId}/withdraw`),
  requestPdf: (wsId: string, docId: string) => apiPost(`${base(wsId)}/${docId}/pdf`),
};
