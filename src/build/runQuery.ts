// ============================================================================
//  Run query — headless "is it running?" + launch for the LLM/MCP tools.
//
//  Backs o3de_is_running, o3de_run, o3de_run_debug and o3de_read_run_log so an
//  assistant can (1) check whether the Editor / GameLauncher is up WITHOUT
//  starting a build -- a running Editor locks gem DLLs and fails the link --
//  (2) launch the selected run target, plain or under the C++ debugger, for a
//  "build and run" flow, and (3) read the app's log to see how it went.
//  Non-interactive companions to run.ts's / runDebug.ts's UI commands.
//  Stopping a running app stays a user action (the O3DE panel, the Debug
//  toolbar) except for the gated, opt-in force-close below.
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { log } from "../log";
import { BuildOptions, BuildConfig, RunTarget } from "./buildOptions";
import { O3deProject } from "../o3de/identity";
import { firstWorkspaceProject } from "./projectResolve";
import { resolveRunnable, buildInFlightReason } from "./run";
import { nativeDebugConfig } from "./runDebug";
import { runArgsFor, gameLauncherExeName, runTargetExeName, runtimeSweepImages } from "./runCommand";
import { anyImageRunning, isExePathRunning } from "./processProbe";
import { RunLogKind, LogTail, logKindForTarget, readLogTail, clampTailLines, writtenSince } from "./runLog";
import { isPlatformToolsEnabled, platformDisabledMessage } from "../platform/platformSupport";
import { CPPTOOLS_EXTENSION_ID } from "../constants";
import * as runManager from "./runManager";

// The run-target exes for a project — Editor + its GameLauncher (Stop's sweep
// set) plus whatever the panel's run target resolves to (any executable target),
// so "is it running" tracks the same app Run would launch.
function projectImages(project: O3deProject, runTarget: RunTarget): string[] {
  return [
    ...new Set([
      runTargetExeName("Editor", project.projectName),
      gameLauncherExeName(project.projectName),
      runTargetExeName(runTarget, project.projectName),
    ]),
  ];
}

// ---- Is running (no build) -------------------------------------------------
export interface RunStatus {
  running: boolean;
  tracked: boolean; // launched by this extension (runManager) — instant/robust
  trackedLabel?: string;
  images: string[]; // the exe images checked
  runTarget: RunTarget; // the currently-selected run target
  project?: { name: string; path: string };
  note?: string;
}

/** Whether an O3DE run target is live for the workspace project — without building. */
export async function runStatus(buildOptions: BuildOptions): Promise<RunStatus> {
  const project = firstWorkspaceProject();
  if (!project) {
    return { running: false, tracked: false, images: [], runTarget: buildOptions.runTarget, note: "No O3DE project in this workspace." };
  }
  const images = projectImages(project, buildOptions.runTarget);
  const tracked = runManager.isRunning(project.path);
  const running = tracked || (await anyImageRunning(images));
  return {
    running,
    tracked,
    trackedLabel: runManager.runningLabel(project.path),
    images,
    runTarget: buildOptions.runTarget,
    project: { name: project.projectName, path: project.path },
  };
}

// ---- Launch (detached, non-blocking) ---------------------------------------
export interface LaunchResult {
  launched: boolean;
  target: RunTarget;
  config: BuildConfig;
  pid?: number;
  exe?: string;
  alreadyRunning?: boolean; // tracked app already up — left alone (no force-close)
  reason?: string; // why it did not launch
}

/**
 * Launch the run target detached (panel selection unless overridden), tracked so
 * the user's Stop can force-quit it. Returns immediately; does NOT block. If the
 * app is already tracked-running it is left alone (alreadyRunning) -- this never
 * force-closes anything.
 */
export function launchRunTarget(
  buildOptions: BuildOptions,
  override?: { target?: RunTarget; config?: BuildConfig },
): LaunchResult {
  const target = override?.target ?? buildOptions.runTarget;
  const config = override?.config ?? buildOptions.config;

  if (!isPlatformToolsEnabled()) {
    return { launched: false, target, config, reason: platformDisabledMessage() };
  }
  // Never launch into a half-written build — same rule the panel's Run obeys.
  const building = buildInFlightReason();
  if (building) {
    return { launched: false, target, config, reason: building };
  }
  const project = firstWorkspaceProject();
  if (!project) {
    return { launched: false, target, config, reason: "No O3DE project in this workspace." };
  }
  if (runManager.isRunning(project.path)) {
    return {
      launched: false,
      target,
      config,
      alreadyRunning: true,
      reason: `${runManager.runningLabel(project.path) ?? "An O3DE app"} is already running for ${project.projectName}. Stop it from the O3DE panel first.`,
    };
  }
  const exe = resolveRunnable(project, target, config);
  if (!fs.existsSync(exe)) {
    return {
      launched: false,
      target,
      config,
      exe,
      reason: `${path.basename(exe)} not found for config "${config}". Build the ${target} target first (o3de_build).`,
    };
  }
  const args = runArgsFor(target, project.path, buildOptions.launchArgs);
  const label = `${target} (${project.projectName})`;
  log().info(`Running ${label}: ${exe} ${args.join(" ")}`);
  const pid = runManager.launch(project.path, exe, args, project.path, label);
  return pid > 0
    ? { launched: true, target, config, pid, exe }
    : { launched: false, target, config, exe, reason: "failed to launch (see the O3DE log)." };
}

