// ============================================================================
//  Managed commands — the one way this extension runs a long external process.
//
//  Every build / configure / tool invocation goes through here instead of an
//  integrated terminal. Terminals were only ever used because CMake Tools cannot
//  establish the MSVC environment for an O3DE project; we capture that
//  environment ourselves (msvcEnvironment.ts), so a plain spawn is strictly
//  better. What this layer adds over a raw spawn:
//
//    - A KEYED REGISTRY. A second Build while one runs joins the in-flight job
//      instead of starting a rival cmake on the same build tree. (Disposing a
//      terminal did not reliably kill grandchildren -- cmake -> ninja -> cl.exe
//      -- so re-running could leave orphaned compilers behind.)
//    - CANCELLATION that kills the process TREE, replacing the Ctrl+C a
//      terminal used to provide.
//    - SHAPED OUTPUT to a plain channel (outputStream.ts), while the full raw
//      text is still accumulated for the diagnostic parsers.
//    - A change EVENT so the UI can show a running job (buildState.ts).
//
//  There is deliberately NO progress notification. The O3DE tab already carries
//  the progress bar and the Stop control, the output channel carries the detail,
//  and a toast whose only button is "Cancel" is a hazard: it is dismissed by
//  clicking exactly the thing that kills the build.
//
//  RULE: a managed command MUST be non-interactive. stdin is /dev/null, so
//  anything that tries to prompt fails fast with EOF instead of hanging
//  invisibly. Anything that genuinely needs typed input belongs in a terminal
//  (see env/developerTerminal.ts -- the deliberate escape hatch).
// ============================================================================

import { spawn } from "child_process";
import * as vscode from "vscode";
import { log } from "../log";
import { commandOutput } from "./commandOutput";
import { killTree } from "./runManager";
import { formatCommand } from "./configureCommand";
import { OutputFilter, StreamProgress } from "./outputStream";

// ---- Types -----------------------------------------------------------------
/** What kind of work a job represents (drives which UI control reflects it). */
export type JobKind = "build" | "configure" | "classWizard";

export interface CommandResult {
  exitCode: number | null;
  /** The FULL raw output -- unthrottled, for parseBuildOutput and friends. */
  output: string;
  durationMs: number;
  /** True when the job was stopped by the user rather than finishing on its own. */
  cancelled: boolean;
}

export interface ManagedJob {
  readonly key: string;
  readonly kind: JobKind;
  readonly label: string; // human label, e.g. "Build CurvesTest"
  readonly command: string; // the exact command line, for logs + MCP results
  readonly startedAt: number;
  readonly done: Promise<CommandResult>;
  pid: number | undefined;
  cancelled: boolean;
  progress: StreamProgress | undefined;
  /** The most recent line shown in the output channel — the tab's progress read-out. */
  lastLine: string | undefined;
}

export interface ManagedCommandSpec {
  /** Identity. A second start under the same key joins the running job. */
  key: string;
  kind: JobKind;
  label: string;
  argv: string[]; // argv[0] is the executable
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Run through a shell. Needed ONLY for a .cmd/.bat target (Windows spawn
   * cannot execute a batch file directly). Plain executables must leave this
   * off -- no shell means no shell-injection surface at all.
   */
  shell?: boolean;
  /** Echo the shaped stream to the output channel (default true). */
  echo?: boolean;
}

// Floor between change events. Progress is already throttled by the filter, but
// pass-through lines are not, so the UI feed needs its own rate limit.
const ACTIVITY_FIRE_MS = 200;

// ---- Registry --------------------------------------------------------------
const jobs = new Map<string, ManagedJob>();

// Module-level and intentionally never disposed: the registry outlives any one
// view, and activate() owns nothing here. Listeners dispose their own handles.
const changed = new vscode.EventEmitter<void>();

/** Fires whenever a job starts, finishes, or ticks its progress. */
export const onDidChangeJobs = changed.event;

/** The running job for a key, if any. */
export function managedJob(key: string): ManagedJob | undefined {
  return jobs.get(key);
}

/** Every running job. */
export function runningJobs(): ManagedJob[] {
  return [...jobs.values()];
}

/** The first running job of a kind (at most one per kind in practice). */
export function runningJobOfKind(kind: JobKind): ManagedJob | undefined {
  return runningJobs().find((job) => job.kind === kind);
}

// ---- Start / join ----------------------------------------------------------
/**
 * Start `spec` in the background, or return the already-running job for its key.
 * Never rejects: failures surface as `exitCode: null` in the result.
 */
