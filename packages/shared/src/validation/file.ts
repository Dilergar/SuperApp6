import { z } from 'zod';
import { FILE_LIMITS, FILE_PROFILES } from '../constants/files';

// ============================================
// Files Engine — Zod-схемы
// ============================================

const profileKeys = Object.keys(FILE_PROFILES) as [string, ...string[]];

/** POST /files — намерение загрузки (контракт Slack v2: init → байты → complete) */
export const initFileSchema = z.object({
  profile: z.enum(profileKeys).default('generic'),
  name: z
    .string()
    .trim()
    .min(1, 'validation.file.nameRequired')
    .max(FILE_LIMITS.maxNameLength, 'validation.file.nameTooLong')
    .refine((v) => !/[<>]/.test(v), 'validation.file.badCharacters'),
  size: z
    .number()
    .int()
    .positive('validation.file.sizePositive')
    .max(FILE_LIMITS.hardMaxSize, 'validation.file.tooBig'),
  mime: z.string().trim().min(3).max(150),
  /** Владелец-организация (B2B); по умолчанию владелец — сам пользователь */
  ownerWorkspaceId: z.string().uuid().optional(),
});

/** POST /files/:id/parts — presigned-ссылки на части multipart */
export const createPartsSchema = z.object({
  partNumbers: z
    .array(z.number().int().min(1).max(10000))
    .min(1)
    .max(FILE_LIMITS.maxPartsPerRequest),
});

/** POST /files/:id/complete */
export const completeFileSchema = z.object({
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, 'validation.file.sha256')
    .optional(),
  /** multipart: подтверждения частей от хранилища */
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10000),
        etag: z.string().min(1).max(200),
      }),
    )
    .min(1)
    .max(10000)
    .optional(),
});

/** GET /files/:id/download?variant= */
export const downloadQuerySchema = z.object({
  variant: z.enum(['thumb', 'medium', 'poster', 'waveform', 'text', 'pdf']).optional(),
});

export type InitFileInput = z.infer<typeof initFileSchema>;
export type CreatePartsInput = z.infer<typeof createPartsSchema>;
export type CompleteFileInput = z.infer<typeof completeFileSchema>;
