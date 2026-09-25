import { vi } from "vitest";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import { BreakAllianceExecution } from "../../src/core/execution/alliance/BreakAllianceExecution";
import { AttackExecution } from "../../src/core/execution/AttackExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { GameRunner } from "../../src/core/GameRunner";
import { GameConfig, GameStartInfo } from "../../src/core/Schemas";
import { snapshotGame } from "../../src/core/snapshot/GameSnapshot";
import { decodeSnapshotValue } from "../../src/core/snapshot/SnapshotCodec";
import { DefconExecution } from "../../src/mod/core/defcon/DefconExecution";
import { defconSettings } from "../../src/mod/core/defcon/DefconSettings";
import {
  defconLevel,
  defconReachedAtTick,
  modDefconBlocksUnit,
  modDefconNukesLocked,
} from "../../src/mod/core/defcon/DefconState";
import { MOD_CONFIG } from "../../src/mod/core/ModConfig";
import {
  createScriptedRunner,
  restoreScriptedRunner,
  scriptedGameStart,
  stepScripted,
} from "../util/ScriptedGame";
import { playerInfo, setup } from "../util/Setup";
import {
  diffSnapshots,
  expectSnapshotRoundTrip,
  roundTrip,
} from "../util/Snapshot";
import { executeTicks } from "../util/utils";

/**
 * Snapshots of a game with DEFCON running. The DefconExecution always uses
 * the DEFAULT tuning here: a restore re-derives the tuning from the game
 * config (defconSettings), so a custom tuning would differ by design.
 */

const MAP = "plains";
const NUKES = [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV];
const LEVELS = [1, 2, 3, 4, 5];

interface World {
  game: Game;
  h0: Player;
  h1: Player;
  h2: Player;
  n0: Player;
  targetTile: TileRef;
}

/**
 * Three humans and a nation in vertical strips on plains (h0 | h1 | h2 |
 * n0). h0 has a missile silo and gold, so the lock is visible in canBuild.
 */
async function world(autoEndSpawnPhase = true): Promise<World> {
  const game = await setup(
    MAP,
    { instantBuild: true },
    ["h0", "h1", "h2"].map((n) => playerInfo(n, PlayerType.Human)),
    undefined,
    undefined,
    autoEndSpawnPhase,
  );
  game.addPlayer(new PlayerInfo("n0", PlayerType.Nation, null, "n0"));
  const [h0, h1, h2, n0] = ["h0", "h1", "h2", "n0"].map((id) =>
    game.player(id),
  );
  [h0, h1, h2, n0].forEach((p, i) => {
    for (let x = i * 25; x < (i + 1) * 25; x++) {
      for (let y = 0; y < 100; y++) p.conquer(game.ref(x, y));
    }
    p.addTroops(10_000);
  });
  h0.buildUnit(UnitType.MissileSilo, game.ref(10, 50), {});
  h0.addGold(1_000_000_000n);
  return { game, h0, h1, h2, n0, targetTile: game.ref(40, 50) };
}

function startDefcon(game: Game): DefconExecution {
  const exec = new DefconExecution(game); // default tuning from the config
  game.addExecution(exec);
  return exec;
}

/** Lets DEFCON initialize and its clock start (no peace time in tests). */
function startClock(w: World): void {
  executeTicks(w.game, 2);
  expect(w.game.isSpawnImmunityActive()).toBe(false);
}

/** Three new conflicts between neighbours and one real betrayal. */
function seedConflicts(w: World): void {
  const { game, h0, h1, h2, n0 } = w;
  game.addExecution(
    new AttackExecution(200, h0, h1.id()),
    new AttackExecution(200, h1, h2.id()),
    new AttackExecution(200, n0, h2.id()),
    new AllianceRequestExecution(h0, n0.id()),
  );
  game.executeNextTick();
  game.addExecution(new AllianceRequestExecution(n0, h0.id()));
  game.executeNextTick();
  expect(h0.isAlliedWith(n0)).toBe(true);
  game.addExecution(new BreakAllianceExecution(h0, n0.id()));
  executeTicks(game, 2); // init, then the break
  expect(h0.isAlliedWith(n0)).toBe(false);
  expect(h0.isTraitor()).toBe(true);
}

