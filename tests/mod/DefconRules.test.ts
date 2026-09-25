import { describe, expect, test } from "vitest";
import { Config } from "../../src/core/configuration/Config";
import { Nukes, UnitType } from "../../src/core/game/Game";
import { PseudoRandom } from "../../src/core/PseudoRandom";
import { GameConfig } from "../../src/core/Schemas";
import {
  blocksUnit,
  DEFCON_START_LEVEL,
  enabledNukeWeapons,
  isNukeWeapon,
  nextDefconLevel,
  NUKE_WEAPON_TYPES,
  nukesLockedAt,
  nukesPossible,
  pairKey,
  scaledBonus,
  scaleForTimer,
  timerScalePercent,
} from "../../src/mod/core/defcon/DefconRules";
import {
  DefconStepLevel,
  DefconTuning,
  MOD_CONFIG,
} from "../../src/mod/core/ModConfig";

// Pure DEFCON rules (src/mod/core/defcon/DefconRules.ts). A small hand-made
// tuning keeps the numbers readable; tests that are about the shipped
// numbers read them from MOD_CONFIG instead of repeating them.

const T: DefconTuning = {
  ...MOD_CONFIG.defcon,
  enabled: true,
  lockNukes: true,
  nukeUnlockLevel: 2,
  latestTicks: { 4: 1000, 3: 2000, 2: 3000, 1: 4000 },
  earliestTicks: { 4: 300, 3: 800, 2: 1500, 1: 2500 },
  minTicksBetweenSteps: 200,
  newConflictBonusTicks: 100,
  conflictQuietTicks: 500,
  betrayalBonusTicks: 150,
  betrayalCooldownTicks: 400,
  nationVsNationPercent: 50,
  referencePlayers: 8,
  timerReferenceMinutes: 20,
  timerMinScalePercent: 40,
};

const STEP_LEVELS: DefconStepLevel[] = [4, 3, 2, 1];
const ALL_LEVELS = [5, 4, 3, 2, 1];

const NOT_NUKE_WEAPONS = Object.values(UnitType).filter(
  (t) =>
    t !== UnitType.AtomBomb &&
    t !== UnitType.HydrogenBomb &&
    t !== UnitType.MIRV,
);

/** Stand-in for Config: only the one method the rules read. */
function unitSettings(disabled: UnitType[]) {
  const set = new Set(disabled);
  return { isUnitDisabled: (t: UnitType) => set.has(t) };
}

/** The units the public "nukes disabled" modifier turns off (MapPlaylist). */
const PUBLIC_NUKES_DISABLED = [
  UnitType.MissileSilo,
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.SAMLauncher,
];

describe("nextDefconLevel: thresholds", () => {
  test("starts at DEFCON 5", () => {
    expect(DEFCON_START_LEVEL).toBe(5);
  });

  test("steps once the clock reaches the latest time and the earliest time has passed", () => {
    for (const target of STEP_LEVELS) {
      const level = target + 1;
      const latest = T.latestTicks[target];
      const earliest = T.earliestTicks[target];
      // Plenty of real time: the clock ("latest") decides, to the tick.
      expect(nextDefconLevel(level, null, 99_999, latest, latest - 1, T)).toBe(
        level,
      );
      expect(nextDefconLevel(level, null, 99_999, latest, latest, T)).toBe(
        target,
      );
      // Plenty of bonus on the clock: real time ("earliest") decides.
      expect(
        nextDefconLevel(level, null, 99_999, earliest - 1, 99_999, T),
      ).toBe(level);
      expect(nextDefconLevel(level, null, 99_999, earliest, 99_999, T)).toBe(
        target,
      );
    }
  });

  test("time alone (no bonus) steps exactly at the latest time", () => {
    for (const target of STEP_LEVELS) {
      const t = T.latestTicks[target];
      expect(nextDefconLevel(target + 1, null, t, t - 1, t - 1, T)).toBe(
        target + 1,
      );
      expect(nextDefconLevel(target + 1, null, t, t, t, T)).toBe(target);
    }
  });

  test("however big the clock bonus, no level comes before its earliest time", () => {
    for (const target of STEP_LEVELS) {
      const earliest = T.earliestTicks[target];
      for (const elapsed of [0, 1, earliest - 1]) {
        expect(
          nextDefconLevel(target + 1, null, elapsed, elapsed, 1_000_000, T),
        ).toBe(target + 1);
      }
    }
  });

  test("at most one step per minTicksBetweenSteps", () => {
    const last = 5000;
    const gap = T.minTicksBetweenSteps;
    expect(nextDefconLevel(4, last, last + gap - 1, 99_999, 99_999, T)).toBe(4);
    expect(nextDefconLevel(4, last, last + gap, 99_999, 99_999, T)).toBe(3);
    // Before the first step there is no gap to respect.
    expect(nextDefconLevel(5, null, 0, 99_999, 99_999, T)).toBe(4);
  });

  test("steps at most one level per call, even far past every threshold", () => {
    for (const level of [5, 4, 3, 2]) {
      expect(nextDefconLevel(level, null, 1e6, 1e6, 1e6, T)).toBe(level - 1);
    }
  });

  test("never goes up, and stays at 1", () => {
    for (const level of ALL_LEVELS) {
      // Nothing reached: the level stays where it is, it never goes back up.
      expect(nextDefconLevel(level, 0, 0, 0, 0, T)).toBe(level);
      for (const clock of [0, 500, 1000, 2500, 4000, 1e6]) {
        const next = nextDefconLevel(level, null, 1e6, 1e6, clock, T);
        expect(next).toBeLessThanOrEqual(level);
        expect(next).toBeGreaterThanOrEqual(Math.max(1, level - 1));
      }
    }
    expect(nextDefconLevel(1, null, 1e6, 1e6, 1e6, T)).toBe(1);
    expect(nextDefconLevel(1, 0, 1e6, 1e6, 1e6, T)).toBe(1);
  });
});

