// ============================================================================
//  IntelliSense health check - running it. vscode-free; the inputs say everything.
//
//    1. read the compile database clangd uses: entries, origins, include dirs on disk
//    2. find clangd and ask its version
//    3. sample files (healthCheck.ts), plus a couple of sources with no entry
//    4. run `clangd --check` on them, two at a time, within a time budget
//    5. assemble the report and its findings (healthReport.ts)
//
//  Only `clangd --check` runs: it builds no index and writes nothing into the project.
//  A check can be cancelled (the AbortSignal) and is bounded (the time budget): files
//  not started in time are reported as skipped, never silently dropped.
// ============================================================================

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CheckOutput,
  DirectoryReader,
  SampledFile,
  buildOutputRoots,
  checkArguments,
  classifyEntries,
  databaseToolchain,
  describeError,
  findEntrylessSources,
  missingIncludeDirs,
  parseCheckOutput,
  parseClangdVersion,
  pickSample,
  readDatabaseFile,
} from "./healthCheck";
import {
  CHECK_CONCURRENCY,
  CHECK_TIMEOUT_MS,
  FileCheck,
  HealthInputs,
  HealthOptions,
  HealthReport,
  HealthSummary,
  MAX_ENTRYLESS,
  MAX_ERROR_LINES,
  MAX_EXAMPLES,
  PartialReason,
} from "./healthModel";
import { engineHint, healthFindings } from "./healthReport";
import { isUnderRoot } from "./paths";
import { COMPILE_DATABASE_FILE } from "./userDatabase";

// ---- Running a process -----------------------------------------------------
export interface ProcessResult {
  text: string; // stderr then stdout: clangd --check logs to stderr
  timedOut: boolean;
  cancelled: boolean;
  failed?: string; // it could not be started
}

export interface ProcessOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export type ProcessRunner = (command: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>;

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Why a process could not be started. Windows refuses a .cmd/.bat wrapper without a shell, so that case says what to do. */
function startFailure(command: string, error: unknown, platform: NodeJS.Platform): string {
  const message = error instanceof Error ? error.message : String(error);
  return platform === "win32" && /\.(cmd|bat)$/i.test(command) ? `${message} - a .cmd/.bat wrapper can't be started directly; point clangd.path at clangd.exe` : message;
}

/**
 * A process runner over `exec` (child_process.execFile; injectable for tests). Never rejects: a clangd that exits 1 because
 * it found errors is an ordinary result, and one that cannot be started - including a start that throws at once, as a
 * .cmd/.bat does on Windows (EINVAL) - is the `failed` outcome.
 */
export function createProcessRunner(exec: typeof execFile = execFile, platform: NodeJS.Platform = process.platform): ProcessRunner {
  return (command, args, options) =>
    new Promise((resolve) => {
      try {
        exec(
          command,
          args,
          { timeout: options.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, signal: options.signal, cwd: os.tmpdir() },
          (error, stdout, stderr) => {
            const text = `${stderr}${stdout}`;
            const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
            if (options.signal?.aborted) {
              resolve({ text, timedOut: false, cancelled: true });
            } else if (failure?.killed) {
              resolve({ text, timedOut: true, cancelled: false });
            } else if (failure && typeof failure.code === "string") {
              resolve({ text, timedOut: false, cancelled: false, failed: startFailure(command, failure, platform) }); // ENOENT, EACCES ...
            } else {
              resolve({ text, timedOut: false, cancelled: false });
            }
          },
        );
      } catch (err) {
        resolve({ text: "", timedOut: false, cancelled: false, failed: startFailure(command, err, platform) });
      }
    });
}

export const runProcess: ProcessRunner = createProcessRunner();

export interface HealthDeps {
  run: ProcessRunner;
  exists: (file: string) => boolean;
  readDirectory?: DirectoryReader;
}

// ---- clangd ----------------------------------------------------------------
const VERSION_TIMEOUT_MS = 10_000;

async function probeClangd(inputs: HealthInputs, options: HealthOptions, run: ProcessRunner): Promise<HealthReport["clangd"]> {
  const located = inputs.clangd;
  if (!located) {
    return { found: false, problem: "No clangd was found: not in clangd.path, not in the clangd extension's download folder and not on PATH." };
  }
  const result = await run(located.path, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS, signal: options.signal });
  const version = parseClangdVersion(result.text);
  return version
    ? { found: true, path: located.path, source: located.source, version }
    : {
        found: false,
        path: located.path,
        source: located.source,
        problem: `clangd was found at ${located.path}, but it didn't start${result.failed ? `: ${result.failed}` : ""}.`,
      };
}

