// ============================================================================
//  Run query — headless "is it running?" + launch for the LLM/MCP tools.
//
//  Backs o3de_is_running and o3de_run so an assistant can (1) check whether the
//  Editor / GameLauncher is up WITHOUT starting a build -- a running Editor locks
//  gem DLLs and fails the link -- and (2) launch the selected run target for a
//  "build and run" flow. Non-interactive companions to run.ts's UI commands.
//  Deliberately NO force-close here: stopping a running app stays a user action
//  in the O3DE panel, not something the assistant does.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { log } from "../log";
import { BuildOptions, BuildConfig, RunTarget } from "./buildOptions";
import { O3deProject } from "../o3de/identity";
import { firstWorkspaceProject } from "./projectResolve";
import { resolveRunnable, buildInFlightReason } from "./run";
import { runArgsFor, gameLauncherExeName, runTargetExeName, runtimeSweepImages } from "./runCommand";
import { anyImageRunning } from "./processProbe";
import { isPlatformToolsEnabled, platformDisabledMessage } from "../platform/platformSupport";
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