export function startManagedCommand(spec: ManagedCommandSpec): ManagedJob {
  const existing = jobs.get(spec.key);
  if (existing) {
    log().info(`${spec.label}: already running (started ${ageSeconds(existing)}s ago) - joined that job.`);
    return existing;
  }

  const command = formatCommand(spec.argv);
  const out = commandOutput();
  const echo = spec.echo !== false;
  const filter = new OutputFilter();
  const startedAt = Date.now();

  let resolveDone: (result: CommandResult) => void;
  const done = new Promise<CommandResult>((resolve) => {
    resolveDone = resolve;
  });

  const job: ManagedJob = {
    key: spec.key,
    kind: spec.kind,
    label: spec.label,
    command,
    startedAt,
    done,
    pid: undefined,
    cancelled: false,
    progress: undefined,
    lastLine: undefined,
  };
  jobs.set(spec.key, job);

  if (echo) {
    out.appendLine(`=== ${spec.label} ===`);
    out.appendLine(command);
  }

  // stdin is ignored on purpose -- see the RULE in the header.
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    shell: spec.shell === true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.pid = child.pid;

  let raw = "";
  let lastFireAt = 0;

  // The UI read-out follows the newest DISPLAYED line, and the change event is
  // rate-limited independently of the filter: a build can emit thousands of
  // non-progress lines (warnings) that the filter passes straight through, and
  // one webview post per line would be a flood.
  const fireThrottled = (): void => {
    const now = Date.now();
    if (now - lastFireAt >= ACTIVITY_FIRE_MS) {
      lastFireAt = now;
      changed.fire();
    }
  };

  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    raw += text; // full fidelity for the parsers, regardless of display shaping
    const emission = filter.push(text);
    if (echo) {
      for (const line of emission.lines) {
        out.appendLine(line);
      }
    }
    if (emission.progress) {
      job.progress = emission.progress;
    }
    const newest = lastMeaningfulLine(emission.lines);
    if (newest !== undefined) {
      job.lastLine = newest;
    }
    if (emission.progress || newest !== undefined) {
      fireThrottled();
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  const finish = (exitCode: number | null, extra?: string): void => {
    if (extra) {
      raw += extra;
    }
    const emission = filter.flush();
    if (echo) {
      for (const line of emission.lines) {
        out.appendLine(line);
      }
    }
    const durationMs = Date.now() - startedAt;
    jobs.delete(spec.key);
    changed.fire();
    resolveDone({ exitCode, output: raw, durationMs, cancelled: job.cancelled });
  };

  child.on("error", (err) => {
    finish(null, `\n[spawn error] ${String(err)}\n`);
  });
  child.on("close", (code) => {
    finish(code);
  });

  return job;
}

/** Start (or join) and wait for the result. */
export function runManagedCommand(spec: ManagedCommandSpec): Promise<CommandResult> {
  return startManagedCommand(spec).done;
}

// ---- Cancellation ----------------------------------------------------------
/**
 * Stop the job for `key`, killing its whole process tree. cmake spawns ninja
 * which spawns cl.exe, so killing only the direct child would leave compilers
 * running -- the exact orphan problem the terminal had. Returns false when
 * nothing was running.
 */
export async function cancelManagedCommand(key: string): Promise<boolean> {
  const job = jobs.get(key);
  if (!job) {
    return false;
  }
  job.cancelled = true;
  changed.fire(); // let the UI show "stopping" straight away
  if (job.pid !== undefined) {
    await killTree(job.pid);
  }
  log().info(`${job.label}: stopped by the user (process tree killed).`);
  return true;
}

/** Stop whatever job of `kind` is running. Returns false when none was. */
export async function cancelJobOfKind(kind: JobKind): Promise<boolean> {
  const job = runningJobOfKind(kind);
  return job ? cancelManagedCommand(job.key) : false;
}

// ---- Helpers ---------------------------------------------------------------
function ageSeconds(job: ManagedJob): number {
  return Math.round((Date.now() - job.startedAt) / 1000);
}

/** The newest non-blank line of an emission — blanks would clear the read-out. */
function lastMeaningfulLine(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      return lines[i];
    }
  }
  return undefined;
}

/** One-line read-out for a finished managed command (logs / summaries). */
export function describeResult(label: string, result: CommandResult): string {
  if (result.cancelled) {
    return `${label} stopped after ${(result.durationMs / 1000).toFixed(1)}s.`;
  }
  const verb = result.exitCode === 0 ? "succeeded" : `FAILED (exit ${result.exitCode ?? "?"})`;
  return `${label} ${verb} in ${(result.durationMs / 1000).toFixed(1)}s.`;
}
