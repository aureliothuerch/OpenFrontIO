import { describe, expect, test } from "vitest";
import { GameConfigSchema } from "../../src/core/Schemas";
import {
  applyModConfigPatch,
  mergeModGameConfig,
  ModGameConfigSchema,
  type ModGameConfig,
} from "../../src/mod/core/ModGameConfig";

/**
 * The per-game mod switches travel inside GameConfig (lobby, wire, snapshot
 * restore). The schema hook in src/core/Schemas.ts must keep them, and the
 * mod schema must add no defaults: a restored game has to parse to exactly
 * what the live game had.
 */
describe("GameConfig.mod", () => {
  test("GameConfigSchema keeps the mod block (MOD hook in Schemas.ts)", () => {
    const pick = GameConfigSchema.pick({ mod: true });
    const mod = { defcon: { enabled: false, lockNukes: false } };
    expect(pick.parse({ mod })).toEqual({ mod });
    expect(pick.parse({})).toEqual({});
  });

  test("no defaults are added", () => {
    expect(ModGameConfigSchema.parse({})).toEqual({});
    expect(ModGameConfigSchema.parse({ defcon: {} })).toEqual({ defcon: {} });
    expect(ModGameConfigSchema.parse({ defcon: { enabled: true } })).toEqual({
      defcon: { enabled: true },
    });
  });

  test("unknown keys are dropped, wrong types are rejected", () => {
    expect(
      ModGameConfigSchema.parse({ defcon: { lockNukes: true, level: 3 } }),
    ).toEqual({ defcon: { lockNukes: true } });
    expect(() =>
      ModGameConfigSchema.parse({ defcon: { enabled: "yes" } }),
    ).toThrow();
  });
});

/** A deep copy, to check an input was left exactly as it was. */
function snapshot<T>(value: T): T {
  return structuredClone(value);
}

/** Deep-freezes an object, so any mutation by the code under test throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * mergeModGameConfig: how the server folds a host's `mod` patch into the
 * stored block (MOD hook in src/server/ConfigPatch.ts). Field by field, so a
 * switch the host sends never clears a setting it did not send.
 */
describe("mergeModGameConfig", () => {
  test("a defined field overwrites the stored value, both ways", () => {
    expect(
      mergeModGameConfig(
        { defcon: { enabled: true } },
        { defcon: { enabled: false } },
      ),
    ).toEqual({ defcon: { enabled: false } });
    expect(
      mergeModGameConfig(
        { defcon: { enabled: false, lockNukes: true } },
        { defcon: { enabled: true, lockNukes: false } },
      ),
    ).toEqual({ defcon: { enabled: true, lockNukes: false } });
  });

  test("a field the patch does not send keeps the stored value", () => {
    expect(
      mergeModGameConfig(
        { defcon: { enabled: true, lockNukes: false } },
        { defcon: { enabled: false } },
      ),
    ).toEqual({ defcon: { enabled: false, lockNukes: false } });
    expect(
      mergeModGameConfig(
        { defcon: { enabled: false, lockNukes: true } },
        { defcon: { lockNukes: false } },
      ),
    ).toEqual({ defcon: { enabled: false, lockNukes: false } });
  });

  test("an explicitly undefined field keeps the stored value", () => {
    const merged = mergeModGameConfig(
      { defcon: { enabled: false, lockNukes: true } },
      { defcon: { enabled: undefined, lockNukes: undefined } },
    );
    expect(merged).toEqual({ defcon: { enabled: false, lockNukes: true } });
    expect(merged.defcon).toHaveProperty("enabled", false);
    expect(merged.defcon).toHaveProperty("lockNukes", true);
  });

  test("an undefined, empty or missing feature block keeps the stored block", () => {
    const current = { defcon: { enabled: false, lockNukes: true } };
    expect(mergeModGameConfig(current, { defcon: undefined })).toEqual(current);
    expect(mergeModGameConfig(current, {})).toEqual(current);
    expect(mergeModGameConfig(current, { defcon: {} })).toEqual(current);
  });

  test("no stored block: the patch's defined fields", () => {
    expect(
      mergeModGameConfig(undefined, { defcon: { enabled: false } }),
    ).toEqual({ defcon: { enabled: false } });
    expect(
      mergeModGameConfig(undefined, {
        defcon: { enabled: true, lockNukes: false },
      }),
    ).toEqual({ defcon: { enabled: true, lockNukes: false } });
    expect(mergeModGameConfig(undefined, {})).toEqual({});
  });

  test("no stored block and only undefined fields: no field is set", () => {
    const merged = mergeModGameConfig(undefined, {
      defcon: { enabled: undefined },
    });
    expect("enabled" in (merged.defcon ?? {})).toBe(false);
    expect("lockNukes" in (merged.defcon ?? {})).toBe(false);
    // Still a valid block: the switch falls back to MOD_CONFIG.
    expect(ModGameConfigSchema.parse(merged)).toEqual(merged);
  });

  test("blocks of other (future) features are kept, and merged the same way", () => {
    // Features this build's schema does not know yet: the merge is generic.
    const current = {
      defcon: { enabled: true, lockNukes: false },
      research: { tier: 2, fast: true },
    } as unknown as ModGameConfig;
    expect(mergeModGameConfig(current, { defcon: { enabled: false } })).toEqual(
      {
        defcon: { enabled: false, lockNukes: false },
        research: { tier: 2, fast: true },
      },
    );

    const patch = {
      research: { tier: 3, fast: undefined },
      doctrine: { pick: "deterrence" },
    } as unknown as ModGameConfig;
    expect(mergeModGameConfig(current, patch)).toEqual({
      defcon: { enabled: true, lockNukes: false },
      research: { tier: 3, fast: true },
      doctrine: { pick: "deterrence" },
    });
  });

  test("never mutates its inputs", () => {
    const current = deepFreeze({
      defcon: { enabled: true, lockNukes: false },
      research: { tier: 2 },
    } as unknown as ModGameConfig);
    const patch = deepFreeze<ModGameConfig>({
      defcon: { enabled: false, lockNukes: undefined },
    });
    const currentBefore = snapshot(current);
    const patchBefore = snapshot(patch);

    // Frozen inputs: any write into them would throw (ES modules are strict).
    const merged = mergeModGameConfig(current, patch);

    expect(current).toEqual(currentBefore);
    expect(patch).toEqual(patchBefore);
    expect(merged).toEqual({
      defcon: { enabled: false, lockNukes: false },
      research: { tier: 2 },
    });
  });

  test("returns new objects: the result shares no patched block with its inputs", () => {
    const current: ModGameConfig = { defcon: { enabled: true } };
    const patch: ModGameConfig = { defcon: { enabled: false } };
    const merged = mergeModGameConfig(current, patch);

    expect(merged).not.toBe(current);
    expect(merged).not.toBe(patch);
    expect(merged.defcon).not.toBe(current.defcon);
    expect(merged.defcon).not.toBe(patch.defcon);

    // Later writes to the result leave the inputs alone, and vice versa.
    merged.defcon!.lockNukes = true;
    expect(current).toEqual({ defcon: { enabled: true } });
    expect(patch).toEqual({ defcon: { enabled: false } });
    patch.defcon!.enabled = true;
    expect(merged.defcon!.enabled).toBe(false);
  });

  test("the result passes the schema unchanged", () => {
    const merged = mergeModGameConfig(
      { defcon: { enabled: true, lockNukes: true } },
      { defcon: { enabled: false } },
    );
    expect(ModGameConfigSchema.parse(merged)).toEqual(merged);
    expect(GameConfigSchema.pick({ mod: true }).parse({ mod: merged })).toEqual(
      { mod: merged },
    );
  });

  test("the schema rejects a null block, so the merge never sees one", () => {
    // update_game_config is parsed with GameConfigSchema.partial().
    expect(() => ModGameConfigSchema.parse({ defcon: null })).toThrow();
    expect(
      GameConfigSchema.partial().safeParse({ mod: { defcon: null } }).success,
    ).toBe(false);
    expect(GameConfigSchema.partial().safeParse({ mod: null }).success).toBe(
      false,
    );
  });
});

