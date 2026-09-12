// ============================================================================
//  Stale cpptools settings — clear `C_Cpp.default.compileCommands` entries that
//  point at a file which no longer exists.
//
//  The rejected n_cc approach left workspaces pointing cpptools at a separate
//  non-unity build's compile_commands.json. Once that tree is gone the setting is
//  dead: cpptools can never use it, and it is noise alongside our live provider.
//
//  The rule is STRUCTURAL — "the file does not exist" — never a name match on
//  "n_cc". Gating on a naming convention is exactly the defect that disabled the
//  source-engine redirect (see workspaceFolders.ts), so it is not repeated here.
//
//  Conservative by construction: an entry is removed only when it is provably
//  dead. Unresolved `${...}` variables are kept (we cannot prove them missing),
//  and user-global settings are never touched — only this workspace's scopes.
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import { log } from "../log";

const SECTION = "C_Cpp";
const KEY = "default.compileCommands";

// ---- Pure pruning (testable without vscode) --------------------------------
export interface PruneResult {
  changed: boolean;
  /** Written back ONLY when `changed`. `undefined` = remove the key (restore cpptools' default). */
  value: string[] | undefined;
  removed: string[];
}

/** True when an entry can be checked on disk (no unresolved `${...}` variable). */
function isResolvable(entry: string): boolean {
  return !entry.includes("${");
}

/**
 * Drop compileCommands entries that point at a missing file.
 * cpptools accepts a string OR a string array (`oneOf` in its schema); both are handled.
 * Empty strings mean "unset" to cpptools and are neither dead nor meaningful — dropped silently.
 */
export function pruneDeadCompileCommands(
  current: string | string[] | undefined,
  exists: (file: string) => boolean,
): PruneResult {
  if (current === undefined) {
    return { changed: false, value: undefined, removed: [] };
  }
  const entries = (Array.isArray(current) ? current : [current]).filter((entry) => entry.trim() !== "");
  const removed = entries.filter((entry) => isResolvable(entry) && !exists(entry));
  if (removed.length === 0) {
    return { changed: false, value: undefined, removed: [] };
  }
  const kept = entries.filter((entry) => !removed.includes(entry));
  return { changed: true, value: kept.length ? kept : undefined, removed };
}

// ---- vscode-facing cleanup -------------------------------------------------
/** Prune one scope; returns true if it wrote a change. */
async function pruneScope(
  config: vscode.WorkspaceConfiguration,
  current: string | string[] | undefined,
  target: vscode.ConfigurationTarget,
  label: string,
): Promise<boolean> {
  const result = pruneDeadCompileCommands(current, (file) => fs.existsSync(file));
  if (!result.changed) {
    return false;
  }
  await config.update(KEY, result.value, target);
  log().info(
    `IntelliSense: cleared dead ${SECTION}.${KEY} in ${label} — ` +
      `file(s) no longer exist: ${result.removed.join(", ")}`,
  );
  return true;
}

/**
 * Clear dead compileCommands entries from this workspace's own scopes: the
 * `.code-workspace` settings, then each folder's `.vscode/settings.json`.
 * User-global settings are deliberately left alone — they span every project.
 */
export async function clearDeadCompileCommands(): Promise<number> {
  let cleared = 0;

  const workspaceConfig = vscode.workspace.getConfiguration(SECTION);
  const workspaceValue = workspaceConfig.inspect<string | string[]>(KEY)?.workspaceValue;
  if (await pruneScope(workspaceConfig, workspaceValue, vscode.ConfigurationTarget.Workspace, "workspace settings")) {
    cleared += 1;
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderConfig = vscode.workspace.getConfiguration(SECTION, folder.uri);
    const folderValue = folderConfig.inspect<string | string[]>(KEY)?.workspaceFolderValue;
    const label = `folder "${folder.name}"`;
    if (await pruneScope(folderConfig, folderValue, vscode.ConfigurationTarget.WorkspaceFolder, label)) {
      cleared += 1;
    }
  }
  return cleared;
}
