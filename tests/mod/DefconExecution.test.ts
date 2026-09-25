import { describe, expect, test, vi } from "vitest";
import { Config } from "../../src/core/configuration/Config";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import { BreakAllianceExecution } from "../../src/core/execution/alliance/BreakAllianceExecution";
import { AttackExecution } from "../../src/core/execution/AttackExecution";
import { DoomsdayClockExecution } from "../../src/core/execution/DoomsdayClockExecution";
import {
  Execution,
  Game,
  GameMode,
  GameType,
  Player,
  PlayerInfo,
  PlayerType,
  RankedType,
  UnitType,
} from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import { GameConfig } from "../../src/core/Schemas";
import { DefconExecution } from "../../src/mod/core/defcon/DefconExecution";
import {
  NUKE_WEAPON_TYPES,
  nukesPossible,
  scaleForTimer,
} from "../../src/mod/core/defcon/DefconRules";
import { defconSettings } from "../../src/mod/core/defcon/DefconSettings";
import {
  defconLevel,
  defconReachedAtTick,
  modDefconBlocksUnit,
  modDefconNukesLocked,
  modDefconOnBetrayal,
} from "../../src/mod/core/defcon/DefconState";
import { ModDefconUpdate } from "../../src/mod/core/defcon/DefconUpdate";
import {
  DefconStepLevel,
  DefconTuning,
  MOD_CONFIG,
} from "../../src/mod/core/ModConfig";
import { modInitExecutions } from "../../src/mod/core/ModExecutions";
import { MapPlaylist } from "../../src/server/MapPlaylist";
import { playerInfo, setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";
import { executeTicks } from "../util/utils";

// DefconExecution in a real game (setup() + real executions).
//
// How a bonus is observed: with FAST, DEFCON 4 comes by time alone exactly
// FAST.latestTicks[4] ticks after the escalation clock starts. Every counted
// conflict or betrayal moves the clock forward, so DEFCON 4 comes that many
// ticks earlier. bonusAtDefcon4() measures exactly that: public level() and
// reachedAtTick() only, no private state. Every event in these tests happens
// long before DEFCON 4 would be reached, so the measurement is exact.
//
// The clock starts on the first tick without spawn immunity. startDefcon()
// initialises DEFCON on the game's first tick, so without peace time the
// clock starts on the tick right after it.

const FAST: DefconTuning = {
  ...MOD_CONFIG.defcon,
  enabled: true,
  lockNukes: true,
  nukeUnlockLevel: 2,
  latestTicks: { 4: 1500, 3: 2000, 2: 2500, 1: 3000 },
  earliestTicks: { 4: 0, 3: 0, 2: 0, 1: 0 },
  minTicksBetweenSteps: 0,
  newConflictBonusTicks: 100,
  conflictQuietTicks: 200,
  betrayalBonusTicks: 40,
  betrayalCooldownTicks: 150,
  nationVsNationPercent: 50,
  referencePlayers: 8,
  heartbeatTicks: 50,
};
const CONFLICT = FAST.newConflictBonusTicks;
const BETRAYAL = FAST.betrayalBonusTicks;
const QUIET = FAST.conflictQuietTicks;
const COOLDOWN = FAST.betrayalCooldownTicks;
/** Weight of a nation-vs-nation event under FAST (50%). */
function nationWeighted(ticks: number): number {
  return Math.floor((ticks * FAST.nationVsNationPercent) / 100);
}

const STEP_LEVELS: DefconStepLevel[] = [4, 3, 2, 1];
const ALL_NUKES = [...NUKE_WEAPON_TYPES];
const LONG = 30_000; // ms, for games run with the shipped (minutes long) tuning

// --- Game helpers ----------------------------------------------------------

function plainsGame(
  config: Partial<GameConfig> = {},
  humans: PlayerInfo[] = [],
): Promise<Game> {
  return setup("plains", { instantBuild: true, ...config }, humans);
}

function giveLand(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  w = 20,
  h = 20,
): Player {
  for (let x = x0; x < x0 + w; x++) {
    for (let y = y0; y < y0 + h; y++) p.conquer(game.ref(x, y));
  }
  return p;
}

function addPlayer(
  game: Game,
  name: string,
  type: PlayerType,
  x0: number,
  y0: number,
  w = 20,
  h = 20,
): Player {
  return giveLand(game, game.addPlayer(playerInfo(name, type)), x0, y0, w, h);
}
const human = (g: Game, n: string, x: number, y: number, w = 20, h = 20) =>
  addPlayer(g, n, PlayerType.Human, x, y, w, h);
const nation = (g: Game, n: string, x: number, y: number, w = 20, h = 20) =>
  addPlayer(g, n, PlayerType.Nation, x, y, w, h);
const tribe = (g: Game, n: string, x: number, y: number, w = 20, h = 20) =>
  addPlayer(g, n, PlayerType.Bot, x, y, w, h);

/** A human with a fixed team slot, as the matchmaker hands them out. */
function pinned(name: string, teamIndex: number): PlayerInfo {
  return new PlayerInfo(
    name,
    PlayerType.Human,
    name,
    name,
    false,
    null,
    [],
    teamIndex,
  );
}

/** Adds DEFCON and runs its init tick. */
function startDefcon(game: Game, tuning: DefconTuning = FAST): DefconExecution {
  const exec = new DefconExecution(game, tuning);
  game.addExecution(exec);
  game.executeNextTick();
  expect(exec.reachedAtTick(5)).toBe(game.ticks() - 1);
  return exec;
}

/**
 * Starts a real attack (null = neutral land) and checks it really exists. A
 * second click on the same target merges into the running attack (upstream).
 */
function startAttack(
  game: Game,
  from: Player,
  to: Player | null,
  troops = 20,
): void {
  const target = to ?? game.terraNullius();
  game.addExecution(new AttackExecution(troops, from, target.id()));
  game.executeNextTick(); // init: the attack exists from now on
  expect(from.outgoingAttacks().some((a) => a.target() === target)).toBe(true);
}

/** Runs until `p` has no attack left; returns the last tick one was seen. */
function finishAttacks(game: Game, p: Player, maxTicks = 2000): number {
  let n = 0;
  while (p.outgoingAttacks().length > 0) {
    if (n++ >= maxTicks) throw new Error("attack did not end");
    game.executeNextTick();
  }
  return game.ticks() - 1;
}

function runUntilTick(game: Game, tick: number): void {
  expect(game.ticks()).toBeLessThanOrEqual(tick);
  while (game.ticks() < tick) game.executeNextTick();
}

/** Runs until DEFCON `level` is reached; returns the tick it was reached. */
function runUntilLevel(
  game: Game,
  exec: DefconExecution,
  level: number,
  maxTicks: number,
): number {
  let n = 0;
  while (exec.level() > level) {
    if (n++ >= maxTicks) {
      throw new Error(`DEFCON ${level} not reached, still ${exec.level()}`);
    }
    game.executeNextTick();
  }
  return exec.reachedAtTick(level)!;
}

/** The bonus the escalation clock collected, measured at DEFCON 4. */
function bonusAtDefcon4(
  game: Game,
  exec: DefconExecution,
  clockStart: number,
): number {
  const reached = runUntilLevel(game, exec, 4, FAST.latestTicks[4] + 10);
  return FAST.latestTicks[4] - (reached - clockStart);
}

function ally(game: Game, a: Player, b: Player): void {
  game.addExecution(new AllianceRequestExecution(a, b.id()));
  game.executeNextTick();
  game.addExecution(new AllianceRequestExecution(b, a.id()));
  game.executeNextTick();
  expect(a.isAlliedWith(b)).toBe(true);
}

/** Breaks the alliance the way a player's intent does. */
function betray(game: Game, traitor: Player, victim: Player): void {
  game.addExecution(new BreakAllianceExecution(traitor, victim.id()));
  executeTicks(game, 2);
  expect(traitor.isAlliedWith(victim)).toBe(false);
}

function buildableNukes(p: Player, target: TileRef): UnitType[] {
  return ALL_NUKES.filter((t) => p.canBuild(t, target) !== false);
}

/**
 * Ticks after the clock start at which each level comes, when `bonus` is
 * all collected right at the start.
 */
function expectedOffsets(t: DefconTuning, bonus: number): number[] {
  const out: number[] = [];
  let prev: number | null = null;
  for (const l of STEP_LEVELS) {
    let off = Math.max(t.latestTicks[l] - bonus, t.earliestTicks[l], 0);
    if (prev !== null) off = Math.max(off, prev + t.minTicksBetweenSteps);
    out.push(off);
    prev = off;
  }
  return out;
}

function offsets(exec: DefconExecution, clockStart: number): number[] {
  return STEP_LEVELS.map((l) => exec.reachedAtTick(l)! - clockStart);
}

// --- Conflicts ---------------------------------------------------------------

describe("DefconExecution: conflicts", () => {
  test("expansion into neutral land never counts", async () => {
    const game = await plainsGame();
    const a = human(game, "a", 0, 0);
    nation(game, "n", 60, 60);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    startAttack(game, a, null, 50);
    finishAttacks(game, a);
    expect(a.numTilesOwned()).toBeGreaterThan(400);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(0);
  });

  test("attacks on tribes and by tribes never count", async () => {
    const game = await plainsGame();
    const a = human(game, "a", 0, 0);
    const t = tribe(game, "t", 20, 0);
    const n = nation(game, "n", 40, 0);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    startAttack(game, a, t); // human -> tribe
    startAttack(game, n, t); // nation -> tribe
    finishAttacks(game, a);
    finishAttacks(game, n);
    startAttack(game, t, a); // tribe -> human
    finishAttacks(game, t);
    startAttack(game, t, n); // tribe -> nation
    finishAttacks(game, t);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(0);
  });

  test("a Human attacking a Nation counts once", async () => {
    const game = await plainsGame();
    const a = human(game, "a", 0, 0);
    const n = nation(game, "n", 20, 0);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    startAttack(game, a, n);
    finishAttacks(game, a);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(CONFLICT);
  });

  test("a Human attacking a Human counts once per pair, whoever attacks", async () => {
    const game = await plainsGame();
    const a = human(game, "a", 0, 0);
    const b = human(game, "b", 20, 0);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    startAttack(game, a, b);
    finishAttacks(game, a);
    startAttack(game, b, a); // the other direction is the same pair
    finishAttacks(game, b);
    startAttack(game, a, b); // and again, click spam
    startAttack(game, a, b);
    const lastSeen = finishAttacks(game, a);
    expect(lastSeen - clockStart).toBeLessThan(QUIET);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(CONFLICT);
  });

  test("different pairs count separately, also in the same tick", async () => {
    const game = await plainsGame();
    const b = human(game, "b", 0, 0);
    const a = human(game, "a", 20, 0);
    const c = nation(game, "c", 40, 0);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    game.addExecution(
      new AttackExecution(20, a, b.id()),
      new AttackExecution(20, a, c.id()),
    );
    game.executeNextTick();
    expect(a.outgoingAttacks()).toHaveLength(2);
    finishAttacks(game, a);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(2 * CONFLICT);
  });

  test("the same pair counts again only after the quiet window", async () => {
    const game = await plainsGame();
    const a = human(game, "a", 0, 0);
    const b = human(game, "b", 20, 0);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    startAttack(game, a, b); // counts
    const last1 = finishAttacks(game, a);

    // Created at the end of this tick, first seen one tick later: one tick
    // short of the quiet window after the last attack. Not a new conflict.
    runUntilTick(game, last1 + QUIET - 2);
    startAttack(game, a, b);
    const last2 = finishAttacks(game, a);

    // First seen exactly QUIET ticks after the last attack: new again.
    runUntilTick(game, last2 + QUIET - 1);
    startAttack(game, a, b);
    finishAttacks(game, a);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(2 * CONFLICT);
  });

  test("nation-vs-nation conflicts use nationVsNationPercent", async () => {
    const game = await plainsGame();
    const n1 = nation(game, "n1", 0, 0);
    const n2 = nation(game, "n2", 20, 0);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    startAttack(game, n1, n2);
    finishAttacks(game, n1);

    expect(nationWeighted(CONFLICT)).toBe(CONFLICT / 2);
    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(
      nationWeighted(CONFLICT),
    );
  });

  test("a Human-Nation conflict is not weighted, a Nation-Nation one is", async () => {
    const game = await plainsGame();
    const h = human(game, "h", 0, 0);
    const n1 = nation(game, "n1", 20, 0);
    const n2 = nation(game, "n2", 40, 0);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    startAttack(game, n1, h); // nation attacking a human: full weight
    startAttack(game, n1, n2); // nation vs nation: weighted
    finishAttacks(game, n1);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(
      CONFLICT + nationWeighted(CONFLICT),
    );
  });

  test("big lobbies shrink the bonus (reference / alive real players)", async () => {
    const game = await plainsGame();
    const players: Player[] = [];
    for (let i = 0; i < 16; i++) {
      players.push(
        human(game, `p${i}`, (i % 4) * 25, Math.floor(i / 4) * 25, 25, 25),
      );
    }
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    startAttack(game, players[0], players[1]);
    finishAttacks(game, players[0]);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(
      Math.floor((CONFLICT * FAST.referencePlayers) / 16),
    );
  });

  test("only living humans and nations shrink the bonus, not tribes or dead players", async () => {
    const game = await plainsGame();
    const players: Player[] = [];
    for (let i = 0; i < 12; i++) {
      players.push(
        human(game, `p${i}`, (i % 4) * 25, Math.floor(i / 4) * 25, 25, 25),
      );
    }
    for (let i = 0; i < 20; i++) tribe(game, `t${i}`, i * 5, 75, 5, 25);
    // Players without land: never spawned or eliminated.
    for (let i = 0; i < 6; i++) {
      const dead = game.addPlayer(playerInfo(`dead${i}`, PlayerType.Human));
      expect(dead.isAlive()).toBe(false);
    }
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    startAttack(game, players[0], players[1]);
    finishAttacks(game, players[0]);

    // 12 living real players; the 20 tribes and 6 dead humans do not count.
    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(
      Math.floor((CONFLICT * FAST.referencePlayers) / 12),
    );
  });

  test("an attack on a disconnected player does not count", async () => {
    const game = await plainsGame();
    const a = human(game, "a", 0, 0);
    const b = human(game, "b", 20, 0);
    b.markDisconnected(true);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    startAttack(game, a, b);
    finishAttacks(game, a);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(0);
  });
});

// --- Betrayals ---------------------------------------------------------------

describe("DefconExecution: betrayals", () => {
  test("a real betrayal counts", async () => {
    const game = await plainsGame();
    const a = human(game, "a", 0, 0);
    const b = human(game, "b", 20, 0);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    ally(game, a, b);
    betray(game, a, b);
    expect(a.isTraitor()).toBe(true);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(BETRAYAL);
  });

  test("betraying a tribe, or a tribe betraying, does not count", async () => {
    const game = await plainsGame();
    const a = human(game, "a", 0, 0);
    const t1 = tribe(game, "t1", 20, 0);
    const c = nation(game, "c", 40, 0);
    const t2 = tribe(game, "t2", 60, 0);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    ally(game, a, t1);
    betray(game, a, t1); // human betrays a tribe
    expect(a.isTraitor()).toBe(true);
    ally(game, t2, c);
    betray(game, t2, c); // tribe betrays a nation
    expect(t2.isTraitor()).toBe(true);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(0);
  });

  test("an alliance that expires does not count", async () => {
    const game = await plainsGame();
    const a = human(game, "a", 0, 0);
    const b = nation(game, "b", 20, 0);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    ally(game, a, b);
    game.expireAlliance(a.allianceWith(b)!);
    expect(a.isAlliedWith(b)).toBe(false);
    expect(a.isTraitor()).toBe(false);
    expect(b.isTraitor()).toBe(false);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(0);
  });

  test("breaking with a traitor does not count", async () => {
    const game = await plainsGame();
    const a = human(game, "a", 0, 0);
    const b = human(game, "b", 20, 0);
    const c = human(game, "c", 0, 20);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    ally(game, a, b);
    ally(game, c, a);
    betray(game, a, b); // counts, a is a traitor now
    betray(game, c, a); // leaving a traitor is no betrayal
    expect(c.isTraitor()).toBe(false);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(BETRAYAL);
  });

  test("at most one counted betrayal per traitor within the cooldown", async () => {
    const game = await plainsGame();
    const t = human(game, "t", 0, 0);
    const v1 = human(game, "v1", 20, 0);
    const v2 = human(game, "v2", 40, 0);
    const v3 = human(game, "v3", 60, 0);
    const v4 = human(game, "v4", 80, 0);
    const u = nation(game, "u", 0, 20);
    const w = human(game, "w", 20, 20);
    const exec = startDefcon(game);
    const clockStart = game.ticks();
    for (const v of [v1, v2, v3, v4]) ally(game, t, v);
    ally(game, u, w);

    // Direct calls, so each break happens on an exact tick.
    const breakWith = (traitor: Player, victim: Player) =>
      traitor.breakAlliance(traitor.allianceWith(victim)!);
    const x = game.ticks();
    breakWith(t, v1); // counts
    runUntilTick(game, x + 10);
    breakWith(t, v2); // same traitor, within the cooldown
    breakWith(u, w); // another traitor: counts
    runUntilTick(game, x + COOLDOWN - 1);
    breakWith(t, v3); // one tick short of the cooldown
    runUntilTick(game, x + COOLDOWN);
    breakWith(t, v4); // cooldown over: counts
    expect(game.ticks() - clockStart).toBeLessThan(COOLDOWN + 100);

    // t: v1 and v4; u: w.
    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(3 * BETRAYAL);
  });

  test("a nation betraying a nation uses nationVsNationPercent", async () => {
    const game = await plainsGame();
    const n1 = nation(game, "n1", 0, 0);
    const n2 = nation(game, "n2", 20, 0);
    const h = human(game, "h", 0, 20);
    const n3 = nation(game, "n3", 20, 20);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    ally(game, n1, n2);
    ally(game, h, n3);
    betray(game, n1, n2); // weighted
    betray(game, h, n3); // human betrays a nation: full weight

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(
      nationWeighted(BETRAYAL) + BETRAYAL,
    );
  });
});

// --- Time, level, game over, updates -----------------------------------------

describe("DefconExecution: time and level", () => {
  test(
    "time alone reaches every level at the configured ticks (shipped tuning)",
    async () => {
      const game = await plainsGame();
      human(game, "a", 0, 0);
      nation(game, "n", 60, 60);
      // No timer: the resolver hands out MOD_CONFIG unchanged.
      expect(defconSettings(game.config())).toEqual(MOD_CONFIG.defcon);
      const exec = new DefconExecution(game); // default: defconSettings()
      game.addExecution(exec);
      game.executeNextTick();
      const clockStart = game.ticks();

      const levels: number[] = [];
      const d = MOD_CONFIG.defcon;
      while (game.ticks() < clockStart + d.latestTicks[1] + 600) {
        game.executeNextTick();
        levels.push(exec.level());
      }

      // With the shipped numbers: 3:12 / 6:24 / 9:36 / 12:48.
      expect(offsets(exec, clockStart)).toEqual(expectedOffsets(d, 0));
      for (const l of STEP_LEVELS) {
        expect(exec.reachedAtTick(l)).toBe(clockStart + d.latestTicks[l]);
        // One tick earlier it was still the level above.
        expect(levels[exec.reachedAtTick(l)! - clockStart - 1]).toBe(l + 1);
        expect(defconReachedAtTick(game, l)).toBe(exec.reachedAtTick(l));
      }
      expect(exec.level()).toBe(1);
      expect(defconLevel(game)).toBe(1);
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i]).toBeLessThanOrEqual(levels[i - 1]);
      }
    },
    LONG,
  );

  test(
    "however much fighting: one level at a time, never before its earliest time, never back up",
    async () => {
      const game = await plainsGame();
      const players: Player[] = [];
      for (let i = 0; i < 8; i++) {
        players.push(
          human(game, `p${i}`, (i % 4) * 25, Math.floor(i / 4) * 50, 25, 50),
        );
      }
      const d = MOD_CONFIG.defcon;
      const exec = startDefcon(game, d);
      const clockStart = game.ticks();

      // Every pair starts a war: 28 new conflicts at once.
      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          game.addExecution(
            new AttackExecution(5, players[i], players[j].id()),
          );
        }
      }
      game.executeNextTick();
      const running = players.reduce(
        (sum, p) => sum + p.outgoingAttacks().length,
        0,
      );
      expect(running).toBe(28);
      const bonus = 28 * d.newConflictBonusTicks; // 8 players: full weight
      // Precondition: that is enough bonus for the clock to never be what
      // holds a level back. Only earliest times and the step gap decide.
      for (const l of STEP_LEVELS) {
        expect(d.latestTicks[l] - bonus).toBeLessThanOrEqual(
          d.earliestTicks[l],
        );
      }

      const levels: number[] = [exec.level()];
      while (game.ticks() < clockStart + d.latestTicks[1] + 1000) {
        game.executeNextTick();
        levels.push(exec.level());
      }

      expect(offsets(exec, clockStart)).toEqual(expectedOffsets(d, bonus));
      let lastStep: number | null = null;
      for (let i = 1; i < levels.length; i++) {
        const diff = levels[i - 1] - levels[i];
        expect(diff === 0 || diff === 1).toBe(true); // never up, one at a time
        if (diff === 1) {
          if (lastStep !== null) {
            expect(i - lastStep).toBeGreaterThanOrEqual(d.minTicksBetweenSteps);
          }
          lastStep = i;
        }
      }
      for (const l of STEP_LEVELS) {
        expect(exec.reachedAtTick(l)! - clockStart).toBeGreaterThanOrEqual(
          d.earliestTicks[l],
        );
      }
      expect(levels[levels.length - 1]).toBe(1); // and stays at 1
    },
    LONG,
  );

  test("after a winner the level freezes and the lock lifts", async () => {
    const game = await plainsGame();
    const a = human(game, "a", 0, 0);
    const n = nation(game, "n", 20, 0);
    const exec = startDefcon(game);
    runUntilLevel(game, exec, 4, FAST.latestTicks[4] + 10);
    expect(modDefconNukesLocked(game)).toBe(true);
    expect(modDefconBlocksUnit(game, UnitType.AtomBomb)).toBe(true);

    game.setWinner(a, game.stats().stats());
    expect(modDefconNukesLocked(game)).toBe(false);
    for (const t of ALL_NUKES) {
      expect(modDefconBlocksUnit(game, t)).toBe(false);
    }
    // The very next tick tells the client (lock lifted), exactly once.
    const told = game.executeNextTick()[GameUpdateType.ModDefcon];
    expect(told).toEqual([
      {
        type: GameUpdateType.ModDefcon,
        level: 4,
        previousLevel: 5,
        reachedAtTick: exec.reachedAtTick(4),
        gameOver: true,
      },
    ]);

    // Past every threshold, with fighting and betrayals: nothing moves.
    startAttack(game, a, n);
    ally(game, a, human(game, "b", 0, 20));
    betray(game, a, game.player("b"));
    const heartbeats: ModDefconUpdate[] = [];
    while (game.ticks() < FAST.latestTicks[1] + 500) {
      heartbeats.push(...game.executeNextTick()[GameUpdateType.ModDefcon]);
    }
    expect(exec.level()).toBe(4);
    expect(exec.reachedAtTick(3)).toBeNull();
    expect(defconLevel(game)).toBe(4);
    // Heartbeats still go out, with the frozen level.
    expect(heartbeats.length).toBeGreaterThan(0);
    for (const u of heartbeats) {
      expect(u.level).toBe(4);
      expect(u.gameOver).toBe(true);
    }
    // Only heartbeats after the first notice: never two in one tick.
    for (const u of heartbeats) {
      expect(u.reachedAtTick).toBe(exec.reachedAtTick(4));
    }
  });

  test("ModDefcon updates: on init, on every change and as heartbeat", async () => {
    const game = await plainsGame();
    const a = human(game, "a", 0, 0);
    const n = nation(game, "n", 20, 0);
    const exec = new DefconExecution(game, FAST);
    game.addExecution(exec);

    const byTick = new Map<number, ModDefconUpdate[]>();
    const levelAfter = new Map<number, number>();
    const record = () => {
      const t = game.ticks();
      byTick.set(t, game.executeNextTick()[GameUpdateType.ModDefcon]);
      levelAfter.set(t, exec.level());
    };
    record(); // init
    record();
    startAttack(game, a, n); // a bonus, so steps do not land on round ticks
    while (exec.level() > 1 || game.ticks() < FAST.latestTicks[1] + 200) {
      record();
    }

    // Init: the start level, once.
    expect(byTick.get(0)).toEqual([
      {
        type: GameUpdateType.ModDefcon,
        level: 5,
        previousLevel: 5,
        reachedAtTick: 0,
        gameOver: false,
      },
    ]);
    const changes = new Set(STEP_LEVELS.map((l) => exec.reachedAtTick(l)!));
    expect([...changes].some((t) => t % FAST.heartbeatTicks !== 0)).toBe(true);
    for (const [t, updates] of byTick) {
      if (t === 0) continue;
      const level = levelAfter.get(t)!;
      if (changes.has(t)) {
        expect(updates).toEqual([
          {
            type: GameUpdateType.ModDefcon,
            level,
            previousLevel: level + 1,
            reachedAtTick: t,
            gameOver: false,
          },
        ]);
      } else if (t % FAST.heartbeatTicks === 0) {
        expect(updates).toEqual([
          {
            type: GameUpdateType.ModDefcon,
            level,
            previousLevel: level === 5 ? 5 : level + 1,
            reachedAtTick: exec.reachedAtTick(level),
            gameOver: false,
          },
        ]);
      } else {
        expect(updates).toEqual([]);
      }
    }
  });
});

