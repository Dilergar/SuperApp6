// ============================================================
// Движок согласований (core/approvals, 14-й платформенный) — константы
// ============================================================
// «Задачник для решений»: заявка = ПРЕДМЕТ + прямой список шагов, каждый шаг
// собирает от людей одно из трёх подтверждений — согласование, подпись,
// ознакомление. Ветвлений, условий и циклов здесь НЕТ и не будет: это работа
// движка Процессов, и второй такой писать нельзя.
//
// Движок не знает своих потребителей: refType — свободная строка, резолвер
// регистрируется в ApprovalsRegistry (паттерн FilesRefRegistry/ShareLinksRegistry).
// Сегодня заявки заводят Документы, завтра — счета, АВР, решения в задачах.
//
// Для человека всё это называется «Ждут решения»: слово «Согласование» не про
// того, кому пришёл приказ на ОЗНАКОМЛЕНИЕ — он ничего не согласует.

import { APPROVAL_AUDIENCE_KINDS } from './audiences';

/**
 * Адрес карточки заявки — ОДНА точка правды.
 *
 * По нему ходят все уведомления движка (`actionUrl`), кнопка «Открыть целиком» в
 * стопке и строки «Моих заявок». Пока адрес собирался строкой в двух местах API,
 * он указывал на страницу, которой в вебе нет вовсе, и КАЖДОЕ уведомление о
 * согласовании вело в 404 — снаружи это выглядит как «приложение сломалось».
 *
 * РАБОЧАЯ заявка открывается ВНУТРИ своей организации, личная — по короткому
 * адресу. Доступ к заявке по-прежнему решает её предмет, и на права путь не
 * влияет никак — дело в каркасе: контекст «Личное / Организация» он выводит
 * РОВНО из адреса, поэтому по короткому пути человек, нажавший «Открыть целиком»
 * в организации, оказывался в «Личном» — с личным сайдбаром и заявлением
 * сотрудника рядом со своими задачами и финансами.
 */
export function approvalHref(requestId: string, workspaceId?: string | null): string {
  return workspaceId ? `/workspaces/${workspaceId}/approvals/${requestId}` : `/approvals/${requestId}`;
}

/**
 * Скоуп стопки «Ждут решения».
 *
 * `all` (по умолчанию) — СКВОЗНОЙ вид: всё, что ждёт человека, из всех его
 * организаций и личного. Так устроены верхние иконки топбара (галочка и
 * колокольчик): они висят над любой страницей и обязаны показывать всё, иначе
 * приказ на подпись «не существует», пока ты не переключишься в нужную компанию.
 *
 * `personal` — только личные заявки (без организации). Так считают витрины
 * ВНУТРИ контекста: на личной Главной у человека с пятью компаниями иначе
 * копится каша из чужих контекстов. Организация задаётся не этим полем, а
 * `workspaceId` — он и сильнее: заданы оба, побеждает организация.
 */
export const APPROVAL_INBOX_SCOPES = ['all', 'personal'] as const;
export type ApprovalInboxScope = (typeof APPROVAL_INBOX_SCOPES)[number];

/** Что именно требуется от человека на шаге */
export const APPROVAL_STEP_KINDS = ['approval', 'signature', 'acknowledgement'] as const;
export type ApprovalStepKind = (typeof APPROVAL_STEP_KINDS)[number];

/**
 * Подписи шагов. `action` — надпись на кнопке, `waiting` — как шаг выглядит в
 * стопке, `done` — как он выглядит в истории. Один источник на API и веб:
 * иначе кнопка «Подписать» и запись «Согласовал» разъедутся уже на второй неделе.
 */
export const APPROVAL_STEP_KIND_LABELS: Record<
  ApprovalStepKind,
  { action: string; waiting: string; done: string; icon: string }
> = {
  approval: { action: 'Согласовать', waiting: 'На согласовании', done: 'Согласовал', icon: 'checkCircle' },
  signature: { action: 'Подписать', waiting: 'На подписи', done: 'Подписал', icon: 'signature' },
  acknowledgement: { action: 'Ознакомлен', waiting: 'На ознакомлении', done: 'Ознакомился', icon: 'eye' },
};

/** Исход решения человека */
export const APPROVAL_DECISIONS = ['approved', 'rejected', 'returned'] as const;
export type ApprovalDecisionKind = (typeof APPROVAL_DECISIONS)[number];

/**
 * Какие исходы доступны на шаге данного вида.
 *
 * У ОЗНАКОМЛЕНИЯ исход один: «прочитал» — это факт, а не решение. Кнопки
 * «Отклонить» там быть не может: отказаться ознакомиться с приказом нельзя,
 * можно только не нажать (тогда шаг просто висит и эскалируется).
 */
