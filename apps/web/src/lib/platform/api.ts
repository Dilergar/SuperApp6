// Ключи React Query и загрузчики кабинета платформы. Один ключ = одна форма кэша.
import type {
  PdIncidentDto,
  PlatformConsentsDocumentsDto,
  EntitlementCatalogDto,
  EntitlementSubjectDetailDto,
  EntitlementSubjectType,
  PlatformAuditPageDto,
  PlatformAuditQuery,
  PlatformCommandDto,
  PlatformCommandPreviewDto,
  PlatformCommandResultDto,
  PlatformCommandRunInput,
  PlatformEntity,
  PlatformEntityDto,
  PlatformLookupResponseDto,
  PlatformPanelDataDto,
  PlatformRequestDto,
  PlatformRequestsPageDto,
  PlatformStaffDto,
} from '@superapp/shared';
import { platformGet, platformPost } from '@/lib/platform-api';

export const platformRootKey = ['platform'] as const;
export const platformCommandsKey = ['platform', 'commands'] as const;
export const platformStaffKey = ['platform', 'staff'] as const;
export const platformLookupKey = (q: string) => ['platform', 'lookup', q] as const;
export const platformEntityKey = (entity: PlatformEntity, id: string) => ['platform', 'entity', entity, id] as const;
export const platformPanelKey = (entity: PlatformEntity, id: string, key: string) => ['platform', 'entity', entity, id, 'panel', key] as const;
export const platformCatalogKey = ['platform', 'entitlements', 'catalog'] as const;
export const platformSubjectKey = (type: EntitlementSubjectType, id: string) => ['platform', 'entitlements', 'subject', type, id] as const;
export const platformRequestsKey = (state: string) => ['platform', 'requests', state] as const;
export const platformAuditKey = (q: PlatformAuditQuery) => ['platform', 'audit', q] as const;

export const fetchPlatformCommands = () => platformGet<PlatformCommandDto[]>('/platform/commands');
export const fetchPlatformStaff = () => platformGet<PlatformStaffDto[]>('/platform/staff');
export const fetchPlatformLookup = (q: string) => platformGet<PlatformLookupResponseDto>(`/platform/lookup?q=${encodeURIComponent(q)}`);
export const fetchPlatformEntity = (entity: PlatformEntity, id: string) => platformGet<PlatformEntityDto>(`/platform/entities/${entity}/${id}`);
export const fetchPlatformPanel = (entity: PlatformEntity, id: string, key: string) =>
  platformGet<PlatformPanelDataDto>(`/platform/entities/${entity}/${id}/panels/${encodeURIComponent(key)}`);
export const fetchPlatformCatalog = () => platformGet<EntitlementCatalogDto>('/platform/entitlements/catalog');
export const fetchPlatformSubject = (type: EntitlementSubjectType, id: string) =>
  platformGet<EntitlementSubjectDetailDto>(`/platform/entitlements/subjects/${type}/${id}`);
export const fetchPlatformRequests = (state: string, cursor?: string | null) =>
  platformGet<PlatformRequestsPageDto>(`/platform/requests?state=${state}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
export const fetchPlatformRequest = (id: string) => platformGet<PlatformRequestDto | null>(`/platform/requests/${id}`);
export const decidePlatformRequest = (id: string, outcome: 'approved' | 'rejected', comment?: string) =>
  platformPost<PlatformRequestDto>(`/platform/requests/${id}/decide`, { outcome, comment });
export const withdrawPlatformRequest = (id: string) => platformPost<PlatformRequestDto>(`/platform/requests/${id}/withdraw`, {});

export function fetchPlatformAudit(q: PlatformAuditQuery): Promise<PlatformAuditPageDto> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return platformGet<PlatformAuditPageDto>(`/platform/audit${qs ? `?${qs}` : ''}`);
}

export const runPlatformCommand = (key: string, body: PlatformCommandRunInput) =>
  platformPost<PlatformCommandResultDto>(`/platform/commands/${encodeURIComponent(key)}`, body);
export const previewPlatformCommand = (key: string, input: unknown) =>
  platformPost<PlatformCommandPreviewDto>(`/platform/commands/${encodeURIComponent(key)}/preview`, { input });

// ---- core/consents: документы платформы, охват принятия, журнал инцидентов ПДн ----
export const fetchPlatformConsentDocuments = () => platformGet<PlatformConsentsDocumentsDto>('/platform/consents/documents');
export const fetchPlatformPdIncidents = () => platformGet<PdIncidentDto[]>('/platform/consents/incidents');
