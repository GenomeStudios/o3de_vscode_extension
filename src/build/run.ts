// ============================================================================
//  Run — launch a built target and force-quit it (build_launch B.5).
//
//  The companion to Build: launches the selected run target (Editor or the
//  project's GameLauncher) detached, with the user's optional launch options,
//  and tracks it so Stop can force-quit the whole process tree. The Editor exe
//  is resolved by engine type (SDK/prebuilt → engine bin; source → project
//  build) via the same helper the launch.json generator uses, and the choice is
//  logged. Windows-focused, mirroring Build/Configure.
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { log } from "../log";
import { BuildOptions, RunTarget } from "./buildOptions";
import { O3deProject } from "../o3de/identity";
import { resolveProjectEngine } from "../o3de/discovery";
import { resolveWorkspaceProject } from "./projectResolve";
import { runArgsFor, projectRuntimeExe, runTargetExeName, gameLauncherExeName, editorExeCandidates } from "./runCommand";
import { runningJobOfKind } from "./managedCommand";
import * as runManager from "./runManager";

// ---- Build-in-flight guard -------------------------------------------------
/**
 * Why launching must be refused right now, or undefined when it's safe.
 *
 * The mirror of the process-guard: that one stops a build while the Editor holds
 * gem DLLs, this one stops a launch while the build is still writing them. Mid-
 * link the exe and its gem DLLs are inconsistent, so an app started now either
 * fails to load or loads half of the previous build — which then reads as a bug
 * in the code rather than in the timing.
 *
 * Shared by every launch path (Run, Run in Debug, and MCP o3de_run) so the rule
 * cannot be sidestepped by a hotkey or an assistant.
 */
export function buildInFlightReason(): string | undefined {
  const job = runningJobOfKind("build");
  return job
    ? `${job.label} is still running — its binaries are being written. Stop the build (or wait for it) before launching.`
    : undefined;
}

// ---- Runtime-exe resolution (SDK engine → engine prebuilt; source → project build) ----
function resolveEditorExe(project: O3deProject, config: string): string {
  const candidates = editorExeCandidates(resolveProjectEngine(project), project.path, config);
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

/**
 * Resolve the exe to launch for a run target. The Editor is engine-aware (SDK
 * engine → engine prebuilt; source → project build); every other target —
 * GameLauncher or any executable target picked in the Run Target picker — is
 * its exe in the project's build output.
 */
export function resolveRunnable(project: O3deProject, target: RunTarget, config: string): string {
  return target === "Editor"
    ? resolveEditorExe(project, config)
    : projectRuntimeExe(project.path, config, runTargetExeName(target, project.projectName));
}

// ---- Diagnostics: log HOW we resolved the exe (SDK vs source + candidates) --
function logRunResolution(project: O3deProject, target: RunTarget, config: string): void {
  if (target !== "Editor") {
    log().info(`Run target: ${target} → project build output.`);
    return;
  }
  const engine = resolveProjectEngine(project);
  const kind = engine?.isSdkEngine
    ? `SDK/prebuilt engine "${engine.engineName}" → engine prebuilt bin`
    : engine
      ? `source/custom engine "${engine.engineName}" → project build output`
      : `engine UNRESOLVED (project.json engine="${project.engine ?? "?"}") → project build output`;
  log().info(`Run target: Editor — detected ${kind}${engine ? ` (${engine.path})` : ""}.`);
  const candidates = editorExeCandidates(engine, project.path, config);
  candidates.forEach((c) => log().info(`  candidate: ${c}${fs.existsSync(c) ? " [exists]" : " [missing]"}`));
}

// ---- Command: Run ----------------------------------------------------------
export async function runProject(options: BuildOptions): Promise<void> {
  if (process.platform !== "win32") {
    void vscode.window.showInformationMessage("O3DE: Run currently targets Windows.");
    return;
  }

  const blocked = buildInFlightReason();
  if (blocked) {
    void vscode.window.showWarningMessage(`O3DE: ${blocked}`);
    return;
  }

  const project = await resolveWorkspaceProject("O3DE: Run");
  if (!project) {
    return;
  }

  // One tracked run per project — offer to restart if it's already up.
  if (runManager.isRunning(project.path)) {
    const choice = await vscode.window.showWarningMessage(
      `${runManager.runningLabel(project.path)} is already running for ${project.projectName}.`,
      "Restart",
      "Cancel",
    );
    if (choice !== "Restart") {
      return;
    }
    await runManager.stop(project.path);
  }

  const target = options.runTarget;
  const exe = resolveRunnable(project, target, options.config);
  logRunResolution(project, target, options.config);
  if (!fs.existsSync(exe)) {
    const choice = await vscode.window.showErrorMessage(
      `O3DE: ${path.basename(exe)} not found for config "${options.config}". Build the ${target} target first.`,
      "Build",
      "Cancel",
    );
    if (choice === "Build") {
      await vscode.commands.executeCommand("o3de.build");
    }
    return;
  }

  const args = runArgsFor(target, project.path, options.launchArgs);
  const label = `${target} (${project.projectName})`;
  log().info(`Running ${label}: ${exe} ${args.join(" ")}`);

  const pid = runManager.launch(project.path, exe, args, project.path, label);
  if (pid > 0) {
    void vscode.window.showInformationMessage(
      `O3DE: launched ${target} (pid ${pid}). Use Stop to force-quit it and its child processes.`,
    );
  } else {
    void vscode.window.showErrorMessage(`O3DE: failed to launch ${target} (see the O3DE log).`);
  }
}

// ---- Command: Stop (force-quit) --------------------------------------------
export async function stopRun(): Promise<void> {
  const project = await resolveWorkspaceProject("O3DE: Stop");
  if (!project) {
    return;
  }

  // Tracked run → force-quit its whole tree (kills the parallel helpers too).
  if (await runManager.stop(project.path)) {
    void vscode.window.showInformationMessage(
      `O3DE: force-quit the running app for ${project.projectName}.`,
    );
    return;
  }

  // Nothing tracked — offer an orphan sweep by image name (covers apps we didn't launch).
  const choice = await vscode.window.showWarningMessage(
    `No O3DE app is tracked for ${project.projectName}. Force-quit any running ` +
      "Editor / GameLauncher / AssetProcessor / ScriptCanvas?",
    { modal: true },
    "Force-Quit All",
  );
  if (choice !== "Force-Quit All") {
    return;
  }
  const images = [
    "Editor.exe",
    gameLauncherExeName(project.projectName),
    "AssetProcessor.exe",
    "ScriptCanvasApplication.exe",
  ];
  for (const image of images) {
    await runManager.killByName(image);
  }
  void vscode.window.showInformationMessage("O3DE: swept O3DE runtime processes.");
}
