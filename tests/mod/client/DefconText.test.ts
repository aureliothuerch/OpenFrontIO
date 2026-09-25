import fs from "fs";
import IntlMessageFormat from "intl-messageformat";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  UnitType,
} from "../../../src/core/game/Game";
import { UserSettings } from "../../../src/core/game/UserSettings";
import {
  BannerText,
  DEFCON_TEXT_KEYS,
  defconBannerText,
  defconIndicatorText,
  defconLockedHint,
  TextRef,
} from "../../../src/mod/client/defcon/DefconText";
import {
  blocksUnit,
  NUKE_WEAPON_TYPES,
  nukesPossible,
} from "../../../src/mod/core/defcon/DefconRules";
import { DefconTuning, MOD_CONFIG } from "../../../src/mod/core/ModConfig";
import { TestConfig } from "../../util/TestConfig";

/**
 * DefconText: which DEFCON texts the client shows (keys + params). The rules
 * come from the plan: "nukes released" never when nukes are off, only
 * host-enabled types are named, the red hint only for a DEFCON lock (never
 * for host-disabled types, never after the game). Every key must exist in
 * en.json with the right ICU parameters.
 */

const LOCKING: DefconTuning = { ...MOD_CONFIG.defcon, lockNukes: true };
const NO_LOCK: DefconTuning = { ...MOD_CONFIG.defcon, lockNukes: false };
const UNLOCK = LOCKING.nukeUnlockLevel;
/** Same rules with a different unlock level, so nothing depends on "2". */
const UNLOCK_AT_3: DefconTuning = { ...LOCKING, nukeUnlockLevel: 3 };

const LEVELS = [5, 4, 3, 2, 1];
const LOCKED_LEVELS = LEVELS.filter((l) => l > UNLOCK);
const UNLOCKED_LEVELS = LEVELS.filter((l) => l <= UNLOCK);

const ALL_UNIT_TYPES = Object.values(UnitType);
const NUKE_WEAPONS = [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV];

const DESC_KEYS: Record<number, string> = {
  4: "mod.defcon.desc_4",
  3: "mod.defcon.desc_3",
  2: "mod.defcon.desc_2",
  1: "mod.defcon.desc_1",
};
const UNIT_NAME_KEYS: Record<string, string> = {
  [UnitType.AtomBomb]: "unit_type.atom_bomb",
  [UnitType.HydrogenBomb]: "unit_type.hydrogen_bomb",
  [UnitType.MIRV]: "unit_type.mirv",
};

interface UnitSettings {
  isUnitDisabled(unitType: UnitType): boolean;
}

function units(...disabled: UnitType[]): UnitSettings {
  const set = new Set(disabled);
  return { isUnitDisabled: (t) => set.has(t) };
}

/** The real upstream Config, as a host would set it up. */
function realConfig(disabledUnits: UnitType[]): UnitSettings {
  return new TestConfig(
    {
      gameMap: GameMapType.Asia,
      gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA,
      gameType: GameType.Private,
      difficulty: Difficulty.Medium,
      nations: "default",
      donateGold: false,
      donateTroops: false,
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
      disabledUnits,
    },
    new UserSettings(),
    false,
  );
}

/** What the public "isNukesDisabled" modifier disables (MapPlaylist). */
const NUKES_MODIFIER_UNITS = [
  UnitType.MissileSilo,
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.SAMLauncher,
];

/** Host settings under which nukes can be used at all. */
const NUKES_ON: [string, UnitSettings][] = [
  ["everything enabled", units()],
  ["SAMs disabled", units(UnitType.SAMLauncher)],
  ["atom bomb disabled", units(UnitType.AtomBomb)],
  ["hydrogen bomb disabled", units(UnitType.HydrogenBomb)],
  ["MIRV disabled", units(UnitType.MIRV)],
  ["only MIRV enabled", units(UnitType.AtomBomb, UnitType.HydrogenBomb)],
  ["MIRV warhead disabled", units(UnitType.MIRVWarhead)],
  ["cities disabled", units(UnitType.City)],
  ["real config, nothing disabled", realConfig([])],
  ["real config, atom bomb disabled", realConfig([UnitType.AtomBomb])],
];

