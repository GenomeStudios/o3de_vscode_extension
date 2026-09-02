// ============================================================================
//  O3DE discovery — ties the manifest + identity files together.
//
//  Enumerates registered engines / projects / gems (from the manifest, reading
//  each marker file), classifies engines source-vs-prebuilt, and resolves the
//  engine a project targets. vscode-free; consumed by the setup wizard (A.2).
// ============================================================================

import * as path from "path";
import { readManifest } from "./manifest";
import {
  O3deEngine,
  O3deGem,
  O3deProject,
  readEngine,
  readGem,
  readProject,
} from "./identity";

// ---- Engines ---------------------------------------------------------------
export function discoverEngines(): O3deEngine[] {
  const manifest = readManifest();
  if (!manifest) {
    return [];
  }
  return manifest.engines
    .map((enginePath) => readEngine(enginePath))
    .filter((engine): engine is O3deEngine => engine !== undefined);
}

/** Engines that carry source (exclude prebuilt SDK engines — no "source vision"). */
export function discoverSourceEngines(): O3deEngine[] {
  return discoverEngines().filter((engine) => !engine.isSdkEngine);
}

// ---- Projects --------------------------------------------------------------
export function discoverProjects(): O3deProject[] {
  const manifest = readManifest();
  if (!manifest) {
    return [];
  }
  return manifest.projects
    .map((projectPath) => readProject(projectPath))
    .filter((project): project is O3deProject => project !== undefined);
}

// ---- Gems ------------------------------------------------------------------
export function discoverGems(): O3deGem[] {
  const manifest = readManifest();
  if (!manifest) {
    return [];
  }
  return manifest.gems
    .map((gemPath) => readGem(gemPath))
    .filter((gem): gem is O3deGem => gem !== undefined);
}

/**
 * The built-in gems of the registered engine(s): each engine.json lists its gem
 * dirs in `external_subdirectories` (relative to the engine root). These are NOT
 * in the user manifest, so they only surface here. There are ~100+ per engine.
 */
export function discoverEngineGems(): O3deGem[] {
  const gems: O3deGem[] = [];
  const seen = new Set<string>();
  for (const engine of discoverEngines()) {
    for (const sub of engine.externalSubdirectories) {
      const dir = path.isAbsolute(sub) ? sub : path.join(engine.path, sub);
      const key = path.resolve(dir);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const gem = readGem(dir);
      if (gem) {
        gems.push(gem);
      }
    }
  }
  return gems;
}

// ---- Project → engine resolution -------------------------------------------
//
//  DIRECTORY-FIRST. A manifest registers engines two ways: `engines` — a plain
//  list of engine DIRECTORIES, which is the forward-looking form and the only one
//  still being written — and `engines_path`, a legacy name → path map that is
//  routinely stale or missing entries (a generic engine_name like "o3de" often has
//  none at all). Resolving through that map made a perfectly good engine sitting
//  right in the workspace fail to resolve. So we work from directories: read each
//  engine.json and match on what it actually declares. The name map is consulted
//  last, and never ahead of an engine the user put in the workspace.

/**
 * Engine roots the workspace itself contributes (the "Engine (source): …" folders).
 * Injected at activation so this module stays vscode-free; defaults to none, which
 * is what the pure tests and any non-vscode caller see.
 */
let workspaceEngineRoots: () => string[] = () => [];

export function setWorkspaceEngineRoots(provider: () => string[]): void {
  workspaceEngineRoots = provider;
}

/** Every engine directory we know about, workspace folders first (they win). */
function candidateEngineRoots(): string[] {
  const roots = [...workspaceEngineRoots(), ...(readManifest()?.engines ?? [])];
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = path.resolve(root).toLowerCase();
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/** The workspace's own source engine, if it carries exactly one unambiguous candidate. */
function loneWorkspaceSourceEngine(): O3deEngine | undefined {
  const engines = workspaceEngineRoots()
    .map((root) => readEngine(root))
    .filter((engine): engine is O3deEngine => engine !== undefined && !engine.isSdkEngine);
  return engines.length === 1 ? engines[0] : undefined;
}

/**
 * Resolve the engine a project targets. In order:
 *   1. an engine DIRECTORY whose engine.json declares project.json's `engine` name
 *      (workspace folders before manifest `engines` roots),
 *   2. the workspace's own source engine, whatever it calls itself — the user
 *      pointed the workspace at it, so a name mismatch shouldn't block us,
 *   3. the legacy `engines_path` name → path map, for manifests old enough that an
 *      engine appears there and nowhere else.
 */
export function resolveProjectEngine(project: O3deProject): O3deEngine | undefined {
  const wanted = project.engine?.toLowerCase();

  if (wanted) {
    for (const root of candidateEngineRoots()) {
      const engine = readEngine(root);
      if (engine && engine.engineName.toLowerCase() === wanted) {
        return engine;
      }
    }
  }

  const inWorkspace = loneWorkspaceSourceEngine();
  if (inWorkspace) {
    return inWorkspace;
  }

  const legacyPath = wanted ? readManifest()?.enginesByName[project.engine as string] : undefined;
  return legacyPath ? readEngine(legacyPath) : undefined;
}
