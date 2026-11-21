// ============================================================================
//  IntelliSense health check - what the report says (vscode-free).
//
//  The findings (what is wrong, what to do), the one-line summary and the Markdown
//  document, all worded from a structured report.
// ============================================================================

import * as assert from "assert";
import { FileCheck, HealthReport } from "../intellisense/healthModel";
import { engineHint, formatHealthReport, healthFindings, healthSummaryLine, originsLine } from "../intellisense/healthReport";
import { summarize } from "../intellisense/healthRun";

// ---- Fixtures --------------------------------------------------------------
function check(overrides: Partial<FileCheck> = {}): FileCheck {
  return { file: "D:/work/game/Gem/Source/A.cpp", origin: "project", status: "ok", command: "entry", errorCount: 0, firstErrors: [], seconds: 4.2, ...overrides };
}

function report(overrides: Partial<HealthReport> = {}): HealthReport {
  const files = overrides.files ?? [check()];
  const full: HealthReport = {
    extensionVersion: "1.2.3",
    platform: "win32",
    project: { name: "MyGame", path: "D:/work/game" },
    intellisenseEngine: "clangd",
    clangd: { found: true, path: "C:/clangd/bin/clangd.exe", source: "extension", version: "22.1.6" },
    toolchain: { compiler: "C:/VS/bin/cl.exe", style: "msvc" },
    database: {
      dir: "D:/work/game/build/windows/clangd",
      file: "D:/work/game/build/windows/clangd/compile_commands.json",
      kind: "generated",
      inUse: true,
      exists: true,
      entries: 1759,
      origins: { project: 394, gem: 100, engineFramework: 1265, engineGems: 0, fallback: 0 },
      includeDirs: { checked: 120, missing: 0, inBuildFolder: 0, examples: [] },
    },
    engine: { mode: "redirected", sourceEngine: "o3de-source", coverage: "participating" },
    files,
    summary: summarize(files),
    findings: [],
    ...overrides,
  };
  full.summary = overrides.summary ?? summarize(full.files);
  full.findings = overrides.findings ?? healthFindings(full);
  return full;
}

