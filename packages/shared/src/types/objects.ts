// ============================================================
// Сервис «Объекты» — DTO провода (одна форма на обеих сторонах).
//
// Объект = физическая площадка организации (модель StaffBranch). Вокруг него
// собраны: штатное расписание (план ставок и денег), график смен (план и факт) и
// оборудование. Денежные поля ОТСУТСТВУЮТ (а не равны null) без права
// `branch.payroll.view` — сервер их не отдаёт, веб прячет колонки по `caps`.
// ============================================================

import type { FileDto } from './file';
import type { AssetKind, AssetMoveKind, AssetStatus, AttendanceOutcome, AttendanceSource, HoldingKind, ObjectKind, RateType, ShiftStatus } from '../constants/objects';

/** Что зритель может делать с объектом. Считается ОДИН раз на запрос. */
export interface ObjectCapsDto {
  /** Видеть объект (его адрес, коллег, свой график, оборудование) */
  view: boolean;
  /** Править объект, штатное расписание, оборудование */
  manage: boolean;
  /** Ставить и публиковать смены */
  scheduleManage: boolean;
  /** Отмечать факт выходов */
  attendanceMark: boolean;
  /** Видеть управленческие деньги: оклады, ставки, цены и ремонты активов */
  payrollView: boolean;
}

/** Правила смен объекта (данные, не константы кода) */
export interface ObjectScheduleSettingsDto {
  minRestMin: number;
  maxShiftMin: number;
  lateToleranceMin: number;
  /** 1 = понедельник (ISO) */
  weekStartsOn: number;
  accountingPeriod: 'month' | 'week';
}

export interface ObjectNodeDto {
  id: string;
  workspaceId: string;
  name: string;
  kind: ObjectKind;
  parentId: string | null;
  /** Материализованные предки, корень первым (без себя) */
  ancestorIds: string[];
  depth: number;
  address: string | null;
  note: string | null;
  glyph: string | null;
  timeZone: string;
  isDefault: boolean;
  archivedAt: string | null;
  sortOrder: number;
  /** Юрлицо, выбранное ЯВНО (null = наследуется) */
  legalEntityId: string | null;
  /** Действующее юрлицо: своё, ближайшего предка или головное */
  effectiveLegalEntityId: string | null;
  effectiveLegalEntityName: string | null;
  /** Наследуется ли юрлицо (для подписи «как у родителя») */
  legalEntityInherited: boolean;
  headPositionId: string | null;
  headPositionName: string | null;
  /** Люди, работающие в объекте и его поддереве (по назначениям) */
  membersCount: number;
  /** Штатных единиц / оборудования — счётчики обзора (0 до Ф2/Ф4) */
  staffingCount: number;
  assetsCount: number;
  scheduleSettings: ObjectScheduleSettingsDto;
  caps: ObjectCapsDto;
  createdAt: string;
}

/** Дерево объектов организации, обрезанное правами зрителя. */
export interface ObjectTreeDto {
  /** Плоский список в порядке обхода (родитель перед детьми); вложенность — по depth */
  nodes: ObjectNodeDto[];
  /** Права зрителя на уровне организации (создание объектов и т. п.) */
  caps: ObjectCapsDto;
  /** Может ли зритель создавать объекты верхнего уровня */
  canCreate: boolean;
}

// ---------- Штатное расписание ----------

export interface StaffRateDto {
  id: string;
  rateType: RateType;
  /** Тиыны строкой (BigInt на проводе — только строкой) */
  amount: string;
  currency: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
  note: string | null;
  createdAt: string;
}

/** Трудовая карточка глазами штатки — «как оформлен» (только при payrollView) */
export interface StaffingEmploymentDto {
  status: 'draft' | 'active' | 'terminated';
  contractType: string;
  workRate: number | null;
  legalEntityName: string | null;
}

export interface StaffingAssignmentDto {
  id: string;
  userId: string;
  userName: string;
  userAvatar: string | null;
  startsOn: string | null;
  endsOn: string | null;
  rateShare: number;
  status: string;
  /** Активно на дату отчётного периода */
  active: boolean;
}

export interface StaffingRowDto {
  staffingPositionId: string;
  positionId: string;
  positionName: string;
  glyph: string | null;
  headcount: number;
  /** Сумма долей ставок активных назначений (0.5 + 0.5 = 1) */
  filled: number;
  note: string | null;
  /** Строка занята человеком либо это ВАКАНСИЯ (assignment = null) */
  assignment: StaffingAssignmentDto | null;
  /** Только при caps.payrollView */
  employment?: StaffingEmploymentDto;
  /** Оклад по договору КЭДО, тиыны строкой; только при caps.payrollView */
  officialSalary?: { amount: string; currency: string } | null;
  /** Управленческая ставка человека; только при caps.payrollView */
  actualRate?: StaffRateDto | null;
  /** Плановая ставка штатной единицы; только при caps.payrollView */
  plannedRate?: StaffRateDto | null;
  /** Подпись графика («2/2 · Утро 09–17») или null */
  schedule: { label: string } | null;
  shifts: { planned: number; worked: number; late: number; absent: number };
}

export interface StaffingTableDto {
  period: string; // YYYY-MM
  branchId: string;
  branchName: string;
  caps: ObjectCapsDto;
  rows: StaffingRowDto[];
  /** Итоги плана затрат за период; только при caps.payrollView */
  totals?: { plannedCost: string; currency: string; headcount: number; filled: number };
}

// ---------- Смены ----------

