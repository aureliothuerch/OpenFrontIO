import type { ToggleOptionConfig } from "../../../client/components/GameConfigSettings";
import { translateText } from "../../../client/Utils";
import type { GameConfig } from "../../../core/Schemas";
import { MOD_CONFIG } from "../../core/ModConfig";

/**
 * DEFCON's part of the mod lobby settings (collected in ../ModLobbySettings.ts,
 * which the singleplayer menu, the private host lobby and the lobby settings
 * summary call through their MOD hooks): the "DEFCON on/off" switch. The value
 * travels in GameConfig.mod.defcon.enabled; off means plain OpenFront (see
 * core/defcon/DefconSettings.ts).
 *
 * Only the host can change it: the server rejects update_game_config from
 * anyone else (src/server/IntentAuthorization.ts).
 */

/** The toggle's id in <game-config-settings>, and its label key. */
export const DEFCON_LOBBY_TOGGLE_KEY = "mod.defcon.lobby_toggle";

/** The switch position a new game starts with (on). */
export function defconLobbyDefault(): boolean {
  return MOD_CONFIG.defcon.enabled;
}

/** The toggle card for the menu's option toggles. */
export function defconLobbyToggles(enabled: boolean): ToggleOptionConfig[] {
  return [{ labelKey: DEFCON_LOBBY_TOGGLE_KEY, checked: enabled }];
}

/** Whether a toggled card is the DEFCON switch. */
export function isDefconLobbyToggle(labelKey: string): boolean {
  return labelKey === DEFCON_LOBBY_TOGGLE_KEY;
}

/**
 * The config part for the switch. Always explicit, also when on: the host
 * lobby sends config patches as JSON, where an undefined value disappears
 * and the server would keep the previous value.
 */
export function defconGameConfig(enabled: boolean): Pick<GameConfig, "mod"> {
  return { mod: { defcon: { enabled } } };
}

/** Whether the switch differs from the default (singleplayer options warning). */
export function defconOptionChanged(enabled: boolean): boolean {
  return enabled !== defconLobbyDefault();
}

/**
 * The lobby summary line: like OpenFront's summary, which lists what differs
 * from a normal game, it only shows when DEFCON is off.
 */
export function defconNotableSettings(
  config: Pick<GameConfig, "mod">,
): { label: string; value: string }[] {
  const enabled = config.mod?.defcon?.enabled ?? defconLobbyDefault();
  if (enabled) return [];
  return [
    {
      label: translateText(DEFCON_LOBBY_TOGGLE_KEY),
      value: translateText("common.disabled"),
    },
  ];
}
