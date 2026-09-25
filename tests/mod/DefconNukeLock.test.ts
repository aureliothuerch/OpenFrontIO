import { vi } from "vitest";
import { MirvExecution } from "../../src/core/execution/MIRVExecution";
import { MissileSiloExecution } from "../../src/core/execution/MissileSiloExecution";
import { NationExecution } from "../../src/core/execution/NationExecution";
import { NukeExecution } from "../../src/core/execution/NukeExecution";
import { SAMLauncherExecution } from "../../src/core/execution/SAMLauncherExecution";
import { UpgradeStructureExecution } from "../../src/core/execution/UpgradeStructureExecution";
import {
  Cell,
  Difficulty,
  Game,
  Nation,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { GameConfig } from "../../src/core/Schemas";
import { DefconExecution } from "../../src/mod/core/defcon/DefconExecution";
import {
  defconLevel,
  modDefconBlocksUnit,
  modDefconNukesLocked,
} from "../../src/mod/core/defcon/DefconState";
import { DefconTuning, MOD_CONFIG } from "../../src/mod/core/ModConfig";
import { modInitExecutions } from "../../src/mod/core/ModExecutions";
import { playerInfo, setup } from "../util/Setup";
import { constructionExecution, executeTicks } from "../util/utils";

/**
 * The DEFCON nuke lock in a real game (setup() + real executions): nukes
 * (AtomBomb, HydrogenBomb, MIRV) are locked above DEFCON 2 for humans and
 * nations, silos and silo upgrades never are, host-disabled types stay
 * disabled, and the lock lifts once a winner is decided.
 *
 * The level is driven by a tiny custom tuning: DEFCON 4/3/2/1 are reached
 * 10/20/30/40 ticks after the escalation clock starts, by time alone.
 */

const NUKES = [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV];
const UNLOCK_LEVEL = 2;

/**
 * DEFCON 4 at `firstTicks` after the clock starts, then one level every
 * `stepTicks` (by time alone: earliest = latest).
 */
function tuning(
  firstTicks: number,
  stepTicks: number,
  overrides: Partial<DefconTuning> = {},
) {
  const at = (n: number) => firstTicks + stepTicks * (n - 1);
  return {
    ...MOD_CONFIG.defcon,
    enabled: true,
    lockNukes: true,
    nukeUnlockLevel: UNLOCK_LEVEL,
    latestTicks: { 4: at(1), 3: at(2), 2: at(3), 1: at(4) },
    earliestTicks: { 4: at(1), 3: at(2), 2: at(3), 1: at(4) },
    minTicksBetweenSteps: 1,
    heartbeatTicks: 5,
    ...overrides,
  } satisfies DefconTuning;
}

const FAST = tuning(10, 10);

function startDefcon(game: Game, t: DefconTuning = FAST): DefconExecution {
  const exec = new DefconExecution(game, t);
  game.addExecution(exec);
  return exec;
}

/** Ticks until DEFCON reaches `level` (it steps at most once per tick). */
function advanceTo(game: Game, level: number, maxTicks = 500): void {
  for (let i = 0; i < maxTicks; i++) {
    if ((defconLevel(game) ?? 0) <= level) break;
    game.executeNextTick();
  }
  expect(defconLevel(game)).toBe(level);
}

function conquerRect(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      const tile = game.ref(x, y);
      if (game.map().isLand(tile)) p.conquer(tile);
    }
  }
}

interface World {
  game: Game;
  launcher: Player;
  target: Player;
  /** Null only when the host disabled missile silos (cannot be built). */
  silo: Unit | null;
  targetTile: TileRef;
}

/**
 * Two humans on big_plains: the launcher (with a ready missile silo and
 * finite gold, so charges are visible) and a large target.
 */
