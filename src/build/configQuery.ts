// ============================================================================
//  Config query — read/apply the O3DE build options + list buildable targets.
//
//  Backs the LLM/MCP config tools (o3de_get_config / o3de_set_config /
//  o3de_list_targets) so an assistant can inspect the current build attributes,
//  change them, and discover every real CMake target — enabling purposeful
//  builds beyond the user's default selection. Thin wrappers over BuildOptions
//  (the same state the panel edits, so changes reflect live in the UI) plus the
//  File API reply for the target list.
// ============================================================================

import * as fs from "fs";
import * as vscode from "vscode";
import { readProject, O3deProject } from "../o3de/identity";
import { fileApiReplyDir, projectBuildDir } from "./configureCommand";
import { curatedTargets } from "./buildCommand";
import { loadTargetNames, loadExecutableTargets } from "../intellisense/fileApi";
import { isConfiguredFor } from "./configure";
import {
  BuildOptions,
  Generator,
  Compiler,
  BuildConfig,
  RunTarget,
  GENERATORS,
  COMPILERS,
  BUILD_CONFIGS,
  RUN_TARGETS,
} from "./buildOptions";

// ---- Snapshot (get) --------------------------------------------------------
export interface ConfigSnapshot {
  generator: Generator;
  compiler: Compiler;
  config: BuildConfig;
  targets: string[]; // empty = build everything
  runTarget: RunTarget;
  launchArgs: string;
  // runTargets lists only the two always-valid values — any executable target
  // name (o3de_list_targets → executables) is also accepted as a runTarget.
  options: { generators: Generator[]; compilers: Compiler[]; configs: BuildConfig[]; runTargets: RunTarget[] };
  project?: { name: string; path: string; buildDir: string; configuredForGenerator: boolean };
}

/** The current build options + the valid choices for each + project/configured state. */
export function configSnapshot(buildOptions: BuildOptions): ConfigSnapshot {
  const project = firstProject();
  return {
    generator: buildOptions.generator,
    compiler: buildOptions.compiler,
    config: buildOptions.config,
    targets: buildOptions.targets,
    runTarget: buildOptions.runTarget,
    launchArgs: buildOptions.launchArgs,
    options: { generators: GENERATORS, compilers: COMPILERS, configs: BUILD_CONFIGS, runTargets: RUN_TARGETS },
    project: project
      ? {
          name: project.projectName,
          path: project.path,
          buildDir: projectBuildDir(project.path),
          configuredForGenerator: isConfiguredFor(project, buildOptions.generator),
        }
      : undefined,
  };
}

// ---- Apply (set) -----------------------------------------------------------
export interface ConfigPatch {
  generator?: Generator;
  compiler?: Compiler;
  config?: BuildConfig;
  targets?: string[];
  runTarget?: RunTarget;
  launchArgs?: string;
}

/** Apply the provided fields (already schema-validated) and report which changed. */
export async function applyConfig(buildOptions: BuildOptions, patch: ConfigPatch): Promise<string[]> {
  const applied: string[] = [];
  if (patch.generator !== undefined) {
    await buildOptions.setGenerator(patch.generator);
    applied.push("generator");
  }
  if (patch.compiler !== undefined) {
    await buildOptions.setCompiler(patch.compiler);
    applied.push("compiler");
  }
  if (patch.config !== undefined) {
    await buildOptions.setConfig(patch.config);
    applied.push("config");
  }
  if (patch.targets !== undefined) {
    await buildOptions.setTargets(patch.targets);
    applied.push("targets");
  }
  if (patch.runTarget !== undefined) {
    await buildOptions.setRunTarget(patch.runTarget);
    applied.push("runTarget");
  }
  if (patch.launchArgs !== undefined) {
    await buildOptions.setLaunchArgs(patch.launchArgs);
    applied.push("launchArgs");
  }
  return applied;
}

// ---- Targets (list) --------------------------------------------------------
export interface TargetList {
  config: BuildConfig;
  configured: boolean;
  curated: string[]; // Editor + <Project>.GameLauncher — the common picks
  targets: string[]; // every real CMake target for the config (from the File API reply)
  executables: string[]; // the runnable subset (EXECUTABLE targets) — valid runTarget values
  note?: string;
}

/** Every buildable CMake target for a config (defaults to the current one). */
export function listTargets(buildOptions: BuildOptions, config?: BuildConfig): TargetList {
  const project = firstProject();
  const cfg = config ?? buildOptions.config;
  if (!project) {
    return {
      config: cfg,
      configured: false,
      curated: [],
      targets: [],
      executables: [],
      note: "No O3DE project in this workspace.",
    };
  }
  const curated = curatedTargets(project.projectName);
  const replyDir = fileApiReplyDir(project.path);
  const configured = fs.existsSync(replyDir);
  const targets = configured ? loadTargetNames(replyDir, cfg) : [];
  const executables = configured ? loadExecutableTargets(replyDir, cfg).map((t) => t.name) : [];
  return {
    config: cfg,
    configured,
    curated,
    targets,
    executables,
    note: configured ? undefined : "Not configured yet — run “O3DE: Configure Project” to list all targets.",
  };
}

// ---- Internal --------------------------------------------------------------
function firstProject(): O3deProject | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const project = readProject(folder.uri.fsPath);
    if (project) {
      return project;
    }
  }
  return undefined;
}
