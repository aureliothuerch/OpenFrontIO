import type { Game, Player, UnitType } from "../../../core/game/Game";
import type { DefconExecution } from "./DefconExecution";

/**
 * Per-game lookup of the running DefconExecution, and the functions upstream
 * hooks call. No entry means DEFCON is not running in that game: nothing is
 * locked and nothing is counted (e.g. tests that build a game without
 * GameRunner.init(), or an old snapshot without DEFCON).
 *
 * Type-only imports: upstream core files import this module, so it must not
 * pull the execution (and its imports) into their load order.
 */
const running = new WeakMap<Game, DefconExecution>();

export function registerDefcon(game: Game, exec: DefconExecution): void {
  running.set(game, exec);
}

/** The current level, or null when DEFCON is not running in this game. */
export function defconLevel(game: Game): number | null {
  return running.get(game)?.level() ?? null;
}

/** The tick a level was reached, or null if it was not reached (yet). */
export function defconReachedAtTick(game: Game, level: number): number | null {
  return running.get(game)?.reachedAtTick(level) ?? null;
}

/** MOD hook in PlayerImpl.canBuildUnitType: the nuke lock. */
export function modDefconBlocksUnit(game: Game, unitType: UnitType): boolean {
  return running.get(game)?.blocksUnit(unitType) ?? false;
}

/** MOD hook in the nation nuke/MIRV behaviours: skip nuke planning. */
export function modDefconNukesLocked(game: Game): boolean {
  return running.get(game)?.nukesLocked() ?? false;
}

/** MOD hook in GameImpl.breakAlliance, called for real betrayals only. */
export function modDefconOnBetrayal(
  game: Game,
  traitor: Player,
  betrayed: Player,
): void {
  running.get(game)?.onBetrayal(traitor, betrayed);
}
