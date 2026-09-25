// ============================================================
// Сроки хранения организации, заморозки, таймер чата (core/lifecycle) — хелперы веба.
// Формы провода — из `@superapp/shared`; своих интерфейсов серверных DTO здесь нет.
// ============================================================

import type {
  ChatDetail,
  CursorPage,
  LifecycleHoldCreateInput,
  LifecycleHoldDto,
  LifecycleHoldStatusDto,
  LifecycleSettingPreviewDto,
  LifecycleSettingUpdateInput,
  LifecycleSettingsClassDto,
  LifecycleSettingsDto,
  LifecycleTenantClass,
  LifecycleWorkspaceSummaryDto,
} from '@superapp/shared';
import { apiDelete, apiGet, apiPost, apiPut } from './api';

export function fetchLifecycleSettings(workspaceId: string): Promise<LifecycleSettingsDto> {
  return apiGet<LifecycleSettingsDto>(`/workspaces/${workspaceId}/lifecycle/settings`);
}

export function fetchLifecycleSummary(workspaceId: string): Promise<LifecycleWorkspaceSummaryDto> {
  return apiGet<LifecycleWorkspaceSummaryDto>(`/workspaces/${workspaceId}/lifecycle/summary`);
}

export function previewLifecycleSetting(workspaceId: string, input: LifecycleSettingUpdateInput): Promise<LifecycleSettingPreviewDto> {
  return apiPost<LifecycleSettingPreviewDto>(`/workspaces/${workspaceId}/lifecycle/settings/preview`, input);
}

export function updateLifecycleSetting(workspaceId: string, input: LifecycleSettingUpdateInput): Promise<LifecycleSettingsClassDto> {
  return apiPut<LifecycleSettingsClassDto>(`/workspaces/${workspaceId}/lifecycle/settings`, input);
}

export function cancelLifecyclePending(workspaceId: string, dataClass: LifecycleTenantClass): Promise<LifecycleSettingsClassDto> {
  return apiDelete<LifecycleSettingsClassDto>(`/workspaces/${workspaceId}/lifecycle/settings/${dataClass}/pending`);
}

export function fetchWorkspaceHolds(workspaceId: string, params: { cursor?: string; active?: boolean } = {}): Promise<CursorPage<LifecycleHoldDto>> {
  return apiGet<CursorPage<LifecycleHoldDto>>(`/workspaces/${workspaceId}/lifecycle/holds`, {
    params: { ...(params.cursor ? { cursor: params.cursor } : {}), ...(params.active ? { active: 'true' } : {}) },
  });
}

/** Запись под заморозкой своей организации? (`type` — `user` или id политики реестра) */
export function fetchHoldStatus(workspaceId: string, type: string, id: string): Promise<LifecycleHoldStatusDto> {
  return apiGet<LifecycleHoldStatusDto>(`/workspaces/${workspaceId}/lifecycle/holds/status`, { params: { type, id } });
}

export function createWorkspaceHold(workspaceId: string, input: LifecycleHoldCreateInput): Promise<LifecycleHoldDto> {
  return apiPost<LifecycleHoldDto>(`/workspaces/${workspaceId}/lifecycle/holds`, input);
}

export function releaseWorkspaceHold(workspaceId: string, holdId: string, note?: string): Promise<LifecycleHoldDto> {
  return apiPost<LifecycleHoldDto>(`/workspaces/${workspaceId}/lifecycle/holds/${holdId}/release`, note ? { note } : {});
}

/** Таймер автоудаления сообщений: 1 · 7 · 30 дней или null (выкл). */
export function setChatTimer(chatId: string, days: number | null): Promise<ChatDetail> {
  return apiPut<ChatDetail>(`/messenger/chats/${chatId}/timer`, { days });
}