describe("scaledBonus", () => {
  test("full bonus up to the reference lobby size (small lobbies are not boosted)", () => {
    for (const alive of [0, 1, 2, 7, 8]) {
      expect(scaledBonus(300, 100, alive, 8)).toBe(300);
    }
  });

  test("big lobbies shrink the bonus by reference / alive players, rounded down", () => {
    expect(scaledBonus(300, 100, 16, 8)).toBe(150);
    expect(scaledBonus(300, 100, 24, 8)).toBe(100);
    expect(scaledBonus(300, 100, 9, 8)).toBe(266); // 266.66…
    expect(scaledBonus(300, 100, 100, 8)).toBe(24);
    expect(scaledBonus(600, 100, 400, 8)).toBe(12);
    expect(scaledBonus(1, 100, 9, 8)).toBe(0); // 0.88… rounds down to 0
  });

  test("the nation percent weights the bonus (e.g. 50%)", () => {
    expect(scaledBonus(300, 50, 8, 8)).toBe(150);
    expect(scaledBonus(301, 50, 8, 8)).toBe(150); // 150.5
    expect(scaledBonus(300, 50, 16, 8)).toBe(75); // both factors together
    expect(scaledBonus(300, 0, 8, 8)).toBe(0);
    expect(scaledBonus(300, 100, 8, 8)).toBe(300);
    expect(scaledBonus(300, 150, 8, 8)).toBe(450);
  });

  test("always an integer", () => {
    for (const bonus of [0, 1, 7, 99, 300, 601]) {
      for (const percent of [0, 1, 33, 50, 67, 100, 133]) {
        for (const alive of [0, 1, 3, 8, 9, 13, 57, 400]) {
          for (const ref of [1, 3, 8, 11]) {
            const b = scaledBonus(bonus, percent, alive, ref);
            expect(Number.isInteger(b)).toBe(true);
            expect(b).toBe(
              Math.floor(
                (bonus * percent * ref) / (100 * Math.max(ref, alive)),
              ),
            );
          }
        }
      }
    }
  });

  test("the shipped nation-vs-nation factor is 100 (1.0)", () => {
    expect(MOD_CONFIG.defcon.nationVsNationPercent).toBe(100);
  });
});

describe("pairKey", () => {
  test("is symmetric", () => {
    for (const [a, b] of [
      [0, 1],
      [3, 7],
      [12, 4095],
      [4095, 4094],
    ]) {
      expect(pairKey(a, b)).toBe(pairKey(b, a));
    }
  });

  test("is unique per unordered pair of small ids", () => {
    const seen = new Map<number, string>();
    const ids = [0, 1, 2, 3, 17, 255, 256, 1000, 4094, 4095];
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b) continue;
        const key = pairKey(a, b);
        expect(Number.isInteger(key)).toBe(true);
        expect(seen.get(key)).toBeUndefined();
        seen.set(key, `${a}-${b}`);
      }
    }
  });
});