async function world(gameConfig: Partial<GameConfig> = {}): Promise<World> {
  const game = await setup(
    "big_plains",
    { instantBuild: true, ...gameConfig },
    [
      playerInfo("launcher", PlayerType.Human),
      playerInfo("target", PlayerType.Human),
    ],
  );
  const launcher = game.player("launcher");
  const target = game.player("target");
  conquerRect(game, launcher, 0, 0, 40, 40);
  conquerRect(game, target, 60, 60, 200, 200);
  const silo = game.config().isUnitDisabled(UnitType.MissileSilo)
    ? null
    : launcher.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
  launcher.addGold(1_000_000_000n);
  launcher.addTroops(10_000);
  target.addTroops(10_000);
  return { game, launcher, target, silo, targetTile: game.ref(100, 100) };
}

function canBuild(w: World, type: UnitType): boolean {
  return w.launcher.canBuild(type, w.targetTile) !== false;
}

function nukesBuildable(w: World): Record<string, boolean> {
  return Object.fromEntries(NUKES.map((t) => [t, canBuild(w, t)]));
}

function allNukes(value: boolean): Record<string, boolean> {
  return Object.fromEntries(NUKES.map((t) => [t, value]));
}

function nukeUnits(game: Game): Unit[] {
  return game.units(NUKES);
}

