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
  PlatformSecurityEventsQuery,
  PlatformSecurityExportDto,
  SecurityAlertPageDto,
  SecurityAlertSummaryDto,
  SecurityDigestDto,
  SecurityEventDto,
  SecurityEventPageDto,
  SecurityNetworkLookupDto,
  SecurityPartitionDto,
  SecurityPartitionManifestDto,
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
// Консоль «Безопасность» (core/audit). Лента — ТОЛЬКО useInfiniteQuery (одна форма кэша)
export const platformSecurityEventsKey = (q: Record<string, unknown>) => ['platform', 'security', 'events', q] as const;
export const platformSecurityEventKey = (id: string) => ['platform', 'security', 'event', id] as const;
export const platformSecurityAlertsKey = (status: string) => ['platform', 'security', 'alerts', status] as const;
export const platformSecurityDigestsKey = ['platform', 'security', 'digests'] as const;
export const platformSecurityPartitionsKey = ['platform', 'security', 'partitions'] as const;
export const platformSecurityManifestKey = (partition: string) => ['platform', 'security', 'manifest', partition] as const;
/** Отдельный корень от списка тревог: одна форма кэша на ключ (страница ≠ сводка) */
export const platformSecurityAlertSummaryKey = ['platform', 'security', 'alertSummary'] as const;
export const platformSecurityExportsKey = ['platform', 'security', 'exports'] as const;

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

// ---- core/audit: консоль «Безопасность» ----
const qs = (q: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
};
/** `ipHmac` — псевдонимы сети через запятую (IP в адрес не кладётся никогда) */
export const fetchPlatformSecurityEvents = (q: Omit<PlatformSecurityEventsQuery, 'ipHmac'> & { ipHmac?: string }) =>
  platformGet<SecurityEventPageDto>(`/platform/security/events${qs(q)}`);
export const fetchPlatformSecurityEvent = (id: string) => platformGet<SecurityEventDto>(`/platform/security/events/${encodeURIComponent(id)}`);
/** IP → псевдонимы сети: POST, чтобы IP не осел в адресе, истории и логах прокси */
export const lookupPlatformNetwork = (ip: string) => platformPost<SecurityNetworkLookupDto>('/platform/security/network', { ip });
export const fetchPlatformSecurityAlerts = (status: string, cursor?: string | null) =>
  platformGet<SecurityAlertPageDto>(`/platform/security/alerts${qs({ status: status === 'all' ? undefined : status, cursor })}`);
export const fetchPlatformSecurityDigests = () => platformGet<SecurityDigestDto[]>('/platform/security/digests');
export const fetchPlatformSecurityPartitions = () => platformGet<SecurityPartitionDto[]>('/platform/security/partitions');
export const fetchPlatformSecurityManifest = (partition: string) => platformGet<SecurityPartitionManifestDto>(`/platform/security/partitions/${encodeURIComponent(partition)}/manifest`);
export const fetchPlatformSecurityAlertSummary = () => platformGet<SecurityAlertSummaryDto>('/platform/security/alerts/summary');
export const fetchPlatformSecurityExports = () => platformGet<PlatformSecurityExportDto[]>('/platform/security/exports');
export const fetchPlatformSecurityExportUrl = (fileId: string) => platformGet<{ url: string }>(`/platform/security/exports/${encodeURIComponent(fileId)}/url`);
