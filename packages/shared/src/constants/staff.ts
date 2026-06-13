// ============================================================
// Staff (B2B «Сотрудники») — лимиты справочников (анти-мусор, не бизнес-лимиты)
// ============================================================

export const STAFF_LIMITS = {
  maxDepartmentsPerWorkspace: 200,
  maxPositionsPerWorkspace: 300,
  maxBranchesPerWorkspace: 200,
  /** Несколько должностей на человека — норма; потолок против случайного спама. */
  maxAssignmentsPerMember: 20,
} as const;

export const STAFF_ASSIGNMENT_STATUS_LABELS: Record<'training' | 'certified', string> = {
  training: 'Стажируется',
  certified: 'Аттестован',
} as const;
