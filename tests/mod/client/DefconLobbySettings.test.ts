import fs from "fs";
import path from "path";
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
import { MOD_CONFIG } from "../../../src/mod/core/ModConfig";

/**
 * DefconLobbySettings: the "DEFCON on/off" switch in the singleplayer menu and
 * the private host lobby, and its line in the lobby summary other players
 * see. The switch starts on (MOD_CONFIG), only claims its own toggle card,
 * always sends an explicit value (a JSON patch drops undefined), and the
 * summary names it only when DEFCON is off.
 */

const LABEL_KEY = "mod.defcon.lobby_toggle";

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
  "defcon",
  "DEFCON",
];

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

/** en.json as the flat "a.b.c" map LangSelector hands to translateText. */
function flatten(
  node: Record<string, unknown>,
  prefix = "",
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(node)) {
    const full = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") out[full] = value;
    else flatten(value as Record<string, unknown>, full, out);
  }
  return out;
}
const EN_FLAT = flatten(en);

/** The mod part of the real GameConfig schema, as the server parses it. */
const ModPart = GameConfigSchema.pick({ mod: true });

let langSelector: HTMLElement | undefined;

/** Stands in for <lang-selector> with the real English texts. */
function installEnglish(): void {
  langSelector = document.createElement("lang-selector");
  Object.assign(langSelector, {
    translations: EN_FLAT,
    defaultTranslations: EN_FLAT,
    currentLang: "en",
  });
  document.body.appendChild(langSelector);
}

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

afterEach(() => {
  langSelector?.remove();
  langSelector = undefined;
  MOD_CONFIG.defcon.enabled = SHIPPED_DEFAULT;
});

describe("DEFCON_LOBBY_TOGGLE_KEY", () => {
  it("is the translation key of the toggle label", () => {
    expect(DEFCON_LOBBY_TOGGLE_KEY).toBe(LABEL_KEY);
  });
});

describe("defconLobbyDefault", () => {
  it("starts with DEFCON on", () => {
    expect(defconLobbyDefault()).toBe(true);
  });

  it("equals MOD_CONFIG.defcon.enabled", () => {
    expect(defconLobbyDefault()).toBe(MOD_CONFIG.defcon.enabled);
  });

  it("follows MOD_CONFIG when the default changes", () => {
    withDefault(false, () => {
      expect(defconLobbyDefault()).toBe(false);
    });
    expect(defconLobbyDefault()).toBe(true);
  });
});

describe("defconLobbyToggles", () => {
  it.each([true, false])(
    "is one card with our label key, checked = %s",
    (enabled) => {
      expect(defconLobbyToggles(enabled)).toEqual([
        { labelKey: LABEL_KEY, checked: enabled },
      ]);
    },
  );

  it("uses the key the toggle handler reacts to", () => {
    for (const enabled of [true, false]) {
      const [card] = defconLobbyToggles(enabled);
      expect(card.labelKey).toBe(DEFCON_LOBBY_TOGGLE_KEY);
      expect(isDefconLobbyToggle(card.labelKey)).toBe(true);
    }
  });

  it("is never hidden and has no doomsday pace dropdown", () => {
    for (const enabled of [true, false]) {
      const [card] = defconLobbyToggles(enabled);
      expect(card.hidden).toBeUndefined();
      expect(card.doomsdayClockSpeed).toBeUndefined();
    }
  });

  it("does not collide with an upstream toggle card", () => {
    expect(UPSTREAM_TOGGLE_KEYS).not.toContain(
      defconLobbyToggles(true)[0].labelKey,
    );
  });

  it("returns a fresh array each call (the menus spread it into theirs)", () => {
    const a = defconLobbyToggles(true);
    const b = defconLobbyToggles(true);
    expect(a).not.toBe(b);
    a[0].checked = false;
    expect(b[0].checked).toBe(true);
  });
});

