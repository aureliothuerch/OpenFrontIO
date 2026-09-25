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

/**
 * Merges a host's `mod` patch into the stored block, field by field (MOD hook
 * in src/server/ConfigPatch.ts). An undefined field keeps the stored value,
 * so switching one mod setting never clears another one, e.g. DEFCON's
 * lockNukes when the host toggles DEFCON on or off.
 */
export function mergeModGameConfig(
  current: ModGameConfig | undefined,
  patch: ModGameConfig,
): ModGameConfig {
  const merged: Record<string, Record<string, unknown>> = { ...current };
  for (const [feature, block] of Object.entries(patch)) {
    if (block === undefined) continue;
    const kept = { ...merged[feature] };
    for (const [field, value] of Object.entries(block)) {
      if (value !== undefined) kept[field] = value;
    }
    merged[feature] = kept;
  }
  return merged as ModGameConfig;
}

/**
 * The MOD hook in applyGameConfigPatch (src/server/ConfigPatch.ts): merges
 * the patch's `mod` block into the stored config. Leaves the config alone
 * (no `mod: undefined` key) when the patch has no `mod` block.
 */
export function applyModConfigPatch(
  target: { mod?: ModGameConfig },
  patch: { mod?: ModGameConfig },
): void {
  if (patch.mod === undefined) return;
  target.mod = mergeModGameConfig(target.mod, patch.mod);
}
