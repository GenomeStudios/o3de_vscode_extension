// ============================================================================
//  Database plan — decides WHAT goes into clangd's compile database. vscode-free.
//
//  ENTRY POINT:  planCompileDatabase(inputs) → { commands, origins, ... }
//
//  The extension (clangdMode.ts) and a Node script run the very same call, so a benchmark
//  measures exactly the database a user gets:
//
//      const reply = loadCommandReply(fileApiReplyDir(projectPath), "profile");   // fileApi.ts
//      const planned = planCompileDatabase({
//        reply,
//        project: readProject(projectPath)!,                                      // o3de/identity.ts
//        sourceEngineRoot: "D:/path/to/source/engine",                            // optional
//        coverage: "participating",
//      });
//      writeCompileDatabase(reply.buildDir, planned.commands);                    // compileDb.ts
//
//  Everything is derived from the user's own data — the File API reply, project.json, gem.json,
//  engine.json, the o3de manifest and the source engine on disk. No gem, project or path is
//  named here; a project with entirely its own gems and engine gets its own database.
//
//  FIVE ORIGINS — every entry belongs to exactly one:
//
//    project          a source of the project's own targets
//    gem              a source of another target the build lists (a gem; the engine itself when the
//                     project builds it from source)
//    engineFramework  the source engine's Code/Framework modules the project includes
//    engineGems       the engine gems the project USES, from the source engine
//    fallback         gem sources no configured target lists (a legacy file list, a gem not enabled)
//
//  ENGINE ENTRIES exist only when navigation is REDIRECTED: the project builds against an SDK
//  engine (headers, no .cpp) and a source engine is at hand. Which engine gems take part comes
//  from the project's own include dirs: every include dir that points into the source engine's
//  Gems folder, walked up to the nearest gem.json, names a participating gem. That gem's
//  sources (not its tests, not other platforms, not vendored code) get the shared command plus
//  the gem's own dirs: the conventional folders (Include, Source, Platform/<host>) and the include
//  dirs the gem's own CMakeLists.txt files declare (declaredIncludes.ts). o3de.intellisense.engineCoverage
//  chooses how far this goes:
//
//    participating   Framework + the participating gems (default)
//    framework       Framework only
//    off             no engine entries
//
//  FALLBACK ENTRIES cover the gems the project reaches — the gems of its own sources, plus the
//  external_subdirectories of project.json, plus the gems of the o3de manifest (read quietly:
//  absent is fine) that this project enables, that live in the project, or that the workspace
//  contains — whose sources have no entry. They take the project's include union plus the gem's
//  own dirs. A manifest gem the project doesn't touch is left out (and counted: skippedManifestGems),
//  so the database never depends on what else is registered on the machine.
//  Gems inside an engine are never fallback material; they are engine entries or nothing, so
//  the coverage setting stays in charge of the engine.
//
//  A project's real entry always wins over any of these; Framework wins over gems.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { O3deProject, readEngine, readGem } from "../o3de/identity";
import { manifestPath, readManifest } from "../o3de/manifest";
import {
  CompileCommand,
  SharedCommandSources,
  buildCompileDatabase,
  gemFolderSkipper,
  isOtherPlatformPath,
  listFrameworkSources,
  listGemSources,
  projectIncludePaths,
  replySourceFiles,
} from "./compileDb";
import { declaredIncludeDirsIn, palFolderName } from "./declaredIncludes";
import { detectBuildEngineRoot } from "./engineRoot";
import { CommandReply } from "./fileApi";
import { ModuleDefineLookup, createModuleDefineLookup, declaresTarget, readCMakeFromDisk } from "./moduleDefines";
import { isUnderRoot, normalizePath, uniqueStable } from "./paths";
import { RootMapping } from "./remap";

// ---- Model -----------------------------------------------------------------
export type EngineCoverage = "participating" | "framework" | "off";

export const ENGINE_COVERAGES: readonly EngineCoverage[] = ["participating", "framework", "off"];
export const DEFAULT_ENGINE_COVERAGE: EngineCoverage = "participating";

