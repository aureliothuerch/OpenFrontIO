import { nothing, render, type TemplateResult } from "lit";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import "../../../src/client/hud/layers/BuildMenu";
import type { BuildMenu } from "../../../src/client/hud/layers/BuildMenu";
import type { TooltipItem } from "../../../src/client/hud/layers/RadialMenu";
import {
  attackMenuElement,
  COLORS,
  type MenuElement,
  type MenuElementParams,
} from "../../../src/client/hud/layers/RadialMenuElements";
import "../../../src/client/hud/layers/UnitDisplay";
import type { UnitDisplay } from "../../../src/client/hud/layers/UnitDisplay";
import type { GameView, PlayerView } from "../../../src/client/view";
import { Config } from "../../../src/core/configuration/Config";
import { EventBus } from "../../../src/core/EventBus";
import {
  BuildableUnit,
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  UnitType,
} from "../../../src/core/game/Game";
import type { GameConfig } from "../../../src/core/Schemas";
import {
  clearDefconClientState,
  defconClientState,
  setDefconClientState,
} from "../../../src/mod/client/defcon/DefconClientState";
import { DefconController } from "../../../src/mod/client/defcon/DefconController";
import {
  modDefconBlocksUnitView,
  modDefconBuildButtonStyle,
  modDefconBuildHint,
  modDefconBuildTitle,
  modDefconDecorateRadial,
  modDefconHotbarClass,
  modDefconHotbarHint,
  modDefconLockedHint,
} from "../../../src/mod/client/defcon/DefconUiHooks";
import { blocksUnit } from "../../../src/mod/core/defcon/DefconRules";
import { defconSettings } from "../../../src/mod/core/defcon/DefconSettings";
import { MOD_CONFIG } from "../../../src/mod/core/ModConfig";

/**
 * DefconUiHooks: what the upstream menus (hotbar, build menu, radial menu)
 * ask through their MOD hooks. The red look and the "Only available from
 * DEFCON 2" hint appear only for a nuke weapon that DEFCON alone locks; every
 * other case (host-disabled type, silos disabled, lockNukes off, game over,
 * DEFCON <= 2, no client state) is exactly upstream.
 */

vi.mock("../../../src/mod/client/ModSound", () => ({
  playDefconAlarm: vi.fn(() => Promise.resolve()),
}));

// Real translateText returns the bare key without a <lang-selector>; add the
// params so the tests can check them.
vi.mock("../../../src/client/Utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/client/Utils")>();
  return {
    ...actual,
    translateText: (key: string, params?: Record<string, string | number>) =>
      params === undefined ? key : `${key}${JSON.stringify(params)}`,
  };
});

const UNLOCK = MOD_CONFIG.defcon.nukeUnlockLevel;
const HINT = `mod.defcon.locked_hint{"level":${UNLOCK}}`;
const HINT_CLASS = "mod-defcon-locked";
const LOCKED_RADIAL_COLOR = "#7f1d1d";
/** RadialMenu's own fill for an item without a color. */
const RADIAL_FALLBACK_COLOR = "#1e3a5f";

const ALL_UNIT_TYPES = Object.values(UnitType);
const NUKES = [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV];

/** What the public "isNukesDisabled" modifier disables (MapPlaylist). */
const NUKES_MODIFIER_UNITS = [
  UnitType.MissileSilo,
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.SAMLauncher,
];

function gameConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
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
    ...overrides,
  };
}

/** Only what the hooks (and UnitDisplay.canBuild) read from a GameView. */
class FakeGame {
  over = false;
  /** The player's gold; rich unless a test says otherwise. */
  gold = 1_000_000_000n;
  constructor(private cfg: Config) {}
  config(): Config {
    return this.cfg;
  }
  gameOver(): boolean {
    return this.over;
  }
  /** Rich, with a silo and a port (unless the host disabled them). */
  myPlayer(): unknown {
    const cfg = this.cfg;
    return {
      gold: () => this.gold,
      units: (type: UnitType) =>
        (type === UnitType.MissileSilo || type === UnitType.Port) &&
        !cfg.isUnitDisabled(type)
          ? [{}]
          : [],
      readyMissileCount: () => 0,
      totalUnitLevels: () => 0, // BuildMenu counts
    };
  }
  inSpawnPhase(): boolean {
    return false;
  }
  get view(): GameView {
    return this as unknown as GameView;
  }
}

interface Scenario {
  readonly name: string;
  readonly level: number;
  readonly disabledUnits?: UnitType[];
  readonly lockNukes?: boolean;
  /** The simulation's game over (a winner), as the ModDefcon update says. */
  readonly gameOver?: boolean;
  /**
   * GameView.gameOver() alone (e.g. a cancelled game without a winner): the
   * simulation keeps its lock, so the hooks must too.
   */
  readonly viewOver?: boolean;
  /** The types that must look locked (red + hint). */
  readonly red: readonly UnitType[];
}

interface Setup {
  game: FakeGame;
  view: GameView;
  cfg: Config;
}

