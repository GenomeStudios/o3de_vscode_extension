// ============================================================================
//  CMake File API reader — the IntelliSense data source (Approach 2).
//
//  Our Configure command writes a File API query; CMake emits a reply under
//  build/<platform>/.cmake/api/v1/reply/. This module turns that reply into the
//  per-target compile data (include paths, defines, C++ standard, compiler) that
//  we consolidate + remap into c_cpp_properties.json — with NO dependency on
//  CMake Tools (which cannot establish the MSVC environment for O3DE).
//
//  parse* functions are pure (JSON → typed); loadFileApiReply does the I/O.
// ============================================================================

import * as fs from "fs";
import * as path from "path";

// ---- Extracted shapes ------------------------------------------------------
export interface IncludeEntry {
  path: string;
  isSystem?: boolean;
}

export interface TargetCompile {
  includes: IncludeEntry[]; // from compileGroups[].includes + external:I fragments
  defines: string[]; // e.g. AZ_ENABLE_TRACING, WIN64, _HAS_EXCEPTIONS=0
  forcedIncludes: string[]; // /FI<path> (O3DE forces VSCompat.h) → cpptools forcedInclude
  standard?: string; // C++ standard digits, e.g. "20"
}

/** A target's compile config plus the source files it owns (for per-file provider config). */
export interface LoadedTarget {
  compile: TargetCompile;
  sourcePaths: string[]; // C/C++ sources listed for the target (relative to project root, or absolute)
}

/** An EXECUTABLE target — a runnable the Run Target picker can offer. */
export interface ExecutableTarget {
  name: string; // CMake target name, e.g. "O3DEQtControlGallery"
  artifact?: string; // build-dir-relative output, e.g. "bin/profile/O3DEQtControlGallery.exe"
}

export interface FileApiReply {
  configName: string;
  compilerPath?: string; // CXX compiler (cl.exe) for c_cpp_properties.compilerPath
  targets: LoadedTarget[];
}

// ---- Raw JSON shapes (only the fields we read) -----------------------------
interface IndexJson {
  objects?: { kind: string; jsonFile: string }[];
}
interface CodemodelJson {
  configurations?: { name: string; targets?: { name: string; jsonFile: string }[] }[];
}
interface ToolchainsJson {
  toolchains?: { language?: string; compiler?: { path?: string } }[];
}
interface CompileGroup {
  language?: string;
  includes?: { path: string; isSystem?: boolean }[];
  defines?: { define: string }[];
  compileCommandFragments?: { fragment: string; role?: string }[];
  languageStandard?: { standard?: string };
}
interface TargetJson {
  name?: string;
  type?: string; // EXECUTABLE | STATIC_LIBRARY | MODULE_LIBRARY | UTILITY | …
  artifacts?: { path: string }[];
  compileGroups?: CompileGroup[];
  sources?: { path: string }[];
}

// ---- Pure parsers ----------------------------------------------------------
const EXTERNAL_INCLUDE_PREFIXES = ["-external:I", "/external:I", "-I", "/I"];

/** Pull include paths carried as compiler flags (O3DE 3rd-party libs use `-external:I<path>`). */
export function extractFragmentIncludes(fragments: { fragment: string }[]): string[] {
  const out: string[] = [];
  for (const { fragment } of fragments) {
    for (const prefix of EXTERNAL_INCLUDE_PREFIXES) {
      if (fragment.startsWith(prefix) && fragment.length > prefix.length) {
        out.push(fragment.slice(prefix.length).trim().replace(/^"|"$/g, ""));
        break;
      }
    }
  }
  return out;
}

/** Pull forced includes (MSVC `/FI<path>`) — usually O3DE's VSCompat.h — from the flag fragments.
 *  These live INSIDE the combined-flags fragment, not as standalone tokens, so scan the string. */
export function extractForcedIncludes(fragments: { fragment: string }[]): string[] {
  const out: string[] = [];
  for (const { fragment } of fragments) {
    for (const match of fragment.matchAll(/[-/]FI\s*("[^"]+"|\S+)/g)) {
      out.push(match[1].replace(/^"|"$/g, ""));
    }
  }
  return out;
}

/** Extract include paths / defines / forced includes / C++ standard from a target's compileGroups. */
export function parseTarget(json: TargetJson): TargetCompile {
  const includes: IncludeEntry[] = [];
  const defines: string[] = [];
  const forcedIncludes: string[] = [];
  let standard: string | undefined;

  for (const group of json.compileGroups ?? []) {
    for (const inc of group.includes ?? []) {
      includes.push({ path: inc.path, isSystem: inc.isSystem });
    }
    const fragments = group.compileCommandFragments ?? [];
    for (const ext of extractFragmentIncludes(fragments)) {
      includes.push({ path: ext, isSystem: true }); // 3rd-party → treat as system
    }
    forcedIncludes.push(...extractForcedIncludes(fragments));
    for (const def of group.defines ?? []) {
      defines.push(def.define);
    }
    if (!standard && group.language === "CXX" && group.languageStandard?.standard) {
      standard = group.languageStandard.standard;
    }
  }
  return { includes, defines, forcedIncludes, standard };
}

const CODE_SOURCE = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|inl|ipp|tpp)$/i;

/** The C/C++ source files a target owns (skips .cmake/.props and — since unity blobs carry the
 *  compile group — this is how we map a project's own files to their target's config). */
