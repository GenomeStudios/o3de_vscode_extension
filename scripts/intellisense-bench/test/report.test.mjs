import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildReport,
  cameBack,
  fmtBytes,
  fmtDuration,
  fmtPct,
  indexWarnings,
  percent,
  renderMarkdown,
  summariseCapabilities,
  summariseCheck,
  summariseCoverage,
  summariseEntryless,
  summariseNavComparison,
  summariseProbes,
  summariseRelationships,
  summariseSymbols,
  writeReport,
} from "../lib/report.mjs";

const parts = ["projectGem", "project", "workspaceGems"];

// ============================================================================
//  builders for synthetic stage results
// ============================================================================

const probe = (id, part, category, status, extra = {}) => ({
  id,
  part,
  category,
  file: `D:/x/${id}.cpp`,
  expectedBuilt: true,
  expectedSuffix: "a/b.cpp",
  kind: "definition",
  needsIndex: false,
  status,
  reason: status === "pass" ? "" : status === "skipped" ? "skipped: index incomplete" : "landed in a different file",
  via: status === "pass" ? "definition" : "",
  line: 3,
  lineText: "call();",
  targets: [{ path: "D:/other/h.h", line: 7, text: "void call();" }],
  diagnostics: { errors: 0, warnings: 0, messages: [], timedOut: false },
  ms: 5,
  ...extra,
});

const checkFile = (file, part, status, extra = {}) => ({
  file,
  part,
  status,
  clean: status === "ok" || status === "ok-slow",
  inDb: true,
  inAllDbs: true,
  ms: 1,
  exitCode: 0,
  errorCount: status === "errors" ? 1 : 0,
  diagnostics: status === "errors" ? [{ code: "pp_file_not_found", line: 1, message: "'x.h' file not found" }] : [],
  tweakFailures: 0,
  unexplainedErrors: 0,
  otherErrors: [],
  ...extra,
});

// ============================================================================
//  summaries
// ============================================================================

test("percent: null instead of NaN when there is nothing to divide by", () => {
  assert.equal(percent(1, 4), 25);
  assert.equal(percent(0, 0), null);
});

test("summariseProbes: pass rate per part and category; not-built probes reported apart", () => {
  const results = [
    probe("a", "workspaceGems", "gem->engine .cpp", "pass"),
    probe("b", "workspaceGems", "gem->engine .cpp", "fail"),
    probe("c", "workspaceGems", "gem->gem", "pass"),
    probe("d", "project", "project->engine", "error", { reason: "anchor not found" }),
    probe("e", "workspaceGems", "gem->engine .cpp", "fail", { expectedBuilt: false }),
    probe("f", "workspaceGems", "gem->gem", "pass", { expectedBuilt: false }),
  ];
  const s = summariseProbes(results, parts);

  assert.deepEqual(s.built, { total: 4, pass: 2, fail: 1, error: 1, skipped: 0, pct: 50 });
  assert.deepEqual(s.parts.map((p) => [p.part, p.pass, p.total]), [
    ["projectGem", 0, 0],
    ["project", 0, 1],
    ["workspaceGems", 2, 3],
  ]);
  assert.equal(s.parts[0].pct, null);
  assert.deepEqual(s.categories.map((c) => [c.category, c.pass, c.total]), [
    ["gem->engine .cpp", 1, 2],
    ["gem->gem", 1, 1],
    ["project->engine", 0, 1],
  ]);
  assert.deepEqual(s.failures.map((p) => p.id), ["b", "d"]);
  assert.equal(s.notBuilt.total, 2);
  assert.equal(s.notBuilt.pass, 1);
});

test("summariseProbes: a probe in the 'other' part gets its own row", () => {
  const s = summariseProbes([probe("z", "other", "misc", "pass")], parts);
  assert.equal(s.parts.at(-1).part, "other");
});

