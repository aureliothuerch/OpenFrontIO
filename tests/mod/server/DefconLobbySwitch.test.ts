import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameMapSize, GameType } from "../../../src/core/game/Game";
import { GameImpl } from "../../../src/core/game/GameImpl";
import { createGameRunner, GameRunner } from "../../../src/core/GameRunner";
import {
  GameConfig,
  GameInfo,
  GameStartInfo,
  ServerMessage,
} from "../../../src/core/Schemas";
import { createGameWireContext } from "../../../src/core/ZbinWire";
import { DefconExecution } from "../../../src/mod/core/defcon/DefconExecution";
import { defconLevel } from "../../../src/mod/core/defcon/DefconState";
import { Client } from "../../../src/server/Client";
import { applyGameConfigPatch } from "../../../src/server/ConfigPatch";
import { GameServer } from "../../../src/server/GameServer";
import { ZbContext } from "../../../zbin";
import {
  cid,
  makeClient,
  makeGame,
  mockLogger,
  mockWsOf,
  startGame,
} from "../../util/GameServerHarness";
import { TestDataMapLoader } from "../../util/ScriptedGame";
import { decodeSentServerMessage, testGameConfig } from "../../util/Wire";

/**
 * The "DEFCON on/off" switch of the private host lobby, on the server side:
 * the value travels in GameConfig.mod.defcon.enabled through
 * update_game_config (merged field by field by applyGameConfigPatch's MOD
 * hook in src/server/ConfigPatch.ts, see applyModConfigPatch in
 * src/mod/core/ModGameConfig.ts), reaches every player in lobby_info and in the
 * start message, and a game started with it off runs without DEFCON. Only
 * the host may change it (upstream's IntentAuthorization, no mod logic).
 */

const HOST = cid("host");
const GUEST = cid("guest");
const HOST_PID = "host-pid";
const GUEST_PID = "guest-pid";
const T0 = 1_700_000_000_000;

/** What the host lobby's putGameConfig sends for the switch. */
function defconPatch(enabled: boolean): Partial<GameConfig> {
  return { mod: { defcon: { enabled } } };
}

function defconEnabledIn(config: GameConfig): boolean | undefined {
  return config.mod?.defcon?.enabled;
}

// ---------------------------------------------------------------------------
// applyGameConfigPatch
// ---------------------------------------------------------------------------

