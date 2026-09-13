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
  /** True when the target has compile groups. INTERFACE / UTILITY targets can LIST sources
   *  but carry no compile data, so they must never decide a file's IntelliSense config. */
  compiles: boolean;
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
  paths?: { source?: string; build?: string };
  configurations?: { name: string; targets?: { name: string; jsonFile: string }[] }[];
}
interface CMakeFilesJson {
  paths?: { source?: string; build?: string };
  inputs?: { path: string; isGenerated?: boolean; isExternal?: boolean; isCMake?: boolean }[];
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
  sourceIndexes?: number[];
}
interface TargetJson {
  name?: string;
  type?: string; // EXECUTABLE | STATIC_LIBRARY | MODULE_LIBRARY | UTILITY | …
  artifacts?: { path: string }[];
  compileGroups?: CompileGroup[];
  sources?: { path: string; compileGroupIndex?: number }[];
}

// ---- Command-level shapes (compile_commands.json synthesis) ----------------
/** One compile group kept whole — the provider merges groups, a compile command must not. */
export interface CommandGroup {
  language: string; // "CXX" | "C" | "RC" | …
  fragments: string[]; // raw compileCommandFragments, in order
  includes: IncludeEntry[];
  defines: string[];
  sourceIndexes: number[];
}

export interface CommandTarget {
  name: string;
  groups: CommandGroup[];
  sources: { path: string; groupIndex?: number }[]; // every listed source, code or not
  compile: TargetCompile; // the provider's merged view (parseTarget) — engine entries agree on it exactly
}

export interface CommandReply {
  sourceDir: string;
  buildDir: string;
  compilerPath?: string;
  targets: CommandTarget[]; // compiling targets only
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

/**
 * The CMake inputs whose change makes IntelliSense data stale: the files that DEFINE targets,
 * source lists and enabled gems — `CMakeLists.txt`, `*.cmake` (incl. `*_files.cmake`) and
 * `project.json`. CMake's own modules and generated files are skipped.
 *
 * `gem.json` and the o3de manifest are deliberately NOT watched. Measured on gs_play, 18 gem.json
 * files were rewritten in one 88 ms batch and the manifest is rewritten by O3DE tooling, with no
 * change to targets — watching them made a verified-working project read "stale".
 */
const TARGET_DEFINING_INPUT = /(^|[\\/])CMakeLists\.txt$|\.cmake$|(^|[\\/])project\.json$/i;

export function parseTargetDefiningInputs(json: CMakeFilesJson): string[] {
  const source = json.paths?.source ?? "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const input of json.inputs ?? []) {
    if (input.isCMake || input.isGenerated || !TARGET_DEFINING_INPUT.test(input.path)) {
      continue;
    }
    const abs = path.isAbsolute(input.path) ? input.path : path.join(source, input.path);
    const key = abs.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(abs);
    }
  }
  return out;
}

const MODULE_TYPES = new Set(["MODULE_LIBRARY", "SHARED_LIBRARY"]);
const MODULE_BINARY = /\.(dll|so|dylib)$/i;

/** A module/shared target's library binaries (absolute) — what the Editor loads and reflects from.
 *  Taken from the target's own artifacts, so engine / 3rd-party DLLs copied into bin/ never count. */
export function parseModuleArtifacts(json: TargetJson, buildDir: string): string[] {
  if (!json.type || !MODULE_TYPES.has(json.type)) {
    return [];
  }
  return (json.artifacts ?? [])
    .map((artifact) => artifact.path)
    .filter((artifactPath) => MODULE_BINARY.test(artifactPath))
    .map((artifactPath) => (path.isAbsolute(artifactPath) ? artifactPath : path.join(buildDir, artifactPath)));
}