function advanceTo(game: Game, level: number, maxTicks = 12_000): void {
  for (let i = 0; i < maxTicks; i++) {
    if ((defconLevel(game) ?? 0) <= level) break;
    game.executeNextTick();
  }
  expect(defconLevel(game)).toBe(level);
}

/** Everything DEFCON exposes through its public accessors. */
function defconView(game: Game) {
  return {
    level: defconLevel(game),
    reachedAt: LEVELS.map((l) => defconReachedAtTick(game, l)),
    nukesLocked: modDefconNukesLocked(game),
    blocks: NUKES.map((t) => modDefconBlocksUnit(game, t)),
  };
}

function canLaunch(game: Game, w: World): boolean[] {
  const h0 = game.player(w.h0.id());
  return NUKES.map((t) => h0.canBuild(t, w.targetTile) !== false);
}

interface DefconRecordData {
  initialized: boolean;
  level: number;
  bonusTicks: number;
  pairLastAttackTick: [number, number][];
  traitorLastCountedTick: [number, number][];
}

/** The DefconExecution's record in a snapshot. */
function defconRecord(bytes: Uint8Array): DefconRecordData {
  const root = decodeSnapshotValue(bytes) as {
    execs: { t: string; d: unknown }[];
  };
  const records = root.execs.filter((e) => e.t === "ModDefcon");
  expect(records).toHaveLength(1);
  return records[0].d as DefconRecordData;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DEFCON snapshots (default tuning)", () => {
  test("a snapshot holds exactly one ModDefcon record", async () => {
    const w = await world();
    startDefcon(w.game);
    executeTicks(w.game, 2);
    const rec = defconRecord(snapshotGame(w.game));
    expect(rec.initialized).toBe(true);
    expect(rec.level).toBe(5);
  });

  test("spawn phase: DEFCON waits uninitialized, and initializes identically after the restore", async () => {
    const w = await world(false);
    startDefcon(w.game);
    // Pending in unInitExecs.
    await expectSnapshotRoundTrip(w.game, MAP, 0);

    executeTicks(w.game, 3);
    expect(w.game.inSpawnPhase()).toBe(true);
    expect(defconRecord(snapshotGame(w.game)).initialized).toBe(false);
    expect(defconView(w.game)).toMatchObject({
      level: 5,
      reachedAt: [null, null, null, null, null],
      nukesLocked: true,
    });

    // The spawn phase ends inside the checked window, on both games.
    const restored = await expectSnapshotRoundTrip(w.game, MAP, 30, (g, i) => {
      if (i === 5) g.endSpawnPhase();
    });
    expect(w.game.inSpawnPhase()).toBe(false);
    expect(defconView(w.game).reachedAt[4]).not.toBeNull();
    expect(defconView(restored)).toEqual(defconView(w.game));
    expect(defconRecord(snapshotGame(restored)).initialized).toBe(true);
  });

  test("during the lock, with conflicts and a betrayal on record", async () => {
    const w = await world();
    startDefcon(w.game);
    startClock(w);
    seedConflicts(w);
    executeTicks(w.game, 10);

    const rec = defconRecord(snapshotGame(w.game));
    expect(rec.level).toBe(5);
    expect(rec.bonusTicks).toBeGreaterThan(0);
    expect(rec.pairLastAttackTick.length).toBeGreaterThanOrEqual(3);
    expect(rec.traitorLastCountedTick).toHaveLength(1);

    const restored = await expectSnapshotRoundTrip(w.game, MAP, 30);
    expect(defconView(restored)).toEqual(defconView(w.game));
    expect(canLaunch(restored, w)).toEqual([false, false, false]);
  });

  test("after each level change, down to DEFCON 1", async () => {
    const w = await world();
    startDefcon(w.game);
    startClock(w);
    seedConflicts(w);
    for (const level of [4, 3, 2, 1]) {
      advanceTo(w.game, level);
      const restored = await expectSnapshotRoundTrip(w.game, MAP, 30);
      expect(defconView(restored), `DEFCON ${level}`).toEqual(
        defconView(w.game),
      );
      const unlocked = level <= MOD_CONFIG.defcon.nukeUnlockLevel;
      expect(canLaunch(restored, w), `DEFCON ${level}`).toEqual(
        NUKES.map(() => unlocked),
      );
    }
  }, 120_000);

  test("restored mid-lock: nukes stay locked, and both games unlock on the same tick", async () => {
    const w = await world();
    startDefcon(w.game);
    startClock(w);
    seedConflicts(w);
    advanceTo(w.game, 3);
    executeTicks(w.game, 7);

    const { bytes, restored, again } = await roundTrip(w.game, MAP);
    expect(diffSnapshots(bytes, again)).toEqual([]);
    expect(defconView(restored)).toEqual(defconView(w.game));
    expect(defconView(restored)).toMatchObject({
      level: 3,
      nukesLocked: true,
      blocks: [true, true, true],
    });
    expect(canLaunch(restored, w)).toEqual([false, false, false]);
    const reachedAt = defconView(w.game).reachedAt;
    expect(reachedAt.slice(2)).not.toContain(null); // 3, 4 and 5 reached
    expect(reachedAt.slice(0, 2)).toEqual([null, null]);

    // The restore registered the copy for its own game only: ticking the
    // copy alone leaves the original's DEFCON untouched.
    const settings = defconSettings(restored.config());
    const toUnlock = settings.latestTicks[2] + settings.minTicksBetweenSteps; // an upper bound
    let unlockTick: number | null = null;
    for (let i = 0; i < toUnlock && unlockTick === null; i++) {
      restored.executeNextTick();
      if (!modDefconNukesLocked(restored)) unlockTick = restored.ticks();
    }
    expect(unlockTick).not.toBeNull();
    expect(defconLevel(restored)).toBe(2);
    expect(defconLevel(w.game)).toBe(3);
    expect(canLaunch(restored, w)).toEqual([true, true, true]);
    expect(canLaunch(w.game, w)).toEqual([false, false, false]);

    // The original, ticked on its own, unlocks on exactly the same tick.
    while (w.game.ticks() < unlockTick! - 1) w.game.executeNextTick();
    expect(modDefconNukesLocked(w.game)).toBe(true);
    w.game.executeNextTick();
    expect(modDefconNukesLocked(w.game)).toBe(false);
    expect(defconView(w.game)).toEqual(defconView(restored));
  }, 120_000);
});

