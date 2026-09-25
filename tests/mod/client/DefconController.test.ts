import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameView } from "../../../src/client/view";
import { Config } from "../../../src/core/configuration/Config";
import { EventBus } from "../../../src/core/EventBus";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  UnitType,
} from "../../../src/core/game/Game";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import type { GameConfig } from "../../../src/core/Schemas";
import {
  defconClientState,
  setDefconClientState,
} from "../../../src/mod/client/defcon/DefconClientState";
import { DefconController } from "../../../src/mod/client/defcon/DefconController";
import { DefconChangedEvent } from "../../../src/mod/client/defcon/DefconEvents";
import { DefconHud } from "../../../src/mod/client/defcon/DefconHud";
import {
  modDefconBlocksUnitView,
  modDefconLockedHint,
} from "../../../src/mod/client/defcon/DefconUiHooks";
import { playDefconAlarm } from "../../../src/mod/client/ModSound";
import { defconSettings } from "../../../src/mod/core/defcon/DefconSettings";
import type { ModDefconUpdate } from "../../../src/mod/core/defcon/DefconUpdate";
import { MOD_CONFIG } from "../../../src/mod/core/ModConfig";

/**
 * DefconController: the client side of DEFCON. Mounts the HUD, keeps the
 * per-GameView client state for the menu hooks, emits DefconChangedEvent and
 * plays the alarm exactly when a banner is announced. Driven with a minimal
 * fake GameView (only what the controller calls) and a real upstream Config.
 */

// No audio in tests: the alarm is a spy, asserted per announced banner.
vi.mock("../../../src/mod/client/ModSound", () => ({
  playDefconAlarm: vi.fn(() => Promise.resolve()),
}));

// translateText without a <lang-selector> returns the bare key; add the
// params so the tests can read the level the HUD shows.
vi.mock("../../../src/client/Utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/client/Utils")>();
  return {
    ...actual,
    translateText: (key: string, params?: Record<string, string | number>) =>
      params === undefined ? key : `${key}${JSON.stringify(params)}`,
  };
});

const alarm = vi.mocked(playDefconAlarm);

const W = MOD_CONFIG.defcon.announceWindowTicks;
/** DefconController's CATCHING_UP_THRESHOLD_TICKS (upstream HeadsUpMessage). */
const CATCH_UP_THRESHOLD = 10;
const LOCKED_HINT = `mod.defcon.locked_hint{"level":${MOD_CONFIG.defcon.nukeUnlockLevel}}`;

function gameConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    gameMap: GameMapType.Asia,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
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

function config(overrides: Partial<GameConfig> = {}, isReplay = false): Config {
  return new Config(gameConfig(overrides), null, isReplay);
}

const DEFCON_OFF = { mod: { defcon: { enabled: false } } };

/** Only what DefconController reads from a GameView. */
class FakeGame {
  tick = 0;
  /** This tick's ModDefcon updates; null = no update of that type. */
  updates: ModDefconUpdate[] | null = null;
  catchingUp = false;
  over = false;
  readUpdates = 0;

  constructor(private cfg: Config) {}

  config(): Config {
    return this.cfg;
  }
  ticks(): number {
    return this.tick;
  }
  isCatchingUp(): boolean {
    return this.catchingUp;
  }
  gameOver(): boolean {
    return this.over;
  }
  updatesSinceLastTick(): unknown {
    this.readUpdates++;
    if (this.updates === null) return null;
    return { [GameUpdateType.ModDefcon]: this.updates };
  }

  get view(): GameView {
    return this as unknown as GameView;
  }
}

interface Harness {
  game: FakeGame;
  view: GameView;
  controller: DefconController;
  events: DefconChangedEvent[];
}

function startGame(cfg: Config = config()): Harness {
  const game = new FakeGame(cfg);
  const bus = new EventBus();
  const events: DefconChangedEvent[] = [];
  bus.on(DefconChangedEvent, (e) => events.push(e));
  const controller = new DefconController(game.view, bus);
  controller.init();
  return { game, view: game.view, controller, events };
}

