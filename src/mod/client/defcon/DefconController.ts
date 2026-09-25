import type { Controller } from "../../../client/Controller";
import type { GameView } from "../../../client/view";
import type { EventBus } from "../../../core/EventBus";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import type { DefconTuning } from "../../core/ModConfig";
import { DEFCON_START_LEVEL } from "../../core/defcon/DefconRules";
import { defconSettings } from "../../core/defcon/DefconSettings";
import { playDefconAlarm } from "../ModSound";
import {
  type AnnounceState,
  decideDefconAnnouncement,
  INITIAL_ANNOUNCE_STATE,
} from "./DefconAnnounce";
import {
  clearDefconClientState,
  setDefconClientState,
} from "./DefconClientState";
import { DefconChangedEvent } from "./DefconEvents";
import { DefconHud } from "./DefconHud";
import { defconBannerText, defconIndicatorText } from "./DefconText";

/** Same threshold as upstream's HeadsUpMessage "catching up" notice. */
const CATCHING_UP_THRESHOLD_TICKS = 10;

/**
 * The DEFCON client: reads the ModDefcon updates, keeps the per-game client
 * state for the menu hooks (DefconClientState), drives the HUD and announces
 * changes (banner + alarm) as decideDefconAnnouncement decides.
 *
 * No getTickIntervalMs on purpose: it must run every tick, or it would miss
 * updates. It subscribes to no bus events, so nothing leaks from one game
 * into the next.
 */
export class DefconController implements Controller {
  /** Null while DEFCON is off in this game (or the controller failed). */
  private tuning: DefconTuning | null = null;
  private hud: DefconHud | null = null;
  private level = DEFCON_START_LEVEL;
  /** The simulation's game-over verdict (see DefconClientState.gameOver). */
  private simGameOver = false;
  private announce: AnnounceState = INITIAL_ANNOUNCE_STATE;
  private catchingUpTicks = 0;
  /** The change whose banner is up, and the tick it went up. */
  private banner: { level: number; shownAtTick: number } | null = null;

  constructor(
    private readonly game: GameView,
    private readonly eventBus: EventBus,
  ) {}

  init(): void {
    this.guard("init", () => this.start());
  }

  tick(): void {
    if (this.tuning === null) return;
    this.guard("tick", () => this.update());
  }

  private start(): void {
    this.tuning = null;
    this.level = DEFCON_START_LEVEL;
    this.simGameOver = false;
    this.announce = INITIAL_ANNOUNCE_STATE;
    this.catchingUpTicks = 0;
    this.banner = null;

    // The element survives between games in the same page: start clean.
    const existing = document.querySelector("mod-defcon-hud");
    const reused = existing instanceof DefconHud ? existing : null;
    reused?.reset();

    const tuning = defconSettings(this.game.config());
    if (!tuning.enabled) {
      // DEFCON off in this game: no HUD, and every menu hook stays neutral.
      clearDefconClientState(this.game);
      this.hud = null;
      return;
    }

    this.tuning = tuning;
    setDefconClientState(this.game, {
      level: this.level,
      tuning,
      gameOver: this.simGameOver,
    });
    this.hud = this.mountHud(reused ?? new DefconHud());
    this.render();
  }

  /** Right under the timer stack (top right), without an index.html edit. */
  private mountHud(hud: DefconHud): DefconHud {
    const sidebar = document.querySelector("game-right-sidebar");
    if (sidebar?.parentElement) {
      hud.floating = false;
      sidebar.after(hud);
    } else {
      hud.floating = true;
      document.body.append(hud);
    }
    return hud;
  }

  private update(): void {
    const tuning = this.tuning;
    if (tuning === null) return;

    const updates =
      this.game.updatesSinceLastTick()?.[GameUpdateType.ModDefcon] ?? null;
    const last =
      updates !== null && updates.length > 0
        ? updates[updates.length - 1]
        : null;
    if (last !== null) {
      this.level = last.level;
      this.simGameOver = last.gameOver;
      setDefconClientState(this.game, {
        level: last.level,
        tuning,
        gameOver: last.gameOver,
      });
    }

    if (this.game.isCatchingUp()) {
      this.catchingUpTicks++;
    } else {
      this.catchingUpTicks = 0;
    }

    const tick = this.game.ticks();
    const result = decideDefconAnnouncement(this.announce, {
      updates,
      tick,
      catchingUp: this.catchingUpTicks >= CATCHING_UP_THRESHOLD_TICKS,
      replay: this.game.config().isReplay(),
      // No banner once either side considers the game over.
      gameOver: this.game.gameOver() || this.simGameOver,
      windowTicks: tuning.announceWindowTicks,
    });
    this.announce = result.next;

    if (result.changedTo !== null && last !== null) {
      this.eventBus.emit(
        new DefconChangedEvent(
          result.changedTo,
          last.previousLevel,
          last.reachedAtTick,
          result.announce,
        ),
      );
      if (result.announce) {
        this.banner = { level: result.changedTo, shownAtTick: tick };
        void playDefconAlarm();
      }
    }
    // Tick based, not a timer: the banner stays up while the game is paused.
    if (
      this.banner !== null &&
      tick - this.banner.shownAtTick >= tuning.announceWindowTicks
    ) {
      this.banner = null;
    }

    this.render();
  }

  private render(): void {
    const tuning = this.tuning;
    const hud = this.hud;
    if (tuning === null || hud === null) return;
    const config = this.game.config();
    hud.show({
      level: this.level,
      indicator: defconIndicatorText(
        this.level,
        tuning,
        config,
        this.simGameOver,
      ),
      banner:
        this.banner === null
          ? null
          : defconBannerText(this.banner.level, tuning, config),
    });
  }

  /**
   * A mod error must never break the game loop. On the first error the DEFCON
   * UI switches off for this game: the HUD hides and the menu hooks go
   * neutral (the simulation still enforces the lock).
   */
  private guard(stage: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`DefconController: ${stage} failed, DEFCON UI off`, err);
      this.tuning = null;
      try {
        clearDefconClientState(this.game);
        this.hud?.reset();
      } catch {
        // Nothing more to do.
      }
    }
  }
}
