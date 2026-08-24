import { apiGet, apiGetRaw, apiPost, apiPut } from '@/lib/api';
import type {
  CreateCampaignInput,
  CreateHrActionInput,
  CreateHrBatchInput,
  DocCampaignDetailDto,
  DocCampaignDto,
  EmploymentDto,
  EsutdSubmissionDto,
  HrActionBatchDto,
  HrActionDto,
  HrActorLite,
  HrDeadlinesDto,
  HrLibraryItemDto,
  HrMemberCardDto,
  HrRosterOverviewDto,
  MyCampaignTaskDto,
  PersonalDocRecordDto,
  UpsertEmploymentInput,
} from '@superapp/shared';

// ============================================================
// КЭДО — фетчеры провода (типы shared стоят на обеих сторонах).
// ============================================================

const base = (wsId: string) => `/workspaces/${wsId}/hr`;

export const fetchHrMemberCard = (wsId: string, userId: string) =>
  apiGet<HrMemberCardDto>(`${base(wsId)}/members/${userId}`);

export const upsertEmployment = (wsId: string, userId: string, dto: UpsertEmploymentInput) =>
  apiPut<EmploymentDto>(`${base(wsId)}/members/${userId}/employment`, dto);

export const createHrAction = (wsId: string, dto: CreateHrActionInput) =>
  apiPost<HrActionDto>(`${base(wsId)}/actions`, dto);

export const cancelHrAction = (wsId: string, actionId: string) =>
  apiPost<HrActionDto>(`${base(wsId)}/actions/${actionId}/cancel`);

/**
 * ZIP-выгрузки — БАЙТАМИ через транспорт с токеном (урок ревью core/sign):
 * простой ссылкой их не забрать — навигация браузера не несёт Authorization,
 * и «Личное дело (ZIP)» по href отвечало бы 401 вместо архива.
 */
export const fetchPersonalFileZip = (wsId: string, userId: string) =>
  apiGetRaw<Blob>(`${base(wsId)}/export/personal-file/${userId}`, { responseType: 'blob' });

export const fetchHrRegistryZip = (wsId: string) =>
  apiGetRaw<Blob>(`${base(wsId)}/export/registry`, { responseType: 'blob' });

/** Отдать пользователю готовые байты файлом (копия saveBlob движка подписи) */
export function saveHrBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Освобождаем адрес не сразу: Safari успевает начать скачивание не мгновенно.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const fetchHrDeadlines = (wsId: string) => apiGet<HrDeadlinesDto>(`${base(wsId)}/deadlines`);

export const fetchHrDeadlinesCount = (wsId: string) =>
  apiGet<{ count: number }>(`${base(wsId)}/deadlines/count`);

export const fetchHrRosterOverview = (wsId: string) =>
  apiGet<HrRosterOverviewDto>(`${base(wsId)}/roster-overview`);

export const fetchEsutd = (wsId: string) =>
  apiGet<{ items: EsutdSubmissionDto[]; actors: Record<string, HrActorLite> }>(`${base(wsId)}/esutd`);

export const fetchEsutdPayload = (wsId: string, id: string) =>
  apiGet<Record<string, unknown>>(`${base(wsId)}/esutd/${id}/payload`);

export const markEsutdSubmitted = (wsId: string, id: string, externalNumber?: string) =>
  apiPost<EsutdSubmissionDto>(`${base(wsId)}/esutd/${id}/submitted`, externalNumber ? { externalNumber } : {});

export const markEsutdNotRequired = (wsId: string, id: string) =>
  apiPost<EsutdSubmissionDto>(`${base(wsId)}/esutd/${id}/not-required`);

export const fetchHrLibrary = (wsId: string) => apiGet<HrLibraryItemDto[]>(`${base(wsId)}/library`);

export const installHrLibraryItem = (
  wsId: string,
  dto: { key: string; signerUserId?: string; signerPositionId?: string },
) => apiPost<HrLibraryItemDto>(`${base(wsId)}/library/install`, dto);

export const createHrBatch = (wsId: string, dto: CreateHrBatchInput) =>
  apiPost<HrActionBatchDto>(`${base(wsId)}/batches`, dto);

export const fetchHrBatch = (wsId: string, batchId: string) =>
  apiGet<HrActionBatchDto>(`${base(wsId)}/batches/${batchId}`);

// ---- Кампании ознакомления ----

export const fetchCampaigns = (wsId: string) =>
  apiGet<{ items: DocCampaignDto[] }>(`/workspaces/${wsId}/doc-campaigns`);

export const fetchCampaignDetail = (wsId: string, campaignId: string) =>
  apiGet<DocCampaignDetailDto>(`/workspaces/${wsId}/doc-campaigns/${campaignId}`);

export const createCampaign = (wsId: string, dto: CreateCampaignInput) =>
  apiPost<DocCampaignDto>(`/workspaces/${wsId}/doc-campaigns`, dto);

export const cancelCampaign = (wsId: string, campaignId: string) =>
  apiPost<void>(`/workspaces/${wsId}/doc-campaigns/${campaignId}/cancel`);

/** «Догнать аудиторию сейчас» (standing): материализация джобом, не ждать ночного крона */
export const sweepCampaign = (wsId: string, campaignId: string) =>
  apiPost<void>(`/workspaces/${wsId}/doc-campaigns/${campaignId}/sweep`);

/** Недоставленная SMS — отдельный исход, а не «не ознакомился» (Менеджер+) */
export const markCampaignSmsFailed = (wsId: string, campaignId: string, userId: string) =>
  apiPost<void>(`/workspaces/${wsId}/doc-campaigns/${campaignId}/targets/${userId}/sms-failed`);

export const acknowledgeCampaign = (campaignId: string) =>
  apiPost<void>(`/doc-campaigns/${campaignId}/acknowledge`);

export const fetchMyCampaignTask = (documentId: string) =>
  apiGet<MyCampaignTaskDto | null>(`/doc-campaigns/my-task?documentId=${encodeURIComponent(documentId)}`);

// ---- Личный архив ----

export const fetchMyHrDocuments = () => apiGet<{ items: PersonalDocRecordDto[] }>(`/hr/my-documents`);
