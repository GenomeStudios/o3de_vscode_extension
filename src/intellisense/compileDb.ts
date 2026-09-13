// ============================================================================
//  Compile database — compile_commands.json synthesized from the File API reply
//  (Tier 2 / clangd, plan I.4).
//
//  Why synthesize instead of CMAKE_EXPORT_COMPILE_COMMANDS: under O3DE's unity
//  build CMake's own database lists the generated unity blobs, not the real .cpp
//  files — the original IntelliSense pain. The File API still lists every real
//  source, so each one gets an entry built from the flags its target compiles it
//  with:
//
//    argv = compiler, /D defines, /I includes, the group's flag fragments, /TP, file
//
//  • A source with a compile group index uses that group. A unity-batched source
//    has none — it compiles inside a blob the build generated, so it takes the
//    flags of the group that compiles those blobs.
//  • Sources inside the build tree (unity blobs, generated code) get no entry;
//    indexing a blob would index every real file a second time.
//  • A file several targets compile resolves exactly like the live provider's
//    tier 2 (agreedCompile): union the includes, intersect the defines — so clangd
//    and cpptools never disagree about the same file.
//  • Include and forced-include paths go through the same engine remap as the
//    provider, so navigation lands in the workspace source engine.
//
//  ENGINE SOURCE (redirected projects — SDK build + source engine in the workspace):
//  the SDK's engine targets are IMPORTED, so no engine .cpp is in the reply and
//  clangd could never index engine implementations. Framework sources (owner scope
//  decision, plan I.5: ~91% of a project's engine includes) get entries built from
//  the provider's tier-3 rule — union includes, agreed defines — with the project's
//  switches MINUS /WX: a consumer sees engine exports as dllimport, and the
//  resulting linkage warnings, made errors by /WX, stopped the parse (measured with
//  real cl.exe and clangd). Other platforms' PAL folders are skipped, as the engine's
//  own build skips them, so Go to Definition can't land in the wrong platform's code.
//
//  Pure except the lister and writer at the bottom; vscode-free.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { CommandGroup, CommandReply, CommandTarget, loadCommandReply } from "./fileApi";
import { agreedCompile } from "./consolidate";
import { remapPath, RootMapping } from "./remap";
import { isUnderRoot, normalizePath, uniqueStable } from "./paths";

// ---- Model -----------------------------------------------------------------
export interface CompileCommand {
  directory: string;
  file: string;
  arguments: string[];
}

const COMPILABLE = /\.(c|cc|cpp|cxx|c\+\+)$/i;
const C_SOURCE = /\.c$/i;