describe("applyGameConfigPatch: the DEFCON switch (mod)", () => {
  it("copies mod when the patch carries it, off and back on", () => {
    const target = testGameConfig();
    expect(target.mod).toBeUndefined();

    applyGameConfigPatch(target, defconPatch(false));
    expect(target.mod).toEqual({ defcon: { enabled: false } });

    applyGameConfigPatch(target, defconPatch(true));
    expect(target.mod).toEqual({ defcon: { enabled: true } });
  });

  it("leaves mod unset when the patch omits it: no `mod` key at all", () => {
    const target = testGameConfig();
    expect("mod" in target).toBe(false);

    applyGameConfigPatch(target, { bots: 7 });
    expect(target.bots).toBe(7);
    expect("mod" in target).toBe(false);

    applyGameConfigPatch(target, {});
    expect("mod" in target).toBe(false);

    // An explicit `mod: undefined` (what JSON would drop anyway) adds none.
    applyGameConfigPatch(target, { mod: undefined, bots: 8 });
    expect(target.bots).toBe(8);
    expect("mod" in target).toBe(false);
  });

  it("mod is no longer a plain copied key: the stored block is merged, not replaced", () => {
    const target = testGameConfig({ mod: { defcon: { lockNukes: true } } });
    applyGameConfigPatch(target, defconPatch(false));
    expect(target.mod).toEqual({ defcon: { enabled: false, lockNukes: true } });
  });

  it("keeps DEFCON off when a later patch carries only other keys", () => {
    // e.g. an admin-bot edit, or any client that does not know the switch.
    const target = testGameConfig(defconPatch(false));
    applyGameConfigPatch(target, {});
    expect(target.mod).toEqual({ defcon: { enabled: false } });

    applyGameConfigPatch(target, {
      bots: 3,
      donateGold: false,
      doomsdayClock: { enabled: true, speed: "fast" },
    });
    expect(target.bots).toBe(3);
    expect(target.mod).toEqual({ defcon: { enabled: false } });
  });

  it("merges the mod block field by field: the switch never clears lockNukes", () => {
    // The host lobby only sends the switch; a stored field it does not send
    // (lockNukes) survives, off and back on.
    const target = testGameConfig({
      mod: { defcon: { enabled: true, lockNukes: false } },
    });
    applyGameConfigPatch(target, defconPatch(false));
    expect(target.mod).toEqual({
      defcon: { enabled: false, lockNukes: false },
    });

    applyGameConfigPatch(target, defconPatch(true));
    expect(target.mod).toEqual({ defcon: { enabled: true, lockNukes: false } });

    // A later patch with other keys only leaves both fields alone.
    applyGameConfigPatch(target, { bots: 5 });
    expect(target.mod).toEqual({ defcon: { enabled: true, lockNukes: false } });
  });

  it("an undefined field in the patch keeps the stored value", () => {
    const target = testGameConfig({
      mod: { defcon: { enabled: false, lockNukes: true } },
    });
    applyGameConfigPatch(target, { mod: { defcon: { enabled: undefined } } });
    expect(target.mod).toEqual({ defcon: { enabled: false, lockNukes: true } });

    applyGameConfigPatch(target, { mod: { defcon: undefined } });
    expect(target.mod).toEqual({ defcon: { enabled: false, lockNukes: true } });

    applyGameConfigPatch(target, { mod: {} });
    expect(target.mod).toEqual({ defcon: { enabled: false, lockNukes: true } });
  });

  it("does not share the patch's objects with the stored config", () => {
    const target = testGameConfig();
    const patch = defconPatch(false);
    applyGameConfigPatch(target, patch);
    expect(target.mod).toEqual({ defcon: { enabled: false } });
    expect(target.mod).not.toBe(patch.mod);
    expect(target.mod?.defcon).not.toBe(patch.mod?.defcon);

    // Reusing the patch object later (the client keeps its config) cannot
    // change the stored config behind the server's back.
    patch.mod!.defcon!.enabled = true;
    expect(target.mod).toEqual({ defcon: { enabled: false } });
  });

  it("the full host config patch (upstream keys + mod) still applies every key", () => {
    const target = testGameConfig({
      mod: { defcon: { enabled: true, lockNukes: false } },
    });
    applyGameConfigPatch(target, {
      bots: 9,
      doomsdayClock: { enabled: true, speed: "fast" },
      overtime: { enabled: false },
      waterNukes: true,
      ...defconPatch(false),
    });
    expect(target.bots).toBe(9);
    expect(target.doomsdayClock).toEqual({ enabled: true, speed: "fast" });
    expect(target.overtime).toEqual({ enabled: false });
    expect(target.waterNukes).toBe(true);
    expect(target.mod).toEqual({
      defcon: { enabled: false, lockNukes: false },
    });
  });
});

// ---------------------------------------------------------------------------
// GameServer: a private lobby, driven over the socket
// ---------------------------------------------------------------------------

interface Lobby {
  game: GameServer;
  host: Client;
  guest: Client;
  log: ReturnType<typeof mockLogger>;
}

/**
 * A private FFA lobby with its host and one other player joined. Nations
 * off, so the start config also runs on the small test map below.
 */
function lobby(config: Partial<GameConfig> = {}): Lobby {
  const log = mockLogger();
  const game = makeGame({
    id: cid("dlobby"),
    log,
    creatorPersistentID: HOST_PID,
    config: { gameType: GameType.Private, nations: "disabled", ...config },
  });
  const host = makeClient({
    clientID: HOST,
    persistentID: HOST_PID,
    username: "HostName",
  });
  const guest = makeClient({
    clientID: GUEST,
    persistentID: GUEST_PID,
    username: "GuestName",
  });
  expect(game.joinClient(host)).toBe("joined");
  expect(game.joinClient(guest)).toBe("joined");
  return { game, host, guest, log };
}

