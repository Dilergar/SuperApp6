import type {
  CopyNotificationPreferencesInput,
  MarkNotificationsReadInput,
  NotificationCountsDto,
  NotificationDeviceDto,
  NotificationDeviceRegisteredDto,
  NotificationDto,
  NotificationPageDto,
  NotificationPreferencesDto,
  NotificationQuietDto,
  NotificationState,
  NotificationVapidDto,
  PauseNotificationsInput,
  PutNotificationPreferencesInput,
  PutNotificationQuietInput,
  PutWorkspaceNotificationPolicyInput,
  RegisterNotificationDeviceInput,
  RemoveNotificationDeviceInput,
  RichCardPayload,
  WorkspaceNotificationPolicyDto,
} from '@superapp/shared';
import { apiDelete, apiGet, apiPost, apiPut } from './api';

// ============================================================
// core/notifications — центр уведомлений, настройки, устройства, политика организации.
// Только хелперы `@superapp/api-client`; типы — с обеих сторон провода из shared.
// ============================================================

export interface NotificationFeedFilter {
  /** `personal` | id организации; пусто — сквозная лента */
  context?: string;
  service?: string;
  state?: NotificationState;
  mentions?: boolean;
  limit?: number;
}

export async function fetchNotifications(filter: NotificationFeedFilter, cursor?: string): Promise<NotificationPageDto> {
  return apiGet<NotificationPageDto>('/notifications', {
    params: {
      ...(cursor ? { cursor } : {}),
      ...(filter.context ? { context: filter.context } : {}),
      ...(filter.service ? { service: filter.service } : {}),
      ...(filter.state && filter.state !== 'all' ? { state: filter.state } : {}),
      ...(filter.mentions ? { mentions: 'true' } : {}),
      ...(filter.limit ? { limit: filter.limit } : {}),
    },
  });
}

export async function fetchNotificationCounts(): Promise<NotificationCountsDto> {
  return apiGet<NotificationCountsDto>('/notifications/counts');
}

export async function markNotificationsSeen(ids?: string[]): Promise<{ updated: number }> {
  return apiPost<{ updated: number }>('/notifications/seen', ids?.length ? { ids } : {});
}

export async function markNotificationsRead(input: MarkNotificationsReadInput): Promise<{ updated: number }> {
  return apiPost<{ updated: number }>('/notifications/read', input);
}

export type NotificationRowAction = 'read' | 'unread' | 'archive' | 'unarchive' | 'save' | 'unsave' | 'unsnooze';

export async function notificationAction(id: string, action: NotificationRowAction): Promise<NotificationDto> {
  return apiPost<NotificationDto>(`/notifications/${id}/${action}`, {});
}

export async function snoozeNotification(id: string, untilIso: string): Promise<NotificationDto> {
  return apiPost<NotificationDto>(`/notifications/${id}/snooze`, { until: untilIso });
}

export async function muteNotificationRef(refType: string, refId: string): Promise<void> {
  await apiPost('/notifications/mute', { refType, refId });
}

export async function unmuteNotificationRef(refType: string, refId: string): Promise<void> {
  await apiDelete('/notifications/mute', { data: { refType, refId } });
}

// ---- настройки ----

export async function fetchNotificationPreferences(context: string): Promise<NotificationPreferencesDto> {
  return apiGet<NotificationPreferencesDto>('/notifications/preferences', { params: { context } });
}

export async function putNotificationPreferences(input: PutNotificationPreferencesInput): Promise<NotificationPreferencesDto> {
  return apiPut<NotificationPreferencesDto>('/notifications/preferences', input);
}

export async function copyNotificationPreferences(input: CopyNotificationPreferencesInput): Promise<{ copiedTo: string[] }> {
  return apiPost<{ copiedTo: string[] }>('/notifications/preferences/copy-to-workspaces', input);
}

export async function fetchNotificationQuiet(): Promise<NotificationQuietDto> {
  return apiGet<NotificationQuietDto>('/notifications/quiet');
}

export async function putNotificationQuiet(input: PutNotificationQuietInput): Promise<NotificationQuietDto> {
  return apiPut<NotificationQuietDto>('/notifications/quiet', input);
}

export async function pauseNotifications(input: PauseNotificationsInput): Promise<NotificationQuietDto> {
  return apiPost<NotificationQuietDto>('/notifications/quiet/pause', input);
}

// ---- устройства push ----

export async function fetchVapidPublicKey(): Promise<NotificationVapidDto> {
  return apiGet<NotificationVapidDto>('/notifications/vapid-public-key');
}

export async function fetchNotificationDevices(): Promise<NotificationDeviceDto[]> {
  return apiGet<NotificationDeviceDto[]>('/notifications/devices');
}

export async function registerNotificationDevice(input: RegisterNotificationDeviceInput): Promise<NotificationDeviceRegisteredDto> {
  return apiPost<NotificationDeviceRegisteredDto>('/notifications/devices', input);
}

export async function removeNotificationDevice(input: RemoveNotificationDeviceInput): Promise<void> {
  await apiDelete('/notifications/devices', { data: input });
}

// ---- политика организации ----

export async function fetchWorkspaceNotificationPolicy(workspaceId: string): Promise<WorkspaceNotificationPolicyDto> {
  return apiGet<WorkspaceNotificationPolicyDto>(`/workspaces/${workspaceId}/notification-policy`);
}

export async function putWorkspaceNotificationPolicy(
  workspaceId: string,
  input: PutWorkspaceNotificationPolicyInput,
): Promise<WorkspaceNotificationPolicyDto> {
  return apiPut<WorkspaceNotificationPolicyDto>(`/workspaces/${workspaceId}/notification-policy`, input);
}

// ---- рич-карта строки (core/rich-cards, живая, с перепроверкой прав) ----

export async function fetchRichCard(refType: string, refId: string): Promise<RichCardPayload> {
  return apiGet<RichCardPayload>(`/rich-cards/${refType}/${encodeURIComponent(refId)}`);
}
