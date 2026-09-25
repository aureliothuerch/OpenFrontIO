import { afterEach, describe, expect, it } from "vitest";
import { GameConfigSchema } from "../../../src/core/Schemas";
import {
  DEFCON_LOBBY_TOGGLE_KEY,
  defconGameConfig,
  defconLobbyDefault,
  defconLobbyToggles,
  defconNotableSettings,
  defconOptionChanged,
  isDefconLobbyToggle,
} from "../../../src/mod/client/defcon/DefconLobbySettings";
import type { ModLobbyState } from "../../../src/mod/client/ModLobbySettings";
import * as ModLobby from "../../../src/mod/client/ModLobbySettings";
import { MOD_CONFIG } from "../../../src/mod/core/ModConfig";

/**
 * ModLobbySettings: the feature-neutral layer behind the MOD hooks in
 * SinglePlayerModal, HostLobbyModal and LobbySettingsSummary. It holds every
 * mod lobby setting in one immutable ModLobbyState and hands each question to
 * the feature (today only DEFCON's switch). These tests pin its contract: the
 * state is replaced, never mutated; only our cards are claimed; the config
 * block is always explicit; and every answer matches DEFCON's own module.
 */

// Pinned as a literal so a renamed constant cannot drift from en.json.
const DEFCON_KEY = "mod.defcon.lobby_toggle";

/** Every toggle card the upstream menus handle themselves. */
const UPSTREAM_TOGGLE_KEYS = [
  "game_settings.bots",
  "game_settings.compact_map",
  "game_settings.doomsday_clock",
  "game_settings.infinite_gold",
  "game_settings.infinite_troops",
  "game_settings.instant_build",
  "game_settings.nations",
  "game_settings.random_spawn",
  "game_settings.water_nukes",
  "host_modal.anonymous_players",
  "host_modal.donate_gold",
  "host_modal.donate_troops",
  "host_modal.host_cheats",
];

/** Keys that look like ours but are not. */
const NEAR_MISS_KEYS = [
  "",
  "mod",
  "mod.defcon",
  "mod.defcon.lobby",
  "mod.defcon.lobby_toggle.",
  " mod.defcon.lobby_toggle",
  "mod.defcon.lobby_toggle ",
  "MOD.DEFCON.LOBBY_TOGGLE",
  "mod.defcon.something_else",
  "defcon",
  "DEFCON",
];

const NOT_OURS = [...UPSTREAM_TOGGLE_KEYS, ...NEAR_MISS_KEYS];

const ON: ModLobbyState = { defconEnabled: true };
const OFF: ModLobbyState = { defconEnabled: false };

/** The mod part of the real GameConfig schema, as the server parses it. */
const ModPart = GameConfigSchema.pick({ mod: true });

const SHIPPED_DEFAULT = MOD_CONFIG.defcon.enabled;

/** Runs `fn` with a different MOD_CONFIG default, then restores it. */
function withDefault(enabled: boolean, fn: () => void): void {
  MOD_CONFIG.defcon.enabled = enabled;
  try {
    fn();
  } finally {
    MOD_CONFIG.defcon.enabled = SHIPPED_DEFAULT;
  }
}

/** A frozen copy, so any mutation by the code under test throws. */
function frozen(state: ModLobbyState): ModLobbyState {
  return Object.freeze({ ...state });
}

afterEach(() => {
  MOD_CONFIG.defcon.enabled = SHIPPED_DEFAULT;
});