/** The setting's value, or the default for anything that isn't one of the three. */
export function parseEngineCoverage(value: unknown): EngineCoverage {
  return ENGINE_COVERAGES.find((coverage) => coverage === value) ?? DEFAULT_ENGINE_COVERAGE;
}

export function engineCoverageDetail(coverage: EngineCoverage): string {
  switch (coverage) {
    case "participating":
      return "Engine sources in clangd's database: the Framework modules your project includes and the engine gems it uses (redirected projects only).";
    case "framework":
      return "Engine sources in clangd's database: only the Framework modules your project includes (redirected projects only).";
    case "off":
      return "No engine sources in clangd's database: only your project, your gems and the gem sources outside the build.";
  }
}

/** How many entries each origin contributed; they add up to the database's entries. */
export interface OriginCounts {
  project: number;
  gem: number;
  engineFramework: number;
  engineGems: number;
  fallback: number;
}

export interface PlanInputs {
  reply: CommandReply;
  project: O3deProject;
  coverage: EngineCoverage;
  /** The source engine on disk, when there is one. Engine entries need it AND a build engine that is an SDK. */
  sourceEngineRoot?: string;
  platform?: NodeJS.Platform; // the host's by default
  /** The engine the project builds against; found from project.json, the manifest and the includes when omitted. */
  buildEngineRoot?: string;
  /** The o3de manifest's external_subdirectories, absolute; read from the manifest when omitted. */
  manifestGems?: string[];
  /** The folders open in the workspace: a manifest gem inside one of them counts as reached (relevantManifestGems). */
  workspaceFolders?: string[];
}

export interface PlannedDatabase {
  commands: CompileCommand[];
  coverage: EngineCoverage;
  redirected: boolean; // engine entries were possible: an SDK build engine with a source engine at hand
  origins: OriginCounts;
  engineModuleDefines: number; // engine entries given their module's export defines
  participatingGems: string[]; // roots of the engine gems the project uses (redirected, coverage participating)
  fallbackGems: string[]; // roots of the gems reached whose uncovered sources got fallback entries
  skippedManifestGems: number; // gems registered in the o3de manifest that the project doesn't enable and the workspace doesn't contain
}

// ---- Gems on disk ----------------------------------------------------------
function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A finder answering "which gem root is at or above this directory" — the nearest folder holding gem.json —
 * and remembering every directory it walked. `stopAt` is exclusive: the walk never reaches it.
 */
