# DEFCON

Feature 1 of the mod: a global DEFCON level, the nuke lock, the DEFCON indicator, and a banner with an alarm on every change.

All numbers below come from `MOD_CONFIG.defcon` in `src/mod/core/ModConfig.ts`. One tick is 100 ms, so 600 ticks are one minute. When a value changes there, update this doc in the same commit.

## Overview

- Every game starts at **DEFCON 5**. The level only ever steps down (5 → 4 → 3 → 2 → 1), and it is the same for all players and teams.
- It steps down as time passes, and faster when real players fight or betray each other.
- **Nukes can only be launched from DEFCON 2 on.** Missile silos can be built at any time.
- Players see:
  - the current level top right, under the timer;
  - a banner with an alarm on every change;
  - red, locked nuke buttons with the hint "Only available from DEFCON 2".
- The host of a private lobby, or the player in singleplayer, can switch DEFCON off. The game then plays exactly like OpenFront.

## Escalation clock

The clock starts on the first tick without spawn immunity, which is when peace time ends. It counts real ticks since then, plus bonus ticks from events.

A level is reached when **all** of these are true (`nextDefconLevel` in `DefconRules.ts`):

1. **By time.** The clock (real time plus bonuses) has reached the level's `latestTicks`. Without any events the level comes exactly at this time.
2. **Earliest time.** The real time since peace ended has reached the level's `earliestTicks`. Bonuses can never push a level before this time.
3. **Gap.** At least `minTicksBetweenSteps` = 600 (1:00) have passed since the last step. So there is at most one step per minute, and at most one step per tick.

| Level | By time (`latestTicks`) | Earliest (`earliestTicks`) |
| ----- | ----------------------- | -------------------------- |
| 4     | 1920 (3:12)             | 720 (1:12)                 |
| 3     | 3840 (6:24)             | 1920 (3:12)                |
| 2     | 5760 (9:36)             | 3360 (5:36)                |
| 1     | 7680 (12:48)            | 5280 (8:48)                |

All times count from the end of peace time.

### Bonuses

| Event        | Bonus                              | Limit                                                                                            |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| New conflict | `newConflictBonusTicks` 300 (0:30) | A pair counts again only after `conflictQuietTicks` 3000 (5:00) without any attack between them. |
| Betrayal     | `betrayalBonusTicks` 600 (1:00)    | At most one counted betrayal per traitor within `betrayalCooldownTicks` 1200 (2:00).             |

- **Nation against nation.** When both sides of a conflict or betrayal are nations, the bonus is weighted by `nationVsNationPercent`. It is 100, so nations count the same as humans for now.
- **Player count.** The bonus is scaled by player count (`scaledBonus`) as `floor(bonus × percent × ref / (100 × max(ref, alive)))`:
  - `ref` is `referencePlayers` = 8.
  - `alive` is the number of living humans and nations.
  - Small lobbies are never boosted. A lobby with 16 living players gets half the bonus.

### Games with a timer

In a game with a timer (`maxTimerValue`, in minutes) the schedule gets shorter, so DEFCON 2 still comes before the game ends (`timerScalePercent`, `scaleForTimer`):

```
available = maxTimerValue × 600 − spawnImmunityDuration
percent   = 100                                          if there is no timer or available ≥ 20 min
          = max(40, floor(available × 100 / (20 × 600))) otherwise
```

- The timer runs from the end of the spawn phase, but the DEFCON clock only runs from the end of peace time. That is why peace time is subtracted.
- The reference length is `timerReferenceMinutes` = 20. The lower limit is `timerMinScalePercent` = 40.
- Only `latestTicks`, `earliestTicks` and `minTicksBetweenSteps` get shorter. Bonuses stay the same.
- Timers of 20 minutes or longer, and games without a timer, keep the normal schedule. The schedule never gets longer.

Examples (tested in `tests/mod/DefconExecution.test.ts`):

- Ranked 1v1, 10 minutes with 30 s peace: 47%.
- Ranked 2v2, 15 minutes with 60 s peace: 70%.
- A 30-minute private lobby: 100%.

### Peace time

