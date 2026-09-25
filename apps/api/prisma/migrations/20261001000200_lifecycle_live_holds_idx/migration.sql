-- core/lifecycle — ревью: живые заморозки отдельным частичным индексом.
--
-- «Строка не под заморозкой» (`holdFreeSql` / `deletableSql`) — коррелированный
-- `NOT EXISTS (SELECT 1 FROM lifecycle_holds h WHERE h.released_at IS NULL AND (…OR…))` на КАЖДУЮ
-- строку-кандидат пачки удаления, как только на платформе есть хоть одна живая заморозка. Ветки
-- OR (класс, хранитель с приведением к тексту) индексами не покрыты — подзапрос читал всю таблицу,
-- а она append-only: снятые заморозки остаются навсегда. N кандидатов × вся история заморозок на
-- пачку — таймауты раннера на годах эксплуатации. Живых заморозок единицы: частичный индекс
-- сводит подзапрос к ним. Он же — быстрый путь «ни одной живой заморозки» (InitPlan на оператор)
-- и проверки заморозок организации (`tenantHeld`).
SET lock_timeout = '3s';
SET statement_timeout = '120s';

CREATE INDEX IF NOT EXISTS "lifecycle_holds_live_idx" ON "lifecycle_holds" ("scope", "data_class") WHERE "released_at" IS NULL;
