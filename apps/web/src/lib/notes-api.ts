import type {
  CreateNoteFolderInput,
  CreateNoteInput,
  CursorPage,
  NoteBoardDto,
  NoteBoardItemDto,
  NoteBoardPutInput,
  NoteDetailDto,
  NoteFolderDto,
  NoteListItemDto,
  NoteRelatedRefInput,
  NoteRelatedTargetType,
  NoteRevisionDto,
  NoteSaveResultDto,
  NoteShareDto,
  NoteShareInput,
  NoteSidebarDto,
  NoteSpaceRef,
  NoteTargetSearchItemDto,
  NoteWikilinkCandidateDto,
  NotesByTargetDto,
  UpdateNoteFolderInput,
  UpdateNoteInput,
} from '@superapp/shared';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from './api';

// ============================================================
// Клиент Заметок. Пространство адресуется необязательным `workspaceId`
// (организация); без него сервер берёт личные заметки зрителя — модель Диска.
// ============================================================

const scope = (ref: NoteSpaceRef): Record<string, string> => (ref.workspaceId ? { workspaceId: ref.workspaceId } : {});

/** Стабильный ключ пространства для кэшей: 'personal' | workspaceId */
export const noteScopeKey = (ref: NoteSpaceRef): string => ref.workspaceId ?? 'personal';

export async function fetchNotesSidebar(ref: NoteSpaceRef): Promise<NoteSidebarDto> {
  return apiGet<NoteSidebarDto>('/notes/sidebar', { params: scope(ref) });
}

export interface NotesListFilter {
  /** 'root' — без папки; undefined — все папки */
  folderId?: string | 'root';
  tag?: string;
  q?: string;
  pinned?: boolean;
  trashed?: boolean;
  shared?: boolean;
}

export async function fetchNotes(ref: NoteSpaceRef, filter: NotesListFilter, cursor?: string): Promise<CursorPage<NoteListItemDto>> {
  return apiGet<CursorPage<NoteListItemDto>>('/notes', {
    params: {
      ...scope(ref),
      ...(filter.folderId ? { folderId: filter.folderId } : {}),
      ...(filter.tag ? { tag: filter.tag } : {}),
      ...(filter.q ? { q: filter.q } : {}),
      ...(filter.pinned ? { pinned: true } : {}),
      ...(filter.trashed ? { trashed: true } : {}),
      ...(filter.shared ? { shared: true } : {}),
      ...(cursor ? { cursor } : {}),
    },
  });
}

export async function fetchNote(id: string): Promise<NoteDetailDto> {
  return apiGet<NoteDetailDto>(`/notes/${id}`);
}

export async function createNote(input: CreateNoteInput): Promise<NoteDetailDto> {
  return apiPost<NoteDetailDto>('/notes', input);
}

export async function updateNote(id: string, input: UpdateNoteInput): Promise<NoteSaveResultDto> {
  return apiPatch<NoteSaveResultDto>(`/notes/${id}`, input);
}

export async function trashNote(id: string): Promise<void> {
  await apiPost(`/notes/${id}/trash`, {});
}

export async function restoreNote(id: string): Promise<NoteDetailDto> {
  return apiPost<NoteDetailDto>(`/notes/${id}/restore`, {});
}

export async function purgeNote(id: string): Promise<void> {
  await apiDelete(`/notes/${id}`);
}

// ---- история версий

export async function fetchNoteRevisions(noteId: string): Promise<NoteRevisionDto[]> {
  return apiGet<NoteRevisionDto[]>(`/notes/${noteId}/revisions`);
}

export async function restoreNoteRevision(noteId: string, version: number): Promise<NoteSaveResultDto> {
  return apiPost<NoteSaveResultDto>(`/notes/${noteId}/revisions/${version}/restore`, {});
}

// ---- папки

export async function createNoteFolder(input: CreateNoteFolderInput): Promise<NoteFolderDto> {
  return apiPost<NoteFolderDto>('/notes/folders', input);
}

export async function updateNoteFolder(id: string, input: UpdateNoteFolderInput): Promise<NoteFolderDto> {
  return apiPatch<NoteFolderDto>(`/notes/folders/${id}`, input);
}

