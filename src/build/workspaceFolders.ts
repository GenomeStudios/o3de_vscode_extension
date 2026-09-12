// ============================================================================
//  Workspace-folder helpers — resolve `${workspaceFolder:…}` references.
//
//  Shared by the IntelliSense remap and the launch.json generator so both refer
//  to the same folders the same way. The `${workspaceFolder:<name>}` form is
//  confirmed working in the user's real multi-root configs.
//
//  Source-engine selection is STRUCTURAL (does the folder carry a non-SDK
//  engine.json), never name-based. A hand-built workspace names its folders
//  whatever it likes; the redirect has to work there too.
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { O3deEngine, readEngine } from "../o3de/identity";
import { normalizePath } from "../intellisense/paths";

// ---- Model -----------------------------------------------------------------
export interface FolderRef {
  path: string;
  name: string;
  ref: string; // "${workspaceFolder:<name>}"
}

/** A workspace folder reduced to what engine selection needs (vscode-free). */
export interface FolderCandidate {
  path: string;
  name: string;
}

/** The name our Setup Workspace command gives the source-engine folder.
 *  A TIE-BREAK HINT ONLY — never a gate. Gating on it silently disabled the
 *  engine redirect on every hand-built or pre-convention workspace. */
const SOURCE_ENGINE_NAME_HINT = "Engine (source):";

// ---- Pure selection (testable without vscode) ------------------------------
/** Rank a folder as an F12 target: named source engine (0), source engine (1), anything else (2).
 *  An SDK engine ships headers only, so it can never be a step-through destination. */
function engineRank(folder: FolderCandidate, readEngineAt: (dir: string) => O3deEngine | undefined): number {
  const engine = readEngineAt(folder.path);
  if (!engine || engine.isSdkEngine) {
    return 2;
  }
  return folder.name.startsWith(SOURCE_ENGINE_NAME_HINT) ? 0 : 1;
}

/**
 * Every source-engine folder among these, named ones first (stable otherwise).
 * THE single definition of "a source engine in the workspace" — the onboarding check, the
 * IntelliSense redirect and the engine-mode status all go through here. Two separate
 * lookups once disagreed (onboarding said yes while the redirect silently did nothing).
 * Qualifies STRUCTURALLY: an engine.json that does not declare `sdk_engine: true`.
 * `readEngineAt` is injected so this stays pure and unit-testable.
 */
export function sourceEngineFolders(
  folders: FolderCandidate[],
  readEngineAt: (dir: string) => O3deEngine | undefined = readEngine,
): FolderCandidate[] {
  return folders
    .map((folder) => ({ folder, rank: engineRank(folder, readEngineAt) }))
    .filter((entry) => entry.rank < 2)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.folder);
}

/** The preferred source engine among these folders, or undefined when none carries one. */
export function pickSourceEngineFolder(
  folders: FolderCandidate[],
  readEngineAt: (dir: string) => O3deEngine | undefined = readEngine,
): FolderCandidate | undefined {
  return sourceEngineFolders(folders, readEngineAt)[0];
}

/** Engine folders with SOURCE engines first — the order callers treat as preference. */
export function orderEngineRootsSourceFirst(
  folders: FolderCandidate[],
  readEngineAt: (dir: string) => O3deEngine | undefined = readEngine,
): FolderCandidate[] {
  return [...folders].sort((a, b) => engineRank(a, readEngineAt) - engineRank(b, readEngineAt));
}

// ---- vscode-facing wrappers ------------------------------------------------
/** `${workspaceFolder}` for the project folder itself, else `${workspaceFolder:<name>}`. */
export function folderRef(folderPath: string, folderName: string, projectPath: string): string {
  return normalizePath(folderPath) === normalizePath(projectPath)
    ? "${workspaceFolder}"
    : `\${workspaceFolder:${folderName}}`;
}

/** Every workspace folder, as selection candidates. */
function folderCandidates(): FolderCandidate[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    path: folder.uri.fsPath,
    name: folder.name,
  }));
}

/** Every source engine in the workspace, preferred first. */
export function workspaceSourceEngines(): O3deEngine[] {
  return sourceEngineFolders(folderCandidates())
    .map((folder) => readEngine(folder.path))
    .filter((engine): engine is O3deEngine => engine !== undefined);
}

/** The workspace's source-engine folder — the F12 / natvis target. */
export function sourceEngineFolder(): FolderRef | undefined {
  const picked = pickSourceEngineFolder(folderCandidates());
  if (!picked) {
    return undefined;
  }
  return { path: picked.path, name: picked.name, ref: `\${workspaceFolder:${picked.name}}` };
}

/** The workspace folder whose root contains `absPath`, if any (build-engine → folder ref). */
export function workspaceFolderForPath(absPath: string): FolderRef | undefined {
  const target = normalizePath(absPath).toLowerCase();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = normalizePath(folder.uri.fsPath).replace(/\/+$/, "").toLowerCase();
    if (target === root || target.startsWith(`${root}/`)) {
      return { path: folder.uri.fsPath, name: folder.name, ref: `\${workspaceFolder:${folder.name}}` };
    }
  }
  return undefined;
}

/**
 * Every workspace folder that is an O3DE engine root (has an engine.json), source
 * engines first. This is the directory the user pointed the extension at, so it
 * outranks anything the global manifest says.
 */
export function workspaceEngineRoots(): string[] {
  const engineFolders = folderCandidates().filter((folder) =>
    fs.existsSync(path.join(folder.path, "engine.json")),
  );
  return orderEngineRootsSourceFirst(engineFolders).map((folder) => folder.path);
}