// ---- Flag tokens -----------------------------------------------------------
/** Split a flags fragment into argv tokens: whitespace separates, double quotes group and are dropped. */
export function splitFlags(fragment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let started = false;
  for (const ch of fragment) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      started = true;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/** Switches whose value is a path: `-external:I`, `/FI` (forced include), `/I`. Either prefix; value attached or next token. */
const PATH_SWITCH = /^([-/])(external:I|FI|I)(.*)$/;

/** Remap the path carried by every path switch; every other token passes through untouched. */
export function remapFlagTokens(tokens: string[], mappings: RootMapping[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const match = tokens[i].match(PATH_SWITCH);
    if (!match) {
      out.push(tokens[i]);
      continue;
    }
    const [, prefix, name, value] = match;
    if (value) {
      out.push(`${prefix}${name}${remapPath(value, mappings)}`);
    } else if (i + 1 < tokens.length) {
      out.push(tokens[i], remapPath(tokens[i + 1], mappings)); // detached value: `/I path`
      i += 1;
    } else {
      out.push(tokens[i]);
    }
  }
  return out;
}

// ---- Group selection -------------------------------------------------------
const absolute = (file: string, sourceDir: string): string => (path.isAbsolute(file) ? file : path.join(sourceDir, file));

/** The index of the group a listed source compiles with, or undefined when the target has none for its language. */
export function groupIndexForSource(target: CommandTarget, sourceIndex: number, reply: CommandReply): number | undefined {
  const source = target.sources[sourceIndex];
  if (source.groupIndex !== undefined) {
    return source.groupIndex;
  }
  const language = C_SOURCE.test(source.path) ? "C" : "CXX";
  // Unity-batched: take the flags of the group compiling the blobs the build generated.
  const compilesBuildOutput = (group: CommandGroup): boolean =>
    group.sourceIndexes.some((index) => isUnderRoot(absolute(target.sources[index].path, reply.sourceDir), reply.buildDir));
  const blobGroup = target.groups.findIndex((group) => group.language === language && compilesBuildOutput(group));
  if (blobGroup >= 0) {
    return blobGroup;
  }
  const first = target.groups.findIndex((group) => group.language === language);
  return first >= 0 ? first : undefined;
}

/** Several groups compile one file: the provider's tier-2 rule — union includes, intersect defines. */
function mergeGroups(groups: CommandGroup[]): CommandGroup {
  if (groups.length === 1) {
    return groups[0];
  }
  const agreed = agreedCompile(groups.map((group) => ({ includes: group.includes, defines: group.defines, forcedIncludes: [] })));
  return { ...groups[0], includes: agreed.includes, defines: agreed.defines };
}

// ---- Arguments -------------------------------------------------------------
/** Everything before the file name — identical for every file a group set compiles, so built once per set. */
function argumentsTemplate(compilerPath: string, group: CommandGroup, mappings: RootMapping[]): string[] {
  const defines = group.defines.map((define) => `/D${define}`);
  const includes = uniqueStable(
    group.includes.map((include) => `${include.isSystem ? "/external:I" : "/I"}${remapPath(include.path, mappings)}`),
  );
  const flags = remapFlagTokens(group.fragments.flatMap(splitFlags), mappings);
  const language = group.language === "CXX" ? ["/TP"] : group.language === "C" ? ["/TC"] : [];
  return [compilerPath, ...defines, ...includes, ...flags, ...language];
}

// ---- Engine source entries -------------------------------------------------
/** O3DE Platform Abstraction Layer folders that belong to OTHER platforms, per host. The engine's own
 *  build compiles `Platform/<its platform>` plus shared `Common/` fallbacks (Default, Unimplemented). */
const OTHER_PLATFORM_FOLDERS: Partial<Record<NodeJS.Platform, { platforms: string[]; common: string[] }>> = {
  win32: {
    platforms: ["Android", "Linux", "Mac", "iOS", "Emscripten"],
    common: ["UnixLike", "UnixLikeDefault", "LinuxLike", "Apple", "Wayland", "Xcb"],
  },
  linux: {
    platforms: ["Android", "Windows", "Mac", "iOS", "Emscripten"],
    common: ["WinAPI", "Apple"],
  },
};

/** True when the path runs through another platform's PAL folder (`…/Platform/Linux/…`, `…/Platform/Common/UnixLike/…`). */
export function isOtherPlatformPath(file: string, platform: NodeJS.Platform): boolean {
  const table = OTHER_PLATFORM_FOLDERS[platform];
  if (!table) {
    return false;
  }
  const has = (list: string[], name: string | undefined): boolean =>
    name !== undefined && list.some((entry) => entry.toLowerCase() === name.toLowerCase());
  const segments = normalizePath(file).split("/");
  return segments.some((segment, index) => {
    if (segment.toLowerCase() !== "platform") {
      return false;
    }
    const next = segments[index + 1];
    return has(table.platforms, next) || (next?.toLowerCase() === "common" && has(table.common, segments[index + 2]));
  });
}

const WARNINGS_AS_ERRORS = /^[-/]WX$/;
const INCLUDE_SWITCH = /^[-/](external:I|I)(.*)$/;

/** Drop include switches (attached or detached value): engine entries take includes from the agreed union. */
function withoutIncludeSwitches(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const match = tokens[i].match(INCLUDE_SWITCH);
    if (!match) {
      out.push(tokens[i]);
    } else if (!match[2]) {
      i += 1; // detached value
    }
  }
  return out;
}

/** The argv every engine source shares: the provider's tier-3 rule, the project's switches minus /WX. */
function engineArgumentsTemplate(reply: CommandReply, mappings: RootMapping[]): string[] | undefined {
  const group = reply.targets.flatMap((target) => target.groups).find((candidate) => candidate.language === "CXX");
  if (!group) {
    return undefined;
  }
  const agreed = agreedCompile(reply.targets.map((target) => target.compile));
  const defines = agreed.defines.map((define) => `/D${define}`);
  const includes = uniqueStable(
    agreed.includes.map((include) => `${include.isSystem ? "/external:I" : "/I"}${remapPath(include.path, mappings)}`),
  );
  const switches = withoutIncludeSwitches(remapFlagTokens(group.fragments.flatMap(splitFlags), mappings)).filter(
    (token) => !WARNINGS_AS_ERRORS.test(token),
  );
  return [reply.compilerPath ?? "cl.exe", ...defines, ...includes, ...switches, "/TP"];
}

// ---- Build -----------------------------------------------------------------
/**
 * One entry per real compilable source in the reply, plus one per `engineSources` file the reply
 * doesn't already cover (a project's real entry always wins), sorted by file for stable output.
 */