export async function trashNoteFolder(id: string): Promise<void> {
  await apiPost(`/notes/folders/${id}/trash`, {});
}

export async function restoreNoteFolder(id: string): Promise<void> {
  await apiPost(`/notes/folders/${id}/restore`, {});
}

// ---- доступ

export async function fetchNoteShares(noteId: string): Promise<NoteShareDto[]> {
  return apiGet<NoteShareDto[]>(`/notes/${noteId}/shares`);
}

export async function shareNote(noteId: string, input: NoteShareInput): Promise<NoteShareDto[]> {
  return apiPost<NoteShareDto[]>(`/notes/${noteId}/shares`, input);
}

export async function unshareNote(noteId: string, principalType: string, principalId: string): Promise<NoteShareDto[]> {
  return apiDelete<NoteShareDto[]>(`/notes/${noteId}/shares/${principalType}/${principalId}`);
}

export async function shareNoteWithMentioned(noteId: string): Promise<NoteShareDto[]> {
  return apiPost<NoteShareDto[]>(`/notes/${noteId}/shares/mentioned`, {});
}

export async function fetchFolderShares(folderId: string): Promise<NoteShareDto[]> {
  return apiGet<NoteShareDto[]>(`/notes/folders/${folderId}/shares`);
}

export async function shareFolder(folderId: string, input: NoteShareInput): Promise<NoteShareDto[]> {
  return apiPost<NoteShareDto[]>(`/notes/folders/${folderId}/shares`, input);
}

export async function unshareFolder(folderId: string, principalType: string, principalId: string): Promise<NoteShareDto[]> {
  return apiDelete<NoteShareDto[]>(`/notes/folders/${folderId}/shares/${principalType}/${principalId}`);
}

// ---- привязки

export async function addNoteRelated(noteId: string, ref: NoteRelatedRefInput): Promise<NoteDetailDto> {
  return apiPost<NoteDetailDto>(`/notes/${noteId}/related`, ref);
}

export async function removeNoteRelated(noteId: string, targetType: NoteRelatedTargetType, targetId: string): Promise<NoteDetailDto> {
  return apiDelete<NoteDetailDto>(`/notes/${noteId}/related/${targetType}/${targetId}`);
}

export async function searchNoteTargets(ref: NoteSpaceRef, type: NoteRelatedTargetType, q: string): Promise<NoteTargetSearchItemDto[]> {
  return apiGet<NoteTargetSearchItemDto[]>('/notes/targets/search', { params: { ...scope(ref), type, ...(q ? { q } : {}) } });
}

export async function fetchNotesByTarget(targetType: NoteRelatedTargetType, targetId: string): Promise<NotesByTargetDto> {
  return apiGet<NotesByTargetDto>(`/notes/by-target/${targetType}/${targetId}`);
}

export async function fetchWikilinkCandidates(ref: NoteSpaceRef, q: string, exclude?: string): Promise<NoteWikilinkCandidateDto[]> {
  return apiGet<NoteWikilinkCandidateDto[]>('/notes/wikilink-candidates', {
    params: { ...scope(ref), ...(q ? { q } : {}), ...(exclude ? { exclude } : {}) },
  });
}

// ---- доска стикеров

export async function fetchNotesBoard(ref: NoteSpaceRef, filter: NotesListFilter): Promise<NoteBoardDto> {
  return apiGet<NoteBoardDto>('/notes/board', {
    params: {
      ...scope(ref),
      ...(filter.folderId ? { folderId: filter.folderId } : {}),
      ...(filter.tag ? { tag: filter.tag } : {}),
      ...(filter.q ? { q: filter.q } : {}),
      ...(filter.pinned ? { pinned: true } : {}),
      ...(filter.shared ? { shared: true } : {}),
      ...(filter.trashed ? { trashed: true } : {}),
    },
  });
}

export async function putBoardItem(noteId: string, input: NoteBoardPutInput): Promise<NoteBoardItemDto> {
  return apiPut<NoteBoardItemDto>(`/notes/board/${noteId}`, input);
}

