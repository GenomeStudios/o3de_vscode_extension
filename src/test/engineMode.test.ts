// ============================================================================
//  Engine mode — classification and the copy rules the UI depends on.
//
//  Fixtures mirror the real engines on the dev machine: GS_Play_Engine (SDK,
//  headers only) and o3de_sourcedev (source). Pure — no disk, no vscode state.
// ============================================================================

import * as assert from "assert";
import { engineModeDetail, engineModeLabel, resolveEngineMode } from "../intellisense/engineMode";
import { O3deEngine } from "../o3de/identity";

// ---- Fixture ---------------------------------------------------------------
function engine(engineName: string, isSdkEngine: boolean, version = "2.7.0"): O3deEngine {
  return { engineName, isSdkEngine, version, externalSubdirectories: [], path: `D:/Engines/${engineName}` };
}
const SDK = engine("GS_Play_Engine", true);
const SOURCE = engine("o3de_sourcedev", false);

// ---- Classification --------------------------------------------------------
suite("engineMode.resolveEngineMode", () => {
  test("native — the project builds against a source engine", () => {
    assert.strictEqual(resolveEngineMode(SOURCE, undefined, true).mode, "native");
  });

  test("redirected — SDK build engine + source engine in the workspace (the gs_play setup)", () => {
    const report = resolveEngineMode(SDK, SOURCE, true);
    assert.strictEqual(report.mode, "redirected");
    assert.strictEqual(report.buildEngine?.name, "GS_Play_Engine");
    assert.strictEqual(report.sourceEngine?.name, "o3de_sourcedev");
  });

  test("headersOnly — SDK build engine with nothing to redirect to", () => {
    assert.strictEqual(resolveEngineMode(SDK, undefined, true).mode, "headersOnly");
  });

  test("unresolved — no build engine", () => {
    assert.strictEqual(resolveEngineMode(undefined, SOURCE, true).mode, "unresolved");
  });

  test("headersOnly offers a remedy ONLY when a source engine is registered", () => {
    assert.strictEqual(resolveEngineMode(SDK, undefined, true).remedyAvailable, true);
    assert.strictEqual(resolveEngineMode(SDK, undefined, false).remedyAvailable, false);
  });

  test("no other mode ever offers a remedy", () => {
    assert.strictEqual(resolveEngineMode(SOURCE, undefined, true).remedyAvailable, false);
    assert.strictEqual(resolveEngineMode(SDK, SOURCE, true).remedyAvailable, false);
    assert.strictEqual(resolveEngineMode(undefined, undefined, true).remedyAvailable, false);
  });

  test("native reports no redirect target even with a source engine in the workspace", () => {
    assert.strictEqual(resolveEngineMode(SOURCE, SOURCE, true).sourceEngine, undefined);
  });

  test("versions are carried as information and never change the mode", () => {
    const skewed = resolveEngineMode(engine("GS_Play_Engine", true, "2.5.2"), engine("o3de_sourcedev", false, "00.00"), true);
    assert.strictEqual(skewed.mode, "redirected");
    assert.strictEqual(skewed.buildEngine?.version, "2.5.2");
  });
});

// ---- Copy rules ------------------------------------------------------------
suite("engineMode copy", () => {
  test("labels are short dashboard values", () => {
    assert.strictEqual(engineModeLabel(resolveEngineMode(SOURCE, undefined, true)), "Indexed (source engine)");
    assert.strictEqual(engineModeLabel(resolveEngineMode(SDK, SOURCE, true)), "Redirected to o3de_sourcedev");
    assert.strictEqual(engineModeLabel(resolveEngineMode(SDK, undefined, true)), "Headers only (SDK engine)");
    assert.strictEqual(engineModeLabel(resolveEngineMode(undefined, undefined, true)), "Not resolved");
  });

  test("headers-only detail names the lost capability and never says 'declarations only'", () => {
    const detail = engineModeDetail(resolveEngineMode(SDK, undefined, false));
    assert.ok(detail.includes("headers only"));
    assert.ok(detail.includes("Go to Definition cannot reach engine implementation"));
    assert.ok(!/declarations only/i.test(detail));
  });

  test("headers-only detail mentions Set Up Workspace only when that remedy exists", () => {
    assert.ok(engineModeDetail(resolveEngineMode(SDK, undefined, true)).includes("Set Up Workspace"));
    assert.ok(!engineModeDetail(resolveEngineMode(SDK, undefined, false)).includes("Set Up Workspace"));
  });

  test("redirected detail names both engines", () => {
    const detail = engineModeDetail(resolveEngineMode(SDK, SOURCE, true));
    assert.ok(detail.includes("GS_Play_Engine") && detail.includes("o3de_sourcedev"));
  });
});