/** Host settings under which nukes can never be used. */
const NUKES_OFF: [string, UnitSettings][] = [
  [
    "all nuke types disabled",
    units(UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV),
  ],
  ["missile silo disabled", units(UnitType.MissileSilo)],
  [
    "all nukes and the MIRV warhead disabled",
    units(...NUKE_WEAPONS, UnitType.MIRVWarhead),
  ],
  ["public isNukesDisabled modifier", units(...NUKES_MODIFIER_UNITS)],
  ["real config, isNukesDisabled modifier", realConfig(NUKES_MODIFIER_UNITS)],
  ["real config, missile silo disabled", realConfig([UnitType.MissileSilo])],
];

function isNukeText(ref: TextRef | null): boolean {
  return (
    ref !== null &&
    (ref.key === DEFCON_TEXT_KEYS.nukesFrom ||
      ref.key === DEFCON_TEXT_KEYS.nukesReleased ||
      ref.key === DEFCON_TEXT_KEYS.lockedHint)
  );
}

describe("defconIndicatorText", () => {
  it("always shows 'DEFCON X' with the level", () => {
    for (const level of LEVELS) {
      for (const tuning of [LOCKING, NO_LOCK]) {
        for (const gameOver of [false, true]) {
          const text = defconIndicatorText(level, tuning, units(), gameOver);
          expect(text.title).toEqual({
            key: DEFCON_TEXT_KEYS.level,
            params: { level },
          });
        }
      }
    }
  });

  it("hint 'Nukes from DEFCON <unlock>' while locked and nukes are possible", () => {
    for (const [name, config] of NUKES_ON) {
      for (const level of LOCKED_LEVELS) {
        const text = defconIndicatorText(level, LOCKING, config, false);
        expect(text.hint, `${name}, level ${level}`).toEqual({
          key: DEFCON_TEXT_KEYS.nukesFrom,
          params: { level: UNLOCK },
        });
      }
    }
  });

  it("no hint at or below the unlock level", () => {
    for (const [name, config] of NUKES_ON) {
      for (const level of UNLOCKED_LEVELS) {
        const text = defconIndicatorText(level, LOCKING, config, false);
        expect(text.hint, `${name}, level ${level}`).toBeNull();
      }
    }
  });

  it("no hint when all nukes or the silo are disabled", () => {
    for (const [name, config] of NUKES_OFF) {
      for (const level of LEVELS) {
        const text = defconIndicatorText(level, LOCKING, config, false);
        expect(text.hint, `${name}, level ${level}`).toBeNull();
        expect(text.title.key).toBe(DEFCON_TEXT_KEYS.level);
      }
    }
  });

  it("no hint when lockNukes is off", () => {
    for (const level of LEVELS) {
      expect(defconIndicatorText(level, NO_LOCK, units(), false).hint).toBe(
        null,
      );
    }
  });

  it("no hint after the game is over", () => {
    for (const [name, config] of NUKES_ON) {
      for (const level of LEVELS) {
        const text = defconIndicatorText(level, LOCKING, config, true);
        expect(text.hint, `${name}, level ${level}`).toBeNull();
      }
    }
  });

  it("follows the configured unlock level", () => {
    expect(defconIndicatorText(4, UNLOCK_AT_3, units(), false).hint).toEqual({
      key: DEFCON_TEXT_KEYS.nukesFrom,
      params: { level: 3 },
    });
    expect(defconIndicatorText(3, UNLOCK_AT_3, units(), false).hint).toBeNull();
  });

  it("shows the hint exactly when at least one build button shows the red hint", () => {
    for (const [name, config] of [...NUKES_ON, ...NUKES_OFF]) {
      for (const tuning of [LOCKING, NO_LOCK, UNLOCK_AT_3]) {
        for (const level of LEVELS) {
          for (const gameOver of [false, true]) {
            const indicator = defconIndicatorText(
              level,
              tuning,
              config,
              gameOver,
            );
            const anyButton = ALL_UNIT_TYPES.some(
              (t) =>
                defconLockedHint(t, level, tuning, config, gameOver) !== null,
            );
            expect(
              indicator.hint !== null,
              `${name}, level ${level}, gameOver ${gameOver}`,
            ).toBe(anyButton);
          }
        }
      }
    }
  });
});