async function sendDefcon(from: Client, enabled: boolean): Promise<void> {
  await mockWsOf(from).emit({
    type: "intent",
    intent: { type: "update_game_config", config: defconPatch(enabled) },
  });
}

/** The lobby as the last lobby_info frame showed it to this client. */
function lastLobbyInfo(client: Client): GameInfo {
  const infos = mockWsOf(client)
    .sent()
    .flatMap((m) => (m.type === "lobby_info" ? [m.lobby] : []));
  expect(infos.length).toBeGreaterThan(0);
  return infos[infos.length - 1];
}

/** The game config in the last lobby_info frame this client received. */
function lobbyConfigSeenBy(client: Client): GameConfig {
  const config = lastLobbyInfo(client).gameConfig;
  if (config === undefined) throw new Error("lobby_info without gameConfig");
  return config;
}

/** Reasons the server logged for rejected intents, in order. */
function rejections(log: Lobby["log"]): unknown[] {
  return log.warn.mock.calls
    .filter(([msg]: unknown[]) => msg === "intent rejected")
    .map(([, meta]: unknown[]) => (meta as { reason?: string }).reason);
}

/** Starts the game and returns the start info each client was sent. */
function startAndReadStartInfo(l: Lobby): {
  host: GameStartInfo;
  guest: GameStartInfo;
} {
  const sentBefore = new Map(
    [l.host, l.guest].map((c) => [c, mockWsOf(c).send.mock.calls.length]),
  );
  startGame(l.game);
  // Post-start frames are dictionary-encoded; the server seeds its
  // dictionary from the start-info players, in join order.
  const ctx: ZbContext = createGameWireContext([
    { clientID: HOST },
    { clientID: GUEST },
  ]);
  const startInfo = (c: Client): GameStartInfo => {
    const frames: ServerMessage[] = mockWsOf(c)
      .send.mock.calls.slice(sentBefore.get(c))
      .map(([frame]) => decodeSentServerMessage(frame, ctx));
    const starts = frames.flatMap((m) =>
      m.type === "start" ? [m.gameStartInfo] : [],
    );
    expect(starts).toHaveLength(1);
    return starts[0];
  };
  return { host: startInfo(l.host), guest: startInfo(l.guest) };
}