// --- Host settings -----------------------------------------------------------

interface ScenarioResult {
  game: Game;
  exec: DefconExecution;
  offsets: number[];
  expectedBonus: number;
  buildableAtStart: UnitType[];
  buildableAtEnd: UnitType[];
}

/**
 * The same small game under different host settings. DEFCON starts the real
 * way (modInitExecutions, the GameRunner hook) with the shipped tuning. One
 * Human->Nation conflict and one Human->Human betrayal (if alliances are on),
 * then time until DEFCON 1. Player "a" owns a missile silo when silos are
 * allowed, so which nukes it could launch is checked at start and end.
 */
async function scenario(
  config: Partial<GameConfig> = {},
  extraExecutions: (game: Game) => Execution[] = () => [],
  onTick: (game: Game) => void = () => {},
): Promise<ScenarioResult> {
  const game = await plainsGame(config);
  const a = human(game, "a", 0, 0);
  const n = nation(game, "n", 20, 0);
  const b = human(game, "b", 0, 20);
  a.addGold(10n ** 12n);
  if (!game.config().isUnitDisabled(UnitType.MissileSilo)) {
    a.buildUnit(UnitType.MissileSilo, game.ref(2, 2), {});
  }
  const target = game.ref(35, 10);

  const execs = modInitExecutions(game);
  expect(execs).toHaveLength(1);
  const exec = execs[0] as DefconExecution;
  game.addExecution(...execs, ...extraExecutions(game));
  game.executeNextTick();
  const clockStart = game.ticks();
  const buildableAtStart = buildableNukes(a, target);

  const tuning = defconSettings(game.config());
  let expectedBonus = 0;
  startAttack(game, a, n);
  expectedBonus += tuning.newConflictBonusTicks;
  if (game.config().disableAlliances()) {
    game.addExecution(new AllianceRequestExecution(a, b.id()));
    game.executeNextTick();
    game.addExecution(new AllianceRequestExecution(b, a.id()));
    game.executeNextTick();
    expect(a.isAlliedWith(b)).toBe(false);
    // Even if a betrayal were reported, it must not count.
    modDefconOnBetrayal(game, a, b);
  } else {
    ally(game, a, b);
    betray(game, a, b);
    expectedBonus += tuning.betrayalBonusTicks;
  }

  while (exec.level() > 1) {
    if (game.ticks() > clockStart + tuning.latestTicks[1] + 100) {
      throw new Error(`DEFCON 1 not reached, still ${exec.level()}`);
    }
    game.executeNextTick();
    onTick(game);
  }
  return {
    game,
    exec,
    offsets: offsets(exec, clockStart),
    expectedBonus,
    buildableAtStart,
    buildableAtEnd: buildableNukes(a, target),
  };
}

