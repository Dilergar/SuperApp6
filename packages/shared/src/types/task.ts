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
  commentsCount: number;

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

  // Reward (per-person). Display-only for now.
  coinReward?: number;
  coinPenalty?: number;
  giftRewardId?: string;

  tags?: string[];
  workspaceId?: string;
  addToCalendar?: boolean;
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
  // Role edits (creator only)
  executorId?: string | null;
  addCoExecutorIds?: string[];
  addObserverIds?: string[];
  removeParticipantUserIds?: string[];
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  /** The author's role on this task at render time, for chat UI badges. */
  authorRole: ViewerTaskRole | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** Server-side smart lists for the task inbox. */
export type TaskSmartList =
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
