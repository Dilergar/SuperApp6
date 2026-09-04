// ============================================================
// Сервис «Объекты» — словари и потолки.
// Объект = физическая площадка организации (StaffBranch): точка, здание, этаж,
// склад, зона. Дерево: права и люди родителя распространяются вниз.
// ============================================================

export const OBJECT_KINDS = [
  { value: 'site', label: 'Площадка', icon: 'storefront' },
  { value: 'building', label: 'Здание', icon: 'buildings' },
  { value: 'floor', label: 'Этаж', icon: 'stairs' },
  { value: 'room', label: 'Помещение', icon: 'door' },
  { value: 'warehouse', label: 'Склад', icon: 'warehouse' },
  { value: 'zone', label: 'Зона', icon: 'mapPin' },
  { value: 'other', label: 'Другое', icon: 'workspace' },
] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number]['value'];

/** Тип ставки. `revenue_share` ЗАРЕЗЕРВИРОВАН: хранится, но не считается в план затрат. */
export const RATE_TYPES = [
  { value: 'monthly', label: 'В месяц', short: 'мес.' },
  { value: 'per_shift', label: 'За смену', short: 'смена' },
  { value: 'hourly', label: 'В час', short: 'час' },
  { value: 'revenue_share', label: 'Процент с выручки', short: '%', reserved: true },
] as const;

export type RateType = (typeof RATE_TYPES)[number]['value'];

/** Типы ставок, участвующие в расчёте плана затрат (revenue_share — только хранение) */
export const PAYABLE_RATE_TYPES = ['monthly', 'per_shift', 'hourly'] as const;

export const SHIFT_STATUSES = [
  { value: 'draft', label: 'Черновик', tone: 'neutral' },
  { value: 'published', label: 'Опубликована', tone: 'success' },
  { value: 'cancelled', label: 'Отменена', tone: 'danger' },
] as const;

export type ShiftStatus = (typeof SHIFT_STATUSES)[number]['value'];

export const ATTENDANCE_OUTCOMES = [
  { value: 'worked', label: 'Вышел', tone: 'success' },
  { value: 'late', label: 'Опоздал', tone: 'warning' },
  { value: 'absent', label: 'Не вышел', tone: 'danger' },
] as const;

export type AttendanceOutcome = (typeof ATTENDANCE_OUTCOMES)[number]['value'];

/** Откуда факт выхода: рука менеджера, пропускная система, сам сотрудник */
export const ATTENDANCE_SOURCES = ['manual', 'access_control', 'self'] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

export const ASSET_STATUSES = [
  { value: 'active', label: 'В работе', tone: 'success' },
  { value: 'in_repair', label: 'В ремонте', tone: 'warning' },
  { value: 'stored', label: 'На хранении', tone: 'neutral' },
  { value: 'written_off', label: 'Списано', tone: 'neutral' },
  { value: 'disposed', label: 'Утилизировано', tone: 'neutral' },
] as const;

export type AssetStatus = (typeof ASSET_STATUSES)[number]['value'];

/** Чьё оборудование: своё, в лизинге, в аренде, чужое (клиента/подрядчика) */
export const HOLDING_KINDS = [
  { value: 'owned', label: 'Собственное' },
  { value: 'leased', label: 'Лизинг' },
  { value: 'rented', label: 'Аренда' },
  { value: 'third_party', label: 'Чужое' },
] as const;

export type HoldingKind = (typeof HOLDING_KINDS)[number]['value'];

export const ASSET_KINDS = [
  { value: 'equipment', label: 'Оборудование', icon: 'wrench' },
  { value: 'vehicle', label: 'Транспорт', icon: 'truck' },
  { value: 'land', label: 'Земля/недвижимость', icon: 'buildings' },
  { value: 'other', label: 'Другое', icon: 'toolbox' },
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number]['value'];

/** Виды записей журнала перемещений (append-only) */
export const ASSET_MOVE_KINDS = ['placement', 'custodian', 'holding', 'status'] as const;
export type AssetMoveKind = (typeof ASSET_MOVE_KINDS)[number];

export const ASSET_SERVICE_KINDS = [
  { value: 'maintenance', label: 'Обслуживание' },
  { value: 'repair', label: 'Ремонт' },
  { value: 'inspection', label: 'Осмотр' },
] as const;

export const ASSET_SERVICE_STATUSES = [
  { value: 'planned', label: 'Запланировано', tone: 'neutral' },
  { value: 'in_progress', label: 'В работе', tone: 'warning' },
  { value: 'done', label: 'Выполнено', tone: 'success' },
  { value: 'cancelled', label: 'Отменено', tone: 'neutral' },
] as const;

export const OBJECT_LIMITS = {
  /** Глубина дерева объектов (площадка → здание → этаж → помещение → зона → …) */
  maxDepth: 6,
  /** Горизонт генерации смен по шаблону ротации, дней */
  horizonDays: 42,
  /** Максимум минут в смене (12 ч) — правило объекта, можно ослабить в настройках */
  maxShiftMin: 720,
  /** Межсменный отдых, минут (12 ч) */
  minRestMin: 720,
  /** Допуск опоздания, минут */
  lateToleranceMin: 10,
  /** Ставок по штату на одну единицу */
  maxHeadcount: 999,
  nameMaxLength: 120,
  noteMaxLength: 2000,
  /** Окно сетки смен за один запрос, дней (сетка недельная; месяц с запасом) */
  maxBoardDays: 62,
  /** Объектов в организации (сеть) */
  maxObjectsPerWorkspace: 2000,
  /** Смен, публикуемых за один вызов */
  maxPublishBatch: 2000,
} as const;

/** Настройки смен объекта по умолчанию (правила — данные, не константы кода) */
export const DEFAULT_SCHEDULE_SETTINGS = {
  minRestMin: OBJECT_LIMITS.minRestMin,
  maxShiftMin: OBJECT_LIMITS.maxShiftMin,
  lateToleranceMin: OBJECT_LIMITS.lateToleranceMin,
  /** 1 = неделя с понедельника (ISO) */
  weekStartsOn: 1,
  accountingPeriod: 'month' as const,
};

export const OBJECTS_ERROR_CODES = {
  objectHasChildren: 'object_has_children',
  objectInUse: 'object_in_use',
  objectCycle: 'object_cycle',
  objectTooDeep: 'object_too_deep',
  objectArchived: 'object_archived',
  assignmentOverlap: 'assignment_overlap',
  staffingUnitDuplicate: 'staffing_unit_duplicate',
  rateOverlap: 'rate_overlap',
  shiftOverlap: 'shift_overlap',
  restViolation: 'rest_violation',
  shiftTooLong: 'shift_too_long',
  shiftNotOpen: 'shift_not_open',
  shiftWrongPosition: 'shift_wrong_position',
  attendanceExists: 'attendance_exists',
  assetInventoryDuplicate: 'asset_inventory_duplicate',
  assetModelInUse: 'asset_model_in_use',
} as const;

/**
 * Роли организации, которым управленческие деньги видны ВЕЗДЕ (без объектного гранта).
 * Управляющий своего объекта получает то же через `branch.payroll.view`.
 */
export const OBJECTS_PAYROLL_FULL_ROLES = ['owner', 'admin'] as const;

/** Роли организации с полной картиной объектов (дерево целиком, правка, штат) */
export const OBJECTS_FULL_SCOPE_ROLES = ['owner', 'admin'] as const;