- The level stays at 5 and the clock does not run while spawn immunity is active. That covers the spawn phase and `spawnImmunityDuration`, which is 5 s by default, 4 min with the public `isPeaceTime` modifier, or whatever the host chose.
- Nukes stay locked during that time.
- Attacks during peace time give no bonus. Their pairs are still marked as seen, so a war that started in peace time does not count the moment peace ends. It counts only after a 5-minute quiet spell.
- Betrayals during peace time give no bonus.

## Who counts

- **Counts:** humans (`PlayerType.Human`) and nations (`PlayerType.Nation`), as attacker, target, traitor and betrayed.
- **Never counts:**
  - tribes (`PlayerType.Bot`);
  - expansion into neutral land;
  - teammates (`isOnSameTeam`), which covers disconnected teammates too;
  - attacks on dead or disconnected players.
- **Conflicts** are polled every tick from `outgoingAttacks()`, with no upstream hook. Each unordered pair of players (`pairKey`) is one conflict, whoever attacks. Different pairs count separately, even in the same tick.
- **Betrayals** are reported by the hook in `GameImpl.breakAlliance`. That hook sits right after `markTraitor()`, so it only fires under upstream's own traitor rule: the other side is neither a traitor nor disconnected.
  - An alliance that expires is not a betrayal.
  - Breaking with a traitor is not a betrayal.
  - Betraying a tribe does not count.
  - Nothing counts when alliances are disabled or the game has a winner.
- **Teams and alliances are separate.** In team mode, an attack on a player of another team counts. So does breaking an alliance with a player of another team. Teammates never count.

## Nuke lock

- **Locked types:** `NUKE_WEAPON_TYPES` is upstream's `Nukes` group without `MIRVWarhead`, so atom bomb, hydrogen bomb and MIRV. They are locked while the level is above `nukeUnlockLevel` = 2 and `lockNukes` is true.
- **MIRV warheads are never locked.** A MIRV in flight spawns them, and locking them would break MIRVs.
- **Missile silos, silo upgrades and every other unit are never locked.**
- **Host settings come first.** The core check (`PlayerImpl.canBuildUnitType`) only adds a restriction on top of upstream's checks. A type the host disabled stays disabled at DEFCON 2 and after, and gets no red DEFCON look.
- **Nations** plan no nukes and no MIRVs while nukes are locked (hooks in `NationNukeBehavior` and `NationMIRVBehavior`). They keep their normal nuke cost and fire after DEFCON 2.
- **The lock starts when the execution is created,** before its first tick.
- **After the game** the lock is lifted once a winner is set. The level freezes and no more banners are shown. A cancelled game without a winner stays locked. That is why the client uses the simulation's `gameOver` flag from the update, not `GameView.gameOver()`.

## Host settings

