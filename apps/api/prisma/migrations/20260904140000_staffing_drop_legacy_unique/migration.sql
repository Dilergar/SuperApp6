-- Старый уникум «человек × должность × объект» остался под ОБРЕЗАННЫМ именем
-- (Postgres режет идентификаторы до 63 символов), и предыдущая миграция его не
-- сняла. Без этого повторное назначение после закрытия падало P2002 — ровно тот
-- сценарий, ради которого назначения датировали.
DROP INDEX IF EXISTS "staff_assignments_workspace_id_user_id_position_id_branch_i_key";
DROP INDEX IF EXISTS "staff_assignments_workspace_id_user_id_position_id_branch_id_key";