/** A game whose DEFCON client state is at `level` (as the controller sets it). */
function setupGame(
  s: Omit<Scenario, "name" | "red"> = { level: 5 },
): Setup & { level: number } {
  const cfg = new Config(
    gameConfig({
      disabledUnits: s.disabledUnits ?? [],
      ...(s.lockNukes === undefined
        ? {}
        : { mod: { defcon: { lockNukes: s.lockNukes } } }),
    }),
    null,
    false,
  );
  const game = new FakeGame(cfg);
  // A winner ends the GameView too; a cancelled game only ends the GameView.
  game.over = (s.gameOver ?? false) || (s.viewOver ?? false);
  setDefconClientState(game.view, {
    level: s.level,
    tuning: defconSettings(cfg),
    gameOver: s.gameOver ?? false,
  });
  return { game, view: game.view, cfg, level: s.level };
}

/** A new ModDefcon update, as the controller stores it. */
function setState(setup: Setup, level: number, gameOver = false): void {
  setDefconClientState(setup.view, {
    level,
    tuning: defconSettings(setup.cfg),
    gameOver,
  });
}

function setLevel(setup: Setup, level: number): void {
  setState(setup, level, defconClientState(setup.view)?.gameOver ?? false);
}

/** The simulation's game over, at the current level. */
function endGame(setup: Setup): void {
  setup.game.over = true;
  setState(setup, defconClientState(setup.view)?.level ?? 5, true);
}

function renderText(tpl: TemplateResult): HTMLElement {
  const host = document.createElement("div");
  render(tpl, host);
  return host;
}

/** Every hook for one unit type, in a form that is easy to compare. */
function hookOutputs(game: GameView | null | undefined, t: UnitType) {
  return {
    blocks: modDefconBlocksUnitView(game, t),
    hint: modDefconLockedHint(game, t),
    hotbarClass: modDefconHotbarClass(game, t),
    hotbarHint: modDefconHotbarHint(game, t),
    buildStyle: modDefconBuildButtonStyle(game, t),
    buildHint: modDefconBuildHint(game, t),
  };
}

function expectNeutral(game: GameView | null | undefined, t: UnitType): void {
  const out = hookOutputs(game, t);
  expect(out.blocks, `${t}: blocks`).toBe(false);
  expectNoRedLook(game, t);
}

function expectNoRedLook(game: GameView | null | undefined, t: UnitType): void {
  const out = hookOutputs(game, t);
  expect(out.hint, `${t}: hint`).toBeNull();
  expect(out.hotbarClass, `${t}: hotbar class`).toBe("");
  expect(out.hotbarHint, `${t}: hotbar hint`).toBeNull();
  expect(out.buildStyle, `${t}: build style`).toBe(nothing);
  expect(out.buildHint, `${t}: build hint`).toBeNull();
}

function expectRedLook(game: GameView, t: UnitType): void {
  const out = hookOutputs(game, t);
  expect(out.hint, `${t}: hint`).toBe(HINT);

  // Hotbar: red, and important ("!") so it wins over opacity-40 / hover.
  expect(out.hotbarClass, `${t}: hotbar class`).toMatch(/red/);
  for (const cls of out.hotbarClass.split(/\s+/)) {
    expect(cls.endsWith("!"), `${t}: ${cls} is important`).toBe(true);
  }
  expect(out.hotbarHint).not.toBeNull();
  const hotbarLine = renderText(out.hotbarHint!).querySelector("div");
  expect(hotbarLine?.textContent?.trim()).toBe(HINT);
  expect(hotbarLine?.className).toMatch(/text-red/);

  // Build menu: inline style (shadow DOM) and the hover hint.
  expect(typeof out.buildStyle, `${t}: build style`).toBe("string");
  expect(out.buildStyle as string).toMatch(/background-color:/);
  expect(out.buildStyle as string).toMatch(/border-color:/);
  expect(out.buildHint).not.toBeNull();
  const buildHint = renderText(out.buildHint!).querySelector(
    ".mod-defcon-hint",
  );
  expect(buildHint?.textContent?.trim()).toBe(HINT);
}

// ------------------------------------------------------------- scenarios

const LOCKED_SCENARIOS: Scenario[] = [
  { name: "DEFCON 5, everything enabled", level: 5, red: NUKES },
  { name: "DEFCON 4", level: 4, red: NUKES },
  { name: "DEFCON 3", level: 3, red: NUKES },
  {
    name: "SAMs disabled",
    level: 3,
    disabledUnits: [UnitType.SAMLauncher],
    red: NUKES,
  },
  {
    name: "lockNukes explicitly on",
    level: 4,
    lockNukes: true,
    red: NUKES,
  },
  {
    name: "atom bomb disabled by the host",
    level: 4,
    disabledUnits: [UnitType.AtomBomb],
    red: [UnitType.HydrogenBomb, UnitType.MIRV],
  },
  {
    name: "hydrogen bomb disabled by the host",
    level: 4,
    disabledUnits: [UnitType.HydrogenBomb],
    red: [UnitType.AtomBomb, UnitType.MIRV],
  },
  {
    name: "MIRV disabled by the host",
    level: 4,
    disabledUnits: [UnitType.MIRV],
    red: [UnitType.AtomBomb, UnitType.HydrogenBomb],
  },
  {
    name: "only MIRV enabled",
    level: 5,
    disabledUnits: [UnitType.AtomBomb, UnitType.HydrogenBomb],
    red: [UnitType.MIRV],
  },
  {
    name: "MIRV warhead disabled (not a weapon)",
    level: 3,
    disabledUnits: [UnitType.MIRVWarhead],
    red: NUKES,
  },
  {
    name: "GameView over without a winner (cancelled game)",
    level: 4,
    viewOver: true,
    red: NUKES,
  },
];

