// ============================================================================
//  IntelliSense health check - running it (vscode-free).
//
//  The whole check runs against a real compile database in a temp folder, with a
//  stand-in for clangd that answers with REAL captured `clangd --check` output
//  (clangdCheckFixtures.ts): the sample that gets checked, the concurrency, the
//  time budget, cancelling, and what a missing clangd or database reports.
//  Also the real process runner, against node itself.
// ============================================================================

import * as assert from "assert";
import type { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CHECK_FROM_ENTRY, CHECK_INFERRED_WITH_ERRORS } from "./clangdCheckFixtures";
import { FileCheck, HealthInputs, HealthOptions } from "../intellisense/healthModel";
import { ProcessOptions, ProcessResult, ProcessRunner, createProcessRunner, runHealthCheck, runProcess, summarize } from "../intellisense/healthRun";
import { normalizePath } from "../intellisense/paths";

// ---- A project on disk -----------------------------------------------------
let root: string;

/** A fresh temp folder for each test of the suite this is called in. */
function useTempRoot(): void {
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-healthrun-"));
  });
  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
}

const at = (...parts: string[]): string => normalizePath(path.join(root, ...parts));

/** The six files of the database, one or two per origin. */
function files(): Record<string, string> {
  return {
    projectA: at("project", "Gem", "Source", "A.cpp"),
    projectB: at("project", "Gem", "Source", "B.cpp"),
    gem: at("gems", "mine", "Code", "Source", "C.cpp"),
    framework: at("engine", "Code", "Framework", "AzCore", "AzCore", "X.cpp"),
    engineGem: at("engine", "Gems", "Atom", "RPI", "Code", "Source", "Pass.cpp"),
    fallback: at("gems", "legacy", "Code", "Source", "Old.cpp"),
  };
}

/** Write compile_commands.json for those files (MSVC-style: one include dir that exists, one that doesn't). */
function writeDatabase(): string {
  const dir = path.join(root, "build", "clangd");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, "inc"), { recursive: true });
  const entries = Object.values(files()).map((file) => ({
    directory: at("build"),
    file,
    arguments: ["C:/VS/bin/cl.exe", `/I${at("inc")}`, `/I${at("missing_inc")}`, "/TP", file],
  }));
  fs.writeFileSync(path.join(dir, "compile_commands.json"), JSON.stringify(entries));
  return dir;
}

function inputs(overrides: Partial<HealthInputs> = {}): HealthInputs {
  const known = files();
  return {
    extensionVersion: "9.9.9",
    platform: process.platform,
    project: { name: "Game", path: at("project") },
    intellisenseEngine: "clangd",
    clangd: { path: "/fake/clangd", source: "path" },
    clangdArguments: ["--query-driver=/x/g++"],
    database: { dir: path.join(root, "build", "clangd"), kind: "generated", inUse: true },
    engine: { mode: "redirected", sourceEngineName: "o3de-source", remedyAvailable: false, coverage: "participating" },
    roots: {
      projectRoot: at("project"),
      sourceEngineRoot: at("engine"),
      planFiles: new Set([known.projectA, known.projectB, known.gem].map((file) => file.toLowerCase())),
      participatingGems: [at("engine", "Gems", "Atom", "RPI")],
      fallbackGems: [at("gems", "legacy")],
    },
    scanRoots: [],
    sampleSize: 6,
    includeEntryless: false,
    ...overrides,
  };
}

// ---- A stand-in clangd -----------------------------------------------------
const VERSION_TEXT = "clangd version 22.1.6 (https://github.com/llvm/llvm-project fc4aad7)\nFeatures: windows+grpc\n";
const ok = (text: string): ProcessResult => ({ text, timedOut: false, cancelled: false });

interface FakeClangd {
  run: ProcessRunner;
  calls: { command: string; args: string[] }[];
  maxInFlight: () => number;
}

/** Answers `--version`, and each `--check` with `answer(file)` (real captured output by default). */
function fakeClangd(answer: (file: string, options: ProcessOptions) => ProcessResult | Promise<ProcessResult> = () => ok(CHECK_FROM_ENTRY)): FakeClangd {
  const calls: FakeClangd["calls"] = [];
  let inFlight = 0;
  let peak = 0;
  const run: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args });
    if (args[0] === "--version") {
      return ok(VERSION_TEXT);
    }
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      const file = args.find((arg) => arg.startsWith("--check="))?.slice("--check=".length) ?? "";
      return await answer(file, options);
    } finally {
      inFlight -= 1;
    }
  };
  return { run, calls, maxInFlight: () => peak };
}

