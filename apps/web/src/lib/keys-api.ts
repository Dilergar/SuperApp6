// Ключи и интеграции (core/keys, core/webhooks): реестр организации, боты, личные
// ключи, step-up, политика, журнал, вебхуки. Организация — в адресе маршрута (owner/admin
// проверяет сервер), поэтому глобального X-Workspace-Id нет.
import type {
  ApiKeyCreateInput,
  ApiKeyCreatedDto,
  ApiKeyDto,
  ApiKeyRevokeInput,
  ApiKeyRotateInput,
  ApiKeyUpdateInput,
  BotCreateInput,
  BotCreatedDto,
  BotDetailsDto,
  BotDto,
  BotKeyCreateInput,
  BotUpdateInput,
  KeyAuditPage,
  KeyJournalQuery,
  KeyPolicyUpdateInput,
  KeyRegistryPage,
  KeyRegistryQuery,
  KeyScopeMatrixDto,
  KeysPendingDto,
  KeysStepUpStatusDto,
  WebhookDeliveryPage,
  WebhookEndpointCreateInput,
  WebhookEndpointCreatedDto,
  WebhookEndpointDto,
  WebhookEndpointUpdateInput,
  WebhookEventCatalogDto,
  WebhookRotateSecretInput,
  WorkspaceKeyPolicyDto,
} from '@superapp/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from './api';

const ws = (id: string) => `/workspaces/${id}/keys`;
const wh = (id: string) => `/workspaces/${id}/webhooks`;

// ---- Реестр организации ----
export const fetchKeysRegistry = (wsId: string, q: KeyRegistryQuery) => apiGet<KeyRegistryPage>(`${ws(wsId)}/registry`, { params: q });
export const fetchKeysPending = (wsId: string) => apiGet<KeysPendingDto>(`${ws(wsId)}/pending`);
export const fetchKeysJournal = (wsId: string, q: KeyJournalQuery) => apiGet<KeyAuditPage>(`${ws(wsId)}/journal`, { params: q });
export const fetchKeysPolicy = (wsId: string) => apiGet<WorkspaceKeyPolicyDto>(`${ws(wsId)}/policy`);
export const updateKeysPolicy = (wsId: string, input: KeyPolicyUpdateInput) => apiPatch<WorkspaceKeyPolicyDto>(`${ws(wsId)}/policy`, input);

// ---- Боты ----
export const fetchBots = (wsId: string) => apiGet<BotDto[]>(`${ws(wsId)}/bots`);
export const fetchBot = (wsId: string, botId: string) => apiGet<BotDetailsDto>(`${ws(wsId)}/bots/${botId}`);
export const createBot = (wsId: string, input: BotCreateInput) => apiPost<BotCreatedDto>(`${ws(wsId)}/bots`, input);
export const updateBot = (wsId: string, botId: string, input: BotUpdateInput) => apiPatch<BotDto>(`${ws(wsId)}/bots/${botId}`, input);
export const createBotKey = (wsId: string, botId: string, input: BotKeyCreateInput) => apiPost<ApiKeyCreatedDto>(`${ws(wsId)}/bots/${botId}/keys`, input);
export const freezeBot = (wsId: string, botId: string) => apiPost<BotDto>(`${ws(wsId)}/bots/${botId}/freeze`, {});
export const unfreezeBot = (wsId: string, botId: string, note?: string) => apiPost<BotDto>(`${ws(wsId)}/bots/${botId}/unfreeze`, note ? { note } : {});
export const archiveBot = (wsId: string, botId: string) => apiDelete<void>(`${ws(wsId)}/bots/${botId}`);

// ---- Ключи организации (боты + личные для данных организации) ----
export const fetchWorkspacePersonalKeys = (wsId: string) => apiGet<ApiKeyDto[]>(`${ws(wsId)}/keys`);
export const createWorkspacePersonalKey = (wsId: string, input: ApiKeyCreateInput) => apiPost<ApiKeyCreatedDto>(`${ws(wsId)}/keys`, input);
export const updateWorkspaceKey = (wsId: string, keyId: string, input: ApiKeyUpdateInput) => apiPatch<ApiKeyDto>(`${ws(wsId)}/keys/${keyId}`, input);
export const rotateWorkspaceKey = (wsId: string, keyId: string, input: ApiKeyRotateInput) => apiPost<ApiKeyCreatedDto>(`${ws(wsId)}/keys/${keyId}/rotate`, input);
export const revokeWorkspaceKey = (wsId: string, keyId: string, input: ApiKeyRevokeInput) => apiPost<ApiKeyDto>(`${ws(wsId)}/keys/${keyId}/revoke`, input);

// ---- Личные ключи для собственных данных ----
export const fetchPersonalKeys = () => apiGet<ApiKeyDto[]>('/keys/personal');
export const createPersonalKey = (input: ApiKeyCreateInput) => apiPost<ApiKeyCreatedDto>('/keys/personal', input);
export const updatePersonalKey = (keyId: string, input: ApiKeyUpdateInput) => apiPatch<ApiKeyDto>(`/keys/personal/${keyId}`, input);
export const rotatePersonalKey = (keyId: string, input: ApiKeyRotateInput) => apiPost<ApiKeyCreatedDto>(`/keys/personal/${keyId}/rotate`, input);
export const revokePersonalKey = (keyId: string, input: ApiKeyRevokeInput) => apiPost<ApiKeyDto>(`/keys/personal/${keyId}/revoke`, input);

// ---- Step-up и справочники ----
export const fetchKeysStepUp = () => apiGet<KeysStepUpStatusDto>('/keys/step-up');
export const confirmKeysStepUp = (verifyToken: string) => apiPost<KeysStepUpStatusDto>('/keys/step-up/confirm', { verifyToken });
export const endKeysStepUp = () => apiPost<KeysStepUpStatusDto>('/keys/step-up/end', {});
export const fetchScopeMatrix = () => apiGet<KeyScopeMatrixDto>('/keys/scope-matrix');

// ---- Вебхуки (core/webhooks) ----
export const fetchWebhookEvents = () => apiGet<WebhookEventCatalogDto>('/webhooks/events');
export const fetchWebhookEndpoints = (wsId: string) => apiGet<WebhookEndpointDto[]>(`${wh(wsId)}/endpoints`);
export const createWebhookEndpoint = (wsId: string, input: WebhookEndpointCreateInput) => apiPost<WebhookEndpointCreatedDto>(`${wh(wsId)}/endpoints`, input);
export const updateWebhookEndpoint = (wsId: string, id: string, input: WebhookEndpointUpdateInput) => apiPatch<WebhookEndpointDto>(`${wh(wsId)}/endpoints/${id}`, input);
export const rotateWebhookSecret = (wsId: string, id: string, input: WebhookRotateSecretInput) => apiPost<WebhookEndpointCreatedDto>(`${wh(wsId)}/endpoints/${id}/rotate-secret`, input);
export const probeWebhookEndpoint = (wsId: string, id: string) => apiPost<WebhookEndpointDto>(`${wh(wsId)}/endpoints/${id}/probe`, {});
export const deleteWebhookEndpoint = (wsId: string, id: string) => apiDelete<void>(`${wh(wsId)}/endpoints/${id}`);
export const fetchWebhookDeliveries = (wsId: string, id: string, params: { cursor?: string; limit?: number }) => apiGet<WebhookDeliveryPage>(`${wh(wsId)}/endpoints/${id}/deliveries`, { params });
export const redeliverWebhook = (wsId: string, id: string, deliveryId: string) => apiPost<void>(`${wh(wsId)}/endpoints/${id}/deliveries/${deliveryId}/redeliver`, {});