describe("nuke types", () => {
  test("NUKE_WEAPON_TYPES is the Nukes group without MIRVWarhead", () => {
    expect(NUKE_WEAPON_TYPES).not.toContain(UnitType.MIRVWarhead);
    expect([...NUKE_WEAPON_TYPES].sort()).toEqual(
      Nukes.types.filter((t) => t !== UnitType.MIRVWarhead).sort(),
    );
    expect([...NUKE_WEAPON_TYPES].sort()).toEqual(
      [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV].sort(),
    );
    expect(isNukeWeapon(UnitType.MIRVWarhead)).toBe(false);
    expect(isNukeWeapon(UnitType.MissileSilo)).toBe(false);
    for (const t of NUKE_WEAPON_TYPES) expect(isNukeWeapon(t)).toBe(true);
  });

  test("nothing disabled: all nuke weapons are possible", () => {
    const s = unitSettings([]);
    expect(enabledNukeWeapons(s)).toEqual([...NUKE_WEAPON_TYPES]);
    expect(nukesPossible(s)).toBe(true);
  });

  test("missile silo disabled: no nukes at all", () => {
    const s = unitSettings([UnitType.MissileSilo]);
    expect(enabledNukeWeapons(s)).toEqual([]);
    expect(nukesPossible(s)).toBe(false);
  });

  test("a single type disabled: only that type is missing", () => {
    for (const off of NUKE_WEAPON_TYPES) {
      const s = unitSettings([off]);
      expect(enabledNukeWeapons(s)).toEqual(
        NUKE_WEAPON_TYPES.filter((t) => t !== off),
      );
      expect(nukesPossible(s)).toBe(true);
    }
  });

  test("all three nuke types disabled (silo still allowed): no nukes", () => {
    const s = unitSettings([...NUKE_WEAPON_TYPES]);
    expect(enabledNukeWeapons(s)).toEqual([]);
    expect(nukesPossible(s)).toBe(false);
  });

  test("the public 'nukes disabled' modifier (real Config): no nukes", () => {
    const config = new Config(
      { disabledUnits: PUBLIC_NUKES_DISABLED } as unknown as GameConfig,
      null,
      false,
    );
    expect(enabledNukeWeapons(config)).toEqual([]);
    expect(nukesPossible(config)).toBe(false);
  });

  test("SAMs or other units disabled do not change the nuke list", () => {
    const s = unitSettings([
      UnitType.SAMLauncher,
      UnitType.City,
      UnitType.Port,
      UnitType.MIRVWarhead,
    ]);
    expect(enabledNukeWeapons(s)).toEqual([...NUKE_WEAPON_TYPES]);
    expect(nukesPossible(s)).toBe(true);
  });
});

describe("blocksUnit / nukesLockedAt", () => {
  test("nuke weapons are blocked above the unlock level, free from it on", () => {
    for (const level of ALL_LEVELS) {
      const locked = level > T.nukeUnlockLevel;
      expect(nukesLockedAt(level, T, false)).toBe(locked);
      for (const t of NUKE_WEAPON_TYPES) {
        expect(blocksUnit(level, t, T, false)).toBe(locked);
      }
    }
    // The shipped unlock level is DEFCON 2.
    expect(MOD_CONFIG.defcon.nukeUnlockLevel).toBe(2);
    expect(blocksUnit(3, UnitType.AtomBomb, MOD_CONFIG.defcon, false)).toBe(
      true,
    );
    expect(blocksUnit(2, UnitType.AtomBomb, MOD_CONFIG.defcon, false)).toBe(
      false,
    );
  });

  test("MIRV warheads are never blocked (MIRVs in flight must work)", () => {
    for (const level of ALL_LEVELS) {
      for (const gameOver of [false, true]) {
        expect(blocksUnit(level, UnitType.MIRVWarhead, T, gameOver)).toBe(
          false,
        );
      }
    }
  });

  test("silos, silo upgrades and every other unit are never blocked", () => {
    for (const level of ALL_LEVELS) {
      for (const t of NOT_NUKE_WEAPONS) {
        expect(blocksUnit(level, t, T, false)).toBe(false);
      }
    }
    expect(NOT_NUKE_WEAPONS).toContain(UnitType.MissileSilo);
    expect(NOT_NUKE_WEAPONS).toContain(UnitType.SAMLauncher);
  });

  test("lockNukes off: never blocked", () => {
    const off = { ...T, lockNukes: false };
    for (const level of ALL_LEVELS) {
      expect(nukesLockedAt(level, off, false)).toBe(false);
      for (const t of NUKE_WEAPON_TYPES) {
        expect(blocksUnit(level, t, off, false)).toBe(false);
      }
    }
  });

  test("game over: never blocked", () => {
    for (const level of ALL_LEVELS) {
      expect(nukesLockedAt(level, T, true)).toBe(false);
      for (const t of NUKE_WEAPON_TYPES) {
        expect(blocksUnit(level, t, T, true)).toBe(false);
      }
    }
  });

  test("a different unlock level is respected", () => {
    const at3 = { ...T, nukeUnlockLevel: 3 };
    expect(blocksUnit(4, UnitType.AtomBomb, at3, false)).toBe(true);
    expect(blocksUnit(3, UnitType.AtomBomb, at3, false)).toBe(false);
  });
});

