import type { Prisma } from '@prisma/client';
import type { NoteAccess, NoteListItemDto, NoteUserLiteDto } from '@superapp/shared';

/** Колонки заметки для списков (без документа и проекций — они тяжёлые) */
export const NOTE_LIST_SELECT = {
  id: true,
  spaceId: true,
  folderId: true,
  folderPath: true,
  title: true,
  plainText: true,
  color: true,
  pinnedAt: true,
  tags: true,
  version: true,
  createdById: true,
  updatedById: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.NoteSelect;

export type NoteListRow = Prisma.NoteGetPayload<{ select: typeof NOTE_LIST_SELECT }>;

export const USER_LITE_SELECT = { id: true, firstName: true, lastName: true, avatar: true } as const;
export type UserLiteRow = Prisma.UserGetPayload<{ select: typeof USER_LITE_SELECT }>;

export function userLite(u: UserLiteRow | null | undefined, fallbackId: string): NoteUserLiteDto {
  return u
    ? { id: u.id, firstName: u.firstName, lastName: u.lastName, avatar: u.avatar }
    : { id: fallbackId, firstName: 'Пользователь', lastName: null, avatar: null };
}

export function noteListItem(
  row: NoteListRow,
  access: NoteAccess,
  shared: boolean,
  author: UserLiteRow | null | undefined,
  snippet: string,
): NoteListItemDto {
  return {
    id: row.id,
    folderId: row.folderId,
    title: row.title,
    snippet,
    color: row.color,
    pinnedAt: row.pinnedAt ? row.pinnedAt.toISOString() : null,
    tags: row.tags,
    access,
    shared,
    createdBy: userLite(author, row.createdById),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

/** Адрес заметки: несёт организацию (правило веба «адрес обязан нести организацию») */
export function noteUrl(space: { ownerType: string; ownerId: string }, noteId: string): string {
  return space.ownerType === 'workspace' ? `/workspaces/${space.ownerId}/notes/${noteId}` : `/notes/${noteId}`;
}
