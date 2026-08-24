// ============================================================
// КЭДО — кадровый электронный документооборот (modules/hr) — константы.
//
// Юридическая рамка ТК РК зашита СПРАВОЧНИКАМИ с явными единицами измерения:
// в одном сервисе соседствуют «15 календарных» (ст. 46) и «15 рабочих»
// (ст. 53 п. 2), и хранить единицу соглашением, а не полем — способ однажды
// недосчитать срок (недосчёт = штраф, ст. 98 КоАП РК).
// ============================================================

// ---------- Трудовая карточка (Employment) ----------

export const EMPLOYMENT_STATUSES = [
  { value: 'draft', label: 'Оформляется' },
  { value: 'active', label: 'Работает' },
  { value: 'terminated', label: 'Уволен' },
] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number]['value'];

export const CONTRACT_TYPES = [
  { value: 'indefinite', label: 'Бессрочный' },
  { value: 'fixed_term', label: 'На определённый срок' },
  { value: 'seasonal', label: 'Сезонная работа' },
  { value: 'task_based', label: 'На время выполнения работы' },
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number]['value'];

/**
 * Ст. 30 п. 1 пп. 2 ТК РК: не уведомили в последний рабочий день — срочный
 * договор продлевается на тот же срок; продление молчанием — МАКСИМУМ 2 раза,
 * дальше договор считается заключённым на неопределённый срок. Счётчик
 * `contractExtensionsCount` сверяется с этим потолком (плашка, не блок).
 */
export const CONTRACT_MAX_SILENT_EXTENSIONS = 2;

// ---------- Кадровые действия ----------

export const HR_ACTION_KINDS = [
  { value: 'hire', label: 'Приём на работу', icon: 'userPlus' },
  { value: 'transfer', label: 'Перевод', icon: 'swap' },
  { value: 'salary_change', label: 'Изменение оклада', icon: 'coins' },
  { value: 'leave', label: 'Отпуск', icon: 'sun' },
  { value: 'dismissal', label: 'Увольнение', icon: 'signOut' },
] as const;
export type HrActionKind = (typeof HR_ACTION_KINDS)[number]['value'];

export const HR_ACTION_KIND_LABELS = HR_ACTION_KINDS.reduce(
  (acc, k) => ({ ...acc, [k.value]: k.label }),
  {} as Record<HrActionKind, string>,
);

/**
 * `scheduled` — отдельный статус намеренно: документы подписаны, действие ждёт
 * даты вступления в силу. Без него списки не различают «на подписи у директора»
 * и «подписано, вступает в силу 1 сентября» — а это разные ответы на вопрос
 * «почему человек ещё не переведён».
 */
export const HR_ACTION_STATUSES = [
  { value: 'draft', label: 'Черновик' },
  { value: 'in_progress', label: 'На оформлении' },
  { value: 'scheduled', label: 'Вступает в силу' },
  { value: 'applied', label: 'Применено' },
  { value: 'cancelled', label: 'Отменено' },
  { value: 'failed', label: 'Не применено' },
] as const;
export type HrActionStatus = (typeof HR_ACTION_STATUSES)[number]['value'];

export const HR_ACTION_STATUS_LABELS = HR_ACTION_STATUSES.reduce(
  (acc, s) => ({ ...acc, [s.value]: s.label }),
  {} as Record<HrActionStatus, string>,
);

/** Та же сущность, два входа: заявление работника и решение работодателя */
export const HR_ACTION_SOURCES = ['employee', 'employer'] as const;
export type HrActionSource = (typeof HR_ACTION_SOURCES)[number];

// ---------- Основания прекращения (справочник статей ТК РК) ----------