describe("defaults", () => {
  it("starts with DEFCON on", () => {
    expect(ModLobby.defaults()).toEqual({ defconEnabled: true });
  });

  it("holds exactly the known settings, nothing else", () => {
    expect(Object.keys(ModLobby.defaults())).toEqual(["defconEnabled"]);
  });

  it("takes DEFCON's default from DefconLobbySettings / MOD_CONFIG", () => {
    expect(ModLobby.defaults().defconEnabled).toBe(defconLobbyDefault());
    withDefault(false, () => {
      expect(ModLobby.defaults()).toEqual({ defconEnabled: false });
    });
    expect(ModLobby.defaults()).toEqual({ defconEnabled: true });
  });

  it("returns a fresh object each call (a reset never shares state)", () => {
    const a = ModLobby.defaults();
    const b = ModLobby.defaults();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("is no changed option", () => {
    expect(ModLobby.optionsChanged(ModLobby.defaults())).toBe(false);
  });
});

describe("toggles", () => {
  it.each([true, false])(
    "is exactly DEFCON's card, checked = %s",
    (defconEnabled) => {
      expect(ModLobby.toggles({ defconEnabled })).toEqual([
        { labelKey: DEFCON_KEY, checked: defconEnabled },
      ]);
      expect(ModLobby.toggles({ defconEnabled })).toEqual(
        defconLobbyToggles(defconEnabled),
      );
    },
  );

  it("every card it hands out is claimed by isToggle", () => {
    for (const state of [ON, OFF]) {
      for (const card of ModLobby.toggles(state)) {
        expect(ModLobby.isToggle(card.labelKey)).toBe(true);
      }
    }
  });

  it("never collides with an upstream toggle card", () => {
    for (const card of ModLobby.toggles(ON)) {
      expect(UPSTREAM_TOGGLE_KEYS).not.toContain(card.labelKey);
    }
  });

  it("has unique label keys", () => {
    const keys = ModLobby.toggles(ON).map((c) => c.labelKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns a fresh array each call (the menus spread it into theirs)", () => {
    const a = ModLobby.toggles(ON);
    const b = ModLobby.toggles(ON);
    expect(a).not.toBe(b);
    a[0].checked = false;
    expect(b[0].checked).toBe(true);
  });

  it("does not mutate the state", () => {
    const state = frozen(OFF);
    expect(() => ModLobby.toggles(state)).not.toThrow();
    expect(state).toEqual(OFF);
  });
});

describe("isToggle", () => {
  it("is true for the DEFCON card", () => {
    expect(ModLobby.isToggle(DEFCON_KEY)).toBe(true);
    expect(ModLobby.isToggle(DEFCON_LOBBY_TOGGLE_KEY)).toBe(true);
  });

  it.each(UPSTREAM_TOGGLE_KEYS)("is false for the upstream card %s", (key) => {
    expect(ModLobby.isToggle(key)).toBe(false);
  });

  it.each(NEAR_MISS_KEYS)("is false for the near miss %j", (key) => {
    expect(ModLobby.isToggle(key)).toBe(false);
  });

  it("agrees with isDefconLobbyToggle on every key", () => {
    for (const key of [DEFCON_KEY, ...NOT_OURS]) {
      expect(ModLobby.isToggle(key), key).toBe(isDefconLobbyToggle(key));
    }
  });
});

describe("toggled", () => {
  it.each([
    [ON, false],
    [ON, true],
    [OFF, true],
    [OFF, false],
  ])(
    "our card on %j with checked = %s: a NEW state with that value",
    (before, checked) => {
      const state = frozen(before);
      const after = ModLobby.toggled(state, DEFCON_KEY, checked);
      expect(after).not.toBe(state);
      expect(after).toEqual({ defconEnabled: checked });
      // The old state is untouched (Lit compares by identity).
      expect(state).toEqual(before);
    },
  );

  it.each(NOT_OURS)(
    "any other card (%j): the IDENTICAL state object",
    (key) => {
      for (const before of [ON, OFF]) {
        const state = frozen(before);
        for (const checked of [true, false]) {
          expect(ModLobby.toggled(state, key, checked)).toBe(state);
        }
        expect(state).toEqual(before);
      }
    },
  );

  it("keeps the other fields of the state (a later feature's setting)", () => {
    // A future feature adds a field; switching DEFCON must not drop it.
    const withMore = Object.freeze({
      defconEnabled: true,
      later: 7,
    }) as unknown as ModLobbyState;
    expect(ModLobby.toggled(withMore, DEFCON_KEY, false)).toEqual({
      defconEnabled: false,
      later: 7,
    });
  });

  it("is what a click on the rendered card produces (off, then on again)", () => {
    // <game-config-settings> sends the card's key with !checked.
    let state = ModLobby.defaults();
    for (const expected of [false, true, false]) {
      const [card] = ModLobby.toggles(state);
      expect(ModLobby.isToggle(card.labelKey)).toBe(true);
      state = ModLobby.toggled(state, card.labelKey, !card.checked);
      expect(state.defconEnabled).toBe(expected);
      expect(ModLobby.toggles(state)[0].checked).toBe(expected);
    }
  });
});

describe("gameConfig", () => {
  it.each([true, false])(
    "is explicit for defconEnabled = %s",
    (defconEnabled) => {
      const config = ModLobby.gameConfig({ defconEnabled });
      expect(config).toEqual({ mod: { defcon: { enabled: defconEnabled } } });
      expect(Object.keys(config)).toEqual(["mod"]);
      expect(Object.keys(config.mod)).toEqual(["defcon"]);
      expect(Object.keys(config.mod.defcon!)).toEqual(["enabled"]);
    },
  );

  it.each([true, false])(
    "equals DEFCON's own config part (defconEnabled = %s)",
    (defconEnabled) => {
      expect(ModLobby.gameConfig({ defconEnabled })).toEqual(
        defconGameConfig(defconEnabled),
      );
    },
  );

  it.each([true, false])(
    "keeps defconEnabled = %s through a JSON round trip",
    (defconEnabled) => {
      const sent = JSON.parse(
        JSON.stringify(ModLobby.gameConfig({ defconEnabled })),
      );
      expect(sent).toEqual({ mod: { defcon: { enabled: defconEnabled } } });
      expect(sent.mod.defcon).toHaveProperty("enabled", defconEnabled);
    },
  );

  it.each([true, false])(
    "passes the real GameConfig schema after JSON (defconEnabled = %s)",
    (defconEnabled) => {
      const sent = JSON.parse(
        JSON.stringify(ModLobby.gameConfig({ defconEnabled })),
      );
      expect(ModPart.parse(sent)).toEqual({
        mod: { defcon: { enabled: defconEnabled } },
      });
    },
  );

  it("the defaults send DEFCON on explicitly", () => {
    const sent = JSON.parse(
      JSON.stringify(ModLobby.gameConfig(ModLobby.defaults())),
    );
    expect(sent).toEqual({ mod: { defcon: { enabled: true } } });
  });

  it("overrides an earlier mod block when spread into a config", () => {
    const base = { bots: 5, mod: { defcon: { enabled: true } } };
    expect({ ...base, ...ModLobby.gameConfig(OFF) }).toEqual({
      bots: 5,
      mod: { defcon: { enabled: false } },
    });
  });

  it("returns fresh objects each call", () => {
    const a = ModLobby.gameConfig(ON);
    const b = ModLobby.gameConfig(ON);
    expect(a).not.toBe(b);
    expect(a.mod).not.toBe(b.mod);
    a.mod.defcon!.enabled = false;
    expect(b.mod.defcon!.enabled).toBe(true);
    expect(ModLobby.gameConfig(ON).mod.defcon!.enabled).toBe(true);
  });

  it("does not mutate the state", () => {
    const state = frozen(OFF);
    expect(() => ModLobby.gameConfig(state)).not.toThrow();
    expect(state).toEqual(OFF);
  });
});

describe("optionsChanged", () => {
  it("DEFCON on (the default) is no change", () => {
    expect(ModLobby.optionsChanged(ON)).toBe(false);
  });

  it("DEFCON off counts as a changed option", () => {
    expect(ModLobby.optionsChanged(OFF)).toBe(true);
  });

  it("agrees with defconOptionChanged", () => {
    for (const state of [ON, OFF]) {
      expect(ModLobby.optionsChanged(state)).toBe(
        defconOptionChanged(state.defconEnabled),
      );
    }
  });

  it("measures against the resolved default", () => {
    withDefault(false, () => {
      expect(ModLobby.optionsChanged(OFF)).toBe(false);
      expect(ModLobby.optionsChanged(ON)).toBe(true);
      expect(ModLobby.optionsChanged(ModLobby.defaults())).toBe(false);
    });
  });
});

describe("notableSettings", () => {
  // translateText returns the key itself in tests (no <lang-selector>).
  const DEFCON_LINE = { label: DEFCON_KEY, value: "common.disabled" };

  it("DEFCON off: exactly DEFCON's line", () => {
    expect(
      ModLobby.notableSettings({ mod: { defcon: { enabled: false } } }),
    ).toEqual([DEFCON_LINE]);
  });

  it.each([
    ["on", { mod: { defcon: { enabled: true } } }],
    ["unset (no mod)", {}],
    ["mod undefined", { mod: undefined }],
    ["mod without defcon", { mod: {} }],
    ["defcon without enabled", { mod: { defcon: {} } }],
    ["only lockNukes off", { mod: { defcon: { lockNukes: false } } }],
  ])("DEFCON %s: no line", (_name, config) => {
    expect(ModLobby.notableSettings(config)).toEqual([]);
  });

  it.each([
    ["off", { mod: { defcon: { enabled: false } } }],
    [
      "off with lockNukes",
      { mod: { defcon: { enabled: false, lockNukes: true } } },
    ],
    ["on", { mod: { defcon: { enabled: true } } }],
    ["unset", {}],
    ["empty mod", { mod: {} }],
  ])("delegates to defconNotableSettings (%s)", (_name, config) => {
    expect(ModLobby.notableSettings(config)).toEqual(
      defconNotableSettings(config),
    );
    withDefault(false, () => {
      expect(ModLobby.notableSettings(config)).toEqual(
        defconNotableSettings(config),
      );
    });
  });

  it("reads what gameConfig sends, also after the JSON wire", () => {
    for (const state of [ON, OFF]) {
      const received = JSON.parse(JSON.stringify(ModLobby.gameConfig(state)));
      expect(ModLobby.notableSettings(received).length > 0).toBe(
        ModLobby.optionsChanged(state),
      );
    }
  });

  it("returns a fresh array each call (the summary spreads it)", () => {
    const off = { mod: { defcon: { enabled: false } } };
    const a = ModLobby.notableSettings(off);
    const b = ModLobby.notableSettings(off);
    expect(a).not.toBe(b);
    a.length = 0;
    expect(b).toEqual([DEFCON_LINE]);
  });
});