// ---- Checking files --------------------------------------------------------
const MIN_RUN_MS = 3_000; // a file started with less than this left would only time out

function seconds(from: number): number {
  return Math.round((Date.now() - from) / 100) / 10;
}

/** The first line clangd printed at error level that isn't a compile error: why it stopped. */
function stopReason(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => /^[EF]\[/.test(candidate));
  return line ? `clangd stopped before finishing: ${line.replace(/^[EF]\[[\d:.]+\]\s*/, "")}` : "clangd stopped before finishing.";
}

function fileCheck(sample: SampledFile, parsed: CheckOutput | undefined, started: number): FileCheck {
  const errors = parsed?.errors ?? [];
  return {
    file: sample.file,
    origin: sample.origin,
    status: errors.length > 0 ? "errors" : "ok",
    command: parsed?.command ?? "unknown",
    inferredFrom: parsed?.inferredFrom,
    errorCount: errors.length,
    firstErrors: errors.slice(0, MAX_ERROR_LINES).map(describeError),
    seconds: seconds(started),
  };
}

interface CheckContext {
  clangd: string;
  databaseDir: string;
  extraArguments: string[];
  deadline: number;
  options: HealthOptions;
  run: ProcessRunner;
}

/** The skipped outcome of a file: never run, or (with `ran`) cut off by the time budget while it ran. */
function skipped(sample: SampledFile, reason: PartialReason, ran?: { seconds: number }): FileCheck {
  const note = ran
    ? "The time budget ran out while this file was being checked."
    : reason === "cancelled"
      ? "The check was cancelled before this file."
      : "The time budget ran out before this file was reached.";
  return { file: sample.file, origin: sample.origin, status: "skipped", command: "unknown", errorCount: 0, firstErrors: [], seconds: ran?.seconds ?? 0, note };
}

async function checkOne(sample: SampledFile, context: CheckContext): Promise<{ check: FileCheck; skippedFor?: PartialReason }> {
  if (context.options.signal?.aborted) {
    return { check: skipped(sample, "cancelled"), skippedFor: "cancelled" };
  }
  const remaining = context.deadline - Date.now();
  if (remaining < MIN_RUN_MS) {
    return { check: skipped(sample, "timeBudget"), skippedFor: "timeBudget" };
  }
  const timeoutMs = Math.min(CHECK_TIMEOUT_MS, remaining);
  const started = Date.now();
  const args = checkArguments(path.normalize(sample.file), context.databaseDir, context.extraArguments);
  const result = await context.run(context.clangd, args, { timeoutMs, signal: context.options.signal });

  if (result.cancelled) {
    return { check: skipped(sample, "cancelled"), skippedFor: "cancelled" };
  }
  const base = fileCheck(sample, undefined, started);
  if (result.failed) {
    return { check: { ...base, status: "failed", note: `clangd could not be run: ${result.failed}` } };
  }
  if (result.timedOut) {
    // The budget, not the per-file limit, cut it off: a smaller sample is the answer, not a slow clangd.
    if (remaining < CHECK_TIMEOUT_MS) {
      return { check: skipped(sample, "timeBudget", { seconds: base.seconds }), skippedFor: "timeBudget" };
    }
    return { check: { ...base, status: "timedOut", note: `clangd didn't finish within ${Math.round(timeoutMs / 1000)} s.` } };
  }
  const parsed = parseCheckOutput(result.text);
  if (!parsed.completed && parsed.errors.length === 0) {
    return { check: { ...fileCheck(sample, parsed, started), status: "failed", note: stopReason(result.text) } };
  }
  return { check: fileCheck(sample, parsed, started) };
}

/** Run the checks `CHECK_CONCURRENCY` at a time, in sample order. */
async function checkFiles(
  sample: SampledFile[],
  context: CheckContext,
): Promise<{ files: FileCheck[]; partial?: HealthReport["partial"] }> {
  const files: FileCheck[] = new Array<FileCheck>(sample.length);
  const skippedFor: PartialReason[] = [];
  let next = 0;
  let checked = 0;
  context.options.onProgress?.(0, sample.length);

  const worker = async (): Promise<void> => {
    while (next < sample.length) {
      const index = next++;
      const outcome = await checkOne(sample[index], context);
      files[index] = outcome.check;
      if (outcome.skippedFor) {
        skippedFor.push(outcome.skippedFor);
      }
      checked += 1;
      context.options.onProgress?.(checked, sample.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, sample.length) }, worker));

  const reason = skippedFor.includes("cancelled") ? "cancelled" : skippedFor[0];
  return { files, partial: reason ? { reason, skipped: skippedFor.length } : undefined };
}

