// ============================================================================
//  Engine mode — how far C++ navigation reaches into the engine, and why.
//
//  Four modes, decided by two facts: is the BUILD engine an SDK (headers only),
//  and is there a SOURCE engine in the workspace to redirect navigation to?
//
//    native       build engine is a source engine — engine code is in the build
//    redirected   SDK build engine + source engine in the workspace (remap active)
//    headersOnly  SDK build engine, nothing to redirect to — no engine .cpp exists
//    unresolved   no project, or its engine cannot be resolved
//
//  Both facts are resolved the SAME way the remap resolves them
//  (detectBuildEngineRoot + pickSourceEngineFolder), so this status can never
//  disagree with what the redirect actually does.
// ============================================================================

import * as vscode from "vscode";
import { O3deEngine, O3deProject, readEngine, readProject } from "../o3de/identity";
import { discoverSourceEngines } from "../o3de/discovery";
import { sourceEngineFolder } from "../build/workspaceFolders";
import { primaryO3deFolder } from "../workspace/projectScope";
import { detectBuildEngineRoot } from "./engineRoot";

// ---- Model -----------------------------------------------------------------
export type EngineMode = "native" | "redirected" | "headersOnly" | "unresolved";

export interface EngineIdentity {
  name: string;
  path: string;
  version?: string; // information only — never used to gate anything
}

export interface EngineModeReport {
  mode: EngineMode;
  buildEngine?: EngineIdentity;
  sourceEngine?: EngineIdentity; // set only when navigation is redirected to it
  /** headersOnly: a source engine IS registered, so Set Up Workspace could add it.
   *  False everywhere else — the UI must never offer a remedy that does not exist. */
  remedyAvailable: boolean;
}

function identity(engine: O3deEngine): EngineIdentity {
  return { name: engine.engineName, path: engine.path, version: engine.version };
}

// ---- Pure resolution -------------------------------------------------------
/**
 * Classify the engine mode from already-resolved inputs.
 * @param buildEngine      the engine the project builds against
 * @param workspaceSource  the preferred source engine in the workspace, if any
 * @param sourceRegistered whether any source engine is registered on this machine
 */
export function resolveEngineMode(
  buildEngine: O3deEngine | undefined,
  workspaceSource: O3deEngine | undefined,
  sourceRegistered: boolean,
): EngineModeReport {
  if (!buildEngine) {
    return { mode: "unresolved", remedyAvailable: false };
  }
  if (!buildEngine.isSdkEngine) {
    return { mode: "native", buildEngine: identity(buildEngine), remedyAvailable: false };
  }
  if (workspaceSource) {
    return {
      mode: "redirected",
      buildEngine: identity(buildEngine),
      sourceEngine: identity(workspaceSource),
      remedyAvailable: false,
    };
  }
  return { mode: "headersOnly", buildEngine: identity(buildEngine), remedyAvailable: sourceRegistered };
}

// ---- Copy ------------------------------------------------------------------
/** Short value text for a dashboard row (the row label carries the noun). */
export function engineModeLabel(report: EngineModeReport): string {
  switch (report.mode) {
    case "native":
      return "Indexed (source engine)";
    case "redirected":
      return `Redirected to ${report.sourceEngine?.name ?? "source engine"}`;
    case "headersOnly":
      return "Headers only (SDK engine)";
    case "unresolved":
      return "Not resolved";
  }
}

/**
 * One full sentence for logs and tooltips. Headers-only names the capability that is
 * actually lost and never implies it is an indexing problem we could fix — the .cpp
 * files do not exist in an SDK install.
 */
export function engineModeDetail(report: EngineModeReport): string {
  const build = report.buildEngine?.name ?? "the engine";
  switch (report.mode) {
    case "native":
      return `Builds against source engine ${build}: engine code is part of the build, so Go to Definition reaches it directly.`;
    case "redirected":
      return (
        `Builds against SDK engine ${build}, which ships headers only; ` +
        `engine navigation is redirected to source engine ${report.sourceEngine?.name ?? "(unknown)"} in this workspace.`
      );
    case "headersOnly":
      return (
        `Builds against SDK engine ${build}, which ships headers only: Go to Definition cannot reach engine implementation. ` +
        (report.remedyAvailable
          ? "A source engine is registered on this machine; add it to the workspace with Set Up Workspace… to enable it."
          : "No source engine is registered on this machine.")
      );
    case "unresolved":
      return "No O3DE project in this workspace, or its engine could not be resolved.";
  }
}

// ---- Workspace detection ---------------------------------------------------
/** The engine mode for a project in the current workspace. `includePaths` sharpen build-engine
 *  detection when a File API reply is loaded; without them the project.json engine is used. */
export function detectEngineMode(project: O3deProject | undefined, includePaths: string[] = []): EngineModeReport {
  const buildRoot = project ? detectBuildEngineRoot(project, includePaths) : undefined;
  const buildEngine = buildRoot ? readEngine(buildRoot) : undefined;
  const sourceFolder = sourceEngineFolder();
  const workspaceSource = sourceFolder ? readEngine(sourceFolder.path) : undefined;
  return resolveEngineMode(buildEngine, workspaceSource, discoverSourceEngines().length > 0);
}

/** The engine mode for the workspace's primary O3DE project. Never prompts — safe for status readouts. */
export function workspaceEngineMode(): EngineModeReport {
  const folder = primaryO3deFolder();
  return detectEngineMode(folder ? readProject(folder.uri.fsPath) : undefined);
}

// ---- Command ---------------------------------------------------------------
const SET_UP_WORKSPACE = "Set Up Workspace…";

/** "O3DE: Show IntelliSense Engine Mode" — explain the mode; offer the remedy only when it exists. */
export async function showEngineMode(): Promise<void> {
  const report = workspaceEngineMode();
  const actions = report.remedyAvailable ? [SET_UP_WORKSPACE] : [];
  const choice = await vscode.window.showInformationMessage(engineModeDetail(report), ...actions);
  if (choice === SET_UP_WORKSPACE) {
    await vscode.commands.executeCommand("o3de.setupWorkspace");
  }
}