describe("isDefconLobbyToggle", () => {
  it("is true for our card", () => {
    expect(isDefconLobbyToggle(LABEL_KEY)).toBe(true);
    expect(isDefconLobbyToggle(DEFCON_LOBBY_TOGGLE_KEY)).toBe(true);
  });

  it.each(UPSTREAM_TOGGLE_KEYS)("is false for the upstream card %s", (key) => {
    expect(isDefconLobbyToggle(key)).toBe(false);
  });

  it.each(NEAR_MISS_KEYS)("is false for the near miss %j", (key) => {
    expect(isDefconLobbyToggle(key)).toBe(false);
  });

  it("claims exactly one of all the known keys", () => {
    const keys = [LABEL_KEY, ...UPSTREAM_TOGGLE_KEYS, ...NEAR_MISS_KEYS];
    expect(keys.filter((key) => isDefconLobbyToggle(key))).toEqual([LABEL_KEY]);
  });
});

describe("defconGameConfig", () => {
  it.each([true, false])("is explicit for enabled = %s", (enabled) => {
    const config = defconGameConfig(enabled);
    expect(config).toEqual({ mod: { defcon: { enabled } } });
    expect(Object.keys(config)).toEqual(["mod"]);
    expect(Object.keys(config.mod!)).toEqual(["defcon"]);
    expect(Object.keys(config.mod!.defcon!)).toEqual(["enabled"]);
  });

  it.each([true, false])(
    "keeps enabled = %s through a JSON round trip",
    (enabled) => {
      const sent = JSON.parse(JSON.stringify(defconGameConfig(enabled)));
      expect(sent).toEqual({ mod: { defcon: { enabled } } });
      expect(sent.mod.defcon).toHaveProperty("enabled", enabled);
    },
  );

  it("must be explicit: JSON drops an undefined switch", () => {
    // What an "only set it when off" config would send when DEFCON is on:
    // the key vanishes and the server keeps the previous value.
    const implicit = { mod: { defcon: { enabled: undefined } } };
    const sent = JSON.parse(JSON.stringify(implicit));
    expect(sent.mod.defcon).not.toHaveProperty("enabled");
  });

  it.each([true, false])(
    "passes the real GameConfig schema after JSON (enabled = %s)",
    (enabled) => {
      const sent = JSON.parse(JSON.stringify(defconGameConfig(enabled)));
      expect(ModPart.parse(sent)).toEqual({ mod: { defcon: { enabled } } });
    },
  );

  it("overrides an earlier value when spread last into a config", () => {
    const base = { mod: { defcon: { enabled: true } } };
    const turnedOff = { ...base, ...defconGameConfig(false) };
    expect(turnedOff.mod?.defcon?.enabled).toBe(false);
    const off = { mod: { defcon: { enabled: false } } };
    const turnedOn = { ...off, ...defconGameConfig(true) };
    expect(turnedOn.mod?.defcon?.enabled).toBe(true);
  });

  it("returns a fresh object each call", () => {
    const a = defconGameConfig(true);
    const b = defconGameConfig(true);
    expect(a).not.toBe(b);
    expect(a.mod).not.toBe(b.mod);
    a.mod!.defcon!.enabled = false;
    expect(b.mod!.defcon!.enabled).toBe(true);
  });
});

describe("defconOptionChanged", () => {
  it("DEFCON on (the default) is no change", () => {
    expect(defconOptionChanged(true)).toBe(false);
  });

  it("DEFCON off counts as a changed option", () => {
    expect(defconOptionChanged(false)).toBe(true);
  });

  it.each([true, false])(
    "equals enabled !== default (enabled = %s)",
    (enabled) => {
      expect(defconOptionChanged(enabled)).toBe(
        enabled !== MOD_CONFIG.defcon.enabled,
      );
    },
  );

  it("measures against the resolved default", () => {
    withDefault(false, () => {
      expect(defconOptionChanged(false)).toBe(false);
      expect(defconOptionChanged(true)).toBe(true);
    });
  });

  it("the default toggle position is never a change", () => {
    const [card] = defconLobbyToggles(defconLobbyDefault());
    expect(defconOptionChanged(card.checked)).toBe(false);
  });
});

