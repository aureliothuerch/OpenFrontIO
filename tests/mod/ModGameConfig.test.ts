import { describe, expect, test } from "vitest";
import { GameConfigSchema } from "../../src/core/Schemas";
import { ModGameConfigSchema } from "../../src/mod/core/ModGameConfig";

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
