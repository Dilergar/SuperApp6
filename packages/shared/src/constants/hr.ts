// ============================================================
// КЭДО — кадровый электронный документооборот (modules/hr) — константы.
//
// Юридическая рамка ТК РК зашита СПРАВОЧНИКАМИ с явными единицами измерения:
// в одном сервисе соседствуют «15 календарных» (ст. 46) и «15 рабочих»
// (ст. 53 п. 2), и хранить единицу соглашением, а не полем — способ однажды
// недосчитать срок (недосчёт = штраф, ст. 98 КоАП РК).
//
// СЛОВ здесь нет. Реестр называет СМЫСЛ (значение перечисления, единицу срока,
// инициативу работодателя), слово даёт каталог `hr` по ключу, выведенному из
// самого значения: `hr.actionKind.<вид>`, `hr.actionStatus.<статус>`,
// `hr.ground.<основание>`, `hr.esutdKind.<вид>`. Готовая строка в общем пакете —
// это один язык навсегда и сразу у трёх клиентов (API, веб, мобильный).
// ============================================================

// ---------- Трудовая карточка (Employment) ----------

/** Слово — `hr.employmentStatus.<статус>` */
export const EMPLOYMENT_STATUSES = ['draft', 'active', 'terminated'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

/** Слово — `hr.contractType.<вид>` */
export const CONTRACT_TYPES = ['indefinite', 'fixed_term', 'seasonal', 'task_based'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

/**
 * Ст. 30 п. 1 пп. 2 ТК РК: не уведомили в последний рабочий день — срочный
 * договор продлевается на тот же срок; продление молчанием — МАКСИМУМ 2 раза,
 * дальше договор считается заключённым на неопределённый срок. Счётчик
 * `contractExtensionsCount` сверяется с этим потолком (плашка, не блок).
 */
export const CONTRACT_MAX_SILENT_EXTENSIONS = 2;

// ---------- Кадровые действия ----------

/** Слово — `hr.actionKind.<вид>` */
export const HR_ACTION_KINDS = ['hire', 'transfer', 'salary_change', 'leave', 'dismissal'] as const;
export type HrActionKind = (typeof HR_ACTION_KINDS)[number];

/**
 * `scheduled` — отдельный статус намеренно: документы подписаны, действие ждёт
 * даты вступления в силу. Без него списки не различают «на подписи у директора»
 * и «подписано, вступает в силу 1 сентября» — а это разные ответы на вопрос
 * «почему человек ещё не переведён». Слово — `hr.actionStatus.<статус>`.
 */
export const HR_ACTION_STATUSES = [
  'draft',
  'in_progress',
  'scheduled',
  'applied',
  'cancelled',
  'failed',
] as const;
export type HrActionStatus = (typeof HR_ACTION_STATUSES)[number];

/** Та же сущность, два входа: заявление работника и решение работодателя */
export const HR_ACTION_SOURCES = ['employee', 'employer'] as const;
export type HrActionSource = (typeof HR_ACTION_SOURCES)[number];

// ---------- Основания прекращения (справочник статей ТК РК) ----------

/**
 * Основание = значение + признак инициативы работодателя (на неё действует
 * запрет ст. 54). Сама формулировка статьи — слово: `hr.ground.<основание>`.
 */
export const DISMISSAL_GROUNDS = [
  { value: 'st50', employerInitiative: false },
  { value: 'st51', employerInitiative: false },
  { value: 'st52_p1_1', employerInitiative: true },
  { value: 'st52_p1_2', employerInitiative: true },
  { value: 'st52_p1_3', employerInitiative: true },
  { value: 'st52_p1_18', employerInitiative: true },
  { value: 'st52_p1_20', employerInitiative: true },
  { value: 'st52_p1_23', employerInitiative: true },
  { value: 'st52_p1_1_1', employerInitiative: true },
  { value: 'st52_other', employerInitiative: true },
  { value: 'st56', employerInitiative: false },
  { value: 'st58', employerInitiative: false },
  { value: 'other', employerInitiative: false },
] as const;
export type DismissalGround = (typeof DISMISSAL_GROUNDS)[number]['value'];

/** Основание — инициатива работодателя (на него действует запрет ст. 54) */
export function isEmployerInitiativeGround(ground: string | null | undefined): boolean {
  return DISMISSAL_GROUNDS.some((g) => g.value === ground && g.employerInitiative);
}

/**
 * Исключения из запрета ст. 54 ТК РК (увольнение по инициативе работодателя в
 * период временной нетрудоспособности и отпуска). Их ПЯТЬ, не одна ликвидация:
 * пп. 1), 18), 20), 23) п. 1 ст. 52 и п. 1-1 (ред. 07.04.2026) — все пять стоят
 * в справочнике оснований и в этом списке. Проверка в момент применения знает
 * их все; границы данных честные: отпуска — по данным системы, больничные
 * системе неизвестны («проверьте вручную» — обязательная формулировка).
 *
 * Пояснение для человека — `hr.st54ExceptionsNote`.
 */
export const ST54_BAN_EXCEPTION_GROUNDS: readonly string[] = [
  'st52_p1_1',
  'st52_p1_18',
  'st52_p1_20',
  'st52_p1_23',
  'st52_p1_1_1',
];

// ---------- Юридические сроки (калькулятор) ----------

/** Единица срока: рабочие дни считаются по производственному календарю РК */
export type HrDeadlineUnit = 'work_days' | 'calendar_days' | 'months';

export interface HrDeadlineRule {
  key: string;
  amount: number;
  unit: HrDeadlineUnit;
}

/**
 * Таблица норм, которые система обязана знать: ВЕЛИЧИНА и ЕДИНИЦА срока. Единица —
 * ПОЛЕМ, не соглашением. Статья названа в комментарии строки, а не полем: она
 * СЛОВО (по-казахски «ҚР ЕК 56-бабы»), и полем разъехалась бы по языкам; там,
 * где статья показывается человеку, её даёт каталог (`hr.esutd.article.<вид>`).
 *
 * Проверено по официальным текстам (adilet.zan.kz); нормы «ответ работника
 * 5 рабочих дней» НЕ СУЩЕСТВУЕТ (п. 3 ст. 46 даёт лишь право отказаться) —
 * блокирующих таймеров на ней не строим.
 */
export const HR_DEADLINE_RULES: readonly HrDeadlineRule[] = [
  // ст. 56 п. 1 ТК РК — от подачи заявления (увольнение по собственному желанию)
  { key: 'resignation_notice', amount: 1, unit: 'months' },
  // ст. 53 п. 1 ТК РК — до даты прекращения (ликвидация / сокращение)
  { key: 'liquidation_notice', amount: 1, unit: 'months' },
  // ст. 53 п. 2 ТК РК — до даты прекращения (снижение объёма производства)
  { key: 'production_cut_notice', amount: 15, unit: 'work_days' },
  // ст. 61 п. 3 ТК РК — со дня издания (вручение акта о прекращении)
  { key: 'termination_act_delivery', amount: 3, unit: 'work_days' },
  // ст. 113 п. 4 ТК РК — со дня прекращения (окончательный расчёт)
  { key: 'final_settlement', amount: 3, unit: 'work_days' },
  // ст. 62 п. 1 ТК РК — в день прекращения (документ о трудовой деятельности)
  { key: 'work_activity_doc', amount: 0, unit: 'work_days' },
  // ст. 62 п. 2 ТК РК — с обращения (справка по требованию работника)
  { key: 'certificate_on_request', amount: 5, unit: 'work_days' },
  // ст. 46 п. 2 ТК РК — до изменения условий труда (только письменно: бумага
  // или электронный документ с ЭЦП, ред. 08.06.2026)
  { key: 'conditions_change_notice', amount: 15, unit: 'calendar_days' },
  // ст. 92 п. 4 ТК РК — до начала отпуска (оплата отпуска)
  { key: 'vacation_pay', amount: 3, unit: 'work_days' },
  // ст. 65 п. 2 ТК РК — с запроса (объяснительная работника)
  { key: 'explanation', amount: 2, unit: 'work_days' },
  // ст. 65 п. 5 ТК РК — со дня издания (объявление взыскания под роспись)
  { key: 'disciplinary_announce', amount: 3, unit: 'work_days' },
  // п. 7 Правил № 353 — от подписания обеими сторонами (ЕСУТД: договор)
  { key: 'esutd_contract', amount: 5, unit: 'work_days' },
  // п. 8 Правил № 353 — от подписания допсоглашения (ЕСУТД: изменения)
  { key: 'esutd_amendment', amount: 15, unit: 'calendar_days' },
  // п. 12 Правил № 353 — от дня прекращения (ЕСУТД: прекращение)
  { key: 'esutd_termination', amount: 3, unit: 'work_days' },
  // разъяснения к ст. 98 КоАП РК — от внесения сведений (окно исправления без штрафа)
  { key: 'esutd_correction', amount: 30, unit: 'work_days' },
];

export const HR_DEADLINE_RULE_MAP: Record<string, HrDeadlineRule> = HR_DEADLINE_RULES.reduce(
  (acc, r) => ({ ...acc, [r.key]: r }),
  {} as Record<string, HrDeadlineRule>,
);

// ---------- ЕСУТД ----------

/** Слово — `hr.esutdKind.<вид>`, статья срока — `hr.esutd.article.<вид>` */
export const ESUTD_KINDS = [
  { value: 'contract', ruleKey: 'esutd_contract' },
  { value: 'amendment', ruleKey: 'esutd_amendment' },
  { value: 'termination', ruleKey: 'esutd_termination' },
] as const;
export type EsutdKind = (typeof ESUTD_KINDS)[number]['value'];

/** Состояние строки очереди; словом на экранах пока не показывается */
export const ESUTD_STATUSES = ['pending', 'submitted', 'failed', 'not_required'] as const;
export type EsutdStatus = (typeof ESUTD_STATUSES)[number];

/**
 * Перечень сведений Правил № 353 — КОДЫ полей снимка «Скопировать сведения».
 * Снимок ложится в БД доказательством содержания, поэтому в нём коды, а не слова:
 * подпись каждого поля даёт каталог (`hr.esutd.field.<код>`) в языке того, кто
 * смотрит. `terminationOnly` — поля, которые есть только у прекращения.
 */
export const ESUTD_PAYLOAD_FIELDS = [
  { code: 'kind', terminationOnly: false },
  { code: 'employer', terminationOnly: false },
  { code: 'employerBin', terminationOnly: false },
  { code: 'employeeName', terminationOnly: false },
  { code: 'employeeIin', terminationOnly: false },
  { code: 'contractNumber', terminationOnly: false },
  { code: 'contractDate', terminationOnly: false },
  { code: 'hiredAt', terminationOnly: false },
  { code: 'position', terminationOnly: false },
  { code: 'contractType', terminationOnly: false },
  { code: 'contractEndAt', terminationOnly: false },
  { code: 'firedAt', terminationOnly: true },
  { code: 'dismissalGround', terminationOnly: true },
] as const;
export type EsutdPayloadField = (typeof ESUTD_PAYLOAD_FIELDS)[number]['code'];

/**
 * Сдача ПРЕКРАЩЕНИЯ безоткатна (п. 13 Правил № 353), поэтому полнота этих
 * сведений проверяется ДО отметки: неполнота = недостоверность = штраф
 * (ст. 98 п. 1-1 КоАП РК).
 */
export const ESUTD_TERMINATION_REQUIRED_FIELDS: readonly EsutdPayloadField[] = [
  'employeeName',
  'employeeIin',
  'employerBin',
  'firedAt',
  'dismissalGround',
];

// ---------- Кампании ознакомления ----------

/** Полиморфный ключ кампании в движке подписи (sms-режим) */
export const DOC_CAMPAIGN_REF_TYPE = 'doc_campaign';

/** Слово — `hr.campaignMode.<режим>` */
export const CAMPAIGN_MODES = ['one_off', 'standing'] as const;
export type CampaignMode = (typeof CAMPAIGN_MODES)[number];

/**
 * Как фиксируется факт ознакомления. `click` законен по ст. 23 п. 2 пп. 6 ТК РК
 * («посредством электронной почты и иных ИКТ» — подпись для факта ознакомления
 * не требуется) и бесплатен; `sms` — усиленное доказательство для критичных ЛНА
 * (охрана труда, дисциплина): SMS стоит денег организации (~8–10 ₸ × адресат).
 * Слово — `hr.campaignFixMode.<режим>`.
 */
export const CAMPAIGN_FIX_MODES = ['click', 'sms'] as const;
export type CampaignFixMode = (typeof CAMPAIGN_FIX_MODES)[number];

/** Слово — `hr.campaignStatus.<статус>` */
export const CAMPAIGN_STATUSES = ['active', 'done', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * `sms_failed` — отдельный исход: недоставленная SMS не значит «не ознакомился».
 * Слово — `hr.campaignTargetStatus.<статус>` (заголовок ГРУППЫ адресатов: единственное
 * место, где статус показывается словом, — разбивка списка по исходам).
 */
export const CAMPAIGN_TARGET_STATUSES = ['pending', 'acknowledged', 'sms_failed'] as const;
export type CampaignTargetStatus = (typeof CAMPAIGN_TARGET_STATUSES)[number];

// ---------- Личный архив ----------

/** Слово — `hr.personalDocKind.<вид>` */
export const PERSONAL_DOC_KINDS = ['signed', 'acknowledged', 'delivered'] as const;
export type PersonalDocKind = (typeof PERSONAL_DOC_KINDS)[number];

/** Полиморфный ключ личной записи-архива в движке файлов */
export const PERSONAL_DOC_REF_TYPE = 'personal_doc';

// ---------- Вручение (гибрид и специальный режим) ----------

/** Слово — `hr.deliveryMode.<режим>` */
export const DOC_DELIVERY_MODES = ['electronic', 'paper', 'hybrid'] as const;
export type DocDeliveryMode = (typeof DOC_DELIVERY_MODES)[number];

/** Слово — `hr.deliveryMethod.<способ>` */
export const DOC_DELIVERY_METHODS = ['in_person', 'refusal_act', 'registered_mail'] as const;
export type DocDeliveryMethod = (typeof DOC_DELIVERY_METHODS)[number];

// ---------- Ссылки ----------

/** Карточка сотрудника (страница человека в организации) — одна точка правды адреса */
export function hrMemberHref(workspaceId: string, userId: string): string {
  return `/workspaces/${workspaceId}/members/${userId}`;
}

// ---------- Лимиты ----------

export const HR_LIMITS = {
  /** Массовое действие из ростера — за один прогон */
  batchMax: 500,
  /** Кампания ознакомления; исполнение пачками через core/jobs */
  campaignMaxTargets: 5000,
  /** Размер пачки материализации адресатов кампании */
  campaignChunkSize: 200,
  /** Страница списков (действия, кампании, личный архив) */
  pageSize: 50,
  /** Сколько строк отдаёт сводный экран «Кадровые сроки» на секцию */
  deadlinesPerSection: 50,
  /** За сколько дней предупреждать об окончании испытательного срока */
  probationWarnDays: 7,
  /** За сколько дней предупреждать об окончании срочного договора */
  contractWarnDays: 30,
  /** Поллинг экрана прогресса массовой операции */
  batchPollMs: 3000,
} as const;

/** Машиночитаемые коды ошибок КЭДО (в details.code общего конверта) */
export const HR_ERROR_CODES = {
  /** Календарь на этот год не засеян — считать срок нечем (недосчёт = штраф) */
  calendarHorizon: 'hr_calendar_horizon',
  /** У шаблона приказа нет опубликованного маршрута с нодой hr.apply */
  noApplyRoute: 'hr_no_apply_route',
  /** Действие уже применено/отменено — статус-гвард */
  actionNotActive: 'hr_action_not_active',
  /** По сотруднику уже идёт незакрытое действие того же вида (двойной клик, второй кадровик) */
  actionDuplicate: 'hr_action_duplicate',
  /** Отзыв по ст. 56 п. 4 — только своё заявление; приказ работодателя работник не отменяет */
  withdrawNotOwnApplication: 'hr_withdraw_not_own_application',
  /** ЕСУТД: сведения о прекращении неполны — сдача без отката (п. 13), валидация ДО */
  esutdIncomplete: 'hr_esutd_incomplete',
  /** ЕСУТД: прекращение уже сдано — правка только через госорган (п. 13) */
  esutdLocked: 'hr_esutd_locked',
  /** Подписанный кадровый документ не удаляется никогда */
  signedDocProtected: 'hr_signed_doc_protected',
} as const;
export type HrErrorCode = (typeof HR_ERROR_CODES)[keyof typeof HR_ERROR_CODES];
