# TODO – current milestone

**Feature 1: DEFCON + nuke lock + indicator + banner/alarm (incl. pace and host/solo switch)** (branch `feature/defcon`)

## Steps

- [x] Branch `feature/defcon`, move the roadmap to `docs/mod/ROADMAP.md` (private), create this file
- [x] Core: `ModConfig`, `ModGameConfig`, `DefconRules`, `DefconSettings`, `DefconExecution`, `DefconState`
- [x] Core hooks: GameRunner, ExecutionRegistry, GameUpdates, PlayerImpl, GameImpl, NationNuke, NationMIRV, Schemas
- [x] Client: controller, HUD, banner/alarm (`decideDefconAnnouncement`), texts, sound
- [x] Client hooks: GameRenderer, UnitDisplay, BuildMenu, RadialMenuElements
- [x] Tests in `tests/mod/` (rules, execution, host settings, nuke lock, snapshots, announce, texts)
- [x] `npm test`, `npm run lint`, `tsc`, prettier all green (only the 3 known failures: 2× jq, 1× number format)
- [x] DEFCON pace 20% faster. New values for `src/mod/core/ModConfig.ts`:
  - `latestTicks { 4: 1920, 3: 3840, 2: 5760, 1: 7680 }` (3:12 / 6:24 / 9:36 / 12:48)
  - `earliestTicks { 4: 720, 3: 1920, 2: 3360, 1: 5280 }` (1:12 / 3:12 / 5:36 / 8:48)
- [ ] Switch "DEFCON on/off" in the host lobby and the singleplayer menu. Prepared via `GameConfig.mod.defcon.enabled`; default: on. (The server only copies host patches listed in `src/server/ConfigPatch.ts`, so `mod` needs to go there too.)

## Assets

- [ ] ASSET NEEDED: `defcon-alarm.mp3` – short alarm/klaxon, ~1.5–2 s, played on every DEFCON change (placeholder in `src/mod/client/ModAssets.ts`)

## Known / deliberate

- Tutorial step "launch atom bomb" waits until DEFCON 2 (left as is, see roadmap "Später").
- `resources/lang/en.json` has a `mod` block that cannot carry a `// MOD:` marker (JSON). Remember it when merging upstream.
- `tests/replay/ReplayGame.ts` (dev tool, not in `npm test`) cannot replay upstream recordings that use nukes any more.

## Playtest questions

- Do the DEFCON numbers feel right (`src/mod/core/ModConfig.ts`)?
- Do all nations fire at once when DEFCON 2 arrives? If so, stagger them in mod code only.
- Does the timer scaling feel right in ranked games?
- Extremfall lange Peace Time + kurzer Timer: DEFCON 2 kann zu spät kommen, DEFCON 1 evtl. nie. Vor Feature 2 (Doomsday) prüfen, dass DEFCON 1 in Timer-Lobbys erreichbar ist.
