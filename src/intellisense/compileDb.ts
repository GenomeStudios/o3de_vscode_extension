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
//    argv = compiler, defines, includes, the group's flag fragments, language, file
//
//  The switch syntax follows the COMPILER (compilerToolchain): cl and clang-cl take
//  MSVC switches (/D /I /external:I /TP); every other compiler (clang++, g++ — the
//  Linux case) takes GNU ones (-D -I -isystem <dir> -x c++). The File API's
//  toolchains reply carries no frontend variant (only id, path, version), so the
//  executable's name decides.
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
//  • Warnings never become errors: /WX, -WX, -Werror and -Werror=<x> are dropped from
//    EVERY entry (-Wno-error=<x> stays). The build's own compiler is the one that
//    enforces them; clangd warns about things cl and gcc never do (-Wswitch...), and
//    those must not show as red errors.
//
//  ENGINE SOURCE (redirected projects — SDK build + source engine in the workspace):
//  the SDK's engine targets are IMPORTED, so no engine .cpp is in the reply and
//  clangd could never index engine implementations. Framework sources (owner scope
//  decision, plan I.5: ~91% of a project's engine includes) get entries built from
//  the provider's tier-3 rule — union includes, agreed defines — with the project's
//  switches. That shared command is built for a CONSUMER of the engine, where module
//  exports read as dllimport; so each engine source also gets the export defines of
//  the module that owns it (AZCORE_EXPORTS...; moduleDefines.ts reads them from the
//  user's own source engine), turning them into dllexport as in the engine's own
//  build. Other platforms' PAL folders are skipped, as the engine's own build skips
//  them, so Go to Definition can't land in the wrong platform's code.
//
//  SHARED-COMMAND GROUPS: engine Framework sources are one group of files that take the shared
//  command. Others join them (SharedCommandSources): the participating engine gems, and gem
//  sources the configure never lists (a legacy file list, a gem not enabled in the project).
//  A group may add its owning gem's own directories, tried before the shared union. What goes
//  into each group is decided in databasePlan.ts.
//
//  Pure except the listers and writer at the bottom; vscode-free.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { CommandGroup, CommandReply, CommandTarget, IncludeEntry, loadCommandReply } from "./fileApi";
import { agreedCompile } from "./consolidate";
import { ModuleDefineLookup } from "./moduleDefines";
import { remapIncludes, remapPath, RootMapping } from "./remap";
import { isUnderRoot, normalizePath, uniqueStable } from "./paths";

// ---- Model -----------------------------------------------------------------
export interface CompileCommand {
  directory: string;
  file: string;
  arguments: string[];
}

const COMPILABLE = /\.(c|cc|cpp|cxx|c\+\+)$/i;
const C_SOURCE = /\.c$/i;

// ---- Compiler flag style ---------------------------------------------------
/** The switch syntax a compiler speaks: MSVC's (`/D`, `/I`) or the GNU / clang one (`-D`, `-I`). */
export type FlagStyle = "msvc" | "gnu";

export interface Toolchain {
  compiler: string; // argv[0] of every entry
  style: FlagStyle;
}

/**
 * The compiler and flag style for a compile database. The style comes from the executable's name, without
 * directory or extension: `cl` and `clang-cl` are MSVC-style, anything else (clang++, g++, c++) is GNU-style.
 * With no compiler in the reply, the host's own default: cl.exe on Windows, c++ elsewhere.
 */
export function compilerToolchain(compilerPath: string | undefined, platform: NodeJS.Platform = process.platform): Toolchain {
  if (!compilerPath) {
    return platform === "win32" ? { compiler: "cl.exe", style: "msvc" } : { compiler: "c++", style: "gnu" };
  }
  const fileName = compilerPath.split(/[\\/]/).pop() ?? "";
  const name = fileName.replace(/\.[^.]*$/, "").toLowerCase();
  return { compiler: compilerPath, style: name === "cl" || name === "clang-cl" ? "msvc" : "gnu" };
}

/**
 * The compiler clangd should be allowed to query for its own system include dirs (`--query-driver`):
 * the reply's compiler when it is GNU-style, nothing for cl / clang-cl or when no compiler is known.
 */
