import { z } from 'zod';
import { DRIVE_LIMITS, DRIVE_ROLES, DRIVE_SORTS, DRIVE_SORT_DIRS } from '../constants/drive';
import { queryBoolean } from './query';

// ============================================
// OmniDrive — Zod-схемы
// ============================================

/**
 * Имя узла. Запрещены угловые скобки (правило платформы против XSS), разделители пути
 * и управляющие символы: имя едет в Content-Disposition при скачивании и в BaseFileName
 * редактора документов, а «.» и «..» — классическая попытка выйти из папки.
 *
 * Управляющие символы проверяются кодом, а не регуляркой: диапазон в литерале пришлось
 * бы писать escape-последовательностями, и один неверный символ молча превратил бы
 * проверку в пропускающую.
 */
const FORBIDDEN_NAME_CHARS = /[<>/\\]/;
const hasControlChar = (s: string): boolean => [...s].some((c) => (c.codePointAt(0) ?? 32) < 32);

const nodeName = z
  .string()
  .trim()
  .min(1, 'Название обязательно')
  .max(DRIVE_LIMITS.maxNameLength)
  .refine((s) => !FORBIDDEN_NAME_CHARS.test(s) && !hasControlChar(s), 'Недопустимые символы в названии')
  .refine((s) => s !== '.' && s !== '..', 'Недопустимое название');

const nodeId = z.string().uuid();
const spaceRef = {
  /** Явное пространство; без него — личный диск зрителя (создаётся лениво) */
  spaceId: z.string().uuid().optional(),
  /** Диск организации: пространство находится/создаётся по её id */
  workspaceId: z.string().uuid().optional(),
};
const oneSpace = (v: { spaceId?: string; workspaceId?: string }) => !(v.spaceId && v.workspaceId);
const oneSpaceMsg = { message: 'Укажите либо spaceId, либо workspaceId' };

/** Пакетная операция: список узлов с потолком — иначе одним запросом можно уронить инстанс */
const nodeIds = z.array(nodeId).min(1, 'Не выбрано ни одного объекта').max(DRIVE_LIMITS.maxBulkIds);

export const driveOverviewQuerySchema = z.object(spaceRef).strict().refine(oneSpace, oneSpaceMsg);

/** GET /drive/nodes — листинг папки (keyset) */
export const driveListQuerySchema = z
  .object({
    ...spaceRef,
    /** Отсутствует — корень пространства */
    parentId: nodeId.optional(),
    sort: z.enum(DRIVE_SORTS).default('name'),
    dir: z.enum(DRIVE_SORT_DIRS).default('asc'),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(DRIVE_LIMITS.maxPageSize).optional(),
    /** Только папки — для окна «куда переместить» */
    foldersOnly: queryBoolean.optional(),
  })
  .strict()
  .refine(oneSpace, oneSpaceMsg);

/**
 * GET /drive/guest/nodes — листинг для ГОСТЯ по ссылке наружу (core/share-links).
 * Пространства здесь нет намеренно: у гостя нет диска, скоуп задаёт сама ссылка,
 * а `parentId` проверяется на принадлежность её поддереву.
 */
export const driveGuestListSchema = z
  .object({
    /** Отсутствует — корень ссылки */
    parentId: nodeId.optional(),
    sort: z.enum(DRIVE_SORTS).default('name'),
    dir: z.enum(DRIVE_SORT_DIRS).default('asc'),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(DRIVE_LIMITS.maxPageSize).optional(),
  })
  .strict();

/**
 * GET /drive/guest/download-zip — «Скачать всё» с гостевой страницы.
 * `nodeId` необязателен: без него архивируется корень ссылки, с ним — её подпапка
 * (и она обязана лежать в поддереве, это проверяет контроллер).
 */
export const driveGuestZipSchema = z
  .object({
    nodeId: nodeId.optional(),
    /**
     * Пропуск гостя. ЕДИНСТВЕННОЕ место, где он приходит не заголовком: скачивание —
     * это навигация браузера, а своих заголовков у неё нет. Размен небольшой: пропуск
     * живёт час, привязан к одной ссылке и по правам слабее самого адреса `/s/<токен>`.
     */
    session: z.string().min(1).max(512),
  })
  .strict();

