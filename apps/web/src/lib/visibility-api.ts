// Правила видимости (core/visibility): личная политика карточки и находимость, план зрителя
// для таблиц (R14), раскрытие ОДНОЙ записи, окно «сильного подтверждения», политика
// организации (матрица, черновик, дифф, публикация, версии, «Проверить сотрудника»).
// Организация — в адресе маршрута (владелец/админ проверяет сервер).
import type {
  ContactUserCard,
  DiscoverableBy,
  PersonalVisibilityDto,
  PersonalVisibilityInput,
  StepUpWindowPurpose,
  VisibilityDiffDto,
  VisibilityDraftInput,
  VisibilityExplainDto,
  VisibilityPlanDto,
  VisibilityPolicyDto,
  VisibilityPolicyVersionDto,
  VisibilityPresetKey,
  VisibilityPreviewQuery,
  VisibilityPublishResultDto,
  VisibilityRevealInput,
  VisibilityRevealResultDto,
  VisibilityStepUpStatusDto,
  VisibilityTypeMetaDto,
  VisibilityWorkspaceOverviewDto,
  Workspace,
  WorkspaceRole,
  WorkspaceVisibilitySettingsDto,
  WorkspaceVisibilitySettingsInput,
} from '@superapp/shared';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from './api';

// ---- Реестр и план зрителя ----
export const fetchVisibilityTypes = () => apiGet<VisibilityTypeMetaDto[]>('/visibility/types');
export const fetchVisibilityPlan = (recordType: string) => apiGet<VisibilityPlanDto>('/visibility/plan', { params: { recordType } });

// ---- Раскрытие (ответ не кэшируется: живёт в памяти вкладки до showUntil) ----
export const revealFields = (input: VisibilityRevealInput) => apiPost<VisibilityRevealResultDto>('/visibility/reveal', input);

// ---- Окно «сильного подтверждения» (core/verify) ----
export const fetchStepUp = (purpose: StepUpWindowPurpose) => apiGet<VisibilityStepUpStatusDto>('/verify/step-up/status', { params: { purpose } });
export const confirmStepUp = (purpose: StepUpWindowPurpose, verifyToken: string) => apiPost<{ until: string }>('/verify/step-up/confirm', { purpose, verifyToken });
export const endStepUp = (purpose: StepUpWindowPurpose) => apiPost<{ until: null }>('/verify/step-up/end', { purpose });

// ---- Моя карточка и видимость ----
export const fetchMyVisibility = () => apiGet<PersonalVisibilityDto>('/visibility/me');
export const updateMyVisibility = (input: PersonalVisibilityInput) => apiPut<PersonalVisibilityDto>('/visibility/me', input);
export const resetMyVisibility = (fieldKeys: string[]) => apiPost<PersonalVisibilityDto>('/visibility/me/reset', { fieldKeys });
export const setMyDiscoverability = (discoverableBy: DiscoverableBy) => apiPut<PersonalVisibilityDto>('/visibility/me/discoverability', { discoverableBy });
export const setCircleVisibility = (circleId: string, fields: Record<string, boolean | null>) =>
  apiPut<PersonalVisibilityDto>(`/visibility/me/circles/${circleId}`, { fields });
export const fetchCardPreview = (q: VisibilityPreviewQuery) => apiGet<ContactUserCard>('/users/me/card-preview', { params: q });

// ---- Политика организации ----
const ws = (id: string) => `/workspaces/${id}/visibility`;
const pol = (id: string, recordType: string) => `${ws(id)}/policies/${encodeURIComponent(recordType)}`;

/** Анкета организации глазами роли — решение движка, не эмуляция на клиенте (владелец/админ). */
export const fetchWorkspaceCardPreview = (wsId: string, role: WorkspaceRole) => apiGet<Workspace>(`/workspaces/${wsId}/card-preview`, { params: { role } });
export const fetchVisibilityOverview = (wsId: string) => apiGet<VisibilityWorkspaceOverviewDto>(`${ws(wsId)}/overview`);
export const fetchVisibilityPolicy = (wsId: string, recordType: string, status: 'published' | 'draft') =>
  apiGet<VisibilityPolicyDto | null>(pol(wsId, recordType), { params: { status } });
export const saveVisibilityDraft = (wsId: string, recordType: string, input: VisibilityDraftInput) => apiPut<VisibilityPolicyDto>(`${pol(wsId, recordType)}/draft`, input);
export const discardVisibilityDraft = (wsId: string, recordType: string) => apiDelete<{ discarded: true }>(`${pol(wsId, recordType)}/draft`);
export const fetchVisibilityDiff = (wsId: string, recordType: string) => apiGet<VisibilityDiffDto>(`${pol(wsId, recordType)}/diff`);
export const publishVisibilityPolicy = (wsId: string, recordType: string, draftToken: string, idempotencyKey?: string) =>
  apiPost<VisibilityPublishResultDto>(`${pol(wsId, recordType)}/publish`, { draftToken }, { idempotencyKey });
export const fetchVisibilityVersions = (wsId: string, recordType: string) => apiGet<VisibilityPolicyVersionDto[]>(`${pol(wsId, recordType)}/versions`);
export const restoreVisibilityVersion = (wsId: string, recordType: string, version: number) => apiPost<VisibilityPolicyDto>(`${pol(wsId, recordType)}/restore`, { version });
export const applyVisibilityPreset = (wsId: string, preset: VisibilityPresetKey) => apiPost<VisibilityPolicyDto[]>(`${ws(wsId)}/presets`, { preset });
export const fetchVisibilitySettings = (wsId: string) => apiGet<WorkspaceVisibilitySettingsDto>(`${ws(wsId)}/settings`);
export const updateVisibilitySettings = (wsId: string, input: WorkspaceVisibilitySettingsInput) => apiPatch<WorkspaceVisibilitySettingsDto>(`${ws(wsId)}/settings`, input);
export const fetchVisibilityExplain = (wsId: string, q: { recordType: string; viewerId: string; subjectId?: string }) =>
  apiGet<VisibilityExplainDto>(`${ws(wsId)}/explain`, { params: q });
export const liftRevealPause = (wsId: string, userId: string) => apiPost<{ lifted: true }>(`${ws(wsId)}/reveal-pause/${userId}/lift`, {});
