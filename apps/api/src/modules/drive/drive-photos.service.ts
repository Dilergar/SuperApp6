import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DRIVE_LIMITS,
  type DrivePhotoBucketDto,
  type DrivePhotoPageDto,
  type DrivePhotoQuery,
} from '@superapp/shared';
import { FilesService } from '../../core/files/files.service';
import { DatabaseService } from '../../shared/database/database.service';
import { DriveAccessService } from './drive-access.service';
import { DriveService } from './drive.service';

interface PhotoRow {
  id: string;
  fileId: string;
  name: string;
  takenAtLocal: Date;
  width: number | null;
  height: number | null;
  thumbhash: string | null;
}

/**
 * Лента «Фото» — настоящая лента по датам, а не папка с картинками.
 *
 * Два решения делают её быстрой:
 *  • счётчики по месяцам лежат отдельной таблицей (скрубберу нужен весь год сразу, а
 *    COUNT с группировкой по 20 000 снимков — полное сканирование на каждое открытие);
 *  • страница отдаётся КОЛОНКАМИ и уже с подписанными ссылками на миниатюры: без
 *    соотношений сторон раскладку не посчитать до загрузки картинок, а тысяча плиток
 *    по отдельному запросу за ссылкой — тысяча запросов.
 */
@Injectable()
export class DrivePhotosService {
  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly acl: DriveAccessService,
    private readonly drive: DriveService,
  ) {}

  /**
   * Счётчики по месяцам — весь ответ единицы килобайт.
   *
   * Готовая таблица бакетов считает ВСЁ пространство, поэтому она годится только
   * владельцу. Гостю с грантом на одну папку она обещала бы месяцы и числа, которых он
   * в ленте не увидит (страница-то режется по правам), — ему счётчики считаются тем же
   * предикатом видимости, что и сама лента.
   */
  async buckets(userId: string, ref: { spaceId?: string; workspaceId?: string }): Promise<DrivePhotoBucketDto[]> {
    const { space, access, grants } = await this.drive.resolveSpace(userId, ref);

    if (access === 'owner') {
      const rows = await this.db.drivePhotoBucket.findMany({
        where: { spaceId: space.id, count: { gt: 0 } },
        orderBy: { month: 'desc' },
        select: { month: true, count: true },
      });
      return rows.map((r) => ({ month: r.month, count: r.count }));
    }

    const visible = this.acl.visibilitySql('n', access, grants.viewer);
    const rows = await this.db.$queryRaw<Array<{ month: string; count: bigint }>>(Prisma.sql`
      SELECT to_char(n."taken_at_local", 'YYYY-MM') AS "month", COUNT(*) AS "count"
        FROM "drive_nodes" n
       WHERE n."space_id" = ${space.id}
         AND n."kind" = 'file'
         AND n."taken_at_local" IS NOT NULL
         AND n."trashed_at" IS NULL
         AND ${visible}
       GROUP BY 1
       ORDER BY 1 DESC
    `);
    return rows.map((r) => ({ month: r.month, count: Number(r.count) }));
  }

  async page(userId: string, q: DrivePhotoQuery): Promise<DrivePhotoPageDto> {
    const { space, access, grants } = await this.drive.resolveSpace(userId, q);
    const limit = q.limit ?? DRIVE_LIMITS.photoPageSize;

    const visible = this.acl.visibilitySql('n', access, grants.viewer);
    // Месяц — ПОЛУИНТЕРВАЛОМ по самой колонке, а не `to_char(...) = 'ГГГГ-ММ'`:
    // функция от колонки не даёт взять индекс, и прыжок скруббера в старый месяц
    // прочитывал бы всё, что новее, — то есть тем дороже, чем старее месяц, ровно
    // против смысла скруббера.
    const range = q.month ? monthRange(q.month) : null;
    const monthFilter = range
      ? Prisma.sql`AND n."taken_at_local" >= ${range.from}::timestamp AND n."taken_at_local" < ${range.to}::timestamp`
      : Prisma.empty;
    const cursor = decodeCursor(q.cursor);
    const keyset = cursor
      ? Prisma.sql`AND (n."taken_at_local" < ${cursor.t}::timestamp
                    OR (n."taken_at_local" = ${cursor.t}::timestamp AND n."id" < ${cursor.i}))`
      : Prisma.empty;

    const rows = await this.db.$queryRaw<PhotoRow[]>(Prisma.sql`
      SELECT n."id" AS "id", n."file_id" AS "fileId", n."name" AS "name",
             n."taken_at_local" AS "takenAtLocal",
             (f."meta" ->> 'width')::int  AS "width",
             (f."meta" ->> 'height')::int AS "height",
             (f."meta" ->> 'thumbhash')   AS "thumbhash"
        FROM "drive_nodes" n
        JOIN "file_objects" f ON f."id" = n."file_id"
       WHERE n."space_id" = ${space.id}
         AND n."kind" = 'file'
         AND n."taken_at_local" IS NOT NULL
         AND n."trashed_at" IS NULL
         AND f."status" = 'ready'
         AND ${visible}
         ${monthFilter}
         ${keyset}
       ORDER BY n."taken_at_local" DESC, n."id" DESC
       LIMIT ${limit + 1}
    `);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    // Ссылки подписываются ОДНИМ батчем (приём buildAttachmentViews мессенджера).
    const views = await this.files.buildAttachmentViews(page.map((r) => r.fileId));

    let urlExpiresAt: string | null = null;
    const url: (string | null)[] = [];
    for (const r of page) {
      const v = views.get(r.fileId);
      url.push(v?.thumbUrl ?? v?.posterUrl ?? null);
      // Самый ранний срок жизни подписи на странице: до него клиент обязан
      // перезапросить страницу, иначе картинки начнут отваливаться по одной.
      if (v?.urlExpiresAt && (!urlExpiresAt || v.urlExpiresAt < urlExpiresAt)) urlExpiresAt = v.urlExpiresAt;
    }

    const last = page[page.length - 1];
    return {
      id: page.map((r) => r.id),
      fileId: page.map((r) => r.fileId),
      name: page.map((r) => r.name),
      // Соотношение сторон считаем НА СЕРВЕРЕ: клиенту нечего делить, а «квадрат по
      // умолчанию» ломал бы раскладку до загрузки каждой картинки.
      ratio: page.map((r) => (r.width && r.height ? Number((r.width / r.height).toFixed(4)) : 1)),
      thumbhash: page.map((r) => r.thumbhash),
      url,
      takenAtLocal: page.map((r) => r.takenAtLocal.toISOString()),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
      urlExpiresAt,
    };
  }
}

/**
 * Границы месяца `ГГГГ-ММ` строкой, а не датой: колонка `taken_at_local` хранит СТЕННОЕ
 * время без пояса, и любой Date по пути неминуемо подмешал бы пояс сервера — снимок
 * первого числа уехал бы в соседний месяц.
 */
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { from: `${y}-${pad(m)}-01 00:00:00`, to: `${nextY}-${pad(nextM)}-01 00:00:00` };
}

function encodeCursor(row: PhotoRow): string {
  return Buffer.from(JSON.stringify({ t: row.takenAtLocal.toISOString(), i: row.id })).toString('base64url');
}

function decodeCursor(raw?: string): { t: string; i: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { t: string; i: string };
    return typeof parsed?.t === 'string' && typeof parsed?.i === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