beforeEach(() => {
  // NukeExecution / MirvExecution warn when a launch is refused.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DEFCON nuke lock: humans", () => {
  test("nukes are locked from the moment DEFCON exists, before its first tick", async () => {
    const w = await world();
    expect(nukesBuildable(w)).toEqual(allNukes(true));
    startDefcon(w.game);
    expect(defconLevel(w.game)).toBe(5);
    expect(nukesBuildable(w)).toEqual(allNukes(false));
  });

  test("nukes cannot be built above DEFCON 2 and can from DEFCON 2 on", async () => {
    const w = await world();
    startDefcon(w.game);
    for (const level of [5, 4, 3, 2, 1]) {
      advanceTo(w.game, level);
      const unlocked = level <= UNLOCK_LEVEL;
      expect(nukesBuildable(w), `DEFCON ${level}`).toEqual(allNukes(unlocked));
      expect(modDefconNukesLocked(w.game), `DEFCON ${level}`).toBe(!unlocked);
      for (const type of NUKES) {
        expect(modDefconBlocksUnit(w.game, type)).toBe(!unlocked);
      }
    }
  });

  test("the build menu data (buildableUnits) shows nukes as not buildable while locked", async () => {
    const w = await world();
    startDefcon(w.game);
    const row = (tile: TileRef, type: UnitType) =>
      w.launcher.buildableUnits(tile).find((b) => b.type === type)!;

    for (const level of [5, 4, 3]) {
      advanceTo(w.game, level);
      for (const type of NUKES) {
        expect(row(w.targetTile, type).canBuild, `${type} @${level}`).toBe(
          false,
        );
      }
      // Silos stay available in the same menu: upgrade near the silo, a new
      // one elsewhere on own land.
      expect(row(w.silo!.tile(), UnitType.MissileSilo).canUpgrade).toBe(
        w.silo!.id(),
      );
      expect(row(w.game.ref(32, 32), UnitType.MissileSilo).canBuild).not.toBe(
        false,
      );
    }

    advanceTo(w.game, UNLOCK_LEVEL);
    for (const type of NUKES) {
      expect(row(w.targetTile, type).canBuild, type).not.toBe(false);
    }
  });

  test("missile silos can always be built and upgraded, also for real", async () => {
    const w = await world();
    startDefcon(w.game);
    executeTicks(w.game, 2);
    expect(defconLevel(w.game)).toBe(5);

    expect(
      w.launcher.canBuild(UnitType.MissileSilo, w.game.ref(32, 32)),
    ).not.toBe(false);
    expect(w.launcher.canUpgradeUnit(w.silo!)).toBe(true);
    expect(
      w.launcher.findUnitToUpgrade(UnitType.MissileSilo, w.silo!.tile()),
    ).toBe(w.silo!);

    // A real upgrade and a real construction while locked.
    w.game.addExecution(
      new UpgradeStructureExecution(w.launcher, w.silo!.id()),
    );
    executeTicks(w.game, 2);
    expect(w.silo!.level()).toBe(2);
    constructionExecution(w.game, w.launcher, 32, 32, UnitType.MissileSilo);
    expect(w.launcher.units(UnitType.MissileSilo)).toHaveLength(2);
    expect(defconLevel(w.game)).toBeGreaterThan(UNLOCK_LEVEL);
  });

  test("a nuke launched while locked does not spawn and charges no gold; it does at DEFCON 2", async () => {
    const w = await world();
    startDefcon(w.game);
    executeTicks(w.game, 2);
    const goldBefore = w.launcher.gold();

    w.game.addExecution(
      new NukeExecution(UnitType.AtomBomb, w.launcher, w.targetTile, null),
      new NukeExecution(UnitType.HydrogenBomb, w.launcher, w.targetTile, null),
      new MirvExecution(w.launcher, w.targetTile),
    );
    executeTicks(w.game, 3);

    expect(defconLevel(w.game)).toBe(5);
    expect(nukeUnits(w.game)).toHaveLength(0);
    expect(w.launcher.gold()).toBe(goldBefore);
    expect(w.silo!.isInCooldown()).toBe(false);
    expect(w.silo!.missileTimerQueue()).toHaveLength(0);

    advanceTo(w.game, UNLOCK_LEVEL);
    const goldAtUnlock = w.launcher.gold();
    const cost = w.game.unitInfo(UnitType.AtomBomb).cost(w.game, w.launcher);
    w.game.addExecution(
      new NukeExecution(UnitType.AtomBomb, w.launcher, w.targetTile, null),
    );
    executeTicks(w.game, 2);
    expect(w.launcher.units(UnitType.AtomBomb)).toHaveLength(1);
    expect(w.launcher.gold()).toBe(goldAtUnlock - cost);
    expect(w.silo!.isInCooldown()).toBe(true);
  });

  test("a MIRV launched at DEFCON 2 spawns its warheads normally", async () => {
    const w = await world();
    startDefcon(w.game);
    // Warheads are never locked, not even at DEFCON 5.
    executeTicks(w.game, 2);
    expect(defconLevel(w.game)).toBe(5);
    expect(modDefconBlocksUnit(w.game, UnitType.MIRVWarhead)).toBe(false);
    expect(w.launcher.canBuild(UnitType.MIRVWarhead, w.targetTile)).toBe(
      w.targetTile,
    );

    advanceTo(w.game, UNLOCK_LEVEL);
    const mirv = new MirvExecution(w.launcher, w.targetTile);
    w.game.addExecution(mirv);
    executeTicks(w.game, 2);
    expect(w.launcher.units(UnitType.MIRV)).toHaveLength(1);

    for (let i = 0; i < 1000 && mirv.isActive(); i++) {
      w.game.executeNextTick();
    }
    expect(mirv.isActive()).toBe(false);
    executeTicks(w.game, 1);
    expect(w.launcher.units(UnitType.MIRV)).toHaveLength(0);
    expect(w.launcher.units(UnitType.MIRVWarhead).length).toBeGreaterThan(0);
  });

  test("host-disabled nuke types stay unbuildable at DEFCON 2 and after", async () => {
    const w = await world({ disabledUnits: [UnitType.HydrogenBomb] });
    startDefcon(w.game);
    advanceTo(w.game, 3);
    expect(nukesBuildable(w)).toEqual(allNukes(false));

    for (const level of [2, 1]) {
      advanceTo(w.game, level);
      expect(nukesBuildable(w), `DEFCON ${level}`).toEqual({
        [UnitType.AtomBomb]: true,
        [UnitType.HydrogenBomb]: false,
        [UnitType.MIRV]: true,
      });
    }

    const goldBefore = w.launcher.gold();
    w.game.addExecution(
      new NukeExecution(UnitType.HydrogenBomb, w.launcher, w.targetTile, null),
    );
    executeTicks(w.game, 2);
    expect(w.launcher.units(UnitType.HydrogenBomb)).toHaveLength(0);
    expect(w.launcher.gold()).toBe(goldBefore);
  });

  test.each([
    [
      "the three nuke types disabled",
      [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV],
    ],
    [
      // What the public isNukesDisabled modifier disables (MapPlaylist).
      "the isNukesDisabled set (silos and SAMs too)",
      [
        UnitType.MissileSilo,
        UnitType.AtomBomb,
        UnitType.HydrogenBomb,
        UnitType.MIRV,
        UnitType.SAMLauncher,
      ],
    ],
  ])(
    "all nukes disabled by the host stay disabled at every level: %s",
    async (_, disabledUnits) => {
      // The world force-builds a silo, so only the host setting stops nukes.
      const w = await world({ disabledUnits });
      const siloDisabled = disabledUnits.includes(UnitType.MissileSilo);
      startDefcon(w.game);
      for (const level of [5, 3, 2, 1]) {
        advanceTo(w.game, level);
        expect(nukesBuildable(w), `DEFCON ${level}`).toEqual(allNukes(false));
        // "Silos are always allowed" never overrides the host.
        expect(
          w.launcher.canBuild(UnitType.MissileSilo, w.game.ref(32, 32)) !==
            false,
        ).toBe(!siloDisabled);
      }
    },
  );

  test("SAMs disabled has no effect on the lock", async () => {
    const w = await world({ disabledUnits: [UnitType.SAMLauncher] });
    startDefcon(w.game);
    for (const level of [5, 4, 3, 2, 1]) {
      advanceTo(w.game, level);
      expect(nukesBuildable(w), `DEFCON ${level}`).toEqual(
        allNukes(level <= UNLOCK_LEVEL),
      );
      expect(
        w.launcher.canBuild(UnitType.SAMLauncher, w.game.ref(32, 32)),
      ).toBe(false);
    }
  });

  test("after a winner is set the lock lifts even at DEFCON 5, host-disabled types stay disabled", async () => {
    const w = await world({ disabledUnits: [UnitType.HydrogenBomb] });
    startDefcon(w.game);
    executeTicks(w.game, 2);
    expect(defconLevel(w.game)).toBe(5);
    expect(nukesBuildable(w)).toEqual(allNukes(false));

    w.game.setWinner(w.launcher, w.game.stats().stats());

    expect(modDefconNukesLocked(w.game)).toBe(false);
    expect(nukesBuildable(w)).toEqual({
      [UnitType.AtomBomb]: true,
      [UnitType.HydrogenBomb]: false,
      [UnitType.MIRV]: true,
    });

    // The level freezes: FAST would have reached DEFCON 1 long before.
    executeTicks(w.game, 100);
    expect(defconLevel(w.game)).toBe(5);

    const goldBefore = w.launcher.gold();
    const cost = w.game.unitInfo(UnitType.AtomBomb).cost(w.game, w.launcher);
    w.game.addExecution(
      new NukeExecution(UnitType.AtomBomb, w.launcher, w.targetTile, null),
    );
    executeTicks(w.game, 2);
    expect(w.launcher.units(UnitType.AtomBomb)).toHaveLength(1);
    expect(w.launcher.gold()).toBe(goldBefore - cost);
  });
});

