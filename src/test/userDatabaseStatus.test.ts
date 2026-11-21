// ============================================================================
//  Bring your own compile database - how the status reads it (clangdDatabase.ts):
//  the userProvided state, when clangd needs re-pointing after the setting moves,
//  and the row's label, detail and visibility. The pure half of the status row and
//  of o3de_intellisense_status's clangdDatabase.
// ============================================================================

import * as assert from "assert";
import {
  DatabaseRecord,
  databaseDetail,
  databaseFileNote,
  databaseLabel,
  databaseRowVisible,
  databaseState,
  needsRepoint,
} from "../intellisense/clangdDatabase";
import type { DatabaseSelection } from "../intellisense/userDatabase";

// ---- Fixtures ----------------------------------------------------------------
const GENERATED_DIR = "D:\\proj\\build\\windows\\clangd";
const OWN_DIR = "D:\\work\\shared";
const OWN_FILE = `${OWN_DIR}\\compile_commands.json`;

function record(overrides: Partial<DatabaseRecord> = {}): DatabaseRecord {
  return {
    ok: true,
    at: 1,
    trigger: "switch",
    config: "profile",
    flagsConfig: "profile",
    replyTimestamp: 100,
    dir: GENERATED_DIR,
    file: `${GENERATED_DIR}\\compile_commands.json`,
    entries: 1759,
    engineCoverage: "participating",
    origins: { project: 100, gem: 394, engineFramework: 1265, engineGems: 0, fallback: 0 },
    engineEntries: 1265,
    engineModuleDefines: 1100,
    skippedManifestGems: 0,
    changed: true,
    durationMs: 270,
    ...overrides,
  };
}

const generatedSelection: DatabaseSelection = {
  source: "generated",
  setting: "",
  reason: "O3DE generates clangd's compile database (o3de.intellisense.compileDatabase is empty).",
};

const userSelection: DatabaseSelection = {
  source: "user",
  setting: OWN_FILE,
  dir: OWN_DIR,
  file: OWN_FILE,
  reason: `Your own compile database, ${OWN_FILE}, is selected (o3de.intellisense.compileDatabase). O3DE never writes or overwrites it.`,
};

const missingSelection: DatabaseSelection = {
  source: "generated",
  setting: "nowhere",
  missing: { resolved: "D:\\proj\\nowhere", reason: "notFound" },
  reason: 'o3de.intellisense.compileDatabase is "nowhere", but no compile_commands.json exists at D:\\proj\\nowhere. O3DE generates the database instead.',
};

const hintSelection: DatabaseSelection = {
  source: "generated",
  setting: "",
  hint: "D:\\proj\\compile_commands.json",
  reason:
    "O3DE generates clangd's compile database (o3de.intellisense.compileDatabase is empty). " +
    "A compile database exists at D:\\proj\\compile_commands.json: set o3de.intellisense.compileDatabase to use it.",
};

// ---- State -------------------------------------------------------------------
suite("userDatabase status: databaseState", () => {
  const current = { inUse: true, config: "profile", replyTimestamp: 100 };

  test("clangd reading the user's database is userProvided, whatever the last generation was", () => {
    assert.strictEqual(databaseState({ ...current, userProvided: true, last: undefined }), "userProvided");
    assert.strictEqual(databaseState({ ...current, userProvided: true, last: record() }), "userProvided");
    assert.strictEqual(
      databaseState({ ...current, userProvided: true, last: { ok: false, at: 1, trigger: "configure", reason: "notConfigured" } }),
      "userProvided",
      "a project that was never configured has nothing to generate: the user's database doesn't need it",
    );
  });

  test("selected but clangd isn't reading it: not in use, as for the generated database", () => {
    assert.strictEqual(databaseState({ ...current, inUse: false, userProvided: true, last: undefined }), "notInUse");
  });

  test("not marked user-provided: unchanged", () => {
    assert.strictEqual(databaseState({ ...current, last: record() }), "upToDate");
  });
});

// ---- Re-pointing -------------------------------------------------------------
suite("userDatabase status: needsRepoint", () => {
  const base = { running: "clangd" as const, clangdDir: GENERATED_DIR, targetDir: OWN_DIR, ownDirs: [GENERATED_DIR, undefined] };

  test("clangd on O3DE's generated folder, the user's database now selected: re-point", () => {
    assert.ok(needsRepoint(base, "win32"));
  });

  test("clangd on the folder O3DE last applied (the user's old database), the selection moved on: re-point", () => {
    assert.ok(needsRepoint({ ...base, clangdDir: "D:\\old\\db", targetDir: GENERATED_DIR, ownDirs: [GENERATED_DIR, "D:\\old\\db"] }, "win32"));
    assert.ok(needsRepoint({ ...base, clangdDir: "D:\\old\\db", targetDir: "D:\\new\\db", ownDirs: [GENERATED_DIR, "d:/old/db/"] }, "win32"));
  });

  test("clangd pointed anywhere else is the user's own: never touched", () => {
    assert.ok(!needsRepoint({ ...base, clangdDir: "D:\\my\\own\\db" }, "win32"));
  });

  test("already on the selected folder: nothing to do", () => {
    assert.ok(!needsRepoint({ ...base, clangdDir: "d:/work/shared/" }, "win32"));
    assert.ok(!needsRepoint({ ...base, targetDir: GENERATED_DIR }, "win32"));
  });

  test("clangd not running, or no folder to compare: nothing to do", () => {
    assert.ok(!needsRepoint({ ...base, running: "cpptools" }, "win32"));
    assert.ok(!needsRepoint({ ...base, running: "none" }, "win32"));
    assert.ok(!needsRepoint({ ...base, clangdDir: undefined }, "win32"));
    assert.ok(!needsRepoint({ ...base, targetDir: undefined }, "win32"));
  });
});

