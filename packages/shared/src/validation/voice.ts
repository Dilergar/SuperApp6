import { z } from 'zod';
import { VOICE_LANGUAGES, VOICE_RECORDING_SOURCES } from '../constants/voice';

// ============================================
// Voice Engine — Zod-схемы
// ============================================

const languageKeys = VOICE_LANGUAGES as unknown as [string, ...string[]];
const sourceKeys = VOICE_RECORDING_SOURCES as unknown as [string, ...string[]];

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Название обязательно')
  .max(255, 'Слишком длинное название')
  .refine((v) => !/[<>]/.test(v), 'Название содержит недопустимые символы');

/** POST /voice/transcripts — запросить расшифровку файла (идемпотентно по fileId) */
export const requestTranscriptSchema = z
  .object({
    fileId: z.string().uuid(),
    /** Влияет только на первый расчёт (или ре-запрос после error) — транскрипт кэшируется навсегда */
    language: z.enum(languageKeys).optional(),
    diarize: z.boolean().optional(),
  })
  .strict();

/** POST /recorder/recordings — создать запись Диктофона из готового файла */
export const createRecordingSchema = z
  .object({
    fileId: z.string().uuid(),
    title: titleSchema.optional(),
    source: z.enum(sourceKeys).optional(),
    language: z.enum(languageKeys).optional(),
  })
  .strict();

/** PATCH /recorder/recordings/:id */
export const renameRecordingSchema = z
  .object({
    title: titleSchema,
  })
  .strict();

/** POST /voice/stt — поля формы рядом с файлом */
export const voiceSyncSttSchema = z
  .object({
    language: z.enum(languageKeys).optional(),
  })
  .strict();

export type RequestTranscriptInput = z.infer<typeof requestTranscriptSchema>;
export type CreateRecordingInput = z.infer<typeof createRecordingSchema>;
export type RenameRecordingInput = z.infer<typeof renameRecordingSchema>;
export type VoiceSyncSttInput = z.infer<typeof voiceSyncSttSchema>;
