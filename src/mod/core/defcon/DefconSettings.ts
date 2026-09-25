import type { Config } from "../../../core/configuration/Config";
import { DefconTuning, MOD_CONFIG } from "../ModConfig";
import { scaleForTimer } from "./DefconRules";

/**
 * The DEFCON tuning for one game: MOD_CONFIG, with the per-game switches from
 * `GameConfig.mod.defcon` on top, scaled for the time the game's timer leaves
 * after peace time. A pure function of the game config, so a restored game
 * (and the client) derive exactly the same values.
 */
export function defconSettings(config: Config): DefconTuning {
  const gameConfig = config.gameConfig();
  const override = gameConfig.mod?.defcon;
  const base = MOD_CONFIG.defcon;
  return scaleForTimer(
    {
      ...base,
      enabled: override?.enabled ?? base.enabled,
      lockNukes: override?.lockNukes ?? base.lockNukes,
    },
    gameConfig.maxTimerValue,
    config.spawnImmunityDuration(),
  );
}
