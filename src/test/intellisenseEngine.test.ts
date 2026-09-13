// ============================================================================
//  IntelliSense engine switch — running-state detection and the workspace write
//  plan. The round-trip tests apply every plan to a simulated workspace: switching
//  back and forth must always return the user's own values, never ones O3DE wrote.
// ============================================================================

import * as assert from "assert";
import {
  EngineChoice,
  ManagedKey,
  PlanInputs,
  PriorValues,
  engineSwitchBlocker,
  nextReloadPending,
  planEngine,
  runningEngine,
  runningEngineLabel,
  withCompileCommandsDir,
} from "../intellisense/intellisenseEngine";

const DB = "D:\\OffLocalDev\\gs_play\\build\\windows\\clangd";

// ---- Running state -----------------------------------------------------------
suite("intellisenseEngine.runningEngine", () => {
  const both = { cppToolsInstalled: true, clangdInstalled: true };

  test("defaults with both installed → both running (the pre-installed clangd state)", () => {
    assert.strictEqual(runningEngine(both), "both");
    assert.strictEqual(runningEngineLabel("both"), "Both running (conflict)");
  });

  test("C/C++ IntelliSense disabled → clangd", () => {
    assert.strictEqual(runningEngine({ ...both, cppToolsEngine: "disabled" }), "clangd");
  });

  test("clangd.enable false → C/C++", () => {
    assert.strictEqual(runningEngine({ ...both, clangdEnable: false }), "cpptools");
  });

  test("'Tag Parser' is still the C/C++ extension running", () => {
    assert.strictEqual(runningEngine({ ...both, cppToolsEngine: "Tag Parser", clangdEnable: false }), "cpptools");
  });

  test("an engine that isn't installed never runs, whatever its settings say", () => {
    assert.strictEqual(runningEngine({ cppToolsInstalled: false, clangdInstalled: true }), "clangd");
    assert.strictEqual(runningEngine({ cppToolsInstalled: false, clangdInstalled: false }), "none");
  });
});

// ---- clangd arguments --------------------------------------------------------
suite("intellisenseEngine.withCompileCommandsDir", () => {
  test("appends the database dir", () => {
    assert.deepStrictEqual(withCompileCommandsDir(undefined, DB), [`--compile-commands-dir=${DB}`]);
  });

  test("replaces an existing dir (attached or detached) and keeps every other argument in order", () => {
    assert.deepStrictEqual(
      withCompileCommandsDir(["--log=verbose", "--compile-commands-dir=C:\\old", "-j=8", "--compile-commands-dir", "C:\\older"], DB),
      ["--log=verbose", "-j=8", `--compile-commands-dir=${DB}`],
    );
  });
});

// ---- Write plan --------------------------------------------------------------
type Workspace = Partial<Record<ManagedKey, unknown>>;

/** Apply a plan to a simulated workspace, returning the new workspace + prior record. */
function switchTo(choice: EngineChoice, state: { workspace: Workspace; prior: PriorValues }, extra: Partial<PlanInputs> = {}) {
  const plan = planEngine(choice, {
    cppToolsInstalled: true,
    clangdInstalled: true,
    inheritedClangdEnable: true,
    databaseDir: DB,
    workspace: state.workspace,
    prior: state.prior,
    ...extra,
  });
  const workspace: Workspace = { ...state.workspace };
  for (const { key, value } of plan.writes) {
    if (value === undefined) {
      delete workspace[key];
    } else {
      workspace[key] = value;
    }
  }
  return { workspace, prior: plan.prior, writes: plan.writes };
}

