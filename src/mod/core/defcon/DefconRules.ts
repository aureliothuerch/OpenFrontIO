import { Nukes, UnitType } from "../../../core/game/Game";
import type { DefconStepLevel, DefconTuning } from "../ModConfig";

/**
 * Pure DEFCON rules, shared by the simulation (DefconExecution) and the
 * client, so both always agree. Integer maths only: every value that reaches
 * the simulation is an integer.
 */

export const DEFCON_START_LEVEL = 5;

/**
 * The nukes a player launches: the upstream Nukes group without MIRVWarhead.
 * Warheads are spawned by a MIRV that is already in flight and must never be
 * blocked, or MIRVs would break.
 */
export const NUKE_WEAPON_TYPES: readonly UnitType[] = Nukes.types.filter(
  (t) => t !== UnitType.MIRVWarhead,
);

export function isNukeWeapon(unitType: UnitType): boolean {
  return NUKE_WEAPON_TYPES.includes(unitType);
}

interface UnitSettings {
  isUnitDisabled(unitType: UnitType): boolean;
}

/**
 * The nuke types the host left usable. Empty when missile silos are disabled,
 * because nukes launch from silos.
 */
export function enabledNukeWeapons(config: UnitSettings): UnitType[] {
  if (config.isUnitDisabled(UnitType.MissileSilo)) return [];
  return NUKE_WEAPON_TYPES.filter((t) => !config.isUnitDisabled(t));
}

/** Whether nukes can ever be used in this game (host settings only). */
export function nukesPossible(config: UnitSettings): boolean {
  return enabledNukeWeapons(config).length > 0;
}

/**
 * Whether DEFCON blocks building (launching) this unit type. Only ever adds a
 * restriction: host-disabled units are checked separately, before this.
 */
export function blocksUnit(
  level: number,
  unitType: UnitType,
  tuning: DefconTuning,
  gameOver: boolean,
): boolean {
  return isNukeWeapon(unitType) && nukesLockedAt(level, tuning, gameOver);
}

/** Whether all nukes are locked by DEFCON right now. */
export function nukesLockedAt(
  level: number,
  tuning: DefconTuning,
  gameOver: boolean,
): boolean {
  return tuning.lockNukes && !gameOver && level > tuning.nukeUnlockLevel;
}

const TICKS_PER_MINUTE = 600;

/**
 * Percentage the schedule runs at in a game with a timer (`maxTimerValue`,
 * minutes). What counts is the time the DEFCON clock actually gets: the timer
 * runs from the end of the spawn phase, the clock only from the end of peace
 * time. Less than the reference: proportionally shorter, but never below the
 * configured minimum. Never longer.
 *
 * @param peaceTicks spawn immunity (peace time) in ticks
 */
export function timerScalePercent(
  maxTimerValue: number | null | undefined,
  tuning: DefconTuning,
  peaceTicks = 0,
): number {
  if (maxTimerValue === null || maxTimerValue === undefined) return 100;
  const availableTicks = maxTimerValue * TICKS_PER_MINUTE - peaceTicks;
  const referenceTicks = tuning.timerReferenceMinutes * TICKS_PER_MINUTE;
  if (availableTicks >= referenceTicks) return 100;
  const percent = Math.floor((availableTicks * 100) / referenceTicks);
  return Math.max(tuning.timerMinScalePercent, percent);
}

/**
 * The tuning for a game with a timer: latest/earliest times and the minimum
 * gap between steps shrink by timerScalePercent. Bonuses stay as they are.
 */
export function scaleForTimer(
  tuning: DefconTuning,
  maxTimerValue: number | null | undefined,
  peaceTicks = 0,
): DefconTuning {
  const percent = timerScalePercent(maxTimerValue, tuning, peaceTicks);
  const scale = (ticks: number) => Math.floor((ticks * percent) / 100);
  const scaleLevels = (
    r: Record<DefconStepLevel, number>,
  ): Record<DefconStepLevel, number> => ({
    4: scale(r[4]),
    3: scale(r[3]),
    2: scale(r[2]),
    1: scale(r[1]),
  });
  return {
    ...tuning,
    latestTicks: scaleLevels(tuning.latestTicks),
    earliestTicks: scaleLevels(tuning.earliestTicks),
    minTicksBetweenSteps: scale(tuning.minTicksBetweenSteps),
  };
}

/**
 * A bonus in ticks, weighted in percent and shrunk for big lobbies:
 * bonus × percent/100 × ref/max(ref, alivePlayers), rounded down.
 */
export function scaledBonus(
  bonusTicks: number,
  percent: number,
  alivePlayers: number,
  referencePlayers: number,
): number {
  return Math.floor(
    (bonusTicks * percent * referencePlayers) /
      (100 * Math.max(referencePlayers, alivePlayers)),
  );
}

/**
 * The level after this tick: at most one step down, and only when the
 * escalation clock reached the level, the level's earliest time has passed
 * and the last step is long enough ago. Never goes up.
 *
 * @param elapsedTicks real ticks since peace time ended
 * @param clockTicks elapsedTicks plus all bonuses
 */
export function nextDefconLevel(
  level: number,
  lastStepTick: number | null,
  tick: number,
  elapsedTicks: number,
  clockTicks: number,
  tuning: DefconTuning,
): number {
  if (level <= 1) return level;
  const target = (level - 1) as DefconStepLevel;
  if (clockTicks < tuning.latestTicks[target]) return level;
  if (elapsedTicks < tuning.earliestTicks[target]) return level;
  if (
    lastStepTick !== null &&
    tick - lastStepTick < tuning.minTicksBetweenSteps
  ) {
    return level;
  }
  return target;
}

/** Order-independent key of two players (small ids are at most 12 bits). */
export function pairKey(smallIdA: number, smallIdB: number): number {
  const lo = Math.min(smallIdA, smallIdB);
  const hi = Math.max(smallIdA, smallIdB);
  return lo * 65536 + hi;
}
