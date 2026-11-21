// Tests for the dependency registry's pure ramp roll-up (intent + platform → next step).
import * as assert from "assert";
import {
  activeChecks,
  appliesToPlatform,
  isBlocking,
  nextStep,
  rampComplete,
  rampProgress,
  readiness,
  ResultMap,
  CHECKS,
} from "../deps/registry";
import { Intent } from "../deps/registry";
import { configuredThirdParty, thirdPartyCheck } from "../deps/detectors";

const WIN = "win32" as NodeJS.Platform;
const LINUX = "linux" as NodeJS.Platform;

function intents(...ids: Intent["id"][]): Set<Intent["id"]> {
  return new Set(ids);
}

// All required checks satisfied, everything else absent.
function allOk(): ResultMap {
  const map: ResultMap = {};
  for (const c of CHECKS) {
    map[c.id] = { state: c.tier === "required" ? "ok" : "absent" };
  }
  return map;
}

suite("Onboarding deps — tracks + platform", () => {
  test("base is engine + project + the per-project opt-in", () => {
    const base = activeChecks(intents(), WIN).map((c) => c.id);
    assert.deepStrictEqual(base.sort(), ["engine", "project", "projectEnabled"]);
  });

  test("cpp intent adds source engine + toolchain + cpptools", () => {
    const ids = activeChecks(intents("cpp"), WIN).map((c) => c.id);
    for (const id of ["sourceEngine", "visualStudio", "cmake", "ninja", "windowsSdk", "thirdParty", "cpptools"]) {
      assert.ok(ids.includes(id), `expected ${id} in cpp track`);
    }
    assert.ok(!ids.includes("sumneko"));
  });

  test("lua intent adds the language server + dump pieces", () => {
    const ids = activeChecks(intents("lua"), WIN).map((c) => c.id);
    assert.ok(ids.includes("sumneko") && ids.includes("remoteToolsGem") && ids.includes("reflectionDump"));
    assert.ok(!ids.includes("cpptools"));
  });

  test("platform gating: Visual Studio on Windows, gcc on Linux", () => {
    const win = activeChecks(intents("cpp"), WIN).map((c) => c.id);
    assert.ok(win.includes("visualStudio") && !win.includes("gcc"));
    const lin = activeChecks(intents("cpp"), LINUX).map((c) => c.id);
    assert.ok(lin.includes("gcc") && !lin.includes("visualStudio") && !lin.includes("windowsSdk"));
  });

  test("the Visual Studio row label names no year (any installed version can satisfy it)", () => {
    const vs = CHECKS.find((c) => c.id === "visualStudio")!;
    assert.ok(!/20\d\d/.test(vs.label), `label should not name a year: ${vs.label}`);
  });

  test("appliesToPlatform respects the platforms field", () => {
    const vs = CHECKS.find((c) => c.id === "visualStudio")!;
    assert.strictEqual(appliesToPlatform(vs, WIN), true);
    assert.strictEqual(appliesToPlatform(vs, LINUX), false);
    const cmake = CHECKS.find((c) => c.id === "cmake")!;
    assert.strictEqual(appliesToPlatform(cmake, LINUX), true); // no platforms field = all
  });
});