export function parseTargetSourcePaths(json: TargetJson): string[] {
  return (json.sources ?? []).map((s) => s.path).filter((p) => CODE_SOURCE.test(p));
}

/** An EXECUTABLE target's name + artifact from a per-target reply, else undefined. */
export function parseExecutableTarget(json: TargetJson): ExecutableTarget | undefined {
  if (json.type !== "EXECUTABLE" || !json.name) {
    return undefined;
  }
  return { name: json.name, artifact: json.artifacts?.[0]?.path };
}

/** The CXX compiler path (cl.exe) from the toolchains reply. */
export function parseCompilerPath(json: ToolchainsJson): string | undefined {
  const cxx = (json.toolchains ?? []).find((t) => t.language === "CXX");
  return cxx?.compiler?.path;
}

/** Choose the codemodel configuration matching `configName` (case-insensitive), else the first. */
export function pickConfiguration(
  json: CodemodelJson,
  configName: string,
): { name: string; targets: { name: string; jsonFile: string }[] } | undefined {
  const configs = json.configurations ?? [];
  const match =
    configs.find((c) => c.name.toLowerCase() === configName.toLowerCase()) ?? configs[0];
  return match ? { name: match.name, targets: match.targets ?? [] } : undefined;
}

/** The buildable target names for a config, de-duplicated in codemodel order (drives the picker). */
export function parseTargetNames(json: CodemodelJson, configName: string): string[] {
  const config = pickConfiguration(json, configName);
  if (!config) {
    return [];
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const { name } of config.targets) {
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

// ---- I/O loader ------------------------------------------------------------
function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Newest index-*.json in a reply directory (timestamped names sort lexically). */
function latestIndexFile(replyDir: string): string | undefined {
  const names = fs
    .readdirSync(replyDir)
    .filter((n) => /^index-.*\.json$/.test(n))
    .sort();
  return names.length ? path.join(replyDir, names[names.length - 1]) : undefined;
}

/** Load + parse the File API reply for the given build config. */
export function loadFileApiReply(replyDir: string, configName: string): FileApiReply | undefined {
  const indexFile = latestIndexFile(replyDir);
  if (!indexFile) {
    return undefined;
  }
  const index = readJson<IndexJson>(indexFile);
  const objects = index?.objects ?? [];
  const codemodelName = objects.find((o) => o.kind === "codemodel")?.jsonFile;
  const toolchainsName = objects.find((o) => o.kind === "toolchains")?.jsonFile;
  if (!codemodelName) {
    return undefined;
  }

  const codemodel = readJson<CodemodelJson>(path.join(replyDir, codemodelName));
  if (!codemodel) {
    return undefined;
  }
  const config = pickConfiguration(codemodel, configName);
  if (!config) {
    return undefined;
  }

  const targets: LoadedTarget[] = [];
  for (const target of config.targets) {
    const targetJson = readJson<TargetJson>(path.join(replyDir, target.jsonFile));
    if (targetJson) {
      targets.push({ compile: parseTarget(targetJson), sourcePaths: parseTargetSourcePaths(targetJson) });
    }
  }

  const compilerPath = toolchainsName
    ? parseCompilerPath(readJson<ToolchainsJson>(path.join(replyDir, toolchainsName)) ?? {})
    : undefined;

  return { configName: config.name, compilerPath, targets };
}

/**
 * Just the buildable target names from a reply — reads only the index + codemodel
 * (not every per-target file), so it's cheap enough to run when opening the picker.
 */
export function loadTargetNames(replyDir: string, configName: string): string[] {
  const indexFile = latestIndexFile(replyDir);
  if (!indexFile) {
    return [];
  }
  const index = readJson<IndexJson>(indexFile);
  const codemodelName = (index?.objects ?? []).find((o) => o.kind === "codemodel")?.jsonFile;
  if (!codemodelName) {
    return [];
  }
  const codemodel = readJson<CodemodelJson>(path.join(replyDir, codemodelName));
  return codemodel ? parseTargetNames(codemodel, configName) : [];
}

/**
 * Every EXECUTABLE target for a config — the candidates the Run Target picker
 * offers. This one DOES read the per-target files (target type/artifacts only
 * live there), but they are small (tens of KB each) so a picker-open read of
 * the whole reply stays well under a second even on a source-engine tree.
 */
export function loadExecutableTargets(replyDir: string, configName: string): ExecutableTarget[] {
  const indexFile = latestIndexFile(replyDir);
  if (!indexFile) {
    return [];
  }
  const index = readJson<IndexJson>(indexFile);
  const codemodelName = (index?.objects ?? []).find((o) => o.kind === "codemodel")?.jsonFile;
  if (!codemodelName) {
    return [];
  }
  const codemodel = readJson<CodemodelJson>(path.join(replyDir, codemodelName));
  const config = codemodel ? pickConfiguration(codemodel, configName) : undefined;
  if (!config) {
    return [];
  }
  const out: ExecutableTarget[] = [];
  const seen = new Set<string>();
  for (const target of config.targets) {
    const json = readJson<TargetJson>(path.join(replyDir, target.jsonFile));
    const exe = json ? parseExecutableTarget(json) : undefined;
    if (exe && !seen.has(exe.name)) {
      seen.add(exe.name);
      out.push(exe);
    }
  }
  return out;
}