const PUBLIC_NUKES_DISABLED = [
  UnitType.MissileSilo,
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.SAMLauncher,
];

describe("DefconExecution: host settings", () => {
  // Everything below is compared with this default game.
  let baseline: number[] | null = null;
  async function baselineOffsets(): Promise<number[]> {
    baseline ??= (await scenario()).offsets;
    return baseline;
  }

  test(
    "default game: conflict and betrayal count, nukes only from DEFCON 2",
    async () => {
      const r = await scenario();
      const d = MOD_CONFIG.defcon;
      expect(r.expectedBonus).toBe(
        d.newConflictBonusTicks + d.betrayalBonusTicks,
      );
      expect(r.offsets).toEqual(expectedOffsets(d, r.expectedBonus));
      expect(r.buildableAtStart).toEqual([]);
      expect(r.buildableAtEnd).toEqual(ALL_NUKES);
    },
    LONG,
  );

  test.each([
    [
      "the public 'nukes disabled' modifier",
      {
        disabledUnits: PUBLIC_NUKES_DISABLED,
        publicGameModifiers: { isNukesDisabled: true },
      },
    ],
    ["missile silos disabled", { disabledUnits: [UnitType.MissileSilo] }],
    [
      "all three nuke types disabled",
      {
        disabledUnits: [
          UnitType.AtomBomb,
          UnitType.HydrogenBomb,
          UnitType.MIRV,
        ],
      },
    ],
  ] as [string, Partial<GameConfig>][])(
    "all nukes disabled (%s): DEFCON still steps normally, nothing gets unlocked",
    async (_name, config) => {
      const r = await scenario(config);
      expect(nukesPossible(r.game.config())).toBe(false);
      expect(r.offsets).toEqual(await baselineOffsets());
      expect(r.buildableAtStart).toEqual([]);
      expect(r.buildableAtEnd).toEqual([]); // DEFCON 1 re-enables nothing
    },
    LONG,
  );

  test(
    "a single nuke type disabled: the lock only adds, the type stays off",
    async () => {
      const r = await scenario({ disabledUnits: [UnitType.HydrogenBomb] });
      expect(r.offsets).toEqual(await baselineOffsets());
      expect(r.buildableAtStart).toEqual([]);
      expect(r.buildableAtEnd).toEqual([UnitType.AtomBomb, UnitType.MIRV]);
    },
    LONG,
  );

  test(
    "SAMs disabled: no effect",
    async () => {
      const r = await scenario({
        disabledUnits: [UnitType.SAMLauncher],
        publicGameModifiers: { isSAMsDisabled: true },
      });
      expect(r.offsets).toEqual(await baselineOffsets());
      expect(r.buildableAtStart).toEqual([]);
      expect(r.buildableAtEnd).toEqual(ALL_NUKES);
    },
    LONG,
  );

  test.each([
    ["disableAlliances", { disableAlliances: true }],
    ["customAllianceDuration 0", { customAllianceDuration: 0 }],
    [
      "the public 'alliances disabled' modifier",
      {
        disableAlliances: true,
        publicGameModifiers: { isAlliancesDisabled: true },
      },
    ],
  ] as [string, Partial<GameConfig>][])(
    "alliances disabled (%s): betrayals never count, attacks and time do",
    async (_name, config) => {
      const r = await scenario(config);
      expect(r.game.config().disableAlliances()).toBe(true);
      const d = MOD_CONFIG.defcon;
      expect(r.expectedBonus).toBe(d.newConflictBonusTicks);
      expect(r.offsets).toEqual(expectedOffsets(d, r.expectedBonus));
    },
    LONG,
  );

  test("alliances disabled: a reported betrayal alone changes nothing", async () => {
    const game = await plainsGame({ customAllianceDuration: 0 });
    const a = human(game, "a", 0, 0);
    const b = human(game, "b", 20, 0);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    modDefconOnBetrayal(game, a, b);
    executeTicks(game, 5);
    modDefconOnBetrayal(game, b, a);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(0);
  });

  test("peace time: the clock starts when it ends, level 5 until then", async () => {
    const peace = 300;
    const game = await plainsGame();
    (game.config() as TestConfig).setSpawnImmunityDuration(peace);
    human(game, "a", 0, 0);
    // DEFCON 4 would come 50 ticks after the clock starts.
    const exec = startDefcon(game, {
      ...FAST,
      latestTicks: { 4: 50, 3: 2000, 2: 2500, 1: 3000 },
    });

    runUntilTick(game, peace);
    expect(game.isSpawnImmunityActive()).toBe(false);
    expect(exec.level()).toBe(5);
    runUntilTick(game, peace + 50);
    expect(exec.level()).toBe(5);
    game.executeNextTick();
    expect(exec.level()).toBe(4);
    expect(exec.reachedAtTick(4)).toBe(peace + 50);
  });

  test("peace time: attacks and betrayals during peace do not count, later", async () => {
    const peace = 300;
    const game = await plainsGame();
    (game.config() as TestConfig).setSpawnImmunityDuration(peace);
    const h1 = human(game, "h1", 0, 0, 30, 30);
    const n = nation(game, "n", 30, 0, 20, 30);
    const h2 = human(game, "h2", 0, 30);
    const h3 = human(game, "h3", 20, 30);
    const exec = startDefcon(game);

    // Nations ignore human PvP immunity: a long attack that is still going
    // on when peace ends.
    runUntilTick(game, peace - 100);
    startAttack(game, n, h1, 400);
    // Humans cannot attack each other yet (upstream).
    game.addExecution(new AttackExecution(20, h2, h3.id()));
    game.executeNextTick();
    expect(h2.outgoingAttacks()).toHaveLength(0);
    // An alliance made and broken during peace.
    ally(game, h2, h3);
    betray(game, h2, h3);
    expect(h2.isTraitor()).toBe(true);

    runUntilTick(game, peace + 10);
    expect(exec.level()).toBe(5);
    expect(n.outgoingAttacks().length).toBeGreaterThan(0); // still going on

    // A new conflict after peace counts.
    startAttack(game, h3, h2);
    finishAttacks(game, h3);

    expect(bonusAtDefcon4(game, exec, peace)).toBe(CONFLICT);
  });

  test("team mode: teammates never count (also disconnected), other teams do", async () => {
    const game = await plainsGame({ gameMode: GameMode.Team, playerTeams: 2 }, [
      pinned("r1", 0),
      pinned("r2", 0),
      pinned("b1", 1),
    ]);
    const r1 = giveLand(game, game.player("r1"), 0, 0);
    const r2 = giveLand(game, game.player("r2"), 20, 0);
    const b1 = giveLand(game, game.player("b1"), 0, 20);
    expect(r1.isOnSameTeam(r2)).toBe(true);
    expect(r1.isOnSameTeam(b1)).toBe(false);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    // Upstream refuses to attack a connected teammate...
    game.addExecution(new AttackExecution(20, r1, r2.id()));
    game.executeNextTick();
    expect(r1.outgoingAttacks()).toHaveLength(0);
    // ...and DEFCON ignores teammates on its own, too.
    const raw = r1.createAttack(r2, 20, null, new Set());
    executeTicks(game, 3);
    raw.delete();

    // A disconnected teammate can be attacked, it still does not count.
    r2.markDisconnected(true);
    startAttack(game, r1, r2);
    finishAttacks(game, r1);

    // Another team: counts.
    startAttack(game, r1, b1);
    finishAttacks(game, r1);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(CONFLICT);
  });

  test("team mode: an alliance across teams, broken, counts", async () => {
    const game = await plainsGame({ gameMode: GameMode.Team, playerTeams: 2 }, [
      pinned("r1", 0),
      pinned("r2", 0),
      pinned("b1", 1),
    ]);
    const r1 = giveLand(game, game.player("r1"), 0, 0);
    const r2 = giveLand(game, game.player("r2"), 20, 0);
    const b1 = giveLand(game, game.player("b1"), 0, 20);
    const exec = startDefcon(game);
    const clockStart = game.ticks();

    // Teammates cannot ally (they already are friendly).
    expect(r1.canSendAllianceRequest(r2)).toBe(false);
    ally(game, r1, b1);
    betray(game, r1, b1);

    expect(bonusAtDefcon4(game, exec, clockStart)).toBe(BETRAYAL);
  });

  test(
    "Singleplayer, Public and Private behave the same",
    async () => {
      const results: number[][] = [];
      for (const gameType of [
        GameType.Singleplayer,
        GameType.Public,
        GameType.Private,
      ]) {
        results.push((await scenario({ gameType })).offsets);
      }
      expect(results[0]).toEqual(await baselineOffsets());
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
    },
    LONG,
  );

  test(
    "doomsday clock together with DEFCON: both run, no interference",
    async () => {
      let sawDoomsday = false;
      const r = await scenario(
        { doomsdayClock: { enabled: true, speed: "veryfast" } },
        () => [new DoomsdayClockExecution()],
        (game) => {
          for (const p of game.players()) {
            if (p.inDoomsdayClock()) sawDoomsday = true;
          }
        },
      );
      expect(r.offsets).toEqual(await baselineOffsets());
      expect(sawDoomsday).toBe(true);
    },
    LONG,
  );

  test("feature off: no execution, nothing registered, nothing locked", async () => {
    const game = await plainsGame({ mod: { defcon: { enabled: false } } });
    const a = human(game, "a", 0, 0);
    nation(game, "n", 20, 0);
    a.addGold(10n ** 12n);
    a.buildUnit(UnitType.MissileSilo, game.ref(2, 2), {});

    expect(defconSettings(game.config()).enabled).toBe(false);
    const execs = modInitExecutions(game);
    expect(execs).toEqual([]);
    game.addExecution(...execs);
    expect(defconLevel(game)).toBeNull();
    expect(defconReachedAtTick(game, 5)).toBeNull();

    let updates = 0;
    for (let i = 0; i < 200; i++) {
      updates += game.executeNextTick()[GameUpdateType.ModDefcon].length;
    }
    expect(updates).toBe(0);
    expect(defconLevel(game)).toBeNull();
    expect(modDefconNukesLocked(game)).toBe(false);
    for (const t of ALL_NUKES) {
      expect(modDefconBlocksUnit(game, t)).toBe(false);
    }
    expect(buildableNukes(a, game.ref(30, 10))).toEqual(ALL_NUKES);
  });

  test("feature on (default): modInitExecutions registers one DefconExecution", async () => {
    const game = await plainsGame();
    const execs = modInitExecutions(game);
    expect(execs).toHaveLength(1);
    expect(execs[0]).toBeInstanceOf(DefconExecution);
    // Registered on construction, before the first tick.
    expect(defconLevel(game)).toBe(5);
    expect(modDefconNukesLocked(game)).toBe(true);
  });

  test(
    "lockNukes false: DEFCON still steps, nothing is locked",
    async () => {
      const r = await scenario({ mod: { defcon: { lockNukes: false } } });
      expect(defconSettings(r.game.config()).lockNukes).toBe(false);
      expect(r.offsets).toEqual(await baselineOffsets());
      expect(r.buildableAtStart).toEqual(ALL_NUKES);
      expect(r.buildableAtEnd).toEqual(ALL_NUKES);
      expect(modDefconNukesLocked(r.game)).toBe(false);
    },
    LONG,
  );
});