const NEUTRAL_SCENARIOS: Scenario[] = [
  { name: "DEFCON 2 (unlocked)", level: 2, red: [] },
  { name: "DEFCON 1", level: 1, red: [] },
  { name: "lockNukes off", level: 5, lockNukes: false, red: [] },
  { name: "game over at DEFCON 5", level: 5, gameOver: true, red: [] },
  {
    name: "all nuke types disabled by the host",
    level: 5,
    disabledUnits: NUKES,
    red: [],
  },
  {
    name: "missile silo disabled by the host",
    level: 5,
    disabledUnits: [UnitType.MissileSilo],
    red: [],
  },
  {
    name: "public isNukesDisabled modifier",
    level: 5,
    disabledUnits: NUKES_MODIFIER_UNITS,
    red: [],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DefconUiHooks: build menu, hotbar and hint", () => {
  describe.each([...LOCKED_SCENARIOS, ...NEUTRAL_SCENARIOS])(
    "$name",
    (scenario) => {
      it("is red with the hint only for the DEFCON-locked nukes", () => {
        const { view } = setupGame(scenario);
        for (const t of ALL_UNIT_TYPES) {
          if (scenario.red.includes(t)) {
            expectRedLook(view, t);
          } else {
            expectNoRedLook(view, t);
          }
        }
      });

      it("blocks in the hotbar by the same rule as the core", () => {
        const { view, cfg } = setupGame(scenario);
        const tuning = defconSettings(cfg);
        for (const t of ALL_UNIT_TYPES) {
          expect(modDefconBlocksUnitView(view, t), t).toBe(
            blocksUnit(scenario.level, t, tuning, scenario.gameOver ?? false),
          );
        }
        // Every red type is also blocked; nothing else but a nuke weapon is.
        for (const t of scenario.red) {
          expect(modDefconBlocksUnitView(view, t), t).toBe(true);
        }
        for (const t of ALL_UNIT_TYPES) {
          if (!NUKES.includes(t)) {
            expect(modDefconBlocksUnitView(view, t), t).toBe(false);
          }
        }
      });
    },
  );

  it("never blocks when lockNukes is off, the game is over or DEFCON <= 2", () => {
    const cases: Omit<Scenario, "name" | "red">[] = [
      { level: 5, lockNukes: false },
      { level: 5, gameOver: true },
      { level: 3, gameOver: true, disabledUnits: [UnitType.AtomBomb] },
      { level: 2 },
      { level: 1 },
    ];
    for (const c of cases) {
      const { view } = setupGame(c);
      for (const t of ALL_UNIT_TYPES) expectNeutral(view, t);
    }
  });

  it("follows the client state: locked at 3, free at 2", () => {
    const setup = setupGame({ level: 3 });
    for (const t of NUKES) expectRedLook(setup.view, t);
    setLevel(setup, 2);
    for (const t of ALL_UNIT_TYPES) expectNeutral(setup.view, t);
  });

  it("drops the lock look the moment the simulation says the game is over", () => {
    const setup = setupGame({ level: 4 });
    for (const t of NUKES) expectRedLook(setup.view, t);
    endGame(setup);
    for (const t of ALL_UNIT_TYPES) expectNeutral(setup.view, t);
  });

  it("keeps the lock look while only the GameView is over (no winner)", () => {
    const setup = setupGame({ level: 4 });
    setup.game.over = true;
    for (const t of NUKES) {
      expectRedLook(setup.view, t);
      expect(modDefconBlocksUnitView(setup.view, t), t).toBe(true);
    }
  });
});

