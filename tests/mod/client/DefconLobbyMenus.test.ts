import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The "DEFCON on/off" switch as the menus use it: the singleplayer modal and
 * the private host lobby (MOD hooks in SinglePlayerModal / HostLobbyModal),
 * and the line other players see in the lobby summary (MOD hook in
 * LobbySettingsSummary, shown by JoinLobbyModal). Everything runs through the
 * real handlers and the real start / putGameConfig paths; only the network,
 * ads and the desktop bridge are stubbed.
 */

// The desktop bridge is absent in jsdom; mocked like HostLobbyModal.test.ts.
vi.mock("../../../src/client/DesktopPresence", () => ({
  desktopPresence: {
    isAvailable: vi.fn(() => false),
    openInviteDialog: vi.fn(async () => true),
    set: vi.fn(),
    consumePendingInvite: vi.fn(async () => null),
    subscribeInvites: vi.fn(() => () => undefined),
  },
}));

vi.mock("../../../src/client/Cosmetics", () => ({
  getPlayerCosmetics: vi.fn(async () => ({})),
}));

vi.mock("../../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    isOnCrazyGames: vi.fn(() => false),
    requestMidgameAd: vi.fn(async () => {}),
    createInviteLink: vi.fn(() => null),
    showInviteButton: vi.fn(),
    hideInviteButton: vi.fn(),
    getUserProfile: vi.fn(async () => null),
    showAuthPrompt: vi.fn(async () => null),
  },
}));

// No map files in jsdom: every map has zero nations, so the nation slider
// and its default agree and never count as a changed option.
vi.mock("../../../src/client/TerrainMapFileLoader", () => ({
  terrainMapFileLoader: {
    getMapData: vi.fn(() => ({
      manifest: async () => ({ nations: [] }),
    })),
  },
}));

// jsdom has no IntersectionObserver; the map cards of a mounted menu create
// one on connect. A no-op is enough: no test here scrolls the map list.
class NoopIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);

// Side-effect import so <single-player-modal> registers (a type-only import
// would be elided and createElement would return an inert element).
import "../../../src/client/SinglePlayerModal";

import { ClientEnv } from "../../../src/client/ClientEnv";
import type { GameConfigSettings } from "../../../src/client/components/GameConfigSettings";
import { HostLobbyModal } from "../../../src/client/HostLobbyModal";
import { JoinLobbyModal } from "../../../src/client/JoinLobbyModal";
import { notableLobbySettings } from "../../../src/client/utilities/LobbySettingsSummary";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../../src/core/game/Game";
import {
  GameConfigSchema,
  LobbyInfoEvent,
  type GameConfig,
  type PublicGameInfo,
} from "../../../src/core/Schemas";
import { DEFCON_LOBBY_TOGGLE_KEY } from "../../../src/mod/client/defcon/DefconLobbySettings";

// The key the menus and en.json use. Pinned as a literal so a renamed
// constant cannot silently drift away from the translation entry.
const DEFCON_KEY = "mod.defcon.lobby_toggle";
// translateText returns the key itself in tests (no <lang-selector>).
const DEFCON_LINE = { label: DEFCON_KEY, value: "common.disabled" };

// Upstream option toggles of each menu. Toggling any of them must leave the
// DEFCON switch alone.
const SINGLEPLAYER_UPSTREAM_TOGGLES = [
  "game_settings.instant_build",
  "game_settings.random_spawn",
  "game_settings.infinite_gold",
  "game_settings.infinite_troops",
  "game_settings.compact_map",
  "game_settings.water_nukes",
  "game_settings.doomsday_clock",
];
const HOST_UPSTREAM_TOGGLES = [
  "game_settings.instant_build",
  "game_settings.random_spawn",
  "host_modal.donate_gold",
  "host_modal.donate_troops",
  "game_settings.infinite_gold",
  "game_settings.infinite_troops",
  "game_settings.compact_map",
  "host_modal.anonymous_players",
  "game_settings.water_nukes",
  "game_settings.doomsday_clock",
  "host_modal.host_cheats",
];

interface ToggleConfig {
  labelKey: string;
  checked: boolean;
  doomsdayClockSpeed?: string;
}