describe("DEFCON nuke lock: switched off", () => {
  test("without a DefconExecution in the game nothing is locked", async () => {
    const w = await world();
    executeTicks(w.game, 5);
    expect(defconLevel(w.game)).toBeNull();
    expect(modDefconNukesLocked(w.game)).toBe(false);
    for (const type of NUKES) {
      expect(modDefconBlocksUnit(w.game, type)).toBe(false);
    }
    expect(nukesBuildable(w)).toEqual(allNukes(true));

    w.game.addExecution(
      new NukeExecution(UnitType.AtomBomb, w.launcher, w.targetTile, null),
    );
    executeTicks(w.game, 2);
    expect(w.launcher.units(UnitType.AtomBomb)).toHaveLength(1);
  });

  test("feature switched off per game: GameRunner's hook adds no DefconExecution", async () => {
    const w = await world({ mod: { defcon: { enabled: false } } });
    const execs = modInitExecutions(w.game);
    expect(execs).toHaveLength(0);
    w.game.addExecution(...execs);
    executeTicks(w.game, 5);
    expect(defconLevel(w.game)).toBeNull();
    expect(nukesBuildable(w)).toEqual(allNukes(true));
  });

  test("lockNukes false: DEFCON runs from the game config but locks nothing", async () => {
    const w = await world({ mod: { defcon: { lockNukes: false } } });
    // Default tuning, derived from the game config like GameRunner does.
    const execs = modInitExecutions(w.game);
    expect(execs).toHaveLength(1);
    w.game.addExecution(...execs);
    executeTicks(w.game, 5);

    expect(defconLevel(w.game)).toBe(5);
    expect(modDefconNukesLocked(w.game)).toBe(false);
    expect(nukesBuildable(w)).toEqual(allNukes(true));

    w.game.addExecution(
      new NukeExecution(UnitType.AtomBomb, w.launcher, w.targetTile, null),
    );
    executeTicks(w.game, 2);
    expect(w.launcher.units(UnitType.AtomBomb)).toHaveLength(1);
  });

  test("lockNukes false in a custom tuning locks nothing either", async () => {
    const w = await world();
    startDefcon(w.game, tuning(10, 10, { lockNukes: false }));
    for (const level of [5, 3]) {
      advanceTo(w.game, level);
      expect(nukesBuildable(w), `DEFCON ${level}`).toEqual(allNukes(true));
    }
  });
});