describe("timerScalePercent", () => {
  test("shorter timers scale proportionally, clamped at the minimum", () => {
    expect(timerScalePercent(10, T)).toBe(50);
    expect(timerScalePercent(15, T)).toBe(75);
    expect(timerScalePercent(19, T)).toBe(95);
    expect(timerScalePercent(9, T)).toBe(45);
    expect(timerScalePercent(8, T)).toBe(40);
    expect(timerScalePercent(5, T)).toBe(40); // 25% clamped
    expect(timerScalePercent(1, T)).toBe(40); // 5% clamped
  });

  test("never longer: 20 minutes, longer timers and no timer run at 100%", () => {
    for (const t of [20, 21, 30, 60, 120, null, undefined]) {
      expect(timerScalePercent(t, T)).toBe(100);
    }
  });

  test("the minimum percent is configurable", () => {
    const min60 = { ...T, timerMinScalePercent: 60 };
    expect(timerScalePercent(10, min60)).toBe(60);
    expect(timerScalePercent(5, min60)).toBe(60);
    expect(timerScalePercent(15, min60)).toBe(75);
    expect(timerScalePercent(30, min60)).toBe(100);
  });

  test("the reference length is configurable", () => {
    const ref30 = { ...T, timerReferenceMinutes: 30 };
    expect(timerScalePercent(15, ref30)).toBe(50);
    expect(timerScalePercent(20, ref30)).toBe(66); // 66.66… rounded down
    expect(timerScalePercent(30, ref30)).toBe(100);
  });

  test("the shipped reference is 20 minutes and the minimum 40%", () => {
    const d = MOD_CONFIG.defcon;
    expect(timerScalePercent(10, d)).toBe(50);
    expect(timerScalePercent(15, d)).toBe(75);
    expect(timerScalePercent(5, d)).toBe(40);
    expect(timerScalePercent(20, d)).toBe(100);
    expect(timerScalePercent(null, d)).toBe(100);
  });

  test("always an integer percentage between the minimum and 100", () => {
    for (let t = 1; t <= 120; t++) {
      for (const peace of [0, 50, 300, 2400, 3000, 72000]) {
        const p = timerScalePercent(t, T, peace);
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(T.timerMinScalePercent);
        expect(p).toBeLessThanOrEqual(100);
      }
    }
  });

  // The DEFCON clock only starts when peace time ends, the timer before it:
  // what counts is the time the timer leaves after peace time.
  test("peace time counts against the timer", () => {
    expect(timerScalePercent(10, T, 3000)).toBe(40); // 5 min left: 25% -> 40%
    expect(timerScalePercent(20, T, 6000)).toBe(50); // 10 min left
    expect(timerScalePercent(15, T, 2400)).toBe(55); // 11 min left
    expect(timerScalePercent(10, T, 300)).toBe(47); // ranked 1v1: 9.5 min
    expect(timerScalePercent(15, T, 300)).toBe(72); // ranked 1v1: 14.5 min
    expect(timerScalePercent(10, T, 600)).toBe(45); // ranked 2v2: 9 min
    expect(timerScalePercent(15, T, 600)).toBe(70); // ranked 2v2: 14 min
    expect(timerScalePercent(20, T, 50)).toBe(99); // default 5 s immunity
  });

  test("peace time longer than the timer: clamped at the minimum", () => {
    expect(timerScalePercent(5, T, 6000)).toBe(40); // nothing left
    expect(timerScalePercent(10, T, 72000)).toBe(40);
  });

  test("peace time never lengthens the schedule", () => {
    expect(timerScalePercent(30, T, 3000)).toBe(100); // 25 min left
    expect(timerScalePercent(20, T, 0)).toBe(100);
    expect(timerScalePercent(null, T, 72000)).toBe(100); // no timer
    expect(timerScalePercent(undefined, T, 3000)).toBe(100);
  });
});