export function buildCompileDatabase(
  reply: CommandReply,
  mappings: RootMapping[],
  engineSources: string[] = [],
): CompileCommand[] {
  // file key → the file and every (distinct) group that compiles it
  const owners = new Map<string, { file: string; groups: CommandGroup[] }>();
  for (const target of reply.targets) {
    target.sources.forEach((source, index) => {
      if (!COMPILABLE.test(source.path)) {
        return;
      }
      const file = normalizePath(absolute(source.path, reply.sourceDir));
      if (isUnderRoot(file, reply.buildDir)) {
        return; // unity blobs and generated sources
      }
      const groupIndex = groupIndexForSource(target, index, reply);
      if (groupIndex === undefined) {
        return;
      }
      const key = file.toLowerCase();
      const entry = owners.get(key) ?? { file, groups: [] };
      const group = target.groups[groupIndex];
      if (!entry.groups.includes(group)) {
        entry.groups.push(group);
      }
      owners.set(key, entry);
    });
  }

  // Remapping stats the disk (verifyBase), so build each distinct group set's template once.
  const groupIds = new Map<CommandGroup, number>();
  const idOf = (group: CommandGroup): number => {
    if (!groupIds.has(group)) {
      groupIds.set(group, groupIds.size);
    }
    return groupIds.get(group) as number;
  };
  const templates = new Map<string, string[]>();
  const compilerPath = reply.compilerPath ?? "cl.exe";

  const commands = [...owners.values()].map(({ file, groups }) => {
    const setKey = groups.map(idOf).join(",");
    let template = templates.get(setKey);
    if (!template) {
      template = argumentsTemplate(compilerPath, mergeGroups(groups), mappings);
      templates.set(setKey, template);
    }
    return { directory: reply.buildDir, file, arguments: [...template, file] };
  });

  if (engineSources.length) {
    const engineTemplate = engineArgumentsTemplate(reply, mappings);
    if (engineTemplate) {
      const covered = new Set(commands.map((command) => command.file.toLowerCase()));
      for (const source of engineSources) {
        const file = normalizePath(source);
        if (!covered.has(file.toLowerCase())) {
          covered.add(file.toLowerCase());
          commands.push({ directory: reply.buildDir, file, arguments: [...engineTemplate, file] });
        }
      }
    }
  }
  return commands.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// ---- List engine sources ---------------------------------------------------
const SKIP_SOURCE_DIRS = /^(tests?|external|3rdparty)$/i;

/** The include paths the project's code compiles with (union across targets, engine paths redirected). */
export function projectIncludePaths(reply: CommandReply, mappings: RootMapping[]): string[] {
  return uniqueStable(agreedCompile(reply.targets.map((target) => target.compile)).includes.map((include) => remapPath(include.path, mappings)));
}

/**
 * The source engine's `Code/Framework` sources for this platform (tests, vendored code and other
 * platforms' PAL folders excluded), sorted.
 *
 * With `includePaths`, only Framework modules the project can actually `#include` are listed — a module
 * none of the project's include paths reaches is one its code never navigates into. Measured on gs_play
 * this drops AzTest, AzManipulatorTestFramework (whose sources wouldn't even parse: its headers aren't
 * on any project include path) and AzAndroid.
 */
export function listFrameworkSources(
  sourceEngineRoot: string,
  platform: NodeJS.Platform = process.platform,
  includePaths?: string[],
): string[] {
  const frameworkRoot = path.join(sourceEngineRoot, "Code", "Framework");
  const reachable = includePaths?.map((include) => normalizePath(include).toLowerCase());
  const moduleReachable = (moduleDir: string): boolean => {
    if (!reachable) {
      return true;
    }
    const root = normalizePath(moduleDir).replace(/\/+$/, "").toLowerCase();
    return reachable.some((include) => include === root || include.startsWith(`${root}/`));
  };
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_SOURCE_DIRS.test(entry.name)) {
          walk(full);
        }
      } else if (COMPILABLE.test(entry.name)) {
        const file = normalizePath(full);
        if (!isOtherPlatformPath(file, platform)) {
          out.push(file);
        }
      }
    }
  };
  let modules: fs.Dirent[];
  try {
    modules = fs.readdirSync(frameworkRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const module of modules) {
    const moduleDir = path.join(frameworkRoot, module.name);
    if (module.isDirectory() && !SKIP_SOURCE_DIRS.test(module.name) && moduleReachable(moduleDir)) {
      walk(moduleDir);
    }
  }
  return out.sort();
}

// ---- Write -----------------------------------------------------------------
/** Where the database lives: its own folder in the build tree, so CMake's own export can never overwrite it. */
export function compileDatabaseDir(buildDir: string): string {
  return path.join(buildDir, "clangd");
}

export interface CompileDatabaseResult {
  file: string;
  entries: number;
  changed: boolean; // false when an identical database was already on disk (clangd need not reload)
}

/** Write a database into `<buildDir>/clangd/` — skipping the write when an identical one is already there. */
export function writeCompileDatabase(buildDir: string, commands: CompileCommand[]): CompileDatabaseResult {
  const dir = compileDatabaseDir(buildDir);
  const file = path.join(dir, "compile_commands.json");
  const output = `${JSON.stringify(commands, null, 2)}\n`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  if (existing === output) {
    return { file, entries: commands.length, changed: false };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, output, "utf8");
  return { file, entries: commands.length, changed: true };
}

/** Load the reply, build the database and write it — skipping the write when nothing changed. */
export function generateCompileDatabase(
  replyDir: string,
  configName: string,
  mappings: RootMapping[],
  engineSources: string[] = [],
): CompileDatabaseResult | undefined {
  const reply = loadCommandReply(replyDir, configName);
  return reply ? writeCompileDatabase(reply.buildDir, buildCompileDatabase(reply, mappings, engineSources)) : undefined;
}
