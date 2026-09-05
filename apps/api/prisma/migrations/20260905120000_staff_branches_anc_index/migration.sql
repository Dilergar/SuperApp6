-- Возврат GIN по staff_branches.ancestor_ids.
--
-- Индекс создавался руками в миграции объектов, а в schema.prisma жил только
-- комментарием — поэтому следующая `prisma migrate dev` (миграция Заметок) сочла его
-- дрейфом и вписала DROP INDEX. На нём держатся права объектов через предков
-- (`ancestor_ids && granted`) и обход поддерева; теперь он объявлен в схеме (@@index).
CREATE INDEX IF NOT EXISTS "staff_branches_ancestor_ids_gin" ON "staff_branches" USING GIN ("ancestor_ids" array_ops);