/** A ModDefcon update; `gameOver` is the simulation's verdict (a winner). */
function upd(
  level: number,
  previousLevel: number,
  reachedAtTick: number,
  gameOver = false,
): ModDefconUpdate {
  return {
    type: GameUpdateType.ModDefcon,
    level,
    previousLevel,
    reachedAtTick,
    gameOver,
  };
}

/** One game tick; `updates` are the ModDefcon updates of that tick. */
function step(h: Harness, ...updates: ModDefconUpdate[]): void {
  h.game.tick++;
  h.game.updates = updates.length === 0 ? null : updates;
  h.controller.tick();
}

/** `n` ticks without any ModDefcon update. */
function idle(h: Harness, n: number): void {
  for (let i = 0; i < n; i++) step(h);
}

/** A change to `level` that the core reached in this very tick. */
function stepChange(h: Harness, level: number, previousLevel: number): number {
  const tick = h.game.tick + 1;
  step(h, upd(level, previousLevel, tick));
  return tick;
}

function huds(): DefconHud[] {
  return [...document.querySelectorAll("mod-defcon-hud")] as DefconHud[];
}

function theHud(): DefconHud {
  const all = huds();
  expect(all).toHaveLength(1);
  expect(all[0]).toBeInstanceOf(DefconHud);
  return all[0];
}

function clean(text: string | null | undefined): string | null {
  return text === null || text === undefined
    ? null
    : text.replace(/\s+/g, " ").trim();
}

/** What the HUD shows once Lit has rendered. */
async function shown(hud: DefconHud = theHud()): Promise<{
  indicator: string | null;
  banner: string | null;
}> {
  await hud.updateComplete;
  return {
    indicator: clean(hud.querySelector('[role="status"]')?.textContent),
    banner: clean(hud.querySelector('[role="alert"]')?.textContent),
  };
}

function levelText(level: number): string {
  return `mod.defcon.level{"level":${level}}`;
}

function sidebarInContainer(): {
  container: HTMLElement;
  sidebar: HTMLElement;
} {
  const container = document.createElement("div");
  const sidebar = document.createElement("game-right-sidebar");
  const after = document.createElement("div");
  container.append(sidebar, after);
  document.body.append(container);
  return { container, sidebar };
}

beforeEach(() => {
  alarm.mockClear();
});

describe("DefconController: mounting the HUD", () => {
  it("mounts <mod-defcon-hud> right after <game-right-sidebar>", async () => {
    const { container, sidebar } = sidebarInContainer();
    startGame();

    const hud = theHud();
    expect(sidebar.nextElementSibling).toBe(hud);
    expect(hud.parentElement).toBe(container);
    expect(hud.floating).toBe(false);
    // Never swallows map clicks, and hangs below the stack instead of
    // growing it into a band that would.
    expect(hud.style.pointerEvents).toBe("none");
    expect(hud.style.position).toBe("absolute");
    expect(hud.style.top).toBe("100%");

    const view = await shown(hud);
    expect(view.indicator).toContain(levelText(5));
    expect(view.banner).toBeNull();
    // In the sidebar stack: not positioned by itself.
    expect(hud.querySelector('[role="status"]')?.className).not.toContain(
      "fixed",
    );
  });

  it("falls back to document.body (floating) without a sidebar", async () => {
    startGame();

    const hud = theHud();
    expect(hud.parentElement).toBe(document.body);
    expect(hud.floating).toBe(true);
    expect(hud.style.pointerEvents).toBe("none");
    expect(hud.style.position).toBe(""); // the indicator positions itself
    const view = await shown(hud);
    expect(view.indicator).toContain(levelText(5));
    expect(hud.querySelector('[role="status"]')?.className).toContain("fixed");
  });

  it("shows 'nukes from DEFCON 2' while locked", async () => {
    startGame();
    expect((await shown()).indicator).toContain(
      `mod.defcon.nukes_from{"level":${MOD_CONFIG.defcon.nukeUnlockLevel}}`,
    );
  });

  it("sets the client state for the menu hooks on init", () => {
    const cfg = config();
    const h = startGame(cfg);
    expect(defconClientState(h.view)).toEqual({
      level: 5,
      tuning: defconSettings(cfg),
      gameOver: false,
    });
    expect(modDefconBlocksUnitView(h.view, UnitType.AtomBomb)).toBe(true);
    expect(modDefconLockedHint(h.view, UnitType.AtomBomb)).toBe(LOCKED_HINT);
  });
});