// ---- Launch settle (wait briefly after a launch, then report) --------------
const SETTLE_POLL_MS = 500;
const SETTLE_LOG_LINES = 40;
const SETTLE_ERROR_LOG_LINES = 20;

export interface LaunchMonitor {
  state: "running" | "exited"; // still tracked as running when the wait ended, or already gone
  waitedSeconds: number;
  log: LogTail | null; // the target's log tail; null for a custom exe (no known log)
  stale: boolean; // the log was last written BEFORE this launch, so its lines are from an earlier run
  // error.log's tail, present ONLY when it was written since this launch: the app hit a fatal error. A crashed
  // Editor can stay alive on its crash dialog, so state "running" alone does not mean the launch survived.
  errorLog?: LogTail;
}

/**
 * After a successful launch: wait up to `settleSeconds` for the app to exit (a startup crash that ends the process
 * shows up as an early exit), checking every 500 ms, then report whether it is still up, the tail of its log, and
 * error.log when it was written since the launch. There is no exit code: the app is spawned detached with its
 * output ignored, so the logs are the evidence. Stops early if `signal` aborts.
 */
export async function monitorLaunch(
  projectPath: string,
  target: RunTarget,
  settleSeconds: number,
  launchedAt: number,
  signal?: AbortSignal,
): Promise<LaunchMonitor> {
  const started = Date.now();
  const deadline = started + settleSeconds * 1000;
  while (runManager.isRunning(projectPath) && Date.now() < deadline && !signal?.aborted) {
    await delay(Math.min(SETTLE_POLL_MS, deadline - Date.now()));
  }

  const kind = logKindForTarget(target);
  const log = kind ? readLogTail(projectPath, kind, SETTLE_LOG_LINES) : null;
  const errorLog = kind ? readLogTail(projectPath, "error", SETTLE_ERROR_LOG_LINES) : undefined;
  return {
    state: runManager.isRunning(projectPath) ? "running" : "exited",
    waitedSeconds: Math.round((Date.now() - started) / 100) / 10,
    log,
    stale: log?.modifiedAt !== undefined && !writtenSince(log, launchedAt),
    errorLog: writtenSince(errorLog, launchedAt) ? errorLog : undefined, // an older error.log is from an earlier run
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Launch under the debugger (headless twin of Run in Debug) -------------
export type DebugBlocked =
  | "platform-unsupported"
  | "build-in-flight"
  | "no-project"
  | "no-debugger" // the C/C++ extension (it ships the C++ debugger) is not installed
  | "already-running" // the exe being debugged is already live, or another debug start is in progress -- left alone
  | "not-built"
  | "start-failed";

export interface DebugLaunchResult {
  started: boolean;
  target: RunTarget;
  config: BuildConfig;
  blocked?: DebugBlocked; // why it did not start
  reason?: string;
  exe?: string;
  args?: string[];
  debugType?: string; // cppvsdbg (Windows) | cppdbg (Linux)
  session?: { name: string; id: string; type: string }; // the debug session that came up
}

// True from the already-running probe until startDebugging settles -- see launchDebugTarget. One project is open at
// a time (firstWorkspaceProject), so one module-level flag is enough.
let debugStarting = false;

/**
 * Start the run target under VS Code's C++ debugger (panel selection unless
 * overridden) -- the same debug configuration as the dashboard's Run in Debug.
 * Never prompts, notifies or installs: every refusal comes back as `blocked`.
 * Resolves once the debug session has started (not when the debuggee exits), so
 * it returns promptly. If the exe being debugged is already running it is left
 * alone (already-running) -- this never closes anything.
 */
export async function launchDebugTarget(
  buildOptions: BuildOptions,
  override?: { target?: RunTarget; config?: BuildConfig },
): Promise<DebugLaunchResult> {
  const target = override?.target ?? buildOptions.runTarget;
  const config = override?.config ?? buildOptions.config;
  const refuse = (blocked: DebugBlocked, reason: string, exe?: string): DebugLaunchResult => ({
    started: false,
    target,
    config,
    blocked,
    reason,
    exe,
  });

  if (!isPlatformToolsEnabled()) {
    return refuse("platform-unsupported", platformDisabledMessage());
  }
  // Never debug into a half-written build -- same rule the panel's Run obeys.
  const building = buildInFlightReason();
  if (building) {
    return refuse("build-in-flight", building);
  }
  const project = firstWorkspaceProject();
  if (!project) {
    return refuse("no-project", "No O3DE project in this workspace.");
  }
  if (!vscode.extensions.getExtension(CPPTOOLS_EXTENSION_ID)) {
    return refuse(
      "no-debugger",
      `Run in Debug needs the Microsoft C/C++ extension (${CPPTOOLS_EXTENSION_ID}), which provides the C++ debugger. ` +
        "It is not installed here. That extension is only offered by Microsoft's VS Code marketplace (it is absent in " +
        "VSCodium, Open VSX editors and Cursor), and this tool never installs it -- ask the user to install it.",
    );
  }
  const exe = resolveRunnable(project, target, config);
  if (!fs.existsSync(exe)) {
    return refuse("not-built", `${path.basename(exe)} not found for config "${config}". Build the ${target} target first (o3de_build).`, exe);
  }
  // One debug start at a time. The debuggee's process does not exist until the debugger has created it, which is
  // after startDebugging is called, so the process probe below cannot see an overlapping second call. There must be
  // no `await` between this check and the flag being set.
  if (debugStarting) {
    return refuse("already-running", "A debug start for this project is already in progress.", exe);
  }
  debugStarting = true;
  let watcher: vscode.Disposable | undefined;
  try {
    // Only the exe being debugged counts: another app (an Editor while debugging the GameLauncher) is fine.
    if (await isExePathRunning(exe)) {
      return refuse(
        "already-running",
        `${path.basename(exe)} is already running. Stop it first (the Debug toolbar, or the O3DE panel's Stop); this tool never closes a running app.`,
        exe,
      );
    }

    const args = runArgsFor(target, project.path, buildOptions.launchArgs);
    const debugConfig = nativeDebugConfig(`O3DE: Debug ${target}`, exe, args, project.path);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.path));
    log().info(`Run in Debug via MCP (${target}): ${exe} ${args.join(" ")}`);

    // Register BEFORE starting so the session event is not missed; dispose once startDebugging settles.
    const sessions: vscode.DebugSession[] = [];
    watcher = vscode.debug.onDidStartDebugSession((session) => {
      if (session.name === debugConfig.name) {
        sessions.push(session);
      }
    });
    const started = await vscode.debug.startDebugging(folder, debugConfig, { suppressSaveBeforeStart: true });
    if (!started) {
      return { ...refuse("start-failed", "VS Code failed to start the C++ debug session (see the O3DE log).", exe), args };
    }
    const session = sessions[0] as vscode.DebugSession | undefined; // undefined only if the event was missed
    return {
      started: true,
      target,
      config,
      exe,
      args,
      debugType: debugConfig.type,
      session: session && { name: session.name, id: session.id, type: session.type },
    };
  } finally {
    debugStarting = false;
    watcher?.dispose();
  }
}

