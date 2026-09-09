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

// Статус назначения (`training` | `certified`) слова не несёт: его даёт каталог —
// `staff.assignmentStatus.<статус>`.