function gemRootFinder(stopAt?: string): (dir: string) => string | undefined {
  const known = new Map<string, string | undefined>(); // directory (lower-case) → its gem root
  const stop = stopAt === undefined ? undefined : normalizePath(stopAt).replace(/\/+$/, "").toLowerCase();
  return (start) => {
    const walked: string[] = [];
    let found: string | undefined;
    let dir = normalizePath(start).replace(/\/+$/, "");
    while (dir && dir !== "." && dir.toLowerCase() !== stop) {
      const key = dir.toLowerCase();
      if (known.has(key)) {
        found = known.get(key);
        break;
      }
      walked.push(key);
      if (fs.existsSync(`${dir}/gem.json`)) {
        found = dir;
        break;
      }
      const parent = path.posix.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    for (const key of walked) {
      known.set(key, found);
    }
    return found;
  };
}

/** Add `root` to `roots` once, ignoring case. */
function addRoot(roots: Map<string, string>, root: string): void {
  if (!roots.has(root.toLowerCase())) {
    roots.set(root.toLowerCase(), root);
  }
}

/**
 * The engine gems a project uses: every include dir under `<engineRoot>/Gems` walked up to the nearest gem.json.
 * `includePaths` are the project's include dirs after the SDK → source redirect. Sorted.
 */
export function participatingGemRoots(includePaths: string[], engineRoot: string): string[] {
  const gemsRoot = `${normalizePath(engineRoot).replace(/\/+$/, "")}/Gems`;
  const find = gemRootFinder(gemsRoot);
  const roots = new Map<string, string>();
  for (const include of includePaths) {
    const root = isUnderRoot(include, gemsRoot) ? find(include) : undefined;
    if (root) {
      addRoot(roots, root);
    }
  }
  return [...roots.values()].sort();
}

/**
 * The gem roots a project reaches: the gem of every source file it compiles, plus each external
 * subdirectory that is a gem. Gems under `excludeUnder` (the engines) are left out. Sorted.
 */
export function reachedGemRoots(sourceFiles: string[], externalSubdirectories: string[], excludeUnder: string[]): string[] {
  const find = gemRootFinder();
  const roots = new Map<string, string>();
  const consider = (root: string | undefined): void => {
    if (root && !excludeUnder.some((excluded) => isUnderRoot(root, excluded))) {
      addRoot(roots, root);
    }
  };
  for (const dir of new Set(sourceFiles.map((file) => path.posix.dirname(normalizePath(file))))) {
    consider(find(dir));
  }
  for (const subdirectory of externalSubdirectories) {
    const dir = normalizePath(subdirectory).replace(/\/+$/, "");
    consider(fs.existsSync(`${dir}/gem.json`) ? dir : undefined);
  }
  return [...roots.values()].sort();
}

/** Where a gem's code lives: its Code folder, or the gem root itself when it has none. */
export function gemCodeRoot(gemRoot: string): string {
  const root = normalizePath(gemRoot).replace(/\/+$/, "");
  return isDirectory(`${root}/Code`) ? `${root}/Code` : root;
}

/**
 * A gem's own include directories that exist, in this order: the conventional ones under its code folder —
 * Include and its Platform/<host>, Source and its Platform/<host> and Platform/Common (where most engine gems
 * keep their platform trait headers), then the code folder's own Platform/<host> and Platform/Common — followed
 * by the ones its own CMake files declare (gemDeclaredIncludeDirs) that the list doesn't have yet.
 */
export function gemIncludeDirs(gemRoot: string, platform: NodeJS.Platform): string[] {
  const code = gemCodeRoot(gemRoot);
  const host = palFolderName(platform);
  const conventional = [
    `${code}/Include`,
    ...(host ? [`${code}/Include/Platform/${host}`] : []),
    `${code}/Source`,
    ...(host ? [`${code}/Source/Platform/${host}`] : []),
    `${code}/Source/Platform/Common`,
    ...(host ? [`${code}/Platform/${host}`] : []),
    `${code}/Platform/Common`,
  ].filter(isDirectory);
  return uniqueStable([...conventional, ...gemDeclaredIncludeDirs(gemRoot, code, platform)]);
}

// ---- Dirs a gem's CMake declares -------------------------------------------
/** Folders under a gem that hold no production headers: tests, build output, dot-folders (vendored code stays: a gem may declare it). */
const NON_PRODUCTION_FOLDER = /^(tests?|build|\..*)$/i;

/** Every CMakeLists.txt that declares a target, at or under `codeRoot` (the gem's own folders, see gemFolderSkipper), read once. */
function targetCMakeFiles(codeRoot: string): { dir: string; cmake: string }[] {
  const skip = gemFolderSkipper(codeRoot);
  const found: { dir: string; cmake: string }[] = [];
  const visit = (dir: string): void => {
    const cmake = readCMakeFromDisk(dir);
    if (cmake !== undefined && declaresTarget(cmake)) {
      found.push({ dir, cmake });
    }
    try {
      // By name, so the order (and so which dir comes first in the entry) never depends on the file system.
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory() && !skip(entry.name, child)) {
          visit(child);
        }
      }
    } catch {
      // an unreadable folder has nothing to declare
    }
  };
  visit(codeRoot);
  return found;
}

/**
 * The include directories a gem's own CMake files declare (declaredIncludes.ts), in the order the files and
 * their blocks name them: every CMakeLists.txt under `codeRoot` that declares a target is read once, and the
 * dirs that exist on disk and are not another platform's PAL folder, a test folder or build output are kept.
 * `${gem_name}` and `${gem_path}` resolve from the gem's gem.json and root.
 */