test("summariseProbes: skipped probes stay out of the headline, the parts and the failures; the split has a rate each", () => {
  const results = [
    probe("same-file", "workspaceGems", "same-file", "pass"),
    probe("header", "workspaceGems", "header", "fail"),
    probe("cpp-ok", "workspaceGems", "gem->engine .cpp", "pass", { needsIndex: true }),
    probe("cpp-skipped-1", "workspaceGems", "gem->engine .cpp", "skipped", { needsIndex: true }),
    probe("cpp-skipped-2", "project", "gem->gem", "skipped", { needsIndex: true }),
    probe("unbuilt-skipped", "workspaceGems", "unbuilt gem", "skipped", { needsIndex: true, expectedBuilt: false }),
  ];
  const s = summariseProbes(results, parts);

  // headline: only the three built probes that ran
  assert.deepEqual(s.built, { total: 3, pass: 2, fail: 1, error: 0, skipped: 2, pct: (100 * 2) / 3 });
  assert.deepEqual(s.independent, { total: 2, pass: 1, pct: 50 });
  assert.deepEqual(s.needsIndex, { total: 3, ran: 1, skipped: 2, pass: 1, pct: 100 });
  assert.deepEqual(s.failures.map((p) => p.id), ["header"], "a skipped probe is not a failure");
  assert.deepEqual(s.parts.map((p) => [p.part, p.pass, p.total, p.skipped]), [
    ["projectGem", 0, 0, 0],
    ["project", 0, 0, 1],
    ["workspaceGems", 2, 3, 1],
  ]);
  assert.equal(s.parts[1].pct, null, "a part with nothing run has no rate");
  assert.deepEqual(s.notBuilt, { total: 1, pass: 0, skipped: 1, results: [results[5]] });
});

test("summariseSymbols: skipped queries are counted apart and are not failures", () => {
  const symbol = (query, status) => ({ query, expectedSuffix: "a.h", status, reason: status === "skipped" ? "skipped: index incomplete" : "", resultCount: 0, top: [], ms: 1 });
  const none = summariseSymbols([symbol("a", "skipped"), symbol("b", "skipped")]);
  assert.deepEqual([none.total, none.pass, none.skipped, none.pct, none.failures.length], [0, 0, 2, null, 0]);

  const some = summariseSymbols([symbol("a", "pass"), symbol("b", "fail"), symbol("c", "skipped")]);
  assert.deepEqual([some.total, some.pass, some.skipped, some.pct, some.failures.length], [2, 1, 1, 50, 1]);
});

test("summariseNavComparison: refuses to compare unless every variant's index finished", () => {
  const variant = (name, indexComplete) => ({ name, nav: indexComplete === null ? null : { indexComplete } });
  assert.equal(summariseNavComparison([variant("A", false)]), null, "one variant: nothing to compare");
  assert.equal(summariseNavComparison([variant("A", false), variant("B", null)]), null, "a variant without a nav result is not compared");
  assert.deepEqual(summariseNavComparison([variant("A", true), variant("B", true)]), { variants: ["A", "B"], comparable: true, incomplete: [] });
  assert.deepEqual(summariseNavComparison([variant("A", true), variant("B", false), variant("C", false)]), { variants: ["A", "B", "C"], comparable: false, incomplete: ["B", "C"] });
});

test("summariseCheck: % clean per part, status counts, top messages", () => {
  const files = [
    checkFile("D:/a.cpp", "project", "ok"),
    checkFile("D:/b.cpp", "project", "errors"),
    checkFile("D:/c.cpp", "workspaceGems", "ok"),
    checkFile("D:/d.cpp", "workspaceGems", "timeout"),
    checkFile("D:/e.cpp", "workspaceGems", "failed", { otherErrors: ["Failed to resolve path"] }),
  ];
  const s = summariseCheck(files, parts);
  assert.equal(s.total, 5);
  assert.equal(s.clean, 2);
  assert.equal(s.pct, 40);
  assert.deepEqual(s.byStatus, { ok: 2, "ok-slow": 0, errors: 1, failed: 1, timeout: 1 });
  assert.deepEqual(s.parts.map((p) => [p.part, p.clean, p.total]), [
    ["projectGem", 0, 0],
    ["project", 1, 2],
    ["workspaceGems", 1, 3],
  ]);
  assert.equal(s.topMessages[0].message, "'x.h' file not found");
});

test("summariseCheck: an ok-slow file counts as clean and has its own status count (no NaN)", () => {
  const files = [checkFile("D:/a.cpp", "project", "ok"), checkFile("D:/b.cpp", "project", "ok-slow"), checkFile("D:/c.cpp", "project", "timeout")];
  const s = summariseCheck(files, parts);
  assert.deepEqual(s.byStatus, { ok: 1, "ok-slow": 1, errors: 0, failed: 0, timeout: 1 });
  assert.equal(s.clean, 2);
  assert.equal(s.pct, (100 * 2) / 3);
});