export function queryDriverFor(compilerPath: string | undefined): string | undefined {
  return compilerPath && compilerToolchain(compilerPath).style === "gnu" ? compilerPath : undefined;
}

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

/** Switches whose value is a path, either prefix, value attached or in the next token:
 *  MSVC `-external:I`, `/FI` (forced include), `/I`; GNU `-I`, `-isystem`, `-iquote`, `-idirafter`. */
const PATH_SWITCH = /^([-/])(external:I|FI|I|isystem|iquote|idirafter)(.*)$/;

/** GNU switches whose value is ALWAYS the next token (`-include <file>`); `-include-pch` and friends are not these. */
const DETACHED_PATH_SWITCH = /^-(include|imacros)$/;

/** Remap the path carried by every path switch; every other token passes through untouched. */
export function remapFlagTokens(tokens: string[], mappings: RootMapping[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const match = token.match(PATH_SWITCH);
    if (match?.[3]) {
      const [, prefix, name, value] = match;
      out.push(`${prefix}${name}${remapPath(value, mappings)}`);
    } else if ((match || DETACHED_PATH_SWITCH.test(token)) && i + 1 < tokens.length) {
      out.push(token, remapPath(tokens[i + 1], mappings)); // detached value: `/I path`, `-isystem path`, `-include path`
      i += 1;
    } else {
      out.push(token);
    }
  }
  return out;
}

/** Warnings made errors: MSVC `/WX`, `-WX`; GNU `-Werror`, `-Werror=<warning>` and the old `-Werror-implicit-function-declaration`
 *  spelling. (`/WX-` and `-Wno-error=<x>` stay.) */
const WARNINGS_AS_ERRORS = /^([-/]WX|-Werror([=-].*)?)$/;

