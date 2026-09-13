// ============================================================================
//  clangd compile database — "is clangd using O3DE's database" (read from the
//  setting clangd actually uses) and "is it current" (build config + configure).
// ============================================================================

import * as assert from "assert";
import {
  DatabaseRecord,
  clangdUsesDatabase,
  compileCommandsDirOf,
  databaseDetail,
  databaseLabel,
  databaseState,
  sameDirectory,
} from "../intellisense/clangdDatabase";

const DIR = "D:\\OffLocalDev\\gs_play\\build\\windows\\clangd";

function record(overrides: Partial<DatabaseRecord> = {}): DatabaseRecord {
  return {
    ok: true,
    at: 1,
    trigger: "switch",
    config: "profile",
    flagsConfig: "profile",
    replyTimestamp: 100,
    dir: DIR,
    file: `${DIR}\\compile_commands.json`,
    entries: 1759,
    engineEntries: 1265,
    changed: true,
    durationMs: 270,
    ...overrides,
  };
}

// ---- clangd arguments ----------------------------------------------------------
suite("clangdDatabase.compileCommandsDirOf", () => {
  test("reads the attached form O3DE writes", () => {
    assert.strictEqual(compileCommandsDirOf([`--compile-commands-dir=${DIR}`]), DIR);
  });

  test("reads the detached form, among other arguments", () => {
    assert.strictEqual(compileCommandsDirOf(["--background-index", "--compile-commands-dir", DIR, "-j=8"]), DIR);
  });

  test("the last one wins, as in clangd", () => {
    assert.strictEqual(compileCommandsDirOf(["--compile-commands-dir=C:\\old", `--compile-commands-dir=${DIR}`]), DIR);
  });

  test("absent, empty or not an array → undefined", () => {
    assert.strictEqual(compileCommandsDirOf(["--background-index"]), undefined);
    assert.strictEqual(compileCommandsDirOf([]), undefined);
    assert.strictEqual(compileCommandsDirOf(undefined), undefined);
    assert.strictEqual(compileCommandsDirOf("--compile-commands-dir=x"), undefined);
  });
});

suite("clangdDatabase.sameDirectory", () => {
  test("Windows: slashes, drive-letter case and a trailing slash don't matter", () => {
    assert.ok(sameDirectory(DIR, "d:/OffLocalDev/gs_play/build/windows/clangd/", "win32"));
  });

  test("Linux: case matters", () => {
    assert.ok(!sameDirectory("/home/u/build/clangd", "/home/u/Build/clangd", "linux"));
    assert.ok(sameDirectory("/home/u/build/clangd", "/home/u/build/clangd/", "linux"));
  });
});

// ---- Rules ---------------------------------------------------------------------
suite("clangdDatabase.clangdUsesDatabase", () => {
  test("clangd running and pointed at O3DE's database → in use", () => {
    assert.ok(clangdUsesDatabase("clangd", DIR, "d:/OffLocalDev/gs_play/build/windows/clangd", "win32"));
    assert.ok(clangdUsesDatabase("both", DIR, DIR, "win32"));
  });

  test("clangd pointed elsewhere, or at nothing → never touched", () => {
    assert.ok(!clangdUsesDatabase("clangd", "D:\\my\\own\\db", DIR, "win32"));
    assert.ok(!clangdUsesDatabase("clangd", undefined, DIR, "win32"));
  });

  test("clangd not running → not in use, even when pointed at the database", () => {
    assert.ok(!clangdUsesDatabase("cpptools", DIR, DIR, "win32"));
    assert.ok(!clangdUsesDatabase("none", DIR, DIR, "win32"));
  });

  test("no project (no database directory) → not in use", () => {
    assert.ok(!clangdUsesDatabase("clangd", DIR, undefined, "win32"));
  });
});

suite("clangdDatabase.databaseState", () => {
  const current = { inUse: true, config: "profile", replyTimestamp: 100 };

  test("not in use wins over everything", () => {
    assert.strictEqual(databaseState({ ...current, inUse: false, last: record() }), "notInUse");
  });

  test("generated from this config and this configure → up to date", () => {
    assert.strictEqual(databaseState({ ...current, last: record() }), "upToDate");
  });

  test("not generated yet this session → update pending", () => {
    assert.strictEqual(databaseState({ ...current, last: undefined }), "updatePending");
  });

  test("a newer configure → update pending", () => {
    assert.strictEqual(databaseState({ ...current, replyTimestamp: 200, last: record() }), "updatePending");
  });

  test("a different build config → update pending", () => {
    assert.strictEqual(databaseState({ ...current, config: "debug", last: record() }), "updatePending");
  });

  test("an unchanged write (identical content) is still up to date", () => {
    assert.strictEqual(databaseState({ ...current, last: record({ changed: false }) }), "upToDate");
  });

  test("the last attempt couldn't run → its reason", () => {
    assert.strictEqual(databaseState({ ...current, last: { ok: false, at: 1, trigger: "configure", reason: "notConfigured" } }), "notConfigured");
    assert.strictEqual(databaseState({ ...current, last: { ok: false, at: 1, trigger: "startup", reason: "noProject" } }), "noProject");
  });
});

// ---- Labels --------------------------------------------------------------------
suite("clangdDatabase labels", () => {
  test("up to date shows the entry count", () => {
    assert.strictEqual(databaseLabel({ state: "upToDate", last: record() }), "Up to date · 1,759 entries");
  });

  test("the detail names the engine entries when there are any", () => {
    assert.match(databaseDetail({ state: "upToDate", last: record() }), /1,265 engine Framework sources/);
    assert.doesNotMatch(databaseDetail({ state: "upToDate", last: record({ engineEntries: 0 }) }), /engine Framework/);
  });

  test("a configure without the selected config says whose flags stand in (SDK engines ship profile only)", () => {
    const standIn = record({ config: "debug", flagsConfig: "profile" });
    assert.match(databaseDetail({ state: "upToDate", last: standIn }), /uses the profile configuration's flags: the project's configure has no debug configuration/);
    assert.match(databaseDetail({ state: "upToDate", last: record() }), /Flags from the profile configuration\./);
  });

  test("stand-in flags don't make the database look out of date", () => {
    const standIn = record({ config: "debug", flagsConfig: "profile" });
    assert.strictEqual(databaseState({ inUse: true, config: "debug", replyTimestamp: 100, last: standIn }), "upToDate");
  });

  test("every state has a label and a detail", () => {
    for (const state of ["notInUse", "upToDate", "updatePending", "notConfigured", "noProject"] as const) {
      assert.ok(databaseLabel({ state }).length > 0, state);
      assert.ok(databaseDetail({ state }).length > 0, state);
    }
  });
});
