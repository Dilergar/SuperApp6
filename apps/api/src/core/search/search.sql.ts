import { Prisma } from '@prisma/client';

/**
 * Ссылка проекции поиска на строку-источник в сыром SQL.
 *
 * `search_documents.source_id` — текст (источники разных видов, не все — uuid), а первичные
 * ключи сущностей — нативный `uuid`. Соединение `n."id"::text = sd."source_id"` приводит
 * КОЛОНКУ сущности — планировщик теряет её первичный ключ и идёт Seq Scan + Hash Join по всей
 * таблице сущностей на каждый поисковый запрос (все узлы Диска всех людей ради двадцати
 * попаданий). Приведение со стороны проекции возвращает Nested Loop по PK, а страж-регэксп
 * защищает от ошибки `22P02` на чужом виде источника, каким бы порядком планировщик ни
 * вычислял условия (docs/api_conventions.md «Идентификаторы (uuid)»).
 *
 * Использование: `JOIN "drive_nodes" n ON n."id" = ${searchSourceUuid('sd')}`.
 */
export function searchSourceUuid(alias: string): Prisma.Sql {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`searchSourceUuid: bad alias "${alias}"`);
  return Prisma.sql`(CASE WHEN ${Prisma.raw(`"${alias}"."source_id"`)} ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN ${Prisma.raw(`"${alias}"."source_id"`)}::uuid END)`;
}