describe("DefconController: a new game in the same page", () => {
  it("reuses the one HUD element and resets it", async () => {
    const { sidebar } = sidebarInContainer();
    const a = startGame();
    step(a, upd(5, 5, 0));
    stepChange(a, 4, 5);
    const hudA = theHud();
    let view = await shown(hudA);
    expect(view.indicator).toContain(levelText(4));
    expect(view.banner).toContain(levelText(4));
    expect(alarm).toHaveBeenCalledTimes(1);
    // A ends with a winner: its lock is lifted.
    step(a, upd(4, 5, 1, true));
    expect((await shown(hudA)).indicator).not.toContain(
      "mod.defcon.nukes_from",
    );

    // Second game, no reload: a new GameView and a new controller.
    const b = startGame();
    const hudB = theHud();
    expect(hudB).toBe(hudA);
    expect(sidebar.nextElementSibling).toBe(hudB);
    view = await shown(hudB);
    expect(view.indicator).toContain(levelText(5));
    expect(view.indicator).not.toContain(levelText(4));
    // B is not over: locked again.
    expect(view.indicator).toContain("mod.defcon.nukes_from");
    expect(view.banner).toBeNull();

    // Per-GameView client state: B starts at 5, A keeps its own.
    expect(defconClientState(b.view)).toMatchObject({
      level: 5,
      gameOver: false,
    });
    expect(defconClientState(a.view)).toMatchObject({
      level: 4,
      gameOver: true,
    });
    expect(modDefconBlocksUnitView(b.view, UnitType.AtomBomb)).toBe(true);
    expect(modDefconBlocksUnitView(a.view, UnitType.AtomBomb)).toBe(false);

    // B's announce state is fresh too: its first update is only a sync,
    // even at a lower level and within the announce window.
    b.game.tick = 1000;
    step(b, upd(3, 4, 1000));
    expect(b.events).toEqual([]);
    expect(alarm).toHaveBeenCalledTimes(1);
    view = await shown(hudB);
    expect(view.indicator).toContain(levelText(3));
    expect(view.banner).toBeNull();
    expect(theHud()).toBe(hudA);
  });

  it("moves a floating HUD after the sidebar of the next game", async () => {
    startGame();
    const hud = theHud();
    expect(hud.floating).toBe(true);

    const { sidebar } = sidebarInContainer();
    startGame();
    expect(theHud()).toBe(hud);
    expect(sidebar.nextElementSibling).toBe(hud);
    expect(hud.floating).toBe(false);
    await shown(hud);
    expect(hud.querySelector('[role="status"]')?.className).not.toContain(
      "fixed",
    );
  });
});

