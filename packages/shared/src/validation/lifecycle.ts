import { z } from 'zod';

// Вход команд Кабинета платформы движка жизненного цикла (core/lifecycle).

/** Окончательное удаление архивной организации (каскад реестра; «четыре глаза»). */
export const lifecycleWorkspacePurgeInputSchema = z.object({ workspaceId: z.string().uuid() }).strict();
export type LifecycleWorkspacePurgeInput = z.infer<typeof lifecycleWorkspacePurgeInputSchema>;