// --- Games with a timer ------------------------------------------------------

/** The real ranked configs, with Math.random pinned to pick one variant. */
function rankedConfig(kind: "1v1" | "2v2", random: number): GameConfig {
  const spy = vi.spyOn(Math, "random").mockReturnValue(random);
  try {
    const playlist = new MapPlaylist();
    return kind === "1v1" ? playlist.get1v1Config() : playlist.get2v2Config();
  } finally {
    spy.mockRestore();
  }
}

/**
 * Starts DEFCON the real way in a game with this config, runs to DEFCON 1
 * by time alone and checks every level against the timer-scaled tuning.
 */
async function expectScaledSchedule(
  config: GameConfig,
  humans: PlayerInfo[],
  percent: number,
): Promise<void> {
  const game = await setup("plains", config, humans);
  const peace = config.spawnImmunityDuration ?? 0;
  (game.config() as TestConfig).setSpawnImmunityDuration(peace);

  const d = MOD_CONFIG.defcon;
  const tuning = defconSettings(game.config());
  expect(tuning).toEqual(scaleForTimer(d, config.maxTimerValue, peace));
  for (const l of STEP_LEVELS) {
    expect(tuning.latestTicks[l]).toBe(
      Math.floor((d.latestTicks[l] * percent) / 100),
    );
    expect(tuning.earliestTicks[l]).toBe(
      Math.floor((d.earliestTicks[l] * percent) / 100),
    );
  }
  // Bonuses are not scaled.
  expect(tuning.newConflictBonusTicks).toBe(d.newConflictBonusTicks);
  expect(tuning.betrayalBonusTicks).toBe(d.betrayalBonusTicks);

  const execs = modInitExecutions(game);
  expect(execs).toHaveLength(1);
  const exec = execs[0] as DefconExecution;
  game.addExecution(...execs);
  const clockStart = Math.max(peace, 1);
  runUntilTick(game, clockStart + tuning.latestTicks[4]);
  expect(exec.level()).toBe(5); // one tick before the scaled time
  game.executeNextTick();
  expect(exec.reachedAtTick(4)).toBe(clockStart + tuning.latestTicks[4]);

  runUntilLevel(game, exec, 1, tuning.latestTicks[1] + 10);
  expect(offsets(exec, clockStart)).toEqual(expectedOffsets(tuning, 0));
}

