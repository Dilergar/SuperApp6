// ============================================================
// core/chatter («Хроника записи») — константы
// Универсальная лента «кто/что/когда + было → стало» на любой сущности
// (refType+refId). Реестр типов записей — как NOTIFICATION_REGISTRY:
// один источник шаблонов для API (плашки в чат) и веба (журнал).
// ============================================================

import { interpolateTemplate } from '../utils/interpolate';

/** Категории для фильтра «Журнала организации» */
export const CHATTER_CATEGORIES = ['tasks', 'staff'] as const;
export type ChatterCategory = (typeof CHATTER_CATEGORIES)[number];

export interface ChatterTypeMeta {
  /**
   * Шаблон текста для renderChatterText. Плейсхолдеры {{...}}:
   * actorName (фолбэк «Кто-то»), from/to (из changes[0]) + любые ключи payload
   * (targetName, roleLabel, positionName, branchSuffix…).
   */
  template: string;
  icon: string;
  category: ChatterCategory;
  /** Проецировать плашкой в контекстный чат сущности (если у refType зарегистрирован chat-sink) */
  chatPost: boolean;
}

// ВАЖНО (паритет плашек): шаблоны task.assigned/submitted/accepted/returned/completed
// байт-в-байт повторяют тексты удалённого TaskSystemListener — веб-рендер плашек не меняется.
export const CHATTER_REGISTRY = {
  // ---- Задачи (refType='task'; typeKey = eventType плашки в чате задачи) ----
  'task.created': {
    template: '{{actorName}} создал(а) задачу',
    icon: '🆕',
    category: 'tasks',
    chatPost: false, // сегодня плашки нет — не спамим само-задачи
  },
  'task.assigned': {
    template: '{{actorName}} назначил(а) задачу',
    icon: '👤',
    category: 'tasks',
    chatPost: true,
  },
  'task.submitted': {
    template: '{{actorName}} сдал(а) работу на проверку',
    icon: '📤',
    category: 'tasks',
    chatPost: true,
  },
  'task.accepted': {
    template: 'Работа принята',
    icon: '✅',
    category: 'tasks',
    chatPost: true,
  },
  'task.returned': {
    template: 'Работа возвращена на доработку',
    icon: '↩️',
    category: 'tasks',
    chatPost: true,
  },
  'task.completed': {
    template: 'Задача выполнена',
    icon: '🎉',
    category: 'tasks',
    chatPost: true,
  },
  'task.cancelled': {
    template: '{{actorName}} отменил(а) задачу',
    icon: '🚫',
    category: 'tasks',
    chatPost: true,
  },
  'task.deadline_changed': {
    template: '{{actorName}} изменил(а) срок: {{from}} → {{to}}',
    icon: '📅',
    category: 'tasks',
    chatPost: true,
  },
  'task.priority_changed': {
    template: '{{actorName}} изменил(а) приоритет: {{from}} → {{to}}',
    icon: '⚡',
    category: 'tasks',
    chatPost: true,
  },
  'task.reward_changed': {
    template: '{{actorName}} изменил(а) награду: {{from}} → {{to}}',
    icon: '🪙',
    category: 'tasks',
    chatPost: true,
  },
  'task.title_changed': {
    template: '{{actorName}} переименовал(а) задачу: «{{from}}» → «{{to}}»',
    icon: '✏️',
    category: 'tasks',
    chatPost: true,
  },
  'task.description_changed': {
    template: '{{actorName}} обновил(а) описание',
    icon: '📝',
    category: 'tasks',
    chatPost: true,
  },
  'task.participant_added': {
    template: '{{actorName}} добавил(а) {{targetName}} — {{roleLabel}}',
    icon: '➕',
    category: 'tasks',
    chatPost: true,
  },
  'task.participant_removed': {
    template: '{{actorName}} исключил(а) {{targetName}}',
    icon: '➖',
    category: 'tasks',
    chatPost: true,
  },

  // ---- Организация (refType='workspace', refId=workspaceId; поверхность — «Журнал», в чат не постятся) ----
  'staff.invited': {
    template: '{{actorName}} пригласил(а) {{targetName}} в организацию',
    icon: '✉️',
    category: 'staff',
    chatPost: false,
  },
  'staff.hired': {
    template: '{{actorName}} вступил(а) в организацию (Стажёр)',
    icon: '🤝',
    category: 'staff',
    chatPost: false,
  },
  'staff.fired': {
    template: '{{actorName}} уволил(а) {{targetName}}',
    icon: '🚪',
    category: 'staff',
    chatPost: false,
  },
  'staff.left': {
    template: '{{actorName}} покинул(а) организацию',
    icon: '🚪',
    category: 'staff',
    chatPost: false,
  },
  'staff.role_changed': {
    template: '{{actorName}} изменил(а) роль {{targetName}}: {{from}} → {{to}}',
    icon: '🎖️',
    category: 'staff',
    chatPost: false,
  },
  'staff.ownership_transferred': {
    template: '{{actorName}} передал(а) владение организацией — {{targetName}}',
    icon: '👑',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_assigned': {
    // {{branchClause}} выводится рендером из сырого payload.branchName (презентация
    // не запекается в вечную строку — формат можно поменять без миграции данных).
    template: '{{actorName}} назначил(а) {{targetName}} на должность «{{positionName}}»{{branchClause}}',
    icon: '💼',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_updated': {
    template: '{{actorName}} изменил(а) назначение {{targetName}} («{{positionName}}»): {{from}} → {{to}}',
    icon: '🔀',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_certified': {
    template: '{{targetName}} аттестован(а) по должности «{{positionName}}»',
    icon: '🎓',
    category: 'staff',
    chatPost: false,
  },
  'staff.position_removed': {
    template: '{{actorName}} снял(а) {{targetName}} с должности «{{positionName}}»',
    icon: '📤',
    category: 'staff',
    chatPost: false,
  },
} as const satisfies Record<string, ChatterTypeMeta>;