describe("DefconController: DEFCON disabled in GameConfig.mod", () => {
  it("shows no HUD and clears the client state", async () => {
    const game = new FakeGame(config(DEFCON_OFF));
    // A stale entry must not survive: the hooks go neutral.
    setDefconClientState(game.view, {
      level: 3,
      tuning: MOD_CONFIG.defcon,
      gameOver: false,
    });
    const bus = new EventBus();
    const events: DefconChangedEvent[] = [];
    bus.on(DefconChangedEvent, (e) => events.push(e));
    const h: Harness = {
      game,
      view: game.view,
      controller: new DefconController(game.view, bus),
      events,
    };
    h.controller.init();

    expect(huds()).toHaveLength(0);
    expect(defconClientState(h.view)).toBeNull();
    expect(modDefconBlocksUnitView(h.view, UnitType.AtomBomb)).toBe(false);
    expect(modDefconLockedHint(h.view, UnitType.AtomBomb)).toBeNull();

    // Even if updates arrived, the controller stays out of it.
    step(h, upd(5, 5, 0));
    stepChange(h, 4, 5);
    expect(h.game.readUpdates).toBe(0);
    expect(events).toEqual([]);
    expect(alarm).not.toHaveBeenCalled();
    expect(huds()).toHaveLength(0);
    expect(defconClientState(h.view)).toBeNull();
  });

  it("hides the HUD a previous game left behind", async () => {
    sidebarInContainer();
    const a = startGame();
    step(a, upd(5, 5, 0));
    stepChange(a, 4, 5);
    const hud = theHud();
    expect((await shown(hud)).banner).not.toBeNull();

    const b = startGame(config(DEFCON_OFF));
    expect(theHud()).toBe(hud);
    const view = await shown(hud);
    expect(view.indicator).toBeNull();
    expect(view.banner).toBeNull();
    expect(hud.textContent?.trim()).toBe("");
    expect(defconClientState(b.view)).toBeNull();
    step(b, upd(3, 4, b.game.tick + 1));
    expect(b.events).toEqual([]);
    expect((await shown(hud)).indicator).toBeNull();
  });
});

