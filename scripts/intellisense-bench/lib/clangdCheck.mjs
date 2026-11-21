// ============================================================================
//  clangdCheck.mjs - "does clangd parse this file cleanly?"
//
//  Runs   clangd --check=<file> --compile-commands-dir=<dir>   once per file and
//  parses what it prints. Measured with clangd 22.1.6 on Windows:
//
//    * Everything goes to STDERR (stdout stays empty). Each line is
//        <L>[HH:MM:SS.mmm] <message>        L = I (info), E (error) or W
//    * Compile errors:      E[..] [<diagnostic-code>] Line <n>: <message>
//    * Code-action noise:   E[..]     tweak: <Name> ==> FAIL: <reason>
//                           (the reason may continue on following lines with no prefix)
//    * IncludeCleaner noise: E[..] IncludeCleaner: Failed to get an entry ...
//    * Feature-check noise:  E[..] Failed to resolve URI : Scheme must be provided in URI:
//                            (a per-token feature test met an empty URI; dozens of lines on a header that
//                            parses cleanly; clangd does not count them in N)
//    * "Indexing AST..." is logged once the AST is built; after it clangd tests its
//      features at every token, which can take minutes on a big file (a 1100-line
//      gtest file took over 100 s), so a timeout does not by itself mean a parse problem.
//    * Harness-level failures: E[..] Failed to resolve path ... / Failed to build AST
//    * The last line:       I[..] All checks completed, <N> errors
//      N counts compile errors AND tweak failures, not IncludeCleaner lines.
//    * Warnings are not printed at all, only errors.
//    * A file that is not in the compile DB still works: clangd infers a command
//      ("Compile command inferred from <other file>"), the same as for a header.
//
//  So "clean" here means one of:
//    ok       the run completed ("All checks completed" was printed), printed no compile
//             error, and clangd's N has no errors beyond the compile errors and tweak
//             failures we recognise. Tweak failures are counted but do not make a file
//             unclean.
//    ok-slow  the run hit the timeout AFTER "Indexing AST..." with no compile error
//             printed. clangd prints every compile diagnostic before it logs that line,
//             so the file is known to parse; only the per-token feature pass was slow,
//             and how slow depends on CPU load and checkConcurrency, not on the file.
//  A timeout before the AST was built ("timeout"), a run that never completed
//  ("failed") and any compile error ("errors") are not clean.
// ============================================================================

import { spawnTracked } from "./procs.mjs";

/**
 * @typedef {object} CheckDiagnostic
 * @property {string} code
 * @property {number} line
 * @property {string} message
 *
 * @typedef {object} ParsedCheck
 * @property {boolean} completed            saw "All checks completed"
 * @property {boolean} astBuilt             saw "Indexing AST..." (the file parsed; later feature checks may still be running)
 * @property {number | null} reportedErrors the N from that line
 * @property {CheckDiagnostic[]} diagnostics compile errors
 * @property {number} tweakFailures
 * @property {number} includeCleanerNoise
 * @property {number} featureNoise          "Failed to resolve URI" lines from the per-token feature tests
 * @property {string[]} otherErrors         E lines that are none of the above
 *
 * @typedef {object} CheckResult
 * @property {string} file
 * @property {string} part
 * @property {"ok" | "ok-slow" | "errors" | "failed" | "timeout"} status
 *   ok-slow = timed out after the AST was built with no compile error (parsed; the feature checks were slow); timeout = never got a parse
 * @property {boolean} clean               status is "ok" or "ok-slow"
 * @property {boolean} astBuilt            the AST was built (on a timeout: the file parsed, clangd's per-token feature checks were just slow)
 * @property {number} ms
 * @property {number | null} exitCode
 * @property {number} errorCount           compile errors
 * @property {CheckDiagnostic[]} diagnostics  at most 10, the first ones
 * @property {number} tweakFailures
 * @property {number} unexplainedErrors    errors clangd counted that we could not attribute
 * @property {string[]} otherErrors        unrecognised E lines (and the reason a run failed)
 */

// ============================================================================
//  PARSING
// ============================================================================

const LOG_LINE = /^([IEW])\[\d\d:\d\d:\d\d\.\d+\] ?(.*)$/;
const DIAGNOSTIC = /^\[([^\]]+)\] Line (\d+): (.*)$/;
const TWEAK_FAILURE = /^\s*tweak: \S+ ==> FAIL:/;
const FEATURE_NOISE = /^Failed to resolve URI/;
const COMPLETED = /^All checks completed, (\d+) errors?$/;

/**
 * Parse the text clangd --check printed.
 * @param {string} text  stderr and stdout, concatenated
 * @returns {ParsedCheck}
 */
