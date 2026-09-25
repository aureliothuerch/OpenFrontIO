import { describe, expect, it } from "vitest";
import {
  AnnounceInput,
  AnnounceResult,
  AnnounceState,
  decideDefconAnnouncement,
  DefconUpdateLike,
  INITIAL_ANNOUNCE_STATE,
} from "../../../src/mod/client/defcon/DefconAnnounce";
import { MOD_CONFIG } from "../../../src/mod/core/ModConfig";

/**
 * decideDefconAnnouncement: when the client shows the DEFCON banner and plays
 * the alarm. Test number = rule number (R1-R11 in DefconAnnounce.ts). Test 9
 * also covers R6; R9 is checked inside tests 2, 3, 4 and 7. Every test checks
 * `announce`, `changedTo` and the follow-up state `next`.
 */

const W = MOD_CONFIG.defcon.announceWindowTicks;
const HEARTBEAT = MOD_CONFIG.defcon.heartbeatTicks;

type Flags = Partial<
  Pick<AnnounceInput, "catchingUp" | "replay" | "gameOver" | "windowTicks">
>;
type TickUpdates = DefconUpdateLike[] | null;

const SYNCED_5: AnnounceState = { synced: true, announcedLevel: 5 };

function upd(level: number, reachedAtTick: number): DefconUpdateLike {
  return { level, reachedAtTick };
}

function input(
  updates: AnnounceInput["updates"],
  tick: number,
  flags: Flags = {},
): AnnounceInput {
  return {
    updates,
    tick,
    catchingUp: false,
    replay: false,
    gameOver: false,
    windowTicks: W,
    ...flags,
  };
}

function synced(announcedLevel: number): AnnounceState {
  return { synced: true, announcedLevel };
}

/**
 * What the core sends: one update on every change (in the tick of the change)
 * and a heartbeat every HEARTBEAT ticks, nothing in between. The level steps
 * 5 -> 4 -> 3 -> ... at the given ticks; `reachedAtTick` is the tick the
 * current level was reached (0 while still at DEFCON 5). The client sees the
 * ticks from `firstTick` on (a late join starts later).
 */
function coreStream(
  changeTicks: readonly number[],
  endTick: number,
  firstTick = 0,
): TickUpdates[] {
  const stream: TickUpdates[] = [];
  let level = 5;
  let reachedAtTick = 0;
  for (let tick = 0; tick <= endTick; tick++) {
    const changed = changeTicks.includes(tick);
    if (changed) {
      level--;
      reachedAtTick = tick;
    }
    if (tick < firstTick) continue;
    stream.push(
      changed || tick % HEARTBEAT === 0 ? [upd(level, reachedAtTick)] : null,
    );
  }
  return stream;
}

interface Banner {
  tick: number;
  level: number | null;
}

/**
 * Feeds a per-tick stream (index 0 = `firstTick`) through the function, like
 * the client controller does once per tick.
 */
