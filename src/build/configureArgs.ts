// ============================================================================
//  CMake flags — the per-project extra cache variables (`o3de.cmake.configureArgs`).
//
//  One read / write / state model shared by everything that touches them, so the
//  three can never disagree about what is set or applied:
//    - the Advanced tab (edits them, shows "reconfigure pending")
//    - Configure (passes each one as -D<KEY>=<VALUE>)
//    - the MCP config tools (read and change them)
//
//  Stored in the PROJECT folder's settings (.vscode/settings.json). CMake caches a
//  flag in CMakeCache.txt at configure, so a change only takes effect after the next
//  configure — "applied" means the cache already holds the stored value.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { projectBuildDir, readCachedValue } from "./configureCommand";

// ---- Model -----------------------------------------------------------------
export type CmakeFlags = Record<string, string>;

export interface CmakeFlagState {
  key: string;
  value: string; // what Configure will pass
  cached?: string; // what CMakeCache.txt holds now (undefined: not configured, or never set)
  applied: boolean; // the cache already holds `value`
}

export interface CmakeFlagsReport {
  configured: boolean; // a CMakeCache.txt exists
  flags: CmakeFlagState[];
  pending: boolean; // any flag not yet applied — a configure is needed
}

/** A valid CMake cache variable name. */
export const CMAKE_FLAG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---- Pure rules ------------------------------------------------------------
/** A setting value → clean flags: keys trimmed and non-empty, values as strings, null/undefined dropped. */
export function normalizeCmakeFlags(raw: unknown): CmakeFlags {
  const flags: CmakeFlags = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return flags;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim() !== "" && value !== null && value !== undefined) {
      flags[key.trim()] = String(value);
    }
  }
  return flags;
}

/** Apply a patch: a string sets the flag, `""` or `null` removes it. Other flags are kept. */
export function applyCmakeFlagPatch(current: CmakeFlags, patch: Record<string, string | null>): CmakeFlags {
  const next: CmakeFlags = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** Keys in a patch that aren't valid CMake variable names. */
export function invalidCmakeFlagNames(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((key) => !CMAKE_FLAG_NAME.test(key));
}

/** Each stored flag against the cache (`cacheText` undefined = not configured). Sorted by key. */
export function cmakeFlagsReport(flags: CmakeFlags, cacheText: string | undefined): CmakeFlagsReport {
  const configured = cacheText !== undefined && cacheText !== "";
  const states = Object.keys(flags)
    .sort()
    .map((key): CmakeFlagState => {
      const cached = configured ? readCachedValue(cacheText, key) : undefined;
      return { key, value: flags[key], cached, applied: configured && cached === flags[key] };
    });
  return { configured, flags: states, pending: states.some((state) => !state.applied) };
}

// ---- I/O -------------------------------------------------------------------
/** The flags stored for a project (its folder's effective setting). */
export function readCmakeFlags(projectPath: string): CmakeFlags {
  const raw = vscode.workspace.getConfiguration("o3de", vscode.Uri.file(projectPath)).get<unknown>("cmake.configureArgs", {});
  return normalizeCmakeFlags(raw);
}

/** Store the flags in the project folder's settings (the workspace settings when the folder isn't a workspace folder). */
export async function writeCmakeFlags(projectPath: string, flags: CmakeFlags): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectPath));
  await vscode.workspace
    .getConfiguration("o3de", folder?.uri)
    .update("cmake.configureArgs", flags, folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace);
}

/** The project's CMakeCache.txt text, or undefined when it hasn't been configured. */
export function readCmakeCache(projectPath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(projectBuildDir(projectPath), "CMakeCache.txt"), "utf8");
  } catch {
    return undefined;
  }
}

/** Stored flags against the project's cache. */
export function readCmakeFlagsReport(projectPath: string): CmakeFlagsReport {
  return cmakeFlagsReport(readCmakeFlags(projectPath), readCmakeCache(projectPath));
}
