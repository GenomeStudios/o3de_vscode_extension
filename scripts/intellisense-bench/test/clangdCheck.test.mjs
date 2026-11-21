import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findInferredProxy, inferenceFromOutput, parseCheckOutput, parseInferredFrom, toCheckResult, topErrorMessages } from "../lib/clangdCheck.mjs";

// The fixtures are real "clangd --check" output captured with clangd 22.1.6
// (long lines trimmed, user name masked).
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, "fixtures", `${name}.txt`), "utf8");
const run = { file: "D:/x/a.cpp", part: "project", ms: 10, exitCode: 0, timedOut: false };

// ============================================================================
//  parsing real output
// ============================================================================

test("clean file: completed, no diagnostics, no tweak failures", () => {
  const parsed = parseCheckOutput(fixture("check-clean"));
  assert.equal(parsed.completed, true);
  assert.equal(parsed.reportedErrors, 0);
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.tweakFailures, 0);
  assert.deepEqual(toCheckResult(parsed, run).status, "ok");
  assert.equal(toCheckResult(parsed, run).clean, true);
});

test("file with compile errors: diagnostics parsed with code, line and message", () => {
  const parsed = parseCheckOutput(fixture("check-errors"));
  assert.equal(parsed.completed, true);
  assert.equal(parsed.reportedErrors, 3);
  assert.deepEqual(parsed.diagnostics, [
    { code: "pp_file_not_found", line: 1, message: "'nothere.h' file not found" },
    { code: "undeclared_var_use", line: 2, message: "use of undeclared identifier 'undefinedThing'" },
    { code: "undeclared_var_use", line: 2, message: "use of undeclared identifier 'missingFn'" },
  ]);
  assert.ok(parsed.includeCleanerNoise >= 1, "IncludeCleaner lines are counted as noise");

  const result = toCheckResult(parsed, run);
  assert.equal(result.status, "errors");
  assert.equal(result.clean, false);
  assert.equal(result.errorCount, 3);
  assert.equal(result.unexplainedErrors, 0);
});

test("header with code-action (tweak) failures: counted by clangd, but the file is clean", () => {
  const parsed = parseCheckOutput(fixture("check-header-tweaks"));
  assert.equal(parsed.reportedErrors, 5);
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.tweakFailures, 5);

  const result = toCheckResult(parsed, run);
  assert.equal(result.status, "ok");
  assert.equal(result.tweakFailures, 5);
  assert.equal(result.unexplainedErrors, 0);
});

test("'Failed to resolve URI' lines are feature-check noise: not an error, not shown as one", () => {
  const parsed = parseCheckOutput(fixture("check-header-uri-noise"));
  assert.ok(parsed.featureNoise >= 20, "the real capture has two dozen of them");
  assert.deepEqual(parsed.otherErrors, []);
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.reportedErrors, 7);
  assert.equal(parsed.tweakFailures, 7);

  const result = toCheckResult(parsed, run);
  assert.equal(result.status, "ok");
  assert.equal(result.unexplainedErrors, 0);
  assert.deepEqual(result.otherErrors, []);
});

test("missing file: never completes, so the run is 'failed' and the reason is kept", () => {
  const parsed = parseCheckOutput(fixture("check-missing-file"));
  assert.equal(parsed.completed, false);
  assert.ok(parsed.otherErrors.some((m) => m.startsWith("Failed to resolve path")));

  const result = toCheckResult(parsed, { ...run, exitCode: 1 });
  assert.equal(result.status, "failed");
  assert.equal(result.clean, false);
  assert.match(result.otherErrors[0], /Failed to resolve path/);
});

// ============================================================================
//  edge cases
// ============================================================================

test("errors clangd counts but we cannot attribute make the file unclean", () => {
  const text = "I[00:00:00.001] Building AST...\nE[00:00:00.002] something new\nI[00:00:00.003] All checks completed, 1 errors\n";
  const result = toCheckResult(parseCheckOutput(text), run);
  assert.equal(result.unexplainedErrors, 1);
  assert.equal(result.status, "errors");
});

test("a timeout is a timeout even with partial output", () => {
  const parsed = parseCheckOutput("I[00:00:00.001] Building preamble...\n");
  const result = toCheckResult(parsed, { ...run, timedOut: true });
  assert.equal(result.status, "timeout");
  assert.equal(result.astBuilt, false);
});

test("a timeout after the AST was built, with no compile error, is 'ok-slow' and clean (big files make clangd's per-token checks slow)", () => {
  const partial = "I[00:00:00.001] Building AST...\nI[00:00:00.002] Indexing AST...\nI[00:00:00.003] Testing features at each token (may be slow in large files)\n";
  const result = toCheckResult(parseCheckOutput(partial), { ...run, timedOut: true });
  assert.equal(result.status, "ok-slow");
  assert.equal(result.astBuilt, true);
  assert.equal(result.clean, true);
  assert.equal(parseCheckOutput(fixture("check-clean")).astBuilt, true);
  assert.equal(parseCheckOutput(fixture("check-missing-file")).astBuilt, false);
});

test("a timeout after the AST was built WITH a compile error is 'errors': the diagnostic was already printed", () => {
  const partial = [
    "I[00:00:00.001] Building AST...",
    "E[00:00:00.002] [pp_file_not_found] Line 1: 'nothere.h' file not found",
    "I[00:00:00.003] Indexing AST...",
    "I[00:00:00.004] Testing features at each token (may be slow in large files)",
  ].join("\n");
  const result = toCheckResult(parseCheckOutput(partial), { ...run, timedOut: true });
  assert.equal(result.status, "errors");
  assert.equal(result.errorCount, 1);
  assert.equal(result.clean, false);
});

