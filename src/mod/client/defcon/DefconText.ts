import { UnitType } from "../../../core/game/Game";
import type { DefconTuning } from "../../core/ModConfig";
import {
  enabledNukeWeapons,
  isNukeWeapon,
  nukesLockedAt,
  nukesPossible,
} from "../../core/defcon/DefconRules";

/**
 * Which DEFCON texts to show, as translation keys plus parameters. Pure (no
 * translateText here), so the rules are unit tested
 * (tests/mod/client/DefconText.test.ts). Keys live in resources/lang/en.json
 * under "mod.defcon".
 *
 * Host settings: when nukes can never be used (silo or all nuke types
 * disabled) no text ever mentions nukes, and a host-disabled nuke type never
 * gets the DEFCON hint.
 */

export interface TextRef {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface BannerText {
  readonly title: TextRef;
  readonly line: TextRef | null;
  /** Unit name keys to translate and join into the {units} parameter. */
  readonly unitKeys: readonly string[];
}

export interface IndicatorText {
  readonly title: TextRef;
  readonly hint: TextRef | null;
}

interface UnitSettings {
  isUnitDisabled(unitType: UnitType): boolean;
}

export const DEFCON_TEXT_KEYS = {
  level: "mod.defcon.level",
  nukesFrom: "mod.defcon.nukes_from",
  nukesReleased: "mod.defcon.nukes_released",
  lockedHint: "mod.defcon.locked_hint",
} as const;

const DESCRIPTION_KEYS: Readonly<Record<number, string>> = {
  4: "mod.defcon.desc_4",
  3: "mod.defcon.desc_3",
  2: "mod.defcon.desc_2",
  1: "mod.defcon.desc_1",
};

const UNIT_NAME_KEYS: Readonly<Partial<Record<UnitType, string>>> = {
  [UnitType.AtomBomb]: "unit_type.atom_bomb",
  [UnitType.HydrogenBomb]: "unit_type.hydrogen_bomb",
  [UnitType.MIRV]: "unit_type.mirv",
};

/** The permanent indicator: "DEFCON X", plus "Nukes from DEFCON 2" while locked. */
export function defconIndicatorText(
  level: number,
  tuning: DefconTuning,
  config: UnitSettings,
  gameOver: boolean,
): IndicatorText {
  const locked =
    nukesLockedAt(level, tuning, gameOver) && nukesPossible(config);
  return {
    title: { key: DEFCON_TEXT_KEYS.level, params: { level } },
    hint: locked
      ? {
          key: DEFCON_TEXT_KEYS.nukesFrom,
          params: { level: tuning.nukeUnlockLevel },
        }
      : null,
  };
}

/**
 * The banner on a change to `level`. At the unlock level it names the nuke
 * types that are now released (only those the host enabled); otherwise, and
 * whenever nukes are impossible or never locked, a short level description.
 */
export function defconBannerText(
  level: number,
  tuning: DefconTuning,
  config: UnitSettings,
): BannerText {
  const title: TextRef = { key: DEFCON_TEXT_KEYS.level, params: { level } };
  if (level === tuning.nukeUnlockLevel && tuning.lockNukes) {
    const unitKeys = enabledNukeWeapons(config).map(
      (t) => UNIT_NAME_KEYS[t] ?? t,
    );
    if (unitKeys.length > 0) {
      return {
        title,
        line: { key: DEFCON_TEXT_KEYS.nukesReleased },
        unitKeys,
      };
    }
  }
  const description = DESCRIPTION_KEYS[level];
  return {
    title,
    line: description === undefined ? null : { key: description },
    unitKeys: [],
  };
}

/**
 * The red "Only available from DEFCON 2" hint for a build button, or null.
 * Only for nuke types that are locked by DEFCON alone: never for types the
 * host disabled, never when nukes are impossible, never after the game.
 */
export function defconLockedHint(
  unitType: UnitType,
  level: number,
  tuning: DefconTuning,
  config: UnitSettings,
  gameOver: boolean,
): TextRef | null {
  if (!isNukeWeapon(unitType)) return null;
  if (config.isUnitDisabled(unitType) || !nukesPossible(config)) return null;
  if (!nukesLockedAt(level, tuning, gameOver)) return null;
  return {
    key: DEFCON_TEXT_KEYS.lockedHint,
    params: { level: tuning.nukeUnlockLevel },
  };
}