describe("scaleForTimer", () => {
  function scaledPart(t: DefconTuning) {
    return {
      latestTicks: t.latestTicks,
      earliestTicks: t.earliestTicks,
      minTicksBetweenSteps: t.minTicksBetweenSteps,
    };
  }
  /** Everything scaleForTimer must leave alone. */
  function restPart(t: DefconTuning): Partial<DefconTuning> {
    const rest: Partial<DefconTuning> = { ...t };
    delete rest.latestTicks;
    delete rest.earliestTicks;
    delete rest.minTicksBetweenSteps;
    return rest;
  }
  function expectScaled(base: DefconTuning, timer: number, percent: number) {
    const s = scaleForTimer(base, timer);
    const f = (ticks: number) => Math.floor((ticks * percent) / 100);
    for (const l of STEP_LEVELS) {
      expect(s.latestTicks[l]).toBe(f(base.latestTicks[l]));
      expect(s.earliestTicks[l]).toBe(f(base.earliestTicks[l]));
    }
    expect(s.minTicksBetweenSteps).toBe(f(base.minTicksBetweenSteps));
  }

  test("10 minutes: 50%, 15 minutes: 75%, 5 and 1 minute: clamped to 40%, 19: 95%", () => {
    expectScaled(MOD_CONFIG.defcon, 10, 50);
    expectScaled(MOD_CONFIG.defcon, 15, 75);
    expectScaled(MOD_CONFIG.defcon, 5, 40);
    expectScaled(MOD_CONFIG.defcon, 1, 40);
    expectScaled(MOD_CONFIG.defcon, 19, 95);
    expectScaled(T, 10, 50);
    expectScaled(T, 15, 75);
    expectScaled(T, 5, 40);
  });

  test("the 10-minute ranked example: DEFCON 2 comes at half the usual times", () => {
    const d = MOD_CONFIG.defcon;
    const s = scaleForTimer(d, 10);
    // With the shipped numbers that is between 2:48 and 4:48.
    expect(s.earliestTicks[2]).toBe(Math.floor(d.earliestTicks[2] / 2));
    expect(s.latestTicks[2]).toBe(Math.floor(d.latestTicks[2] / 2));
  });

  test("with peace time, DEFCON 2 by time still comes before the timer ends", () => {
    const d = MOD_CONFIG.defcon;
    for (const [timer, peace, percent] of [
      [10, 3000, 40],
      [20, 6000, 50],
      [15, 2400, 55],
      [10, 300, 47],
      [15, 600, 70],
    ]) {
      const s = scaleForTimer(d, timer, peace);
      expect(s.latestTicks[2]).toBe(
        Math.floor((d.latestTicks[2] * percent) / 100),
      );
      expect(s.minTicksBetweenSteps).toBe(
        Math.floor((d.minTicksBetweenSteps * percent) / 100),
      );
      expect(peace + s.latestTicks[2]).toBeLessThan(timer * 600);
      // Bonuses are never scaled.
      expect(s.newConflictBonusTicks).toBe(d.newConflictBonusTicks);
      expect(s.betrayalBonusTicks).toBe(d.betrayalBonusTicks);
    }
  });

  test("never longer: 20, 30, no timer give the unchanged tuning", () => {
    for (const t of [20, 30, 120, null, undefined]) {
      expect(scaleForTimer(MOD_CONFIG.defcon, t)).toEqual(MOD_CONFIG.defcon);
      expect(scaleForTimer(T, t)).toEqual(T);
    }
    // And no timer ever makes a value bigger.
    for (let t = 1; t <= 120; t++) {
      const s = scaleForTimer(T, t);
      for (const l of STEP_LEVELS) {
        expect(s.latestTicks[l]).toBeLessThanOrEqual(T.latestTicks[l]);
        expect(s.earliestTicks[l]).toBeLessThanOrEqual(T.earliestTicks[l]);
      }
      expect(s.minTicksBetweenSteps).toBeLessThanOrEqual(
        T.minTicksBetweenSteps,
      );
    }
  });

  test("a configured minimum percent is used", () => {
    const min60 = { ...T, timerMinScalePercent: 60 };
    expectScaled(min60, 5, 60);
    expectScaled(min60, 10, 60);
    expectScaled(min60, 15, 75);
  });

  test("only latest, earliest and the step gap change; bonuses and the rest stay identical", () => {
    for (const timer of [1, 5, 10, 15, 19]) {
      for (const base of [MOD_CONFIG.defcon, T]) {
        const s = scaleForTimer(base, timer);
        expect(Object.keys(s).sort()).toEqual(Object.keys(base).sort());
        expect(restPart(s)).toEqual(restPart(base));
        expect(s.newConflictBonusTicks).toBe(base.newConflictBonusTicks);
        expect(s.betrayalBonusTicks).toBe(base.betrayalBonusTicks);
        expect(s.conflictQuietTicks).toBe(base.conflictQuietTicks);
        expect(s.betrayalCooldownTicks).toBe(base.betrayalCooldownTicks);
        expect(s.heartbeatTicks).toBe(base.heartbeatTicks);
        expect(scaledPart(s)).not.toEqual(scaledPart(base));
      }
    }
  });

  test("all results are integers, also for odd inputs", () => {
    const odd: DefconTuning = {
      ...T,
      latestTicks: { 4: 2401, 3: 4799, 2: 7203, 1: 9607 },
      earliestTicks: { 4: 901, 3: 2399, 2: 4201, 1: 6603 },
      minTicksBetweenSteps: 601,
    };
    for (let timer = 1; timer <= 25; timer++) {
      const s = scaleForTimer(odd, timer);
      for (const l of STEP_LEVELS) {
        expect(Number.isInteger(s.latestTicks[l])).toBe(true);
        expect(Number.isInteger(s.earliestTicks[l])).toBe(true);
      }
      expect(Number.isInteger(s.minTicksBetweenSteps)).toBe(true);
    }
    expect(scaleForTimer(odd, 15).latestTicks[4]).toBe(1800); // 1800.75
  });

  test("does not modify its input", () => {
    const base: DefconTuning = structuredClone(T);
    const copy = structuredClone(base);
    scaleForTimer(base, 10);
    scaleForTimer(base, 5);
    expect(base).toEqual(copy);
  });
});

