import { z } from "zod";
import {
  Execution,
  Game,
  Player,
  PlayerType,
  UnitType,
} from "../../../core/game/Game";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import { execSnapshotType } from "../../../core/snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
} from "../../../core/snapshot/SnapshotContext";
import { zInt } from "../../../core/snapshot/SnapshotType";
import type { DefconTuning } from "../ModConfig";
import {
  blocksUnit,
  DEFCON_START_LEVEL,
  nextDefconLevel,
  nukesLockedAt,
  pairKey,
  scaledBonus,
} from "./DefconRules";
import { defconSettings } from "./DefconSettings";
import { registerDefcon } from "./DefconState";

/**
 * Global DEFCON level (5 -> 1, never goes back up), shared by all players.
 *
 * An escalation clock starts when peace time (spawn immunity) ends. It runs
 * with real time, and events move it forward:
 * - a new conflict: a Human or Nation attacking another Human or Nation of a
 *   different team (polled from outgoingAttacks, no upstream hook). Neutral
 *   land and tribes never count. A pair counts again only after a quiet spell.
 * - a real betrayal (reported by a hook in GameImpl.breakAlliance), unless
 *   alliances are disabled. Betraying a tribe does not count.
 * A level is reached when the clock passes its "latest" time, its "earliest"
 * real time has passed and the last step is long enough ago (DefconRules).
 *
 * Nukes are locked until the unlock level (DefconState.modDefconBlocksUnit).
 * After a winner is decided the level freezes and the lock lifts.
 *
 * Deterministic: integer ticks only, players visited in allPlayers() order,
 * maps kept (and snapshotted) in insertion order. Always active, so upstream
 * never drops it and its state survives snapshots.
 */
export class DefconExecution implements Execution {
  private mg: Game | null = null;
  private tuning: DefconTuning;
  private currentLevel = DEFCON_START_LEVEL;
  private previousLevel = DEFCON_START_LEVEL;
  /** First tick without spawn immunity: the escalation clock's zero. */
  private clockStartTick: number | null = null;
  private bonusTicks = 0;
  private lastStepTick: number | null = null;
  /** Index = level - 1. */
  private reachedAt: (number | null)[] = [null, null, null, null, null];
  /** pairKey -> last tick an attack between the two was seen. */
  private pairLastAttackTick = new Map<number, number>();
  /** Traitor small id -> last tick one of their betrayals counted. */
  private traitorLastCountedTick = new Map<number, number>();
  /** Whether the client was told that the game is over (lock lifted). */
  private gameOverSent = false;

  /** Registers itself, so the nuke lock applies from game creation on. */
  constructor(
    game: Game,
    tuning: DefconTuning = defconSettings(game.config()),
  ) {
    this.tuning = tuning;
    registerDefcon(game, this);
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.reachedAt[DEFCON_START_LEVEL - 1] = ticks;
    this.emit();
  }

  tick(ticks: number): void {
    if (this.mg === null) return;
    const mg = this.mg;
    if (mg.getWinner() !== null) {
      // Frozen. Tell the client right away that the lock is lifted.
      if (!this.gameOverSent) {
        this.gameOverSent = true;
        this.emit();
        return;
      }
    } else {
      const peace = mg.isSpawnImmunityActive();
      this.pollAttacks(ticks, peace);
      if (!peace) {
        this.clockStartTick ??= ticks;
        if (this.step(ticks)) {
          this.emit();
          return;
        }
      }
    }
    if (ticks % this.tuning.heartbeatTicks === 0) this.emit();
  }

  level(): number {
    return this.currentLevel;
  }

  reachedAtTick(level: number): number | null {
    return this.reachedAt[level - 1] ?? null;
  }

  blocksUnit(unitType: UnitType): boolean {
    return blocksUnit(
      this.currentLevel,
      unitType,
      this.tuning,
      this.gameOver(),
    );
  }

  nukesLocked(): boolean {
    return nukesLockedAt(this.currentLevel, this.tuning, this.gameOver());
  }

  onBetrayal(traitor: Player, betrayed: Player): void {
    const mg = this.mg;
    if (mg === null || mg.getWinner() !== null) return;
    if (mg.config().disableAlliances()) return;
    if (mg.isSpawnImmunityActive()) return;
    if (!isReal(traitor) || !isReal(betrayed)) return;
    const now = mg.ticks();
    const last = this.traitorLastCountedTick.get(traitor.smallID());
    if (last !== undefined && now - last < this.tuning.betrayalCooldownTicks) {
      return;
    }
    this.traitorLastCountedTick.set(traitor.smallID(), now);
    this.bonusTicks += this.bonus(
      this.tuning.betrayalBonusTicks,
      bothNations(traitor, betrayed),
      countAliveReal(mg),
    );
  }