describe("DefconUiHooks: no client state is upstream behaviour", () => {
  it("is neutral for a null or undefined game", () => {
    for (const t of ALL_UNIT_TYPES) {
      expectNeutral(null, t);
      expectNeutral(undefined, t);
    }
  });

  it("is neutral for another GameView than the one with the state", () => {
    const locked = setupGame({ level: 5 });
    const other = new FakeGame(locked.cfg);
    expect(defconClientState(other.view)).toBeNull();
    for (const t of ALL_UNIT_TYPES) expectNeutral(other.view, t);
    // The locked game itself is unaffected.
    for (const t of NUKES) expectRedLook(locked.view, t);
  });

  it("is neutral once the state is cleared", () => {
    const setup = setupGame({ level: 5 });
    clearDefconClientState(setup.view);
    for (const t of ALL_UNIT_TYPES) expectNeutral(setup.view, t);
  });

  it("is neutral when DEFCON is off in GameConfig.mod (via the controller)", () => {
    const cfg = new Config(
      gameConfig({ mod: { defcon: { enabled: false } } }),
      null,
      false,
    );
    const game = new FakeGame(cfg);
    // A stale entry the controller must clear.
    setDefconClientState(game.view, {
      level: 5,
      tuning: MOD_CONFIG.defcon,
      gameOver: false,
    });
    new DefconController(game.view, new EventBus()).init();

    expect(defconClientState(game.view)).toBeNull();
    for (const t of ALL_UNIT_TYPES) expectNeutral(game.view, t);
    const items = NUKES.map((t) => fakeItem(t));
    expect(modDefconDecorateRadial(items, params(game.view))).toBe(items);
  });

  it("is red when DEFCON is on (via the controller)", () => {
    const cfg = new Config(gameConfig(), null, false);
    const game = new FakeGame(cfg);
    new DefconController(game.view, new EventBus()).init();
    expect(defconClientState(game.view)?.level).toBe(5);
    for (const t of NUKES) expectRedLook(game.view, t);
  });
});

// ------------------------------------------------------------ radial menu

interface FakeItem extends MenuElement {
  disabled: Mock<(p: MenuElementParams) => boolean>;
  action: Mock<(p: MenuElementParams) => void>;
  subMenu: Mock<(p: MenuElementParams) => MenuElement[]>;
}

const SUB_ITEMS: MenuElement[] = [
  { id: "upgrade_x1", name: "x1", disabled: () => false, action: () => {} },
];

/** Like createMenuElements' items: attack_<UnitType>, upstream fields. */
function fakeItem(t: UnitType, opts: { disabled?: boolean } = {}): FakeItem {
  return {
    id: `attack_${t}`,
    name: t,
    icon: `${t}-icon`,
    displayed: true,
    fontSize: "12px",
    text: "t",
    renderType: "r",
    cooldown: () => 0,
    timerFraction: () => 0,
    tooltipKeys: [{ key: "k", className: "c" }],
    disabled: vi.fn(() => opts.disabled ?? true),
    color: (p: MenuElementParams) =>
      p.buildMenu.canBuildOrUpgrade(null as never)
        ? COLORS.attack
        : COLORS.building,
    tooltipItems: [
      { text: `${t} title`, className: "title" },
      { text: `${t} description`, className: "description" },
      { text: "100 gold", className: "cost" },
    ],
    subMenu: vi.fn(() => SUB_ITEMS),
    action: vi.fn(),
  };
}

interface FakeParams extends MenuElementParams {
  closeMenu: Mock<() => void>;
}

function params(
  game: GameView,
  canBuild = false,
): FakeParams & { bus: EventBus } {
  const bus = new EventBus();
  vi.spyOn(bus, "emit");
  return {
    game,
    bus,
    eventBus: bus,
    closeMenu: vi.fn(),
    buildMenu: { canBuildOrUpgrade: () => canBuild } as never,
    myPlayer: {} as PlayerView,
    selected: null,
    tile: 0,
    playerActions: { buildableUnits: [] } as never,
    emojiTable: {} as never,
    playerActionHandler: {} as never,
    playerPanel: {} as never,
    chatIntegration: {} as never,
  } as FakeParams & { bus: EventBus };
}

/** A shallow snapshot of an item (and its tooltip lines) to detect mutation. */
function snapshot(item: MenuElement) {
  return {
    fields: { ...item },
    tooltip: item.tooltipItems?.map((i) => ({ ...i })),
    tooltipRef: item.tooltipItems,
  };
}

function expectUnchanged(
  item: MenuElement,
  before: ReturnType<typeof snapshot>,
): void {
  expect({ ...item }).toEqual(before.fields);
  for (const [key, value] of Object.entries(before.fields)) {
    expect((item as unknown as Record<string, unknown>)[key], key).toBe(value);
  }
  expect(item.tooltipItems).toBe(before.tooltipRef);
  expect(item.tooltipItems?.map((i) => ({ ...i }))).toEqual(before.tooltip);
}

/** The fill RadialMenu paints for an enabled item (resolveColor + fallback). */
function fill(item: MenuElement, p: MenuElementParams): string {
  const color = typeof item.color === "function" ? item.color(p) : item.color;
  return color ?? RADIAL_FALLBACK_COLOR;
}

