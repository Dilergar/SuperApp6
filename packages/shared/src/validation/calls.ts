import { z } from 'zod';

// ============================================
// Calls Engine — Zod-схемы
// ============================================

/** POST /calls/token — вход в звонок сущности (доступ решает резолвер refType) */
export const callTokenSchema = z
  .object({
    refType: z.string().trim().min(1).max(40),
    refId: z.string().trim().min(1).max(64),
  })
  .strict();

/** POST /calls/rooms/:sessionId/kick — исключить участника (модератор) */
export const callKickSchema = z.object({ userId: z.string().uuid() }).strict();

/** POST /calls/rooms/:sessionId/mute — принудительный mute трека участника (модератор) */
export const callMuteSchema = z
  .object({
    userId: z.string().uuid(),
    trackSid: z.string().trim().min(1).max(64),
    muted: z.boolean(),
  })
  .strict();

export type CallKickInput = z.infer<typeof callKickSchema>;
export type CallMuteInput = z.infer<typeof callMuteSchema>;