// ---------------------------------------------------------------------------
// A scripted full game (tests/util/ScriptedGame.ts, the way
// tests/core/snapshot/FullGameSnapshot.test.ts drives it) with the nuke lock
// ON. DEFCON is added by GameRunner.init(), so this is the real pipeline.
// ---------------------------------------------------------------------------

const SCRIPTED_MAP = "world";
const SCRIPTED_TICKS = 900;
const CHECK_EVERY = 100;
const SCRIPTED_TIMEOUT = 300_000;

function hash(game: Game): number {
  return (game as unknown as { hash(): number }).hash();
}

interface Reference {
  hashes: number[];
  views: string[];
  checkpoints: Map<number, Uint8Array>;
  final: Uint8Array;
  levels: Set<number | null>;
  /** Nuke units seen in flight while DEFCON locked nukes. */
  nukesWhileLocked: number;
  /** Ticks a human held a finished silo while locked (the lock mattered). */
  humanSiloTicksWhileLocked: number;
}

function view(game: Game): string {
  return JSON.stringify(defconView(game));
}

async function playReference(start: GameStartInfo): Promise<Reference> {
  const runner = await createScriptedRunner(SCRIPTED_MAP, start);
  const ref: Reference = {
    hashes: [],
    views: [],
    checkpoints: new Map(),
    final: new Uint8Array(),
    levels: new Set(),
    nukesWhileLocked: 0,
    humanSiloTicksWhileLocked: 0,
  };
  ref.views[runner.game.ticks()] = view(runner.game);
  while (runner.game.ticks() < SCRIPTED_TICKS) {
    const tick = runner.game.ticks();
    if (tick % CHECK_EVERY === 0) ref.checkpoints.set(tick, runner.snapshot());
    stepScripted(runner);
    const game = runner.game;
    ref.hashes[game.ticks()] = hash(game);
    ref.views[game.ticks()] = view(game);
    ref.levels.add(defconLevel(game));
    if (modDefconNukesLocked(game)) {
      ref.nukesWhileLocked += game.units(NUKES).length;
      const humanSilo = game
        .units(UnitType.MissileSilo)
        .some(
          (u) =>
            u.owner().type() === PlayerType.Human && !u.isUnderConstruction(),
        );
      if (humanSilo) ref.humanSiloTicksWhileLocked++;
    }
  }
  ref.final = runner.snapshot();
  return ref;
}