describe("DefconUiHooks: radial attack submenu", () => {
  it("returns the very same items without client state", () => {
    const game = new FakeGame(new Config(gameConfig(), null, false));
    const items = [
      ...NUKES.map((t) => fakeItem(t)),
      fakeItem(UnitType.Warship),
    ];
    const before = items.map(snapshot);
    const out = modDefconDecorateRadial(items, params(game.view));
    expect(out).toBe(items);
    items.forEach((item, i) => expectUnchanged(item, before[i]));
  });

  it("returns new objects for locked nukes and never mutates the inputs", () => {
    const { view } = setupGame({ level: 4 });
    const warship = fakeItem(UnitType.Warship);
    const other: MenuElement = {
      id: "build_City",
      name: "city",
      disabled: () => false,
    };
    const items: MenuElement[] = [
      ...NUKES.map((t) => fakeItem(t)),
      warship,
      other,
    ];
    const inputArray = [...items];
    const before = items.map(snapshot);

    const out = modDefconDecorateRadial(items, params(view));

    expect(out).not.toBe(items);
    expect(out).toHaveLength(items.length);
    expect(items).toEqual(inputArray);
    items.forEach((item, i) => expectUnchanged(item, before[i]));
    for (let i = 0; i < NUKES.length; i++) {
      expect(out[i]).not.toBe(items[i]);
      expect(out[i].id).toBe(items[i].id);
    }
    // Non-nuke items are passed through as they are.
    expect(out[3]).toBe(warship);
    expect(out[4]).toBe(other);

    // Using the decorated items does not touch the inputs either.
    const p = params(view);
    for (const item of out) {
      item.disabled(p);
      fill(item, p);
      void item.tooltipItems;
      item.subMenu?.(p);
      item.action?.(p);
    }
    items.forEach((item, i) => expectUnchanged(item, before[i]));
  });

  it("shows a locked nuke in dark red with the hint, and a click only closes the menu", () => {
    const { view } = setupGame({ level: 5 });
    for (const t of NUKES) {
      const item = fakeItem(t);
      const [locked] = modDefconDecorateRadial([item], params(view));
      const p = params(view);

      // Enabled, or RadialMenu would paint it grey and ignore the color.
      expect(locked.disabled(p)).toBe(false);
      expect(fill(locked, p)).toBe(LOCKED_RADIAL_COLOR);
      expect(locked.tooltipItems).toEqual([
        { text: `${t} title`, className: "title" },
        { text: `${t} description`, className: "description" },
        { text: HINT, className: HINT_CLASS },
        { text: "100 gold", className: "cost" },
      ]);
      expect(item.tooltipItems).toHaveLength(3);

      // RadialMenu's click: an empty submenu falls through to action().
      expect(locked.subMenu?.(p)).toEqual([]);
      const toasts: { message: string; color: string }[] = [];
      const onToast = (e: Event) =>
        toasts.push(
          (e as CustomEvent<{ message: string; color: string }>).detail,
        );
      window.addEventListener("show-message", onToast);
      try {
        locked.action?.(p);
      } finally {
        window.removeEventListener("show-message", onToast);
      }
      // Tooltips only show on hover: the click tells touch players why.
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toBe(HINT);
      expect(toasts[0].color).toBe("red");
      expect(p.closeMenu).toHaveBeenCalledTimes(1);
      expect(p.bus.emit).not.toHaveBeenCalled();
      expect(item.action).not.toHaveBeenCalled();
      expect(item.subMenu).not.toHaveBeenCalled();

      // Everything else is the upstream item's.
      expect(locked.id).toBe(item.id);
      expect(locked.name).toBe(item.name);
      expect(locked.icon).toBe(item.icon);
      expect(locked.cooldown).toBe(item.cooldown);
      expect(locked.timerFraction).toBe(item.timerFraction);
      expect(locked.tooltipKeys).toBe(item.tooltipKeys);
      expect(locked.displayed).toBe(item.displayed);
      expect(locked.fontSize).toBe(item.fontSize);
      expect(locked.text).toBe(item.text);
      expect(locked.renderType).toBe(item.renderType);
    }
  });

  it("adds the hint line at the end without a description, or alone without tooltip", () => {
    const { view } = setupGame({ level: 3 });
    const noDescription: MenuElement = {
      ...fakeItem(UnitType.AtomBomb),
      tooltipItems: [{ text: "title", className: "title" }],
    };
    const noTooltip: MenuElement = {
      ...fakeItem(UnitType.MIRV),
      tooltipItems: undefined,
    };
    const [a, b] = modDefconDecorateRadial(
      [noDescription, noTooltip],
      params(view),
    );
    const line: TooltipItem = { text: HINT, className: HINT_CLASS };
    expect(a.tooltipItems).toEqual([
      { text: "title", className: "title" },
      line,
    ]);
    expect(noDescription.tooltipItems).toHaveLength(1);
    expect(b.tooltipItems).toEqual([line]);
    expect(noTooltip.tooltipItems).toBeUndefined();
  });

  it("styles the hint line once per page", () => {
    const { view } = setupGame({ level: 3 });
    modDefconDecorateRadial([fakeItem(UnitType.AtomBomb)], params(view));
    modDefconDecorateRadial([fakeItem(UnitType.MIRV)], params(view));
    const styles = [...document.head.querySelectorAll("style")].filter((s) =>
      s.textContent?.includes(`.radial-tooltip .${HINT_CLASS}`),
    );
    expect(styles).toHaveLength(1);
  });

  describe.each(NEUTRAL_SCENARIOS)("$name", (scenario) => {
    it("leaves every item as it is", () => {
      const { view } = setupGame(scenario);
      const items = [
        ...NUKES.map((t) => fakeItem(t)),
        fakeItem(UnitType.Warship),
      ];
      const before = items.map(snapshot);
      const out = modDefconDecorateRadial(items, params(view));
      out.forEach((item, i) => expect(item, items[i].id).toBe(items[i]));
      items.forEach((item, i) => expectUnchanged(item, before[i]));
    });
  });

  it("decorates only the nukes the host left enabled", () => {
    const { view } = setupGame({
      level: 4,
      disabledUnits: [UnitType.HydrogenBomb],
    });
    const items = NUKES.map((t) => fakeItem(t));
    const out = modDefconDecorateRadial(items, params(view));
    expect(out[0]).not.toBe(items[0]); // atom bomb: locked by DEFCON
    expect(out[1]).toBe(items[1]); // hydrogen bomb: host-disabled, upstream
    expect(out[2]).not.toBe(items[2]); // MIRV: locked by DEFCON
  });

  it("stays locked while only the GameView is over (no winner)", () => {
    const { view } = setupGame({ level: 4, viewOver: true });
    for (const t of NUKES) {
      const item = fakeItem(t);
      const [locked] = modDefconDecorateRadial([item], params(view));
      const p = params(view);
      expect(locked).not.toBe(item);
      expect(fill(locked, p)).toBe(LOCKED_RADIAL_COLOR);
      locked.action?.(p);
      expect(p.closeMenu).toHaveBeenCalledTimes(1);
      expect(item.action).not.toHaveBeenCalled();
    }
  });

  describe("after unlocking, a decorated item behaves like the original", () => {
    const unlocks: [string, (s: ReturnType<typeof setupGame>) => void][] = [
      ["DEFCON 2", (s) => setLevel(s, 2)],
      ["DEFCON 1", (s) => setLevel(s, 1)],
      ["game over (a winner)", endGame],
    ];

    it.each(unlocks)("%s", (_name, unlock) => {
      const setup = setupGame({ level: 3 });
      for (const t of NUKES) {
        for (const upstreamDisabled of [true, false]) {
          for (const canBuild of [true, false]) {
            const item = fakeItem(t, { disabled: upstreamDisabled });
            const [decorated] = modDefconDecorateRadial(
              [item],
              params(setup.view),
            );
            expect(decorated).not.toBe(item);

            unlock(setup);
            const p = params(setup.view, canBuild);
            expect(decorated.disabled(p)).toBe(upstreamDisabled);
            expect(item.disabled).toHaveBeenCalledWith(p);
            expect(fill(decorated, p)).toBe(fill(item, p));
            expect(decorated.tooltipItems).toBe(item.tooltipItems);
            expect(decorated.subMenu?.(p)).toBe(SUB_ITEMS);
            expect(item.subMenu).toHaveBeenCalledWith(p);
            decorated.action?.(p);
            expect(item.action).toHaveBeenCalledTimes(1);
            expect(item.action).toHaveBeenCalledWith(p);
            expect(p.closeMenu).not.toHaveBeenCalled();

            // Back to the locked state for the next item.
            setState(setup, 3);
            setup.game.over = false;
          }
        }
      }
    });

    it("keeps a string or missing color and missing subMenu/action", () => {
      const setup = setupGame({ level: 4 });
      const stringColor: MenuElement = {
        id: `attack_${UnitType.AtomBomb}`,
        name: "atom",
        color: "#123456",
        disabled: () => true,
      };
      const noColor: MenuElement = {
        id: `attack_${UnitType.MIRV}`,
        name: "mirv",
        disabled: () => false,
      };
      const [a, b] = modDefconDecorateRadial(
        [stringColor, noColor],
        params(setup.view),
      );
      expect(a.subMenu).toBeUndefined();
      expect(b.subMenu).toBeUndefined();
      const locked = params(setup.view);
      expect(fill(a, locked)).toBe(LOCKED_RADIAL_COLOR);
      expect(fill(b, locked)).toBe(LOCKED_RADIAL_COLOR);
      a.action?.(locked);
      expect(locked.closeMenu).toHaveBeenCalledTimes(1);

      setLevel(setup, 2);
      const p = params(setup.view);
      expect(fill(a, p)).toBe("#123456");
      expect(fill(b, p)).toBe(fill(noColor, p));
      expect(a.disabled(p)).toBe(true);
      expect(b.disabled(p)).toBe(false);
      expect(() => a.action?.(p)).not.toThrow();
      expect(p.closeMenu).not.toHaveBeenCalled();
      expect(a.tooltipItems).toBeUndefined();
    });
  });
});

