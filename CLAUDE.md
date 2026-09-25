# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## This Repo Is a Fork

This is a **fork of [OpenFront.io](https://github.com/openfrontio/OpenFrontIO)**. Our game adds a nuke-escalation layer on top of OpenFront: a global DEFCON system, a control-center look and sound, an advisor voice, doctrines and a small research system. Design doc: https://claude.ai/code/artifact/0f16aa7b-9a31-490d-88fb-624533bcac49

**Top priority: stay mergeable with upstream.** OpenFront is actively developed and we pull its updates regularly. Every change must be written so that `git merge upstream/main` produces as few conflicts as possible.

## Mod Folder Rules (IMPORTANT)

All of our own code lives in `src/mod/`, mirroring the upstream layers:

```
src/mod/
  core/     # Our deterministic simulation logic (DEFCON, doctrines, research)
  client/   # Our rendering, UI, sounds, advisor voice, newspaper
  server/   # Our server-side additions (only if really needed)
tests/mod/  # Tests for src/mod/core
```

1. **New features go in `src/mod/`**, never as rewrites of upstream files.
2. **Upstream files (`src/core`, `src/client`, `src/server`) get only minimal "hook" edits**: ideally one line that calls into `src/mod/`. Mark every such edit:
   ```ts
   // MOD: DEFCON hook – see src/mod/core/defcon/
   ```
   Before editing an upstream file, check whether a hook already exists and reuse it.
3. **Change balance values through config overrides** in `src/mod/`, not by editing numbers inside upstream code.
4. **Never reformat, rename or reorganize upstream files.** Unrelated diffs cause merge conflicts.
5. **`src/mod/core/` follows the same rules as `src/core/`**: pure TypeScript, no external dependencies, fully deterministic (seeded PRNG, no floating-point math), and every change needs tests in `tests/mod/`.
6. If a feature truly cannot be done with a small hook, stop and explain why before making a larger upstream edit.

## Upstream Workflow

```bash
git remote add upstream https://github.com/openfrontio/OpenFrontIO.git  # once
git fetch upstream
git merge upstream/main          # merge often (ideally weekly)
git cherry-pick <commit>         # later, once we diverge: pull single fixes only
```

- Resolve conflicts by keeping upstream's version and re-applying our `// MOD:` hooks.
- After every merge: `npm test` and `npm run lint` must pass.
- To list all our hooks in upstream files: `grep -rn "// MOD:" src/core src/client src/server tests eslint.config.js`. Import lines of hooks are not marked (Prettier re-sorts them), and the `mod` block in `resources/lang/en.json` cannot carry a marker (JSON).

## Branching

- **`main` must always be playable.** Never commit directly to `main`.
- **One branch per feature**, named `mod/<feature>` (e.g. `mod/defcon`, `mod/advisor-voice`). Fixes use `fix/<topic>`.
- **Upstream updates** happen on their own branch, never directly on `main`:
  ```bash
  git checkout -b upstream-sync main
  git fetch upstream
  git merge upstream/main
  npm test && npm run lint
  ```
  Only merge `upstream-sync` into `main` once tests and lint pass.
- Before merging a feature branch into `main`: `npm test` and `npm run lint` must pass, and the game must start with `npm run dev`.
- Keep branches short-lived. Merge `main` into long-running feature branches regularly to avoid big conflicts.
- Before starting work, check which branch is checked out. If it's `main`, create a new branch first.

## Branching Workflow

Never commit directly to `main`. `main` must always be playable.

- **One branch per feature or fix**, created from an up-to-date `main`:
  ```bash
  git checkout main
  git pull
  git checkout -b feature/defcon-system
  ```
- **Branch names:** `feature/<name>`, `fix/<name>`, `upstream/<date>` (e.g. `upstream/2026-10-01`).
- **Upstream merges also happen on their own branch**, never directly on `main`:
  ```bash
  git checkout -b upstream/2026-10-01
  git fetch upstream
  git merge upstream/main
  ```
- Before merging a branch into `main`: `npm test` and `npm run lint` must pass.
- Keep branches small and short-lived. Merge them into `main` often.
- Do not push, merge into `main` or delete branches without asking first.

## TODO File

Keep a short task list in `docs/mod/TODO.md` so progress survives between sessions.

- Read it at the start of every session.
- Only the **current milestone** with concrete steps. Big ideas live in the design doc, not here.
- Use checkboxes: `- [ ]` open, `- [x]` done. Update them as you work.
- Keep it short: regularly remove finished items or condense them into a one-line summary at the bottom.

## Assets (Graphics, Sounds, Voice)

Our own assets live in `resources/mod/` (e.g. `resources/mod/sounds/`, `resources/mod/images/`), never mixed into upstream asset folders.

When a feature needs an asset that does not exist yet:

1. **Never download assets from the internet** and never generate or copy assets of unknown origin.
2. **Use a placeholder** so the feature still works: reuse an existing OpenFront asset (not from `proprietary/`), a simple shape/color, or silence for sounds.
3. **Add it to `docs/mod/TODO.md`** as `- [ ] ASSET NEEDED: <file name> – <what it is, size/length, where it is used>`.
4. Load assets through one central file in `src/mod/client/` so placeholders can be swapped later without touching feature code.
5. When a real third-party asset is added, record its source and license in `CREDITS.md` under a `## Mod Assets` section at the end of the file.

Existing OpenFront assets outside `proprietary/` may be reused (CC BY-SA 4.0). Modified versions of them must stay CC BY-SA 4.0.

## Host Settings & Game Modes (ALWAYS CHECK)

Hosts can change almost everything in a lobby. **Every mod feature must work correctly with every combination of settings.** Check these before designing or changing a feature:

- **Disabled units** (`disabledUnits`, `config().isUnitDisabled(type)`): e.g. `AtomBomb`, `HydrogenBomb`, `MIRV`, `MissileSilo`, `SAMLauncher`. Use the `Nukes` unit group instead of hardcoding single nuke types.
- **Modifiers** (`publicGameModifiers`): `isNukesDisabled`, `isSAMsDisabled`, `isAlliancesDisabled`, `isPeaceTime`, `isWaterNukes`, `isDoomsdayClock`, `startingGold`, `goldMultiplier`, …
- **Upstream end-game systems:** `doomsdayClock` (territory bar with troop bleed) and `overtime` (anti-stalemate).
- **Game type and mode:** Singleplayer / Public / Private, FFA / Team, ranked 1v1/2v2, nations enabled or disabled.
- **Teams and alliances are separate systems.** In team mode, players can have teammates AND alliances with players from other teams at the same time. Never treat "teammate" and "ally" as the same thing.

Rules:

1. **Never re-enable what the host disabled.** A mod feature may only restrict further, never unlock something the settings turned off.
2. **Degrade gracefully.** If a feature depends on something that is disabled (e.g. nukes off), it must not break, show wrong messages ("Nukes unlocked") or play pointless alarms. Decide explicitly what the feature does in that case.
3. **Every mod feature needs its own on/off switch** in the mod config, so it can later become a lobby setting.
4. **Tests must cover the disabled cases**, at least: all nukes disabled, a single nuke type disabled, SAMs disabled, alliances disabled, peace time on, team mode, and team mode with alliances between different teams.
5. **Decide for every feature how it works per player vs. per team** (e.g. who is attacked, who counts as betrayed, who is shown a warning).
6. **In every plan, list which settings affect the feature and how it behaves with each.**

## Reuse Existing Mechanics

Before building a feature, check whether upstream already has something similar (e.g. `DoomsdayClock`, `overtime`, `isPeaceTime`, traitor/alliance-break logic) and point out overlaps in the plan before writing code.

We may extend, replace or turn off upstream mechanics. But **never delete or rewrite upstream code** to do so: turn the upstream mechanic off through a config override or a small `// MOD:` hook and build our version in `src/mod/`. Same result, no merge conflicts.

## License & Branding

- Code is **AGPL-3.0**, assets are **CC BY-SA 4.0**. Our full source (incl. server) must stay public.
- Keep the "© OpenFront and Contributors" notice visible (footer and loading screen). Never remove it.
- **Never use anything from `proprietary/`** (OpenFront name, logo, branding). Our own branding lives in `src/mod/` / our own asset folders.

## Commands

```bash
npm run inst             # Install deps (uses npm ci --ignore-scripts — do NOT use npm install)
npm run dev              # Run client + server in dev mode with hot reload
npm run start:client     # Client only
npm run start:server-dev # Server only
npm test                 # Run all tests (Vitest)
npm run test:coverage    # Tests with coverage
npm run lint             # Oxlint + ESLint
npm run lint:fix         # Oxlint + ESLint with auto-fix
npm run format           # Prettier
npm run build-prod       # Production build
```

**Run a single test file:**

```bash
npx vitest tests/YourTest.test.ts --run
npx vitest NationAllianceBehavior --run # match by name pattern
```

## Architecture

OpenFront.io is a real-time multiplayer territorial strategy game. There are four components:

1. **`src/core/`** — Deterministic game simulation. Pure TypeScript with **no external dependencies**. Must remain fully deterministic (seeded PRNG, no floating-point math). Runs in a Web Worker thread. All `src/core` changes **must** include tests.
2. **`src/client/`** — Rendering (Pixi.js/WebGL), UI (Lit web components + Tailwind CSS 4), WebSocket communication.
3. **`src/server/`** — Game coordination, intent relay, WebSocket management (Node.js/Express/ws).
4. **API** — Closed-source Cloudflare Worker handling auth, stats, cosmetics, monetization. Not in this repo. Our fork needs its own solution for this.

### Simulation Flow (Intent → Execution)

The game simulation runs **on each client**, not the server. The server only relays intents.

1. Player action → client creates an **Intent** → sent to server
2. Server bundles all intents for the tick into a **Turn** → relays to all clients
3. Client forwards Turn to the Core worker
4. Core creates an **Execution** for each intent
5. Core calls `executeNextTick()` — all executions run and mutate game state
6. Core sends **GameUpdates** back to client → client renders

Intents and all wire messages are Zod-validated schemas defined in `src/core/Schemas.ts`.
Every WebSocket frame is a compact binary encoding of those schemas
(`src/core/ZbinWire.ts`, library docs in `zbin/README.md`). HTTP stays JSON.

New intents for our features (e.g. doctrine choice) should be defined in `src/mod/core/` and registered in `Schemas.ts` with a `// MOD:` hook.

### CDN / Static Assets

The game server only serves `index.html` and the WebSocket. All other assets (JS bundle, images, maps, worker) come from a CDN bucket. `CDN_BASE` is an empty string in dev (falls back to same-origin) and a full origin (e.g. `https://cdn.example.com`) in production. It is set as both a Vite build-time variable and a server runtime env var.

## Key Files

| File                        | Purpose                                |
| --------------------------- | -------------------------------------- |
| `src/mod/`                  | **All of our own code**                |
| `src/core/Schemas.ts`       | All intent/message types (Zod schemas) |
| `src/core/GameRunner.ts`    | Simulation orchestrator                |
| `src/core/game/GameImpl.ts` | Game state implementation              |
| `src/server/GameServer.ts`  | Main WebSocket server, game loop       |
| `src/server/Master.ts`      | Lobby and game registry                |
| `tests/util/Setup.ts`       | Test helper — creates test games       |
| `docs/Architecture.md`      | Architecture overview                  |
| `zbin/README.md`            | Binary wire format for zod schemas     |
| `docs/Auth.md`              | JWT/auth flow                          |
| `docs/API.md`               | Public API endpoints                   |
| `vite.config.ts`            | Build config, CDN handling             |

## UI Text / i18n

All user-visible text must go through `translateText()` and have a corresponding entry in `resources/lang/en.json`. For our features, use keys prefixed with `mod.` (e.g. `mod.defcon.level_changed`) and keep them together in one block to reduce merge conflicts. Translations are managed via Crowdin. DO NOT modify any other translation files.

## Testing Patterns

Tests use a `setup()` helper from `tests/util/Setup.ts` that creates a full game instance with map data from `tests/testdata/maps/`. Write tests that exercise the core simulation directly — not mocks. Our tests go in `tests/mod/`.

## Tech Stack

- **Bundler:** Vite + TypeScript 5.7
- **Rendering:** Pixi.js (WebGL)
- **UI Components:** Lit (LitElement) + Tailwind CSS 4
- **Audio:** Howler.js (use this for alarms and the advisor voice)
- **Schemas/Validation:** Zod
- **Testing:** Vitest
- **Server:** Node.js, Express, ws (WebSocket)
