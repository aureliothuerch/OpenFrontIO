import type { Controller } from "../../client/Controller";
import type { GameView } from "../../client/view";
import type { EventBus } from "../../core/EventBus";
import { DefconController } from "./defcon/DefconController";

/**
 * The controllers our features add to a game's renderer. Called from the one
 * MOD hook in createRenderer (src/client/hud/GameRenderer.ts).
 *
 * Only constructs objects: nothing here may read the game or touch the DOM
 * (each controller does that in init()), and a failure never blocks the game
 * start, it only leaves our features out.
 */
export function createModControllers(
  game: GameView,
  eventBus: EventBus,
): Controller[] {
  try {
    return [new DefconController(game, eventBus)];
  } catch (err) {
    console.error("createModControllers failed, mod UI off", err);
    return [];
  }
}