describe("determinism", () => {
  interface Step {
    tick: number;
    level: number;
    bonus: number;
  }

  /**
   * A long made-up game: seeded random conflicts and betrayals move the
   * clock, the rules decide the level every tick. Returns every step.
   */
  function run(seed: number, tuning: DefconTuning): Step[] {
    const rnd = new PseudoRandom(seed);
    let level = DEFCON_START_LEVEL;
    let lastStep: number | null = null;
    let bonus = 0;
    const steps: Step[] = [];
    for (let tick = 0; tick < 12_000; tick++) {
      const alive = rnd.nextInt(2, 60);
      if (rnd.nextInt(0, 100) === 0) {
        const nations = rnd.nextInt(0, 2) === 0;
        bonus += scaledBonus(
          tuning.newConflictBonusTicks,
          nations ? tuning.nationVsNationPercent : 100,
          alive,
          tuning.referencePlayers,
        );
      }
      if (rnd.nextInt(0, 400) === 0) {
        bonus += scaledBonus(
          tuning.betrayalBonusTicks,
          100,
          alive,
          tuning.referencePlayers,
        );
      }
      const next = nextDefconLevel(
        level,
        lastStep,
        tick,
        tick,
        tick + bonus,
        tuning,
      );
      if (next !== level) {
        level = next;
        lastStep = tick;
        steps.push({ tick, level, bonus });
      }
    }
    return steps;
  }

  test("a long sequence run twice gives identical results", () => {
    for (const tuning of [T, MOD_CONFIG.defcon, scaleForTimer(T, 10)]) {
      const a = run(12345, tuning);
      const b = run(12345, tuning);
      expect(a).toEqual(b);
      expect(a.map((s) => s.level)).toEqual([4, 3, 2, 1]);
    }
  });

  test("the sequence keeps every rule: one step down at a time, gaps, earliest times, integers", () => {
    for (const seed of [1, 2, 3, 99]) {
      const steps = run(seed, T);
      let prev = DEFCON_START_LEVEL;
      let prevTick: number | null = null;
      for (const s of steps) {
        expect(s.level).toBe(prev - 1);
        expect(Number.isInteger(s.bonus)).toBe(true);
        expect(s.tick).toBeGreaterThanOrEqual(
          T.earliestTicks[s.level as DefconStepLevel],
        );
        if (prevTick !== null) {
          expect(s.tick - prevTick).toBeGreaterThanOrEqual(
            T.minTicksBetweenSteps,
          );
        }
        prev = s.level;
        prevTick = s.tick;
      }
    }
  });
});
