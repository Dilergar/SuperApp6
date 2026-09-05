// ============================================================
// Заметки — DTO провода (обе стороны: API объявляет Promise<Dto>, веб читает те же типы)
// ============================================================

import type { NOTE_LINK_KINDS, NOTE_PRINCIPAL_TYPES, NOTE_RELATED_TARGET_TYPES, NOTE_ROLES, NOTE_TARGET_TYPES } from '../constants/notes';
import type { FileOwnerType } from './file';
import type { NoteDoc } from '../notes/note-doc';

export type NoteRole = (typeof NOTE_ROLES)[number];
/** Что зритель может: 'owner' (хозяин пространства / админ организации) сильнее любой роли */
export type NoteAccess = NoteRole | 'owner';
export type NotePrincipalType = (typeof NOTE_PRINCIPAL_TYPES)[number];
export type NoteTargetType = (typeof NOTE_TARGET_TYPES)[number];
export type NoteRelatedTargetType = (typeof NOTE_RELATED_TARGET_TYPES)[number];
export type NoteLinkKind = (typeof NOTE_LINK_KINDS)[number];

/** Адресация пространства: без workspaceId — личные заметки зрителя */
export interface NoteSpaceRef {
  workspaceId?: string | null;
}

export interface NoteSpaceDto {
  id: string;
  ownerType: FileOwnerType;
  ownerId: string;
  /** «Мои заметки» / название организации */
  title: string;
  /** Что может ИМЕННО этот зритель в пространстве целиком */
  access: NoteAccess;
}

/** Человек в списках — рисуется PersonChip/PersonAvatar (правило платформы) */
export interface NoteUserLiteDto {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
}

export interface NoteFolderDto {
  id: string;
  parentId: string | null;
  name: string;
  color: string | null;
  depth: number;
  ancestorIds: string[];
  /** Заметок непосредственно в папке (без корзины) */
  notesCount: number;
  access: NoteAccess;
  createdById: string;
  updatedAt: string;
}

export interface NoteTagCountDto {
  name: string;
  count: number;
}

/** Левая панель одним запросом: дерево, чужие папки, теги, корзина */
export interface NoteSidebarDto {
  space: NoteSpaceDto;
  folders: NoteFolderDto[];
  /** Папки, к которым зрителю дали доступ в этом пространстве (не его собственные) */
  sharedFolders: NoteFolderDto[];
  /** Есть ли отдельные заметки, расшаренные зрителю (раздел «Поделились со мной») */
  sharedNotesCount: number;
  rootNotesCount: number;
  tags: NoteTagCountDto[];
  trashCount: number;
}

export interface NoteListItemDto {
  id: string;
  folderId: string | null;
  title: string;
  snippet: string;
  color: string | null;
  pinnedAt: string | null;
  tags: string[];
  access: NoteAccess;
  /** Заметкой поделились (есть хотя бы один грант) — значок в списке */
  shared: boolean;
  createdBy: NoteUserLiteDto;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface NoteRelatedDto {
  targetType: NoteRelatedTargetType;
  targetId: string;
  title: string;
  url: string | null;
}

export interface NoteBacklinkDto {
  noteId: string;
  title: string;
  folderId: string | null;
}

export interface NoteFolderCrumbDto {
  id: string;
  name: string;
}

export interface NoteDetailDto extends NoteListItemDto {
  spaceId: string;
  ownerType: FileOwnerType;
  ownerId: string;
  content: NoteDoc;
  contentMd: string;
  version: number;
  folderPath: NoteFolderCrumbDto[];
  related: NoteRelatedDto[];
  backlinks: NoteBacklinkDto[];
  /** Упомянутые, которые заметку не видят — подсказка «поделиться с упомянутыми» */
  mentionsWithoutAccess: NoteUserLiteDto[];
}

/** Ответ на сохранение — лёгкий, без документа (клиент уже держит его) */
export interface NoteSaveResultDto {
  id: string;
  version: number;
  title: string;
  snippet: string;
  tags: string[];
  updatedAt: string;
  mentionsWithoutAccess: NoteUserLiteDto[];
  /**
   * Пересчитывался ли доступ упомянутых в этом сохранении. При `false` набор
   * упоминаний не менялся (обычный набор текста) — клиент оставляет подсказку,
   * которая у него уже есть, вместо того чтобы гасить её пустым списком.
   */
  mentionsChecked: boolean;
}

/** Снимок содержимого в истории версий заметки */
export interface NoteRevisionDto {
  version: number;
  createdAt: string;
  author: NoteUserLiteDto;
  /** Это текущая версия заметки */
  current: boolean;
  /** Начало текста снимка — чтобы отличить версии на глаз */
  preview: string;
}

export interface NoteShareDto {
  principalType: NotePrincipalType;
  principalId: string;
  principalName: string;
  role: NoteRole;
  /** Где выдан грант: сама заметка/папка или предок */
  refType: 'note' | 'note_folder';
  refId: string;
  refName: string;
  inherited: boolean;
}

/** Стикер на доске: позиция per-user + сама заметка с документом */
export interface NoteStickyDto extends NoteListItemDto {
  content: NoteDoc;
  version: number;
  related: NoteRelatedDto[];
}

export interface NoteBoardItemDto {
  noteId: string;
  folderId: string | null;
  /**
   * Человек сам положил карточку сюда (есть сохранённая раскладка). Если false —
   * позиции нет, и клиент раскладывает карточку сеткой по ширине доски: сервер не
   * знает ни ширины панели, ни размера карточек.
   */
  placed: boolean;
  /** Пиксели холста доски от левого верхнего угла (холст растёт вниз за карточками) */
  x: number;
  y: number;
  /** Пиксели */
  w: number;
  h: number;
  z: number;
  collapsed: boolean;
  note: NoteStickyDto;
}

export interface NoteBoardDto {
  folderId: string | null;
  items: NoteBoardItemDto[];
}

export interface NoteTargetSearchItemDto {
  targetType: NoteRelatedTargetType;
  id: string;
  title: string;
  subtitle: string | null;
}

export interface NoteWikilinkCandidateDto {
  id: string;
  title: string;
  folderName: string | null;
}

/** Панель «Заметки» на карточке сущности */
export interface NotesByTargetDto {
  items: NoteListItemDto[];
  /** Зритель может создать/прикрепить заметку к этой сущности */
  canAttach: boolean;
}