// ---- Findings --------------------------------------------------------------
suite("healthReport.healthFindings", () => {
  test("a clean sample on a healthy setup says so, and nothing else", () => {
    assert.deepStrictEqual(healthFindings(report()), ["No problems found in the sample: every checked file compiled without errors, using an entry of its own."]);
  });

  test("clangd missing: says to install the extension or set clangd.path", () => {
    const findings = healthFindings(report({ clangd: { found: false, problem: "No clangd was found." }, files: [] }));
    assert.match(findings[0], /No clangd was found\. Install the clangd extension and let it download clangd, or set clangd\.path\./);
  });

  test("errors on a file that has its own entry: the command is missing an include or define", () => {
    const findings = healthFindings(report({ files: [check({ file: "D:/g/Bad.cpp", status: "errors", errorCount: 3, firstErrors: ["line 1 [x] y"] })] }));
    assert.ok(findings.some((finding) => /1 sampled file with an entry of its own still shows compile errors \(Bad\.cpp\)/.test(finding)), findings.join(" | "));
  });

  test("files with no entry: clangd guesses their flags, and how many of them fail", () => {
    const findings = healthFindings(
      report({
        files: [
          check({ file: "D:/g/One.cpp", origin: "noEntry", command: "inferred", status: "errors", errorCount: 9, inferredFrom: "D:/g/Other.cpp" }),
          check({ file: "D:/g/Two.cpp", origin: "noEntry", command: "inferred" }),
        ],
      }),
    );
    const guessed = findings.find((finding) => /no entry in the database/.test(finding)) ?? "";
    assert.match(guessed, /2 sampled sources have no entry in the database, so clangd guesses their flags from another file; 1 of them shows compile errors \(One\.cpp\)/);
  });

  test("a missing include directory says 'configure again' for O3DE's own database and 'regenerate it yourself' for one of the user's", () => {
    const includeDirs = { checked: 10, missing: 2, inBuildFolder: 0, examples: ["D:/gone/a", "D:/gone/b"] };
    const advice = (kind: "generated" | "user" | "clangdArguments"): string =>
      healthFindings(report({ database: { ...report().database, kind, includeDirs } })).find((finding) => /exist on disk/.test(finding)) ?? "";
    assert.match(advice("generated"), /Configure the project again\.$/);
    for (const kind of ["user", "clangdArguments"] as const) {
      assert.match(advice(kind), /This is your own compile database, so O3DE won't regenerate it: regenerate it, or fix those paths in it, yourself\.$/, kind);
      assert.doesNotMatch(advice(kind), /Configure the project again/, kind);
    }
  });

  test("files that couldn't be checked are listed with the reason", () => {
    const findings = healthFindings(report({ files: [check({ file: "D:/g/Slow.cpp", status: "timedOut", note: "clangd didn't finish within 60 s." })] }));
    assert.ok(findings.some((finding) => /1 sampled file could not be checked \(Slow\.cpp\): clangd didn't finish within 60 s\./.test(finding)), findings.join(" | "));
  });

  test("missing include directories are counted with examples, and the remedy is a reconfigure", () => {
    const findings = healthFindings(
      report({ database: { ...report().database, includeDirs: { checked: 50, missing: 8, inBuildFolder: 0, examples: ["D:/gone/a", "D:/gone/b"] } } }),
    );
    const finding = findings.find((candidate) => /include director/.test(candidate)) ?? "";
    assert.match(finding, /8 include directories named in the database don't exist on disk \(D:\/gone\/a, D:\/gone\/b, \.\.\.\)/);
    assert.match(finding, /Configure the project again/);
  });

  test("one missing include directory is worded in the singular", () => {
    const findings = healthFindings(report({ database: { ...report().database, includeDirs: { checked: 5, missing: 1, inBuildFolder: 0, examples: ["D:/gone/a"] } } }));
    assert.ok(findings.some((finding) => /^1 include directory named in the database doesn't exist on disk \(D:\/gone\/a\)/.test(finding)), findings.join(" | "));
  });

  test("include directories a build creates are told apart: the remedy is a build, not a reconfigure", () => {
    const only = healthFindings(
      report({ database: { ...report().database, includeDirs: { checked: 50, missing: 27, inBuildFolder: 27, examples: ["D:/p/build/windows/X_autogen/include"] } } }),
    );
    assert.strictEqual(only.length, 1, only.join(" | "));
    assert.match(only[0], /^27 include directories in the build folder don't exist yet: a build creates them \(Qt's moc and ui headers, for one\)\. Build the project once/);
    assert.ok(!only.some((finding) => /Configure the project again/.test(finding)));

    const mixed = healthFindings(
      report({ database: { ...report().database, includeDirs: { checked: 50, missing: 3, inBuildFolder: 2, examples: ["D:/gone/a", "D:/p/build/windows/X_autogen/include", "D:/p/build/windows/Y_autogen/include"] } } }),
    );
    assert.match(mixed[0], /^1 include directory named in the database doesn't exist on disk \(D:\/gone\/a\): a stale configure.*Configure the project again\./);
    assert.match(mixed[1], /^2 include directories in the build folder don't exist yet: a build creates them/);
  });

  test("no database, per kind: the remedy names the right place", () => {
    const missing = (kind: HealthReport["database"]["kind"]) =>
      healthFindings(report({ database: { ...report().database, kind, exists: false, entries: 0 }, files: [] })).join(" | ");
    assert.match(missing("generated"), /Configure the project/);
    assert.match(missing("user"), /o3de\.intellisense\.compileDatabase/);
    assert.match(missing("clangdArguments"), /--compile-commands-dir in clangd\.arguments/);
  });

  test("a database clangd isn't pointed at, and a C/C++ extension that is running instead", () => {
    const findings = healthFindings(report({ intellisenseEngine: "cpptools", database: { ...report().database, inUse: false } }));
    assert.ok(findings.some((finding) => /doesn't point --compile-commands-dir at this database/.test(finding)));
    assert.ok(findings.some((finding) => /isn't the running C\+\+ IntelliSense engine/.test(finding)));
  });

  test("both engines running still counts as clangd running", () => {
    const findings = healthFindings(report({ intellisenseEngine: "both" }));
    assert.ok(!findings.some((finding) => /isn't the running/.test(finding)));
  });

  test("a partial check says how many files were skipped, and why", () => {
    const skipped = check({ status: "skipped", note: "x" });
    const budget = healthFindings(report({ files: [check(), skipped, skipped], partial: { reason: "timeBudget", skipped: 2 } }));
    assert.ok(budget.some((finding) => /The time budget ran out: 2 files were not checked\. Ask for a smaller sample\./.test(finding)), budget.join(" | "));
    const cancelled = healthFindings(report({ files: [check(), skipped], partial: { reason: "cancelled", skipped: 1 } }));
    assert.ok(cancelled.some((finding) => /The check was cancelled: 1 file was not checked\./.test(finding)), cancelled.join(" | "));
  });

  test("the headersOnly hint is a finding", () => {
    const hint = engineHint("headersOnly", false);
    assert.ok(hint);
    const findings = healthFindings(report({ engine: { mode: "headersOnly", coverage: "participating", hint } }));
    assert.ok(findings.includes(hint ?? "?"));
  });
});

suite("healthReport.engineHint", () => {
  test("only an engine that ships headers has a hint; it says to attach a source engine for engine navigation", () => {
    assert.match(engineHint("headersOnly", false) ?? "", /Attach a source engine for engine navigation/);
    assert.match(engineHint("headersOnly", true) ?? "", /registered on this machine.*Set Up Workspace/);
    for (const mode of ["native", "redirected", "unresolved"] as const) {
      assert.strictEqual(engineHint(mode, true), undefined, mode);
    }
  });
});

// ---- Summary line ----------------------------------------------------------
suite("healthReport.healthSummaryLine", () => {
  test("the verdict on the sample, then the facts behind it", () => {
    const line = healthSummaryLine(
      report({ files: [check(), check({ file: "/b.cpp", status: "errors", errorCount: 2, command: "inferred" }), check({ file: "/c.cpp", status: "timedOut" })] }),
    );
    assert.strictEqual(
      line,
      "IntelliSense health: 1 of 3 sampled files compile cleanly, 1 with errors, 1 not checked (1 had no entry) · clangd 22.1.6 · 1,759 database entries · 0 missing include dirs · engine redirected",
    );
  });

  test("with no files checked it says why", () => {
    assert.match(healthSummaryLine(report({ files: [], clangd: { found: false } })), /no files were checked \(clangd was not found\) · clangd not found/);
    assert.match(healthSummaryLine(report({ files: [] })), /no files were checked \(the compile database has no usable entries\)/);
  });
});

suite("healthReport.originsLine", () => {
  test("lists the origins that have entries, in a fixed order", () => {
    assert.strictEqual(originsLine({ project: 394, gem: 100, engineFramework: 1265, engineGems: 165, fallback: 12 }), "394 project, 100 gem, 1,265 engine Framework, 165 engine gem, 12 fallback gem");
    assert.strictEqual(originsLine({ project: 3, gem: 0, engineFramework: 0, engineGems: 0, fallback: 0 }), "3 project");
    assert.strictEqual(originsLine({ project: 0, gem: 0, engineFramework: 0, engineGems: 0, fallback: 0 }), "none");
  });
});

// ---- Markdown --------------------------------------------------------------
suite("healthReport.formatHealthReport", () => {
  const failing = report({
    files: [
      check(),
      check({
        file: "D:/work/gems/canvas/Code/Source/GraphContext.cpp",
        origin: "noEntry",
        status: "errors",
        command: "inferred",
        inferredFrom: "D:/work/gems/canvas/Code/Source/Module.cpp",
        errorCount: 9,
        firstErrors: ["line 4 [pp_file_not_found] in included file: 'X.h' file not found", "line 19 [undeclared_var_use] use of undeclared identifier 'X'"],
        seconds: 3.5,
      }),
    ],
  });
  const text = formatHealthReport(failing);

  test("it opens with the title, the project, the version and the one-line summary", () => {
    const lines = text.split("\n");
    assert.strictEqual(lines[0], "# O3DE IntelliSense health");
    assert.strictEqual(lines[2], "MyGame - O3DE Development Tools 1.2.3 - win32");
    assert.strictEqual(lines[4], `**${healthSummaryLine(failing)}**`);
  });

  test("the findings come first, then clangd, the database, the engine and the sampled files", () => {
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    assert.deepStrictEqual(headings, ["## Findings", "## clangd", "## Compile database", "## Engine", "## Sampled files (2)"]);
  });

  test("the facts are all there: versions, binary and where it came from, database and its origins, engine", () => {
    for (const expected of [
      "- Version: 22.1.6",
      "- Binary: C:/clangd/bin/clangd.exe (from the clangd extension's download)",
      "- C++ IntelliSense engine running: clangd",
      "- Compiler in the database: C:/VS/bin/cl.exe (MSVC switches)",
      "- File: D:/work/game/build/windows/clangd/compile_commands.json (generated by O3DE)",
      "- clangd.arguments points at it: yes",
      "- Entries: 1,759 (394 project, 100 gem, 1,265 engine Framework)",
      "- Include directories not on disk: 0 of 120",
      "- Mode: redirected (SDK engine, navigation goes to source engine o3de-source)",
      "- Engine coverage setting: participating",
    ]) {
      assert.ok(text.includes(expected), expected);
    }
  });

  test("sampled files are a table: origin, flags (own entry or inferred from), errors, seconds", () => {
    assert.ok(text.includes("| File | Origin | Flags | Errors | Seconds |"));
    assert.ok(text.includes("| D:/work/game/Gem/Source/A.cpp | project | own entry | 0 | 4.2 |"));
    assert.ok(text.includes("| D:/work/gems/canvas/Code/Source/GraphContext.cpp | no entry | inferred from D:/work/gems/canvas/Code/Source/Module.cpp | 9 | 3.5 |"));
  });

  test("a failing file lists its first errors and how many more there are", () => {
    assert.ok(text.includes("**D:/work/gems/canvas/Code/Source/GraphContext.cpp**"));
    assert.ok(text.includes("- line 4 [pp_file_not_found] in included file: 'X.h' file not found"));
    assert.ok(text.includes("- ... and 7 more"));
  });

  test("missing include directories say how many sit in the build folder", () => {
    const built = formatHealthReport(
      report({ database: { ...report().database, includeDirs: { checked: 170, missing: 27, inBuildFolder: 25, examples: ["D:/gone/a"] } } }),
    );
    assert.ok(built.includes("- Include directories not on disk: 27 of 170, 25 of them in the build folder (a build creates them) (D:/gone/a)"));
  });

  test("the registered gems left out are said in the compile database section, and not at all when none were", () => {
    const left = formatHealthReport(report({ database: { ...report().database, skippedManifestGems: 7 } }));
    assert.ok(left.includes("- Gems registered in the O3DE manifest and left out: 7 (the project doesn't enable them and the workspace doesn't contain them)"));
    assert.ok(!formatHealthReport(report()).includes("left out"));
    assert.ok(!formatHealthReport(report({ database: { ...report().database, skippedManifestGems: 0 } })).includes("left out"));
  });

  test("a pipe or a line break in a path or flag can't break the table", () => {
    const odd = formatHealthReport(report({ files: [check({ file: "D:/a|b/c.cpp" })] }));
    assert.ok(odd.includes("| D:/a\\|b/c.cpp |"));
  });

  test("no files, a user's database and no clangd: still a readable document", () => {
    const empty = formatHealthReport(
      report({ files: [], clangd: { found: false, problem: "No clangd was found." }, toolchain: undefined, database: { ...report().database, kind: "user", inUse: false } }),
    );
    assert.ok(empty.includes("No files were checked."));
    assert.ok(empty.includes("- Version: not found"));
    assert.ok(empty.includes("(your own, from o3de.intellisense.compileDatabase)"));
    assert.ok(empty.includes("- clangd.arguments points at it: no"));
    assert.ok(!empty.includes("- Binary:"));
    assert.ok(!empty.includes("- Compiler in the database"));
  });

  test("a note on a file (why it wasn't checked) is shown under it", () => {
    const note = formatHealthReport(
      report({ files: [check({ file: "D:/g/Slow.cpp", status: "timedOut", command: "unknown", note: "clangd didn't finish within 60 s." })] }),
    );
    assert.ok(note.includes("| D:/g/Slow.cpp | project | - | timedOut | 4.2 |"));
    assert.ok(note.includes("- clangd didn't finish within 60 s."));
  });
});
