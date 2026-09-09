// ============================================================
// core/audiences (16-й платформенный движок) — единый словарь АДРЕСАТОВ
// ============================================================
// «Кому адресовано»: человек, Группа, вся команда, отдел, должность, объект — и
// ОТНОСИТЕЛЬНЫЕ виды (руководитель кого-то, команда кого-то, руководитель объекта
// кого-то), которые разворачиваются по оргструктуре. Одна карта на платформу: до
// движка четыре потребителя держали по копии разворота и знали наизусть имена
// отношений проекции прав.
//
// Движок РЕШАЕТ, кому адресовано (userId[]), и НЕ пишет гранты: шаблоны и Диск
// по-прежнему пишут рёбра сами (`principalsFor` отдаёт им форму субъекта).
// Относительные виды — не принципалы (`grantable: false`): их нельзя записать
// в ребро прав, потому что «руководитель X» меняется со временем.

export const AUDIENCE_KINDS = [
  'user',
  'circle',
  'workspace',
  'department',
  'position',
  'branch',
  'manager_of',
  'subordinates_of',
  'branch_head_of',
] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

/**
 * Якоря — подстановки вместо id у относительных видов (и у `user`): кто именно
 * «инициатор», «сторона документа», «я» — знает контекст вызова (AudienceContext).
 * Якорь без контекста — честная ошибка `audience_anchor_unavailable`, не пустой список.
 */
export const AUDIENCE_ANCHORS = {
  initiator: '$initiator',
  subject: '$subject',
  self: '$self',
} as const;
export type AudienceAnchor = (typeof AUDIENCE_ANCHORS)[keyof typeof AUDIENCE_ANCHORS];
export const AUDIENCE_ANCHOR_IDS: readonly string[] = Object.values(AUDIENCE_ANCHORS);

export function isAudienceAnchor(id: string): id is AudienceAnchor {
  return AUDIENCE_ANCHOR_IDS.includes(id);
}

/**
 * Якорь → КЛЮЧ каталога (`common.audience.anchor.<ключ>`). Реестр называет смысл,
 * слово ему даёт каталог: подпись адресата читает человек.
 */
export const AUDIENCE_ANCHOR_KEYS: Record<AudienceAnchor, string> = {
  $initiator: 'initiator',
  $subject: 'subject',
  $self: 'self',
};

export interface AudienceKindDef {
  /** Разворачивается по оргструктуре относительно человека (id = userId или якорь) */
  relative: boolean;
  /** Может быть ПОЛУЧАТЕЛЕМ гранта в движке прав (subjectType tuple'а) */
  grantable: boolean;
  /** Существует только в контексте организации */
  workspaceOnly: boolean;
}

/**
 * Свойства вида адресата. Слова у видов нет: подпись даёт каталог по ключу вида
 * (`common.audience.kind.<вид>`) в языке зрителя.
 */
export const AUDIENCE_KIND_DEFS: Record<AudienceKind, AudienceKindDef> = {
  user: { relative: false, grantable: true, workspaceOnly: false },
  circle: { relative: false, grantable: true, workspaceOnly: false },
  workspace: { relative: false, grantable: true, workspaceOnly: true },
  department: { relative: false, grantable: true, workspaceOnly: true },
  position: { relative: false, grantable: true, workspaceOnly: true },
  branch: { relative: false, grantable: true, workspaceOnly: true },
  manager_of: { relative: true, grantable: false, workspaceOnly: true },
  subordinates_of: { relative: true, grantable: false, workspaceOnly: true },
  branch_head_of: { relative: true, grantable: false, workspaceOnly: true },
};

/** Наборы видов на потребителя — каждый enum ниже есть ПОДМНОЖЕСТВО AUDIENCE_KINDS */

/** Шаг согласования (снимок при активации; вся команда/Группа — не адресаты решения) */
export const APPROVAL_AUDIENCE_KINDS = ['user', 'position', 'department', 'branch', 'manager_of', 'branch_head_of'] as const;
/** Кампании ознакомления и массовые кадровые действия */
export const CAMPAIGN_AUDIENCE_KINDS = [
  'user',
  'position',
  'department',
  'branch',
  'workspace',
  'manager_of',
  'subordinates_of',
  'branch_head_of',
] as const;
/** Кому доступен бланк (только принципалы движка прав, живущие в организации) */
export const DOC_TEMPLATE_GRANT_KINDS = ['user', 'department', 'position', 'branch'] as const;
/** Шеринг Диска (личный диск: человек и Группа; диск организации: её оси) */
export const DRIVE_SHARE_KINDS = ['user', 'circle', 'workspace', 'department', 'position', 'branch'] as const;

export const AUDIENCE_ERROR_CODES = {
  /** Якорь ($initiator/$subject/$self) без соответствующего контекста */
  anchorUnavailable: 'audience_anchor_unavailable',
  /** Состав больше потолка потребителя (режим throw) */
  overflow: 'audience_overflow',
  /** Вид адресата не разрешён этому потребителю */
  kindNotAllowed: 'audience_kind_not_allowed',
} as const;
export type AudienceErrorCode = (typeof AUDIENCE_ERROR_CODES)[keyof typeof AUDIENCE_ERROR_CODES];