/** What <game-config-settings> sends when a toggle card is clicked. */
function toggle(modal: any, labelKey: string, checked: boolean): void {
  modal.handleConfigOptionToggleChanged(
    new CustomEvent("option-toggle-changed", {
      detail: { labelKey, checked },
    }),
  );
}

/** The option toggles the modal hands to its <game-config-settings>. */
function renderedToggles(modal: any): ToggleConfig[] {
  const container = document.createElement("div");
  render(modal.render(), container);
  const settings = container.querySelector(
    "game-config-settings",
  ) as GameConfigSettings | null;
  expect(settings).not.toBeNull();
  return settings!.settings!.options.toggles;
}

function defconToggles(toggles: ToggleConfig[]): ToggleConfig[] {
  return toggles.filter((t) => t.labelKey === DEFCON_KEY);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DEFCON toggle key", () => {
  it("is the translation key the menus render", () => {
    expect(DEFCON_LOBBY_TOGGLE_KEY).toBe(DEFCON_KEY);
  });
});

describe("DEFCON switch in the singleplayer menu", () => {
  function spModal(): any {
    return document.createElement("single-player-modal") as any;
  }

  /** Runs the real Start path and returns the join-lobby config. */
  async function startConfig(modal: any): Promise<GameConfig> {
    const events: any[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent).detail);
    modal.addEventListener("join-lobby", listener);
    try {
      await modal.startGame();
    } finally {
      modal.removeEventListener("join-lobby", listener);
    }
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("singleplayer");
    return events[0].gameStartInfo.config;
  }

  it("starts with DEFCON on by default, explicitly in the config", async () => {
    const modal = spModal();
    expect(modal.modLobby.defconEnabled).toBe(true);
    expect(modal.hasOptionsChanged()).toBe(false);

    const config = await startConfig(modal);

    expect(config.mod).toEqual({ defcon: { enabled: true } });
    // The worker parses the config: the mod part must survive the schema.
    const parsed = GameConfigSchema.safeParse(config);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.mod).toEqual({ defcon: { enabled: true } });
  });

  it("switching DEFCON off starts a game without DEFCON and counts as a changed option", async () => {
    const modal = spModal();

    toggle(modal, DEFCON_KEY, false);

    expect(modal.modLobby.defconEnabled).toBe(false);
    expect(modal.hasOptionsChanged()).toBe(true);
    const config = await startConfig(modal);
    expect(config.mod).toEqual({ defcon: { enabled: false } });
    expect(GameConfigSchema.safeParse(config).data?.mod).toEqual({
      defcon: { enabled: false },
    });
  });

  it("switching DEFCON back on restores the default start and the unchanged-options state", async () => {
    const modal = spModal();

    toggle(modal, DEFCON_KEY, false);
    toggle(modal, DEFCON_KEY, true);

    expect(modal.modLobby.defconEnabled).toBe(true);
    expect(modal.hasOptionsChanged()).toBe(false);
    const config = await startConfig(modal);
    expect(config.mod).toEqual({ defcon: { enabled: true } });
  });

  it("DEFCON off only changes the mod part of the start config", async () => {
    const on = await startConfig(spModal());
    const offModal = spModal();
    toggle(offModal, DEFCON_KEY, false);
    const off = await startConfig(offModal);

    expect({ ...off, mod: undefined }).toEqual({ ...on, mod: undefined });
  });

  it("closing the modal resets DEFCON to on", () => {
    const modal = spModal();
    toggle(modal, DEFCON_KEY, false);

    modal.onClose();

    expect(modal.modLobby.defconEnabled).toBe(true);
    expect(modal.hasOptionsChanged()).toBe(false);
  });

  it("resetOptions (tutorial path) resets DEFCON to on", () => {
    const modal = spModal();
    toggle(modal, DEFCON_KEY, false);

    modal.resetOptions();

    expect(modal.modLobby.defconEnabled).toBe(true);
  });

  it("the next game after a game without DEFCON starts with DEFCON on again", async () => {
    const modal = spModal();
    toggle(modal, DEFCON_KEY, false);

    // startGame closes the modal after dispatching, which resets the options.
    expect((await startConfig(modal)).mod).toEqual({
      defcon: { enabled: false },
    });
    expect(modal.modLobby.defconEnabled).toBe(true);
    expect((await startConfig(modal)).mod).toEqual({
      defcon: { enabled: true },
    });
  });

  it("hands the DEFCON toggle to <game-config-settings> exactly once, with the current state", () => {
    const modal = spModal();

    const before = renderedToggles(modal);
    expect(defconToggles(before)).toEqual([
      { labelKey: DEFCON_KEY, checked: true },
    ]);

    toggle(modal, DEFCON_KEY, false);
    expect(defconToggles(renderedToggles(modal))).toEqual([
      { labelKey: DEFCON_KEY, checked: false },
    ]);
  });

  it("puts the DEFCON card between water nukes and doomsday clock, upstream order unchanged", () => {
    for (const defcon of [true, false]) {
      const modal = spModal();
      toggle(modal, DEFCON_KEY, defcon);

      const toggles = renderedToggles(modal);
      const keys = toggles.map((t) => t.labelKey);
      // Without our card, exactly the upstream toggles in upstream order.
      expect(keys.filter((k) => k !== DEFCON_KEY)).toEqual(
        SINGLEPLAYER_UPSTREAM_TOGGLES,
      );
      const at = keys.indexOf(DEFCON_KEY);
      expect(keys[at - 1]).toBe("game_settings.water_nukes");
      expect(keys[at + 1]).toBe("game_settings.doomsday_clock");
      // The doomsday card after ours keeps its pace dropdown; ours has none.
      expect(toggles[at + 1].doomsdayClockSpeed).toBeDefined();
      expect(toggles[at].doomsdayClockSpeed).toBeUndefined();
    }
  });

  it("clicking the rendered DEFCON card switches DEFCON off and on", async () => {
    const modal = spModal();
    document.body.appendChild(modal);
    await modal.updateComplete;
    const settings = modal.querySelector(
      "game-config-settings",
    ) as GameConfigSettings;
    await settings.updateComplete;

    const defconButton = () =>
      [...settings.querySelectorAll("button")].filter(
        (b) => b.textContent?.trim() === DEFCON_KEY,
      );
    expect(defconButton()).toHaveLength(1);

    defconButton()[0].click();
    expect(modal.modLobby.defconEnabled).toBe(false);

    await modal.updateComplete;
    await settings.updateComplete;
    defconButton()[0].click();
    expect(modal.modLobby.defconEnabled).toBe(true);
  });

  it("upstream toggles still work and never touch DEFCON", async () => {
    for (const defcon of [true, false]) {
      for (const key of SINGLEPLAYER_UPSTREAM_TOGGLES) {
        const modal = spModal();
        toggle(modal, DEFCON_KEY, defcon);
        toggle(modal, key, true);
        expect(modal.modLobby.defconEnabled).toBe(defcon);
      }
    }

    const modal = spModal();
    toggle(modal, "game_settings.water_nukes", true);
    expect(modal.waterNukes).toBe(true);
    expect(modal.modLobby.defconEnabled).toBe(true);
    const config = await startConfig(modal);
    expect(config.waterNukes).toBe(true);
    expect(config.mod).toEqual({ defcon: { enabled: true } });
  });

  it("an unknown toggle key changes nothing", () => {
    const modal = spModal();
    toggle(modal, DEFCON_KEY, false);

    toggle(modal, "mod.defcon.something_else", true);
    toggle(modal, "unknown_key", true);

    expect(modal.modLobby.defconEnabled).toBe(false);
  });

  it("replaces modLobby on a DEFCON click (never mutates it) and keeps it on any other click", () => {
    const modal = spModal();
    const initial = modal.modLobby;

    toggle(modal, DEFCON_KEY, false);
    const off = modal.modLobby;
    expect(off).not.toBe(initial);
    expect(initial).toEqual({ defconEnabled: true });
    expect(off).toEqual({ defconEnabled: false });

    for (const key of [...SINGLEPLAYER_UPSTREAM_TOGGLES, "unknown_key"]) {
      toggle(modal, key, true);
      expect(modal.modLobby, key).toBe(off);
    }
  });
});

