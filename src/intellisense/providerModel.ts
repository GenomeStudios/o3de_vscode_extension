// ============================================================================
//  Provider model (pure) — File API reply → per-file + browse configs.
//
//  Builds what the live CustomConfigurationProvider serves to cpptools:
//    • perFile — each of the project's OWN source files → its TARGET's config
//      (per-target precision; sharper than the project-wide union).
//    • defaultConfig — the consolidated union, used for headers / files we don't
//      index individually.
//    • browsePath — the consolidated include set for the symbol database.
//  Paths are ABSOLUTE (cpptools does not resolve ${workspaceFolder} in provider
//  responses) with the build engine remapped to the source engine's real path.
// ============================================================================

import * as path from "path";
import type { SourceFileConfiguration } from "vscode-cpptools";
import { FileApiReply } from "./fileApi";
import { consolidateTargets } from "./consolidate";
import { remapIncludes, remapPath, RootMapping } from "./remap";
import { cppStandardFromApi, intelliSenseModeFor } from "./cppProperties";
import { normalizePath, uniqueStable } from "./paths";

export interface ProviderModel {
  perFile: Map<string, SourceFileConfiguration>; // key = normalizePath(abs).toLowerCase()
  defaultConfig: SourceFileConfiguration; // consolidated fallback (headers / unknown files)
  browsePath: string[];
  compilerPath?: string;
}

const CODE_SOURCE = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|inl|ipp|tpp)$/i;

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

/** Build the provider model for one project's reply. `mappings` remap engine → source (absolute). */
export function buildProviderModel(
  reply: FileApiReply,
  projectRoot: string,
  mappings: RootMapping[],
): ProviderModel {
  const consolidated = consolidateTargets(reply.targets.map((t) => t.compile));
  const browsePath = uniqueStable(remapIncludes(consolidated.includes, mappings).map((i) => i.path));
  const browseForced = uniqueStable(consolidated.forcedIncludes.map((p) => remapPath(p, mappings)));
  const defaultConfig = toConfig(
    browsePath,
    consolidated.defines,
    browseForced,
    consolidated.standard,
    reply.compilerPath,
  );

  const perFile = new Map<string, SourceFileConfiguration>();
  for (const target of reply.targets) {
    const includePath = uniqueStable(remapIncludes(target.compile.includes, mappings).map((i) => i.path));
    const forcedInclude = uniqueStable(target.compile.forcedIncludes.map((p) => remapPath(p, mappings)));
    const config = toConfig(
      includePath,
      target.compile.defines,
      forcedInclude,
      target.compile.standard ?? consolidated.standard,
      reply.compilerPath,
    );
    for (const src of target.sourcePaths) {
      if (!CODE_SOURCE.test(src)) {
        continue;
      }
      const abs = path.isAbsolute(src) ? src : path.join(projectRoot, src);
      perFile.set(normalizePath(abs).toLowerCase(), config);
    }
  }

  return { perFile, defaultConfig, browsePath, compilerPath: reply.compilerPath };
}