/** POST /drive/folders */
export const driveFolderCreateSchema = z
  .object({ ...spaceRef, parentId: nodeId.optional(), name: nodeName })
  .strict()
  .refine(oneSpace, oneSpaceMsg);

/**
 * POST /drive/nodes — положить на Диск УЖЕ загруженный движком файл.
 * Байты Диск не принимает: загрузка идёт обычным путём core/files (init → байты →
 * complete), а сюда приезжает готовый fileId. Так один файл может лежать и в чате,
 * и на Диске, оставаясь одним FileObject.
 */
export const driveNodeCreateSchema = z
  .object({
    ...spaceRef,
    parentId: nodeId.optional(),
    fileId: z.string().uuid(),
    /** По умолчанию — имя файла */
    name: nodeName.optional(),
  })
  .strict()
  .refine(oneSpace, oneSpaceMsg);

/** PATCH /drive/nodes/:id — переименование */
export const driveNodeUpdateSchema = z.object({ name: nodeName }).strict();

/** POST /drive/nodes/move — в пределах ОДНОГО пространства */
export const driveMoveSchema = z.object({ ids: nodeIds, parentId: nodeId.optional() }).strict();

/**
 * POST /drive/nodes/copy — копия, в том числе в другое пространство.
 * Между пространствами это ВСЕГДА копия: у движка файлов нет смены владельца, а квота
 * считается владельцу. Оригинал остаётся на месте — решение продукта.
 */
export const driveCopySchema = z
  .object({ ids: nodeIds, parentId: nodeId.optional(), ...spaceRef })
  .strict()
  .refine(oneSpace, oneSpaceMsg);

export const driveIdsSchema = z.object({ ids: nodeIds }).strict();

export const driveTrashQuerySchema = z
  .object({
    ...spaceRef,
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(DRIVE_LIMITS.maxPageSize).optional(),
  })
  .strict()
  .refine(oneSpace, oneSpaceMsg);

/** POST /drive/nodes/:id/shares */
export const driveShareSchema = z
  .object({
    principalType: z.enum(['user', 'circle', 'workspace', 'department', 'position', 'branch']),
    principalId: z.string().min(1).max(64),
    role: z.enum(DRIVE_ROLES),
  })
  .strict();

/** GET /drive/photos/buckets */
export const drivePhotoBucketsQuerySchema = z.object(spaceRef).strict().refine(oneSpace, oneSpaceMsg);

/** GET /drive/photos */
export const drivePhotoQuerySchema = z
  .object({
    ...spaceRef,
    /** `YYYY-MM`; без него лента идёт с самых свежих */
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Ожидается месяц в формате ГГГГ-ММ')
      .optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(DRIVE_LIMITS.photoPageSize).optional(),
  })
  .strict()
  .refine(oneSpace, oneSpaceMsg);

export type DriveOverviewQuery = z.infer<typeof driveOverviewQuerySchema>;
export type DriveListQuery = z.infer<typeof driveListQuerySchema>;
export type DriveGuestListQuery = z.infer<typeof driveGuestListSchema>;
export type DriveGuestZipQuery = z.infer<typeof driveGuestZipSchema>;
export type DriveFolderCreateInput = z.infer<typeof driveFolderCreateSchema>;
export type DriveNodeCreateInput = z.infer<typeof driveNodeCreateSchema>;
export type DriveNodeUpdateInput = z.infer<typeof driveNodeUpdateSchema>;
export type DriveMoveInput = z.infer<typeof driveMoveSchema>;
export type DriveCopyInput = z.infer<typeof driveCopySchema>;
export type DriveIdsInput = z.infer<typeof driveIdsSchema>;
export type DriveTrashQuery = z.infer<typeof driveTrashQuerySchema>;
export type DriveShareInput = z.infer<typeof driveShareSchema>;
export type DrivePhotoQuery = z.infer<typeof drivePhotoQuerySchema>;