describe("defconNotableSettings", () => {
  const OFF = defconGameConfig(false);
  const ON = defconGameConfig(true);

  it("DEFCON off: exactly one line with the English label and value", () => {
    installEnglish();
    expect(defconNotableSettings(OFF)).toEqual([
      { label: "DEFCON", value: "Disabled" },
    ]);
  });

  it("DEFCON off: the label and value are our key and common.disabled", () => {
    installEnglish();
    expect(defconNotableSettings(OFF)).toEqual([
      { label: EN_FLAT[LABEL_KEY], value: EN_FLAT["common.disabled"] },
    ]);
  });

  it("DEFCON off without a <lang-selector>: falls back to the bare keys", () => {
    expect(defconNotableSettings(OFF)).toEqual([
      { label: LABEL_KEY, value: "common.disabled" },
    ]);
  });

  it("DEFCON off after a JSON round trip (what other players receive)", () => {
    installEnglish();
    const received = JSON.parse(JSON.stringify(OFF));
    expect(defconNotableSettings(received)).toEqual([
      { label: "DEFCON", value: "Disabled" },
    ]);
  });

  it("DEFCON off in a full game config", () => {
    installEnglish();
    const config = {
      gameMap: "World",
      disabledUnits: [],
      ...OFF,
    } as Parameters<typeof defconNotableSettings>[0];
    expect(defconNotableSettings(config)).toHaveLength(1);
  });

  it("DEFCON off with lockNukes also set: still exactly one line", () => {
    installEnglish();
    expect(
      defconNotableSettings({
        mod: { defcon: { enabled: false, lockNukes: true } },
      }),
    ).toEqual([{ label: "DEFCON", value: "Disabled" }]);
  });

  it.each([
    ["on", ON],
    ["unset (no mod)", {}],
    ["mod undefined", { mod: undefined }],
    ["mod without defcon", { mod: {} }],
    ["defcon undefined", { mod: { defcon: undefined } }],
    ["defcon without enabled", { mod: { defcon: {} } }],
    ["enabled undefined", { mod: { defcon: { enabled: undefined } } }],
    ["only lockNukes off", { mod: { defcon: { lockNukes: false } } }],
  ])("DEFCON %s: no line", (_name, config) => {
    installEnglish();
    expect(defconNotableSettings(config)).toEqual([]);
  });

  it("unset uses the resolved default", () => {
    installEnglish();
    // Shipped default (on): nothing to show.
    expect(defconNotableSettings({})).toEqual([]);
    expect(defconNotableSettings({ mod: { defcon: {} } })).toEqual([]);
    withDefault(false, () => {
      // Default off: an unset switch means off, so the line shows.
      expect(defconNotableSettings({})).toEqual([
        { label: "DEFCON", value: "Disabled" },
      ]);
      expect(defconNotableSettings({ mod: { defcon: {} } })).toEqual([
        { label: "DEFCON", value: "Disabled" },
      ]);
      // An explicit value still wins over the default.
      expect(defconNotableSettings(ON)).toEqual([]);
      expect(defconNotableSettings(OFF)).toHaveLength(1);
    });
  });

  it("shows exactly when defconOptionChanged is true", () => {
    for (const enabled of [true, false]) {
      expect(defconNotableSettings(defconGameConfig(enabled)).length > 0).toBe(
        defconOptionChanged(enabled),
      );
    }
  });
});

describe("en.json", () => {
  it('has mod.defcon.lobby_toggle = "DEFCON"', () => {
    expect(en.mod.defcon.lobby_toggle).toBe("DEFCON");
    expect(EN_FLAT[LABEL_KEY]).toBe("DEFCON");
  });

  it("the label has no ICU parameters (it is translated without any)", () => {
    expect(EN_FLAT[LABEL_KEY]).not.toContain("{");
  });

  it("has the common.disabled value the summary line uses", () => {
    expect(EN_FLAT["common.disabled"]).toBe("Disabled");
  });
});
