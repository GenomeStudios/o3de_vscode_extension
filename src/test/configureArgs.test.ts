// ============================================================================
//  CMake flags (o3de.cmake.configureArgs) — the one model the Advanced tab,
//  Configure and the MCP config tools share: cleaning a stored value, applying a
//  set/remove patch, name validation, and "applied" against CMakeCache.txt.
// ============================================================================

import * as assert from "assert";
import {
  applyCmakeFlagPatch,
  cmakeFlagsReport,
  invalidCmakeFlagNames,
  normalizeCmakeFlags,
} from "../build/configureArgs";

const CACHE = [
  "# This is the CMakeCache file.",
  "LY_RENDERDOC_ENABLED:BOOL=ON",
  "CMAKE_OBJECT_PATH_MAX:UNINITIALIZED=1000",
  "LY_MONOLITHIC_GAME:BOOL=OFF",
].join("\n");

suite("configureArgs.normalizeCmakeFlags", () => {
  test("values become strings; blank keys and null values are dropped; keys are trimmed", () => {
    assert.deepStrictEqual(normalizeCmakeFlags({ A: "ON", " B ": 5, "": "x", C: null }), { A: "ON", B: "5" });
  });

  test("anything that isn't an object reads as no flags", () => {
    assert.deepStrictEqual(normalizeCmakeFlags(undefined), {});
    assert.deepStrictEqual(normalizeCmakeFlags(["A=ON"]), {});
    assert.deepStrictEqual(normalizeCmakeFlags("A=ON"), {});
  });
});

suite("configureArgs.applyCmakeFlagPatch", () => {
  test("a value sets or replaces; an empty string or null removes; unlisted flags are kept", () => {
    const next = applyCmakeFlagPatch({ A: "ON", B: "1", C: "x" }, { A: "OFF", B: "", C: null, D: "new" });
    assert.deepStrictEqual(next, { A: "OFF", D: "new" });
  });

  test("the input is not mutated", () => {
    const current = { A: "ON" };
    applyCmakeFlagPatch(current, { A: null });
    assert.deepStrictEqual(current, { A: "ON" });
  });
});

suite("configureArgs.invalidCmakeFlagNames", () => {
  test("only CMake variable names pass", () => {
    assert.deepStrictEqual(invalidCmakeFlagNames({ LY_X: "1", _y2: "1", "2BAD": "1", "HAS SPACE": "1", "A-B": "1" }), [
      "2BAD",
      "HAS SPACE",
      "A-B",
    ]);
  });
});

suite("configureArgs.cmakeFlagsReport", () => {
  test("a flag the cache already holds is applied; a different or missing cached value is pending", () => {
    const report = cmakeFlagsReport({ LY_RENDERDOC_ENABLED: "ON", CMAKE_OBJECT_PATH_MAX: "2000", NEW_FLAG: "1" }, CACHE);
    assert.strictEqual(report.configured, true);
    assert.deepStrictEqual(report.flags, [
      { key: "CMAKE_OBJECT_PATH_MAX", value: "2000", cached: "1000", applied: false },
      { key: "LY_RENDERDOC_ENABLED", value: "ON", cached: "ON", applied: true },
      { key: "NEW_FLAG", value: "1", cached: undefined, applied: false },
    ]);
    assert.strictEqual(report.pending, true);
  });

  test("every flag applied → nothing pending", () => {
    assert.strictEqual(cmakeFlagsReport({ LY_RENDERDOC_ENABLED: "ON" }, CACHE).pending, false);
  });

  test("not configured yet: stored flags are pending until the first configure", () => {
    const report = cmakeFlagsReport({ LY_RENDERDOC_ENABLED: "ON" }, undefined);
    assert.strictEqual(report.configured, false);
    assert.strictEqual(report.pending, true);
  });

  test("no flags → nothing pending, configured or not", () => {
    assert.strictEqual(cmakeFlagsReport({}, CACHE).pending, false);
    assert.strictEqual(cmakeFlagsReport({}, undefined).pending, false);
  });
});
