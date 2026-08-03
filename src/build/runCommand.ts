// ============================================================================
//  Run command — pure helpers (vscode-free, unit-tested).
//
//  Resolves the argv + runtime-exe paths for launching a built target and the
//  small display strings the Run section shows. The launch itself (detached
//  spawn, PID tracking, force-quit) lives in runManager.ts; the command flow
//  (project resolve, disk probe, prompts) in run.ts.
// ============================================================================

import * as path from "path";
import { platformBuildDir } from "./configureCommand";
import type { RunTarget } from "./buildOptions";
import type { O3deEngine } from "../o3de/identity";

// ---- Runtime-exe paths -----------------------------------------------------
/** A built runtime exe in the project tree: <project>/build/<platform>/bin/<config>/<exe>. */
export function projectRuntimeExe(projectPath: string, config: string, exeName: string): string {
  return path.join(projectPath, "build", platformBuildDir(), "bin", config, exeName);
}

/** O3DE launcher naming: <Project>.GameLauncher.exe (matches the user's build output). */
export function gameLauncherExeName(projectName: string): string {
  return `${projectName}.GameLauncher.exe`;
}

/**
 * The exe image a run target resolves to. "Editor" / "GameLauncher" are the two
 * special values (engine-aware Editor, project-prefixed launcher); anything else
 * is an executable target name — its exe is simply `<name>.exe` in the project's
 * build output (CMake artifact naming, e.g. O3DEQtControlGallery.exe).
 */
export function runTargetExeName(target: RunTarget, projectName: string): string {
  if (target === "Editor") {
    return "Editor.exe";
  }
  if (target === "GameLauncher") {
    return gameLauncherExeName(projectName);
  }
  return customRunImage(target) ?? target;
}

/**
 * The exe image a CUSTOM run target adds to the is-running probes — undefined
 * for Editor/GameLauncher (the standard probe set already covers those, and
 * only they need a project name to resolve).
 */
export function customRunImage(target: RunTarget): string | undefined {
  if (target === "Editor" || target === "GameLauncher") {
    return undefined;
  }
  return target.toLowerCase().endsWith(".exe") ? target : `${target}.exe`;
}

/**
 * Editor.exe candidate paths in priority order, keyed off the project's engine —
 * the single source of truth shared by Run (run.ts) and launch.json (launchGenerate.ts).
 *   - SDK (prebuilt) engine → the engine's own prebuilt Editor (Default/ then flat bin).
 *     The project build dir only holds copied DLLs + custom gems; its Editor.exe is a
 *     stale stub and must NOT be run (running it exits code 1).
 *   - source / custom / unresolved engine → the project's own built Editor.
 * Pure: the caller resolves the engine, then picks the first candidate that exists.
 * NOTE: engine bin is capital-"Windows" on disk; the project build dir is lowercase
 * (platformBuildDir) — do not "unify" the casing.
 */
export function editorExeCandidates(
  engine: O3deEngine | undefined,
  projectPath: string,
  config: string,
): string[] {
  if (engine?.isSdkEngine) {
    const engineBin = path.join(engine.path, "bin", "Windows", config);
    return [path.join(engineBin, "Default", "Editor.exe"), path.join(engineBin, "Editor.exe")];
  }
  return [projectRuntimeExe(projectPath, config, "Editor.exe")];
}

// ---- Launch args -----------------------------------------------------------
/** Split a launch-options string into argv, honoring double-quoted tokens. */
export function parseLaunchArgs(text: string): string[] {
  const out: string[] = [];
  const token = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(text)) !== null) {
    out.push(match[1] !== undefined ? match[1] : match[2]);
  }
  return out;
}

/**
 * Full argv for a run: the target's base args + the user's launch options.
 *   Editor    → ["--project-path", <project>] + <launchArgs>
 *   all else  → <launchArgs>   (e.g. +LoadLevel DefaultLevel +r_displayInfo 1)
 * Only the Editor needs --project-path spelled out (an SDK engine's Editor lives
 * in the shared engine bin). Everything else launches from the project's own
 * build output, where O3DE apps self-locate the project via the registry files
 * deployed next to the exe; non-O3DE tools (e.g. the Qt control gallery) get no
 * surprise args they never asked for.
 */
export function runArgsFor(target: RunTarget, projectPath: string, launchArgs: string): string[] {
  const base = target === "Editor" ? ["--project-path", projectPath] : [];
  return [...base, ...parseLaunchArgs(launchArgs)];
}

// ---- Run-target picker candidates -------------------------------------------
/**
 * The discovered (non-curated) run-target names, ordered for the picker:
 * File-API executable targets first (codemodel order), then built exes found on
 * disk that the File API didn't list, then the current selection (a custom name
 * must survive the picker reopening). Deduplicated case-insensitively, first
 * spelling wins. "Editor" and the project's GameLauncher (under any of its
 * spellings) are excluded — the curated rows own those.
 */
export function orderRunTargets(
  projectName: string,
  apiExecutables: string[],
  builtExes: string[],
  current: string,
): string[] {
  const curated = new Set([
    "editor",
    "gamelauncher",
    `${projectName}.GameLauncher`.toLowerCase(),
    gameLauncherExeName(projectName).toLowerCase(),
  ]);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of [...apiExecutables, ...builtExes, current]) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || curated.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(name);
  }
  return ordered;
}

// ---- Display ---------------------------------------------------------------
/** How the Run action reads in the tree: "Editor" or "GameLauncher · +LoadLevel …". */
export function runSummary(target: RunTarget, launchArgs: string): string {
  const args = launchArgs.trim();
  return args ? `${target} · ${args}` : target;
}

/** The Launch Options row's dimmed value ("(none)" when unset). */
export function launchArgsLabel(launchArgs: string): string {
  const args = launchArgs.trim();
  return args.length > 0 ? args : "(none)";
}