suite("intellisenseEngine.planEngine", () => {
  test("clangd from a clean workspace: C/C++ IntelliSense off, clangd pointed at O3DE's database, enable untouched", () => {
    const after = switchTo("clangd", { workspace: {}, prior: {} });
    assert.deepStrictEqual(after.workspace, {
      "C_Cpp.intelliSenseEngine": "disabled",
      "clangd.arguments": [`--compile-commands-dir=${DB}`],
    });
  });

  test("back to C/C++ from there: the workspace is clean again, with clangd switched off", () => {
    const clangd = switchTo("clangd", { workspace: {}, prior: {} });
    const cpp = switchTo("cpptools", clangd);
    assert.deepStrictEqual(cpp.workspace, { "clangd.enable": false });
  });

  test("the user's own workspace values survive any number of round trips", () => {
    const original: Workspace = { "C_Cpp.intelliSenseEngine": "Tag Parser", "clangd.arguments": ["--log=verbose"] };
    let state = { workspace: original, prior: {} as PriorValues };
    for (let i = 0; i < 4; i++) {
      state = switchTo("clangd", state);
      assert.deepStrictEqual(state.workspace["clangd.arguments"], ["--log=verbose", `--compile-commands-dir=${DB}`]);
      assert.strictEqual(state.workspace["C_Cpp.intelliSenseEngine"], "disabled");
      state = switchTo("cpptools", state);
      assert.strictEqual(state.workspace["C_Cpp.intelliSenseEngine"], "Tag Parser", `round ${i}: C/C++ value restored`);
      assert.deepStrictEqual(state.workspace["clangd.arguments"], ["--log=verbose"], `round ${i}: clangd args restored`);
      assert.strictEqual(state.workspace["clangd.enable"], false);
    }
    // And switching to clangd one last time removes the enable=false O3DE added (it wasn't the user's).
    assert.strictEqual(switchTo("clangd", state).workspace["clangd.enable"], undefined);
  });

  test("a user-level clangd.enable false: clangd choice sets workspace true; that true is never taken for the user's", () => {
    let state = { workspace: {} as Workspace, prior: {} as PriorValues };
    state = switchTo("clangd", state, { inheritedClangdEnable: false });
    assert.strictEqual(state.workspace["clangd.enable"], true);
    state = switchTo("cpptools", state, { inheritedClangdEnable: false });
    assert.strictEqual(state.workspace["clangd.enable"], false);
    state = switchTo("clangd", state, { inheritedClangdEnable: false });
    assert.strictEqual(state.workspace["clangd.enable"], true);
    assert.strictEqual(state.prior["clangd.enable"], null, "the original is still 'not set', not a value O3DE wrote");
  });

  test("clangd-only (C/C++ not installed, e.g. VSCodium) never writes C_Cpp settings", () => {
    const after = switchTo("clangd", { workspace: {}, prior: {} }, { cppToolsInstalled: false });
    assert.ok(!after.writes.some((w) => w.key === "C_Cpp.intelliSenseEngine"));
  });

  test("C/C++ with clangd not installed writes nothing for clangd", () => {
    const after = switchTo("cpptools", { workspace: {}, prior: {} }, { clangdInstalled: false });
    assert.deepStrictEqual(after.writes, []);
  });

  test("each key is written at most once per switch", () => {
    const state = switchTo("clangd", { workspace: {}, prior: {} });
    const keys = switchTo("cpptools", state).writes.map((w) => w.key);
    assert.strictEqual(new Set(keys).size, keys.length);
  });
});

// ---- Switch rules --------------------------------------------------------------
suite("intellisenseEngine switch rules", () => {
  test("an engine whose extension isn't installed can't be switched to", () => {
    assert.strictEqual(engineSwitchBlocker("clangd", { cppToolsInstalled: true, clangdInstalled: false }), "notInstalled");
    assert.strictEqual(engineSwitchBlocker("cpptools", { cppToolsInstalled: false, clangdInstalled: true }), "notInstalled");
    assert.strictEqual(engineSwitchBlocker("clangd", { cppToolsInstalled: false, clangdInstalled: true }), undefined);
  });

  test("switching to clangd while C/C++ IntelliSense runs owes a reload", () => {
    assert.strictEqual(nextReloadPending("clangd", "cpptools", false), true);
    assert.strictEqual(nextReloadPending("clangd", "both", false), true);
  });

  test("switching to clangd when C/C++ IntelliSense was already off owes nothing new", () => {
    assert.strictEqual(nextReloadPending("clangd", "clangd", false), false);
    assert.strictEqual(nextReloadPending("clangd", "none", false), false);
  });

  test("a reload still owed survives a repeat clangd switch", () => {
    assert.strictEqual(nextReloadPending("clangd", "clangd", true), true);
  });

  test("switching back to C/C++ before reloading clears the debt (it never stopped)", () => {
    assert.strictEqual(nextReloadPending("cpptools", "clangd", true), false);
  });
});
