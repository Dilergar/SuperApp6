import { z } from 'zod';
import {
  NOTE_COLOR_VALUES,
  NOTE_LIMITS,
  NOTE_PRINCIPAL_TYPES,
  NOTE_RELATED_TARGET_TYPES,
  NOTE_ROLES,
} from '../constants/notes';
import { validateNoteDoc, type NoteDoc } from '../notes/note-doc';
import { queryBoolean } from './query';

// ============================================
// Заметки — Zod-схемы (тип входа = z.infer рядом со схемой)
// ============================================

const uuid = z.string().uuid();

/**
 * Документ на входе ручки. Разбор идёт через `validateNoteDoc`, а не напрямую через
 * рекурсивную `noteDocSchema`: та проверяет структуру ДО лимитов, и документ с
 * бездонной вложенностью ронял разбор по стеку (500 вместо 400). Внутри — сначала
 * дешёвый обход стеком, потом уже Zod.
 */
const noteDocInput = z.custom<NoteDoc>().superRefine((value, ctx) => {
  const result = validateNoteDoc(value);
  if (!result.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
});

/** Пространство: без workspaceId — личные заметки зрителя */
const spaceRef = {
  workspaceId: uuid.optional(),
};

const color = z
  .string()
  .refine((v) => (NOTE_COLOR_VALUES as readonly string[]).includes(v), 'Цвет вне палитры')
  .nullable();

const hasControlChar = (s: string): boolean => [...s].some((c) => (c.codePointAt(0) ?? 32) < 32);
const folderName = z
  .string()
  .trim()
  .min(1, 'Название обязательно')
  .max(NOTE_LIMITS.maxFolderNameLength)
  .refine((s) => !/[<>]/.test(s) && !hasControlChar(s), 'Недопустимые символы в названии');

/** `folderId=root` — корень пространства (без папки); отсутствует — все папки */
const folderFilter = z.union([uuid, z.literal('root')]).optional();

/** Номер версии из пути (`/notes/:id/revisions/:version`) */
export const noteVersionParam = z.coerce.number().int().min(1);

export const noteSidebarQuerySchema = z.object(spaceRef).strict();
export type NoteSidebarQuery = z.infer<typeof noteSidebarQuerySchema>;

export const noteListQuerySchema = z
  .object({
    ...spaceRef,
    folderId: folderFilter,
    tag: z.string().trim().min(1).max(NOTE_LIMITS.maxTagLength).optional(),
    q: z.string().trim().max(100).optional(),
    pinned: queryBoolean.optional(),
    /** Корзина */
    trashed: queryBoolean.optional(),
    /** Только то, чем поделились со мной (не мои собственные) */
    shared: queryBoolean.optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type NoteListQuery = z.infer<typeof noteListQuerySchema>;

export const createNoteFolderSchema = z
  .object({
    ...spaceRef,
    parentId: uuid.nullable().optional(),
    name: folderName,
    color: color.optional(),
  })
  .strict();
export type CreateNoteFolderInput = z.infer<typeof createNoteFolderSchema>;

export const updateNoteFolderSchema = z
  .object({
    name: folderName.optional(),
    color: color.optional(),
    /** null — вынести в корень */
    parentId: uuid.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять');
export type UpdateNoteFolderInput = z.infer<typeof updateNoteFolderSchema>;

export const noteRelatedRefSchema = z
  .object({
    targetType: z.enum(NOTE_RELATED_TARGET_TYPES),
    targetId: uuid,
  })
  .strict();
export type NoteRelatedRefInput = z.infer<typeof noteRelatedRefSchema>;

export const createNoteSchema = z
  .object({
    ...spaceRef,
    folderId: uuid.nullable().optional(),
    /** Документ ИЛИ Markdown (вход ИИ-инструментов / вставка текста) — не оба */
    content: noteDocInput.optional(),
    markdown: z.string().max(NOTE_LIMITS.maxMarkdownLength).optional(),
    color: color.optional(),
    related: z.array(noteRelatedRefSchema).max(NOTE_LIMITS.maxRelated).optional(),
  })
  .strict()
  .refine((v) => !(v.content && v.markdown !== undefined), { message: 'Укажите либо content, либо markdown' });
export type CreateNoteInput = z.infer<typeof createNoteSchema>;

export const updateNoteSchema = z
  .object({
    /** Оптимистическая блокировка: версия, от которой правил клиент */
    baseVersion: z.number().int().min(1),
    content: noteDocInput.optional(),
    markdown: z.string().max(NOTE_LIMITS.maxMarkdownLength).optional(),
    color: color.optional(),
    pinned: z.boolean().optional(),
    /** null — вынести из папки в корень */
    folderId: uuid.nullable().optional(),
  })
  .strict()
  .refine((v) => !(v.content && v.markdown !== undefined), { message: 'Укажите либо content, либо markdown' });
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;

export const noteShareSchema = z
  .object({
    principalType: z.enum(NOTE_PRINCIPAL_TYPES),
    principalId: uuid,
    role: z.enum(NOTE_ROLES),
  })
  .strict();
export type NoteShareInput = z.infer<typeof noteShareSchema>;

export const noteTargetSearchQuerySchema = z
  .object({
    ...spaceRef,
    type: z.enum(NOTE_RELATED_TARGET_TYPES),
    q: z.string().trim().max(100).optional(),
  })
  .strict();
export type NoteTargetSearchQuery = z.infer<typeof noteTargetSearchQuerySchema>;

/**
 * Доска = ВИД на выбранный раздел (папка, все, тег, закреплённые, «поделились», корзина),
 * а не отдельный набор: те же фильтры, что у списка. Раскладка (позиция, размер, слой)
 * хранится на человека и подхватывается к тем заметкам, которые он двигал.
 */
export const noteBoardQuerySchema = z
  .object({
    ...spaceRef,
    folderId: folderFilter,
    tag: z.string().trim().min(1).max(NOTE_LIMITS.maxTagLength).optional(),
    pinned: queryBoolean.optional(),
    shared: queryBoolean.optional(),
    trashed: queryBoolean.optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();
export type NoteBoardQuery = z.infer<typeof noteBoardQuerySchema>;

export const noteBoardPutSchema = z
  .object({
    ...spaceRef,
    x: z.number().min(0).max(NOTE_LIMITS.boardMaxCoord).optional(),
    y: z.number().min(0).max(NOTE_LIMITS.boardMaxCoord).optional(),
    w: z.number().int().min(NOTE_LIMITS.stickyMinW).max(NOTE_LIMITS.stickyMaxW).optional(),
    h: z.number().int().min(NOTE_LIMITS.stickyMinH).max(NOTE_LIMITS.stickyMaxH).optional(),
    z: z.number().int().min(0).max(100_000).optional(),
    collapsed: z.boolean().optional(),
  })
  .strict();
export type NoteBoardPutInput = z.infer<typeof noteBoardPutSchema>;

export const noteWikilinkCandidatesQuerySchema = z
  .object({
    ...spaceRef,
    q: z.string().trim().max(100).optional(),
    /** Исключить саму заметку из кандидатов */
    exclude: uuid.optional(),
  })
  .strict();
export type NoteWikilinkCandidatesQuery = z.infer<typeof noteWikilinkCandidatesQuerySchema>;

