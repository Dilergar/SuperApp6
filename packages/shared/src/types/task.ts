// ============================================================
// TASKS — types
// ============================================================
// Role model (Bitrix24-style): Постановщик = creator (not a participant row);
// Исполнитель = executor (1); Соисполнитель = co_executor (N); Наблюдатель = observer (N).
// A GROUP task targets a Circle (Группа): one shared task/chat, its members become
// co_executors, and EACH participant carries their own status (drives "3 of 10" progress
// and per-person acceptance). Coins are display-only intent until the Store/wallet ships.

export type TaskStatus = 'todo' | 'in_progress' | 'on_review' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

/** Non-creator roles. Постановщик is Task.creatorId, not a TaskRole. */
export type TaskRole = 'executor' | 'co_executor' | 'observer';

/** Per-participant execution state. Acceptance is per-person. */
export type ParticipantStatus = 'pending' | 'submitted' | 'accepted' | 'returned';

/** "My" relationship to a task, used for UI affordances. */
export type ViewerTaskRole = 'creator' | TaskRole;

export interface TaskParticipant {
  id: string;
  userId: string;
  name: string;
  avatar: string | null;
  role: TaskRole;
  status: ParticipantStatus;
  submittedAt: string | null;
  acceptedAt: string | null;
  returnedAt: string | null;
  /** Per-person coin reward snapshot ("каждому по X"). Display-only for now. */
  rewardCoins: number;
  giftRewardId: string | null;
}

/** Aggregate acceptance progress (group tasks). */
export interface TaskProgress {
  accepted: number;
  total: number;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;

  /** «Входящие» (GTD): быстрая запись себе, ещё не разобрана (без срока/исполнителя). */
  inbox: boolean;

  // Time-manager
  dueDate: string | null;
  startDate: string | null;
  allDay: boolean;
  reminderAt: string | null;
  recurrenceRule: string | null;

  // Roles
  creatorId: string;
  creatorName: string;
  creatorAvatar: string | null;
  /** Single Исполнитель for an individual task; null for a group task. */
  executor: TaskParticipant | null;
  coExecutors: TaskParticipant[];
  observers: TaskParticipant[];

  // Group assignment (Группа)
  assignedCircleId: string | null;
  assignedCircleName: string | null;
  /** Set for group tasks: how many participants are accepted out of the total. */
  progress: TaskProgress | null;

  // Hierarchy
  parentId: string | null;
  subtasksCount: number;
  subtasksDoneCount: number;

  // Reward — display-only intent (no wallet yet). Per-person amount.
  coinReward: number;
  coinPenalty: number;
  giftRewardId: string | null;

  // Context
  workspaceId: string | null;
  calendarEventId: string | null;

  tags: string[];

  // Viewer-relative state (filled per request)
  myRole: ViewerTaskRole | null;
  myParticipantStatus: ParticipantStatus | null;

  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  priority?: TaskPriority;

  dueDate?: string;
  startDate?: string;
  allDay?: boolean;
  reminderAt?: string;
  /** RRULE-light, e.g. "FREQ=WEEKLY;INTERVAL=1". */
  recurrenceRule?: string;

  // Assignment is EITHER individual (executorId) OR group (assignedCircleId).
  // Omitting both makes it a self-task (creator becomes the executor, no acceptance step).
  executorId?: string;
  coExecutorIds?: string[];
  observerIds?: string[];
  assignedCircleId?: string;

  parentId?: string;

  /** Быстрая запись во «Входящие». Игнорируется, если задан срок/исполнитель/родитель. */
  inbox?: boolean;

  // Reward (per-person). Display-only for now.
  coinReward?: number;
  coinPenalty?: number;
  giftRewardId?: string;

  tags?: string[];
  workspaceId?: string;
  addToCalendar?: boolean;
  /** Вложения «с порога» — файлы, загруженные движком до создания задачи. */
  attachmentFileIds?: string[];
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  startDate?: string | null;
  allDay?: boolean;
  reminderAt?: string | null;
  recurrenceRule?: string | null;
  coinReward?: number;
  coinPenalty?: number;
  tags?: string[];
  /** Ручное «Разобрано» (false) для «Входящих»; уточнение срока/исполнителя снимает флаг само. */
  inbox?: boolean;
  // Role edits (creator only)
  executorId?: string | null;
  addCoExecutorIds?: string[];
  addObserverIds?: string[];
  removeParticipantUserIds?: string[];
}

// Task discussion now lives in the Messenger (a context chat attached to the task).
// See @superapp/shared messenger types (ChatMessage). TaskComment was removed in Phase 2.

/** Server-side smart lists for the task views. */
export type TaskSmartList =
  | 'inbox'
  | 'today'
  | 'upcoming'
  | 'overdue'
  | 'assigned_to_me'
  | 'created_by_me'
  | 'on_review';

export interface TaskFilter {
  status?: TaskStatus[];
  priority?: TaskPriority[];
  /** Filter by the viewer's role on the task. */
  role?: ViewerTaskRole;
  smartList?: TaskSmartList;
  workspaceId?: string | null;
  dueDateFrom?: string;
  dueDateTo?: string;
  tags?: string[];
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Счётчики смарт-листов для бейджей сайдбара и дашборда «Обзор».
 * assignedToMe/createdByMe — только ОТКРЫТЫЕ задачи (в отличие от одноимённых
 * списков, которые показывают и завершённые) — бейдж значит «требует внимания».
 */
export interface TaskStats {
  inbox: number;
  today: number;
  overdue: number;
  upcoming: number;
  assignedToMe: number;
  createdByMe: number;
  onReview: number;
}
