// Журнал безопасности (core/audit): сессии и устройства человека, лента событий, «Это не я»,
// настройки, заморозка без входа, журнал организации. Кабинет — `lib/platform/api.ts`.
import type {
  AuditOrgFilter,
  AuditPersonFilter,
  NotMeCompleteInput,
  NotMeResultDto,
  OrgAuditExportInput,
  OrgSecurityEventsQuery,
  OrgSecurityOverviewDto,
  SecurityCoolingDto,
  SecurityEventDto,
  SecurityEventPageDto,
  SecuritySessionsDto,
  SecuritySettingsDto,
  AuthTokens,
  UserDeviceDto,
} from '@superapp/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';

// ---- Сессии и устройства ----

export const fetchSecuritySessions = () => apiGet<SecuritySessionsDto>('/users/me/sessions');
export const fetchSecurityCooling = () => apiGet<SecurityCoolingDto>('/users/me/security/cooling');
export const confirmSecuritySession = (verifyToken: string) => apiPost<unknown>('/users/me/sessions/confirm', { verifyToken });
export const endSecuritySession = (id: string) => apiDelete<unknown>(`/users/me/sessions/${encodeURIComponent(id)}`);
export const logoutEverywhere = () => apiPost<unknown>('/auth/logout-all', {});

export const fetchSecurityDevices = () => apiGet<UserDeviceDto[]>('/users/me/devices');
export const renameSecurityDevice = (id: string, label: string) => apiPatch<UserDeviceDto>(`/users/me/devices/${encodeURIComponent(id)}`, { label });
export const forgetSecurityDevice = (id: string) => apiDelete<{ sessionsRevoked: number }>(`/users/me/devices/${encodeURIComponent(id)}`);

// ---- Лента человека ----

export const fetchSecurityEvents = (filter: AuditPersonFilter, cursor?: string | null) =>
  apiGet<SecurityEventPageDto>('/users/me/security/events', { params: { filter, ...(cursor ? { cursor } : {}) } });
export const fetchSecurityEvent = (id: string) => apiGet<SecurityEventDto>(`/users/me/security/events/${encodeURIComponent(id)}`);

// ---- «Это не я» ----

export const notMeStart = (eventId: string, idempotencyKey: string) =>
  apiPost<NotMeResultDto>('/users/me/security/not-me', { eventId }, { idempotencyKey });
export const notMeComplete = (input: NotMeCompleteInput) => apiPost<{ completed: true }>('/users/me/security/not-me/complete', input);

// ---- Настройки ----

export const fetchSecuritySettings = () => apiGet<SecuritySettingsDto>('/users/me/security/settings');
export const updateSecuritySettings = (input: SecuritySettingsDto) => apiPatch<SecuritySettingsDto>('/users/me/security/settings', input);

// ---- Заморозка без входа (публичные ручки /auth/*) ----

export const freezeStartUrl = '/auth/freeze/start';
export const unfreezeStartUrl = '/auth/unfreeze/start';
export const freezeConfirm = (verifyToken: string) => apiPost<{ frozen: true }>('/auth/freeze/confirm', { verifyToken });
export const unfreezeConfirm = (verifyToken: string) => apiPost<AuthTokens>('/auth/unfreeze/confirm', { verifyToken });

// ---- Журнал организации ----

export const fetchOrgSecurityOverview = (wsId: string) => apiGet<OrgSecurityOverviewDto>(`/workspaces/${wsId}/security/overview`);
export const fetchOrgSecurityEvents = (wsId: string, q: Omit<OrgSecurityEventsQuery, 'filter'> & { filter?: AuditOrgFilter }) =>
  apiGet<SecurityEventPageDto>(`/workspaces/${wsId}/security/events`, { params: q });
export const fetchOrgSecurityEvent = (wsId: string, id: string) => apiGet<SecurityEventDto>(`/workspaces/${wsId}/security/events/${encodeURIComponent(id)}`);
/** Заказ выгрузки журнала организации: ключ повтора формы — двойной клик = один файл. */
export const requestOrgSecurityExport = (wsId: string, input: OrgAuditExportInput, idempotencyKey: string) =>
  apiPost<{ jobQueued: true }>(`/workspaces/${wsId}/security/export`, input, { idempotencyKey });
