import type { WorkspaceRole } from '../constants/roles';
import type { DiscoverableBy, VisibilityPresetKey } from '../constants/visibility';
import type {
  VisibilityAudienceKind,
  VisibilityFieldCap,
  VisibilityFieldClass,
  VisibilityFieldGroup,
  VisibilityLevel,
  VisibilityMaskKind,
  VisibilityOwnerKind,
  VisibilityRevealMode,
  VisibilityRuleRevealMode,
  VisibilityWhySource,
} from '../visibility/types';

// ============================================================
// core/visibility — формы провода (одна форма на обеих сторонах)
// ============================================================

/** Адресат правила: `{kind:'role', id:'staff'}`, `{kind:'department', id}`, `{kind:'circle', id}`, `{kind:'everybody', id:null}`… */
export interface VisibilityAudienceRef {
  kind: VisibilityAudienceKind;
  id: string | null;
}

export type VisibilityRuleEffect = 'allow' | 'deny';
export type VisibilityPolicyStatus = 'draft' | 'published' | 'archived';

export interface VisibilityRuleSurfaces {
  /** Поле участвует в поиске по записи */
  inSearch?: boolean;
  /** Поле показывается в пикерах (EntitySelector) */
  inPickers?: boolean;
}

export interface VisibilityRuleDto {
  id: string;
  /** Ровно одно из трёх: поле, группа полей, секция */
  fieldKey: string | null;
  groupKey: VisibilityFieldGroup | null;
  sectionKey: string | null;
  audience: VisibilityAudienceRef;
  effect: VisibilityRuleEffect;
  level: VisibilityLevel;
  mask: VisibilityMaskKind | null;
  reveal: VisibilityRuleRevealMode;
  stage: string | null;
  surfaces: VisibilityRuleSurfaces | null;
  priority: number;
}

export interface VisibilityPolicyDto {
  id: string;
  ownerType: VisibilityOwnerKind;
  ownerId: string;
  recordType: string;
  version: number;
  status: VisibilityPolicyStatus;
  presetKey: VisibilityPresetKey | null;
  publishedAt: string | null;
  publishedById: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  rules: VisibilityRuleDto[];
}

/** Строка вкладки «Версии». */
export interface VisibilityPolicyVersionDto {
  id: string;
  recordType: string;
  version: number;
  status: VisibilityPolicyStatus;
  publishedAt: string | null;
  publishedById: string | null;
  ruleCount: number;
}

/** Настройки политики организации (R18). Правит только владелец. */
export interface WorkspaceVisibilitySettingsDto {
  /** Push сотруднику о раскрытии его данных (иначе — строка в «Моих данных» без push) */
  notifyOnReveal: boolean;
  /** Ослабление строгих (restricted) полей — только с одобрения второго админа */
  dualControl: boolean;
  /** Разрешить делегировать раскрытие адресатам оргструктуры (замок тарифа) */
  allowDelegation: boolean;
  updatedAt: string | null;
}

/** Паспорт поля для UI (слова — из каталога по ключам). */
export interface VisibilityFieldMetaDto {
  key: string;
  section: string;
  group: VisibilityFieldGroup;
  class: VisibilityFieldClass;
  control: 'subject' | 'controller';
  kind: string;
  masks: VisibilityMaskKind[];
  configurable: boolean;
  /** Почему ячейку нельзя менять: пол, обязательная видимость, секрет */
  locked: 'floor' | 'mandatory' | 'secret' | 'fixed' | null;
  /** Умолчание платформы по ролям (служебные поля) */
  defaults: Partial<Record<WorkspaceRole, VisibilityLevel>>;
  /** Умолчание по относительным адресатам */
  relativeDefaults: Partial<Record<'manager_of' | 'branch_head_of' | 'branch_payroll' | 'branch_scheduler', VisibilityLevel>>;
  revealDefault: WorkspaceRole[];
}

export interface VisibilityTypeMetaDto {
  recordType: string;
  service: string;
  owner: VisibilityOwnerKind;
  subject: 'user' | 'none';
  sections: string[];
  groups: VisibilityFieldGroup[];
  floor: string[];
  fields: VisibilityFieldMetaDto[];
  stages: string[];
}

/** Страница «Видимость данных» организации: сводка по типам. */
export interface VisibilityWorkspaceOverviewDto {
  types: VisibilityTypeMetaDto[];
  policies: {
    recordType: string;
    published: VisibilityPolicyVersionDto | null;
    draft: VisibilityPolicyVersionDto | null;
  }[];
  settings: WorkspaceVisibilitySettingsDto;
  /** Правил во всех опубликованных и черновых политиках организации / потолок тарифа (`null` — без потолка) */
  rulesUsed: number;
  rulesLimit: number | null;
  /** Замки тарифа (решение грилла №11) */
  features: { orgAudiences: boolean; revealDelegation: boolean };
}