export function gemDeclaredIncludeDirs(gemRoot: string, codeRoot: string, platform: NodeJS.Platform): string[] {
  const root = normalizePath(gemRoot).replace(/\/+$/, "");
  const gem = readGem(gemRoot);
  const variables: Record<string, string> = { gem_path: root, ...(gem ? { gem_name: gem.gemName } : {}) };
  const declared = targetCMakeFiles(codeRoot).flatMap(({ dir, cmake }) => declaredIncludeDirsIn(cmake, dir, platform, variables));
  // Judged by the folders below the nearest one the dir shares with the gem, so `../Code/Tests` (beside a root-layout
  // gem) is a tests folder, while where the gem itself lives (`~/.o3de/Gems/x`, `C:/build/x`) never counts.
  const inNonProductionFolder = (dir: string): boolean =>
    path.posix.relative(root, dir).split("/").some((folder) => folder !== ".." && NON_PRODUCTION_FOLDER.test(folder));
  return uniqueStable(declared).filter((dir) => isDirectory(dir) && !isOtherPlatformPath(dir, platform) && !inNonProductionFolder(dir));
}

// ---- Engine redirect -------------------------------------------------------
/** Build engine → source engine, verified per path: the mapping the live provider uses (engineMappings.ts). */
function redirectMappings(buildEngineRoot: string | undefined, sourceEngineRoot: string | undefined): RootMapping[] {
  if (!buildEngineRoot || !sourceEngineRoot) {
    return [];
  }
  return [
    {
      fromRoot: buildEngineRoot,
      toRef: normalizePath(sourceEngineRoot),
      verifyBase: sourceEngineRoot,
      exists: (absPath) => fs.existsSync(absPath),
    },
  ];
}

/** The source engine, only when navigation is REDIRECTED to it — the rule of engineMode.ts: an SDK build engine plus a readable source engine. */
function redirectedSourceEngine(buildEngineRoot: string | undefined, sourceEngineRoot: string | undefined): string | undefined {
  const build = buildEngineRoot ? readEngine(buildEngineRoot) : undefined;
  return build?.isSdkEngine && sourceEngineRoot && readEngine(sourceEngineRoot) ? sourceEngineRoot : undefined;
}

// ---- Gems the project names ------------------------------------------------
/** The o3de manifest's external_subdirectories, absolute — none when the manifest can't be read. */
export function readManifestGems(): string[] {
  const manifest = readManifest();
  const base = path.dirname(manifestPath());
  return (manifest?.gems ?? []).filter((gem) => typeof gem === "string").map((gem) => path.resolve(base, gem));
}

/** A gem_names entry without its version specifier ("Atom_RPI>=1.0" is "Atom_RPI"), lower-case. */
function bareGemName(entry: string): string {
  return (/^[^<>=~!\s]+/.exec(entry.trim())?.[0] ?? "").toLowerCase();
}

export interface ManifestGemSplit {
  relevant: string[]; // gems this project enables, holds, or the workspace contains: in manifest order
  skipped: string[]; // gems (a folder with a gem.json) the project doesn't touch
}

/**
 * Which of the o3de manifest's gems belong to THIS workspace. A registered gem counts when ANY of these holds: its
 * gem.json names a gem the project enables (project.json gem_names), it lives under the project, or it lives under a
 * workspace folder (a gem the user opened without enabling it). Anything else on the machine is none of this
 * project's business. Folders with no gem.json are dropped quietly: they are no gem.
 */
export function relevantManifestGems(manifestGems: string[], project: O3deProject, workspaceFolders: string[] = []): ManifestGemSplit {
  const enabled = new Set(project.gemNames.map(bareGemName));
  const heldBy = [project.path, ...workspaceFolders];
  const split: ManifestGemSplit = { relevant: [], skipped: [] };
  for (const dir of manifestGems) {
    const gem = readGem(dir);
    if (!gem) {
      continue;
    }
    const related = heldBy.some((folder) => isUnderRoot(dir, folder)) || enabled.has(gem.gemName.toLowerCase());
    (related ? split.relevant : split.skipped).push(dir);
  }
  return split;
}

// ---- Plan ------------------------------------------------------------------
type Origin = keyof OriginCounts;

/**
 * Decide the whole database: the redirect, the engine entries `coverage` allows, the fallback gem
 * entries, and the project's own — then build it. See the header for the rules.
 */
