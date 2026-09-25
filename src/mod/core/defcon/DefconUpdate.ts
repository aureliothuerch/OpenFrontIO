import type { GameUpdateType } from "../../../core/game/GameUpdates";

/**
 * Sent on every DEFCON change and as a heartbeat (see DefconExecution).
 * Hooked into the GameUpdate union in src/core/game/GameUpdates.ts.
 */
export interface ModDefconUpdate {
  type: GameUpdateType.ModDefcon;
  level: number;
  /** The level before the most recent change (5 before the first change). */
  previousLevel: number;
  /** The tick the current level was reached. */
  reachedAtTick: number;
  /**
   * The simulation's game-over verdict (a winner is decided): DEFCON is frozen
   * and the nuke lock is lifted. The client must use this, not
   * GameView.gameOver(), for the lock: a cancelled game ends without a winner,
   * and then the simulation still locks.
   */
  gameOver: boolean;
}
