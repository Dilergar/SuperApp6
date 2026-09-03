import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import type {
  CreateStaffDeputyInput,
  OrgChartDto,
  OrgDeputyDto,
  OrgLineDto,
  OrgScopeDto,
  OrgSetupInput,
  OrgSetupResultDto,
  OrgUnassignedDto,
  StaffAssignment,
  UpdateStaffDeputyInput,
} from '@superapp/shared';

// ============================================================
// Орг. структура — фетчеры провода (типы shared стоят на обеих сторонах).
// Головы отдела/объекта и подчинение — через PATCH справочников /staff (отдельных
// ручек нет намеренно); граф, «место в структуре», заместители, мастер — /org.
// ============================================================

const org = (wsId: string) => `/workspaces/${wsId}/org`;
const staff = (wsId: string) => `/workspaces/${wsId}/staff`;

export const fetchOrgChart = (wsId: string, branchId?: string | null) =>
  apiGet<OrgChartDto>(`${org(wsId)}/chart`, { params: branchId ? { branchId } : undefined });

export const fetchOrgUnassigned = (wsId: string) => apiGet<OrgUnassignedDto>(`${org(wsId)}/unassigned`);

export const fetchOrgScope = (wsId: string) => apiGet<OrgScopeDto>(`${org(wsId)}/my-scope`);

export const fetchOrgLine = (wsId: string, userId: string, q?: { branchId?: string; assignmentId?: string }) =>
  apiGet<OrgLineDto>(`${org(wsId)}/people/${userId}/line`, { params: q });

export const fetchOrgDeputies = (wsId: string, positionId?: string | null) =>
  apiGet<OrgDeputyDto[]>(`${org(wsId)}/deputies`, { params: positionId ? { positionId } : undefined });

export const createOrgDeputy = (wsId: string, dto: CreateStaffDeputyInput) =>
  apiPost<OrgDeputyDto>(`${org(wsId)}/deputies`, dto);

export const updateOrgDeputy = (wsId: string, deputyId: string, dto: UpdateStaffDeputyInput) =>
  apiPatch<OrgDeputyDto>(`${org(wsId)}/deputies/${deputyId}`, dto);

export const deleteOrgDeputy = (wsId: string, deputyId: string) => apiDelete(`${org(wsId)}/deputies/${deputyId}`);

export const runOrgSetup = (wsId: string, dto: OrgSetupInput) => apiPost<OrgSetupResultDto>(`${org(wsId)}/setup`, dto);

// ---- Мутации структуры через справочники Staff ----

export const setDepartmentHead = (wsId: string, departmentId: string, headPositionId: string | null) =>
  apiPatch(`${staff(wsId)}/departments/${departmentId}`, { headPositionId });

export const setBranchHead = (wsId: string, branchId: string, headPositionId: string | null) =>
  apiPatch(`${staff(wsId)}/branches/${branchId}`, { headPositionId });

export const setPositionReportsTo = (wsId: string, positionId: string, reportsToPositionId: string | null) =>
  apiPatch(`${staff(wsId)}/positions/${positionId}`, { reportsToPositionId });

export const movePositionToDepartment = (wsId: string, positionId: string, departmentId: string | null) =>
  apiPatch(`${staff(wsId)}/positions/${positionId}`, { departmentId });

export const updatePosition = (
  wsId: string,
  positionId: string,
  dto: { name?: string; description?: string | null; glyph?: string | null; departmentId?: string | null; reportsToPositionId?: string | null },
) => apiPatch(`${staff(wsId)}/positions/${positionId}`, dto);

export const createPosition = (
  wsId: string,
  dto: { name: string; departmentId?: string | null; description?: string | null; reportsToPositionId?: string | null; glyph?: string | null },
) => apiPost<{ id: string; name: string; departmentId: string | null }>(`${staff(wsId)}/positions`, dto);

export const deletePosition = (wsId: string, positionId: string) => apiDelete(`${staff(wsId)}/positions/${positionId}`);

export const createDepartment = (wsId: string, dto: { name: string; parentId?: string | null; headPositionId?: string | null }) =>
  apiPost<{ id: string; name: string; parentId: string | null; headPositionId: string | null }>(`${staff(wsId)}/departments`, dto);

export const updateDepartment = (
  wsId: string,
  departmentId: string,
  dto: { name?: string; parentId?: string | null; headPositionId?: string | null },
) => apiPatch(`${staff(wsId)}/departments/${departmentId}`, dto);

export const deleteDepartment = (wsId: string, departmentId: string) => apiDelete(`${staff(wsId)}/departments/${departmentId}`);

export const assignPositionTo = (
  wsId: string,
  userId: string,
  dto: { positionId: string; branchId?: string | null; isPrimary?: boolean },
) => apiPost<StaffAssignment>(`${staff(wsId)}/members/${userId}/assignments`, dto);

export const updateAssignment = (wsId: string, assignmentId: string, dto: { branchId?: string; isPrimary?: true }) =>
  apiPatch<StaffAssignment>(`${staff(wsId)}/assignments/${assignmentId}`, dto);

export const removeAssignment = (wsId: string, assignmentId: string) => apiDelete(`${staff(wsId)}/assignments/${assignmentId}`);