describe("DefconController: announcing changes", () => {
  it("treats the first update as a sync (no alarm, no event)", async () => {
    const h = startGame();
    step(h, upd(5, 5, 0));
    expect(h.events).toEqual([]);
    expect(alarm).not.toHaveBeenCalled();
    expect((await shown()).banner).toBeNull();
  });

  it("treats a late join at a lower level as a sync too", async () => {
    const h = startGame();
    // Reached one tick ago: well inside the announce window.
    h.game.tick = 500;
    step(h, upd(3, 4, 500));

    expect(h.events).toEqual([]);
    expect(alarm).not.toHaveBeenCalled();
    const view = await shown();
    expect(view.indicator).toContain(levelText(3));
    expect(view.banner).toBeNull();
    expect(defconClientState(h.view)?.level).toBe(3);
  });

  it("announces a lower level once: live event, one alarm, banner for exactly announceWindowTicks ticks", async () => {
    const h = startGame();
    step(h, upd(5, 5, 0));
    idle(h, 20);
    expect(alarm).not.toHaveBeenCalled();

    const changeTick = stepChange(h, 4, 5);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toBeInstanceOf(DefconChangedEvent);
    expect({ ...h.events[0] }).toEqual({
      level: 4,
      previousLevel: 5,
      reachedAtTick: changeTick,
      live: true,
    });
    expect(alarm).toHaveBeenCalledTimes(1);
    expect(defconClientState(h.view)?.level).toBe(4);

    let visibleTicks = 0;
    for (let guard = 0; guard < W * 3; guard++) {
      const view = await shown();
      if (view.banner === null) break;
      expect(view.banner).toContain(levelText(4));
      visibleTicks++;
      step(h);
    }
    expect(visibleTicks).toBe(W);
    expect(h.game.tick).toBe(changeTick + W);
    expect((await shown()).indicator).toContain(levelText(4));

    idle(h, 3 * W);
    expect(h.events).toHaveLength(1);
    expect(alarm).toHaveBeenCalledTimes(1);
  });

  it("names the released nukes on the banner at DEFCON 2 and drops the lock hint", async () => {
    const h = startGame();
    step(h, upd(3, 4, 0));
    stepChange(h, 2, 3);
    expect(alarm).toHaveBeenCalledTimes(1);
    const view = await shown();
    expect(view.banner).toContain(levelText(2));
    expect(view.banner).toContain("mod.defcon.nukes_released");
    expect(view.indicator).not.toContain("mod.defcon.nukes_from");
    expect(modDefconBlocksUnitView(h.view, UnitType.AtomBomb)).toBe(false);
    expect(modDefconLockedHint(h.view, UnitType.AtomBomb)).toBeNull();
  });

  it("announces each step of 5 -> 4 -> 3 -> 2 -> 1 exactly once", () => {
    const h = startGame();
    step(h, upd(5, 5, 0));
    const expected: object[] = [];
    for (const level of [4, 3, 2, 1]) {
      idle(h, 100);
      const tick = stepChange(h, level, level + 1);
      expected.push({
        level,
        previousLevel: level + 1,
        reachedAtTick: tick,
        live: true,
      });
      // Heartbeats of the same level never re-announce.
      idle(h, 10);
      step(h, upd(level, level + 1, tick));
    }
    expect(h.events.map((e) => ({ ...e }))).toEqual(expected);
    expect(alarm).toHaveBeenCalledTimes(4);
  });

  it("counts only the last of several updates in one tick", async () => {
    const h = startGame();
    step(h, upd(5, 5, 0));
    const tick = h.game.tick + 1;
    step(h, upd(4, 5, tick), upd(3, 4, tick));
    expect(h.events.map((e) => ({ ...e }))).toEqual([
      { level: 3, previousLevel: 4, reachedAtTick: tick, live: true },
    ]);
    expect(alarm).toHaveBeenCalledTimes(1);
    expect((await shown()).banner).toContain(levelText(3));
  });

  it("does nothing on a heartbeat with the same level", async () => {
    const h = startGame();
    step(h, upd(4, 5, 0));
    for (let i = 0; i < 5; i++) {
      idle(h, MOD_CONFIG.defcon.heartbeatTicks - 1);
      step(h, upd(4, 5, 0));
    }
    expect(h.events).toEqual([]);
    expect(alarm).not.toHaveBeenCalled();
    const view = await shown();
    expect(view.indicator).toContain(levelText(4));
    expect(view.banner).toBeNull();
    expect(defconClientState(h.view)?.level).toBe(4);
  });

  it("does not extend a banner on a heartbeat", async () => {
    const h = startGame();
    step(h, upd(5, 5, 0));
    const changeTick = stepChange(h, 4, 5);
    idle(h, W - 2);
    step(h, upd(4, 5, changeTick)); // tick changeTick + W - 1: still up
    expect((await shown()).banner).not.toBeNull();
    step(h); // changeTick + W
    expect((await shown()).banner).toBeNull();
    expect(h.events).toHaveLength(1);
    expect(alarm).toHaveBeenCalledTimes(1);
  });

  it("emits live=false and stays silent for a stale change", async () => {
    const h = startGame();
    step(h, upd(5, 5, 0));
    idle(h, 100);
    // First seen W ticks after it was reached (e.g. after a stall).
    const reached = h.game.tick + 1 - W;
    step(h, upd(4, 5, reached));
    expect(h.events.map((e) => ({ ...e }))).toEqual([
      { level: 4, previousLevel: 5, reachedAtTick: reached, live: false },
    ]);
    expect(alarm).not.toHaveBeenCalled();
    const view = await shown();
    expect(view.banner).toBeNull();
    expect(view.indicator).toContain(levelText(4));
  });
});