/** Дифф черновика с опубликованной версией (модалка «Опубликовать»). */
export interface VisibilityDiffEntryDto {
  fieldKey: string;
  audience: VisibilityAudienceRef;
  from: VisibilityLevel;
  to: VisibilityLevel;
}
export interface VisibilityDiffDto {
  recordType: string;
  draftVersion: number;
  baseVersion: number | null;
  /** Токен черновика: публикация сверяет его (кто-то правил после диффа → 409) */
  draftToken: string;
  widened: VisibilityDiffEntryDto[];
  narrowed: VisibilityDiffEntryDto[];
  /** Сколько людей организации увидят больше / меньше (оценка по ролям и адресатам) */
  widenPeople: number;
  narrowPeople: number;
  /** Черновик ослабляет строгие (restricted) поля → нужен step-up (и «четыре глаза» по политике) */
  weakensRestricted: boolean;
  /** Нарушения обязательной видимости — публикация будет отвергнута */
  mandatoryViolations: string[];
}

/** Решение по полю для зрителя (без «почему» — для таблиц и пикеров). */
export interface VisibilityFieldPlanDto {
  level: VisibilityLevel;
  mask: VisibilityMaskKind | null;
  reveal: VisibilityRevealMode;
  caps: VisibilityFieldCap[];
}

/** `GET /visibility/plan?recordType=` — базовый план зрителя в «шляпе» запроса (R14). */
export interface VisibilityPlanDto {
  recordType: string;
  pv: number;
  fields: Record<string, VisibilityFieldPlanDto>;
}

export interface VisibilityWhyDto {
  source: VisibilityWhySource;
  ruleId?: string;
  audience?: VisibilityAudienceRef;
  role?: WorkspaceRole;
  relative?: string;
  /** Потолок, срезавший уровень (класс поля, потолок бота) */
  ceiling?: VisibilityLevel;
}

/** «Проверить сотрудника» / предпросмотр: уровень и «почему» по каждому полю. */
export interface VisibilityExplainDto {
  recordType: string;
  viewerId: string;
  subjectId: string | null;
  pv: number;
  fields: {
    fieldKey: string;
    level: VisibilityLevel;
    mask: VisibilityMaskKind | null;
    reveal: VisibilityRevealMode;
    why: VisibilityWhyDto;
  }[];
}

/** Ответ раскрытия: полные значения ОДНОЙ записи. Не кэшируется, живёт в памяти вкладки. */
export interface VisibilityRevealResultDto {
  recordType: string;
  recordId: string;
  values: Record<string, unknown>;
  /** До какого момента клиент показывает значение, потом снова маска */
  showUntil: string;
}

export interface VisibilityStepUpStatusDto {
  until: string | null;
}

// ---- Личная политика человека («Моя карточка и видимость») ----

export interface PersonalVisibilityFieldDto {
  fieldKey: string;
  /** Аудитории: everybody / circle_all / circle:<id> / colleagues[:<wsId>]; пусто = «Никто» */
  audiences: VisibilityAudienceRef[];
  /** Исключения «Всегда показывать» / «Никогда не показывать» (userId) */
  always: string[];
  never: string[];
  /** «Скрыть от Группы» (редактор Группы): сильнее аудиторий, слабее «Всегда» конкретному человеку */
  hiddenFromCircles: string[];
  /** Человек настраивал поле (иначе действуют умолчания платформы) */
  configured: boolean;
}

export interface PersonalVisibilityDto {
  pv: number;
  fields: PersonalVisibilityFieldDto[];
  discoverableBy: DiscoverableBy;
}

/** Предпросмотр своей карточки глазами синтетического зрителя (вызов explain, не чужая сессия). */
export type VisibilityPreviewAs =
  | { kind: 'stranger' }
  | { kind: 'circle_all' }
  | { kind: 'circle'; id: string }
  | { kind: 'colleague'; workspaceId: string }
  | { kind: 'user'; id: string };

/** Панель Кабинета `workspace.visibility` (карточка 360 организации). */
export interface PlatformWorkspaceVisibilityPanelDto {
  policies: { recordType: string; version: number; publishedAt: string | null; ruleCount: number; hasDraft: boolean }[];
  rulesTotal: number;
  settings: WorkspaceVisibilitySettingsDto;
  /** Раскрытий данных сотрудников за 30 дней */
  reveals30d: number;
  /** Детекций массового раскрытия за 30 дней */
  massRevealDetections30d: number;
}

/**
 * Итог «Опубликовать»: правила вступили в силу — либо (ослабление строгих полей при включённых
 * «четырёх глазах») ушла заявка второму владельцу/админу в «Ждут решения».
 */
export type VisibilityPublishResultDto =
  | { status: 'published'; policy: VisibilityPolicyDto }
  | { status: 'pending_approval'; approvalId: string };