// ------------------------------------------- the real upstream call sites

describe("DefconUiHooks in the real attack submenu (RadialMenuElements hook)", () => {
  const myPlayer = { id: () => 1 } as unknown as PlayerView;
  const enemy = { id: () => 2 } as unknown as PlayerView;

  function realParams(view: GameView, canBuild: (t: UnitType) => boolean) {
    const bus = new EventBus();
    const emit = vi.spyOn(bus, "emit");
    const buildableUnits = [...NUKES, UnitType.Warship].map(
      (type) =>
        ({
          type,
          canBuild: canBuild(type) ? 7 : false,
          canUpgrade: false,
          cost: 100n,
        }) as unknown as BuildableUnit,
    );
    const p: MenuElementParams = {
      myPlayer,
      selected: enemy,
      tile: 7,
      playerActions: { buildableUnits, canAttack: true } as never,
      game: view,
      buildMenu: {
        canBuildOrUpgrade: (item: { unitType: UnitType }) =>
          canBuild(item.unitType),
        cost: () => 100n,
        count: () => "1",
      } as never,
      emojiTable: {} as never,
      playerActionHandler: {} as never,
      playerPanel: {} as never,
      chatIntegration: {} as never,
      eventBus: bus,
      closeMenu: vi.fn(),
    };
    return { p, emit };
  }

  function byType(items: MenuElement[], t: UnitType): MenuElement {
    const item = items.find((i) => i.id === `attack_${t}`);
    expect(item, t).toBeDefined();
    return item!;
  }

  /** RadialMenu's click on an enabled item. */
  function click(item: MenuElement, p: MenuElementParams): void {
    const sub = item.subMenu?.(p);
    if (sub && sub.length > 0) return;
    item.action?.(p);
  }

  it("locked: dark red nukes with the hint, clicks send no build intent", () => {
    const { view } = setupGame({ level: 4 });
    // The worker rejects locked nukes (PlayerImpl hook): canBuild false.
    const { p, emit } = realParams(view, (t) => !NUKES.includes(t));
    const items = attackMenuElement.subMenu!(p);

    for (const t of NUKES) {
      const item = byType(items, t);
      expect(item.disabled(p)).toBe(false);
      expect(fill(item, p)).toBe(LOCKED_RADIAL_COLOR);
      expect(item.tooltipItems?.map((i) => i.text)).toContain(HINT);
      click(item, p);
    }
    expect(emit).not.toHaveBeenCalled();
    expect(p.closeMenu).toHaveBeenCalledTimes(NUKES.length);

    const warship = byType(items, UnitType.Warship);
    expect(fill(warship, p)).toBe(COLORS.attack);
    expect(warship.tooltipItems?.map((i) => i.text)).not.toContain(HINT);
  });

  it("unlocked: the upstream items, a click sends the build intent", () => {
    const setup = setupGame({ level: 2 });
    const { p, emit } = realParams(setup.view, () => true);
    const items = attackMenuElement.subMenu!(p);
    const atom = byType(items, UnitType.AtomBomb);
    expect(atom.disabled(p)).toBe(false);
    expect(fill(atom, p)).toBe(COLORS.attack);
    expect(atom.tooltipItems?.map((i) => i.text)).not.toContain(HINT);
    click(atom, p);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      unit: UnitType.AtomBomb,
      tile: 7,
    });
  });

  it("feature off: exactly the upstream submenu", () => {
    const setup = setupGame({ level: 5 });
    clearDefconClientState(setup.view);
    const { p } = realParams(setup.view, (t) => !NUKES.includes(t));
    const items = attackMenuElement.subMenu!(p);
    for (const t of NUKES) {
      const item = byType(items, t);
      expect(item.disabled(p)).toBe(true);
      expect(item.tooltipItems?.map((i) => i.text)).not.toContain(HINT);
    }
  });
});