test("summariseCheck: clean % by where the compile command came from (in this DB / in every DB / inferred)", () => {
  const files = [
    checkFile("D:/both-1.cpp", "project", "ok"),
    checkFile("D:/both-2.cpp", "project", "errors"),
    checkFile("D:/mine-only.cpp", "project", "ok", { inAllDbs: false }),
    checkFile("D:/header.h", "project", "ok", { inDb: false, inAllDbs: false }),
    checkFile("D:/other-header.h", "project", "errors", { inDb: false, inAllDbs: false }),
  ];
  const s = summariseCheck(files, parts);
  assert.deepEqual(s.inDb, { total: 3, clean: 2, pct: (100 * 2) / 3 });
  assert.deepEqual(s.common, { total: 2, clean: 1, pct: 50 });
  assert.deepEqual(s.inferred, { total: 2, clean: 1, pct: 50 });
});

test("summariseCoverage: ordered rows, 'other' only when it has something, overall total", () => {
  const row = (onDisk, withEntries, extra = {}) => ({ onDisk, withEntries, pct: onDisk ? (100 * withEntries) / onDisk : null, dbEntries: withEntries, dbFiles: withEntries, dbOnly: 0, missingSample: [], ...extra });
  const coverage = { projectGem: row(10, 10), project: row(0, 0), workspaceGems: row(30, 15), other: row(0, 0) };
  const s = summariseCoverage(coverage, parts);
  assert.deepEqual(s.parts.map((p) => p.part), parts);
  assert.deepEqual(s.total, { onDisk: 40, withEntries: 25, pct: 62.5 });

  const withOther = summariseCoverage({ ...coverage, other: row(0, 0, { dbEntries: 4 }) }, parts);
  assert.equal(withOther.parts.at(-1).part, "other");
});

test("summariseSymbols", () => {
  const s = summariseSymbols([
    { query: "a", expectedSuffix: "a.h", status: "pass", reason: "", resultCount: 3, top: [], ms: 1 },
    { query: "b", expectedSuffix: "b.h", status: "fail", reason: "no result", resultCount: 0, top: [], ms: 1 },
  ]);
  assert.equal(s.pass, 1);
  assert.equal(s.pct, 50);
  assert.equal(s.failures.length, 1);
});

// ============================================================================
//  whole report
// ============================================================================

function sampleReportInput() {
  return {
    recipe: { name: "gs_play", clangd: "C:/clangd.exe", project: "D:/gs_play", workDir: "D:/ib", parts: { projectGem: [], project: [], workspaceGems: [] } },
    recipeFile: "D:/recipes/gs_play.json",
    recipeHash: "abc123",
    clangdVersion: "clangd version 22.1.6",
    cold: true,
    stages: ["coverage", "check", "nav"],
    outDir: "D:/ib/runs/x",
    startedAt: new Date("2026-11-21T10:00:00Z"),
    finishedAt: new Date("2026-11-21T10:05:30Z"),
    exclusive: true,
    otherClangdProcesses: 1,
    variants: [
      {
        name: "A-extension",
        db: "D:/db/a.json",
        extraArgs: ["--header-insertion=never"],
        dbEntries: 100,
        dbFiles: 90,
        errors: { nav: "boom | with pipe" },
        coverage: {
          projectGem: { onDisk: 4, withEntries: 4, pct: 100, dbEntries: 4, dbFiles: 4, dbOnly: 0, missingSample: [] },
          project: { onDisk: 0, withEntries: 0, pct: null, dbEntries: 0, dbFiles: 0, dbOnly: 0, missingSample: [] },
          workspaceGems: { onDisk: 10, withEntries: 5, pct: 50, dbEntries: 6, dbFiles: 5, dbOnly: 0, missingSample: ["D:/gems/missing.cpp"] },
          other: { onDisk: 0, withEntries: 0, pct: null, dbEntries: 0, dbFiles: 0, dbOnly: 0, missingSample: [] },
        },
        sampleSize: 3,
        check: [checkFile("D:/a.cpp", "project", "ok"), checkFile("D:/b.cpp", "workspaceGems", "errors")],
        nav: {
          coldRequested: true,
          freshIndex: true,
          indexDir: "D:/ib/variants/A-extension/.cache/clangd/index",
          indexExists: true,
          indexInsideWorkDir: true,
          indexSizeBytes: 5 * 1024 * 1024,
          indexMs: 125000,
          indexComplete: true,
          indexNote: "",
          progressTokens: ["backgroundIndexProgress"],
          clangdStderr: "",
          probes: [probe("a", "workspaceGems", "gem->engine .cpp", "pass"), probe("b", "workspaceGems", "gem->engine .cpp", "fail"), probe("c", "workspaceGems", "gem->gem", "fail", { expectedBuilt: false })],
          symbols: [{ query: "Entity", expectedSuffix: "AzCore/Component/Entity.h", status: "pass", reason: "", resultCount: 4, top: [{ name: "Entity", path: "D:/x/Entity.h", line: 3 }], ms: 4 }],
        },
      },
    ],
  };
}