describe("DEFCON switch in the private host lobby", () => {
  function hostModal(): any {
    return new HostLobbyModal() as any;
  }

  /** Replaces putGameConfig with a counter (no network, no URL). */
  function stubPut(modal: any) {
    const put = vi.fn(async () => {});
    modal.putGameConfig = put;
    return put;
  }

  /**
   * Keeps the REAL putGameConfig, but records its promises so a test can
   * await every push the handlers fired and forgotten.
   */
  function trackRealPut(modal: any): Promise<void>[] {
    // The lobby URL only feeds history.replaceState; jsdom has no
    // BOOTSTRAP_CONFIG to build the worker path from.
    vi.spyOn(ClientEnv, "gamePath").mockReturnValue("/game/ABCD1234");
    vi.spyOn(history, "replaceState").mockImplementation(() => undefined);
    const real = modal.putGameConfig.bind(modal);
    const pending: Promise<void>[] = [];
    modal.putGameConfig = () => {
      const p = real();
      pending.push(p);
      return p;
    };
    return pending;
  }

  function captureConfigs(target: EventTarget): Partial<GameConfig>[] {
    const configs: Partial<GameConfig>[] = [];
    target.addEventListener("update-game-config", (e) =>
      configs.push((e as CustomEvent).detail.config),
    );
    return configs;
  }

  it("starts with DEFCON on", () => {
    expect(hostModal().modLobby.defconEnabled).toBe(true);
  });

  it("switching DEFCON off updates the state and pushes the config once", () => {
    const modal = hostModal();
    const put = stubPut(modal);

    toggle(modal, DEFCON_KEY, false);

    expect(modal.modLobby.defconEnabled).toBe(false);
    expect(put).toHaveBeenCalledOnce();

    toggle(modal, DEFCON_KEY, true);
    expect(modal.modLobby.defconEnabled).toBe(true);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("the real putGameConfig sends mod.defcon.enabled explicitly, off and on", async () => {
    const modal = hostModal();
    const pending = trackRealPut(modal);
    const configs = captureConfigs(modal);

    toggle(modal, DEFCON_KEY, false);
    await Promise.all(pending);
    toggle(modal, DEFCON_KEY, true);
    await Promise.all(pending);

    expect(pending).toHaveLength(2);
    expect(configs).toHaveLength(2);
    expect(configs[0].mod).toEqual({ defcon: { enabled: false } });
    expect(configs[1].mod).toEqual({ defcon: { enabled: true } });
  });

  it("the default config push carries DEFCON on explicitly", async () => {
    const modal = hostModal();
    trackRealPut(modal);
    const configs = captureConfigs(modal);

    await modal.putGameConfig();

    expect(configs).toHaveLength(1);
    expect(configs[0].mod).toEqual({ defcon: { enabled: true } });
  });

  it("the pushed value survives the JSON wire and the update_game_config schema", async () => {
    const modal = hostModal();
    const pending = trackRealPut(modal);
    const configs = captureConfigs(modal);

    toggle(modal, DEFCON_KEY, false);
    await Promise.all(pending);

    const wire = JSON.parse(JSON.stringify(configs[0]));
    expect(wire.mod).toEqual({ defcon: { enabled: false } });
    const parsed = GameConfigSchema.partial().safeParse(wire);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.mod).toEqual({ defcon: { enabled: false } });
  });

  it("the update-game-config event reaches the document listener (Main)", async () => {
    const modal = hostModal();
    document.body.appendChild(modal);
    const pending = trackRealPut(modal);
    const configs: Partial<GameConfig>[] = [];
    const listener = (e: Event) =>
      configs.push((e as CustomEvent).detail.config);
    document.addEventListener("update-game-config", listener);
    try {
      toggle(modal, DEFCON_KEY, false);
      await Promise.all(pending);
    } finally {
      document.removeEventListener("update-game-config", listener);
    }

    expect(configs).toHaveLength(1);
    expect(configs[0].mod).toEqual({ defcon: { enabled: false } });
  });

  it("switching DEFCON changes nothing else in the pushed config", async () => {
    const modal = hostModal();
    const pending = trackRealPut(modal);
    const configs = captureConfigs(modal);

    await modal.putGameConfig();
    toggle(modal, DEFCON_KEY, false);
    await Promise.all(pending);

    expect(configs).toHaveLength(2);
    expect({ ...configs[1], mod: undefined }).toEqual({
      ...configs[0],
      mod: undefined,
    });
  });

  it("upstream toggles push once and never touch DEFCON", () => {
    for (const defcon of [true, false]) {
      for (const key of HOST_UPSTREAM_TOGGLES) {
        const modal = hostModal();
        modal.modLobby = { defconEnabled: defcon };
        const put = stubPut(modal);

        toggle(modal, key, true);

        expect(put, key).toHaveBeenCalledOnce();
        expect(modal.modLobby.defconEnabled, key).toBe(defcon);
      }
    }

    const modal = hostModal();
    const put = stubPut(modal);
    toggle(modal, "game_settings.water_nukes", true);
    expect(modal.waterNukes).toBe(true);
    expect(modal.modLobby.defconEnabled).toBe(true);
    expect(put).toHaveBeenCalledOnce();
  });

  it("an unknown toggle key pushes nothing and leaves DEFCON alone", () => {
    const modal = hostModal();
    modal.modLobby = { defconEnabled: false };
    const put = stubPut(modal);

    toggle(modal, "mod.defcon.something_else", true);
    toggle(modal, "unknown_key", true);

    expect(put).not.toHaveBeenCalled();
    expect(modal.modLobby.defconEnabled).toBe(false);
  });

  it("replaces modLobby on a DEFCON click (never mutates it) and keeps it on any other click", () => {
    const modal = hostModal();
    stubPut(modal);
    const initial = modal.modLobby;

    toggle(modal, DEFCON_KEY, false);
    const off = modal.modLobby;
    expect(off).not.toBe(initial);
    expect(initial).toEqual({ defconEnabled: true });
    expect(off).toEqual({ defconEnabled: false });

    for (const key of [...HOST_UPSTREAM_TOGGLES, "unknown_key"]) {
      toggle(modal, key, true);
      expect(modal.modLobby, key).toBe(off);
    }
  });

  it("closing the lobby resets DEFCON to on", () => {
    const modal = hostModal();
    stubPut(modal);
    vi.spyOn(history, "replaceState").mockImplementation(() => undefined);
    toggle(modal, DEFCON_KEY, false);

    modal.onClose();

    expect(modal.modLobby.defconEnabled).toBe(true);
  });

  it("hands the DEFCON toggle to <game-config-settings> between water nukes and doomsday clock, upstream order unchanged", () => {
    const modal = hostModal();

    const toggles = renderedToggles(modal);
    expect(defconToggles(toggles)).toEqual([
      { labelKey: DEFCON_KEY, checked: true },
    ]);
    const keys = toggles.map((t) => t.labelKey);
    // Without our card, exactly the upstream toggles in upstream order.
    expect(keys.filter((k) => k !== DEFCON_KEY)).toEqual(HOST_UPSTREAM_TOGGLES);
    const at = keys.indexOf(DEFCON_KEY);
    expect(keys[at - 1]).toBe("game_settings.water_nukes");
    expect(keys[at + 1]).toBe("game_settings.doomsday_clock");
    expect(keys.indexOf(DEFCON_KEY)).toBeLessThan(
      keys.indexOf("host_modal.host_cheats"),
    );
    // The doomsday card after ours keeps its pace dropdown; ours has none.
    expect(toggles[at + 1].doomsdayClockSpeed).toBeDefined();
    expect(toggles[at].doomsdayClockSpeed).toBeUndefined();

    stubPut(modal);
    toggle(modal, DEFCON_KEY, false);
    expect(defconToggles(renderedToggles(modal))).toEqual([
      { labelKey: DEFCON_KEY, checked: false },
    ]);
  });

  it("a publicly listed lobby keeps showing the switch, frozen with the other settings", () => {
    const modal = hostModal();
    modal.publiclyListed = true;
    modal.modLobby = { defconEnabled: false };

    const container = document.createElement("div");
    render(modal.render(), container);
    const settings = container.querySelector(
      "game-config-settings",
    ) as GameConfigSettings;

    expect(settings.hasAttribute("inert")).toBe(true);
    const keys = settings.settings!.options.toggles.map((t) => t.labelKey);
    // Host cheats disappear while listed; DEFCON stays visible (read-only).
    expect(keys).not.toContain("host_modal.host_cheats");
    expect(defconToggles(settings.settings!.options.toggles)).toEqual([
      { labelKey: DEFCON_KEY, checked: false },
    ]);
    // Same place as in an unlisted lobby.
    expect(keys.filter((k) => k !== DEFCON_KEY)).toEqual(
      HOST_UPSTREAM_TOGGLES.filter((k) => k !== "host_modal.host_cheats"),
    );
    const at = keys.indexOf(DEFCON_KEY);
    expect(keys[at - 1]).toBe("game_settings.water_nukes");
    expect(keys[at + 1]).toBe("game_settings.doomsday_clock");
  });
});

describe("DEFCON line in the lobby settings summary", () => {
  function lobbyConfig(overrides: Partial<GameConfig> = {}): GameConfig {
    return {
      gameMap: GameMapType.World,
      difficulty: Difficulty.Easy,
      donateGold: false,
      donateTroops: false,
      gameType: GameType.Private,
      gameMode: GameMode.FFA,
      gameMapSize: GameMapSize.Normal,
      nations: "default",
      bots: 400,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      disabledUnits: [],
      randomSpawn: false,
      ...overrides,
    };
  }

  const OFF = { mod: { defcon: { enabled: false } } };
  const ON = { mod: { defcon: { enabled: true } } };

  function defconLines(items: { label: string; value: string }[]) {
    return items.filter((i) => i.label === DEFCON_KEY);
  }

  it("lists DEFCON as disabled exactly once when the host switched it off", () => {
    expect(notableLobbySettings(lobbyConfig(OFF), null)).toEqual([DEFCON_LINE]);
  });

  it("lists nothing for DEFCON when it is on or unset", () => {
    expect(notableLobbySettings(lobbyConfig(ON), null)).toEqual([]);
    expect(notableLobbySettings(lobbyConfig(), null)).toEqual([]);
    expect(notableLobbySettings(lobbyConfig({ mod: {} }), null)).toEqual([]);
    expect(
      notableLobbySettings(lobbyConfig({ mod: { defcon: {} } }), null),
    ).toEqual([]);
  });

  // Summary labels are the bare keys in tests (no <lang-selector>).
  const WATER_NUKES_LINE = "game_settings.water_nukes";
  const DOOMSDAY_LINE = "game_settings.doomsday_clock";
  const OVERTIME_LINE = "overtime.title";
  const ANONYMOUS_LINE = "host_modal.anonymous_players";
  const BOTS_LINE = "game_settings.bots";
  const INFINITE_GOLD_LINE = "game_settings.infinite_gold";

  const DOOMSDAY_ON = { enabled: true, speed: "fast" as const };
  const OVERTIME_ON = { enabled: true, startMinutes: 20 };

  // Upstream lines on both sides of the hook: before doomsday (infinite
  // gold, water nukes) and after overtime (anonymous, bots, nations).
  const BUSY: Partial<GameConfig> = {
    waterNukes: true,
    infiniteGold: true,
    anonymizeNames: true,
    bots: 50,
    nations: "disabled",
  };

  it.each<
    [string, Partial<GameConfig>, string | undefined, string | undefined]
  >([
    [
      "doomsday and overtime on",
      { ...BUSY, doomsdayClock: DOOMSDAY_ON, overtime: OVERTIME_ON },
      DOOMSDAY_LINE,
      OVERTIME_LINE,
    ],
    [
      "doomsday on, overtime off",
      { ...BUSY, doomsdayClock: DOOMSDAY_ON, overtime: { enabled: false } },
      DOOMSDAY_LINE,
      ANONYMOUS_LINE,
    ],
    [
      "doomsday off, overtime on",
      { ...BUSY, doomsdayClock: { enabled: false }, overtime: OVERTIME_ON },
      WATER_NUKES_LINE,
      OVERTIME_LINE,
    ],
    ["doomsday and overtime off", BUSY, WATER_NUKES_LINE, ANONYMOUS_LINE],
    ["only lines after the hook", { bots: 50 }, undefined, BOTS_LINE],
    [
      "only lines before the hook",
      { infiniteGold: true },
      INFINITE_GOLD_LINE,
      undefined,
    ],
  ])(
    "%s: the line sits after doomsday / before overtime, upstream lines unchanged",
    (_name, settings, before, after) => {
      const upstream = notableLobbySettings(
        lobbyConfig({ ...settings, ...ON }),
        12,
      );
      expect(defconLines(upstream)).toEqual([]);
      // DEFCON on and unset show the same upstream summary.
      expect(notableLobbySettings(lobbyConfig(settings), 12)).toEqual(upstream);

      const off = notableLobbySettings(
        lobbyConfig({ ...settings, ...OFF }),
        12,
      );
      expect(defconLines(off)).toEqual([DEFCON_LINE]);
      // Taking our line out gives back exactly upstream's lines, in order.
      expect(off.filter((i) => i.label !== DEFCON_KEY)).toEqual(upstream);

      const at = off.findIndex((i) => i.label === DEFCON_KEY);
      expect(off[at - 1]?.label).toBe(before);
      expect(off[at + 1]?.label).toBe(after);
    },
  );

  it("keeps doomsday clock and overtime next to each other in upstream's summary", () => {
    // The hook sits between these two upstream lines; if upstream ever
    // reorders them, the position tests above need a new look.
    const labels = notableLobbySettings(
      lobbyConfig({ doomsdayClock: DOOMSDAY_ON, overtime: OVERTIME_ON }),
      null,
    ).map((i) => i.label);
    expect(labels).toEqual([DOOMSDAY_LINE, OVERTIME_LINE]);
  });

  it("shows the line in team mode too", () => {
    const team = { gameMode: GameMode.Team, donateGold: true };
    expect(
      defconLines(notableLobbySettings(lobbyConfig({ ...team, ...OFF }), null)),
    ).toEqual([DEFCON_LINE]);
    expect(
      defconLines(notableLobbySettings(lobbyConfig({ ...team, ...ON }), null)),
    ).toEqual([]);
  });

  describe("what a non-host sees in the join modal", () => {
    function lobbyInfo(config: GameConfig): LobbyInfoEvent {
      return new LobbyInfoEvent(
        {
          gameID: "ABCD1234",
          serverTime: 0,
          lobbyCreatorClientID: "host",
          clients: [
            { clientID: "host", username: "Host", clanTag: null },
            { clientID: "guest", username: "Guest", clanTag: null },
          ],
          gameConfig: config,
        },
        "guest",
      );
    }

    // Water nukes on in every lobby here: its card is the positive control
    // that the config view really rendered, so "no DEFCON card" cannot pass
    // just because nothing was rendered at all.
    const WATER_NUKES = "game_settings.water_nukes";
    const joinConfig = (overrides: Partial<GameConfig> = {}) =>
      lobbyConfig({ waterNukes: true, ...overrides });

    /** A guest who joined the host's lobby (as startTrackingLobby leaves it). */
    function guestModal(): JoinLobbyModal {
      const modal = new JoinLobbyModal();
      (modal as any).currentLobbyId = "ABCD1234";
      return modal;
    }

    function configCards(modal: JoinLobbyModal): [string, unknown][] {
      const container = document.createElement("div");
      render((modal as any).render(), container);
      const cards = [...container.querySelectorAll("lobby-config-item")].map(
        (el): [string, unknown] => [(el as any).label, (el as any).value],
      );
      expect(cards.map(([label]) => label)).toContain(WATER_NUKES);
      return cards;
    }

    function defconCards(cards: [string, unknown][]) {
      return cards.filter(([label]) => label === DEFCON_KEY);
    }

    it("shows a DEFCON Disabled card when the host switched DEFCON off", () => {
      const modal = guestModal();
      (modal as any).handleLobbyInfo(lobbyInfo(joinConfig(OFF)));

      expect(defconCards(configCards(modal))).toEqual([
        [DEFCON_KEY, "common.disabled"],
      ]);
    });

    it("shows no DEFCON card while DEFCON is on or unset", () => {
      for (const config of [joinConfig(ON), joinConfig()]) {
        const modal = guestModal();
        (modal as any).handleLobbyInfo(lobbyInfo(config));
        expect(defconCards(configCards(modal))).toEqual([]);
      }
    });

    it("follows the host's changes through later lobby updates", () => {
      const modal = guestModal();

      (modal as any).handleLobbyInfo(lobbyInfo(joinConfig(OFF)));
      expect(defconCards(configCards(modal))).toHaveLength(1);

      (modal as any).handleLobbyInfo(lobbyInfo(joinConfig(ON)));
      expect(defconCards(configCards(modal))).toEqual([]);

      (modal as any).handleLobbyInfo(lobbyInfo(joinConfig(OFF)));
      expect(defconCards(configCards(modal))).toHaveLength(1);
    });

    it("shows DEFCON Disabled in the open-lobby row of a listed lobby", () => {
      const modal = new JoinLobbyModal();
      const row = (config: GameConfig): string => {
        const lobby: PublicGameInfo = {
          gameID: "ABCD1234",
          numClients: 2,
          publicGameType: "hosted",
          gameConfig: config,
        };
        const container = document.createElement("div");
        render((modal as any).renderHostedLobbyRow(lobby), container);
        return container.textContent ?? "";
      };

      const off = row(joinConfig(OFF));
      expect(off).toContain(WATER_NUKES);
      expect(off).toContain(`${DEFCON_KEY}: common.disabled`);
      expect(off.split(DEFCON_KEY)).toHaveLength(2); // exactly once
      const on = row(joinConfig(ON));
      expect(on).toContain(WATER_NUKES);
      expect(on).not.toContain(DEFCON_KEY);
    });
  });
});

// The singleplayer "custom settings – achievements disabled" warning, as it
// is really rendered. Upstream shows it only to players with a linked
// account (achievements need one), so the login is simulated through the
// modal's real "userMeResponse" document event.
describe("DEFCON off and the singleplayer achievements warning", () => {
  const WARNING = "single_modal.options_changed_no_achievements";
  const LOGGED_IN = {
    user: { email: "tester@example.com" },
    player: { achievements: { singleplayerMap: [] } },
  };

  function mountedModal(): any {
    const modal = document.createElement("single-player-modal") as any;
    document.body.append(modal);
    return modal;
  }

  function login(detail: unknown): void {
    document.dispatchEvent(new CustomEvent("userMeResponse", { detail }));
  }

  /** How often the warning text appears in the rendered menu. */
  function warnings(modal: any): number {
    const container = document.createElement("div");
    render(modal.render(), container);
    return [...container.querySelectorAll("div")].filter(
      // The warning box itself, not the wrappers around it.
      (d) => d.children.length === 0 && d.textContent?.trim() === WARNING,
    ).length;
  }

  afterEach(() => {
    document.querySelectorAll("single-player-modal").forEach((m) => m.remove());
  });

  it("does not show with the default settings", () => {
    const modal = mountedModal();
    login(LOGGED_IN);
    expect(modal.modLobby.defconEnabled).toBe(true);
    expect(warnings(modal)).toBe(0);
  });

  it("shows exactly once when DEFCON is switched off", () => {
    const modal = mountedModal();
    login(LOGGED_IN);
    toggle(modal, DEFCON_KEY, false);
    expect(warnings(modal)).toBe(1);
  });

  it("goes away again when DEFCON is switched back on", () => {
    const modal = mountedModal();
    login(LOGGED_IN);
    toggle(modal, DEFCON_KEY, false);
    expect(warnings(modal)).toBe(1);
    toggle(modal, DEFCON_KEY, true);
    expect(warnings(modal)).toBe(0);
  });

  it("control: an upstream option change shows the same warning", () => {
    const modal = mountedModal();
    login(LOGGED_IN);
    toggle(modal, "game_settings.water_nukes", true);
    expect(warnings(modal)).toBe(1);
  });

  it("never shows without a linked account (upstream rule), also with DEFCON off", () => {
    const modal = mountedModal();
    login(false);
    toggle(modal, DEFCON_KEY, false);
    expect(modal.modLobby.defconEnabled).toBe(false);
    expect(warnings(modal)).toBe(0);
  });
});
