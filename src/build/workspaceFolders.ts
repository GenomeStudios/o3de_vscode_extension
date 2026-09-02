// ============================================================================
//  Workspace-folder helpers — resolve `${workspaceFolder:…}` references.
//
//  Shared by the IntelliSense remap and the launch.json generator so both refer
//  to the same folders the same way. The `${workspaceFolder:<name>}` form is
//  confirmed working in the user's real multi-root configs.
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { normalizePath } from "../intellisense/paths";

export interface FolderRef {
  path: string;
  name: string;
  ref: string; // "${workspaceFolder:<name>}"
}

/** `${workspaceFolder}` for the project folder itself, else `${workspaceFolder:<name>}`. */
export function folderRef(folderPath: string, folderName: string, projectPath: string): string {
  return normalizePath(folderPath) === normalizePath(projectPath)
    ? "${workspaceFolder}"
    : `\${workspaceFolder:${folderName}}`;
}

/** The workspace's source-engine folder ("Engine (source): …") — the F12 / natvis target. */
export function sourceEngineFolder(): FolderRef | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.name.startsWith("Engine (source):")) {
      return { path: folder.uri.fsPath, name: folder.name, ref: `\${workspaceFolder:${folder.name}}` };
    }
  }
  return undefined;
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
 * Every workspace folder that is an O3DE engine root (has an engine.json), with
 * the "Engine (source): …" folder(s) first. This is the directory the user
 * pointed the extension at, so it outranks anything the global manifest says.
 */
export function workspaceEngineRoots(): string[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) =>
    fs.existsSync(path.join(folder.uri.fsPath, "engine.json")),
  );
  const isSource = (folder: vscode.WorkspaceFolder): number =>
    folder.name.startsWith("Engine (source):") ? 0 : 1;
  return [...folders].sort((a, b) => isSource(a) - isSource(b)).map((folder) => folder.uri.fsPath);
}