export const APPROVAL_KIND_DECISIONS: Record<ApprovalStepKind, readonly ApprovalDecisionKind[]> = {
  approval: ['approved', 'rejected', 'returned'],
  signature: ['approved', 'rejected', 'returned'],
  acknowledgement: ['approved'],
};

/** Исходы, требующие объяснения: «нет» без причины делает маршрут бесполезным */
export const APPROVAL_DECISIONS_NEEDING_COMMENT: readonly ApprovalDecisionKind[] = ['rejected', 'returned'];

export const APPROVAL_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'returned', 'cancelled'] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

export const APPROVAL_REQUEST_STATUS_LABELS: Record<ApprovalRequestStatus, string> = {
  pending: 'Ждёт решения',
  approved: 'Согласовано',
  rejected: 'Отклонено',
  returned: 'На доработке',
  cancelled: 'Отменено',
};

export const APPROVAL_STEP_STATUSES = ['waiting', 'active', 'approved', 'rejected', 'returned', 'skipped'] as const;
export type ApprovalStepStatus = (typeof APPROVAL_STEP_STATUSES)[number];

/**
 * Кому адресован шаг — подмножество словаря core/audiences (`APPROVAL_AUDIENCE_KINDS`).
 *
 * `manager_of` / `branch_head_of` — ОТНОСИТЕЛЬНЫЕ адресаты оргструктуры: id — человек
 * или якорь (`$initiator` — автор заявки; сторону документа подставляет тот, кто её
 * знает, — нода маршрута). Разворачиваются В МОМЕНТ АКТИВАЦИИ шага в снимок, как и
 * отдел: «руководитель на момент активации» — согласуется с инвариантом снимка.
 * Вершина без руководителя → владелец организации (снимок не пуст, подпись в
 * assigneeLabel).
 *
 * `branch` добавлен вместе с КЭДО: рёбра `branch#member` давно проецируются в
 * движок прав, и ветка была мёртвой только из-за этой константы — «ознакомить
 * филиал с приказом» иначе невозможно.
 */
export const APPROVAL_ASSIGNEE_TYPES = APPROVAL_AUDIENCE_KINDS;
export type ApprovalAssigneeType = (typeof APPROVAL_ASSIGNEE_TYPES)[number];

/**
 * Сколько человек должно ответить, когда адресат — должность или отдел.
 *
 * `any` — «любой из» (первый ответивший закрывает шаг): так согласуют счета.
 * `all` — «каждый» (нужен ответ от всех): так ознакамливают отдел с приказом.
 *
 * У `all` состав фиксируется СНИМКОМ в момент активации шага. Иначе принятый
 * в середине согласования сотрудник молча добавлял бы себе обязанность, а
 * уволенный — навсегда подвешивал бы шаг, которого уже некому закрыть.
 */
export const APPROVAL_RULES = ['any', 'all'] as const;
export type ApprovalRule = (typeof APPROVAL_RULES)[number];

/**
 * Чем подтверждено решение. `internal` — нажатие кнопки в SuperApp6, юридической
 * силы ноль; `sms` и `ecp` ставит ТОЛЬКО core/sign изнутри транзакции
 * финализации акта подписи. От клиента это поле не принимается никогда.
 *
 * Названия не переименовываем под терминологию core/sign (`pep`/`ecp`): решения
 * уже записаны, а история решений неизменяема. Соответствие уровней —
 * `approvalSignatureKindOf` в constants/sign.
 */
export const APPROVAL_SIGNATURE_KINDS = ['internal', 'sms', 'ecp'] as const;
export type ApprovalSignatureKind = (typeof APPROVAL_SIGNATURE_KINDS)[number];

/**
 * Чего шаг ТРЕБУЕТ, чтобы закрыться. `internal` сюда не входит осознанно: «шагу
 * достаточно клика» выражается отсутствием требования (null), а не третьим
 * значением — иначе одно и то же говорилось бы двумя способами.
 */
export const APPROVAL_SIGNATURE_REQUIREMENTS = ['sms', 'ecp'] as const;
export type ApprovalSignatureRequirement = (typeof APPROVAL_SIGNATURE_REQUIREMENTS)[number];

export const APPROVAL_SIGNATURE_KIND_LABELS: Record<ApprovalSignatureKind, string> = {
  internal: 'Внутреннее утверждение в SuperApp6',
  sms: 'Подтверждено кодом из SMS',
  ecp: 'Электронная цифровая подпись',
};