describe("defconBannerText", () => {
  function expectReleased(text: BannerText, unitKeys: string[]) {
    expect(text.line).toEqual({ key: DEFCON_TEXT_KEYS.nukesReleased });
    expect(text.unitKeys).toEqual(unitKeys);
  }

  it("title is always 'DEFCON X'", () => {
    for (const level of LEVELS) {
      for (const [, config] of [...NUKES_ON, ...NUKES_OFF]) {
        expect(defconBannerText(level, LOCKING, config).title).toEqual({
          key: DEFCON_TEXT_KEYS.level,
          params: { level },
        });
      }
    }
  });

  it("at the unlock level: 'nukes released' with Atom, Hydrogen, MIRV in that order", () => {
    expectReleased(defconBannerText(UNLOCK, LOCKING, units()), [
      "unit_type.atom_bomb",
      "unit_type.hydrogen_bomb",
      "unit_type.mirv",
    ]);
    expectReleased(defconBannerText(UNLOCK, LOCKING, realConfig([])), [
      "unit_type.atom_bomb",
      "unit_type.hydrogen_bomb",
      "unit_type.mirv",
    ]);
  });

  it("names only the nuke types the host left enabled", () => {
    const cases: [UnitType[], string[]][] = [
      [[UnitType.AtomBomb], ["unit_type.hydrogen_bomb", "unit_type.mirv"]],
      [[UnitType.HydrogenBomb], ["unit_type.atom_bomb", "unit_type.mirv"]],
      [[UnitType.MIRV], ["unit_type.atom_bomb", "unit_type.hydrogen_bomb"]],
      [[UnitType.AtomBomb, UnitType.HydrogenBomb], ["unit_type.mirv"]],
      [[UnitType.AtomBomb, UnitType.MIRV], ["unit_type.hydrogen_bomb"]],
      [[UnitType.HydrogenBomb, UnitType.MIRV], ["unit_type.atom_bomb"]],
      // Disabling non-weapons changes nothing.
      [
        [UnitType.SAMLauncher, UnitType.City, UnitType.MIRVWarhead],
        ["unit_type.atom_bomb", "unit_type.hydrogen_bomb", "unit_type.mirv"],
      ],
    ];
    for (const [disabled, expected] of cases) {
      expectReleased(
        defconBannerText(UNLOCK, LOCKING, units(...disabled)),
        expected,
      );
      expectReleased(
        defconBannerText(UNLOCK, LOCKING, realConfig(disabled)),
        expected,
      );
    }
  });

  it("never names MIRV warheads, silos, SAMs or other units", () => {
    const allowed = new Set(Object.values(UNIT_NAME_KEYS));
    for (const [, config] of [...NUKES_ON, ...NUKES_OFF]) {
      for (const level of LEVELS) {
        for (const key of defconBannerText(level, LOCKING, config).unitKeys) {
          expect(allowed.has(key), key).toBe(true);
        }
      }
    }
  });

  it("never mentions nukes when all nukes or the silo are disabled: description line instead", () => {
    for (const [name, config] of NUKES_OFF) {
      for (const tuning of [LOCKING, NO_LOCK, UNLOCK_AT_3]) {
        for (const level of LEVELS) {
          const text = defconBannerText(level, tuning, config);
          expect(isNukeText(text.line), `${name}, level ${level}`).toBe(false);
          expect(text.unitKeys).toEqual([]);
          expect(text.line).toEqual(
            level === 5 ? null : { key: DESC_KEYS[level] },
          );
        }
      }
    }
  });

  it("no 'nukes released' when lockNukes is off (nukes were never locked)", () => {
    for (const [name, config] of NUKES_ON) {
      const text = defconBannerText(UNLOCK, NO_LOCK, config);
      expect(text.line, name).toEqual({ key: DESC_KEYS[UNLOCK] });
      expect(text.unitKeys).toEqual([]);
    }
  });

  it("other levels show their description, level 5 no line", () => {
    for (const [name, config] of [...NUKES_ON, ...NUKES_OFF]) {
      for (const tuning of [LOCKING, NO_LOCK]) {
        for (const level of LEVELS.filter((l) => l !== UNLOCK)) {
          const text = defconBannerText(level, tuning, config);
          expect(text.line, `${name}, level ${level}`).toEqual(
            level === 5 ? null : { key: DESC_KEYS[level] },
          );
          expect(text.unitKeys).toEqual([]);
        }
      }
    }
  });

  it("'nukes released' only ever at the unlock level", () => {
    for (const [name, config] of NUKES_ON) {
      for (const tuning of [LOCKING, UNLOCK_AT_3]) {
        for (const level of LEVELS) {
          const released =
            defconBannerText(level, tuning, config).line?.key ===
            DEFCON_TEXT_KEYS.nukesReleased;
          expect(released, `${name}, level ${level}`).toBe(
            level === tuning.nukeUnlockLevel,
          );
        }
      }
    }
    // With the unlock at 3, DEFCON 2 is a plain description.
    expect(defconBannerText(2, UNLOCK_AT_3, units())).toEqual({
      title: { key: DEFCON_TEXT_KEYS.level, params: { level: 2 } },
      line: { key: DESC_KEYS[2] },
      unitKeys: [],
    });
  });
});

