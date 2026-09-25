import type { GameView } from "../../../client/view";
import type { DefconTuning } from "../../core/ModConfig";

/**
 * What the client knows about DEFCON in one game: the level from the latest
 * ModDefcon update and the game's tuning. Written only by DefconController,
 * read by the menu hooks (DefconUiHooks.ts).
 *
 * Keyed by GameView, so a second game in the same page (no reload) never
 * inherits the level of the previous one. No entry means DEFCON is off in
 * that game, or the controller has not started yet: every hook then behaves
 * exactly like OpenFront.
 */
export interface DefconClientState {
  readonly level: number;
  readonly tuning: DefconTuning;
}

const states = new WeakMap<GameView, DefconClientState>();

export function defconClientState(
  game: GameView | null | undefined,
): DefconClientState | null {
  if (game === null || game === undefined) return null;
  return states.get(game) ?? null;
}

export function setDefconClientState(
  game: GameView,
  state: DefconClientState,
): void {
  states.set(game, state);
}

export function clearDefconClientState(game: GameView): void {
  states.delete(game);
}