// A generous budget by default: with less than one file's own limit (60 s) left, a timeout is the budget's, not the file's.
const options = (extra: Partial<HealthOptions> = {}): HealthOptions => ({ maxTotalMs: 600_000, ...extra });
const base = (file: string): string => path.basename(file);

// ---- The sample is checked -------------------------------------------------
suite("healthRun.runHealthCheck: a project with a database", () => {
  useTempRoot();

  test("six files, one per origin (two project): errors read from real output, entry versus inferred", async () => {
    writeDatabase();
    const clangd = fakeClangd((file) => ok(base(file) === "Old.cpp" ? CHECK_INFERRED_WITH_ERRORS : CHECK_FROM_ENTRY));
    const report = await runHealthCheck(inputs(), options(), { run: clangd.run });

    assert.strictEqual(report.files.length, 6);
    const byName = new Map(report.files.map((file) => [base(file.file), file]));
    assert.deepStrictEqual(
      [...byName.keys()].sort(),
      ["A.cpp", "B.cpp", "C.cpp", "Old.cpp", "Pass.cpp", "X.cpp"],
    );
    assert.strictEqual(byName.get("Old.cpp")?.origin, "fallback");
    assert.strictEqual(byName.get("X.cpp")?.origin, "engineFramework");
    assert.strictEqual(byName.get("Pass.cpp")?.origin, "engineGems");
    assert.strictEqual(byName.get("C.cpp")?.origin, "gem");
    assert.strictEqual(byName.get("A.cpp")?.origin, "project");

    const broken = byName.get("Old.cpp");
    assert.strictEqual(broken?.status, "errors");
    assert.strictEqual(broken?.errorCount, 9);
    assert.strictEqual(broken?.command, "inferred");
    assert.match(broken?.inferredFrom ?? "", /CanvasModule\.cpp$/);
    assert.strictEqual(broken?.firstErrors.length, 3, "the first three, not all nine");
    assert.match(broken?.firstErrors[0] ?? "", /^line 4 \[pp_file_not_found\] /);

    const clean = byName.get("A.cpp");
    assert.strictEqual(clean?.status, "ok");
    assert.strictEqual(clean?.errorCount, 0, "clangd's '1 errors' was only a tweak failing");
    assert.strictEqual(clean?.command, "entry");

    assert.deepStrictEqual(report.summary, { sampled: 6, clean: 5, withErrors: 1, notChecked: 0, withoutEntry: 1 });
    assert.strictEqual(report.partial, undefined);
  });

  test("the report carries the facts: versions, toolchain, database, entries by origin, missing include dirs", async () => {
    writeDatabase();
    const report = await runHealthCheck(inputs(), options(), { run: fakeClangd().run });

    assert.strictEqual(report.extensionVersion, "9.9.9");
    assert.deepStrictEqual(report.clangd, { found: true, path: "/fake/clangd", source: "path", version: "22.1.6" });
    assert.deepStrictEqual(report.toolchain, { compiler: "C:/VS/bin/cl.exe", style: "msvc" });
    assert.strictEqual(report.database.entries, 6);
    assert.deepStrictEqual(report.database.origins, { project: 2, gem: 1, engineFramework: 1, engineGems: 1, fallback: 1 });
    assert.strictEqual(report.database.exists, true);
    assert.strictEqual(report.database.inUse, true);
    assert.strictEqual(report.database.kind, "generated");
    assert.ok(report.database.file.endsWith("compile_commands.json"));
    assert.deepStrictEqual(report.database.includeDirs, { checked: 2, missing: 1, inBuildFolder: 0, examples: [at("missing_inc")] });
    assert.deepStrictEqual(report.engine, { mode: "redirected", sourceEngine: "o3de-source", coverage: "participating", hint: undefined });
    assert.ok(report.findings.some((finding) => /include director/.test(finding)), report.findings.join(" | "));
  });

  test("a missing include dir inside the build folder is counted apart, and listed after the ones a build won't fix", async () => {
    const dir = path.join(root, "build", "clangd");
    fs.mkdirSync(dir, { recursive: true });
    const file = at("project", "Gem", "Source", "A.cpp");
    const arguments_ = ["C:/VS/bin/cl.exe", `/I${at("build", "windows", "Gem_autogen", "include")}`, `/I${at("moved_engine", "Include")}`, "/TP", file];
    fs.writeFileSync(path.join(dir, "compile_commands.json"), JSON.stringify([{ directory: at("build"), file, arguments: arguments_ }]));
    const report = await runHealthCheck(inputs({ buildDir: at("build") }), options(), { run: fakeClangd().run });
    assert.deepStrictEqual(report.database.includeDirs, {
      checked: 2,
      missing: 2,
      inBuildFolder: 1,
      examples: [at("moved_engine", "Include"), at("build", "windows", "Gem_autogen", "include")],
    });
    assert.ok(report.findings.some((finding) => /^1 include directory in the build folder doesn't exist yet/.test(finding)), report.findings.join(" | "));
    assert.ok(report.findings.some((finding) => /^1 include directory named in the database doesn't exist on disk/.test(finding)), report.findings.join(" | "));
  });

  test("each check is `clangd --check` with the database folder and no index; the user's --query-driver rides along", async () => {
    writeDatabase();
    const clangd = fakeClangd();
    await runHealthCheck(inputs(), options(), { run: clangd.run });

    assert.deepStrictEqual(clangd.calls[0], { command: "/fake/clangd", args: ["--version"] });
    const checks = clangd.calls.slice(1);
    assert.strictEqual(checks.length, 6);
    for (const { args } of checks) {
      assert.ok(args[0].startsWith("--check="), args[0]);
      assert.ok(args.includes(`--compile-commands-dir=${path.join(root, "build", "clangd")}`));
      assert.ok(args.includes("--background-index=false"));
      assert.ok(args.includes("--query-driver=/x/g++"));
      assert.ok(!args.some((arg) => /--background-index(=true)?$/.test(arg)), "never builds an index");
    }
    const checked = checks.map(({ args }) => args[0].slice("--check=".length)).sort();
    assert.deepStrictEqual(checked, Object.values(files()).map((file) => path.normalize(file)).sort());
  });

  test("at most two clangd run at once", async () => {
    writeDatabase();
    const clangd = fakeClangd();
    await runHealthCheck(inputs(), options(), { run: clangd.run });
    assert.strictEqual(clangd.maxInFlight(), 2);
  });

  test("progress counts up from 0 to the sample size", async () => {
    writeDatabase();
    const seen: string[] = [];
    await runHealthCheck(inputs(), options({ onProgress: (checked, total) => seen.push(`${checked}/${total}`) }), { run: fakeClangd().run });
    assert.deepStrictEqual(seen, ["0/6", "1/6", "2/6", "3/6", "4/6", "5/6", "6/6"]);
  });

  test("a smaller sample asks clangd about fewer files", async () => {
    writeDatabase();
    const clangd = fakeClangd();
    const report = await runHealthCheck(inputs({ sampleSize: 3 }), options(), { run: clangd.run });
    assert.strictEqual(report.files.length, 3);
    assert.strictEqual(clangd.calls.length, 4, "--version and three checks");
  });

  test("the same database and size check the same files, in the same order", async () => {
    writeDatabase();
    const first = await runHealthCheck(inputs({ sampleSize: 4 }), options(), { run: fakeClangd().run });
    const second = await runHealthCheck(inputs({ sampleSize: 4 }), options(), { run: fakeClangd().run });
    assert.deepStrictEqual(
      second.files.map((file) => file.file),
      first.files.map((file) => file.file),
    );
  });
});

// ---- Sources with no entry -------------------------------------------------
suite("healthRun.runHealthCheck: sources with no entry", () => {
  useTempRoot();

  function writeSources(): void {
    for (const rel of [["project", "Gem", "Source", "A.cpp"], ["project", "Gem", "Source", "B.cpp"], ["project", "Gem", "Source", "Extra.cpp"]]) {
      fs.mkdirSync(path.join(root, ...rel.slice(0, -1)), { recursive: true });
      fs.writeFileSync(path.join(root, ...rel), "");
    }
  }

  test("includeEntryless adds a source the database doesn't list, marked noEntry", async () => {
    writeDatabase();
    writeSources();
    const clangd = fakeClangd((file) => ok(base(file) === "Extra.cpp" ? CHECK_INFERRED_WITH_ERRORS : CHECK_FROM_ENTRY));
    const report = await runHealthCheck(
      inputs({ includeEntryless: true, scanRoots: [{ dir: at("project"), group: "own" }] }),
      options(),
      { run: clangd.run },
    );
    assert.strictEqual(report.files.length, 7);
    const extra = report.files.find((file) => file.origin === "noEntry");
    assert.strictEqual(base(extra?.file ?? ""), "Extra.cpp");
    assert.strictEqual(extra?.command, "inferred");
    assert.strictEqual(extra?.errorCount, 9);
    assert.strictEqual(report.summary.withoutEntry, 1);
    assert.ok(report.findings.some((finding) => /no entry in the database/.test(finding)), report.findings.join(" | "));
  });

  test("includeEntryless off: only database entries are checked", async () => {
    writeDatabase();
    writeSources();
    const report = await runHealthCheck(inputs({ includeEntryless: false, scanRoots: [{ dir: at("project"), group: "own" }] }), options(), { run: fakeClangd().run });
    assert.strictEqual(report.files.length, 6);
    assert.ok(!report.files.some((file) => file.origin === "noEntry"));
  });

  test("a database that lists everything has no entryless source to add", async () => {
    writeDatabase();
    fs.mkdirSync(path.join(root, "project", "Gem", "Source"), { recursive: true });
    fs.writeFileSync(path.join(root, "project", "Gem", "Source", "A.cpp"), "");
    const report = await runHealthCheck(inputs({ includeEntryless: true, scanRoots: [{ dir: at("project"), group: "own" }] }), options(), { run: fakeClangd().run });
    assert.strictEqual(report.files.length, 6);
  });
});

// ---- Bounded and cancellable -----------------------------------------------
suite("healthRun.runHealthCheck: the time budget and cancelling", () => {
  useTempRoot();

  test("a budget too small to start any file skips them all and says so", async () => {
    writeDatabase();
    const clangd = fakeClangd();
    const report = await runHealthCheck(inputs(), options({ maxTotalMs: 1_000 }), { run: clangd.run });
    assert.strictEqual(report.files.length, 6);
    assert.ok(report.files.every((file) => file.status === "skipped"));
    assert.deepStrictEqual(report.partial, { reason: "timeBudget", skipped: 6 });
    assert.strictEqual(report.summary.notChecked, 6);
    assert.deepStrictEqual(clangd.calls.map((call) => call.args[0]), ["--version"], "no file was run");
    assert.ok(report.findings.some((finding) => /time budget ran out/.test(finding)), report.findings.join(" | "));
  });

  test("a check cancelled before it starts runs nothing", async () => {
    writeDatabase();
    const controller = new AbortController();
    controller.abort();
    const clangd = fakeClangd();
    const report = await runHealthCheck(inputs(), options({ signal: controller.signal }), { run: clangd.run });
    assert.deepStrictEqual(report.partial, { reason: "cancelled", skipped: 6 });
    assert.strictEqual(clangd.calls.filter((call) => call.args[0].startsWith("--check")).length, 0);
  });

  test("a check cancelled while clangd runs stops the rest", async () => {
    writeDatabase();
    const controller = new AbortController();
    const clangd = fakeClangd(() => {
      controller.abort();
      return { text: "", timedOut: false, cancelled: true };
    });
    const report = await runHealthCheck(inputs(), options({ signal: controller.signal }), { run: clangd.run });
    assert.strictEqual(report.partial?.reason, "cancelled");
    assert.ok(report.files.every((file) => file.status === "skipped"));
    assert.ok(clangd.calls.length <= 3, "the two in flight, never the other four");
    assert.ok(report.findings.some((finding) => /was cancelled/.test(finding)), report.findings.join(" | "));
  });

  test("files killed because the total budget ran out are skipped for the budget, not blamed on clangd", async () => {
    writeDatabase();
    const clangd = fakeClangd(() => ({ text: "", timedOut: true, cancelled: false })); // every check runs into the (10 s) budget's end
    const report = await runHealthCheck(inputs(), options({ maxTotalMs: 10_000 }), { run: clangd.run });
    assert.strictEqual(report.files.length, 6);
    for (const file of report.files) {
      assert.strictEqual(file.status, "skipped", file.file);
      assert.match(file.note ?? "", /while this file was being checked/);
    }
    assert.deepStrictEqual(report.partial, { reason: "timeBudget", skipped: 6 });
    assert.strictEqual(report.summary.notChecked, 6);
    assert.ok(report.findings.some((finding) => /time budget ran out/.test(finding)), report.findings.join(" | "));
    assert.ok(!report.findings.some((finding) => /clangd didn't finish/.test(finding)), "not reported as a clangd timeout");
  });

  test("a file that times out within its own limit, with budget to spare, is still a clangd timeout", async () => {
    writeDatabase();
    const clangd = fakeClangd((file) => ({ text: base(file) === "Old.cpp" ? "" : CHECK_FROM_ENTRY, timedOut: base(file) === "Old.cpp", cancelled: false }));
    const report = await runHealthCheck(inputs(), options(), { run: clangd.run });
    const old = report.files.find((file) => base(file.file) === "Old.cpp");
    assert.strictEqual(old?.status, "timedOut");
    assert.strictEqual(report.partial, undefined);
  });

  test("a file that times out, one that cannot start and one that stops early are each reported, and the rest still checked", async () => {
    writeDatabase();
    const clangd = fakeClangd((file) => {
      switch (base(file)) {
        case "Old.cpp":
          return { text: "", timedOut: true, cancelled: false };
        case "B.cpp":
          return { text: "", timedOut: false, cancelled: false, failed: "spawn clangd ENOENT" };
        case "Pass.cpp":
          return ok("I[00:00:00.001] clangd version 22.1.6\nE[00:00:00.200] Failed to read the compile database");
        default:
          return ok(CHECK_FROM_ENTRY);
      }
    });
    const report = await runHealthCheck(inputs(), options(), { run: clangd.run });
    const byName = new Map(report.files.map((file) => [base(file.file), file]));
    assert.strictEqual(byName.get("Old.cpp")?.status, "timedOut");
    assert.match(byName.get("Old.cpp")?.note ?? "", /didn't finish within/);
    assert.strictEqual(byName.get("B.cpp")?.status, "failed");
    assert.match(byName.get("B.cpp")?.note ?? "", /ENOENT/);
    assert.strictEqual(byName.get("Pass.cpp")?.status, "failed");
    assert.match(byName.get("Pass.cpp")?.note ?? "", /stopped before finishing: Failed to read the compile database/);
    assert.strictEqual(byName.get("A.cpp")?.status, "ok");
    assert.deepStrictEqual(report.summary, { sampled: 6, clean: 3, withErrors: 0, notChecked: 3, withoutEntry: 0 });
    assert.strictEqual(report.partial, undefined, "not a budget or cancel problem");
    assert.ok(report.findings.some((finding) => /could not be checked/.test(finding)), report.findings.join(" | "));
  });
});

// ---- What a broken setup reports -------------------------------------------
suite("healthRun.runHealthCheck: clangd or the database missing", () => {
  useTempRoot();

  test("no clangd found: the database is still read, nothing is run, and the finding says what to do", async () => {
    writeDatabase();
    const clangd = fakeClangd();
    const report = await runHealthCheck(inputs({ clangd: undefined }), options(), { run: clangd.run });
    assert.strictEqual(report.clangd.found, false);
    assert.deepStrictEqual(report.files, []);
    assert.strictEqual(report.database.entries, 6, "the database is still counted");
    assert.strictEqual(report.database.includeDirs.missing, 1);
    assert.strictEqual(clangd.calls.length, 0);
    assert.ok(report.findings.some((finding) => /clangd was not found|No clangd was found/i.test(finding) && /clangd\.path/.test(finding)), report.findings.join(" | "));
  });

  test("a clangd that is found but won't start is said so", async () => {
    writeDatabase();
    const report = await runHealthCheck(inputs(), options(), { run: async () => ok("") });
    assert.strictEqual(report.clangd.found, false);
    assert.strictEqual(report.clangd.path, "/fake/clangd");
    assert.match(report.clangd.problem ?? "", /didn't start/);
    assert.deepStrictEqual(report.files, []);
  });

  test("a clangd that fails to start says why in its problem text", async () => {
    writeDatabase();
    const report = await runHealthCheck(inputs(), options(), { run: async () => ({ text: "", timedOut: false, cancelled: false, failed: "spawn EINVAL" }) });
    assert.strictEqual(report.clangd.found, false);
    assert.match(report.clangd.problem ?? "", /didn't start: spawn EINVAL\./);
    assert.ok(report.findings.some((finding) => /spawn EINVAL/.test(finding)), report.findings.join(" | "));
  });

  test("no database: reported with what to do, and no file is run", async () => {
    const clangd = fakeClangd();
    const report = await runHealthCheck(inputs(), options(), { run: clangd.run });
    assert.strictEqual(report.database.exists, false);
    assert.strictEqual(report.database.entries, 0);
    assert.deepStrictEqual(report.files, []);
    assert.ok(report.findings.some((finding) => /There is no compile database at .*Configure the project/.test(finding)), report.findings.join(" | "));
    assert.ok(!clangd.calls.some((call) => call.args[0].startsWith("--check")));
  });

  test("a database of the user's own that is missing points at the setting", async () => {
    const report = await runHealthCheck(inputs({ database: { dir: path.join(root, "mine"), kind: "user", inUse: true } }), options(), { run: fakeClangd().run });
    assert.ok(report.findings.some((finding) => /o3de\.intellisense\.compileDatabase/.test(finding)), report.findings.join(" | "));
  });

  test("a database that isn't valid JSON: its problem is reported", async () => {
    const dir = path.join(root, "build", "clangd");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "compile_commands.json"), "{ nope");
    const report = await runHealthCheck(inputs(), options(), { run: fakeClangd().run });
    assert.strictEqual(report.database.exists, true);
    assert.match(report.database.problem ?? "", /isn't valid JSON/);
    assert.deepStrictEqual(report.files, []);
  });

  test("an empty database has no entries to check", async () => {
    const dir = path.join(root, "build", "clangd");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "compile_commands.json"), "[]");
    const report = await runHealthCheck(inputs(), options(), { run: fakeClangd().run });
    assert.deepStrictEqual(report.files, []);
    assert.ok(report.findings.some((finding) => /has no entries/.test(finding)), report.findings.join(" | "));
  });

  test("clangd not pointed at the database, and the C/C++ extension running, are both said", async () => {
    writeDatabase();
    const report = await runHealthCheck(
      inputs({ intellisenseEngine: "cpptools", database: { dir: path.join(root, "build", "clangd"), kind: "generated", inUse: false } }),
      options(),
      { run: fakeClangd().run },
    );
    assert.ok(report.findings.some((finding) => /doesn't point --compile-commands-dir at this database/.test(finding)));
    assert.ok(report.findings.some((finding) => /isn't the running C\+\+ IntelliSense engine/.test(finding)));
    assert.strictEqual(report.files.length, 6, "the database is checked anyway: it shows what clangd would do");
  });

  test("a headersOnly engine carries the hint to attach a source engine", async () => {
    writeDatabase();
    const report = await runHealthCheck(
      inputs({ engine: { mode: "headersOnly", remedyAvailable: false, coverage: "participating" } }),
      options(),
      { run: fakeClangd().run },
    );
    assert.match(report.engine.hint ?? "", /Attach a source engine for engine navigation/);
    assert.ok(report.findings.includes(report.engine.hint ?? "?"));
  });

  test("a healthy sample says so", async () => {
    const dir = path.join(root, "build", "clangd");
    fs.mkdirSync(dir, { recursive: true });
    const file = at("project", "Gem", "Source", "A.cpp");
    fs.writeFileSync(path.join(dir, "compile_commands.json"), JSON.stringify([{ directory: at("build"), file, arguments: ["c++", "-x", "c++", file] }]));
    const report = await runHealthCheck(inputs(), options(), { run: fakeClangd().run });
    assert.deepStrictEqual(report.summary, { sampled: 1, clean: 1, withErrors: 0, notChecked: 0, withoutEntry: 0 });
    assert.match(report.findings[0], /No problems found/);
  });
});

suite("healthRun.summarize", () => {
  test("clean, with errors, not checked and without an entry are counted apart", () => {
    const summary = summarize([
      makeCheck("ok", "entry"),
      makeCheck("errors", "inferred"),
      makeCheck("errors", "entry"),
      makeCheck("timedOut", "unknown"),
      makeCheck("skipped", "unknown"),
    ]);
    assert.deepStrictEqual(summary, { sampled: 5, clean: 1, withErrors: 2, notChecked: 2, withoutEntry: 1 });
  });
});

function makeCheck(status: FileCheck["status"], command: FileCheck["command"]): FileCheck {
  return { file: "/f.cpp", origin: "project", status, command, errorCount: status === "errors" ? 1 : 0, firstErrors: [], seconds: 0 };
}

// ---- Include dirs a build makes ---------------------------------------------
suite("healthRun.runHealthCheck: which missing include dirs a build would create", () => {
  useTempRoot();

  /** A database of the user's own, its entry recorded with working directory `directory`, naming `includes` (all missing). */
  function writeUserDatabase(directory: string, includes: string[]): string {
    const dir = path.join(root, "shared");
    fs.mkdirSync(dir, { recursive: true });
    const file = at("project", "Gem", "Source", "A.cpp");
    const entry = { directory, file, arguments: ["C:/VS/bin/cl.exe", ...includes.map((include) => `/I${include}`), "/TP", file] };
    fs.writeFileSync(path.join(dir, "compile_commands.json"), JSON.stringify([entry]));
    return dir;
  }

  test("a user's database whose entries record another build tree: its generated include dirs count as in the build folder", async () => {
    const build = at("out", "build", "x64-debug");
    const dir = writeUserDatabase(build, [at("out", "build", "x64-debug", "Gem_autogen", "include")]);
    const report = await runHealthCheck(inputs({ database: { dir, kind: "user", inUse: true } }), options(), { run: fakeClangd().run });
    assert.strictEqual(report.database.includeDirs.missing, 1);
    assert.strictEqual(report.database.includeDirs.inBuildFolder, 1, "the entry's own directory is where its build wrote its headers");
    assert.ok(report.findings.some((finding) => /in the build folder doesn't exist yet/.test(finding)), report.findings.join(" | "));
  });

  test("a database whose entries record the source folder: a missing source include stays in 'other'", async () => {
    const dir = writeUserDatabase(at("project", "Gem", "Source"), [at("project", "Gem", "Include")]);
    const report = await runHealthCheck(inputs({ database: { dir, kind: "user", inUse: true } }), options(), { run: fakeClangd().run });
    assert.strictEqual(report.database.includeDirs.missing, 1);
    assert.strictEqual(report.database.includeDirs.inBuildFolder, 0, "an entry's directory above its own source is no build tree");
  });

  test("a database folder inside a CMake build tree (CMakeCache.txt above it): include dirs in that tree are built ones", async () => {
    const build = path.join(root, "cmake-build");
    fs.mkdirSync(path.join(build, "clangd"), { recursive: true });
    fs.writeFileSync(path.join(build, "CMakeCache.txt"), "");
    const file = at("project", "Gem", "Source", "A.cpp");
    const entry = { directory: at("project"), file, arguments: ["C:/VS/bin/cl.exe", `/I${path.join(build, "gen", "include")}`, "/TP", file] };
    fs.writeFileSync(path.join(build, "clangd", "compile_commands.json"), JSON.stringify([entry]));
    const report = await runHealthCheck(inputs({ database: { dir: path.join(build, "clangd"), kind: "user", inUse: true } }), options(), { run: fakeClangd().run });
    assert.strictEqual(report.database.includeDirs.inBuildFolder, 1);
  });

  test("the 'configure again' advice is for O3DE's own database; a user's own is told it won't be regenerated", async () => {
    const mine = writeUserDatabase(at("project", "Gem", "Source"), [at("moved_engine", "Include")]);
    const own = await runHealthCheck(inputs({ database: { dir: mine, kind: "user", inUse: true } }), options(), { run: fakeClangd().run });
    const ownAdvice = own.findings.find((finding) => /exist on disk/.test(finding)) ?? "";
    assert.match(ownAdvice, /your own compile database, so O3DE won't regenerate it/);
    assert.doesNotMatch(ownAdvice, /Configure the project again/);

    writeDatabase();
    const generated = await runHealthCheck(inputs(), options(), { run: fakeClangd().run });
    assert.match(generated.findings.find((finding) => /exist on disk/.test(finding)) ?? "", /Configure the project again\./);
  });

  test("the registered gems left out of a generated database are carried into the report", async () => {
    writeDatabase();
    const report = await runHealthCheck(inputs({ roots: { ...inputs().roots, skippedManifestGems: 3 } }), options(), { run: fakeClangd().run });
    assert.strictEqual(report.database.skippedManifestGems, 3);
  });
});

// ---- The real process runner -----------------------------------------------
suite("healthRun.runProcess: a real process", () => {
  const node = process.execPath;

  test("output is captured from stderr, and an exit code of 1 is an ordinary result", async function () {
    this.timeout(15_000);
    const result = await runProcess(node, ["-e", "process.stderr.write('E[00:00:00.000] [x] Line 1: boom\\n'); process.stdout.write('out'); process.exit(1)"], { timeoutMs: 10_000 });
    assert.match(result.text, /E\[00:00:00\.000\] \[x\] Line 1: boom/);
    assert.match(result.text, /out/);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.cancelled, false);
    assert.strictEqual(result.failed, undefined);
  });

  test("a process that runs too long is killed and reported as timed out", async function () {
    this.timeout(15_000);
    const started = Date.now();
    const result = await runProcess(node, ["-e", "setTimeout(() => {}, 20000)"], { timeoutMs: 500 });
    assert.strictEqual(result.timedOut, true);
    assert.ok(Date.now() - started < 10_000, "killed, not waited for");
  });

  test("a process that can't be started is reported, not thrown", async function () {
    this.timeout(15_000);
    const result = await runProcess(path.join(os.tmpdir(), "no-such-clangd-here"), ["--version"], { timeoutMs: 5_000 });
    assert.ok(result.failed, "failed is set");
    assert.strictEqual(result.timedOut, false);
  });

  test("a start that throws at once (Windows refuses a .cmd/.bat) is the failed outcome, never a rejection", async () => {
    const throwing = (() => {
      throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
    }) as unknown as typeof execFile;
    for (const command of ["clangd", "C:/tools/clangd.cmd", "C:/tools/clangd.BAT"]) {
      const result = await createProcessRunner(throwing, "win32")(command, ["--version"], { timeoutMs: 5_000 });
      assert.match(result.failed ?? "", /spawn EINVAL/, command);
      assert.strictEqual(result.timedOut, false);
      assert.strictEqual(result.cancelled, false);
      assert.strictEqual(result.text, "");
    }
  });

  test("a .cmd/.bat that can't be started says to point clangd.path at clangd.exe; another failure doesn't", async () => {
    const throwing = (() => {
      throw new Error("spawn EINVAL");
    }) as unknown as typeof execFile;
    const wrapper = await createProcessRunner(throwing, "win32")("C:/tools/clangd.cmd", [], { timeoutMs: 5_000 });
    assert.match(wrapper.failed ?? "", /a \.cmd\/\.bat wrapper can't be started directly; point clangd\.path at clangd\.exe/);
    const exe = await createProcessRunner(throwing, "win32")("C:/tools/clangd.exe", [], { timeoutMs: 5_000 });
    assert.strictEqual(exe.failed, "spawn EINVAL");
    const onLinux = await createProcessRunner(throwing, "linux")("/opt/clangd.cmd", [], { timeoutMs: 5_000 });
    assert.strictEqual(onLinux.failed, "spawn EINVAL", "the hint is for Windows only");
  });

  test("a throw that is not an Error still becomes a failed outcome", async () => {
    const throwing = (() => {
      throw "boom";
    }) as unknown as typeof execFile;
    assert.strictEqual((await createProcessRunner(throwing, "linux")("x", [], { timeoutMs: 5_000 })).failed, "boom");
  });

  test("a real .cmd on Windows resolves, whichever way this Node treats it: it runs, or it fails with the hint", async function () {
    if (process.platform !== "win32") {
      this.skip();
    }
    this.timeout(15_000);
    const wrapper = path.join(os.tmpdir(), `o3de-health-wrapper-${process.pid}.cmd`);
    fs.writeFileSync(wrapper, "@echo off\r\necho clangd version 1.2.3\r\n");
    try {
      const result = await runProcess(wrapper, ["--version"], { timeoutMs: 10_000 });
      const explained = result.failed !== undefined && /a \.cmd\/\.bat wrapper can't be started directly/.test(result.failed);
      assert.ok(explained || /clangd version 1\.2\.3/.test(result.text), JSON.stringify(result));
    } finally {
      fs.rmSync(wrapper, { force: true });
    }
  });

  test("aborting the signal kills the process and reports it cancelled", async function () {
    this.timeout(15_000);
    const controller = new AbortController();
    const pending = runProcess(node, ["-e", "setTimeout(() => {}, 20000)"], { timeoutMs: 15_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.timedOut, false);
  });
});