describe("defconLockedHint", () => {
  const HINT = { key: DEFCON_TEXT_KEYS.lockedHint, params: { level: UNLOCK } };

  it("shows 'Only available from DEFCON <unlock>' for every nuke weapon while locked", () => {
    expect([...NUKE_WEAPON_TYPES].sort()).toEqual([...NUKE_WEAPONS].sort());
    for (const type of NUKE_WEAPONS) {
      for (const level of LOCKED_LEVELS) {
        expect(
          defconLockedHint(type, level, LOCKING, units(), false),
          `${type}, level ${level}`,
        ).toEqual(HINT);
      }
    }
  });

  it("never for MIRV warheads, silos, SAMs, cities or any other unit", () => {
    for (const type of ALL_UNIT_TYPES.filter(
      (t) => !NUKE_WEAPONS.includes(t),
    )) {
      for (const [, config] of NUKES_ON) {
        for (const level of LEVELS) {
          expect(
            defconLockedHint(type, level, LOCKING, config, false),
            `${type}, level ${level}`,
          ).toBeNull();
        }
      }
    }
  });

  it("never for a type the host disabled; the other types keep it", () => {
    for (const disabledType of NUKE_WEAPONS) {
      for (const config of [units(disabledType), realConfig([disabledType])]) {
        for (const level of LOCKED_LEVELS) {
          for (const type of NUKE_WEAPONS) {
            expect(
              defconLockedHint(type, level, LOCKING, config, false),
              `${type} with ${disabledType} disabled, level ${level}`,
            ).toEqual(type === disabledType ? null : HINT);
          }
        }
      }
    }
  });

  it("never when the silo or all nukes are disabled", () => {
    for (const [name, config] of NUKES_OFF) {
      for (const type of ALL_UNIT_TYPES) {
        for (const level of LEVELS) {
          expect(
            defconLockedHint(type, level, LOCKING, config, false),
            `${name}: ${type}, level ${level}`,
          ).toBeNull();
        }
      }
    }
  });

  it("never after the game is over", () => {
    for (const type of ALL_UNIT_TYPES) {
      for (const level of LEVELS) {
        expect(
          defconLockedHint(type, level, LOCKING, units(), true),
        ).toBeNull();
      }
    }
  });

  it("never at or below the unlock level", () => {
    for (const type of ALL_UNIT_TYPES) {
      for (const level of UNLOCKED_LEVELS) {
        expect(
          defconLockedHint(type, level, LOCKING, units(), false),
        ).toBeNull();
      }
    }
  });

  it("never when lockNukes is off", () => {
    for (const type of ALL_UNIT_TYPES) {
      for (const level of LEVELS) {
        expect(
          defconLockedHint(type, level, NO_LOCK, units(), false),
        ).toBeNull();
      }
    }
  });

  it("follows the configured unlock level", () => {
    expect(
      defconLockedHint(UnitType.AtomBomb, 4, UNLOCK_AT_3, units(), false),
    ).toEqual({ key: DEFCON_TEXT_KEYS.lockedHint, params: { level: 3 } });
    expect(
      defconLockedHint(UnitType.AtomBomb, 3, UNLOCK_AT_3, units(), false),
    ).toBeNull();
  });

  it("appears exactly when the core DEFCON lock is what stops a host-allowed nuke", () => {
    for (const [name, config] of [...NUKES_ON, ...NUKES_OFF]) {
      for (const tuning of [LOCKING, NO_LOCK, UNLOCK_AT_3]) {
        for (const type of ALL_UNIT_TYPES) {
          for (const level of LEVELS) {
            for (const gameOver of [false, true]) {
              const expected =
                blocksUnit(level, type, tuning, gameOver) &&
                !config.isUnitDisabled(type) &&
                nukesPossible(config);
              expect(
                defconLockedHint(type, level, tuning, config, gameOver) !==
                  null,
                `${name}: ${type}, level ${level}, gameOver ${gameOver}`,
              ).toBe(expected);
            }
          }
        }
      }
    }
  });
});

