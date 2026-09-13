// ============================================================================
//  Engine path mappings — the build engine → workspace source engine redirect,
//  as ABSOLUTE paths (neither cpptools provider responses nor compile_commands.json
//  resolve ${workspaceFolder} variables).
//
//  One implementation shared by both IntelliSense engines — the cpptools live
//  provider and the clangd compile database — so the two can never redirect
//  differently.
// ============================================================================

import * as fs from "fs";
import { O3deProject } from "../o3de/identity";
import { sourceEngineFolder } from "../build/workspaceFolders";
import { detectBuildEngineRoot } from "./engineRoot";
import { RootMapping } from "./remap";
import { normalizePath } from "./paths";

/** Build engine → the workspace's source engine (verified per path), or no mapping when either is missing. */
export function absoluteEngineMappings(project: O3deProject | undefined, includePaths: string[]): RootMapping[] {
  if (!project) {
    return [];
  }
  const source = sourceEngineFolder();
  const buildEngineRoot = detectBuildEngineRoot(project, includePaths);
  if (!buildEngineRoot || !source) {
    return [];
  }
  return [
    {
      fromRoot: buildEngineRoot,
      toRef: normalizePath(source.path),
      verifyBase: source.path,
      exists: (absPath) => fs.existsSync(absPath),
    },
  ];
}