export function parseCheckOutput(text) {
  /** @type {ParsedCheck} */
  const parsed = { completed: false, astBuilt: false, reportedErrors: null, diagnostics: [], tweakFailures: 0, includeCleanerNoise: 0, featureNoise: 0, otherErrors: [] };

  for (const line of text.split(/\r?\n/)) {
    const m = LOG_LINE.exec(line);
    if (!m) continue; // continuation lines (some tweak failures span several lines) and blanks carry nothing we use
    const [, level, message] = m;

    if (message === "Indexing AST...") parsed.astBuilt = true; // clangd logs this once the AST is built

    const done = COMPLETED.exec(message);
    if (done) {
      parsed.completed = true;
      parsed.reportedErrors = Number(done[1]);
      continue;
    }
    if (level !== "E") continue;

    const diagnostic = DIAGNOSTIC.exec(message);
    if (diagnostic) parsed.diagnostics.push({ code: diagnostic[1], line: Number(diagnostic[2]), message: diagnostic[3] });
    else if (TWEAK_FAILURE.test(message)) parsed.tweakFailures++;
    else if (message.startsWith("IncludeCleaner:")) parsed.includeCleanerNoise++;
    else if (FEATURE_NOISE.test(message)) parsed.featureNoise++;
    else parsed.otherErrors.push(message.trim());
  }
  return parsed;
}

/**
 * Turn a parsed run into a result row.
 * @param {ParsedCheck} parsed
 * @param {{file: string, part: string, ms: number, exitCode: number | null, timedOut: boolean}} run
 * @returns {CheckResult}
 */
export function toCheckResult(parsed, run) {
  // clangd counts compile errors and tweak failures; anything it counts beyond those
  // is an error line we do not recognise, which must not pass silently.
  const explained = parsed.diagnostics.length + parsed.tweakFailures;
  const unexplainedErrors = parsed.completed ? Math.max(0, (parsed.reportedErrors ?? 0) - explained) : 0;

  /** @type {CheckResult["status"]} */
  let status = "ok";
  if (run.timedOut) {
    if (!parsed.astBuilt) status = "timeout"; // never got a parse: not clean
    else status = parsed.diagnostics.length > 0 ? "errors" : "ok-slow"; // AST built, so every compile error is already logged
  } else if (!parsed.completed) status = "failed";
  else if (parsed.diagnostics.length > 0 || unexplainedErrors > 0) status = "errors";

  return {
    file: run.file,
    part: run.part,
    status,
    clean: status === "ok" || status === "ok-slow",
    astBuilt: parsed.astBuilt,
    ms: run.ms,
    exitCode: run.exitCode,
    errorCount: parsed.diagnostics.length,
    diagnostics: parsed.diagnostics.slice(0, 10),
    tweakFailures: parsed.tweakFailures,
    unexplainedErrors,
    otherErrors: parsed.otherErrors.slice(0, 5),
  };
}

// ============================================================================
//  RUNNING
// ============================================================================

/**
 * Check one file.
 * @param {object} options
 * @param {string} options.clangd
 * @param {string} options.file
 * @param {string} options.part
 * @param {string} options.dbDir          folder holding compile_commands.json
 * @param {string[]} [options.extraArgs]
 * @param {number} options.timeoutSec
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<CheckResult>}
 */
export function runCheck({ clangd, file, part, dbDir, extraArgs = [], timeoutSec, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [`--check=${file}`, `--compile-commands-dir=${dbDir}`, ...extraArgs];
    const child = spawnTracked(clangd, args, { env, stdio: ["ignore", "pipe", "pipe"] });

    let output = "";
    let timedOut = false;
    let settled = false;
    const collect = (chunk) => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const finish = (exitCode, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseCheckOutput(output);
      if (spawnError) parsed.otherErrors.push(`cannot run clangd: ${spawnError.message}`);
      resolve(toCheckResult(parsed, { file, part, ms: Date.now() - started, exitCode, timedOut }));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSec * 1000);
    child.once("error", (err) => finish(null, err));
    child.once("close", (code) => finish(code));
  });
}

/**
 * Check many files with a fixed number running at once. Results keep the input order.
 * @param {{file: string, part: string}[]} files
 * @param {Omit<Parameters<typeof runCheck>[0], "file" | "part"> & {concurrency: number, onResult?: (r: CheckResult, done: number, total: number) => void}} options
 * @returns {Promise<CheckResult[]>}
 */
export async function runChecks(files, options) {
  const { concurrency, onResult, ...single } = options;
  const results = new Array(files.length);
  let next = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= files.length) return;
      results[index] = await runCheck({ ...single, file: files[index].file, part: files[index].part });
      onResult?.(results[index], ++done, files.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), files.length) }, worker));
  return results;
}

