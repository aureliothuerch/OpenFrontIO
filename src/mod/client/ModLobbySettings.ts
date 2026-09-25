import type { ToggleOptionConfig } from "../../client/components/GameConfigSettings";
import type { GameConfig } from "../../core/Schemas";
import type { ModGameConfig } from "../core/ModGameConfig";
import * as Defcon from "./defcon/DefconLobbySettings";

/**
 * Every mod setting of a lobby menu, behind one set of MOD hooks in
 * SinglePlayerModal, HostLobbyModal and LobbySettingsSummary. A later mod
 * feature with a lobby switch adds itself here, not to those upstream files.
 *
 * The menus keep a ModLobbyState and replace it (never mutate), so Lit sees
 * every change.
 */
export interface ModLobbyState {
  readonly defconEnabled: boolean;
}

export function defaults(): ModLobbyState {
  return { defconEnabled: Defcon.defconLobbyDefault() };
}

/** The mod toggle cards for <game-config-settings>. */
export function toggles(state: ModLobbyState): ToggleOptionConfig[] {
  return [...Defcon.defconLobbyToggles(state.defconEnabled)];
}

/** Whether a toggled card belongs to a mod setting. */
export function isToggle(labelKey: string): boolean {
  return Defcon.isDefconLobbyToggle(labelKey);
}

/** The state after a mod toggle card was clicked. */
export function toggled(
  state: ModLobbyState,
  labelKey: string,
  checked: boolean,
): ModLobbyState {
  if (Defcon.isDefconLobbyToggle(labelKey)) {
    return { ...state, defconEnabled: checked };
  }
  return state;
}

/**
 * The single `mod` block for the game config, merged from every feature
 * (a shallow spread of two feature blocks would drop one of them).
 */
export function gameConfig(state: ModLobbyState): { mod: ModGameConfig } {
  return {
    mod: {
      ...Defcon.defconGameConfig(state.defconEnabled).mod,
    },
  };
}

/** Whether any mod setting differs from its default. */
export function optionsChanged(state: ModLobbyState): boolean {
  return Defcon.defconOptionChanged(state.defconEnabled);
}

/** The mod lines of the lobby settings summary other players see. */
export function notableSettings(
  config: Pick<GameConfig, "mod">,
): { label: string; value: string }[] {
  return [...Defcon.defconNotableSettings(config)];
}
