// Тариф и лимиты (core/entitlements): снимок контекста и батч-проверка.
// Контекст организации едет заголовком пер-запросно (правило веба: глобального
// X-Workspace-Id нет — он включил бы chokepoint на личных запросах).
import type { EntitlementCheckItemDto, EntitlementCheckResponseDto, EntitlementSnapshotDto } from '@superapp/shared';
import { apiGet, apiPost } from './api';

const wsHeaders = (workspaceId?: string | null) => (workspaceId ? { headers: { 'X-Workspace-Id': workspaceId } } : undefined);

export function fetchEntitlements(workspaceId?: string | null): Promise<EntitlementSnapshotDto> {
  return apiGet<EntitlementSnapshotDto>('/entitlements/me', wsHeaders(workspaceId));
}

export function checkEntitlements(items: EntitlementCheckItemDto[], workspaceId?: string | null): Promise<EntitlementCheckResponseDto> {
  return apiPost<EntitlementCheckResponseDto>('/entitlements/check', { items }, wsHeaders(workspaceId));
}