describe("DefconUiHooks in the real hotbar (UnitDisplay.canBuild hook)", () => {
  function canBuild(view: GameView, t: UnitType): boolean {
    const hotbar = document.createElement("unit-display") as UnitDisplay;
    hotbar.game = view;
    return (hotbar as unknown as { canBuild(t: UnitType): boolean }).canBuild(
      t,
    );
  }

  /** The hotbar's answer for every type with and without DEFCON state. */
  function withAndWithout(setup: ReturnType<typeof setupGame>) {
    const withState = ALL_UNIT_TYPES.map((t) => canBuild(setup.view, t));
    const state = defconClientState(setup.view);
    clearDefconClientState(setup.view);
    const upstream = ALL_UNIT_TYPES.map((t) => canBuild(setup.view, t));
    if (state !== null) setDefconClientState(setup.view, state);
    return { withState, upstream };
  }

  it("locks exactly the enabled nukes while DEFCON locks them", () => {
    const setup = setupGame({ level: 3 });
    const { withState, upstream } = withAndWithout(setup);
    ALL_UNIT_TYPES.forEach((t, i) => {
      if (NUKES.includes(t)) {
        expect(upstream[i], t).toBe(true);
        expect(withState[i], t).toBe(false);
      } else {
        expect(withState[i], t).toBe(upstream[i]);
      }
    });
  });

  it.each([
    ...NEUTRAL_SCENARIOS,
    ...LOCKED_SCENARIOS.filter((s) => (s.disabledUnits ?? []).length > 0),
  ])("is upstream for everything not locked by DEFCON: $name", (scenario) => {
    const setup = setupGame(scenario);
    const { withState, upstream } = withAndWithout(setup);
    ALL_UNIT_TYPES.forEach((t, i) => {
      if (scenario.red.includes(t)) {
        expect(withState[i], t).toBe(false);
      } else {
        expect(withState[i], t).toBe(upstream[i]);
      }
    });
    // A host-disabled type stays disabled (nothing is ever unlocked).
    for (const t of scenario.disabledUnits ?? []) {
      expect(canBuild(setup.view, t), t).toBe(false);
    }
  });
});