test("buildReport: carries hash, clangd version, cold flag, timestamps, duration", () => {
  const report = buildReport(sampleReportInput());
  assert.equal(report.recipe.hash, "abc123");
  assert.equal(report.clangd.version, "clangd version 22.1.6");
  assert.equal(report.run.cold, true);
  assert.equal(report.run.startedAt, "2026-11-21T10:00:00.000Z");
  assert.equal(report.run.durationSec, 330);
  assert.equal(report.variants[0].check.pct, 50);
  assert.equal(report.variants[0].nav.probes.built.pct, 50);
  assert.equal(report.variants[0].coverage.total.pct, (100 * 9) / 14);
});

test("renderMarkdown: every section is present and table cells survive pipes", () => {
  const md = renderMarkdown(buildReport(sampleReportInput()));
  for (const expected of [
    "# IntelliSense benchmark: gs_play",
    "`abc123`",
    "COLD run",
    "clangd version 22.1.6",
    "## Variant: A-extension",
    "--header-insertion=never",
    '**Stage "nav" failed:** boom | with pipe',
    "### Coverage",
    "### Check",
    "### Navigation",
    "50.0%",
    "5.0 MB",
    "2 min 5 s",
    "gem->engine .cpp",
    "Probes for gems not in this build",
    "Symbols (Ctrl+T): 1/1 pass (100.0%)",
    "D:/gems/missing.cpp",
  ]) {
    assert.ok(md.includes(expected), `report.md should contain: ${expected}`);
  }
  assert.ok(!md.includes("undefined"), "no undefined leaked into the markdown");
  assert.ok(!md.includes("NaN"));
});

test("renderMarkdown: a warm run says so", () => {
  const input = sampleReportInput();
  input.cold = false;
  assert.match(renderMarkdown(buildReport(input)), /warm\/normal run/);
});