export type ChatterTypeKey = keyof typeof CHATTER_REGISTRY;

/** typeKeys категории (фильтр журнала: category → typeKey IN (...)) */
export function chatterTypeKeysOf(category: ChatterCategory): string[] {
  return Object.entries(CHATTER_REGISTRY)
    .filter(([, meta]) => meta.category === category)
    .map(([key]) => key);
}

export const CHATTER_LIMITS = {
  pageSize: 30,
  maxPageSize: 100,
  /** Батч бэкфилла незапощенных плашек на bootstrap (деплой-переход на core/jobs). */
  chatPostBatch: 100,
  /**
   * Потолок попыток проекции плашки (maxAttempts джоба chatter.chatpost в core/jobs):
   * после N безуспешных — dead-letter движка (не вечный цикл).
   */
  chatPostMaxAttempts: 8,
  /**
   * Окно бэкфилла на bootstrap: незапощенные записи старше — не догоняем (иначе
   * поздняя регистрация синка вылила бы в чат всю накопленную историю залпом).
   * Штатный путь — джоб, поставленный в транзакции самой записи.
   */
  redriveMaxAgeSec: 86_400,
} as const;

/**
 * Единый рендер текста записи хроники ({{placeholder}}, как у уведомлений).
 * Используется и API-синком (текст плашки в чат), и вебом (журнал) — одна строка везде.
 * Отсутствующие ключи → пустая строка (клиент не видит голый {{...}}).
 */
export function renderChatterText(
  typeKey: string,
  entry: {
    actorName?: string | null;
    changes?: ReadonlyArray<{ from: string | null; to: string | null }> | null;
    payload?: Record<string, unknown> | null;
  },
): string {
  const meta = (CHATTER_REGISTRY as Record<string, ChatterTypeMeta>)[typeKey];
  if (!meta) return typeKey;
  const first = entry.changes?.[0];
  // payload — снизу; from/to/actorName — сверху: авторитетные значения из changes
  // и снапшот актёра НЕ перекрываются одноимённым ключом payload.
  const vars: Record<string, unknown> = {
    ...(entry.payload ?? {}),
    from: first?.from ?? '—',
    to: first?.to ?? '—',
    actorName: entry.actorName?.trim() || 'Кто-то',
  };
  // Условная презентация — в рендере (не запечена в payload): филиал показываем,
  // только если он есть; формат можно менять без миграции вечных записей.
  if (vars.branchClause === undefined) {
    const branchName = entry.payload?.branchName;
    vars.branchClause = typeof branchName === 'string' && branchName
      ? ` · филиал «${branchName}»`
      : '';
  }
  return interpolateTemplate(meta.template, vars);
}