// ---- Read a run log (Editor.log / Game.log / error.log) --------------------
export type RunLogChoice = RunLogKind | "auto";

export interface RunLogReport {
  project?: { name: string; path: string };
  log?: LogTail; // absent without a project
  note?: string;
}

/**
 * The tail of one of the workspace project's O3DE logs. "auto" (the default) reads the log of the selected run
 * target -- Editor.log for the Editor, Game.log for the GameLauncher, Editor.log for a custom exe (it has none).
 */
export function readRunLog(buildOptions: BuildOptions, request: { log?: RunLogChoice; tailLines?: number }): RunLogReport {
  const project = firstWorkspaceProject();
  if (!project) {
    return { note: "No O3DE project in this workspace." };
  }
  const choice = request.log ?? "auto";
  const kind = choice === "auto" ? (logKindForTarget(buildOptions.runTarget) ?? "editor") : choice;
  return {
    project: { name: project.projectName, path: project.path },
    log: readLogTail(project.path, kind, clampTailLines(request.tailLines)),
  };
}

// ---- Force-close (destructive; opt-in + always user-approved) --------------
export interface CloseResult {
  closedTracked: boolean; // an extension-launched app was force-quit (process tree)
  sweptImages: string[]; // O3DE runtime images we swept by name (best-effort)
  project?: { name: string; path: string };
  note?: string;
}

/**
 * Force-quit the O3DE runtime for the workspace project so a build can link
 * (a running Editor locks gem DLLs). Kills the tracked app's whole tree, then
 * sweeps the O3DE runtime images by name (covers apps started outside this
 * session). Best-effort per image (a not-running image is a no-op). Gated by
 * o3de.llm.allowForceClose and marked destructive so the client always confirms.
 */
export async function forceCloseRuntime(): Promise<CloseResult> {
  const project = firstWorkspaceProject();
  if (!project) {
    return { closedTracked: false, sweptImages: [], note: "No O3DE project in this workspace." };
  }
  const closedTracked = await runManager.stop(project.path);
  const images = runtimeSweepImages(project.projectName);
  for (const image of images) {
    await runManager.killByName(image);
  }
  log().info(`Force-closed O3DE runtime for ${project.projectName} (tracked: ${closedTracked}).`);
  return { closedTracked, sweptImages: images, project: { name: project.projectName, path: project.path } };
}
