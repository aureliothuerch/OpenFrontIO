import { z } from "zod";

/**
 * Per-game mod switches, stored in `GameConfig.mod` (hooked into
 * GameConfigSchema in src/core/Schemas.ts). Unset fields fall back to
 * MOD_CONFIG. No defaults here: a snapshot restore parses the config and
 * must produce exactly what the live game had.
 *
 * Only imports zod: Schemas.ts imports this file, so anything more risks an
 * import cycle.
 */
export const ModGameConfigSchema = z.object({
  defcon: z
    .object({
      enabled: z.boolean().optional(),
      lockNukes: z.boolean().optional(),
    })
    .optional(),
});

export type ModGameConfig = z.infer<typeof ModGameConfigSchema>;
