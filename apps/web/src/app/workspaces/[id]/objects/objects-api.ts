// ============================================================
// Сервис «Объекты» — тонкий слой запросов раздела.
// Типы — только из @superapp/shared (правило «Контракт API ↔ клиенты»).
// ============================================================

import type {
  AssetCardDto,
  AssetDto,
  AssetModelDto,
  AssetServiceRecordDto,
  AttendanceDto,
  CursorPage,
  FileDto,
  LegalEntityLiteDto,
  ObjectNodeDto,
  ObjectTreeDto,
  ShiftBoardDto,
  ShiftDto,
  ShiftPatternDto,
  ShiftTemplateDto,
  StaffingTableDto,
  StaffRateDto,
} from '@superapp/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';

const base = (wsId: string) => `/workspaces/${wsId}/objects`;

// ---------- Дерево и карточка объекта ----------

export const fetchObjectTree = (wsId: string, archived = false): Promise<ObjectTreeDto> =>
  apiGet(`${base(wsId)}/tree`, { params: archived ? { archived: 'true' } : {} });

export const fetchMyObjects = (wsId: string): Promise<ObjectNodeDto[]> => apiGet(`${base(wsId)}/mine`);

export const fetchObject = (wsId: string, objectId: string): Promise<ObjectNodeDto> =>
  apiGet(`${base(wsId)}/${objectId}`);

export const objectsApi = {
  base,
  create: (wsId: string, body: Record<string, unknown>) => apiPost<ObjectNodeDto>(base(wsId), body),
  update: (wsId: string, objectId: string, body: Record<string, unknown>) =>
    apiPatch<ObjectNodeDto>(`${base(wsId)}/${objectId}`, body),
  move: (wsId: string, objectId: string, parentId: string | null) =>
    apiPost<ObjectNodeDto>(`${base(wsId)}/${objectId}/move`, { parentId }),
  archive: (wsId: string, objectId: string) => apiPost<ObjectNodeDto>(`${base(wsId)}/${objectId}/archive`, {}),
  makeDefault: (wsId: string, objectId: string) =>
    apiPost<ObjectNodeDto>(`${base(wsId)}/${objectId}/make-default`, {}),
  restore: (wsId: string, objectId: string) => apiPost<ObjectNodeDto>(`${base(wsId)}/${objectId}/restore`, {}),
  remove: (wsId: string, objectId: string) => apiDelete(`${base(wsId)}/${objectId}`),
};

/** Справочник юрлиц для формы объекта (живые) */
export const fetchLegalEntitiesLite = (wsId: string): Promise<LegalEntityLiteDto[]> =>
  apiGet(`/workspaces/${wsId}/legal-entities/lite`);

// ---------- Штатное расписание ----------

export const fetchStaffing = (wsId: string, objectId: string, period: string): Promise<StaffingTableDto> =>
  apiGet(`${base(wsId)}/${objectId}/staffing`, { params: { period } });

export const staffingApi = {
  createUnit: (wsId: string, objectId: string, body: Record<string, unknown>) =>
    apiPost<StaffingTableDto>(`${base(wsId)}/${objectId}/staffing/positions`, body),
  updateUnit: (wsId: string, spId: string, body: Record<string, unknown>) =>
    apiPatch(`/workspaces/${wsId}/staffing/positions/${spId}`, body),
  removeUnit: (wsId: string, spId: string) => apiDelete(`/workspaces/${wsId}/staffing/positions/${spId}`),
  setPlannedRate: (wsId: string, spId: string, body: Record<string, unknown>) =>
    apiPost<StaffRateDto>(`/workspaces/${wsId}/staffing/positions/${spId}/rates`, body),
  assign: (wsId: string, objectId: string, body: Record<string, unknown>) =>
    apiPost(`${base(wsId)}/${objectId}/staffing/assign`, body),
  updateAssignment: (wsId: string, aId: string, body: Record<string, unknown>) =>
    apiPatch(`/workspaces/${wsId}/staffing/assignments/${aId}`, body),
  closeAssignment: (wsId: string, aId: string, endsOn: string) =>
    apiPost(`/workspaces/${wsId}/staffing/assignments/${aId}/close`, { endsOn }),
  setActualRate: (wsId: string, aId: string, body: Record<string, unknown>) =>
    apiPost<StaffRateDto>(`/workspaces/${wsId}/staffing/assignments/${aId}/rates`, body),
  rates: (wsId: string, aId: string): Promise<StaffRateDto[]> =>
    apiGet(`/workspaces/${wsId}/staffing/assignments/${aId}/rates`),
};

// ---------- Смены ----------

export const fetchShiftBoard = (
  wsId: string,
  objectId: string,
  from: string,
  to: string,
): Promise<ShiftBoardDto> => apiGet(`${base(wsId)}/${objectId}/shifts`, { params: { from, to } });

export const fetchShiftTemplates = (wsId: string, objectId?: string): Promise<ShiftTemplateDto[]> =>
  apiGet(`/workspaces/${wsId}/shift-templates`, { params: objectId ? { branchId: objectId } : {} });