test("a timeout before the AST was built stays 'timeout' and unclean, whatever else was printed", () => {
  const result = toCheckResult(parseCheckOutput("I[00:00:00.001] Building preamble...\nI[00:00:00.002] Building AST...\n"), { ...run, timedOut: true });
  assert.equal(result.status, "timeout");
  assert.equal(result.astBuilt, false);
  assert.equal(result.clean, false);
});

test("a multi-line tweak failure does not confuse the parser", () => {
  const text = [
    "E[00:00:01.000]     tweak: SwapBinaryOperands ==> FAIL: The new replacement overlaps with an existing replacement.",
    "New replacement: D:\\x\\a.cpp: 58172:+58:\"==\"",
    "Existing replacement: D:\\x\\a.cpp: 58172:+58:\"MACRO(X)\"",
    "I[00:00:02.000] All checks completed, 1 errors",
  ].join("\n");
  const parsed = parseCheckOutput(text);
  assert.equal(parsed.tweakFailures, 1);
  assert.equal(parsed.otherErrors.length, 0);
  assert.equal(toCheckResult(parsed, run).status, "ok");
});

test("handles CRLF line endings and junk lines", () => {
  const text = "garbage\r\nE[00:00:00.002] [foo] Line 7: bad thing\r\n\r\nI[00:00:00.003] All checks completed, 1 error\r\n";
  const parsed = parseCheckOutput(text);
  assert.equal(parsed.diagnostics.length, 1);
  assert.equal(parsed.reportedErrors, 1);
});

// ============================================================================
//  aggregating
// ============================================================================

test("topErrorMessages ranks by the number of files that hit the message", () => {
  const diag = (message) => ({ code: "c", line: 1, message });
  const file = (name, messages) => ({ file: name, part: "p", diagnostics: messages.map(diag), otherErrors: [] });
  const top = topErrorMessages([file("a", ["x", "x", "y"]), file("b", ["x"]), file("c", ["y", "z"])]);
  assert.deepEqual(
    top.map((m) => [m.message, m.files, m.count]),
    [
      ["x", 2, 3],
      ["y", 2, 2],
      ["z", 1, 1],
    ],
  );
});

// ============================================================================
//  the entry clangd infers a file's flags from (a file with no entry of its own)
// ============================================================================

test("parseInferredFrom: a header with no entry names the .cpp clangd borrowed its flags from (real capture)", () => {
  assert.equal(parseInferredFrom(fixture("check-header-uri-noise")), "D:/OffLocalDev/gs_play_gems/gs_core/Code/Source/Interfaces/Item/ItemComponentType.cpp");
});

test("parseInferredFrom: the borrowed entry can sit in a different tree than the file (real capture of an unbuilt gem's .cpp)", () => {
  assert.equal(parseInferredFrom(fixture("check-inferred-other-tree")), "D:/OffLocalDev/VolumetricCloudsForO3DE/Gem/Code/Source/Clients/VolumetricCloudsModule.cpp");
});

test("parseInferredFrom: a file that HAS an entry logs 'Compile command from CDB', so there is nothing to name (real capture)", () => {
  assert.equal(parseInferredFrom(fixture("check-own-entry")), null);
  assert.equal(parseInferredFrom(fixture("check-clean")), null);
});

test("parseInferredFrom: a path with spaces is read up to ' is: ', and CRLF output works", () => {
  const text = "I[00:00:00.001] Compile command inferred from D:/My Gems/a b/Code/Source/Mod.cpp is: [D:/build] cl a.cpp\r\nI[00:00:00.002] Parsing command...\r\n";
  assert.equal(parseInferredFrom(text), "D:/My Gems/a b/Code/Source/Mod.cpp");
});

test("inferenceFromOutput: undecided until clangd names the entry, or reaches 'Parsing command' without naming one", () => {
  const loaded = "I[00:00:00.001] Loading compilation database...\nI[00:00:00.002] Loaded compilation database from D:/db\compile_commands.json\n";
  assert.equal(inferenceFromOutput(loaded), null);
  assert.equal(inferenceFromOutput(`${loaded}I[00:00:00.003] Compile command inferred from D:/g/a/Code/Source/Mod.cp`), null, "the line is still arriving");

  const named = `${loaded}I[00:00:00.003] Compile command inferred from D:/g/a/Code/Source/Mod.cpp is: [D:/build] cl`;
  assert.deepEqual(inferenceFromOutput(named), { proxy: "D:/g/a/Code/Source/Mod.cpp", note: "" });

  const own = inferenceFromOutput(fixture("check-own-entry"));
  assert.equal(own.proxy, null);
  assert.match(own.note, /no 'Compile command inferred from' line/);
});

test("findInferredProxy: a clangd that cannot be started, or that exits without naming an entry, gives no proxy and says why", async () => {
  const options = { file: "D:/x/a.h", dbDir: "D:/x", timeoutSec: 30 };
  const missing = await findInferredProxy({ ...options, clangd: path.join(here, "no-such-clangd.exe") });
  assert.equal(missing.proxy, null);
  assert.match(missing.note, /cannot run clangd/);

  // node stands in for clangd and rejects the clangd-style flags at once
  const exits = await findInferredProxy({ ...options, clangd: process.execPath });
  assert.equal(exits.proxy, null);
  assert.match(exits.note, /clangd exited without naming an inferred command/);
});
