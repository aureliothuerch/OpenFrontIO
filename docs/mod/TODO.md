# TODO – current milestone

**Feature 1: DEFCON + nuke lock + indicator + banner/alarm on DEFCON change** (branch `feature/defcon`)

## Steps

- [x] Branch `feature/defcon`, move the roadmap to `docs/mod/ROADMAP.md` (private), create this file
- [x] Core: `ModConfig`, `ModGameConfig`, `DefconRules`, `DefconSettings`, `DefconExecution`, `DefconState`
- [x] Core hooks: GameRunner, ExecutionRegistry, GameUpdates, PlayerImpl, GameImpl, NationNuke, NationMIRV, Schemas
- [x] Client: controller, HUD, banner/alarm (`decideDefconAnnouncement`), texts, sound
- [x] Client hooks: GameRenderer, UnitDisplay, BuildMenu, RadialMenuElements
- [x] Tests in `tests/mod/` (rules, execution, host settings, nuke lock, snapshots, announce, texts)
- [ ] `npm test`, `npm run lint`, `tsc`, prettier all green

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