describe("DEFCON switch in a private lobby (GameServer, over the socket)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("a new lobby carries no switch: DEFCON on by default", () => {
    const l = lobby();
    expect(l.game.gameConfig.mod).toBeUndefined();
    // The broadcast at the host's join went out before the guest joined.
    vi.advanceTimersByTime(1000);
    expect(lobbyConfigSeenBy(l.guest).mod).toBeUndefined();
  });

  it("the host turns DEFCON off; the other player's lobby_info carries it", async () => {
    const l = lobby();
    await sendDefcon(l.host, false);

    expect(rejections(l.log)).toEqual([]);
    expect(defconEnabledIn(l.game.gameConfig)).toBe(false);
    expect(l.game.gameInfo().gameConfig?.mod).toEqual({
      defcon: { enabled: false },
    });

    vi.advanceTimersByTime(1000); // one lobby_info broadcast
    expect(lobbyConfigSeenBy(l.guest).mod).toEqual({
      defcon: { enabled: false },
    });
    // The guest's lobby_info is about the same lobby, with the host marked.
    expect(lastLobbyInfo(l.guest).lobbyCreatorClientID).toBe(HOST);
    expect(defconEnabledIn(lobbyConfigSeenBy(l.host))).toBe(false);
  });

  it("the host turns DEFCON back on", async () => {
    const l = lobby();
    await sendDefcon(l.host, false);
    vi.advanceTimersByTime(1000);
    expect(defconEnabledIn(lobbyConfigSeenBy(l.guest))).toBe(false);

    await sendDefcon(l.host, true);
    expect(rejections(l.log)).toEqual([]);
    expect(defconEnabledIn(l.game.gameConfig)).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(defconEnabledIn(lobbyConfigSeenBy(l.guest))).toBe(true);
  });

  it("a later host edit without the switch keeps DEFCON off", async () => {
    const l = lobby();
    await sendDefcon(l.host, false);
    await mockWsOf(l.host).emit({
      type: "intent",
      intent: { type: "update_game_config", config: { bots: 4 } },
    });

    expect(rejections(l.log)).toEqual([]);
    expect(l.game.gameConfig.bots).toBe(4);
    expect(defconEnabledIn(l.game.gameConfig)).toBe(false);
  });

  it("the host's switch keeps a stored lockNukes, in lobby_info and at the start", async () => {
    const l = lobby({ mod: { defcon: { lockNukes: false } } });
    await sendDefcon(l.host, false);

    expect(rejections(l.log)).toEqual([]);
    const merged = { defcon: { enabled: false, lockNukes: false } };
    expect(l.game.gameConfig.mod).toEqual(merged);
    vi.advanceTimersByTime(1000);
    expect(lobbyConfigSeenBy(l.guest).mod).toEqual(merged);

    const start = startAndReadStartInfo(l);
    expect(start.guest.config.mod).toEqual(merged);
  });

  it("a non-host cannot turn DEFCON off", async () => {
    const l = lobby();
    await sendDefcon(l.guest, false);

    expect(rejections(l.log)).toEqual([
      "only the lobby creator can update game config",
    ]);
    expect(l.game.gameConfig.mod).toBeUndefined();

    vi.advanceTimersByTime(1000);
    expect(lobbyConfigSeenBy(l.guest).mod).toBeUndefined();
    expect(lobbyConfigSeenBy(l.host).mod).toBeUndefined();
  });

  it("a non-host cannot turn DEFCON back on after the host turned it off", async () => {
    const l = lobby();
    await sendDefcon(l.host, false);
    await sendDefcon(l.guest, true);

    expect(rejections(l.log)).toEqual([
      "only the lobby creator can update game config",
    ]);
    expect(defconEnabledIn(l.game.gameConfig)).toBe(false);
  });

  it("the non-host check is upstream's: handleIntent answers 403", () => {
    const l = lobby();
    const outcome = l.game.handleIntent(
      { type: "update_game_config", config: defconPatch(false) },
      {
        clientID: GUEST,
        isLobbyCreator: false,
        isAdmin: false,
        isAdminBot: false,
      },
    );
    expect(outcome.status).toBe(403);
    expect(l.game.gameConfig.mod).toBeUndefined();
  });

  it("a publicly listed lobby rejects the host's switch (409)", async () => {
    const l = lobby();
    l.game.setListed(true);
    await sendDefcon(l.host, false);

    expect(rejections(l.log)).toEqual([
      "cannot change the config of a publicly listed lobby",
    ]);
    expect(l.game.gameConfig.mod).toBeUndefined();

    const outcome = l.game.handleIntent(
      { type: "update_game_config", config: defconPatch(false) },
      {
        clientID: HOST,
        isLobbyCreator: true,
        isAdmin: false,
        isAdminBot: false,
      },
    );
    expect(outcome.status).toBe(409);
    expect(l.game.gameConfig.mod).toBeUndefined();
  });

  it("listing keeps a DEFCON-off lobby off; the host cannot turn it back on", async () => {
    const l = lobby();
    await sendDefcon(l.host, false);
    l.game.setListed(true);
    await sendDefcon(l.host, true);

    expect(rejections(l.log)).toEqual([
      "cannot change the config of a publicly listed lobby",
    ]);
    expect(defconEnabledIn(l.game.gameConfig)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(defconEnabledIn(lobbyConfigSeenBy(l.guest))).toBe(false);
  });

  it("a public game rejects the switch", async () => {
    const l = lobby({ gameType: GameType.Public });
    await sendDefcon(l.host, false);

    expect(rejections(l.log)).toEqual(["cannot update a public game"]);
    expect(l.game.gameConfig.mod).toBeUndefined();
  });

  it("the start message carries DEFCON off to every player; it cannot change after the start", async () => {
    const l = lobby();
    await sendDefcon(l.host, false);
    const start = startAndReadStartInfo(l);

    expect(start.guest.config.mod).toEqual({ defcon: { enabled: false } });
    expect(start.host.config.mod).toEqual({ defcon: { enabled: false } });

    await sendDefcon(l.host, true);
    expect(rejections(l.log)).toEqual(["game already started"]);
    expect(defconEnabledIn(l.game.gameConfig)).toBe(false);
  });

  it("an untouched lobby starts without the switch (DEFCON on by default)", () => {
    const l = lobby();
    const start = startAndReadStartInfo(l);
    expect(start.guest.config.mod).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The simulation, from the start info the (non-host) player received
// ---------------------------------------------------------------------------

/**
 * The real client pipeline: createGameRunner (which calls GameRunner.init()
 * and so the MOD hook modInitExecutions) on a small test map. The map files
 * come from tests/testdata/maps whatever map the config names.
 */
async function runnerFor(start: GameStartInfo): Promise<GameRunner> {
  return createGameRunner(
    start,
    GUEST,
    new TestDataMapLoader("big_plains"),
    () => {},
  );
}

function runTicks(runner: GameRunner, n: number): void {
  for (let i = 0; i < n; i++) {
    runner.addTurn({ turnNumber: runner.game.ticks(), intents: [] });
    expect(runner.executeNextTick()).toBe(true);
  }
}

/** DefconExecutions in the game, initialised or still waiting for init. */
function defconExecutions(runner: GameRunner): DefconExecution[] {
  // executions() is on GameImpl only, not on the Game interface.
  expect(runner.game).toBeInstanceOf(GameImpl);
  return (runner.game as GameImpl)
    .executions()
    .filter((e): e is DefconExecution => e instanceof DefconExecution);
}

/** The start info the guest receives after the host's switch changes. */
async function guestStartInfo(switches: boolean[]): Promise<GameStartInfo> {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  try {
    const l = lobby();
    for (const enabled of switches) await sendDefcon(l.host, enabled);
    expect(rejections(l.log)).toEqual([]);
    return startAndReadStartInfo(l).guest;
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

describe("DEFCON switch: the started game (GameRunner)", () => {
  it("DEFCON off: GameRunner.init adds no DefconExecution, no level ever", async () => {
    const start = await guestStartInfo([false]);
    const runner = await runnerFor(start);

    expect(runner.game.config().gameConfig().mod).toEqual({
      defcon: { enabled: false },
    });
    expect(defconExecutions(runner)).toEqual([]);
    runTicks(runner, 5);
    expect(defconExecutions(runner)).toEqual([]);
    expect(defconLevel(runner.game)).toBeNull();
  });

  it("DEFCON left on (untouched lobby): exactly one DefconExecution runs", async () => {
    const start = await guestStartInfo([]);
    const runner = await runnerFor(start);

    expect(defconExecutions(runner)).toHaveLength(1);
    runTicks(runner, 5);
    expect(defconLevel(runner.game)).toBe(5);
  });

  it("DEFCON off and back on: DEFCON runs again", async () => {
    const start = await guestStartInfo([false, true]);
    expect(start.config.mod).toEqual({ defcon: { enabled: true } });
    const runner = await runnerFor(start);

    expect(defconExecutions(runner)).toHaveLength(1);
    runTicks(runner, 5);
    expect(defconLevel(runner.game)).toBe(5);
  });

  it("singleplayer with DEFCON off adds no DefconExecution either", async () => {
    // What the singleplayer menu starts with the switch off.
    const runner = await runnerFor({
      gameID: cid("solo"),
      lobbyCreatedAt: 0,
      config: testGameConfig({
        gameType: GameType.Singleplayer,
        gameMapSize: GameMapSize.Normal,
        nations: "disabled",
        ...defconPatch(false),
      }),
      players: [
        {
          clientID: GUEST,
          username: "SoloName",
          clanTag: null,
          isLobbyCreator: true,
        },
      ],
    });

    expect(defconExecutions(runner)).toEqual([]);
    runTicks(runner, 5);
    expect(defconLevel(runner.game)).toBeNull();
  });
});