export const APPROVAL_LIMITS = {
  /** Шагов в одной заявке. Длиннее — это уже процесс, ему место на канвасе */
  maxSteps: 20,
  /**
   * Адресатов в снимке шага `all`: ознакомить весь департамент реально, весь
   * завод — нет. Превышение — ЧЕСТНЫЙ ОТКАЗ с числом, а не молчаливая обрезка
   * (на компании в 600 человек 100 неознакомленных, о которых никто не узнает, —
   * хуже отказа). Массовые ознакомления — кампании КЭДО (потолок 5000, пачками).
   */
  maxSnapshotSize: 500,
  maxTitleLength: 200,
  maxCommentLength: 2000,
  /** Страница списков «мои заявки» и журнала решений */
  pageSize: 30,
  /**
   * Сколько элементов стопка берёт с ОДНОГО источника. Стопка — это «разгрести
   * сейчас», а не архив: длинный хвост живёт в разделе сервиса со своими фильтрами.
   */
  inboxPerSource: 50,
  /** Как часто веб перепрашивает счётчик бейджа (на видимой вкладке) */
  countPollMs: 60_000,
  /**
   * Потолок выборки «предметы, по которым человек решает» — она подставляется ОДНИМ
   * условием в чужой SQL (реестр документов). Молчаливой обрезки бояться нечего:
   * это дополнение к видимости, а не единственный её источник.
   */
  involvedRefsCap: 500,
  /**
   * За сколько до срока напомнить адресатам. Берётся МЕНЬШЕЕ из суток и половины
   * окна: у шага «решить за 4 часа» напоминание за сутки пришло бы раньше самой
   * заявки. Напоминание — не эскалация: оно приходит ДО срока и только адресатам,
   * автора беспокоить нечем, пока срок не вышел.
   */
  remindBeforeMs: 24 * 3_600_000,
  /**
   * Короче этого окна не напоминаем вовсе: между «напомнили» и «просрочено»
   * должен быть промежуток, за который реально успеть решить, иначе человек
   * получает два уведомления подряд об одном и том же.
   */
  remindMinWindowMs: 2 * 3_600_000,
} as const;

/**
 * Машиночитаемые коды ошибок (уходят в `details.code` общего конверта).
 * Клиент ветвится по ним, а не по русскому тексту.
 */
export const APPROVAL_ERROR_CODES = {
  /** Решение уже вынесено — кто-то успел раньше («любой из») либо двойной клик */
  alreadyDecided: 'approval_already_decided',
  /** Шаг не активен: заявку отменили или её уже закрыл предыдущий исход */
  stepNotActive: 'approval_step_not_active',
  /** Вы не адресат этого шага */
  notAssignee: 'approval_not_assignee',
  /** Такой исход недоступен на этом виде шага (отклонить ознакомление нельзя) */
  decisionNotAllowed: 'approval_decision_not_allowed',
  /** Отказ и возврат требуют комментария */
  commentRequired: 'approval_comment_required',
  /**
   * Шаг требует НАСТОЯЩЕЙ подписи (`requiredSignatureKind`), а не нажатия кнопки.
   * Публичный `decide` такой шаг не закрывает никогда — его закрывает движок
   * core/sign изнутри транзакции финализации акта. Клиент по этому коду уводит
   * человека на экран подписания.
   */
  needsSignature: 'approval_needs_signature',
  /**
   * Снимок адресатов больше потолка — честный отказ с числом, а не молчаливая
   * обрезка (`take` без ошибки). Массовые ознакомления — кампании КЭДО.
   */
  snapshotTooBig: 'approval_snapshot_too_big',
  /**
   * Адресат шага развернулся В НИКОГО (битый id, чужой справочник, пустой отдел).
   * Шаг, который молча активируется и никого не ждёт, висит вечно — честная
   * ошибка при активации лучше вечного зависания.
   */
  emptyAssignees: 'approval_empty_assignees',
} as const;

export type ApprovalErrorCode = (typeof APPROVAL_ERROR_CODES)[keyof typeof APPROVAL_ERROR_CODES];

/**
 * Как называется стопка для человека. Держим строкой здесь, а не в вёрстке: имя
 * появляется в бейдже топбара, на Главной, в Задачах и в Документах — четыре
 * места, которые обязаны совпадать.
 */
export const APPROVAL_INBOX_TITLE = 'Ждут решения';

/**
 * Ключи источников стопки. Сам реестр открыт (источник = свободная строка,
 * движок своих потребителей не знает), но ключи ЖИВЫХ источников перечислены
 * здесь ради иконок и порядка в интерфейсе.
 */
export const INBOX_SOURCE_KEYS = {
  /** Заявки этого движка */
  approval: 'approval',
  /** Свободные подписи core/sign (регистрируется в SignJobs) */
  sign: 'sign',
  /** Кампании ознакомления КЭДО (регистрируется в doc-campaigns) */
  hrCampaign: 'hr_campaign',
  /** ЗАДЕЛ: очереди задач отдела в Процессах — регистрируется, когда дойдут руки */
  processQueue: 'process_queue',
  /** ЗАДЕЛ: приёмка работы в Задачнике */
  taskReview: 'task_review',
} as const;
