import type { WorkspaceRole } from './roles';
import type {
  VisibilityLevel,
  VisibilityMaskKind,
  VisibilityRuleRevealMode,
  VisibilityWorkspaceAudienceKind,
} from '../visibility/types';

// ============================================================
// core/visibility — коды отказов, лимиты, ключи Redis, пресеты, находимость
// ============================================================

/**
 * Коды отказов (`details.code`); слова — каталог `errors.visibility.<code>`. Отказ НИКОГДА
 * не несёт значения поля (Directus CVE-2025-64749: различимые ответы — оракул).
 */
export const VISIBILITY_ERROR_CODES = {
  /** Правка поля, которое зритель видит не полностью */
  fieldForbidden: 'visibility.field_forbidden',
  /** В теле правки — значение, похожее на маску */
  maskedValueRejected: 'visibility.masked_value_rejected',
  /** Фильтр/сортировка/поиск/агрегат по полю, которое зритель видит не полностью */
  fieldNotQueryable: 'visibility.field_not_queryable',
  /** Публикация сняла обязательную видимость (ТК ст. 113 и т. п.) */
  mandatoryViolation: 'visibility.mandatory_violation',
  /** Ответ с защищёнными полями ушёл мимо `shape()` (страж ответа) */
  unshapedResponse: 'visibility.unshaped_response',
  /** План не даёт раскрытия этого поля */
  revealNotAllowed: 'visibility.reveal_not_allowed',
  /** Раскрытие строгого поля — окно SMS-подтверждения закрыто */
  stepUpRequired: 'visibility.step_up_required',
  /** Раскрытия приостановлены детекцией массового раскрытия */
  revealPaused: 'visibility.reveal_paused',
  /** Правило не годится (поле/группа/адресат/маска) */
  ruleInvalid: 'visibility.rule_invalid',
  /** Человек и в «Всегда», и в «Никогда» одного поля */
  exceptionConflict: 'visibility.exception_conflict',
  /** Черновика нет (опубликовать/удалить нечего) */
  draftMissing: 'visibility.draft_missing',
  /** Черновик изменили параллельно (публикуется не то, что показывал дифф) */
  draftChanged: 'visibility.draft_changed',
  /** Ослабление строгих полей — только с одобрения второго админа */
  dualControlRequired: 'visibility.dual_control_required',
  /** «Четыре глаза» включены, а одобрить некому (владелец/админ в организации один) */
  noSecondAdmin: 'visibility.no_second_admin',
  /** Тип записи не зарегистрирован */
  unknownRecordType: 'visibility.unknown_record_type',
  /** Запись для раскрытия / проверки не найдена или не видна */
  recordNotFound: 'visibility.record_not_found',
  /** Слишком много адресатов у одного поля */
  tooManyAudiences: 'visibility.too_many_audiences',
} as const;
export type VisibilityErrorCode = (typeof VISIBILITY_ERROR_CODES)[keyof typeof VISIBILITY_ERROR_CODES];

export const VISIBILITY_LIMITS = {
  /** Адресатов (включая исключения) на одно поле в одной политике */
  maxAudiencesPerField: 50,
  /** Исключений «всегда/никогда» на одно личное поле */
  maxExceptionsPerField: 200,
  /** Жёсткий потолок правил в политике (тарифный `visibility.maxRules` — ниже) */
  maxRulesHard: 5000,
  /** L1 LRU процесса (мс) */
  planL1TtlMs: 30_000,
  planL1Max: 20_000,
  /** L2 Redis (с) */
  planL2TtlSec: 300,
  policyL2TtlSec: 120,
  /** Раскрытое значение живёт на экране (с) — потом снова маска */
  revealShowSec: 600,
  /** Окно SMS-подтверждения раскрытия (мин) — как у ключей */
  stepUpMinutes: 15,
  /** Детекция массового раскрытия: столько раскрытий одним человеком за окно */
  massRevealThreshold: 30,
  massRevealWindowMin: 10,
  /** После срабатывания раскрытия этому человеку стоят (мин) до решения админа */
  massRevealPauseMin: 60,
  /**
   * Детекция скрейпинга: столько ЧУЖИХ строк с полями класса ≥ contact, ушедшими зрителю
   * целиком, за часовое окно — тревога `detect.pii_scrape` (без блокировки: решает организация)
   */
  personalRowsPerHour: 20_000,
  /** Полей в одном раскрытии */
  maxRevealFields: 12,
  /** Версий в списке «Версии» */
  versionsPageSize: 50,
} as const;

/** Ключи Redis движка. */
export const VISIBILITY_REDIS = {
  /** Скомпилированная политика владельца по типу (JSON {pv, rules}) */
  policy: (ownerKind: string, ownerId: string, recordType: string) => `vis:policy:${ownerKind}:${ownerId}:${recordType}`,
  /** Факты о зрителе (L2): принципалы оргструктуры под эпохой прав `core/access` (роль в ключе не живёт — читается свежей) */
  facts: (workspaceId: string | null, userId: string, epoch: string) => `vis:facts:${workspaceId ?? '-'}:${userId}:${epoch}`,
  /** Счётчик раскрытий человека в окне детекции */
  revealWindow: (actorId: string) => `vis:reveal:win:${actorId}`,
  /** Раскрытия человеку приостановлены детекцией */
  revealPause: (actorId: string) => `vis:reveal:pause:${actorId}`,
  /** Часовое окно чужих строк с полями ≥ contact, ушедшими целиком (детекция скрейпинга) */
  personalRows: (actorId: string, hourBucket: number) => `vis:rows:${actorId}:${hourBucket}`,
} as const;