/** The tokens without the switches that turn warnings into errors. */
export function withoutWarningsAsErrors(tokens: string[]): string[] {
  return tokens.filter((token) => !WARNINGS_AS_ERRORS.test(token));
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
/** `-x <language>` must precede the file it applies to — every template ends with it, right before the file. */
const LANGUAGE_SWITCH: Record<FlagStyle, Record<string, string[]>> = {
  msvc: { CXX: ["/TP"], C: ["/TC"] },
  gnu: { CXX: ["-x", "c++"], C: ["-x", "c"] },
};

function defineTokens(defines: string[], style: FlagStyle): string[] {
  return defines.map((define) => (style === "msvc" ? `/D${define}` : `-D${define}`));
}

/**
 * Include switches, remapped and deduplicated in first-seen order. MSVC: `/Idir`, `/external:Idir`.
 * GNU: `-Idir`, and `-isystem` + dir as TWO tokens (the attached form isn't valid for every driver).
 * Windows paths ignore case when deduplicating; Linux paths don't.
 */
function includeTokens(includes: IncludeEntry[], style: FlagStyle, mappings: RootMapping[]): string[] {
  const switches = includes.map((include): string[] => {
    const dir = remapPath(include.path, mappings);
    if (style === "msvc") {
      return [`${include.isSystem ? "/external:I" : "/I"}${dir}`];
    }
    return include.isSystem ? ["-isystem", dir] : [`-I${dir}`];
  });
  const seen = new Set<string>();
  return switches
    .filter((tokens) => {
      const key = style === "msvc" ? tokens.join(" ").toLowerCase() : tokens.join(" ");
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .flat();
}

/** Everything before the file name — identical for every file a group set compiles, so built once per set. */
function argumentsTemplate(toolchain: Toolchain, group: CommandGroup, mappings: RootMapping[]): string[] {
  const { compiler, style } = toolchain;
  const flags = withoutWarningsAsErrors(remapFlagTokens(group.fragments.flatMap(splitFlags), mappings));
  return [
    compiler,
    ...defineTokens(group.defines, style),
    ...includeTokens(group.includes, style, mappings),
    ...flags,
    ...(LANGUAGE_SWITCH[style][group.language] ?? []),
  ];
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
  darwin: {
    platforms: ["Android", "Windows", "Linux", "iOS", "Emscripten"],
    common: ["WinAPI", "LinuxLike", "Wayland", "Xcb"],
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

/** Include switches: MSVC `/I`, `/external:I`; GNU `-I`, `-isystem`. */
const INCLUDE_SWITCH = /^[-/](external:I|I|isystem)(.*)$/;

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

/**
 * Sources that have no target of their own in the reply compile with ONE shared command — the provider's
 * tier-3 rule: the union of every target's includes (redirected), the defines they all agree on, and the
 * project's switches minus warnings-as-errors. `includes` and `exportDefines` add what belongs to a group alone.
 */
export interface SharedCommandSources {
  files: string[];
  /** The owning gem's own directories (Code/Include, Code/Source, PAL folders): tried before the shared union. */
  includes?: string[];
  /** The export defines of the module owning each file (moduleDefines.ts); none when omitted. */
  exportDefines?: ModuleDefineLookup;
}

interface SharedCommand {
  defines: string[]; // agreed across every target
  includes: IncludeEntry[]; // the union, already redirected into the source engine
  tail: string[]; // the project's switches, then the language switch
}

function sharedCommand(reply: CommandReply, toolchain: Toolchain, mappings: RootMapping[]): SharedCommand | undefined {
  const group = reply.targets.flatMap((target) => target.groups).find((candidate) => candidate.language === "CXX");
  if (!group) {
    return undefined;
  }
  const agreed = agreedCompile(reply.targets.map((target) => target.compile));
  const switches = withoutIncludeSwitches(withoutWarningsAsErrors(remapFlagTokens(group.fragments.flatMap(splitFlags), mappings)));
  return {
    defines: agreed.defines,
    includes: remapIncludes(agreed.includes, mappings),
    tail: [...switches, ...LANGUAGE_SWITCH[toolchain.style].CXX],
  };
}

/** The argv of one shared-command entry, up to (not including) the file. */
function sharedArguments(shared: SharedCommand, toolchain: Toolchain, ownIncludes: string[], exportDefines: string[]): string[] {
  const { compiler, style } = toolchain;
  return [
    compiler,
    ...defineTokens(shared.defines, style),
    ...defineTokens(exportDefines, style),
    ...includeTokens([...ownIncludes.map((dir) => ({ path: dir })), ...shared.includes], style, []),
    ...shared.tail,
  ];
}

/** One entry per file the groups name that no earlier entry covers (a project's real entry always wins). */
function sharedEntries(
  reply: CommandReply,
  toolchain: Toolchain,
  mappings: RootMapping[],
  groups: SharedCommandSources[],
  covered: Set<string>,
): CompileCommand[] {
  const shared = groups.some((group) => group.files.length) ? sharedCommand(reply, toolchain, mappings) : undefined;
  if (!shared) {
    return [];
  }
  const commands: CompileCommand[] = [];
  for (const group of groups) {
    const templates = new Map<string, string[]>(); // a file's export defines → its argv up to the file, built once per group
    for (const source of group.files) {
      const file = normalizePath(source);
      if (covered.has(file.toLowerCase())) {
        continue;
      }
      covered.add(file.toLowerCase());
      const exportDefines = group.exportDefines?.(file) ?? [];
      const key = exportDefines.join(",");
      let template = templates.get(key);
      if (!template) {
        template = sharedArguments(shared, toolchain, group.includes ?? [], exportDefines);
        templates.set(key, template);
      }
      commands.push({ directory: reply.buildDir, file, arguments: [...template, file] });
    }
  }
  return commands;
}

// ---- Build -----------------------------------------------------------------
/** file key (lower-case) → the file and every (distinct) group that compiles it. */
function collectOwners(reply: CommandReply): Map<string, { file: string; groups: CommandGroup[] }> {
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
  return owners;
}

/** Every real source file the reply compiles (the ones that get a project or gem entry), normalized, each once. */
export function replySourceFiles(reply: CommandReply): string[] {
  return [...collectOwners(reply).values()].map((owner) => owner.file);
}

/**
 * One entry per real compilable source in the reply, plus one per shared-command file the reply doesn't
 * already cover (a project's real entry always wins; the first group to name a file keeps it), sorted by file
 * for stable output. `platform` only matters when the reply names no compiler (see compilerToolchain).
 *
 * `engineSources` is the engine Framework group; `engineModuleDefines` names the export defines of the
 * module owning each of them (moduleDefines.ts) — without it they take the shared command alone.
 * `moreSources` are further groups (engine gems, gem sources outside the configured targets).
 */
export function buildCompileDatabase(
  reply: CommandReply,
  mappings: RootMapping[],
  engineSources: string[] = [],
  platform: NodeJS.Platform = process.platform,
  engineModuleDefines?: ModuleDefineLookup,
  moreSources: SharedCommandSources[] = [],
): CompileCommand[] {
  const owners = collectOwners(reply);

  // Remapping stats the disk (verifyBase), so build each distinct group set's template once.
  const groupIds = new Map<CommandGroup, number>();
  const idOf = (group: CommandGroup): number => {
    if (!groupIds.has(group)) {
      groupIds.set(group, groupIds.size);
    }
    return groupIds.get(group) as number;
  };
  const templates = new Map<string, string[]>();
  const toolchain = compilerToolchain(reply.compilerPath, platform);

  const commands = [...owners.values()].map(({ file, groups }) => {
    const setKey = groups.map(idOf).join(",");
    let template = templates.get(setKey);
    if (!template) {
      template = argumentsTemplate(toolchain, mergeGroups(groups), mappings);
      templates.set(setKey, template);
    }
    return { directory: reply.buildDir, file, arguments: [...template, file] };
  });

  const covered = new Set(commands.map((command) => command.file.toLowerCase()));
  const groups: SharedCommandSources[] = [{ files: engineSources, exportDefines: engineModuleDefines }, ...moreSources];
  commands.push(...sharedEntries(reply, toolchain, mappings, groups, covered));
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
  let modules: fs.Dirent[];
  try {
    modules = fs.readdirSync(frameworkRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const module of modules) {
    const moduleDir = path.join(frameworkRoot, module.name);
    if (module.isDirectory() && !SKIP_SOURCE_DIRS.test(module.name) && moduleReachable(moduleDir)) {
      collectSources(moduleDir, platform, (name) => SKIP_SOURCE_DIRS.test(name), out);
    }
  }
  return out.sort();
}

/** Add every compilable source under `dir` to `out`: folders `skipDir` names and other platforms' PAL folders are not entered. */
function collectSources(dir: string, platform: NodeJS.Platform, skipDir: (name: string, full: string) => boolean, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDir(entry.name, full)) {
        collectSources(full, platform, skipDir, out);
      }
    } else if (COMPILABLE.test(entry.name)) {
      const file = normalizePath(full);
      if (!isOtherPlatformPath(file, platform)) {
        out.push(file);
      }
    }
  }
}

/** A gem's folders that hold no code of its own, at any depth: tests, vendored code, build output, dot-folders. */
const SKIP_GEM_DIRS = /^(tests?|external|3rdparty|build|\..*)$/i;

/**
 * The folders a walk of a gem's code folder does not enter (see SKIP_GEM_DIRS). A folder holding its own gem.json
 * is ANOTHER gem — a gem may enclose gems (Atom does) — and belongs to that one.
 *
 * An `Assets` folder directly under `codeRoot` is skipped: in a gem with no Code folder, `codeRoot` is the gem
 * root and `Assets` holds asset sources. Deeper `Assets` folders (`Code/Source/Integration/Assets`) are real code.
 */
export function gemFolderSkipper(codeRoot: string): (name: string, full: string) => boolean {
  const root = normalizePath(codeRoot).replace(/\/+$/, "");
  return (name, full) =>
    SKIP_GEM_DIRS.test(name) ||
    (name.toLowerCase() === "assets" && normalizePath(path.dirname(full)) === root) ||
    fs.existsSync(path.join(full, "gem.json"));
}

/** Every compilable source of a gem for this platform, under its code folder (see gemFolderSkipper), sorted. */
export function listGemSources(codeRoot: string, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  collectSources(codeRoot, platform, gemFolderSkipper(codeRoot), out);
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
