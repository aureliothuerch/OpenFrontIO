/**
 * When the client announces a DEFCON change (banner + alarm). A pure function
 * so every rule is unit tested (tests/mod/client/DefconAnnounce.test.ts):
 *
 * R1  The first update is a sync, never announced.
 * R2  No announcement while catching up, and none afterwards for that change.
 * R3  No announcement in replays.
 * R4  No announcement once the game is over.
 * R5  Never for DEFCON 5.
 * R6  Exactly once per change: only a level below the announced one counts.
 * R7  Only within `windowTicks` of the tick the level was reached.
 * R8  Several updates in one tick: only the last one counts.
 * R9  A change that is not announced still moves the announced level on, so
 *     it is never announced later.
 * R10 No update this tick: nothing happens, the state stays as it is.
 * R11 Pure and deterministic: inputs are never modified.
 */

export interface AnnounceState {
  /** Whether the first update (the sync) was seen. */
  readonly synced: boolean;
  /** The level the player already knows about. */
  readonly announcedLevel: number;
}

export const INITIAL_ANNOUNCE_STATE: AnnounceState = {
  synced: false,
  announcedLevel: 5,
};

export interface DefconUpdateLike {
  readonly level: number;
  readonly reachedAtTick: number;
}

export interface AnnounceInput {
  /** This tick's DEFCON updates, oldest first. */
  readonly updates: readonly DefconUpdateLike[] | null | undefined;
  readonly tick: number;
  /** The client is (persistently) catching up with the simulation. */
  readonly catchingUp: boolean;
  readonly replay: boolean;
  readonly gameOver: boolean;
  readonly windowTicks: number;
}

export interface AnnounceResult {
  /** Show the banner and play the alarm. */
  readonly announce: boolean;
  /** The level that changed this tick (announced or not), else null. */
  readonly changedTo: number | null;
  readonly next: AnnounceState;
}

export function decideDefconAnnouncement(
  prev: AnnounceState,
  input: AnnounceInput,
): AnnounceResult {
  const updates = input.updates;
  // R10
  if (updates === null || updates === undefined || updates.length === 0) {
    return { announce: false, changedTo: null, next: prev };
  }
  // R8
  const update = updates[updates.length - 1];
  // R1
  if (!prev.synced) {
    return {
      announce: false,
      changedTo: null,
      next: { synced: true, announcedLevel: update.level },
    };
  }
  // R6: same level (heartbeat) or, which never happens, a higher one.
  if (update.level >= prev.announcedLevel) {
    return { announce: false, changedTo: null, next: prev };
  }
  // R9
  const next: AnnounceState = { synced: true, announcedLevel: update.level };
  const suppressed =
    input.catchingUp || // R2
    input.replay || // R3
    input.gameOver || // R4
    update.level >= 5 || // R5
    input.tick - update.reachedAtTick >= input.windowTicks; // R7
  return { announce: !suppressed, changedTo: update.level, next };
}