export function planCompileDatabase(inputs: PlanInputs): PlannedDatabase {
  const { reply, project, coverage } = inputs;
  const platform = inputs.platform ?? process.platform;
  const includePaths = reply.targets.flatMap((target) => target.compile.includes.map((include) => include.path));
  const buildEngineRoot = inputs.buildEngineRoot ?? detectBuildEngineRoot(project, includePaths);
  const mappings = redirectMappings(buildEngineRoot, inputs.sourceEngineRoot);
  const sourceEngine = redirectedSourceEngine(buildEngineRoot, inputs.sourceEngineRoot);

  // Files the database already has, and who adds each new one.
  const replyFiles = replySourceFiles(reply);
  const taken = new Set(replyFiles.map((file) => file.toLowerCase()));
  const origin = new Map<string, Origin>();
  const claim = (kind: Origin, files: string[]): string[] => {
    const claimed: string[] = [];
    for (const file of files) {
      const key = file.toLowerCase();
      if (!taken.has(key) && !isUnderRoot(file, reply.buildDir)) {
        taken.add(key);
        origin.set(key, kind);
        claimed.push(file);
      }
    }
    return claimed;
  };

  // Engine entries: Framework, then the participating gems.
  let frameworkFiles: string[] = [];
  let exportDefines: ModuleDefineLookup | undefined;
  let participatingGems: string[] = [];
  const gemGroups: SharedCommandSources[] = [];
  if (sourceEngine && coverage !== "off") {
    const projectIncludes = projectIncludePaths(reply, mappings);
    exportDefines = createModuleDefineLookup(sourceEngine);
    frameworkFiles = claim("engineFramework", listFrameworkSources(sourceEngine, platform, projectIncludes));
    if (coverage === "participating") {
      participatingGems = participatingGemRoots(projectIncludes, sourceEngine);
      for (const root of participatingGems) {
        const files = claim("engineGems", listGemSources(gemCodeRoot(root), platform));
        if (files.length) {
          gemGroups.push({ files, includes: gemIncludeDirs(root, platform), exportDefines });
        }
      }
    }
  }

  // Fallback entries: gems the project reaches, outside every engine. Manifest gems count only when they are this project's.
  const engines = [buildEngineRoot, inputs.sourceEngineRoot].filter((root): root is string => root !== undefined);
  const manifest = relevantManifestGems(inputs.manifestGems ?? readManifestGems(), project, inputs.workspaceFolders);
  const named = [...project.externalSubdirectories.map((subdirectory) => path.resolve(project.path, subdirectory)), ...manifest.relevant];
  const skippedManifestGems = manifest.skipped.filter((gem) => !engines.some((engine) => isUnderRoot(gem, engine))).length;
  const fallbackGems = reachedGemRoots(replyFiles, named, engines);
  for (const root of fallbackGems) {
    const files = claim("fallback", listGemSources(gemCodeRoot(root), platform));
    if (files.length) {
      gemGroups.push({ files, includes: gemIncludeDirs(root, platform) });
    }
  }

  const commands = buildCompileDatabase(reply, mappings, frameworkFiles, platform, exportDefines, gemGroups);
  return {
    commands,
    coverage,
    redirected: sourceEngine !== undefined,
    origins: countOrigins(commands, origin, project.path),
    engineModuleDefines: commands.filter((command) => isEngineOrigin(origin.get(command.file.toLowerCase())) && (exportDefines?.(command.file).length ?? 0) > 0).length,
    participatingGems,
    fallbackGems,
    skippedManifestGems,
  };
}

// ---- Counting --------------------------------------------------------------
function isEngineOrigin(kind: Origin | undefined): boolean {
  return kind === "engineFramework" || kind === "engineGems";
}

/** Each entry counts once: by who added it, else by the reply — under the project root is the project's, anything else a gem's. */
function countOrigins(commands: CompileCommand[], addedBy: Map<string, Origin>, projectRoot: string): OriginCounts {
  const counts: OriginCounts = { project: 0, gem: 0, engineFramework: 0, engineGems: 0, fallback: 0 };
  for (const { file } of commands) {
    counts[addedBy.get(file.toLowerCase()) ?? (isUnderRoot(file, projectRoot) ? "project" : "gem")] += 1;
  }
  return counts;
}