describe("DEFCON texts in en.json", () => {
  const EN_JSON = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "resources",
    "lang",
    "en.json",
  );
  const en = JSON.parse(fs.readFileSync(EN_JSON, "utf8"));

  function message(key: string): unknown {
    let node: unknown = en;
    for (const part of key.split(".")) {
      if (typeof node !== "object" || node === null) return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  }

  /** Names of the simple ICU arguments ({name}) in a message. */
  function icuParams(text: string): string[] {
    return [...text.matchAll(/\{\s*(\w+)\s*\}/g)].map((m) => m[1]).sort();
  }

  const EXPECTED_PARAMS: Record<string, string[]> = {
    [DEFCON_TEXT_KEYS.level]: ["level"],
    [DEFCON_TEXT_KEYS.nukesFrom]: ["level"],
    [DEFCON_TEXT_KEYS.nukesReleased]: ["units"],
    [DEFCON_TEXT_KEYS.lockedHint]: ["level"],
    [DESC_KEYS[1]]: [],
    [DESC_KEYS[2]]: [],
    [DESC_KEYS[3]]: [],
    [DESC_KEYS[4]]: [],
  };

  it("every DEFCON key exists with the expected ICU params", () => {
    const keys = [
      ...Object.values(DEFCON_TEXT_KEYS),
      ...Object.values(DESC_KEYS),
    ];
    expect(keys.sort()).toEqual(Object.keys(EXPECTED_PARAMS).sort());
    for (const key of keys) {
      const text = message(key);
      expect(typeof text, key).toBe("string");
      expect((text as string).length, key).toBeGreaterThan(0);
      expect(icuParams(text as string), key).toEqual(EXPECTED_PARAMS[key]);
    }
  });

  it("the messages format with their params (valid ICU)", () => {
    const values: Record<string, string | number> = {
      level: 2,
      units: "Atom Bomb, MIRV",
    };
    for (const [key, params] of Object.entries(EXPECTED_PARAMS)) {
      const args = Object.fromEntries(params.map((p) => [p, values[p]]));
      const out = new IntlMessageFormat(message(key) as string, "en").format(
        args,
      ) as string;
      for (const p of params) expect(out, key).toContain(String(values[p]));
    }
  });

  it("the unit names used in the banner exist", () => {
    for (const key of Object.values(UNIT_NAME_KEYS)) {
      expect(typeof message(key), key).toBe("string");
    }
  });

  it("level title and descriptions never mention nukes (they show when nukes are off)", () => {
    for (const key of [DEFCON_TEXT_KEYS.level, ...Object.values(DESC_KEYS)]) {
      expect(message(key) as string, key).not.toMatch(
        /nuk|nuclear|atom|hydrogen|mirv|missile|warhead/i,
      );
    }
  });

  it("every text the functions produce resolves in en.json with matching params", () => {
    const refs: TextRef[] = [];
    const unitKeys = new Set<string>();
    for (const [, config] of [...NUKES_ON, ...NUKES_OFF]) {
      for (const tuning of [LOCKING, NO_LOCK]) {
        for (const level of LEVELS) {
          for (const gameOver of [false, true]) {
            const indicator = defconIndicatorText(
              level,
              tuning,
              config,
              gameOver,
            );
            refs.push(indicator.title);
            if (indicator.hint) refs.push(indicator.hint);
            for (const type of ALL_UNIT_TYPES) {
              const hint = defconLockedHint(
                type,
                level,
                tuning,
                config,
                gameOver,
              );
              if (hint) refs.push(hint);
            }
          }
          const banner = defconBannerText(level, tuning, config);
          refs.push(banner.title);
          if (banner.line) refs.push(banner.line);
          banner.unitKeys.forEach((k) => unitKeys.add(k));
        }
      }
    }
    // Every key and param kind was reached.
    expect(new Set(refs.map((r) => r.key))).toEqual(
      new Set(Object.keys(EXPECTED_PARAMS)),
    );
    for (const ref of refs) {
      const text = message(ref.key);
      expect(typeof text, ref.key).toBe("string");
      // {units} is filled by the caller from the translated unitKeys.
      const given = Object.keys(ref.params ?? {});
      if (ref.key === DEFCON_TEXT_KEYS.nukesReleased) given.push("units");
      expect(icuParams(text as string), ref.key).toEqual(given.sort());
    }
    for (const key of unitKeys) {
      expect(typeof message(key), key).toBe("string");
    }
  });
});