describe("DefconController: catching up, replays, game over", () => {
  it(`is silent while catching up for >= ${CATCH_UP_THRESHOLD} ticks, and never catches up on the banner`, async () => {
    const h = startGame();
    step(h, upd(5, 5, 0));

    h.game.catchingUp = true;
    idle(h, CATCH_UP_THRESHOLD - 1);
    const tick = stepChange(h, 4, 5); // the 10th catching-up tick
    expect(h.events.map((e) => ({ ...e }))).toEqual([
      { level: 4, previousLevel: 5, reachedAtTick: tick, live: false },
    ]);
    expect(alarm).not.toHaveBeenCalled();
    expect((await shown()).banner).toBeNull();
    expect((await shown()).indicator).toContain(levelText(4));

    // Caught up: no late banner for that change, and heartbeats stay quiet.
    h.game.catchingUp = false;
    idle(h, 5);
    step(h, upd(4, 5, tick));
    expect(h.events).toHaveLength(1);
    expect(alarm).not.toHaveBeenCalled();
    expect((await shown()).banner).toBeNull();

    // The next change is announced normally.
    idle(h, 100);
    stepChange(h, 3, 4);
    expect(h.events).toHaveLength(2);
    expect(h.events[1].live).toBe(true);
    expect(alarm).toHaveBeenCalledTimes(1);
    expect((await shown()).banner).toContain(levelText(3));
  });

  it(`still announces after a catch-up blip shorter than ${CATCH_UP_THRESHOLD} ticks`, async () => {
    const h = startGame();
    step(h, upd(5, 5, 0));

    h.game.catchingUp = true;
    idle(h, CATCH_UP_THRESHOLD - 2);
    stepChange(h, 4, 5); // the 9th catching-up tick
    expect(h.events.map((e) => e.live)).toEqual([true]);
    expect(alarm).toHaveBeenCalledTimes(1);

    // The count restarts once the client has caught up.
    h.game.catchingUp = false;
    step(h);
    h.game.catchingUp = true;
    idle(h, CATCH_UP_THRESHOLD - 2);
    stepChange(h, 3, 4);
    expect(h.events.map((e) => e.live)).toEqual([true, true]);
    expect(alarm).toHaveBeenCalledTimes(2);
  });

  it("never plays the alarm in a replay", async () => {
    const h = startGame(config({}, true));
    step(h, upd(5, 5, 0));
    for (const level of [4, 3, 2, 1]) {
      idle(h, 100);
      stepChange(h, level, level + 1);
    }
    expect(h.events.map((e) => [e.level, e.live])).toEqual([
      [4, false],
      [3, false],
      [2, false],
      [1, false],
    ]);
    expect(alarm).not.toHaveBeenCalled();
    const view = await shown();
    expect(view.banner).toBeNull();
    // Replays still show the level.
    expect(view.indicator).toContain(levelText(1));
  });

  it("never plays the alarm once the GameView is over, but keeps the simulation's lock", async () => {
    const h = startGame();
    step(h, upd(4, 5, 0));
    expect((await shown()).indicator).toContain("mod.defcon.nukes_from");

    // The client's game over (e.g. a cancelled game, no winner): the level
    // drops in the very tick the game ends, the simulation still locks.
    h.game.over = true;
    const tick = stepChange(h, 3, 4);
    expect(alarm).not.toHaveBeenCalled();
    let view = await shown();
    expect(view.banner).toBeNull();
    expect(view.indicator).toContain(levelText(3));
    expect(view.indicator).toContain("mod.defcon.nukes_from");
    expect(defconClientState(h.view)?.gameOver).toBe(false);
    expect(modDefconBlocksUnitView(h.view, UnitType.AtomBomb)).toBe(true);
    expect(modDefconLockedHint(h.view, UnitType.AtomBomb)).toBe(LOCKED_HINT);

    idle(h, 100);
    stepChange(h, 2, 3);

    expect(h.events.map((e) => ({ ...e }))).toEqual([
      { level: 3, previousLevel: 4, reachedAtTick: tick, live: false },
      {
        level: 2,
        previousLevel: 3,
        reachedAtTick: tick + 101,
        live: false,
      },
    ]);
    expect(alarm).not.toHaveBeenCalled();
    view = await shown();
    expect(view.banner).toBeNull();
    expect(view.indicator).toContain(levelText(2));
    expect(view.indicator).not.toContain("mod.defcon.nukes_from");
  });

  it("lifts the lock in the HUD and the hooks on the simulation's game over, silently", async () => {
    const h = startGame();
    step(h, upd(4, 5, 0));
    expect((await shown()).indicator).toContain("mod.defcon.nukes_from");
    expect(modDefconBlocksUnitView(h.view, UnitType.AtomBomb)).toBe(true);

    // A winner: the core sends the frozen level once more, with gameOver.
    step(h, upd(4, 5, 0, true));
    expect(h.events).toEqual([]);
    expect(alarm).not.toHaveBeenCalled();
    expect(defconClientState(h.view)).toMatchObject({
      level: 4,
      gameOver: true,
    });
    expect(modDefconBlocksUnitView(h.view, UnitType.AtomBomb)).toBe(false);
    expect(modDefconLockedHint(h.view, UnitType.AtomBomb)).toBeNull();
    let view = await shown();
    expect(view.indicator).toContain(levelText(4));
    expect(view.indicator).not.toContain("mod.defcon.nukes_from");
    expect(view.banner).toBeNull();

    // A drop that arrives together with the game over is never announced,
    // even though the GameView does not know yet that the game is over.
    expect(h.game.over).toBe(false);
    const tick = h.game.tick + 1;
    step(h, upd(3, 4, tick, true));
    expect(h.events.map((e) => ({ ...e }))).toEqual([
      { level: 3, previousLevel: 4, reachedAtTick: tick, live: false },
    ]);
    expect(alarm).not.toHaveBeenCalled();
    view = await shown();
    expect(view.banner).toBeNull();
    expect(view.indicator).toContain(levelText(3));
    expect(view.indicator).not.toContain("mod.defcon.nukes_from");
  });
});

