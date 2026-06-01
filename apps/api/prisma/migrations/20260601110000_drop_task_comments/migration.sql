-- Phase 2: TaskComment is replaced by a messenger contextual chat attached to the task.
-- task_comments held only test data; drop the table (FKs to tasks/users drop with it).
DROP TABLE IF EXISTS "task_comments";