// ---------------------------------------------------------------------------
// Nations. The setups follow tests/NationNukeSamOverwhelm.test.ts and
// tests/NationMIRV.test.ts: the NationExecution is ticked by hand (its
// attack tick is random per game ID, so several IDs are tried) while the
// game advances every 10 nation ticks.
//
// NationNukeBehavior is private inside NationExecution. Its state is read
// through the same fields its snapshot writes (NationExecution.snapshot ->
// behaviors.nuke: atomBombPerceivedCost, atomBombsLaunched, ...), via a
// structural cast, because a manually ticked execution is not part of the
// game's own snapshot.
// ---------------------------------------------------------------------------

interface NukeBehaviorState {
  atomBombPerceivedCost: bigint;
  atomBombsLaunched: number;
  hydrogenBombPerceivedCost: bigint;
  hydrogenBombsLaunched: number;
  recentlySentNukes: unknown[];
}

function nukeBehavior(exec: NationExecution): NukeBehaviorState | undefined {
  return (exec as unknown as { nukeBehavior?: NukeBehaviorState }).nukeBehavior;
}

// DEFCON 4 only after 1000 ticks, so the locked phase (at most ~650 game
// ticks) stays at DEFCON 5; then quickly on to DEFCON 2.
const SLOW = tuning(1000, 10);

interface NationRun {
  launched: boolean;
  runs: { exec: NationExecution; behavior: NukeBehaviorState | undefined }[];
}

/** Ticks a fresh NationExecution per game ID until `launched()` holds. */
function runNation(
  game: Game,
  nation: Nation,
  idPrefix: string,
  launched: () => boolean,
  ids = 10,
  innerTicks = 150,
): NationRun {
  const runs: NationRun["runs"] = [];
  for (let i = 0; i < ids; i++) {
    if (i > 0) executeTicks(game, 50);
    const exec = new NationExecution(`${idPrefix}_${i}`, nation);
    exec.init(game);
    for (let tick = 0; tick < innerTicks; tick++) {
      exec.tick(tick);
      if (tick % 10 === 0) game.executeNextTick();
      if (launched()) {
        runs.push({ exec, behavior: nukeBehavior(exec) });
        return { launched: true, runs };
      }
    }
    runs.push({ exec, behavior: nukeBehavior(exec) });
  }
  return { launched: false, runs };
}