export const shiftsApi = {
  createTemplate: (wsId: string, body: Record<string, unknown>) =>
    apiPost<ShiftTemplateDto>(`/workspaces/${wsId}/shift-templates`, body),
  updateTemplate: (wsId: string, tplId: string, body: Record<string, unknown>) =>
    apiPatch<ShiftTemplateDto>(`/workspaces/${wsId}/shift-templates/${tplId}`, body),
  removeTemplate: (wsId: string, tplId: string) => apiDelete(`/workspaces/${wsId}/shift-templates/${tplId}`),

  patterns: (wsId: string, objectId: string): Promise<ShiftPatternDto[]> =>
    apiGet(`${base(wsId)}/${objectId}/shift-patterns`),
  createPattern: (wsId: string, objectId: string, body: Record<string, unknown>) =>
    apiPost<ShiftPatternDto>(`${base(wsId)}/${objectId}/shift-patterns`, body),
  removePattern: (wsId: string, patId: string) => apiDelete(`/workspaces/${wsId}/shift-patterns/${patId}`),
  generate: (wsId: string, patId: string) => apiPost(`/workspaces/${wsId}/shift-patterns/${patId}/generate`, {}),

  create: (wsId: string, objectId: string, body: Record<string, unknown>) =>
    apiPost<ShiftDto>(`${base(wsId)}/${objectId}/shifts`, body),
  update: (wsId: string, shiftId: string, body: Record<string, unknown>) =>
    apiPatch<ShiftDto>(`/workspaces/${wsId}/shifts/${shiftId}`, body),
  cancel: (wsId: string, shiftId: string) => apiPost<ShiftDto>(`/workspaces/${wsId}/shifts/${shiftId}/cancel`, {}),
  publish: (wsId: string, objectId: string, from: string, to: string) =>
    apiPost<{ published: number; hasMore: boolean }>(`${base(wsId)}/${objectId}/shifts/publish`, { from, to }),
  take: (wsId: string, shiftId: string) => apiPost<ShiftDto>(`/workspaces/${wsId}/shifts/${shiftId}/take`, {}),
  markAttendance: (wsId: string, shiftId: string, body: Record<string, unknown>) =>
    apiPost<AttendanceDto>(`/workspaces/${wsId}/shifts/${shiftId}/attendance`, body),
  markUnplanned: (wsId: string, objectId: string, body: Record<string, unknown>) =>
    apiPost<AttendanceDto>(`${base(wsId)}/${objectId}/attendance`, body),
  updateAttendance: (wsId: string, attId: string, body: Record<string, unknown>) =>
    apiPatch<AttendanceDto>(`/workspaces/${wsId}/attendance/${attId}`, body),
  removeAttendance: (wsId: string, attId: string) => apiDelete(`/workspaces/${wsId}/attendance/${attId}`),
};

/** Табель объекта за период: плановые смены и ВНЕПЛАНОВЫЕ выходы одной лентой. */
export const fetchAttendance = (
  wsId: string,
  objectId: string,
  from: string,
  to: string,
): Promise<AttendanceDto[]> => apiGet(`${base(wsId)}/${objectId}/attendance`, { params: { from, to } });

// ---------- Оборудование ----------

export const fetchAssets = (
  wsId: string,
  objectId: string,
  params: Record<string, string | number | undefined>,
): Promise<CursorPage<AssetDto>> => {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  return apiGet(`${base(wsId)}/${objectId}/assets`, { params: clean });
};

export const fetchAssetCard = (wsId: string, assetId: string): Promise<AssetCardDto> =>
  apiGet(`/workspaces/${wsId}/assets/${assetId}`);

export const fetchAssetModels = (wsId: string, search?: string): Promise<AssetModelDto[]> =>
  apiGet(`/workspaces/${wsId}/asset-models`, { params: search ? { search } : {} });

export const assetModelsApi = {
  update: (wsId: string, modelId: string, body: Record<string, unknown>) =>
    apiPatch<AssetModelDto>(`/workspaces/${wsId}/asset-models/${modelId}`, body),
  /** Инструкция и паспорт крепятся к МОДЕЛИ один раз — на весь парк одинаковых машин */
  files: (wsId: string, modelId: string): Promise<FileDto[]> =>
    apiGet(`/workspaces/${wsId}/asset-models/${modelId}/files`),
  attachFile: (wsId: string, modelId: string, fileId: string) =>
    apiPost(`/workspaces/${wsId}/asset-models/${modelId}/files`, { fileId }),
  detachFile: (wsId: string, modelId: string, fileId: string) =>
    apiDelete(`/workspaces/${wsId}/asset-models/${modelId}/files/${fileId}`),
};

export const assetsApi = {
  create: (wsId: string, objectId: string, body: Record<string, unknown>) =>
    apiPost<AssetDto>(`${base(wsId)}/${objectId}/assets`, body),
  update: (wsId: string, assetId: string, body: Record<string, unknown>) =>
    apiPatch<AssetDto>(`/workspaces/${wsId}/assets/${assetId}`, body),
  move: (wsId: string, assetId: string, body: Record<string, unknown>) =>
    apiPost<AssetDto>(`/workspaces/${wsId}/assets/${assetId}/move`, body),
  setCustodian: (wsId: string, assetId: string, body: Record<string, unknown>) =>
    apiPost<AssetDto>(`/workspaces/${wsId}/assets/${assetId}/custodian`, body),
  setHolding: (wsId: string, assetId: string, body: Record<string, unknown>) =>
    apiPost<AssetDto>(`/workspaces/${wsId}/assets/${assetId}/holding`, body),
  setStatus: (wsId: string, assetId: string, body: Record<string, unknown>) =>
    apiPost<AssetDto>(`/workspaces/${wsId}/assets/${assetId}/status`, body),
  logService: (wsId: string, assetId: string, body: Record<string, unknown>) =>
    apiPost<AssetServiceRecordDto>(`/workspaces/${wsId}/assets/${assetId}/service`, body),
  updateService: (wsId: string, assetId: string, recId: string, body: Record<string, unknown>) =>
    apiPatch<AssetServiceRecordDto>(`/workspaces/${wsId}/assets/${assetId}/service/${recId}`, body),
  createModel: (wsId: string, body: Record<string, unknown>) =>
    apiPost<AssetModelDto>(`/workspaces/${wsId}/asset-models`, body),
  removeModel: (wsId: string, modelId: string) => apiDelete(`/workspaces/${wsId}/asset-models/${modelId}`),
};