  isActive(): boolean {
    return true;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  private gameOver(): boolean {
    return this.mg !== null && this.mg.getWinner() !== null;
  }

  /**
   * Records every ongoing attack between two real players of different
   * teams. During peace time pairs are only marked as seen, so they don't
   * all count at once when peace ends.
   */
  private pollAttacks(ticks: number, peace: boolean): void {
    const mg = this.mg!;
    let alive = 0;
    let newConflicts = 0;
    let newNationConflicts = 0;
    for (const attacker of mg.allPlayers()) {
      if (!isReal(attacker) || !attacker.isAlive()) continue;
      alive++;
      for (const attack of attacker.outgoingAttacks()) {
        const target = attack.target();
        if (!target.isPlayer() || !isReal(target)) continue;
        if (!target.isAlive() || target.isDisconnected()) continue;
        if (attacker.isOnSameTeam(target)) continue;
        const key = pairKey(attacker.smallID(), target.smallID());
        const last = this.pairLastAttackTick.get(key);
        this.pairLastAttackTick.set(key, ticks);
        if (last === ticks || peace) continue; // seen this tick, or peace
        if (
          last !== undefined &&
          ticks - last < this.tuning.conflictQuietTicks
        ) {
          continue;
        }
        if (bothNations(attacker, target)) newNationConflicts++;
        else newConflicts++;
      }
    }
    const bonus = this.tuning.newConflictBonusTicks;
    this.bonusTicks +=
      newConflicts * this.bonus(bonus, false, alive) +
      newNationConflicts * this.bonus(bonus, true, alive);
  }

  /** Steps down at most one level. Returns whether the level changed. */
  private step(ticks: number): boolean {
    const elapsed = ticks - this.clockStartTick!;
    const next = nextDefconLevel(
      this.currentLevel,
      this.lastStepTick,
      ticks,
      elapsed,
      elapsed + this.bonusTicks,
      this.tuning,
    );
    if (next >= this.currentLevel) return false;
    this.previousLevel = this.currentLevel;
    this.currentLevel = next;
    this.lastStepTick = ticks;
    this.reachedAt[next - 1] = ticks;
    return true;
  }

  private bonus(ticks: number, nations: boolean, alive: number): number {
    return scaledBonus(
      ticks,
      nations ? this.tuning.nationVsNationPercent : 100,
      alive,
      this.tuning.referencePlayers,
    );
  }

  private emit(): void {
    this.mg!.addUpdate({
      type: GameUpdateType.ModDefcon,
      level: this.currentLevel,
      previousLevel: this.previousLevel,
      reachedAtTick: this.reachedAt[this.currentLevel - 1] ?? 0,
      gameOver: this.gameOver(),
    });
  }

  snapshot(): ExecRecord {
    return DefconExecutionSnapshot.write({
      initialized: this.mg !== null,
      level: this.currentLevel,
      previousLevel: this.previousLevel,
      clockStartTick: this.clockStartTick,
      bonusTicks: this.bonusTicks,
      lastStepTick: this.lastStepTick,
      reachedAt: [...this.reachedAt],
      // Insertion order is state: both maps are written and rebuilt in order.
      pairLastAttackTick: [...this.pairLastAttackTick],
      traitorLastCountedTick: [...this.traitorLastCountedTick],
      gameOverSent: this.gameOverSent,
    });
  }

  restoreSnapshot(s: DefconState, r: SnapshotReader): void {
    // Only assign: the game's own state is not restored yet at this point.
    this.mg = s.initialized ? r.game : null;
    this.tuning = defconSettings(r.game.config());
    this.currentLevel = s.level;
    this.previousLevel = s.previousLevel;
    this.clockStartTick = s.clockStartTick;
    this.bonusTicks = s.bonusTicks;
    this.lastStepTick = s.lastStepTick;
    this.reachedAt = [...s.reachedAt];
    this.pairLastAttackTick = new Map(s.pairLastAttackTick);
    this.traitorLastCountedTick = new Map(s.traitorLastCountedTick);
    this.gameOverSent = s.gameOverSent;
    registerDefcon(r.game, this);
  }
}

/** Humans and nations; tribes (PlayerType.Bot) never count. */
function isReal(p: Player): boolean {
  return p.type() === PlayerType.Human || p.type() === PlayerType.Nation;
}

function bothNations(a: Player, b: Player): boolean {
  return a.type() === PlayerType.Nation && b.type() === PlayerType.Nation;
}

function countAliveReal(mg: Game): number {
  let alive = 0;
  for (const p of mg.allPlayers()) {
    if (isReal(p) && p.isAlive()) alive++;
  }
  return alive;
}

const DefconStateSchema = z.object({
  initialized: z.boolean(),
  level: zInt().min(1).max(5),
  previousLevel: zInt().min(1).max(5),
  clockStartTick: zInt().nullable(),
  bonusTicks: zInt(),
  lastStepTick: zInt().nullable(),
  reachedAt: z.array(zInt().nullable()).length(5),
  pairLastAttackTick: z.array(z.tuple([zInt(), zInt()])),
  traitorLastCountedTick: z.array(z.tuple([zInt(), zInt()])),
  gameOverSent: z.boolean(),
});
type DefconState = z.infer<typeof DefconStateSchema>;

export const DefconExecutionSnapshot = execSnapshotType({
  name: "ModDefcon",
  version: 1,
  schema: DefconStateSchema,
  cls: () => DefconExecution,
});