function expectOnTrack(runner: GameRunner, ref: Reference): void {
  const tick = runner.game.ticks();
  if (hash(runner.game) !== ref.hashes[tick]) {
    throw new Error(`hash diverged at tick ${tick}`);
  }
  if (view(runner.game) !== ref.views[tick]) {
    throw new Error(
      `DEFCON diverged at tick ${tick}: ${view(runner.game)} !== ${ref.views[tick]}`,
    );
  }
  const checkpoint = ref.checkpoints.get(tick);
  if (checkpoint !== undefined) {
    const diffs = diffSnapshots(runner.snapshot(), checkpoint);
    if (diffs.length > 0) {
      throw new Error(`state diverged at tick ${tick}:\n${diffs.join("\n")}`);
    }
  }
}

const LOCKED: Partial<GameConfig> = { mod: { defcon: { lockNukes: true } } };

const VARIANTS: [string, Partial<GameConfig>, boolean][] = [
  // No level change within the run (DEFCON 4 needs 1:12 after peace time).
  ["no timer", LOCKED, false],
  // A 5-minute timer shrinks the schedule to its minimum (40%), so DEFCON 4
  // falls inside the run: the change itself crosses snapshots.
  ["5-minute timer", { ...LOCKED, maxTimerValue: 5 }, true],
];

describe.each(VARIANTS)(
  "DEFCON in a scripted full game with the nuke lock on: %s",
  (_, overrides, expectLevelChange) => {
    const start = scriptedGameStart(overrides);
    let reference: Reference;

    beforeAll(async () => {
      reference = await playReference(start);
    }, SCRIPTED_TIMEOUT);

    test("DEFCON ran, locked every nuke, and (with a timer) changed level", () => {
      expect(reference.levels.has(null)).toBe(false);
      expect(reference.levels.has(5)).toBe(true);
      expect(reference.nukesWhileLocked).toBe(0);
      // Scripted humans (infinite gold) try nukes whenever they own a silo.
      expect(reference.humanSiloTicksWhileLocked).toBeGreaterThan(0);
      const lowest = Math.min(...[...reference.levels].map((l) => l ?? 5));
      if (expectLevelChange) expect(lowest).toBeLessThan(5);
      else expect(lowest).toBe(5);
      // The lock held for the whole run (DEFCON 2 is minutes away).
      expect(lowest).toBeGreaterThan(MOD_CONFIG.defcon.nukeUnlockLevel);
    });

    test(
      "snapshot -> restore -> snapshot is byte-identical at every checkpoint",
      async () => {
        for (const [tick, bytes] of reference.checkpoints) {
          const restored = await restoreScriptedRunner(
            SCRIPTED_MAP,
            start,
            bytes,
          );
          expect(restored.game.ticks()).toBe(tick);
          expect(
            diffSnapshots(restored.snapshot(), bytes),
            `tick ${tick}`,
          ).toEqual([]);
          expect(view(restored.game), `tick ${tick}`).toBe(
            reference.views[tick],
          );
        }
      },
      SCRIPTED_TIMEOUT,
    );

    test(
      "restoring every 100 ticks continues exactly like the straight run",
      async () => {
        let runner = await restoreScriptedRunner(
          SCRIPTED_MAP,
          start,
          reference.checkpoints.get(0)!,
        );
        while (runner.game.ticks() < SCRIPTED_TICKS) {
          stepScripted(runner);
          expectOnTrack(runner, reference);
          if (runner.game.ticks() % CHECK_EVERY === 0) {
            runner = await restoreScriptedRunner(
              SCRIPTED_MAP,
              start,
              runner.snapshot(),
            );
            expectOnTrack(runner, reference);
          }
        }
        expect(diffSnapshots(runner.snapshot(), reference.final)).toEqual([]);
      },
      SCRIPTED_TIMEOUT,
    );
  },
);