describe("DefconExecution: games with a timer", () => {
  test(
    "ranked 1v1 (10 minutes, 30 s peace): the schedule runs at 47%",
    async () => {
      const config = rankedConfig("1v1", 0.1); // compact -> 10 minutes
      expect(config.rankedType).toBe(RankedType.OneVOne);
      expect(config.gameMode).toBe(GameMode.FFA);
      expect(config.maxTimerValue).toBe(10);
      await expectScaledSchedule(
        config,
        [pinned("p1", 0), pinned("p2", 1)],
        47, // (6000 - 300) / 12000
      );
    },
    LONG,
  );

  test(
    "ranked 2v2 (15 minutes, 60 s peace): the schedule runs at 70%",
    async () => {
      const config = rankedConfig("2v2", 0.9); // normal size -> 15 minutes
      expect(config.rankedType).toBe(RankedType.TwoVTwo);
      expect(config.gameMode).toBe(GameMode.Team);
      expect(config.playerTeams).toBe(2);
      expect(config.maxTimerValue).toBe(15);
      await expectScaledSchedule(
        config,
        [pinned("p1", 0), pinned("p2", 1), pinned("p3", 1), pinned("p4", 0)],
        70, // (9000 - 600) / 12000
      );
    },
    LONG,
  );

  test(
    "a private lobby with a 30 minute timer keeps the normal schedule",
    async () => {
      const game = await plainsGame({
        gameType: GameType.Private,
        maxTimerValue: 30,
      });
      expect(defconSettings(game.config())).toEqual(MOD_CONFIG.defcon);
      const exec = new DefconExecution(game);
      game.addExecution(exec);
      game.executeNextTick();
      const clockStart = game.ticks();
      runUntilLevel(game, exec, 1, MOD_CONFIG.defcon.latestTicks[1] + 10);
      expect(offsets(exec, clockStart)).toEqual(
        expectedOffsets(MOD_CONFIG.defcon, 0),
      );
    },
    LONG,
  );

  test("the resolver scales the same way on a plain Config (restore path)", () => {
    const base = {
      gameType: GameType.Public,
      gameMode: GameMode.FFA,
    } as unknown as GameConfig;
    const at = (
      maxTimerValue: number | null | undefined,
      spawnImmunityDuration?: number,
    ) =>
      defconSettings(
        new Config(
          { ...base, maxTimerValue, spawnImmunityDuration },
          null,
          false,
        ),
      );
    // A plain Config always has the default 5 s (50 ticks) spawn immunity.
    const peace = new Config(base, null, false).spawnImmunityDuration();
    expect(peace).toBe(50);
    expect(at(10)).toEqual(scaleForTimer(MOD_CONFIG.defcon, 10, peace));
    expect(at(15)).toEqual(scaleForTimer(MOD_CONFIG.defcon, 15, peace));
    expect(at(10).latestTicks[2]).toBe(
      Math.floor((MOD_CONFIG.defcon.latestTicks[2] * 49) / 100), // 5950/12000
    );
    expect(at(5).latestTicks[4]).toBe(
      Math.floor((MOD_CONFIG.defcon.latestTicks[4] * 40) / 100),
    );
    // Peace time eats into the timer: 20 min with 10 min peace -> 50%.
    expect(at(20, 6000).latestTicks[2]).toBe(
      Math.floor((MOD_CONFIG.defcon.latestTicks[2] * 50) / 100),
    );
    for (const t of [30, null, undefined]) {
      expect(at(t)).toEqual(MOD_CONFIG.defcon);
    }
  });

  // Plan: the schedule must fit the time the timer leaves after peace time.
  test.each([
    { timer: 10, peaceMinutes: 5, percent: 40 }, // 25% clamped to 40%
    { timer: 20, peaceMinutes: 10, percent: 50 },
    { timer: 15, peaceMinutes: 4, percent: 55 },
  ])(
    "private lobby, $timer min timer and $peaceMinutes min peace time: DEFCON 2 by time comes before the timer ends",
    async ({ timer, peaceMinutes, percent }) => {
      const peace = peaceMinutes * 600;
      const game = await plainsGame({
        gameType: GameType.Private,
        maxTimerValue: timer,
      });
      (game.config() as TestConfig).setSpawnImmunityDuration(peace);
      const tuning = defconSettings(game.config());
      const d = MOD_CONFIG.defcon;
      expect(tuning.latestTicks[2]).toBe(
        Math.floor((d.latestTicks[2] * percent) / 100),
      );
      const exec = new DefconExecution(game, tuning);
      game.addExecution(exec);
      const timerEnd = timer * 600;
      runUntilLevel(game, exec, 2, timerEnd);
      expect(exec.level()).toBe(2);
      expect(exec.reachedAtTick(2)!).toBeLessThan(timerEnd);
      // By time alone: exactly when the scaled clock gets there.
      expect(exec.reachedAtTick(2)!).toBe(
        Math.max(peace, 1) + tuning.latestTicks[2],
      );
    },
    LONG,
  );
});
