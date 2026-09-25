/**
 * The one mod config: every tunable of our features lives here, so balance
 * changes never touch upstream code. Times are integer ticks (1 tick = 100 ms).
 *
 * Per-game switches that may later become lobby settings are resolved on top
 * of these defaults (see ModGameConfig.ts and defcon/DefconSettings.ts).
 */

/** The levels DEFCON can step down to. */
export type DefconStepLevel = 4 | 3 | 2 | 1;

export interface DefconTuning {
  /** On/off switch for the whole DEFCON feature. */
  enabled: boolean;
  /** Lock nukes until `nukeUnlockLevel`. Off = DEFCON is display only. */
  lockNukes: boolean;
  /** Nukes can be launched from this level on. */
  nukeUnlockLevel: number;
  /** Escalation clock value that reaches each level (time alone = latest). */
  latestTicks: Record<DefconStepLevel, number>;
  /** Real time after peace time before each level can be reached at all. */
  earliestTicks: Record<DefconStepLevel, number>;
  /** At most one step per this many ticks. */
  minTicksBetweenSteps: number;
  /** A new conflict between two real players moves the clock forward. */
  newConflictBonusTicks: number;
  /** A pair only counts as a new conflict again after this long without attacks. */
  conflictQuietTicks: number;
  /** A real betrayal moves the clock forward. */
  betrayalBonusTicks: number;
  /** At most one counted betrayal per traitor within this window. */
  betrayalCooldownTicks: number;
  /** Weight of conflicts and betrayals between two nations (100 = 1.0). */
  nationVsNationPercent: number;
  /** Bonuses shrink by referencePlayers / max(referencePlayers, alive players). */
  referencePlayers: number;
  /** Games with a timer shorter than this get a proportionally shorter schedule. */
  timerReferenceMinutes: number;
  /** The schedule is never shortened below this percentage. */
  timerMinScalePercent: number;
  /** Client: banner and alarm only within this many ticks of a change. */
  announceWindowTicks: number;
  /** A full-state update is sent this often, besides every change. */
  heartbeatTicks: number;
}

export interface ModConfig {
  defcon: DefconTuning;
}

export const MOD_CONFIG: ModConfig = {
  defcon: {
    enabled: true,
    lockNukes: true,
    nukeUnlockLevel: 2,
    // 4:00 / 8:00 / 12:00 / 16:00 after peace time, by time alone.
    latestTicks: { 4: 2400, 3: 4800, 2: 7200, 1: 9600 },
    // 1:30 / 4:00 / 7:00 / 11:00 after peace time, however much fighting.
    earliestTicks: { 4: 900, 3: 2400, 2: 4200, 1: 6600 },
    minTicksBetweenSteps: 600,
    newConflictBonusTicks: 300,
    conflictQuietTicks: 3000,
    betrayalBonusTicks: 600,
    betrayalCooldownTicks: 1200,
    nationVsNationPercent: 100,
    referencePlayers: 8,
    timerReferenceMinutes: 20,
    timerMinScalePercent: 40,
    announceWindowTicks: 40,
    heartbeatTicks: 50,
  },
};
