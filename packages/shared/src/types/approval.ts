// ============================================
// core/approvals — типы DTO
// ============================================
// Здесь только конверт ДВИЖКА. Предмет заявки (документ, счёт, задача) описывает
// потребитель у себя: движок по определению не знает своих потребителей, и его
// паспорт не должен наполняться чужими анкетами по мере роста списка сервисов.

import type {
  ApprovalAssigneeType,
  ApprovalDecisionKind,
  ApprovalRequestStatus,
  ApprovalRule,
  ApprovalSignatureKind,
  ApprovalSignatureRequirement,
  ApprovalStepKind,
  ApprovalStepStatus,
} from '../constants/approvals';

/** Человек в решениях — только карточкой (Принцип 2), поэтому лайт-профиль */
export interface ApprovalActorLite {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
}

/** Одно решение одного человека. Неизменяемо: это запись в истории, а не состояние. */
export interface ApprovalDecisionDto {
  id: string;
  userId: string;
  decision: ApprovalDecisionKind;
  comment: string | null;
  decidedAt: string;
  /** Чем подтверждено. `internal` — нажатие в SuperApp6, не юридическая подпись */
  signatureKind: ApprovalSignatureKind;
  /**
   * Отпечаток той версии предмета, которую человек видел, когда решал. Без него
   * подпись ничего не значит: файл могли переписать после решения.
   */
  subjectSha256: string | null;
  /**
   * Акт электронной подписи (core/sign), которым закрыто решение. Есть только у
   * `signatureKind` `sms`/`ecp`: у нажатия кнопки акта нет и быть не может.
   * По нему карточка ведёт на доказательства — протокол и страницу проверки.
   */
  signActId: string | null;
}

export interface ApprovalStepDto {
  id: string;
  /**
   * Порядок. Шаги с ОДИНАКОВЫМ order идут одновременно, следующая группа
   * активируется после закрытия предыдущей — так «по очереди» и «все сразу»
   * выражаются одним полем, без отдельного режима у заявки.
   */
  order: number;
  kind: ApprovalStepKind;
  title: string;
  status: ApprovalStepStatus;
  assigneeType: ApprovalAssigneeType;
  assigneeId: string;
  /** Название должности/отдела для показа; у адресата-человека null (рисуем карточкой) */
  assigneeLabel: string | null;
  rule: ApprovalRule;
  /** Кого ждём поимённо (снимок на момент активации); пусто, пока шаг не активен */
  awaitingUserIds: string[];
  decisions: ApprovalDecisionDto[];
  dueAt: string | null;
  /** Просрочен прямо сейчас — считает сервер, чтобы часы клиента не решали */
  overdue: boolean;
  decidedAt: string | null;
  /**
   * Чем шаг закрывается: null — обычным кликом, `sms`/`ecp` — только настоящей
   * подписью через core/sign. Веб по этому полю уводит на экран подписания
   * вместо кнопок «Согласовать/Отклонить».
   */
  requiredSignatureKind: ApprovalSignatureRequirement | null;
}

/** Заявка целиком: предмет + маршрут + история решений */
export interface ApprovalRequestDto {
  id: string;
  refType: string;
  refId: string;
  /** Снимок названия предмета на момент создания — переживает удаление объекта */
  refTitle: string;
  refIcon: string | null;
  /** Актуальные название и ссылка от резолвера потребителя; null — предмет исчез */
  ref: { title: string; icon: string | null; href: string | null } | null;
  status: ApprovalRequestStatus;
  workspaceId: string | null;
  createdById: string;
  createdAt: string;
  finishedAt: string | null;
  steps: ApprovalStepDto[];
  /** Участники маршрута для PersonChip: id → лайт-профиль */
  actors: Record<string, ApprovalActorLite>;
  /** Что этот зритель может сделать прямо сейчас (сервер уже проверил права) */
  myStepId: string | null;
  myDecisions: ApprovalDecisionKind[];
  canCancel: boolean;
}

/**
 * Элемент стопки «Ждут решения» — ОБЩАЯ форма для всех источников.
 *
 * Модалка рисует элемент, ничего не зная про источник: сегодня это заявки
 * согласования, завтра очереди отделов Процессов и приёмка задач встанут рядом
 * одной регистрацией в InboxSourceRegistry, и вёрстку менять не придётся.
 */
export interface InboxItemDto {
  /** Ключ источника (`approval`, позже `process_queue`, `task_review`) */
  sourceKey: string;
  /** Идентификатор внутри источника — сам источник знает, что с ним делать */
  id: string;
  title: string;
  subtitle: string | null;
  icon: string | null;
  /** Куда ведёт «Открыть целиком» */
  href: string | null;
  /** Кнопки решения. Пусто — источник умеет только показать и увести по href */
  actions: InboxActionDto[];
  /** Кто просит (для PersonChip); null — просит система */
  requestedById: string | null;
  createdAt: string;
  dueAt: string | null;
  overdue: boolean;
  /**
   * Что именно требуется: согласовать, ПОДПИСАТЬ или ознакомиться. Стопка обязана
   * их различать: «подписать приказ» и «согласовать счёт» — разные действия с
   * разными последствиями, а до появления подписи модалка рисовала их одинаково.
   * Источник вправе не заполнять поле (у очереди задач вида шага нет).
   */
  stepKind?: ApprovalStepKind;
  /**
   * Чем шаг закрывается. `null`/отсутствует — обычным кликом; `sms`/`ecp` — только
   * настоящей подписью через core/sign, и кнопки решения в стопке не показываются:
   * подпись собирается на своём экране, а не одним нажатием в списке.
   */
  signRequirement?: ApprovalSignatureKind | null;
}

/**
 * Скоуп, с которым спрашивают источник стопки.
 *
 * Разрешение — в одном месте (`ApprovalsService.scopeWhere`): организация сильнее
 * «только личное», а пустой объект означает СКВОЗНОЙ вид. Форма объекта, а не
 * голый `workspaceId?`, нужна именно ради третьего состояния: «личное» и «всё»
 * одинаково приходят без организации, и различить их строкой невозможно.
 */
export interface InboxScope {
  workspaceId?: string;
  /** Только заявки без организации. Игнорируется, если задан workspaceId */
  personalOnly?: boolean;
}

export interface InboxActionDto {
  key: string;
  label: string;
  /** Опасное действие рисуется красным; комментарий у него обязателен */
  tone: 'primary' | 'default' | 'danger';
  commentRequired: boolean;
}

export interface InboxPageDto {
  items: InboxItemDto[];
  actors: Record<string, ApprovalActorLite>;
  /** Счётчики по источникам — подписи вкладок стопки */
  counts: Record<string, number>;
  total: number;
}

/** Лёгкий ответ для бейджа: одно число, никаких списков */
export interface InboxCountDto {
  total: number;
  counts: Record<string, number>;
}

/** Строка списка «мои заявки»: где сейчас то, что я отправил */
export interface ApprovalMineDto {
  id: string;
  refType: string;
  refTitle: string;
  refIcon: string | null;
  href: string | null;
  status: ApprovalRequestStatus;
  /** Подпись текущего этапа: «Шаг 2 из 3 · На подписи» */
  stageLabel: string;
  /** Кого ждём сейчас — карточками */
  awaitingUserIds: string[];
  createdAt: string;
  finishedAt: string | null;
  dueAt: string | null;
  overdue: boolean;
}

export interface ApprovalMinePage {
  items: ApprovalMineDto[];
  actors: Record<string, ApprovalActorLite>;
  nextCursor: string | null;
}
