import type { GameEvent } from "../../../core/EventBus";

/**
 * Emitted on the client EventBus when the DEFCON level changes (never for the
 * first update, which is only a sync). Docking point for later features such
 * as the advisor voice: v1 only emits it and nothing listens.
 *
 * `live` is true only when the change was announced (banner + alarm). It is
 * false while catching up, in replays, after the game is over and for changes
 * that are already stale, so a listener never announces an old level.
 */
export class DefconChangedEvent implements GameEvent {
  constructor(
    public readonly level: number,
    public readonly previousLevel: number,
    public readonly reachedAtTick: number,
    public readonly live: boolean,
  ) {}
}