// ============================================================================
//  INFERRED COMMAND: whose flags would clangd borrow for a file with no entry?
// ============================================================================

/** "Compile command inferred from <file in the DB> is: [<directory>] <command>"; the path is everything up to " is: ". */
const INFERRED_FROM = /Compile command inferred from (.+?) is: /;

/** Logged right after the command line is chosen (from the DB or inferred), before any parsing. */
const PARSING_COMMAND = /^[IEW]\[[\d:.]+\] Parsing command\.\.\./m;

/**
 * The DB file clangd took a file's compile command from, when the file has no entry of its own.
 * Measured with clangd 22.1.6: the line sits right after "Loaded compilation database" and names the
 * entry's file as the DB spells it ("D:/dir/File.cpp"). A file that HAS an entry logs "Compile command
 * from CDB" instead, so there is no such line.
 * @param {string} text  what clangd --check printed (all of it, or the part seen so far)
 * @returns {string | null}
 */
export function parseInferredFrom(text) {
  return INFERRED_FROM.exec(text)?.[1] ?? null;
}

/**
 * Has clangd said enough yet? It names the inferred entry before "Parsing command...", so that line without
 * the name means the file has an entry of its own, or the DB has nothing to infer from.
 * @param {string} output  what clangd --check printed so far
 * @returns {{proxy: string | null, note: string} | null}  null while clangd has not got that far
 */
export function inferenceFromOutput(output) {
  const proxy = parseInferredFrom(output);
  if (proxy) return { proxy, note: "" };
  if (PARSING_COMMAND.test(output)) return { proxy: null, note: "clangd printed no 'Compile command inferred from' line (the file has an entry of its own, or the DB has nothing to infer from)" };
  return null;
}

/**
 * Ask clangd which DB entry it would infer `file`'s flags from. clangd names it long before it builds
 * anything, so the run is stopped as soon as the line (or the "Parsing command" line that follows it)
 * has been printed: no preamble, no AST, about a second per file.
 * @param {object} options
 * @param {string} options.clangd
 * @param {string} options.file
 * @param {string} options.dbDir          folder holding the compile_commands.json to ask (the FULL DB)
 * @param {string[]} [options.extraArgs]
 * @param {number} options.timeoutSec
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<{proxy: string | null, note: string}>}  proxy as clangd printed it; null (with the reason in note) when it printed no such line
 */
export function findInferredProxy({ clangd, file, dbDir, extraArgs = [], timeoutSec, env }) {
  return new Promise((resolve) => {
    const args = [`--check=${file}`, `--compile-commands-dir=${dbDir}`, ...extraArgs];
    const child = spawnTracked(clangd, args, { env, stdio: ["ignore", "pipe", "pipe"] });

    let output = "";
    let settled = false;
    // `reason` is used only when the output never said anything about the inferred command
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill(); // no-op when clangd already exited
      resolve(inferenceFromOutput(output) ?? { proxy: null, note: reason });
    };

    const collect = (chunk) => {
      output += chunk.toString("utf8");
      if (inferenceFromOutput(output)) finish("");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => finish(`clangd did not name an inferred command within ${timeoutSec} s`), timeoutSec * 1000);
    child.once("error", (err) => finish(`cannot run clangd: ${err.message}`));
    child.once("close", () => finish("clangd exited without naming an inferred command"));
  });
}

// ============================================================================
//  AGGREGATING
// ============================================================================

/**
 * The most common distinct compile-error messages across all checked files.
 * @param {CheckResult[]} results
 * @param {number} [limit]
 * @returns {{code: string, message: string, count: number, files: number}[]}
 */
export function topErrorMessages(results, limit = 10) {
  /** @type {Map<string, {code: string, message: string, count: number, files: Set<string>}>} */
  const byMessage = new Map();
  for (const r of results) {
    const messages = [...r.diagnostics.map((d) => ({ code: d.code, message: d.message })), ...r.otherErrors.map((m) => ({ code: "harness", message: m }))];
    for (const { code, message } of messages) {
      const key = `${code}\0${message}`;
      if (!byMessage.has(key)) byMessage.set(key, { code, message, count: 0, files: new Set() });
      const row = byMessage.get(key);
      row.count++;
      row.files.add(r.file);
    }
  }
  return [...byMessage.values()]
    .sort((a, b) => b.files.size - a.files.size || b.count - a.count || a.message.localeCompare(b.message))
    .slice(0, limit)
    .map((row) => ({ code: row.code, message: row.message, count: row.count, files: row.files.size }));
}