describe("DefconController: errors never escape", () => {
  it("switches the DEFCON UI off when tick() throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = startGame();
      step(h, upd(4, 5, 0));
      expect((await shown()).indicator).toContain(levelText(4));

      h.game.updatesSinceLastTick = () => {
        throw new Error("boom");
      };
      expect(() => step(h)).not.toThrow();
      expect(error).toHaveBeenCalledTimes(1);

      // HUD hidden (element kept for the next game), hooks neutral.
      const hud = theHud();
      const view = await shown(hud);
      expect(view.indicator).toBeNull();
      expect(view.banner).toBeNull();
      expect(defconClientState(h.view)).toBeNull();
      expect(modDefconBlocksUnitView(h.view, UnitType.AtomBomb)).toBe(false);
      expect(modDefconLockedHint(h.view, UnitType.AtomBomb)).toBeNull();

      // It stays off: later ticks read nothing and announce nothing.
      const reads = vi.fn(() => ({
        [GameUpdateType.ModDefcon]: [upd(3, 4, h.game.tick + 1)],
      }));
      h.game.updatesSinceLastTick = reads;
      expect(() => idle(h, 5)).not.toThrow();
      expect(reads).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
      expect(alarm).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect((await shown(hud)).indicator).toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  it("switches the DEFCON UI off when an event listener throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const game = new FakeGame(config());
      const bus = new EventBus();
      bus.on(DefconChangedEvent, () => {
        throw new Error("listener");
      });
      const controller = new DefconController(game.view, bus);
      controller.init();
      const h: Harness = { game, view: game.view, controller, events: [] };
      step(h, upd(5, 5, 0));
      expect(() => stepChange(h, 4, 5)).not.toThrow();
      expect(error).toHaveBeenCalledTimes(1);
      expect(defconClientState(h.view)).toBeNull();
      expect((await shown()).indicator).toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  it("does not throw out of init() and stays off", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const game = new FakeGame(config());
      game.config = () => {
        throw new Error("no config");
      };
      const controller = new DefconController(game.view, new EventBus());
      expect(() => controller.init()).not.toThrow();
      expect(error).toHaveBeenCalledTimes(1);
      expect(huds()).toHaveLength(0);
      expect(defconClientState(game.view)).toBeNull();

      const h: Harness = { game, view: game.view, controller, events: [] };
      expect(() => step(h, upd(5, 5, 0))).not.toThrow();
      expect(game.readUpdates).toBe(0);
      expect(alarm).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