/** A target's compile groups and sources, kept at command granularity. */
export function parseCommandTarget(json: TargetJson): CommandTarget {
  return {
    name: json.name ?? "",
    groups: (json.compileGroups ?? []).map((group) => ({
      language: group.language ?? "",
      fragments: (group.compileCommandFragments ?? []).map((fragment) => fragment.fragment),
      includes: (group.includes ?? []).map((include) => ({ path: include.path, isSystem: include.isSystem })),
      defines: (group.defines ?? []).map((define) => define.define),
      sourceIndexes: group.sourceIndexes ?? [],
    })),
    sources: (json.sources ?? []).map((source) => ({ path: source.path, groupIndex: source.compileGroupIndex })),
    compile: parseTarget(json),
  };
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
      targets.push({
        compile: parseTarget(targetJson),
        sourcePaths: parseTargetSourcePaths(targetJson),
        compiles: (targetJson.compileGroups ?? []).length > 0,
      });
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

// ---- Freshness inputs --------------------------------------------------------
/** When the newest reply was written (ms), i.e. the last configure — undefined when never configured. */
export function replyTimestamp(replyDir: string): number | undefined {
  try {
    const indexFile = latestIndexFile(replyDir);
    return indexFile ? fs.statSync(indexFile).mtimeMs : undefined;
  } catch {
    return undefined; // no reply directory
  }
}

/** Target-defining CMake inputs for the newest reply; undefined when the reply has no cmakeFiles
 *  object (a configure from before the query asked for it — freshness is then unknowable). */
export function loadTargetDefiningInputs(replyDir: string): string[] | undefined {
  const indexFile = latestIndexFile(replyDir);
  const name = indexFile ? readJson<IndexJson>(indexFile)?.objects?.find((o) => o.kind === "cmakeFiles")?.jsonFile : undefined;
  const json = name ? readJson<CMakeFilesJson>(path.join(replyDir, name)) : undefined;
  return json ? parseTargetDefiningInputs(json) : undefined;
}

/** Compiling targets at command granularity, plus the dirs and compiler a compile command needs. */
export function loadCommandReply(replyDir: string, configName: string): CommandReply | undefined {
  const indexFile = latestIndexFile(replyDir);
  const objects = indexFile ? (readJson<IndexJson>(indexFile)?.objects ?? []) : [];
  const codemodelName = objects.find((o) => o.kind === "codemodel")?.jsonFile;
  const toolchainsName = objects.find((o) => o.kind === "toolchains")?.jsonFile;
  const codemodel = codemodelName ? readJson<CodemodelJson>(path.join(replyDir, codemodelName)) : undefined;
  const config = codemodel ? pickConfiguration(codemodel, configName) : undefined;
  if (!codemodel || !config) {
    return undefined;
  }
  const targets = config.targets
    .map((target) => readJson<TargetJson>(path.join(replyDir, target.jsonFile)))
    .filter((json): json is TargetJson => json !== undefined && (json.compileGroups ?? []).length > 0)
    .map(parseCommandTarget);
  return {
    sourceDir: codemodel.paths?.source ?? "",
    buildDir: codemodel.paths?.build ?? "",
    compilerPath: toolchainsName
      ? parseCompilerPath(readJson<ToolchainsJson>(path.join(replyDir, toolchainsName)) ?? {})
      : undefined,
    targets,
  };
}

/** Every module/shared library binary this build produces for `configName` (absolute paths). */
export function loadModuleArtifacts(replyDir: string, configName: string): string[] {
  const indexFile = latestIndexFile(replyDir);
  const codemodelName = indexFile ? readJson<IndexJson>(indexFile)?.objects?.find((o) => o.kind === "codemodel")?.jsonFile : undefined;
  const codemodel = codemodelName ? readJson<CodemodelJson>(path.join(replyDir, codemodelName)) : undefined;
  const config = codemodel ? pickConfiguration(codemodel, configName) : undefined;
  if (!codemodel || !config) {
    return [];
  }
  const buildDir = codemodel.paths?.build ?? "";
  return config.targets.flatMap((target) => {
    const json = readJson<TargetJson>(path.join(replyDir, target.jsonFile));
    return json ? parseModuleArtifacts(json, buildDir) : [];
  });
}