function runClient(
  stream: readonly TickUpdates[],
  flagsAt: (tick: number) => Flags = () => ({}),
  firstTick = 0,
) {
  let state = INITIAL_ANNOUNCE_STATE;
  const results: AnnounceResult[] = [];
  const banners: Banner[] = [];
  for (let i = 0; i < stream.length; i++) {
    const tick = firstTick + i;
    const r = decideDefconAnnouncement(
      state,
      input(stream[i], tick, flagsAt(tick)),
    );
    if (r.announce) banners.push({ tick, level: r.changedTo });
    results.push(r);
    state = r.next;
  }
  return { banners, results, final: state };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("decideDefconAnnouncement", () => {
  it("starts unsynced at DEFCON 5", () => {
    expect(INITIAL_ANNOUNCE_STATE).toEqual({
      synced: false,
      announcedLevel: 5,
    });
  });

  describe("R1: the first update is a sync, never announced", () => {
    it("1a. first update at DEFCON 5 -> no banner, synced at 5", () => {
      const r = decideDefconAnnouncement(
        INITIAL_ANNOUNCE_STATE,
        input([upd(5, 0)], 0),
      );
      expect(r.announce).toBe(false);
      expect(r.changedTo).toBeNull();
      expect(r.next).toEqual({ synced: true, announcedLevel: 5 });
    });

    it("1b. first update already at DEFCON 3 (late join) -> no banner, announced level 3", () => {
      // Reached in this very tick, i.e. well inside the window: still a sync.
      const r = decideDefconAnnouncement(
        INITIAL_ANNOUNCE_STATE,
        input([upd(3, 5000)], 5000),
      );
      expect(r.announce).toBe(false);
      expect(r.changedTo).toBeNull();
      expect(r.next).toEqual({ synced: true, announcedLevel: 3 });

      // 1c. The following heartbeat at 3 -> still no banner.
      const hb = decideDefconAnnouncement(r.next, input([upd(3, 5000)], 5001));
      expect(hb.announce).toBe(false);
      expect(hb.changedTo).toBeNull();
      expect(hb.next).toEqual({ synced: true, announcedLevel: 3 });
    });

    it("1d. a late join long after the change and a later heartbeat -> no banner", () => {
      const r = decideDefconAnnouncement(
        INITIAL_ANNOUNCE_STATE,
        input([upd(3, 4800)], 6000),
      );
      expect(r.announce).toBe(false);
      expect(r.changedTo).toBeNull();
      expect(r.next).toEqual(synced(3));

      const hb = decideDefconAnnouncement(r.next, input([upd(3, 4800)], 6050));
      expect(hb.announce).toBe(false);
      expect(hb.changedTo).toBeNull();
      expect(hb.next).toEqual(synced(3));
    });

    it("1e. the first update is a sync whatever the flags say", () => {
      for (const flags of [
        { catchingUp: true },
        { replay: true },
        { gameOver: true },
      ]) {
        const r = decideDefconAnnouncement(
          INITIAL_ANNOUNCE_STATE,
          input([upd(2, 100)], 100, flags),
        );
        expect(r.announce).toBe(false);
        expect(r.changedTo).toBeNull();
        expect(r.next).toEqual(synced(2));
      }
    });

    it("1f. a joined stream never announces the level it synced to", () => {
      // Join at tick 1000 at DEFCON 4 (reached at 990); nothing changes after.
      const stream = coreStream([990], 1500, 1000);
      const { banners, results, final } = runClient(stream, () => ({}), 1000);
      expect(banners).toEqual([]);
      expect(results.every((r) => r.changedTo === null)).toBe(true);
      expect(final).toEqual(synced(4));
    });
  });

  describe("R2: no announcement while catching up, and none afterwards", () => {
    it("2a. a change while catching up -> no banner, level moved on (R9)", () => {
      const r = decideDefconAnnouncement(
        SYNCED_5,
        input([upd(4, 600)], 600, { catchingUp: true }),
      );
      expect(r.announce).toBe(false);
      expect(r.changedTo).toBe(4);
      expect(r.next).toEqual(synced(4));

      // 2b. Catch-up ends while the change is still inside the window: no
      // late banner for it.
      const after = decideDefconAnnouncement(r.next, input([upd(4, 600)], 601));
      expect(after.announce).toBe(false);
      expect(after.changedTo).toBeNull();
      expect(after.next).toEqual(synced(4));

      // 2c. A new change afterwards is announced normally.
      const next = decideDefconAnnouncement(
        after.next,
        input([upd(3, 1200)], 1200),
      );
      expect(next.announce).toBe(true);
      expect(next.changedTo).toBe(3);
      expect(next.next).toEqual(synced(3));
    });

    it("2d. several changes during a long catch-up -> none announced, the next live one is", () => {
      // Catching up from tick 0 to 1250 (changes at 600 and 1200), then live.
      const stream = coreStream([600, 1200, 1800], 2000);
      const { banners, results, final } = runClient(stream, (tick) => ({
        catchingUp: tick <= 1250,
      }));
      expect(banners).toEqual([{ tick: 1800, level: 2 }]);
      expect(results[600]).toEqual({
        announce: false,
        changedTo: 4,
        next: synced(4),
      });
      expect(results[1200]).toEqual({
        announce: false,
        changedTo: 3,
        next: synced(3),
      });
      expect(final).toEqual(synced(2));
    });
  });

  describe("R3: no announcement in replays", () => {
    it("3a. a change in a replay at normal speed -> no banner, level moved on (R9)", () => {
      const r = decideDefconAnnouncement(
        SYNCED_5,
        input([upd(4, 600)], 600, { replay: true }),
      );
      expect(r.announce).toBe(false);
      expect(r.changedTo).toBe(4);
      expect(r.next).toEqual(synced(4));

      const hb = decideDefconAnnouncement(
        r.next,
        input([upd(4, 600)], 601, { replay: true }),
      );
      expect(hb.announce).toBe(false);
      expect(hb.changedTo).toBeNull();
      expect(hb.next).toEqual(synced(4));
    });

    it("3b. a whole replay 5 -> 1 -> no banner at all, but every level tracked", () => {
      const stream = coreStream([600, 1200, 1800, 2400], 2600);
      const { banners, results, final } = runClient(stream, () => ({
        replay: true,
      }));
      expect(banners).toEqual([]);
      expect(results.map((r) => r.changedTo).filter((l) => l !== null)).toEqual(
        [4, 3, 2, 1],
      );
      expect(final).toEqual(synced(1));
    });
  });

  describe("R4: no announcement once the game is over", () => {
    it("4a. a change after the game ended -> no banner, level moved on (R9)", () => {
      const r = decideDefconAnnouncement(
        synced(3),
        input([upd(2, 5000)], 5000, { gameOver: true }),
      );
      expect(r.announce).toBe(false);
      expect(r.changedTo).toBe(2);
      expect(r.next).toEqual(synced(2));

      const hb = decideDefconAnnouncement(
        r.next,
        input([upd(2, 5000)], 5001, { gameOver: true }),
      );
      expect(hb.announce).toBe(false);
      expect(hb.changedTo).toBeNull();
      expect(hb.next).toEqual(synced(2));
    });

    it("4b. change and game over in the same tick -> no banner", () => {
      const r = decideDefconAnnouncement(
        SYNCED_5,
        input([upd(4, 700)], 700, { gameOver: true }),
      );
      expect(r.announce).toBe(false);
      expect(r.changedTo).toBe(4);
      expect(r.next).toEqual(synced(4));
    });

    it("4c. game over mid-stream -> banners before it only", () => {
      const stream = coreStream([600, 1200, 1800], 2000);
      const { banners, final } = runClient(stream, (tick) => ({
        gameOver: tick >= 1200,
      }));
      expect(banners).toEqual([{ tick: 600, level: 4 }]);
      expect(final).toEqual(synced(2));
    });
  });

  describe("R5: never for DEFCON 5", () => {
    it("5a. an update with level 5 after the sync -> no banner", () => {
      const r = decideDefconAnnouncement(SYNCED_5, input([upd(5, 100)], 100));
      expect(r.announce).toBe(false);
      expect(r.changedTo).toBeNull();
      expect(r.next).toEqual(SYNCED_5);
    });

    it("5b. a game that stays at DEFCON 5 never announces", () => {
      const stream = coreStream([], 20 * HEARTBEAT);
      const { banners, results, final } = runClient(stream);
      expect(banners).toEqual([]);
      expect(results.every((r) => !r.announce && r.changedTo === null)).toBe(
        true,
      );
      expect(final).toEqual(SYNCED_5);
    });

    it("5c. not even from a state above 5 (never produced, defensive)", () => {
      const r = decideDefconAnnouncement(synced(6), input([upd(5, 100)], 100));
      expect(r.announce).toBe(false);
      expect(r.changedTo).toBe(5);
      expect(r.next).toEqual(SYNCED_5);
    });
  });

  describe("R6: exactly once per change", () => {
    it("6a. 5 -> 4 live -> exactly one banner", () => {
      const r = decideDefconAnnouncement(SYNCED_5, input([upd(4, 600)], 600));
      expect(r.announce).toBe(true);
      expect(r.changedTo).toBe(4);
      expect(r.next).toEqual(synced(4));

      // 6b. The same update again (heartbeat, still inside the window) -> none.
      const again = decideDefconAnnouncement(r.next, input([upd(4, 600)], 601));
      expect(again.announce).toBe(false);
      expect(again.changedTo).toBeNull();
      expect(again.next).toEqual(synced(4));

      // 6c. A level above the announced one (must never happen) -> none, and
      // the announced level is not raised.
      const higher = decideDefconAnnouncement(
        again.next,
        input([upd(5, 602)], 602),
      );
      expect(higher.announce).toBe(false);
      expect(higher.changedTo).toBeNull();
      expect(higher.next).toEqual(synced(4));

      // So the old level coming back is not announced a second time.
      const back = decideDefconAnnouncement(
        higher.next,
        input([upd(4, 603)], 603),
      );
      expect(back.announce).toBe(false);
      expect(back.changedTo).toBeNull();
      expect(back.next).toEqual(synced(4));
    });
  });

  describe("R7: only within the window after reachedAtTick", () => {
    it("7a. the default window is the plan's 4 s (40 ticks of 100 ms)", () => {
      expect(W).toBe(40);
    });

    it("7b. W - 1 ticks after the change -> banner", () => {
      const r = decideDefconAnnouncement(
        SYNCED_5,
        input([upd(4, 1000)], 1000 + W - 1),
      );
      expect(r.announce).toBe(true);
      expect(r.changedTo).toBe(4);
      expect(r.next).toEqual(synced(4));
    });

    it("7c. exactly W ticks after the change -> no banner, level still moves on (R9)", () => {
      const r = decideDefconAnnouncement(
        SYNCED_5,
        input([upd(4, 1000)], 1000 + W),
      );
      expect(r.announce).toBe(false);
      expect(r.changedTo).toBe(4);
      expect(r.next).toEqual(synced(4));

      // The stale change is never announced later.
      const hb = decideDefconAnnouncement(
        r.next,
        input([upd(4, 1000)], 1000 + W + 1),
      );
      expect(hb.announce).toBe(false);
      expect(hb.changedTo).toBeNull();
      expect(hb.next).toEqual(synced(4));
    });

    it("7d. far too late -> no banner, level still moves on (R9)", () => {
      const r = decideDefconAnnouncement(
        synced(3),
        input([upd(2, 7200)], 9000),
      );
      expect(r.announce).toBe(false);
      expect(r.changedTo).toBe(2);
      expect(r.next).toEqual(synced(2));
    });

    it("7e. in the tick of the change -> banner", () => {
      const r = decideDefconAnnouncement(SYNCED_5, input([upd(4, 1000)], 1000));
      expect(r.announce).toBe(true);
      expect(r.changedTo).toBe(4);
      expect(r.next).toEqual(synced(4));
    });

    it("7f. the window comes from the input", () => {
      const inside = decideDefconAnnouncement(
        SYNCED_5,
        input([upd(4, 1000)], 1004, { windowTicks: 5 }),
      );
      expect(inside.announce).toBe(true);
      expect(inside.changedTo).toBe(4);
      expect(inside.next).toEqual(synced(4));

      const outside = decideDefconAnnouncement(
        SYNCED_5,
        input([upd(4, 1000)], 1005, { windowTicks: 5 }),
      );
      expect(outside.announce).toBe(false);
      expect(outside.changedTo).toBe(4);
      expect(outside.next).toEqual(synced(4));
    });
  });

  describe("R8: several updates in one tick, only the last one counts", () => {
    it("8a. updates 4 and 3 in the same tick -> exactly one banner, for DEFCON 3", () => {
      const r = decideDefconAnnouncement(
        SYNCED_5,
        input([upd(4, 600), upd(3, 600)], 600),
      );
      expect(r.announce).toBe(true);
      expect(r.changedTo).toBe(3);
      expect(r.next).toEqual(synced(3));

      // No banner for the skipped DEFCON 4 later either.
      const hb = decideDefconAnnouncement(r.next, input([upd(3, 600)], 601));
      expect(hb.announce).toBe(false);
      expect(hb.changedTo).toBeNull();
      expect(hb.next).toEqual(synced(3));

      const late4 = decideDefconAnnouncement(
        hb.next,
        input([upd(4, 600)], 602),
      );
      expect(late4.announce).toBe(false);
      expect(late4.changedTo).toBeNull();
      expect(late4.next).toEqual(synced(3));
    });

    it("8b. a change plus a heartbeat in the same tick -> one banner", () => {
      const r = decideDefconAnnouncement(
        SYNCED_5,
        input([upd(4, 600), upd(4, 600)], 600),
      );
      expect(r.announce).toBe(true);
      expect(r.changedTo).toBe(4);
      expect(r.next).toEqual(synced(4));
    });

    it("8c. the last update decides even if an earlier one was stale", () => {
      // An old heartbeat queued first, then the fresh change.
      const r = decideDefconAnnouncement(
        synced(4),
        input([upd(4, 100), upd(3, 1200)], 1200),
      );
      expect(r.announce).toBe(true);
      expect(r.changedTo).toBe(3);
      expect(r.next).toEqual(synced(3));
    });

    it("8d. several updates in the first tick -> sync to the last one", () => {
      const r = decideDefconAnnouncement(
        INITIAL_ANNOUNCE_STATE,
        input([upd(5, 0), upd(4, 600)], 600),
      );
      expect(r.announce).toBe(false);
      expect(r.changedTo).toBeNull();
      expect(r.next).toEqual(synced(4));
    });
  });

  describe("R6 (test 9): every step 5 -> 1 announced exactly once", () => {
    it("9. 5 -> 4 -> 3 -> 2 -> 1 live with gaps -> one banner each, right level", () => {
      // The real time-only schedule of the mod config.
      const latest = MOD_CONFIG.defcon.latestTicks;
      const changeTicks = [latest[4], latest[3], latest[2], latest[1]];
      const stream = coreStream(changeTicks, latest[1] + 10 * HEARTBEAT);
      const { banners, results, final } = runClient(stream);

      expect(banners).toEqual([
        { tick: latest[4], level: 4 },
        { tick: latest[3], level: 3 },
        { tick: latest[2], level: 2 },
        { tick: latest[1], level: 1 },
      ]);
      expect(results.filter((r) => r.announce)).toHaveLength(4);
      expect(results.filter((r) => r.changedTo !== null)).toHaveLength(4);
      for (const [i, tick] of changeTicks.entries()) {
        expect(results[tick].next).toEqual(synced(4 - i));
      }
      expect(final).toEqual(synced(1));
    });

    it("9b. the same with a late-arriving update per step (inside the window)", () => {
      // The client sees each change a few ticks after the core made it.
      let state: AnnounceState = SYNCED_5;
      const announced: (number | null)[] = [];
      for (const [i, reached] of [600, 1200, 1800, 2400].entries()) {
        const level = 4 - i;
        const r = decideDefconAnnouncement(
          state,
          input([upd(level, reached)], reached + (W - 1)),
        );
        expect(r.announce).toBe(true);
        expect(r.changedTo).toBe(level);
        expect(r.next).toEqual(synced(level));
        announced.push(r.changedTo);
        // Heartbeats in between never re-announce.
        const hb = decideDefconAnnouncement(
          r.next,
          input([upd(level, reached)], reached + HEARTBEAT),
        );
        expect(hb.announce).toBe(false);
        expect(hb.changedTo).toBeNull();
        expect(hb.next).toEqual(synced(level));
        state = hb.next;
      }
      expect(announced).toEqual([4, 3, 2, 1]);
    });
  });

  describe("R10: no update this tick, the state stays as it is", () => {
    const states: AnnounceState[] = [
      INITIAL_ANNOUNCE_STATE,
      SYNCED_5,
      synced(3),
      synced(1),
    ];
    const flagSets: Flags[] = [
      {},
      { catchingUp: true },
      { replay: true },
      { gameOver: true },
    ];

    for (const [name, updates] of [
      ["null", null],
      ["undefined", undefined],
      ["[]", []],
    ] as const) {
      it(`10. updates = ${name} -> no banner, next === prev`, () => {
        for (const prev of states) {
          for (const flags of flagSets) {
            const r = decideDefconAnnouncement(
              prev,
              input(updates, 1234, flags),
            );
            expect(r.announce).toBe(false);
            expect(r.changedTo).toBeNull();
            expect(r.next).toBe(prev);
          }
        }
      });
    }

    it("10b. ticks without updates between a change and the next heartbeat keep the state", () => {
      const first = decideDefconAnnouncement(
        SYNCED_5,
        input([upd(4, 600)], 600),
      );
      expect(first.announce).toBe(true);
      expect(first.changedTo).toBe(4);
      let state = first.next;
      for (let tick = 601; tick < 650; tick++) {
        const r = decideDefconAnnouncement(state, input(null, tick));
        expect(r.announce).toBe(false);
        expect(r.changedTo).toBeNull();
        expect(r.next).toBe(state);
        state = r.next;
      }
      expect(state).toEqual(synced(4));
    });
  });

  describe("R11: pure and deterministic", () => {
    const cases: [AnnounceState, AnnounceInput][] = [
      [INITIAL_ANNOUNCE_STATE, input([upd(5, 0)], 0)],
      [INITIAL_ANNOUNCE_STATE, input([upd(3, 5000)], 5000)],
      [SYNCED_5, input([upd(4, 600)], 600)],
      [SYNCED_5, input([upd(4, 600)], 600, { catchingUp: true })],
      [SYNCED_5, input([upd(4, 600)], 600, { replay: true })],
      [SYNCED_5, input([upd(4, 600)], 600, { gameOver: true })],
      [SYNCED_5, input([upd(4, 600)], 600 + W)],
      [SYNCED_5, input([upd(4, 600), upd(3, 600)], 600)],
      [synced(4), input([upd(4, 600)], 610)],
      [synced(4), input([upd(5, 600)], 610)],
      [synced(4), input(null, 610)],
      [synced(4), input([], 610)],
    ];

    it("11a. deep-frozen prev and updates do not throw, same result as unfrozen", () => {
      for (const [prev, inp] of cases) {
        const expected = decideDefconAnnouncement(
          structuredClone(prev),
          structuredClone(inp),
        );
        const frozenPrev = deepFreeze(structuredClone(prev));
        const frozenInput = deepFreeze(structuredClone(inp));
        let r: AnnounceResult | undefined;
        expect(() => {
          r = decideDefconAnnouncement(frozenPrev, frozenInput);
        }).not.toThrow();
        expect(r).toEqual(expected);
      }
    });

    it("11b. inputs are never modified", () => {
      for (const [prev, inp] of cases) {
        const prevBefore = structuredClone(prev);
        const inputBefore = structuredClone(inp);
        decideDefconAnnouncement(prev, inp);
        expect(prev).toEqual(prevBefore);
        expect(inp).toEqual(inputBefore);
      }
    });

    it("11c. the same input gives the same output", () => {
      for (const [prev, inp] of cases) {
        expect(decideDefconAnnouncement(prev, inp)).toEqual(
          decideDefconAnnouncement(prev, inp),
        );
      }
    });

    it("11d. a long sequence played twice gives identical results", () => {
      // Join late (tick 300), catch up over the first change, go live, the
      // game ends before the last change; with gaps, a burst of two updates
      // in one tick and frozen inputs.
      const first = 300;
      const stream = coreStream([600, 1200, 1800, 2400], 3000, first);
      stream[1800 - first] = [upd(3, 1200), upd(2, 1800)];
      deepFreeze(stream);
      const flagsAt = (tick: number): Flags => ({
        catchingUp: tick < 1000,
        gameOver: tick >= 2000,
      });
      const a = runClient(stream, flagsAt, first);
      const b = runClient(stream, flagsAt, first);
      expect(b.results).toEqual(a.results);
      expect(b.banners).toEqual(a.banners);
      expect(b.final).toEqual(a.final);
      // And the run itself is what the rules say: only the two live changes
      // are announced (600 was caught up, 2400 came after the game ended).
      expect(a.banners).toEqual([
        { tick: 1200, level: 3 },
        { tick: 1800, level: 2 },
      ]);
      expect(a.final).toEqual(synced(1));
    });
  });
});