/**
 * applyModConfigPatch: the MOD hook in applyGameConfigPatch. Only touches the
 * `mod` key, and only when the patch carries one.
 */
describe("applyModConfigPatch", () => {
  interface Target {
    mod?: ModGameConfig;
    bots?: number;
  }

  test("no patch.mod: a config without mod gets no `mod` key at all", () => {
    const target: Target = { bots: 3 };
    applyModConfigPatch(target, {});
    expect("mod" in target).toBe(false);
    applyModConfigPatch(target, { mod: undefined });
    expect("mod" in target).toBe(false);
    expect(target).toEqual({ bots: 3 });
  });

  test("no patch.mod: a stored block stays, the very same object", () => {
    const stored: ModGameConfig = {
      defcon: { enabled: false, lockNukes: true },
    };
    const target: Target = { mod: stored };
    applyModConfigPatch(target, {});
    applyModConfigPatch(target, { mod: undefined });
    expect(target.mod).toBe(stored);
    expect(target.mod).toEqual({ defcon: { enabled: false, lockNukes: true } });
  });

  test("patch.mod on a config without mod: sets the block", () => {
    const target: Target = {};
    applyModConfigPatch(target, { mod: { defcon: { enabled: false } } });
    expect(target.mod).toEqual({ defcon: { enabled: false } });
  });

  test("patch.mod on a stored block: merges field by field", () => {
    const target: Target = {
      mod: { defcon: { enabled: true, lockNukes: false } },
    };
    applyModConfigPatch(target, { mod: { defcon: { enabled: false } } });
    expect(target.mod).toEqual({
      defcon: { enabled: false, lockNukes: false },
    });

    applyModConfigPatch(target, { mod: { defcon: { enabled: true } } });
    expect(target.mod).toEqual({ defcon: { enabled: true, lockNukes: false } });

    applyModConfigPatch(target, { mod: {} });
    expect(target.mod).toEqual({ defcon: { enabled: true, lockNukes: false } });
  });

  test("only touches `mod`: other keys of target and patch are ignored", () => {
    const target: Target = { bots: 3 };
    const patch: Target = { bots: 9, mod: { defcon: { enabled: false } } };
    applyModConfigPatch(target, patch);
    expect(target).toEqual({ bots: 3, mod: { defcon: { enabled: false } } });
  });

  test("does not mutate the patch or keep its objects", () => {
    const patch = deepFreeze<{ mod: ModGameConfig }>({
      mod: { defcon: { enabled: false } },
    });
    const target: Target = { mod: { defcon: { lockNukes: true } } };

    applyModConfigPatch(target, patch);

    expect(patch).toEqual({ mod: { defcon: { enabled: false } } });
    expect(target.mod).not.toBe(patch.mod);
    expect(target.mod?.defcon).not.toBe(patch.mod.defcon);
    expect(target.mod).toEqual({ defcon: { enabled: false, lockNukes: true } });
  });
});
