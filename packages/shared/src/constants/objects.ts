// ============================================================
// Сервис «Объекты» — словари и потолки.
// Объект = физическая площадка организации (StaffBranch): точка, здание, этаж,
// склад, зона. Дерево: права и люди родителя распространяются вниз.
// ============================================================

// Реестр называет ЗНАЧЕНИЕ и значок, слово даёт каталог (`objects.kind.<value>`).
export const OBJECT_KINDS = [
  { value: 'site', icon: 'storefront' },
  { value: 'building', icon: 'buildings' },
  { value: 'floor', icon: 'stairs' },
  { value: 'room', icon: 'door' },
  { value: 'warehouse', icon: 'warehouse' },
  { value: 'zone', icon: 'mapPin' },
  { value: 'other', icon: 'workspace' },
] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number]['value'];

/**
 * Тип ставки. `revenue_share` ЗАРЕЗЕРВИРОВАН: хранится, но не считается в план затрат.
 * Слова — каталог: `objects.rateType.<value>` (полное) и `objects.rateTypeShort.<value>`.
 */
export const RATE_TYPES = [
  { value: 'monthly' },
  { value: 'per_shift' },
  { value: 'hourly' },
  { value: 'revenue_share', reserved: true },
] as const;

export type RateType = (typeof RATE_TYPES)[number]['value'];

/** Типы ставок, участвующие в расчёте плана затрат (revenue_share — только хранение) */
export const PAYABLE_RATE_TYPES = ['monthly', 'per_shift', 'hourly'] as const;

/** Слово статуса — каталог `objects.shiftStatus.<value>` */
export const SHIFT_STATUSES = ['draft', 'published', 'cancelled'] as const;

export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

/** Слово исхода — каталог `objects.attendanceOutcome.<value>` */
export const ATTENDANCE_OUTCOMES = [
  { value: 'worked', tone: 'success' },
  { value: 'late', tone: 'warning' },
  { value: 'absent', tone: 'danger' },
] as const;

export type AttendanceOutcome = (typeof ATTENDANCE_OUTCOMES)[number]['value'];

/** Откуда факт выхода: рука менеджера, пропускная система, сам сотрудник */
export const ATTENDANCE_SOURCES = ['manual', 'access_control', 'self'] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

/** Слово статуса — каталог `objects.assetStatus.<value>` */
export const ASSET_STATUSES = [
  { value: 'active', tone: 'success' },
  { value: 'in_repair', tone: 'warning' },
  { value: 'stored', tone: 'neutral' },
  { value: 'written_off', tone: 'neutral' },
  { value: 'disposed', tone: 'neutral' },
] as const;

export type AssetStatus = (typeof ASSET_STATUSES)[number]['value'];

/**
 * Чьё оборудование: своё, в лизинге, в аренде, чужое (клиента/подрядчика).
 * Слово — каталог `objects.holdingKind.<value>`.
 */
export const HOLDING_KINDS = ['owned', 'leased', 'rented', 'third_party'] as const;

export type HoldingKind = (typeof HOLDING_KINDS)[number];

/** Слово вида — каталог `objects.assetKind.<value>` */
export const ASSET_KINDS = [
  { value: 'equipment', icon: 'wrench' },
  { value: 'vehicle', icon: 'truck' },
  { value: 'land', icon: 'buildings' },
  { value: 'other', icon: 'toolbox' },
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number]['value'];

/** Виды записей журнала перемещений (append-only) */
export const ASSET_MOVE_KINDS = ['placement', 'custodian', 'holding', 'status'] as const;
export type AssetMoveKind = (typeof ASSET_MOVE_KINDS)[number];

/** Слово вида работ — каталог `objects.assetServiceKind.<value>` */
export const ASSET_SERVICE_KINDS = ['maintenance', 'repair', 'inspection'] as const;

/** Слово статуса работ — каталог `objects.assetServiceStatus.<value>` */
export const ASSET_SERVICE_STATUSES = ['planned', 'in_progress', 'done', 'cancelled'] as const;

// Потолок узлов дерева на организацию — ключ `objects.maxPerWorkspace` реестра entitlements.
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
