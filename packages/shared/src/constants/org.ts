// ============================================================
// Орг. структура (B2B) — константы вертикали, заместителей, областных прав
// ============================================================
// Оргструктура — граф ДОЛЖНОСТЕЙ и ОБЪЕКТОВ, не людей и не штатного расписания.
// «Кто мой руководитель» решает ровно одно место — resolver в modules/staff
// (образец `ContactsService.resolveCircleMemberIds`): все B2B-сервисы спрашивают его.

import type { WorkspaceRole } from './roles';

export const ORG_LIMITS = {
  /** Потолок цельного графа канваса; больше — честный 409 `org_chart_too_big` */
  maxChartPositions: 1000,
  /** Стоп-кран подъёма по вертикали (защита от повреждённых данных) */
  maxChainDepth: 32,
  /** Разворот «зам — должность → её зам — должность…» */
  maxDeputyDepth: 3,
  /** Заместителей на одну должность (анти-мусор) */
  maxDeputiesPerPosition: 20,
  /** Снимок «Моя команда» в профиле (остальное — числом) */
  teamPreview: 12,
} as const;

/**
 * Кто правит структуру ЦЕЛИКОМ (области добавляют, не отнимают). Сужение до
 * `['owner','admin']` — одной константой, вместе с ролью «Кадры» (техдолг в roadmap).
 */
export const STAFF_FULL_SCOPE_ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'manager'];

/** Машиночитаемые коды ошибок оргструктуры (`details.code` общего конверта) */
export const ORG_ERROR_CODES = {
  /** Подчинение замыкается в цикл (в т.ч. смешанный: reportsTo + дерево + голова объекта) */
  cycle: 'org_cycle',
  /** Граф больше потолка ORG_LIMITS.maxChartPositions */
  chartTooBig: 'org_chart_too_big',
  /** Должность руководит отделом или объектом — сначала снимите её с руководства */
  headInUse: 'org_head_in_use',
  /** Последний/основной объект удалить нельзя; перенос флага — явным действием */
  defaultBranch: 'org_default_branch',
  /** Область прав: не ваша ветка/объект */
  scopeForbidden: 'org_scope_forbidden',
  /** Заместитель: цель не в организации или совпадает с замещаемым */
  deputyTarget: 'org_deputy_target',
} as const;
export type OrgErrorCode = (typeof ORG_ERROR_CODES)[keyof typeof ORG_ERROR_CODES];

/** Почему руководитель определился именно так (подпись в UI и в снимках согласований) */
export const ORG_MANAGER_REASONS = ['position', 'owner_fallback'] as const;
export type OrgManagerReason = (typeof ORG_MANAGER_REASONS)[number];

export const ORG_MANAGER_REASON_LABELS: Record<OrgManagerReason, string> = {
  position: 'по структуре',
  owner_fallback: 'руководитель не найден → владелец организации',
};

/** Вид замещения: без дат — запасной; с датами — вместо на период */
export const ORG_DEPUTY_KINDS = ['standing', 'temporary'] as const;
export type OrgDeputyKind = (typeof ORG_DEPUTY_KINDS)[number];

export const ORG_DEPUTY_KIND_LABELS: Record<OrgDeputyKind, string> = {
  standing: 'Запасной (когда некому)',
  temporary: 'Замещает на период',
};

/** Виды канваса (одна схема — переключатель видов, приём реестра слоёв календаря) */
export const ORG_CHART_VIEWS = ['reports', 'deputies'] as const;
export type OrgChartView = (typeof ORG_CHART_VIEWS)[number];