/** Событие шины и сокета: политика владельца сменилась (клиент сбрасывает свои RQ-ключи). */
export const VISIBILITY_BUS_EVENTS = { changed: 'visibility.changed' } as const;
export const VISIBILITY_WS_EVENTS = { changed: 'visibility:changed' } as const;

// ---- Находимость по номеру (отдельная ось, решение грилла №9) ----

export const DISCOVERABLE_BY = ['everybody', 'circle', 'nobody'] as const;
export type DiscoverableBy = (typeof DISCOVERABLE_BY)[number];
export const DISCOVERABLE_BY_DEFAULT: DiscoverableBy = 'everybody';

// ---- Пресеты политики организации (первый вход: пресет создаёт ЧЕРНОВИК) ----

export const VISIBILITY_PRESET_KEYS = ['retail', 'office', 'strict'] as const;
export type VisibilityPresetKey = (typeof VISIBILITY_PRESET_KEYS)[number];

export interface VisibilityPresetRule {
  recordType: string;
  /** Поле ЛИБО группа полей типа */
  fieldKey?: string;
  groupKey?: string;
  audience: { kind: VisibilityWorkspaceAudienceKind; id: WorkspaceRole | null };
  effect: 'allow' | 'deny';
  level: VisibilityLevel;
  mask?: VisibilityMaskKind;
  reveal?: VisibilityRuleRevealMode;
}

const role = (id: WorkspaceRole) => ({ kind: 'role' as const, id });
const rel = (kind: 'manager_of' | 'branch_head_of') => ({ kind, id: null });

/**
 * Пресеты — отправная точка, не догма: человек правит черновик до публикации.
 * «Розница» — управляющие площадок видят факт и деньги своих точек, продавцы — контакты
 * клиентов маской; «Офис» — менеджеры продаж работают с клиентами (контакты полностью);
 * «Строгий» — оклад только владельцу/админу, контакты клиентов только менеджерам.
 */
export const VISIBILITY_PRESETS: Record<VisibilityPresetKey, readonly VisibilityPresetRule[]> = {
  retail: [
    { recordType: 'objects.shift', groupKey: 'schedule', audience: role('manager'), effect: 'allow', level: 'full' },
    { recordType: 'objects.staffing', groupKey: 'finance', audience: rel('branch_head_of'), effect: 'allow', level: 'full' },
    { recordType: 'counterparty', groupKey: 'contacts', audience: role('staff'), effect: 'allow', level: 'masked', mask: 'phone_partial' },
    { recordType: 'counterparty', groupKey: 'contacts', audience: role('trainee'), effect: 'allow', level: 'masked', mask: 'phone_partial' },
  ],
  office: [
    { recordType: 'counterparty', groupKey: 'contacts', audience: role('staff'), effect: 'allow', level: 'full' },
    { recordType: 'counterparty', groupKey: 'finance', audience: role('staff'), effect: 'allow', level: 'masked', mask: 'id_last4' },
    { recordType: 'workspace.card', fieldKey: 'contactPhone', audience: role('staff'), effect: 'allow', level: 'full' },
    { recordType: 'workspace.card', fieldKey: 'contactPhone', audience: role('manager'), effect: 'allow', level: 'full' },
  ],
  strict: [
    { recordType: 'hr.employment', fieldKey: 'salaryAmount', audience: rel('manager_of'), effect: 'deny', level: 'hidden' },
    { recordType: 'hr.employment', fieldKey: 'salaryAmount', audience: rel('branch_head_of'), effect: 'deny', level: 'hidden' },
    { recordType: 'counterparty', groupKey: 'contacts', audience: role('staff'), effect: 'deny', level: 'hidden' },
    { recordType: 'counterparty', groupKey: 'contacts', audience: role('trainee'), effect: 'deny', level: 'hidden' },
    { recordType: 'workspace.card', fieldKey: 'iban', audience: role('staff'), effect: 'deny', level: 'hidden' },
    { recordType: 'workspace.card', fieldKey: 'iban', audience: role('trainee'), effect: 'deny', level: 'hidden' },
  ],
};

/** Столбцы матрицы по умолчанию (порядок = порядок UI). «Сам» — всегда последним фиксированным. */
export const VISIBILITY_MATRIX_ROLE_COLUMNS: readonly WorkspaceRole[] = ['owner', 'admin', 'manager', 'staff', 'trainee', 'contractor'];

/**
 * Заявка «четырёх глаз» на публикацию политики видимости (core/approvals): предмет — черновик,
 * отпечаток — его правила; одобряет ДРУГОЙ владелец или админ организации.
 */
export const VISIBILITY_APPROVAL_REF_TYPE = 'visibility_publish';
