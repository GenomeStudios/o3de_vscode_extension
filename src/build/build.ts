// ============================================================================
//  Build (interactive) — the tab's Build button and “O3DE: Build”.
//
//  A thin POLICY wrapper over the shared core in buildRun.ts. The core owns the
//  preconditions and the actual cmake invocation; this file owns only what makes
//  the interactive path different from the MCP one:
//    - ask which project when the workspace holds several;
//    - turn each BuildBlockedReason into the right prompt or message;
//    - report the outcome (and reveal the output channel on failure).
//
//  No terminal: the build streams to the “O3DE Build Output” channel and is
//  stopped from the tab's Build/Stop toggle (see buildState.ts) or the progress
//  notification. Replaces the user's build .bats natively.
// ============================================================================

import * as vscode from "vscode";
import { log } from "../log";
import { commandOutput } from "./commandOutput";
import { BuildOptions } from "./buildOptions";
import { resolveWorkspaceProject } from "./projectResolve";
import { targetsLabel } from "./buildCommand";
import { configureProject } from "./configure";
import { buildJobKey } from "./buildRun";
import { startBuildJob } from "./buildJobs";
import { cancelManagedCommand, managedJob } from "./managedCommand";
import { BuildResult } from "./buildOutput";

// ---- Command ---------------------------------------------------------------
export async function buildProject(options: BuildOptions): Promise<void> {
  if (process.platform !== "win32") {
    void vscode.window.showInformationMessage("O3DE: Build currently targets Windows (MSVC).");
    return;
  }

  const project = await resolveWorkspaceProject("O3DE: Build");
  if (!project) {
    return;
  }

  log().info(`Building ${project.projectName} — targets=[${targetsLabel(options.targets)}], config=${options.config}`);

  // Registered as a BuildJob (not called directly) so an assistant asking
  // o3de_build_status / o3de_build_log sees the build the user just started.
  const result = await startBuildJob({
    generator: options.generator,
    config: options.config,
    targets: options.targets,
    coreCount: options.coreCount,
    interactive: true,
    project,
  }).done;

  if (result.blocked) {
    await reportBlocked(result, options);
    return;
  }
  reportOutcome(result);
}

/** Stop the running build for the workspace's project (its whole process tree). */
export async function stopBuild(): Promise<boolean> {
  const project = await resolveWorkspaceProject("O3DE: Stop Build");
  if (!project) {
    return false;
  }
  return cancelManagedCommand(buildJobKey(project.path));
}

/** Is a build running for the given project? (Cheap; no prompt.) */
export function isBuildRunning(projectPath: string): boolean {
  return managedJob(buildJobKey(projectPath)) !== undefined;
}

// ---- Blocked-precondition policy -------------------------------------------
// The core reports WHY it could not build; the interactive path decides what to
// do about it. Only "not-configured" is recoverable in one click.
async function reportBlocked(result: BuildResult, options: BuildOptions): Promise<void> {
  log().info(`Build not started — ${result.summary}`);

  if (result.blocked === "not-configured") {
    const choice = await vscode.window.showWarningMessage(
      `${result.summary} Configure first, then run Build again once it finishes.`,
      "Configure Now",
      "Cancel",
    );
    if (choice === "Configure Now") {
      await configureProject(options);
    }
    return;
  }

  if (result.blocked === "busy") {
    void vscode.window.showInformationMessage(
      "O3DE: a build is already running — use Stop Build to cancel it.",
      "Show Output",
    ).then((choice) => {
      if (choice === "Show Output") {
        commandOutput().show(true);
      }
    });
    return;
  }

  // editor-running is already handled interactively by the core's process-guard
  // (the user chose Cancel), so it needs no second dialog.
  if (result.blocked === "editor-running") {
    return;
  }

  void vscode.window.showErrorMessage(`O3DE: ${result.summary}`);
}

// ---- Outcome ---------------------------------------------------------------
function reportOutcome(result: BuildResult): void {
  if (result.cancelled) {
    void vscode.window.showInformationMessage("O3DE: build stopped.");
    return;
  }
  if (result.ok) {
    const warn = result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : "";
    void vscode.window.showInformationMessage(`O3DE: ${result.summary.replace(/^Build /, "build ")}${warn}`);
    return;
  }
  // Failed: lead with the first real diagnostic — it's what the user needs.
  const first = result.errors[0];
  const detail = first ? `${first.code ?? ""} ${first.message}`.trim() : "see the output for details";
  void vscode.window
    .showErrorMessage(`O3DE: build failed — ${detail}`, "Show Output")
    .then((choice) => {
      if (choice === "Show Output") {
        commandOutput().show(true);
      }
    });
}