describe("DEFCON nuke lock: nations", () => {
  test("an Impossible nation launches no nukes while locked, keeps its perceived nuke cost, and launches after DEFCON 2", async () => {
    // Two players, the human's SAM covers all of its land: on Impossible
    // the nation plans an atom bomb salvo (maybeDestroyEnemySam), which
    // raises atomBombPerceivedCost per bomb without checking canBuild.
    const game = await setup("big_plains", {
      difficulty: Difficulty.Impossible,
      infiniteGold: true,
      instantBuild: true,
    });
    game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
    );
    game.addPlayer(new PlayerInfo("human", PlayerType.Human, null, "human_id"));
    const nation = game.player("nation_id");
    const human = game.player("human_id");
    conquerRect(game, nation, 10, 10, 40, 40);
    conquerRect(game, human, 60, 60, 90, 90);

    const sam = human.buildUnit(UnitType.SAMLauncher, game.ref(75, 75), {});
    game.addExecution(new SAMLauncherExecution(human, null, sam));
    for (const [x, y] of [
      [20, 20],
      [25, 25],
      [30, 30],
    ] as const) {
      const silo = nation.buildUnit(UnitType.MissileSilo, game.ref(x, y), {});
      game.addExecution(new MissileSiloExecution(silo));
    }
    nation.addGold(1_000_000_000n); // infiniteGold is for humans only
    nation.addTroops(100_000);
    human.addTroops(100_000);

    startDefcon(game, SLOW);
    const atomCost = game.unitInfo(UnitType.AtomBomb).cost(game, nation);
    const testNation = new Nation(new Cell(25, 25), nation.info());

    // Locked: every game ID runs its full 150 ticks (no early exit).
    let everLaunched = false;
    const locked = runNation(game, testNation, "locked", () => {
      everLaunched ||= nukeUnits(game).length > 0;
      return false;
    });
    expect(defconLevel(game)).toBe(5);
    expect(everLaunched).toBe(false);
    expect(nukeUnits(game)).toHaveLength(0);
    expect(locked.runs).toHaveLength(10);
    for (const { behavior } of locked.runs) {
      expect(behavior).toBeDefined(); // the behaviours did initialize
      expect(behavior!.atomBombPerceivedCost).toBe(atomCost);
      expect(behavior!.atomBombsLaunched).toBe(0);
      expect(behavior!.hydrogenBombsLaunched).toBe(0);
      expect(behavior!.recentlySentNukes).toHaveLength(0);
    }

    // Unlock and run the same setup again: now the salvo flies.
    advanceTo(game, UNLOCK_LEVEL, 2000);
    const unlocked = runNation(
      game,
      testNation,
      "unlocked",
      () => nation.units(UnitType.AtomBomb).length > 0,
    );
    expect(unlocked.launched).toBe(true);
    const last = unlocked.runs[unlocked.runs.length - 1].behavior!;
    expect(last.atomBombsLaunched).toBeGreaterThan(0);
    expect(last.atomBombPerceivedCost).toBeGreaterThan(atomCost);
  }, 60_000);

  test("an Impossible nation sends no MIRV while locked, and does after DEFCON 2", async () => {
    // The human holds half the map: on Impossible (victory denial at 40%)
    // the nation wants to MIRV it.
    const game = await setup("big_plains", {
      difficulty: Difficulty.Impossible,
      infiniteGold: true,
      instantBuild: true,
    });
    game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
    );
    game.addPlayer(new PlayerInfo("human", PlayerType.Human, null, "human_id"));
    const nation = game.player("nation_id");
    const human = game.player("human_id");
    conquerRect(game, nation, 10, 10, 40, 40);
    conquerRect(game, human, 0, 100, 200, 200);
    const silo = nation.buildUnit(UnitType.MissileSilo, game.ref(25, 25), {});
    game.addExecution(new MissileSiloExecution(silo));
    nation.addGold(1_000_000_000n);
    nation.addTroops(100_000);
    human.addTroops(100_000);

    startDefcon(game, SLOW);
    const testNation = new Nation(new Cell(25, 25), nation.info());

    let everLaunched = false;
    runNation(game, testNation, "locked", () => {
      everLaunched ||= nukeUnits(game).length > 0;
      return false;
    });
    expect(defconLevel(game)).toBe(5);
    expect(everLaunched).toBe(false);
    expect(game.nationMirvTargets().size).toBe(0);

    advanceTo(game, UNLOCK_LEVEL, 2000);
    const unlocked = runNation(
      game,
      testNation,
      "unlocked",
      () => nation.units(UnitType.MIRV).length > 0,
      20,
      200,
    );
    expect(unlocked.launched).toBe(true);
    expect(game.nationMirvTargets().has(human.id())).toBe(true);
  }, 60_000);
});