suite("Onboarding deps — blocking + next step", () => {
  test("a missing required check blocks; warn/absent does not; optional never blocks", () => {
    const vs = CHECKS.find((c) => c.id === "visualStudio")!;
    assert.strictEqual(isBlocking(vs, { state: "missing" }), true);
    assert.strictEqual(isBlocking(vs, { state: "warn" }), false);
    assert.strictEqual(isBlocking(vs, { state: "ok" }), false);
    const opt = CHECKS.find((c) => c.id === "ffmpeg")!;
    assert.strictEqual(isBlocking(opt, { state: "missing" }), false);
  });

  test("cold start: with no engine, the next step is to get O3DE", () => {
    const results = allOk();
    results["engine"] = { state: "missing" };
    const step = nextStep(results, intents("cpp", "lua"), WIN);
    assert.strictEqual(step?.id, "engine");
    assert.strictEqual(step?.action?.kind, "url"); // acquisition: download O3DE
  });

  test("a C++ toolchain gap only surfaces when C++ is chosen", () => {
    const results = allOk();
    results["cmake"] = { state: "missing" };
    assert.strictEqual(nextStep(results, intents("lua"), WIN), null); // Lua-only ramp ignores the toolchain
    assert.strictEqual(nextStep(results, intents("cpp"), WIN)?.id, "cmake");
  });

  test("Lua-only on an SDK engine needs no toolchain — just the language server", () => {
    const results = allOk();
    results["sumneko"] = { state: "missing" };
    assert.strictEqual(nextStep(results, intents("lua"), WIN)?.id, "sumneko");
  });

  test("rampComplete true when all required base+track checks pass (full package)", () => {
    const results = allOk();
    assert.strictEqual(rampComplete(results, intents("cpp", "lua"), WIN), true);
    results["project"] = { state: "missing" };
    assert.strictEqual(rampComplete(results, intents("cpp", "lua"), WIN), false);
  });

  test("readiness gives base + independent C++/Lua sub-reports", () => {
    const results = allOk();
    // Everything required present → all tracks ready.
    let r = readiness(results, WIN);
    assert.strictEqual(r.base, true);
    assert.strictEqual(r.cpp, true);
    assert.strictEqual(r.lua, true);
    // Break a C++-only requirement: base + Lua still ready, C++ not.
    results["cmake"] = { state: "missing" };
    r = readiness(results, WIN);
    assert.strictEqual(r.base, true);
    assert.strictEqual(r.lua, true);
    assert.strictEqual(r.cpp, false);
  });

  test("rampProgress counts required satisfied/total per platform", () => {
    const results = allOk();
    // Windows full package: base(3: engine,project,projectEnabled) + cpp(8: sourceEngine,workspaceSettings,visualStudio,windowsSdk,cmake,ninja,thirdParty,cpptools) + lua(1: sumneko).
    const win = rampProgress(results, intents("cpp", "lua"), WIN);
    assert.strictEqual(win.total, 12);
    assert.strictEqual(win.done, 12);
    // Linux swaps visualStudio+windowsSdk (2) for gcc (1): base(3)+cpp(7)+lua(1) = 11.
    assert.strictEqual(rampProgress(results, intents("cpp", "lua"), LINUX).total, 11);
    results["ninja"] = { state: "missing" };
    assert.strictEqual(rampProgress(results, intents("cpp"), WIN).done, rampProgress(allOk(), intents("cpp"), WIN).done - 1);
  });
});

// ---- 3rd Party path row (#36) -- the Advanced tab's LY_3RDPARTY_PATH counts, like in Configure ----
suite("Onboarding deps — the 3rd Party path row", () => {
  const HOME = "/home/x";
  const check = (manifest: string | undefined, flags: Record<string, string> | undefined, present: string[]) =>
    thirdPartyCheck(configuredThirdParty(manifest, flags, HOME), (folder) => present.includes(folder));

  test("an Advanced-tab path that exists beats a manifest folder that is gone", () => {
    const result = check("/old/3rdParty", { LY_3RDPARTY_PATH: "/new/3rdParty" }, ["/new/3rdParty"]);
    assert.strictEqual(result.state, "ok");
    assert.ok(result.detail?.startsWith("/new/3rdParty"), result.detail);
  });

  test("an Advanced-tab path with no manifest default is ok, not missing", () => {
    assert.strictEqual(check(undefined, { LY_3RDPARTY_PATH: "/new/3rdParty" }, ["/new/3rdParty"]).state, "ok");
  });

  test("an Advanced-tab path to a folder that does not exist warns and says so", () => {
    const result = check("/old/3rdParty", { LY_3RDPARTY_PATH: "/new/3rdParty" }, ["/old/3rdParty"]);
    assert.strictEqual(result.state, "warn");
    assert.ok(result.detail?.includes("(missing)"), result.detail);
  });

  test("the manifest folder alone: ok when it exists, warn when it is missing", () => {
    assert.strictEqual(check("/old/3rdParty", undefined, ["/old/3rdParty"]).state, "ok");
    assert.strictEqual(check("/old/3rdParty", undefined, []).state, "warn");
  });

  test("nothing set is missing: the ~/.o3de/3rdParty fallback alone does not turn the row green", () => {
    assert.strictEqual(check(undefined, undefined, []).state, "missing");
    assert.strictEqual(check(undefined, undefined, [`${HOME}/.o3de/3rdParty`]).state, "missing");
    assert.strictEqual(check(undefined, { LY_3RDPARTY_PATH: "  " }, []).state, "missing", "a blank flag names nothing");
  });
});