export function summarize(files: FileCheck[]): HealthSummary {
  const checked = files.filter((file) => file.status === "ok" || file.status === "errors");
  return {
    sampled: files.length,
    clean: files.filter((file) => file.status === "ok").length,
    withErrors: files.filter((file) => file.status === "errors").length,
    notChecked: files.length - checked.length,
    withoutEntry: checked.filter((file) => file.command === "inferred").length,
  };
}

// ---- Include directories ---------------------------------------------------
/** Missing include dirs split by whether they sit in a folder a build writes (made by a build: Qt's *_autogen/include, for one). */
function splitBuildOutputs(missing: string[], buildRoots: string[]): { generated: string[]; other: string[] } {
  const generated = missing.filter((dir) => buildRoots.some((root) => isUnderRoot(dir, root)));
  return { generated, other: missing.filter((dir) => !generated.includes(dir)) };
}

// ---- The health check ------------------------------------------------------
/** Run the whole check. Never throws for a problem in the user's setup: it is reported (`findings`). */
export async function runHealthCheck(inputs: HealthInputs, options: HealthOptions, deps: Partial<HealthDeps> = {}): Promise<HealthReport> {
  const run = deps.run ?? runProcess;
  const exists = deps.exists ?? fs.existsSync;
  const started = Date.now();

  // The database clangd reads.
  const file = path.join(inputs.database.dir, COMPILE_DATABASE_FILE);
  const read = readDatabaseFile(file);
  const entries = read.ok ? read.entries : [];
  const classified = classifyEntries(entries, inputs.roots);
  const toolchain = databaseToolchain(entries);
  const includeDirs = toolchain ? missingIncludeDirs(entries, toolchain.style, exists, inputs.platform) : { checked: 0, missing: [] };
  const buildRoots = buildOutputRoots({ entries, buildDir: inputs.buildDir, databaseDir: inputs.database.dir, exists });
  const { generated, other } = splitBuildOutputs(includeDirs.missing, buildRoots);

  // clangd, then the files.
  const clangd = await probeClangd(inputs, options, run);
  let files: FileCheck[] = [];
  let partial: HealthReport["partial"];
  if (clangd.found && clangd.path && entries.length > 0) {
    const sample = pickSample(classified.files, inputs.sampleSize);
    if (inputs.includeEntryless) {
      const caseKey = (name: string): string => (inputs.platform === "linux" ? name : name.toLowerCase());
      const listed = new Set(entries.map((entry) => caseKey(entry.file)));
      const unlisted = findEntrylessSources(inputs.scanRoots, (name) => listed.has(caseKey(name)), MAX_ENTRYLESS, inputs.platform, deps.readDirectory);
      sample.push(...unlisted.map((name): SampledFile => ({ file: name, origin: "noEntry" })));
    }
    const context: CheckContext = {
      clangd: clangd.path,
      databaseDir: inputs.database.dir,
      extraArguments: inputs.clangdArguments,
      deadline: started + options.maxTotalMs,
      options,
      run,
    };
    ({ files, partial } = await checkFiles(sample, context));
  }

  const report: HealthReport = {
    extensionVersion: inputs.extensionVersion,
    platform: inputs.platform,
    project: inputs.project,
    intellisenseEngine: inputs.intellisenseEngine,
    clangd,
    toolchain,
    database: {
      dir: inputs.database.dir,
      file,
      kind: inputs.database.kind,
      inUse: inputs.database.inUse,
      exists: read.ok || read.reason !== "missing",
      problem: read.ok ? undefined : read.reason === "unreadable" ? read.message : undefined,
      entries: entries.length,
      origins: classified.counts,
      skippedManifestGems: inputs.roots.skippedManifestGems,
      includeDirs: {
        checked: includeDirs.checked,
        missing: includeDirs.missing.length,
        inBuildFolder: generated.length,
        examples: [...other, ...generated].slice(0, MAX_EXAMPLES), // the ones a build won't fix first
      },
    },
    engine: {
      mode: inputs.engine.mode,
      sourceEngine: inputs.engine.sourceEngineName,
      coverage: inputs.engine.coverage,
      hint: engineHint(inputs.engine.mode, inputs.engine.remedyAvailable),
    },
    files,
    summary: summarize(files),
    partial,
    findings: [],
  };
  report.findings = healthFindings(report);
  return report;
}
