-- core/notifications: два недостающих индекса на строке ленты.
--
-- 1) `event_id` — колонка внешнего ключа БЕЗ своего индекса. PostgreSQL проверяет
--    ссылки при КАЖДОМ удалении родителя, а ретеншн событий (`pruneEvents`) вдобавок
--    спрашивает «есть ли у события строки» анти-джойном: и то и другое шло по всей
--    таблице уведомлений.
-- 2) `workspace_id` — архив строк организации целиком (исключение сотрудника,
--    удаление организации по ретеншну архива). Составной (user_id, workspace_id)
--    для запроса без user_id не годится: организация не префикс ключа.
CREATE INDEX IF NOT EXISTS "notifications_event_id_idx" ON "notifications"("event_id");
CREATE INDEX IF NOT EXISTS "notifications_workspace_id_idx" ON "notifications"("workspace_id");