export const DISMISSAL_GROUNDS = [
  { value: 'st50', label: 'Соглашение сторон (ст. 50 ТК РК)', employerInitiative: false },
  { value: 'st51', label: 'Истечение срока договора (ст. 51 ТК РК)', employerInitiative: false },
  { value: 'st52_p1_1', label: 'Ликвидация работодателя (пп. 1) п. 1 ст. 52 ТК РК)', employerInitiative: true },
  { value: 'st52_p1_2', label: 'Сокращение численности или штата (пп. 2) п. 1 ст. 52 ТК РК)', employerInitiative: true },
  { value: 'st52_p1_3', label: 'Снижение объёма производства (пп. 3) п. 1 ст. 52 ТК РК)', employerInitiative: true },
  { value: 'st52_p1_18', label: 'Нарушение обязанностей руководителем/заместителем с материальным ущербом (пп. 18) п. 1 ст. 52 ТК РК)', employerInitiative: true },
  { value: 'st52_p1_20', label: 'Неявка более двух месяцев подряд из-за временной нетрудоспособности (пп. 20) п. 1 ст. 52 ТК РК)', employerInitiative: true },
  { value: 'st52_p1_23', label: 'Досрочное прекращение полномочий руководителя исполнительного органа (пп. 23) п. 1 ст. 52 ТК РК)', employerInitiative: true },
  { value: 'st52_p1_1_1', label: 'Основание п. 1-1 ст. 52 ТК РК (руководители квазигосударственного сектора)', employerInitiative: true },
  { value: 'st52_other', label: 'Иное основание ст. 52 ТК РК (инициатива работодателя)', employerInitiative: true },
  { value: 'st56', label: 'Инициатива работника (ст. 56 ТК РК)', employerInitiative: false },
  { value: 'st58', label: 'Отказ работника от продолжения работы (ст. 58 ТК РК)', employerInitiative: false },
  { value: 'other', label: 'Иное основание ТК РК', employerInitiative: false },
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
 */
export const ST54_BAN_EXCEPTION_GROUNDS: readonly string[] = [
  'st52_p1_1',
  'st52_p1_18',
  'st52_p1_20',
  'st52_p1_23',
  'st52_p1_1_1',
];
export const ST54_BAN_EXCEPTIONS_NOTE =
  'Исключения ст. 54 — пп. 1), 18), 20), 23) п. 1 ст. 52 и п. 1-1 — выбираются основанием из списка. Для оснований вне справочника («иное») отметьте исключение вручную.';

// ---------- Юридические сроки (калькулятор) ----------

/** Единица срока: рабочие дни считаются по производственному календарю РК */
export type HrDeadlineUnit = 'work_days' | 'calendar_days' | 'months';

export interface HrDeadlineRule {
  key: string;
  label: string;
  article: string;
  amount: number;
  unit: HrDeadlineUnit;
  /** От какого события считается срок */
  anchor: string;
}

/**
 * Таблица норм, которые система обязана знать. Единица — ПОЛЕМ, не соглашением.
 * Проверено по официальным текстам (adilet.zan.kz); нормы «ответ работника
 * 5 рабочих дней» НЕ СУЩЕСТВУЕТ (п. 3 ст. 46 даёт лишь право отказаться) —
 * блокирующих таймеров на ней не строим.
 */
export const HR_DEADLINE_RULES: readonly HrDeadlineRule[] = [
  { key: 'resignation_notice', label: 'Уведомление об увольнении по собственному желанию', article: 'ст. 56 п. 1 ТК РК', amount: 1, unit: 'months', anchor: 'от подачи заявления' },
  { key: 'liquidation_notice', label: 'Уведомление при ликвидации / сокращении', article: 'ст. 53 п. 1 ТК РК', amount: 1, unit: 'months', anchor: 'до даты прекращения' },
  { key: 'production_cut_notice', label: 'Уведомление при снижении объёма производства', article: 'ст. 53 п. 2 ТК РК', amount: 15, unit: 'work_days', anchor: 'до даты прекращения' },
  { key: 'termination_act_delivery', label: 'Вручение акта о прекращении', article: 'ст. 61 п. 3 ТК РК', amount: 3, unit: 'work_days', anchor: 'со дня издания' },
  { key: 'final_settlement', label: 'Окончательный расчёт', article: 'ст. 113 п. 4 ТК РК', amount: 3, unit: 'work_days', anchor: 'со дня прекращения' },
  { key: 'work_activity_doc', label: 'Документ о трудовой деятельности', article: 'ст. 62 п. 1 ТК РК', amount: 0, unit: 'work_days', anchor: 'в день прекращения' },
  { key: 'certificate_on_request', label: 'Справка по требованию работника', article: 'ст. 62 п. 2 ТК РК', amount: 5, unit: 'work_days', anchor: 'с обращения' },
  { key: 'conditions_change_notice', label: 'Уведомление об изменении условий труда (только письменно: бумага или ЭД с ЭЦП — ред. 08.06.2026)', article: 'ст. 46 п. 2 ТК РК', amount: 15, unit: 'calendar_days', anchor: 'до изменения' },
  { key: 'vacation_pay', label: 'Оплата отпуска', article: 'ст. 92 п. 4 ТК РК', amount: 3, unit: 'work_days', anchor: 'до начала отпуска' },
  { key: 'explanation', label: 'Объяснительная работника', article: 'ст. 65 п. 2 ТК РК', amount: 2, unit: 'work_days', anchor: 'с запроса' },
  { key: 'disciplinary_announce', label: 'Объявление взыскания под роспись', article: 'ст. 65 п. 5 ТК РК', amount: 3, unit: 'work_days', anchor: 'со дня издания' },
  { key: 'esutd_contract', label: 'ЕСУТД: заключение договора', article: 'п. 7 Правил № 353', amount: 5, unit: 'work_days', anchor: 'от подписания обеими сторонами' },
  { key: 'esutd_amendment', label: 'ЕСУТД: изменения договора', article: 'п. 8 Правил № 353', amount: 15, unit: 'calendar_days', anchor: 'от подписания допсоглашения' },
  { key: 'esutd_termination', label: 'ЕСУТД: прекращение договора', article: 'п. 12 Правил № 353', amount: 3, unit: 'work_days', anchor: 'от дня прекращения' },
  { key: 'esutd_correction', label: 'ЕСУТД: исправление ошибки без штрафа', article: 'разъяснения к ст. 98 КоАП РК', amount: 30, unit: 'work_days', anchor: 'от внесения сведений' },
];

export const HR_DEADLINE_RULE_MAP: Record<string, HrDeadlineRule> = HR_DEADLINE_RULES.reduce(
  (acc, r) => ({ ...acc, [r.key]: r }),
  {} as Record<string, HrDeadlineRule>,
);

// ---------- ЕСУТД ----------

export const ESUTD_KINDS = [
  { value: 'contract', label: 'Заключение договора', ruleKey: 'esutd_contract' },
  { value: 'amendment', label: 'Изменение договора', ruleKey: 'esutd_amendment' },
  { value: 'termination', label: 'Прекращение договора', ruleKey: 'esutd_termination' },
] as const;
export type EsutdKind = (typeof ESUTD_KINDS)[number]['value'];

export const ESUTD_STATUSES = [
  { value: 'pending', label: 'Не сдано' },
  { value: 'submitted', label: 'Сдано' },
  { value: 'failed', label: 'Ошибка' },
  { value: 'not_required', label: 'Не требуется' },
] as const;
export type EsutdStatus = (typeof ESUTD_STATUSES)[number]['value'];

/**
 * Штрафы ст. 98 п. 1-1 КоАП РК (закон № 257-VIII, с 12.03.2026) — первое/повторное,
 * МРП 2026 = 4 325 ₸. Наказуемы не только опоздание, но неполнота и недостоверность.
 */
export const ESUTD_FINES_NOTE =
  'Штраф за несдачу/недостоверность (ст. 98 п. 1-1 КоАП): должностные лица 30/60 МРП, малый бизнес 60/80, средний 80/100, крупный 150/200 МРП';

/** После сдачи ПРЕКРАЩЕНИЯ самостоятельная правка невозможна (п. 13 Правил № 353) */
export const ESUTD_TERMINATION_LOCK_NOTE =
  'После отправки прекращения в ЕСУТД исправление — только через госорган по труду по обращению (п. 13 Правил № 353). Проверьте сведения до отправки.';

// ---------- Кампании ознакомления ----------

/** Полиморфный ключ кампании в движке подписи (sms-режим) */
export const DOC_CAMPAIGN_REF_TYPE = 'doc_campaign';

export const CAMPAIGN_MODES = [
  { value: 'one_off', label: 'Разовая' },
  { value: 'standing', label: 'Постоянное правило' },
] as const;
export type CampaignMode = (typeof CAMPAIGN_MODES)[number]['value'];

/**
 * Как фиксируется факт ознакомления. `click` законен по ст. 23 п. 2 пп. 6 ТК РК
 * («посредством электронной почты и иных ИКТ» — подпись для факта ознакомления
 * не требуется) и бесплатен; `sms` — усиленное доказательство для критичных ЛНА
 * (охрана труда, дисциплина): SMS стоит денег организации (~8–10 ₸ × адресат).
 */
export const CAMPAIGN_FIX_MODES = [
  { value: 'click', label: 'Отметка в системе (клик)' },
  { value: 'sms', label: 'Код из SMS (усиленное доказательство)' },
] as const;
export type CampaignFixMode = (typeof CAMPAIGN_FIX_MODES)[number]['value'];

export const CAMPAIGN_STATUSES = [
  { value: 'active', label: 'Идёт' },
  { value: 'done', label: 'Завершена' },
  { value: 'cancelled', label: 'Отменена' },
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]['value'];

/** `sms_failed` — отдельный исход: недоставленная SMS не значит «не ознакомился» */
export const CAMPAIGN_TARGET_STATUSES = [
  { value: 'pending', label: 'Не ознакомился' },
  { value: 'acknowledged', label: 'Ознакомился' },
  { value: 'sms_failed', label: 'SMS не доставлена' },
] as const;
export type CampaignTargetStatus = (typeof CAMPAIGN_TARGET_STATUSES)[number]['value'];

// ---------- Личный архив ----------

export const PERSONAL_DOC_KINDS = [
  { value: 'signed', label: 'Подписан мной' },
  { value: 'acknowledged', label: 'Ознакомлен' },
  { value: 'delivered', label: 'Вручён' },
] as const;
export type PersonalDocKind = (typeof PERSONAL_DOC_KINDS)[number]['value'];

/** Полиморфный ключ личной записи-архива в движке файлов */
export const PERSONAL_DOC_REF_TYPE = 'personal_doc';

// ---------- Вручение (гибрид и специальный режим) ----------

export const DOC_DELIVERY_MODES = [
  { value: 'electronic', label: 'Электронно' },
  { value: 'paper', label: 'На бумаге' },
  { value: 'hybrid', label: 'Электронно и на бумаге' },
] as const;
export type DocDeliveryMode = (typeof DOC_DELIVERY_MODES)[number]['value'];

export const DOC_DELIVERY_METHODS = [
  { value: 'in_person', label: 'Лично под роспись' },
  { value: 'refusal_act', label: 'Отказ — составлен акт' },
  { value: 'registered_mail', label: 'Заказное письмо с уведомлением' },
] as const;
export type DocDeliveryMethod = (typeof DOC_DELIVERY_METHODS)[number]['value'];

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