test("renderMarkdown: records the work dir lock and the other clangd processes", () => {
  const md = renderMarkdown(buildReport(sampleReportInput()));
  assert.match(md, /Work dir lock \| held: no other harness run/);
  assert.match(md, /Other clangd processes at start \| 1 \(they share the CPU/);
});

test("renderMarkdown: ok-slow files are counted clean but listed in their own note", () => {
  const input = sampleReportInput();
  input.variants[0].check = [checkFile("D:/a.cpp", "project", "ok"), checkFile("D:/big.cpp", "workspaceGems", "ok-slow", { ms: 180000 })];
  const md = renderMarkdown(buildReport(input));
  assert.match(md, /2 clean \(100\.0%\)/);
  assert.match(md, /1 parsed, feature checks slow \(counted clean\)/);
  assert.match(md, /\*\*Parsed, feature checks slow\*\* \(1,/);
  assert.match(md, /D:\/big\.cpp/);
  assert.match(md, /Unclean files\*\* \(0\)/);
  assert.ok(!md.includes("NaN") && !md.includes("undefined"));
});

test("renderMarkdown: check table shows the fair, same-files number apart from inferred-command files", () => {
  const input = sampleReportInput();
  input.variants[0].check = [checkFile("D:/a.cpp", "project", "ok"), checkFile("D:/h.h", "project", "errors", { inDb: false, inAllDbs: false })];
  const md = renderMarkdown(buildReport(input));
  assert.match(md, /in every variant's DB \(the fair number to compare\)\*\* \| 1 \| 1 \| 100\.0%/);
  assert.match(md, /inferred by clangd \(not in this DB\) \| 1 \| 0 \| 0\.0%/);
});

// ============================================================================
//  relationship probes, capabilities, path identity
// ============================================================================

/** A relationship probe result, as nav.mjs records it. */
const relation = (id, type, category, status, extra = {}) => ({
  ...probe(id, "workspaceGems", category, status, { needsIndex: true, targets: [], kind: "", expectedSuffix: "" }),
  type,
  expected: "includes ...src/a.cpp",
  returned: status === "skipped" ? null : { problem: "", files: ["D:/x/a.cpp"], labels: [], counts: { locations: 1, files: 1 } },
  ...extra,
});

test("summariseProbes: counts the F12 (definition) probes only; a probe with no type is one", () => {
  const s = summariseProbes([probe("f12", "workspaceGems", "c", "pass"), probe("typed", "workspaceGems", "c", "fail", { type: "definition" }), relation("refs", "references", "r", "pass")], parts);
  assert.deepEqual(s.built, { total: 2, pass: 1, fail: 1, error: 0, skipped: 0, pct: 50 });
  assert.deepEqual(s.results.map((p) => p.id), ["f12", "typed"]);
  assert.deepEqual(s.categories.map((c) => c.category), ["c"]);
});

test("summariseRelationships: rate over built probes, per category with its types; skipped and unbuilt stay out", () => {
  const s = summariseRelationships([
    probe("f12", "workspaceGems", "c", "fail"),
    relation("r1", "references", "gem refs", "pass"),
    relation("r2", "references", "gem refs", "fail", { reason: "missing ...src/a.cpp" }),
    relation("i1", "implementation", "gem refs", "pass"),
    relation("t1", "typeHierarchy", "hierarchy", "error", { reason: "request failed: timeout" }),
    relation("c1", "completion", "hierarchy", "skipped"),
    relation("u1", "rename", "unbuilt", "pass", { expectedBuilt: false }),
  ]);
  assert.deepEqual(s.built, { total: 4, pass: 2, fail: 1, error: 1, skipped: 1, pct: 50 });
  assert.deepEqual(s.categories.map((c) => [c.category, c.types, c.pass, c.total, c.skipped]), [
    ["gem refs", ["references", "implementation"], 2, 3, 0],
    ["hierarchy", ["typeHierarchy", "completion"], 0, 1, 1],
  ]);
  assert.deepEqual(s.failures.map((p) => p.id), ["r2", "t1"], "a skipped probe is not a failure, and the F12 probe is not listed here");
  assert.deepEqual([s.total, s.notBuilt.total, s.notBuilt.pass], [6, 1, 1]);
  assert.equal(s.results.length, 6);
});

test("summariseRelationships: nothing to report for a recipe with only F12 probes", () => {
  const s = summariseRelationships([probe("a", "workspaceGems", "c", "pass")]);
  assert.deepEqual([s.total, s.built.total, s.built.pct, s.failures.length, s.categories.length], [0, 0, null, 0, 0]);
});

test("summariseCapabilities: pass/total per kind of question, in the report's order; unbuilt probes and skipped ones stay out", () => {
  const rows = summariseCapabilities(
    [
      probe("f1", "workspaceGems", "c", "pass"),
      probe("f2", "workspaceGems", "c", "fail", { type: "definition" }),
      relation("r1", "references", "r", "pass"),
      relation("r2", "references", "r", "skipped"),
      relation("r3", "references", "r", "pass", { expectedBuilt: false }),
      relation("k1", "completion", "r", "fail"),
      relation("n1", "rename", "r", "pass"),
    ],
    [
      { query: "a", status: "pass" },
      { query: "b", status: "skipped" },
    ],
  );
  assert.deepEqual(rows.map((r) => [r.type, r.pass, r.total, r.skipped]), [
    ["definition", 1, 2, 0],
    ["references", 1, 1, 1],
    ["rename", 1, 1, 0],
    ["completion", 0, 1, 0],
    ["workspaceSymbol", 1, 1, 1],
  ]);
  assert.equal(rows[0].label, "go to definition (F12)");
  assert.equal(rows[0].pct, 50);
});

test("summariseCapabilities: no symbols, no workspaceSymbol row", () => {
  assert.deepEqual(summariseCapabilities([probe("f", "workspaceGems", "c", "pass")], []).map((r) => r.type), ["definition"]);
});

test("summariseSymbols: path identity pairs and examples over the queries that ran", () => {
  const twin = (name) => ({ name, container: "AZ", a: "C:/sdk/Code/AzCore/Entity.h", b: "d:/src/Code/AzCore/Entity.h", tail: 4 });
  const symbol = (query, status, twins = []) => ({ query, expectedSuffix: "a.h", status, reason: "", resultCount: 3, top: [], twinCount: twins.length, twins, ms: 1 });
  const s = summariseSymbols([symbol("AZ::Entity", "pass", [twin("Entity")]), symbol("Plain", "pass"), symbol("Two", "fail", [twin("A"), twin("B")]), symbol("Skipped", "skipped", [twin("Z")])]);
  assert.equal(s.pathIdentity.pairs, 3, "the skipped query is not counted");
  assert.equal(s.pathIdentity.queries, 2);
  assert.deepEqual(s.pathIdentity.examples.map((e) => [e.query, e.name]), [["AZ::Entity", "Entity"], ["Two", "A"], ["Two", "B"]]);

  const none = summariseSymbols([{ query: "old", expectedSuffix: "a.h", status: "pass", reason: "", resultCount: 1, top: [], ms: 1 }]);
  assert.deepEqual(none.pathIdentity, { pairs: 0, queries: 0, examples: [] }, "a symbol result from before the metric existed counts as none");
});

test("cameBack: counts, the first 8 files and names, and a note when a file came back under two spellings", () => {
  const files = Array.from({ length: 10 }, (_, i) => `D:/x/f${i}.cpp`);
  const text = cameBack(relation("r", "references", "r", "fail", { returned: { problem: "", files, labels: ["Dog", "Bird"], counts: { locations: 12, files: 10, uris: 11 } } }));
  assert.match(text, /^12 locations, 10 files, 11 uris \| \(a file came back under two path spellings/);
  assert.ok(text.includes("D:/x/f7.cpp") && !text.includes("D:/x/f8.cpp"), "the first 8 files only");
  assert.match(text, /D:\/x\/f7\.cpp; \.\.\. \| names: Dog; Bird$/);

  assert.equal(cameBack(relation("r", "references", "r", "skipped")), "");
  assert.equal(cameBack(probe("f12", "workspaceGems", "c", "fail")), "", "an F12 probe has nothing in returned");
  assert.equal(cameBack(relation("r", "completion", "r", "fail", { returned: { problem: "", files: [], labels: ["Size"], counts: { items: 1 } } })), "1 items | names: Size");
});

/** the sample report, with relationship probes and symbols that have a path-identity pair */
function relationshipInput() {
  const input = sampleReportInput();
  const nav = input.variants[0].nav;
  nav.probes = [...nav.probes, relation("refs-ok", "references", "gem refs", "pass"), relation("refs-bad", "references", "gem refs", "fail", { reason: "missing ...src/a.cpp", expected: "includes ...src/a.cpp" })];
  nav.symbols = [{ query: "AZ::Entity", expectedSuffix: "AzCore/Component/Entity.h", status: "pass", reason: "", resultCount: 4, top: [], twinCount: 1, twins: [{ name: "Entity", container: "AZ", a: "C:/sdk/Code/AzCore/Entity.h", b: "d:/src/Code/AzCore/Entity.h", tail: 4 }], ms: 4 }];
  return input;
}

test("renderMarkdown: Capabilities table, Relationships section with failures and the full list, path identity", () => {
  const md = renderMarkdown(buildReport(relationshipInput()));
  for (const expected of [
    "**Capabilities**",
    "| go to definition (F12) | 1 | 2 | 50.0% | 0 |",
    "| find references | 1 | 2 | 50.0% | 0 |",
    "| workspace symbol (Ctrl+T) | 1 | 1 | 100.0% | 0 |",
    "**Relationships, built projects only: 1/2 pass (50.0%)**",
    "| gem refs | references | 1 | 2 | 50.0% |",
    "**Failed relationship probes** (1)",
    "| refs-bad | references | includes ...src/a.cpp | fail: missing ...src/a.cpp | 1 locations, 1 files \\| files: D:/x/a.cpp |",
    "Every relationship probe (2)",
    "**Path identity: 1 duplicate symbol pair(s) across roots** in 1 of 1 queries",
    "| AZ::Entity | AZ::Entity | C:/sdk/Code/AzCore/Entity.h | d:/src/Code/AzCore/Entity.h | 4 |",
  ]) {
    assert.ok(md.includes(expected), `report.md should contain: ${expected}`);
  }
  assert.ok(!md.includes("undefined") && !md.includes("NaN"));
  assert.match(md, /\*\*Probes \(F12\), built projects only: 1\/2 pass/, "the relationship probes are not in the F12 headline");
});

test("renderMarkdown: a recipe with only F12 probes still gets the Capabilities table, but no Relationships section", () => {
  const md = renderMarkdown(buildReport(sampleReportInput()));
  assert.match(md, /\*\*Capabilities\*\*/);
  assert.ok(!md.includes("**Relationships"));
  assert.match(md, /\*\*Path identity: 0 duplicate symbol pair\(s\) across roots\*\* in 0 of 1 queries/);
});

test("renderMarkdown: an unfinished index counts the skipped relationship probes too", () => {
  const input = incompleteIndexInput();
  input.variants[0].nav.probes.push(relation("refs-a", "references", "gem refs", "skipped"), relation("rename-a", "rename", "gem refs", "skipped"));
  const md = renderMarkdown(buildReport(input));
  assert.match(md, /the 4 probes that need it and all 1 symbol queries were skipped/);
  assert.match(md, /\*\*Relationships, built projects only: 0\/0 pass \(n\/a\)\*\*, 2 skipped \(index incomplete\) - INDEX INCOMPLETE - partial results/);
  assert.match(indexWarnings(buildReport(input))[0], /4 probes and 1 symbol queries were skipped/);
  assert.ok(!md.includes("NaN") && !md.includes("undefined"));
});

// ============================================================================
//  an unfinished index
// ============================================================================

/** The sample report, with its nav stage turned into an unfinished index: needs-index probes and all symbols skipped. */
function incompleteIndexInput() {
  const input = sampleReportInput();
  const nav = input.variants[0].nav;
  nav.indexComplete = false;
  nav.indexNote = "index not finished after 2 min; results may undercount";
  nav.probes = [
    probe("same-file", "workspaceGems", "same-file", "pass"),
    probe("cpp-a", "workspaceGems", "gem->engine .cpp", "skipped", { needsIndex: true }),
    probe("cpp-b", "workspaceGems", "gem->engine .cpp", "skipped", { needsIndex: true }),
  ];
  nav.symbols = [{ query: "Entity", expectedSuffix: "AzCore/Component/Entity.h", status: "skipped", reason: "skipped: index incomplete", resultCount: 0, top: [], ms: 0 }];
  return input;
}

test("renderMarkdown: an unfinished index puts the banner on the probe and symbol headlines and shows the split", () => {
  const md = renderMarkdown(buildReport(incompleteIndexInput()));
  assert.match(md, /Probes \(F12\), built projects only: 1\/1 pass \(100\.0%\)\*\*, 2 skipped \(index incomplete\) - INDEX INCOMPLETE - partial results/);
  assert.match(md, /Symbols \(Ctrl\+T\): 0\/0 pass \(n\/a\)\*\*, 1 skipped \(index incomplete\) - INDEX INCOMPLETE - partial results/);
  assert.match(md, /\*\*INDEX INCOMPLETE - partial results\.\*\* .*the 2 probes that need it and all 1 symbol queries were skipped/);
  assert.match(md, /needing the index \| 2 \| 0 \| 0 \| n\/a/);
  assert.ok(!md.includes("NaN") && !md.includes("undefined"));
});

test("renderMarkdown: a finished index has no banner", () => {
  const md = renderMarkdown(buildReport(sampleReportInput()));
  assert.ok(!md.includes("INDEX INCOMPLETE"));
});

test("indexWarnings: one line per unfinished variant, and one when variants cannot be compared", () => {
  assert.deepEqual(indexWarnings(buildReport(sampleReportInput())), []);

  const one = indexWarnings(buildReport(incompleteIndexInput()));
  assert.equal(one.length, 1, "a single variant has nothing to compare");
  assert.match(one[0], /variant A-extension: INDEX INCOMPLETE - partial results\. 2 probes and 1 symbol queries were skipped/);

  const two = incompleteIndexInput();
  two.variants.push({ ...sampleReportInput().variants[0], name: "B" });
  const warnings = indexWarnings(buildReport(two));
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /NOT comparable between variants: the index did not finish for A-extension/);
  assert.match(renderMarkdown(buildReport(two)), /Navigation comparison between variants: REFUSED/);
});

test("renderMarkdown: variants whose indexes all finished are marked comparable", () => {
  const input = sampleReportInput();
  input.variants.push({ ...sampleReportInput().variants[0], name: "B" });
  assert.match(renderMarkdown(buildReport(input)), /Navigation comparison between variants: valid/);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoots = [];
after(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("writeReport writes report.json and report.md", () => {
  const dir = fs.mkdtempSync(path.join(here, ".tmp-report-"));
  tmpRoots.push(dir);
  writeReport(dir, buildReport(sampleReportInput()));
  const json = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
  assert.equal(json.schema, 2);
  assert.equal(json.variants[0].name, "A-extension");
  assert.ok(fs.readFileSync(path.join(dir, "report.md"), "utf8").startsWith("# IntelliSense benchmark"));
});

test("formatting helpers", () => {
  assert.equal(fmtPct(null), "n/a");
  assert.equal(fmtPct(87.456), "87.5%");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(1536), "1.5 KB");
  assert.equal(fmtBytes(3 * 1024 ** 3), "3.0 GB");
  assert.equal(fmtDuration(null), "n/a");
  assert.equal(fmtDuration(250), "250 ms");
  assert.equal(fmtDuration(12500), "12.5 s");
  assert.equal(fmtDuration(125000), "2 min 5 s");
});

// ============================================================================
//  probe files with no compile-DB entry
// ============================================================================

const flagged = (source, from) => ({ flags: { source, from } });

test("summariseEntryless: one row per probe file without an entry, with where its flags come from; own-entry probes and older results are left out", () => {
  const probes = [
    probe("own", "workspaceGems", "c", "pass", flagged("own entry", "")),
    probe("older-result-without-flags", "workspaceGems", "c", "pass"),
    probe("x1", "workspaceGems", "legacy file", "fail", { file: "D:/g/a.cpp", ...flagged("full-DB inferred", "D:/g/Module.cpp") }),
    probe("x2", "workspaceGems", "legacy file", "pass", { file: "D:/g/a.cpp", ...flagged("full-DB inferred", "D:/g/Module.cpp") }),
    probe("y", "workspaceGems", "unbuilt gem", "fail", { file: "D:/g/b.cpp", ...flagged("subset-inferred", "") }),
  ];
  assert.deepEqual(summariseEntryless(probes), [
    { file: "D:/g/a.cpp", source: "full-DB inferred", from: "D:/g/Module.cpp", probes: ["x1", "x2"] },
    { file: "D:/g/b.cpp", source: "subset-inferred", from: "", probes: ["y"] },
  ]);
  assert.deepEqual(summariseEntryless([probe("own", "workspaceGems", "c", "pass")]), []);
});

test("renderMarkdown: entry-less probes are marked 'full-DB inferred' and the entry their flags come from is shown", () => {
  const input = sampleReportInput();
  input.variants[0].errors = {};
  input.variants[0].nav.probes = [
    probe("a", "workspaceGems", "gem->engine .cpp", "pass"),
    probe("legacy-ctor", "workspaceGems", "legacy file", "pass", { expectedBuilt: false, file: "D:/g/gs_graphcanvas/Core/Ctor.cpp", ...flagged("full-DB inferred", "D:/g/gs_graphcanvas/Clients/Module.cpp") }),
    probe("legacy-node", "workspaceGems", "legacy file", "fail", { expectedBuilt: false, file: "D:/g/gs_graphcanvas/Nodes/Base.cpp", ...flagged("subset-inferred", "") }),
  ];
  const md = renderMarkdown(buildReport(input));

  assert.match(md, /\*\*Probe files without a compile-DB entry\*\* \(2\)/);
  assert.match(md, /\| D:\/g\/gs_graphcanvas\/Core\/Ctor\.cpp \| full-DB inferred \| D:\/g\/gs_graphcanvas\/Clients\/Module\.cpp \| 1 \|/);
  assert.match(md, /\| D:\/g\/gs_graphcanvas\/Nodes\/Base\.cpp \| subset-inferred \| \(not named by clangd\) \| 1 \|/);
  assert.match(md, /\| legacy-ctor \| workspaceGems \| full-DB inferred \| pass \|/, "the not-built table says which flags the probe ran on");
  assert.ok(!md.includes("undefined") && !md.includes("NaN"));
});

test("renderMarkdown: a run where every probe file has an entry has no entry-less section", () => {
  const md = renderMarkdown(buildReport(sampleReportInput()));
  assert.ok(!md.includes("Probe files without a compile-DB entry"));
});