suite("userDatabase status: the follow never touches the C/C++ extension", () => {
  const base = { running: "clangd" as const, clangdDir: GENERATED_DIR, targetDir: OWN_DIR, ownDirs: [GENERATED_DIR, undefined] };

  test("with both engines running (C/C++ installed and on) a changed setting is never re-pointed automatically", () => {
    assert.ok(needsRepoint(base, "win32"), "clangd alone: followed");
    assert.ok(!needsRepoint({ ...base, running: "both" }, "win32"), "both: left to the engine picker, the C/C++ extension stays on");
    assert.ok(!needsRepoint({ ...base, running: "both", clangdDir: "D:/old/db", targetDir: GENERATED_DIR, ownDirs: [GENERATED_DIR, "D:/old/db"] }, "win32"));
  });
});

// ---- Labels ------------------------------------------------------------------
suite("userDatabase status: label, detail and row", () => {
  test("the label says it is the user's; the detail names the file and that O3DE never writes it", () => {
    const status = { state: "userProvided" as const, dir: OWN_DIR, selection: userSelection };
    assert.strictEqual(databaseLabel(status), "User-provided");
    const detail = databaseDetail(status);
    assert.ok(detail.includes(OWN_FILE), detail);
    assert.match(detail, /never writes or overwrites it/);
    assert.match(detail, /engine coverage doesn't apply/);
    assert.match(detail, /Clear the setting to go back to the generated database/);
    assert.strictEqual(detail.split(OWN_FILE).length - 1, 1, "the selection's sentence isn't repeated");
  });

  test("selected but not in use yet: the state's sentence, then the selection's", () => {
    const detail = databaseDetail({ state: "notInUse", selection: userSelection });
    assert.match(detail, /^clangd isn't using O3DE's compile database/);
    assert.ok(detail.endsWith(userSelection.reason), detail);
  });

  test("a missing database is said in the detail, in every state it can show", () => {
    for (const state of ["notInUse", "upToDate", "updatePending", "notConfigured"] as const) {
      assert.ok(databaseDetail({ state, selection: missingSelection }).includes(missingSelection.reason), state);
    }
  });

  test("a database found but not chosen is offered as a hint on the row", () => {
    const detail = databaseDetail({ state: "upToDate", last: record(), selection: hintSelection });
    assert.ok(detail.includes("A compile database exists at D:\\proj\\compile_commands.json: set o3de.intellisense.compileDatabase to use it."), detail);
  });

  test("the status command names the generated file, never one for the user's own database", () => {
    assert.strictEqual(databaseFileNote({ state: "upToDate", last: record() }), ` File: ${record().file}`);
    assert.strictEqual(databaseFileNote({ state: "userProvided", last: record(), selection: userSelection }), "", "last is an earlier generation: it says nothing about the user's database");
    assert.strictEqual(databaseFileNote({ state: "upToDate", last: { ok: false, at: 1, trigger: "x", reason: "notConfigured" } }), "");
    assert.strictEqual(databaseFileNote({ state: "notInUse" }), "");
  });

  test("the plain default adds nothing: the detail is the state's own sentence", () => {
    const plain = databaseDetail({ state: "upToDate", last: record() });
    assert.strictEqual(databaseDetail({ state: "upToDate", last: record(), selection: generatedSelection }), plain);
  });

  test("the row shows while clangd uses a database or once the user wrote a setting; otherwise it stays hidden", () => {
    assert.ok(databaseRowVisible({ state: "upToDate", selection: generatedSelection }));
    assert.ok(databaseRowVisible({ state: "userProvided", selection: userSelection }));
    assert.ok(databaseRowVisible({ state: "notInUse", selection: userSelection }));
    assert.ok(databaseRowVisible({ state: "notInUse", selection: missingSelection }));
    assert.ok(!databaseRowVisible({ state: "notInUse", selection: generatedSelection }));
    assert.ok(!databaseRowVisible({ state: "notInUse", selection: hintSelection }), "a hint alone doesn't put a row on everyone's dashboard");
    assert.ok(!databaseRowVisible({ state: "notInUse" }));
  });
});