// The build menu's native tooltip says "Not enough money" for every disabled
// button. When DEFCON is the reason, only the red DEFCON hint may show; when
// gold is missing as well, both may.
describe("DefconUiHooks: build menu tooltip", () => {
  const MONEY = "build_menu.not_enough_money";
  const COST = 750_000n;

  it("locked by DEFCON with enough gold: no 'Not enough money', only the red hint", () => {
    const setup = setupGame({ level: 5 });
    for (const t of NUKES) {
      expect(modDefconBuildTitle(setup.view, t, COST, MONEY), t).toBe("");
      expect(modDefconLockedHint(setup.view, t), t).toBe(HINT);
    }
  });

  it("exactly affordable counts as enough gold", () => {
    const setup = setupGame({ level: 4 });
    setup.game.gold = COST;
    for (const t of NUKES) {
      expect(modDefconBuildTitle(setup.view, t, COST, MONEY), t).toBe("");
    }
  });

  it("locked by DEFCON and gold missing too: both stay", () => {
    const setup = setupGame({ level: 3 });
    setup.game.gold = COST - 1n;
    for (const t of NUKES) {
      expect(modDefconBuildTitle(setup.view, t, COST, MONEY), t).toBe(MONEY);
      expect(modDefconLockedHint(setup.view, t), t).toBe(HINT);
    }
  });

  it("a cancelled game (GameView over, no winner) is still locked: no 'Not enough money'", () => {
    const setup = setupGame({ level: 5, viewOver: true });
    for (const t of NUKES) {
      expect(modDefconBuildTitle(setup.view, t, COST, MONEY), t).toBe("");
    }
  });

  it.each(NEUTRAL_SCENARIOS)(
    "leaves upstream's tooltip alone when DEFCON is not the reason: $name",
    (scenario) => {
      const setup = setupGame(scenario);
      for (const t of ALL_UNIT_TYPES) {
        if (scenario.red.includes(t)) continue;
        expect(modDefconBuildTitle(setup.view, t, COST, MONEY), t).toBe(MONEY);
        expect(modDefconBuildTitle(setup.view, t, COST, ""), t).toBe("");
      }
    },
  );

  it("leaves non-nuke buttons and games without DEFCON state alone", () => {
    const setup = setupGame({ level: 5 });
    for (const t of ALL_UNIT_TYPES.filter((t) => !NUKES.includes(t))) {
      expect(modDefconBuildTitle(setup.view, t, COST, MONEY), t).toBe(MONEY);
    }
    clearDefconClientState(setup.view);
    for (const t of NUKES) {
      expect(modDefconBuildTitle(setup.view, t, COST, MONEY), t).toBe(MONEY);
    }
    expect(modDefconBuildTitle(null, UnitType.AtomBomb, COST, MONEY)).toBe(
      MONEY,
    );
  });

  describe("in the real build menu (BuildMenu hook)", () => {
    async function titles(setup: Setup): Promise<Map<string, string | null>> {
      const menu = document.createElement("build-menu") as BuildMenu;
      menu.game = setup.view;
      // Locked nukes come back from the worker with canBuild false.
      menu.playerBuildables = [
        ...NUKES.map((type) => ({
          type,
          canBuild: false as const,
          canUpgrade: false as const,
          cost: COST,
        })),
        {
          type: UnitType.City,
          canBuild: false as const,
          canUpgrade: false as const,
          cost: COST,
        },
      ] as unknown as BuildMenu["playerBuildables"];
      document.body.append(menu);
      try {
        await menu.updateComplete;
        const out = new Map<string, string | null>();
        for (const button of menu.shadowRoot!.querySelectorAll("button")) {
          const alt = button.querySelector("img")?.getAttribute("alt");
          if (alt) out.set(alt, button.getAttribute("title"));
        }
        return out;
      } finally {
        menu.remove();
      }
    }

    it("DEFCON-locked, affordable nukes get no 'Not enough money'; other disabled buttons keep it", async () => {
      const setup = setupGame({ level: 5 });
      const t = await titles(setup);
      for (const n of NUKES) expect(t.get(n), n).toBe("");
      expect(t.get(UnitType.City)).toBe(MONEY);
    });

    it("keeps 'Not enough money' when gold is missing too", async () => {
      const setup = setupGame({ level: 5 });
      setup.game.gold = COST - 1n;
      const t = await titles(setup);
      for (const n of NUKES) expect(t.get(n), n).toBe(MONEY);
    });

    it("is upstream once DEFCON unlocks", async () => {
      const setup = setupGame({ level: UNLOCK });
      const t = await titles(setup);
      for (const n of NUKES) expect(t.get(n), n).toBe(MONEY);
    });
  });
});
