// ============================================================================
//  Provider model (pure) — File API reply → per-file + browse configs.
//
//  Builds what the live CustomConfigurationProvider serves to cpptools. Every file
//  resolves through ONE of three tiers (the configuration stack):
//
//    1. One owning target   → that target's exact config (precision).
//    2. Several owners      → the AGREED compile of just those owners.
//    3. No owning target    → the AGREED compile of every compiling target
//                             (`defaultConfig`: engine source reached through the
//                             source-engine redirect, gems not enabled here, ...).
//
//  "Agreed" = union the include paths, intersect the defines / forced includes
//  (see consolidate.ts agreedCompile). Only COMPILING targets own files.
//
//  browsePath stays the full include union — navigation wants reach.
//  Paths are ABSOLUTE (cpptools does not resolve ${workspaceFolder} in provider
//  responses) with the build engine remapped to the source engine's real path.
// ============================================================================

import * as path from "path";
import type { SourceFileConfiguration } from "vscode-cpptools";
import { FileApiReply, LoadedTarget } from "./fileApi";
import { ConsolidatedCompile, agreedCompile, consolidateTargets } from "./consolidate";
import { remapIncludes, remapPath, RootMapping } from "./remap";
import { cppStandardFromApi, intelliSenseModeFor } from "./cppProperties";
import { normalizePath, uniqueStable } from "./paths";

// ---- Model -----------------------------------------------------------------
export interface ProviderModel {
  perFile: Map<string, SourceFileConfiguration>; // key = normalizePath(abs).toLowerCase()
  defaultConfig: SourceFileConfiguration; // tier 3: files no compiling target owns
  browsePath: string[];
  compilerPath?: string;
}

const CODE_SOURCE = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|inl|ipp|tpp)$/i;

// ---- Config construction ---------------------------------------------------
function toConfig(
  includePath: string[],
  defines: string[],
  forcedInclude: string[],
  standard: string | undefined,
  compilerPath?: string,
): SourceFileConfiguration {
  return {
    includePath,
    defines,
    intelliSenseMode: intelliSenseModeFor(compilerPath) as SourceFileConfiguration["intelliSenseMode"],
    standard: cppStandardFromApi(standard) as SourceFileConfiguration["standard"],
    ...(forcedInclude.length ? { forcedInclude } : {}),
    ...(compilerPath ? { compilerPath } : {}),
  };
}

/** Remap a compile set's paths to the workspace and turn it into a cpptools config. */
function configFor(
  compile: ConsolidatedCompile,
  mappings: RootMapping[],
  fallbackStandard: string | undefined,
  compilerPath: string | undefined,
): SourceFileConfiguration {
  return toConfig(
    uniqueStable(remapIncludes(compile.includes, mappings).map((include) => include.path)),
    compile.defines,
    uniqueStable(compile.forcedIncludes.map((forced) => remapPath(forced, mappings))),
    compile.standard ?? fallbackStandard,
    compilerPath,
  );
}

// ---- Ownership -------------------------------------------------------------
/** file key → indices (ascending, codemodel order) of the compiling targets that list it. */
function mapOwners(targets: LoadedTarget[], projectRoot: string): Map<string, number[]> {
  const owners = new Map<string, number[]>();
  targets.forEach((target, index) => {
    for (const src of target.sourcePaths) {
      if (!CODE_SOURCE.test(src)) {
        continue;
      }
      const abs = path.isAbsolute(src) ? src : path.join(projectRoot, src);
      const key = normalizePath(abs).toLowerCase();
      const list = owners.get(key) ?? [];
      if (list[list.length - 1] !== index) {
        list.push(index); // a target listing the same file twice still owns it once
      }
      owners.set(key, list);
    }
  });
  return owners;
}

// ---- Build -----------------------------------------------------------------
/** Build the provider model for one project's reply. `mappings` remap engine → source (absolute). */
export function buildProviderModel(
  reply: FileApiReply,
  projectRoot: string,
  mappings: RootMapping[],
): ProviderModel {
  // Only targets that actually compile carry authority over a file's config. An INTERFACE
  // target lists sources but has no compile groups; letting it own a file served that file an
  // EMPTY config (measured on gs_play: 3 VolumetricClouds headers).
  const compiling = reply.targets.filter((target) => target.compiles);
  const compiles = compiling.map((target) => target.compile);
  const union = consolidateTargets(compiles);

  // Navigation: every include any target offers.
  const browsePath = uniqueStable(remapIncludes(union.includes, mappings).map((include) => include.path));

  // Tier 3 — no owning target.
  const defaultConfig = configFor(agreedCompile(compiles), mappings, union.standard, reply.compilerPath);

  // Tier 1 configs, built once per target and shared by all its files (remapping stats the disk,
  // so this must not become once-per-file).
  const targetConfigs = compiles.map((compile) => configFor(compile, mappings, union.standard, reply.compilerPath));

  // Tiers 1 + 2.
  const perFile = new Map<string, SourceFileConfiguration>();
  const sharedConfigs = new Map<string, SourceFileConfiguration>(); // owner-set key → agreed config
  for (const [file, owners] of mapOwners(compiling, projectRoot)) {
    if (owners.length === 1) {
      perFile.set(file, targetConfigs[owners[0]]);
      continue;
    }
    const ownerSetKey = owners.join(",");
    let shared = sharedConfigs.get(ownerSetKey);
    if (!shared) {
      shared = configFor(
        agreedCompile(owners.map((index) => compiles[index])),
        mappings,
        union.standard,
        reply.compilerPath,
      );
      sharedConfigs.set(ownerSetKey, shared);
    }
    perFile.set(file, shared);
  }

  return { perFile, defaultConfig, browsePath, compilerPath: reply.compilerPath };
}
