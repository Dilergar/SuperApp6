import { z } from 'zod';

// Test-only top-up of the platform currency (real payment rails come later).
export const topUpSkinWalletSchema = z
  .object({ amount: z.number().int().positive().max(10_000_000) })
  .strict();

// Equip a skin instance as the default (everywhere), or null to unequip.
export const equipDefaultSkinSchema = z
  .object({ instanceId: z.string().uuid().nullable() })
  .strict();

// Equip a skin instance for one group (premium), or null to clear it.
export const equipGroupSkinSchema = z
  .object({
    circleId: z.string().uuid(),
    instanceId: z.string().uuid().nullable(),
  })
  .strict();

export type TopUpSkinWalletInput = z.infer<typeof topUpSkinWalletSchema>;
export type EquipDefaultSkinInput = z.infer<typeof equipDefaultSkinSchema>;
export type EquipGroupSkinInput = z.infer<typeof equipGroupSkinSchema>;