| Setting                                                                            | Behaviour                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DEFCON switch** (`GameConfig.mod.defcon.enabled`, default on)                    | Off gives plain OpenFront: no execution, no lock, no indicator, no red buttons, no `ModDefcon` updates. Only the singleplayer menu and the private host lobby show the switch. Public and ranked games always run DEFCON. |
| `mod.defcon.lockNukes` (config only, no UI)                                        | False means DEFCON steps and shows its level but locks nothing. The "Nukes from" hint is hidden, and there is no "nukes released" banner.                                                                                 |
| All nukes disabled (`isNukesDisabled` also disables silo and SAM) or silo disabled | DEFCON runs normally. The indicator has no "Nukes from" hint, there are no red buttons, and the DEFCON 2 banner shows the level description instead of "nukes released".                                                  |
| A single nuke type disabled                                                        | That type stays disabled, as upstream does it, with no red look. The "nukes released" banner names only the enabled types.                                                                                                |
| SAMs disabled (`isSAMsDisabled`)                                                   | No effect.                                                                                                                                                                                                                |
| Alliances disabled (`disableAlliances()`, also `customAllianceDuration` 0)         | Betrayals never count. The clock runs on time and conflicts only.                                                                                                                                                         |
| Peace time (`spawnImmunityDuration`, `isPeaceTime`)                                | The clock starts after it, and the level stays at 5 until then (see [Peace time](#peace-time)). It is subtracted from the timer for timer scaling.                                                                        |
| Timer (`maxTimerValue`)                                                            | Shorter schedule, see [Games with a timer](#games-with-a-timer).                                                                                                                                                          |
| Doomsday clock, overtime                                                           | Independent: DEFCON does not read them. The doomsday clock together with DEFCON is tested.                                                                                                                                |
| Water nukes, instant build, infinite gold/troops                                   | No effect on DEFCON. The lock applies the same way.                                                                                                                                                                       |
| Team mode                                                                          | One global level for all teams. Teammates never count. Alliances across teams count when broken.                                                                                                                          |
| Nations disabled                                                                   | Only humans count. The clock still runs on time.                                                                                                                                                                          |
| Singleplayer / Public / Private                                                    | Same rules in all three.                                                                                                                                                                                                  |
| Replay                                                                             | The levels are simulated as usual. No banner and no alarm.                                                                                                                                                                |

### Lobby switch

- **UI.** `src/mod/client/ModLobbySettings.ts` collects every mod lobby setting (`ModLobbyState { defconEnabled }`). `SinglePlayerModal`, `HostLobbyModal` and `LobbySettingsSummary` call it through their `// MOD:` hooks. DEFCON's part is in `src/mod/client/defcon/DefconLobbySettings.ts`.
  - The card "DEFCON" sits between water nukes and the doomsday clock.
  - Closing the menu, or starting the tutorial, resets it to on.
- **Always explicit.** The menus always send `mod.defcon.enabled`, even when it is on. JSON drops an `undefined` value, and the server would then keep the old value.
- **Server.** `applyModConfigPatch` (`src/mod/core/ModGameConfig.ts`, hooked into `src/server/ConfigPatch.ts`) merges the `mod` block **field by field**. A field that is missing or `undefined` keeps its stored value, so switching DEFCON never clears a stored `lockNukes`.
  - Only the host can change it: upstream's `IntentAuthorization` answers a non-host with 403.
  - A publicly listed lobby rejects the change with 409.
- **Other players** see "DEFCON: Disabled" in the lobby settings summary, only while it is off. This follows OpenFront's summary, which lists only what differs from a normal game.
- **Singleplayer.** DEFCON off counts as a changed option (`hasOptionsChanged`). So the upstream warning "custom settings, no achievements" appears, but only for players with a linked account, because upstream shows it only then.

## Architecture

### Files in `src/mod/`

| File                                        | Purpose                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `core/ModConfig.ts`                         | `MOD_CONFIG.defcon`, every tunable, documented in `DefconTuning`                                                  |
| `core/ModGameConfig.ts`                     | `ModGameConfigSchema` (`mod.defcon.enabled`, `lockNukes`), `mergeModGameConfig`, `applyModConfigPatch`            |
| `core/ModExecutions.ts`                     | `modInitExecutions` (nothing if off), `MOD_EXECUTION_SNAPSHOT_TYPES`                                              |
| `core/defcon/DefconRules.ts`                | Pure rules shared by core and client: nuke types, lock, timer scaling, bonus, `nextDefconLevel`, `pairKey`        |
| `core/defcon/DefconSettings.ts`             | `defconSettings(config)`: `MOD_CONFIG` + per-game switches + timer scaling; a pure function of the config         |
| `core/defcon/DefconExecution.ts`            | The simulation: clock, conflicts, betrayals, steps, updates, snapshot                                             |
| `core/defcon/DefconState.ts`                | Per-game registry (`WeakMap<Game, DefconExecution>`) and the functions the upstream hooks call; type-only imports |
| `core/defcon/DefconUpdate.ts`               | `ModDefconUpdate`                                                                                                 |
| `client/ModControllers.ts`                  | `createModControllers`: never throws, a failure only leaves the mod UI out                                        |
| `client/ModAssets.ts`, `client/ModSound.ts` | Central asset list (alarm placeholder), alarm on upstream's `alerts` channel (follows volume and mute)            |
| `client/ModLobbySettings.ts`                | All mod lobby switches                                                                                            |
| `client/defcon/DefconController.ts`         | Reads updates, keeps the client state, drives the HUD, announces changes                                          |
| `client/defcon/DefconHud.ts`                | `<mod-defcon-hud>`: indicator and banner, mounted after `<game-right-sidebar>`                                    |
| `client/defcon/DefconAnnounce.ts`           | `decideDefconAnnouncement`, rules R1–R11                                                                          |
| `client/defcon/DefconText.ts`               | Indicator, banner and hint texts as translation refs (`mod.defcon.*` in `resources/lang/en.json`)                 |
| `client/defcon/DefconClientState.ts`        | Per-`GameView` client state (`WeakMap`); no entry means upstream behaviour                                        |
| `client/defcon/DefconEvents.ts`             | `DefconChangedEvent`                                                                                              |
| `client/defcon/DefconUiHooks.ts`            | Red look and hint in the hotbar, build menu and radial menu                                                       |
| `client/defcon/DefconLobbySettings.ts`      | DEFCON's lobby switch                                                                                             |

### `// MOD:` hooks in upstream files

List them with `grep -rn "// MOD:" src/core src/client src/server tests eslint.config.js`.

| File                                                                       | Hook                                                                                                                | Why                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/core/GameRunner.ts`                                                   | `addExecution(...modInitExecutions(game))` in `init()`                                                              | Starts DEFCON; adds nothing when it is off                            |
| `src/core/snapshot/ExecutionRegistry.ts`                                   | `...MOD_EXECUTION_SNAPSHOT_TYPES`                                                                                   | The execution can be snapshotted and restored                         |
| `src/core/game/GameUpdates.ts`                                             | `ModDefcon = -1` as the first enum member (upstream's members keep their values), `\| ModDefconUpdate` in the union | Sends the level to the client                                         |
| `src/core/game/PlayerImpl.ts`                                              | `canBuildUnitType`: `modDefconBlocksUnit`                                                                           | The nuke lock (after upstream's own checks)                           |
| `src/core/game/GameImpl.ts`                                                | `breakAlliance`, after `markTraitor()`: `modDefconOnBetrayal`                                                       | Betrayal trigger                                                      |
| `src/core/execution/nation/NationNukeBehavior.ts`, `NationMIRVBehavior.ts` | Early return while `modDefconNukesLocked`                                                                           | Nations do not plan nukes while locked                                |
| `src/core/Schemas.ts`                                                      | `mod: ModGameConfigSchema.optional()` in `GameConfigSchema`                                                         | Per-game switches                                                     |
| `src/server/ConfigPatch.ts`                                                | `applyModConfigPatch(target, patch)`                                                                                | Merges the host's `mod` patch field by field                          |
| `src/client/hud/GameRenderer.ts`                                           | `layers.push(...createModControllers(game, eventBus))`                                                              | Client controller                                                     |
| `src/client/hud/layers/UnitDisplay.ts`                                     | `canBuild`, button class, tooltip hint                                                                              | Hotbar lock look                                                      |
| `src/client/hud/layers/BuildMenu.ts`                                       | Button title (`modDefconBuildTitle`), style, hint                                                                   | Build menu lock look; no "Not enough money" when DEFCON is the reason |
| `src/client/hud/layers/RadialMenuElements.ts`                              | Attack submenu wrapped by `modDefconDecorateRadial`                                                                 | Radial lock look; a click shows the hint as a toast                   |
| `src/client/SinglePlayerModal.ts`                                          | State, toggle cards, toggle handler, reset, start config, `hasOptionsChanged`                                       | DEFCON switch                                                         |
| `src/client/HostLobbyModal.ts`                                             | State, toggle cards, toggle handler (pushes the config), reset, `putGameConfig`                                     | DEFCON switch                                                         |
| `src/client/utilities/LobbySettingsSummary.ts`                             | `items.push(...ModLobby.notableSettings(c))`                                                                        | "DEFCON: Disabled" for other players                                  |
| `tests/util/ScriptedGame.ts`                                               | `mod: { defcon: { lockNukes: false } }`                                                                             | Upstream's scripted full game fires nukes early; DEFCON still runs    |
| `eslint.config.js`                                                         | `src/mod/core/**/*.ts` in the determinism rules                                                                     | Same determinism lint as `src/core`                                   |
| `resources/lang/en.json`                                                   | `mod.defcon.*` block (JSON, no marker possible)                                                                     | Texts                                                                 |

### Simulation

- **Execution.** `DefconExecution` is always active (`isActive()` is true), so upstream never drops it and its state survives snapshots. It does not run during the spawn phase.
- **Determinism.**
  - Integer ticks only.
  - Players are visited in `allPlayers()` order.
  - Both maps (`pairLastAttackTick`, `traitorLastCountedTick`) are kept, snapshotted and rebuilt in insertion order.
- **Snapshot.** The type is `"ModDefcon"`, version 1. Never rename it. The tuning is not stored: on restore it is derived again from the game config with `defconSettings`. `DefconState` has no entry for a game without DEFCON, such as an old snapshot or a test game built without `GameRunner.init()`. Then nothing is locked and nothing is counted.
- **Update.** `ModDefconUpdate { level, previousLevel, reachedAtTick, gameOver }` is sent:
  - once on init;
  - on every change;
  - once when a winner is set;
  - as a heartbeat every `heartbeatTicks` = 50 ticks (5 s).

### Client

- **`DefconController`** runs every tick. It reads the last `ModDefcon` update of the tick, then:
  - stores `{ level, tuning, gameOver }` per `GameView` for the menu hooks;
  - updates the HUD;
  - asks `decideDefconAnnouncement` whether to show the banner and play the alarm.
- **Banner.** It stays up for `announceWindowTicks` = 40 ticks (4 s). This is counted in ticks, so the banner stays while the game is paused.
- **Catching up.** The controller counts as catching up after 10 ticks of `isCatchingUp()`, the same threshold as upstream's notice.
- **Errors.** On any error the controller switches the DEFCON UI off for that game: the HUD hides and the hooks go neutral. The simulation still enforces the lock.
- **DEFCON off.** No HUD and no client state. Every hook then returns upstream's values.

### Banner rules (`DefconAnnounce.ts`)

| Rule | Meaning                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------- |
| R1   | The first update is a sync, never announced (also on a late join).                                 |
| R2   | No announcement while catching up, and none afterwards for that change.                            |
| R3   | No announcement in replays.                                                                        |
| R4   | No announcement once the game is over (`GameView` or simulation).                                  |
| R5   | Never for DEFCON 5.                                                                                |
| R6   | Exactly once per change: only a level below the announced one counts.                              |
| R7   | Only within `announceWindowTicks` of the tick the level was reached.                               |
| R8   | Several updates in one tick: only the last one counts.                                             |
| R9   | A change that is not announced still moves the announced level on, so it is never announced later. |
| R10  | No update this tick: nothing happens, the state stays as it is.                                    |
| R11  | Pure and deterministic: inputs are never modified.                                                 |

**Banner text.** At the unlock level the banner reads "Nuclear weapons released: …" and names the enabled nuke types. It does this only if `lockNukes` is on and at least one type is possible. Every other change shows the level's description.

## Docking points for later features

- **`defconLevel(game)` and `defconReachedAtTick(game, level)`** in `src/mod/core/defcon/DefconState.ts` let core code read DEFCON. Both return `null` when DEFCON is not running. Doomsday and doctrines should use these and not reach into the execution.
- **`DefconChangedEvent(level, previousLevel, reachedAtTick, live)`** goes out on the client `EventBus` for every change after the sync. Nothing listens yet. It is meant for the advisor voice and the newspaper. **Only react when `live` is true.** `live` is false while catching up, in replays, after the game and for stale changes, so a listener never announces an old level.
- **Betrayal hook.** `modDefconOnBetrayal` in `GameImpl.breakAlliance` is the one place a real betrayal is reported. A later feature that reacts to betrayals should be called from the same hook through `src/mod/`, not get a second upstream hook.
- **`ModLobbySettings.ts`** is where further mod switches go:
  - add a field to `ModLobbyState`;
  - add a feature file like `DefconLobbySettings.ts`;
  - add the config field to `ModGameConfigSchema`.
    The upstream hooks and the field-by-field server merge already handle it.
- **War declarations (Diplomacy part A)** are planned as a new trigger. A declaration execution in `src/mod/core/` would call a new method on `DefconExecution` through `DefconState`, like `onBetrayal`, with its own bonus in `DefconTuning`. That needs no new upstream hook.

## Tests

| File                                                                       | Covers                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/mod/DefconRules.test.ts`                                            | Thresholds, gap, one step at a time, bonus scaling, `pairKey`, nuke types, lock rules, timer scaling, determinism                                                                                    |
| `tests/mod/DefconExecution.test.ts`                                        | Conflicts and betrayals (who counts, quiet window, cooldown, nation factor, lobby size), time schedule, game over, updates, host settings (see [Host settings](#host-settings)), timers, feature off |
| `tests/mod/DefconNukeLock.test.ts`                                         | Lock for humans (build, launch, gold, silos, MIRV warheads, host-disabled types, game over), feature off, `lockNukes` off, nations (nuke and MIRV behaviour)                                         |
| `tests/mod/DefconSnapshot.test.ts`                                         | Snapshot and restore in every state, byte-identical round trips, a scripted full game with and without a timer                                                                                       |
| `tests/mod/ModGameConfig.test.ts`                                          | Schema, `mergeModGameConfig`, `applyModConfigPatch`                                                                                                                                                  |
| `tests/mod/client/DefconAnnounce.test.ts`                                  | R1–R11, one `describe` per rule                                                                                                                                                                      |
| `tests/mod/client/DefconText.test.ts`                                      | Indicator, banner and hint texts per setting, `en.json` keys and ICU params                                                                                                                          |
| `tests/mod/client/DefconController.test.ts`                                | HUD mounting, a new game in the same page, DEFCON off, announcing, catch-up, replay, game over, error handling                                                                                       |
| `tests/mod/client/DefconUiHooks.test.ts`                                   | Hotbar, build menu (incl. tooltip) and radial menu, as pure functions and in the real upstream components                                                                                            |
| `tests/mod/client/DefconLobbySettings.test.ts`, `ModLobbySettings.test.ts` | The lobby switch helpers                                                                                                                                                                             |
| `tests/mod/client/DefconLobbyMenus.test.ts`                                | The switch in the real singleplayer menu and host lobby, the summary line, the join modal, the rendered achievements warning                                                                         |
| `tests/mod/server/DefconLobbySwitch.test.ts`                               | Config patch merge, the switch over a real server socket (host only, listed lobbies, start message), the started game via `GameRunner`                                                               |

Run them with `npx vitest tests/mod --run`.

### Manual test in singleplayer

1. Run `npm run dev` and open http://localhost:9000.
2. Open **Solo**. Turn on **Instant build** and **Infinite gold**. Check that the **DEFCON** card is on, then start.
3. After spawning, check that top right under the timer shows "DEFCON 5" and "Nukes from DEFCON 2".
4. Build a missile silo. It must work.
5. Check the atom bomb, hydrogen bomb and MIRV. They must be red with the hint "Only available from DEFCON 2" in:
   - the build menu (with no "Not enough money");
   - the hotbar tooltip;
   - the radial attack submenu, where a click only shows a red toast.
6. Attack a nation. DEFCON 4 comes at 1:12 at the earliest and at 3:12 at the latest after peace time. Every step shows a banner for 4 s and plays the alarm.
7. At DEFCON 2, after 5:36 at the earliest and 9:36 at the latest:
   - the banner names the released nukes;
   - the buttons turn normal;
   - nukes launch;
   - nations may start using nukes (tested with Impossible nations).
8. **Switch off.** Start again with the DEFCON card off. There must be no indicator and no red buttons, and a nuke must launch right after building a silo. Players with a linked account also see the "no achievements" warning in the menu.
9. **Host settings.** Disable one nuke type in the options. That type must stay upstream-disabled without the red look, and the DEFCON 2 banner must not name it.

## Known limitations

- **Placeholder alarm.** The alarm is still a placeholder (`sounds/effects/warship-lost.mp3`). ASSET NEEDED: `defcon-alarm.mp3`, see `docs/mod/TODO.md`.
- **Tutorial.** The tutorial step "launch atom bomb" waits until DEFCON 2. This is left as is on purpose.
- **`en.json` marker.** The `mod` block in `resources/lang/en.json` cannot carry a `// MOD:` marker. Remember it when merging upstream.
- **Upstream changes.** `src/client/utilities/LobbySettingsSummary.ts` is brand new upstream, so expect changes there when merging.
- **Replays.** `tests/replay/ReplayGame.ts` (a dev tool, not in `npm test`) can no longer replay upstream recordings that use nukes.
- **Long peace time with a short timer.** DEFCON 2 can come late and DEFCON 1 maybe never. Check this before Feature 2 (Doomsday).
- **Untested settings.** Overtime, water nukes and "nations disabled" have no dedicated DEFCON test. DEFCON does not read those settings.
- **Open playtest questions:**
  - Do the numbers feel right?
  - Do all nations fire at once when DEFCON 2 arrives?
  - Does the timer scaling feel right in ranked games?
