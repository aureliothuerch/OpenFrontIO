import type { Execution, Game } from "../../core/game/Game";
import {
  DefconExecution,
  DefconExecutionSnapshot,
} from "./defcon/DefconExecution";
import { defconSettings } from "./defcon/DefconSettings";

/**
 * Executions our features add when a game starts. Called from the one MOD
 * hook in GameRunner.init(). A feature that is switched off adds nothing.
 */
export function modInitExecutions(game: Game): Execution[] {
  const execs: Execution[] = [];
  const defcon = defconSettings(game.config());
  if (defcon.enabled) execs.push(new DefconExecution(game, defcon));
  return execs;
}

/**
 * Snapshot types of every mod execution, spread into upstream's
 * EXECUTION_SNAPSHOT_TYPES. Names are stored in snapshots: never rename one.
 */
export const MOD_EXECUTION_SNAPSHOT_TYPES = [DefconExecutionSnapshot] as const;