export interface ShiftTemplateDto {
  id: string;
  branchId: string | null;
  name: string;
  glyph: string | null;
  color: string | null;
  startMin: number;
  durationMin: number;
  breakMin: number;
  sortOrder: number;
  archivedAt: string | null;
  /**
   * Может ли ЗРИТЕЛЬ править этот шаблон. Общий шаблон организации
   * (`branchId === null`) правят только владелец и админ — без этого флага
   * интерфейс предлагал «Править» всем, кто ведёт график, и ловил отказ тостом.
   */
  canManage: boolean;
}

export interface ShiftPatternDto {
  id: string;
  branchId: string;
  assignmentId: string | null;
  staffingPositionId: string | null;
  name: string;
  anchorDate: string;
  /** По одному элементу на день цикла: id шаблона или null (выходной) */
  cycle: (string | null)[];
  activeFrom: string;
  activeTo: string | null;
  horizonDays: number;
  archivedAt: string | null;
}

export interface ShiftDto {
  id: string;
  workspaceId: string;
  branchId: string;
  branchName: string;
  staffingPositionId: string | null;
  positionId: string;
  positionName: string;
  assignmentId: string | null;
  userId: string | null;
  userName: string | null;
  localDate: string; // YYYY-MM-DD в поясе объекта
  startsAt: string; // ISO UTC
  endsAt: string;
  breakMin: number;
  templateId: string | null;
  templateName: string | null;
  color: string | null;
  patternId: string | null;
  status: ShiftStatus;
  publishedAt: string | null;
  note: string | null;
  version: number;
  /** Факт по смене (если отмечен) */
  attendance: AttendanceDto | null;
  /** Может ли ЗРИТЕЛЬ взять эту открытую смену */
  canTake: boolean;
}

export interface AttendanceDto {
  id: string;
  shiftId: string | null;
  branchId: string;
  userId: string;
  userName: string | null;
  localDate: string;
  outcome: AttendanceOutcome;
  lateMin: number;
  actualStartAt: string | null;
  actualEndAt: string | null;
  source: AttendanceSource;
  note: string | null;
  markedById: string | null;
  markedAt: string;
}

/** Сетка смен объекта за период */
export interface ShiftBoardDto {
  branchId: string;
  branchName: string;
  timeZone: string;
  from: string;
  to: string;
  caps: ObjectCapsDto;
  templates: ShiftTemplateDto[];
  /** Люди объекта (строки сетки) */
  people: {
    userId: string;
    userName: string;
    /** Действующее (основное) назначение человека в объекте — цель переноса смены */
    assignmentId: string;
    avatar: string | null;
    positionNames: string[];
  }[];
  shifts: ShiftDto[];
  /** Есть ли неопубликованные смены в периоде (кнопка «Опубликовать») */
  hasDrafts: boolean;
}

// ---------- Оборудование ----------

export interface AssetModelDto {
  id: string;
  kind: AssetKind;
  name: string;
  manufacturer: string | null;
  category: string | null;
  glyph: string | null;
  archivedAt: string | null;
  /** Сколько экземпляров заведено по этой модели */
  assetsCount: number;
}

export interface AssetDto {
  id: string;
  workspaceId: string;
  branchId: string;
  branchName: string;
  modelId: string;
  modelName: string;
  manufacturer: string | null;
  kind: AssetKind;
  name: string;
  inventoryNumber: string | null;
  serialNumber: string | null;
  parentAssetId: string | null;
  parentAssetName: string | null;
  locationNote: string | null;
  custodianUserId: string | null;
  custodianName: string | null;
  status: AssetStatus;
  purchasedOn: string | null;
  commissionedOn: string | null;
  warrantyUntil: string | null;
  note: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Обложка плитки: первый файл-ФОТО целиком. Профиль `asset_photo` приватный —
   * ссылку веб получает через движок файлов (useFileDisplayUrl), а не из поля.
   */
  photo: FileDto | null;
  // ---- Денежное и балансовое: только при caps.payrollView ----
  holdingKind?: HoldingKind;
  balanceLegalEntityId?: string | null;
  balanceLegalEntityName?: string | null;
  holdingCounterpartyId?: string | null;
  holdingCounterpartyName?: string | null;
  purchasePrice?: string | null;
  currency?: string;
  /** Сумма расходов на обслуживание (TCO), тиыны строкой */
  serviceCost?: string;
}

export interface AssetMoveDto {
  id: string;
  assetId: string;
  kind: AssetMoveKind;
  fromLabel: string | null;
  toLabel: string | null;
  reason: string | null;
  movedById: string;
  movedByName: string | null;
  movedAt: string;
}

export interface AssetServiceRecordDto {
  id: string;
  assetId: string;
  kind: 'maintenance' | 'repair' | 'inspection';
  status: 'planned' | 'in_progress' | 'done' | 'cancelled';
  title: string;
  description: string | null;
  scheduledOn: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  nextDueOn: string | null;
  performedByUserId: string | null;
  performedByName: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  createdAt: string;
  /** Только при caps.payrollView */
  cost?: string | null;
  currency?: string;
}

/** Карточка актива: данные + журналы */
export interface AssetCardDto {
  asset: AssetDto;
  caps: ObjectCapsDto;
  moves: AssetMoveDto[];
  services: AssetServiceRecordDto[];
  children: { id: string; name: string; status: AssetStatus }[];
}

// ---------- Порт плана затрат (читают будущие Финансы) ----------

export interface PlannedPayrollRowDto {
  branchId: string;
  staffingPositionId: string;
  positionId: string;
  assignmentId: string | null;
  userId: string | null;
  rateType: RateType;
  /** Тиыны строкой */
  amount: string;
  rateShare: number;
  plannedShifts: number;
  plannedMin: number;
  plannedCost: string;
}
