export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  startDate: string | null;

  // Creator & Assignee
  creatorId: string;
  creatorName: string;
  assigneeId: string | null;
  assigneeName: string | null;

  // Hierarchy
  parentId: string | null;
  subtasksCount: number;
  subtasksDoneCount: number;

  // Gamification
  coinReward: number;
  coinPenalty: number; // штраф за просрочку

  // Context
  workspaceId: string | null; // null = personal
  calendarEventId: string | null;

  // Tags
  tags: string[];

  // Chat
  commentsCount: number;

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
  assigneeId?: string;
  parentId?: string;
  coinReward?: number;
  coinPenalty?: number;
  tags?: string[];
  workspaceId?: string;
  addToCalendar?: boolean;
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string;
  startDate?: string;
  assigneeId?: string;
  coinReward?: number;
  coinPenalty?: number;
  tags?: string[];
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskFilter {
  status?: TaskStatus[];
  priority?: TaskPriority[];
  assigneeId?: string;
  creatorId?: string;
  workspaceId?: string | null;
  dueDateFrom?: string;
  dueDateTo?: string;
  tags?: string[];
  search?: string;
}
