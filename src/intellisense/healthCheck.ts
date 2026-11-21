// ============================================================================
//  IntelliSense health check - the rules. vscode-free; only reads the file system.
//
//  A check samples files from the compile database clangd reads and runs
//  `clangd --check` on each. This module holds everything that decides WHAT is
//  checked and HOW its output is read:
//
//    clangd binary    clangd.path, else the clangd extension's own download, else PATH
//    the database     entries read from compile_commands.json (arguments or command form),
//                     each classified by origin, the include dirs that don't exist counted
//    the sample       deterministic, stratified by origin, plus sources with NO entry
//    --check output   real compile errors only: `E[..] [code] Line N: message`.
//                     clangd's own "All checks completed, N errors" also counts refactoring
//                     tweaks failing and "Failed to resolve URI" noise, so it is never trusted
//    the roots        which database is checked, where sources with no entry are looked for, and which
//                     folders a build makes - each decided from the user's own data, with the file
//                     system checks passed in (so the vscode side only reads settings)
//
//  Nothing here names a project, gem or path: every root comes in through the inputs.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { CLANGD_EXTENSION_ID } from "../constants";
import { ClangdResolveContext, resolveClangdExecutable } from "../deps/clangdServer";
import { sameDirectory } from "./clangdDatabase";
import { FlagStyle, Toolchain, compilerToolchain, isOtherPlatformPath, splitFlags } from "./compileDb";
import { gemCodeRoot } from "./databasePlan";
import type { OriginCounts } from "./databasePlan";
import type { EngineModeReport } from "./engineMode";
import {
  ClangdLocation,
  CommandSource,
  DEFAULT_SAMPLE_SIZE,
  DatabaseKind,
  MAX_ENTRYLESS,
  MAX_SAMPLE_SIZE,
  MIN_SAMPLE_SIZE,
  Origin,
  OriginRoots,
  SampleOrigin,
  ScanRoot,
} from "./healthModel";
import { isUnderRoot, normalizePath, uniqueStable } from "./paths";

// ---- Reading clangd's --check output ---------------------------------------
export interface CompileError {
  line: number;
  code: string; // clangd's diagnostic name, e.g. pp_file_not_found
  message: string;
}

export interface CheckOutput {
  errors: CompileError[]; // real compile errors only
  command: CommandSource;
  inferredFrom?: string; // the file whose flags clangd borrowed (or "clangd fallback")
  completed: boolean; // clangd got to the end of its checks
  clangdVersion?: string;
}

const ERROR_LINE = /^E\[[\d:.]+\] \[([^\]\s]+)\] Line (\d+): (.*)$/;
const COMMAND_LINE = /^I\[[\d:.]+\] Compile command (.+?) is: /;
const COMPLETED_LINE = /^I\[[\d:.]+\] All checks completed/;
const VERSION_LINE = /^I\[[\d:.]+\] clangd version (\S+)/;

/**
 * Read one `clangd --check` log. A real compile error is `E[time] [code] Line N: message`. Everything else on an E[ line
 * is noise: `tweak: ... ==> FAIL` (a refactoring offer that can't apply, often a multi-line message) and
 * `Failed to resolve URI`. clangd prints only errors here, never warnings.
 */
export function parseCheckOutput(text: string): CheckOutput {
  const output: CheckOutput = { errors: [], command: "unknown", completed: false };
  for (const line of text.split(/\r?\n/)) {
    const error = ERROR_LINE.exec(line);
    if (error) {
      output.errors.push({ line: Number(error[2]), code: error[1], message: error[3].trim() });
      continue;
    }
    const command = COMMAND_LINE.exec(line);
    const version = VERSION_LINE.exec(line);
    if (command) {
      const how = command[1];
      output.command = how === "from CDB" ? "entry" : "inferred";
      if (how !== "from CDB") {
        output.inferredFrom = how.replace(/^inferred from /, "");
      }
    } else if (COMPLETED_LINE.test(line)) {
      output.completed = true;
    } else if (version && output.clangdVersion === undefined) {
      output.clangdVersion = version[1];
    }
  }
  return output;
}

/** "line 19 [undeclared_var_use] use of undeclared identifier 'X'" - one error as the report shows it. */
export function describeError(error: CompileError): string {
  const message = error.message.length > 200 ? `${error.message.slice(0, 200)}...` : error.message;
  return `line ${error.line} [${error.code}] ${message}`;
}

/** The text of `clangd --version` -> its version number. */
export function parseClangdVersion(text: string): string | undefined {
  return /clangd version (\S+)/.exec(text)?.[1];
}

// ---- Running clangd --------------------------------------------------------
/** clangd's switches that change how a file compiles, from clangd.arguments; the rest (index, completion) don't matter here. */
export function compileRelevantArguments(args: unknown): string[] {
  if (!Array.isArray(args)) {
    return [];
  }
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") {
      continue;
    }
    if (/^--(query-driver|resource-dir)=/.test(arg)) {
      kept.push(arg);
    } else if (/^--(query-driver|resource-dir)$/.test(arg) && typeof args[i + 1] === "string") {
      kept.push(`${arg}=${args[i + 1] as string}`); // detached value
      i += 1;
    }
  }
  return kept;
}

/** The arguments of one check. Nothing here builds an index (--background-index=false) or writes anywhere. */
export function checkArguments(file: string, databaseDir: string, extra: string[] = []): string[] {
  return [`--check=${file}`, `--compile-commands-dir=${databaseDir}`, "--background-index=false", "--log=info", ...extra];
}

// ---- Locating clangd -------------------------------------------------------
/** `bin/clangd[.exe]` of the newest version the clangd extension downloaded into its global storage. */
export function findExtensionClangd(
  storageRoot: string | undefined,
  platform: NodeJS.Platform,
  exists: (file: string) => boolean,
  readDir: (dir: string) => string[],
): string | undefined {
  if (!storageRoot) {
    return undefined;
  }
  const p = platform === "win32" ? path.win32 : path.posix;
  const installDir = p.join(storageRoot, CLANGD_EXTENSION_ID, "install");
  const versions = readDir(installDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const exe = platform === "win32" ? "clangd.exe" : "clangd";
  return versions.map((version) => p.join(installDir, version, `clangd_${version}`, "bin", exe)).find(exists);
}

export interface LocateInputs {
  setting: string | undefined; // clangd.path
  context: ClangdResolveContext;
  storageRoot?: string; // the folder holding every extension's global storage
  readDir?: (dir: string) => string[];
}

/**
 * The clangd binary the clangd extension runs. An explicit `clangd.path` wins (the extension writes the absolute path
 * of its own download there); else the extension's own download folder; else PATH.
 */
export function locateClangd(inputs: LocateInputs): ClangdLocation | undefined {
  const setting = (inputs.setting ?? "").trim();
  if (setting !== "" && setting !== "clangd") {
    const resolved = resolveClangdExecutable(setting, inputs.context);
    if (resolved) {
      return { path: resolved, source: "setting" };
    }
  }
  const downloaded = findExtensionClangd(inputs.storageRoot, inputs.context.platform, inputs.context.exists, inputs.readDir ?? listNames);
  if (downloaded) {
    return { path: downloaded, source: "extension" };
  }
  const onPath = resolveClangdExecutable("clangd", inputs.context);
  return onPath ? { path: onPath, source: "path" } : undefined;
}

function listNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// ---- Reading the database --------------------------------------------------
export interface DatabaseEntry {
  directory: string;
  file: string; // absolute, forward slashes
  args: string[];
}

export type DatabaseRead = { ok: true; entries: DatabaseEntry[] } | { ok: false; reason: "missing" | "unreadable"; message: string };

const isAbsoluteFile = (file: string): boolean => path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file);

/** Entries from a parsed compile_commands.json: the `arguments` form O3DE writes, or the `command` string CMake exports. */
export function parseDatabase(json: unknown): DatabaseEntry[] {
  if (!Array.isArray(json)) {
    return [];
  }
  const entries: DatabaseEntry[] = [];
  for (const item of json) {
    const record = item as { directory?: unknown; file?: unknown; arguments?: unknown; command?: unknown } | null;
    if (!record || typeof record.file !== "string") {
      continue;
    }
    const directory = typeof record.directory === "string" ? record.directory : "";
    const args = Array.isArray(record.arguments)
      ? record.arguments.filter((arg): arg is string => typeof arg === "string")
      : typeof record.command === "string"
        ? splitFlags(record.command)
        : [];
    entries.push({ directory, file: normalizePath(isAbsoluteFile(record.file) ? record.file : path.join(directory, record.file)), args });
  }
  return entries;
}

export function readDatabaseFile(file: string): DatabaseRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return { ok: false, reason: missing ? "missing" : "unreadable", message: missing ? `${file} doesn't exist.` : `${file} can't be read: ${String(err)}` };
  }
  try {
    const json: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    return Array.isArray(json)
      ? { ok: true, entries: parseDatabase(json) }
      : { ok: false, reason: "unreadable", message: `${file} isn't a compile database: its top level isn't a list.` };
  } catch {
    return { ok: false, reason: "unreadable", message: `${file} isn't valid JSON.` };
  }
}

/** The compiler and switch style the database's entries use (from the first entry that has a command). */
export function databaseToolchain(entries: DatabaseEntry[]): Toolchain | undefined {
  const compiler = entries.find((entry) => entry.args.length > 0)?.args[0];
  return compiler ? compilerToolchain(compiler) : undefined;
}

// ---- Include directories ---------------------------------------------------
// MSVC-style commands take /I, -I, /external:I; GNU-style ones only -I, -isystem, -iquote, -idirafter. A GNU argument that
// starts with a slash is a path (a source file), never a switch.
const MSVC_INCLUDE = /^[-/](external:I|imsvc|isystem|iquote|idirafter|I)(.*)$/;
const GNU_INCLUDE = /^-(isystem|iquote|idirafter|I)(.*)$/;

/** The include directories one command names (attached `-Idir` or detached `-I dir`), as written. */
export function includeDirsOf(args: string[], style: FlagStyle): string[] {
  const pattern = style === "msvc" ? MSVC_INCLUDE : GNU_INCLUDE;
  const dirs: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const match = pattern.exec(args[i]);
    if (!match) {
      continue;
    }
    if (match[2]) {
      dirs.push(match[2]);
    } else if (i + 1 < args.length) {
      dirs.push(args[i + 1]);
      i += 1;
    }
  }
  return dirs;
}

export interface IncludeDirReport {
  checked: number; // distinct include directories the entries name
  missing: string[]; // those that don't exist, sorted
}

/** Every distinct include dir the database names, and which of them are not on disk. */
export function missingIncludeDirs(
  entries: DatabaseEntry[],
  style: FlagStyle,
  exists: (dir: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): IncludeDirReport {
  const seen = new Map<string, string>(); // key -> the directory as first written, made absolute
  for (const entry of entries) {
    for (const dir of includeDirsOf(entry.args, style)) {
      const absolute = path.isAbsolute(dir) || /^[A-Za-z]:[\\/]/.test(dir) ? dir : path.join(entry.directory, dir);
      const key = normalizePath(absolute).replace(/\/+$/, "");
      const caseKey = platform === "linux" ? key : key.toLowerCase();
      if (!seen.has(caseKey)) {
        seen.set(caseKey, key);
      }
    }
  }
  const missing = [...seen.values()].filter((dir) => !exists(dir)).sort();
  return { checked: seen.size, missing };
}

// ---- Origins ---------------------------------------------------------------
/**
 * Which origin an entry's file belongs to - the rule databasePlan.ts counts by, read back from the roots it used:
 * a file the build compiles is the project's (under the project) or a gem's; Framework of the source engine; a
 * participating engine gem; a fallback gem. Without a plan (the user's own database) only the paths speak: the project,
 * the source engine (Framework or other), and everything else is a gem.
 */
export function classifyOrigin(file: string, roots: OriginRoots): Origin {
  const underProject = isUnderRoot(file, roots.projectRoot);
  if (roots.planFiles?.has(normalizePath(file).toLowerCase())) {
    return underProject ? "project" : "gem";
  }
  const engine = roots.sourceEngineRoot;
  if (engine && isUnderRoot(file, `${normalizePath(engine).replace(/\/+$/, "")}/Code/Framework`)) {
    return "engineFramework";
  }
  if (roots.participatingGems?.some((gem) => isUnderRoot(file, gem))) {
    return "engineGems";
  }
  if (roots.fallbackGems?.some((gem) => isUnderRoot(file, gem))) {
    return "fallback";
  }
  if (engine && isUnderRoot(file, engine)) {
    return "engineGems";
  }
  return underProject ? "project" : "gem";
}

export interface ClassifiedFile {
  file: string;
  origin: Origin;
}

/** Each entry's file with its origin, and the counts by origin (they add up to the entries). */
export function classifyEntries(entries: DatabaseEntry[], roots: OriginRoots): { files: ClassifiedFile[]; counts: OriginCounts } {
  const counts: OriginCounts = { project: 0, gem: 0, engineFramework: 0, engineGems: 0, fallback: 0 };
  const files = entries.map((entry) => {
    const origin = classifyOrigin(entry.file, roots);
    counts[origin] += 1;
    return { file: entry.file, origin };
  });
  return { files, counts };
}

// ---- Sampling --------------------------------------------------------------
const STRATA: readonly Origin[] = ["project", "gem", "engineFramework", "engineGems", "fallback"];

/** The sample size asked for, kept inside 1..20 (the default when it isn't a number). */
export function clampSampleSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_SAMPLE_SIZE, Math.max(MIN_SAMPLE_SIZE, Math.trunc(value))) : DEFAULT_SAMPLE_SIZE;
}

export interface SampledFile {
  file: string;
  origin: SampleOrigin;
}

/**
 * `size` files from the database, deterministic and spread over the origins: each origin that has files gets a share
 * (project, gem, engineFramework, engineGems, fallback in turn), and within an origin the files picked are evenly spaced
 * through its sorted list - so the same database always gives the same sample, and it reaches different folders.
 */
export function pickSample(files: ClassifiedFile[], size: number): SampledFile[] {
  const byOrigin = new Map<Origin, string[]>();
  for (const origin of STRATA) {
    byOrigin.set(origin, distinctSorted(files.filter((candidate) => candidate.origin === origin).map((candidate) => candidate.file)));
  }
  const quota = new Map<Origin, number>(STRATA.map((origin) => [origin, 0]));
  let remaining = Math.min(size, files.length);
  while (remaining > 0) {
    const before = remaining;
    for (const origin of STRATA) {
      if (remaining > 0 && (quota.get(origin) ?? 0) < (byOrigin.get(origin)?.length ?? 0)) {
        quota.set(origin, (quota.get(origin) ?? 0) + 1);
        remaining -= 1;
      }
    }
    if (remaining === before) {
      break;
    }
  }
  const sample: SampledFile[] = [];
  for (const origin of STRATA) {
    const list = byOrigin.get(origin) ?? [];
    const count = quota.get(origin) ?? 0;
    for (let i = 0; i < count; i++) {
      sample.push({ file: list[Math.floor(((i + 0.5) * list.length) / count)], origin });
    }
  }
  return sample;
}

const compareFiles = (a: string, b: string): number => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);

/** Each file once (the first spelling, case ignored), sorted: a source in several database entries is one candidate. */
function distinctSorted(names: string[]): string[] {
  const first = new Map<string, string>();
  for (const name of names) {
    if (!first.has(name.toLowerCase())) {
      first.set(name.toLowerCase(), name);
    }
  }
  return [...first.values()].sort(compareFiles);
}

// ---- Sources with no entry -------------------------------------------------
export interface DirectoryItem {
  name: string;
  isDirectory: boolean;
}

export type DirectoryReader = (dir: string) => DirectoryItem[] | undefined;

const COMPILABLE = /\.(c|cc|cpp|cxx|c\+\+)$/i;

/** Folders that hold no code of their own (the ones gem scanning skips, plus assets at any depth: a project root is full of them). */
const SKIPPED_DIRS = /^(tests?|external|3rdparty|build|assets|cache|node_modules|\..*)$/i;

const DIRECTORY_BUDGET = 800; // directories read per root before giving up on it

function readDirectory(dir: string): DirectoryItem[] | undefined {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .map((item) => ({ name: item.name, isDirectory: item.isDirectory() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return undefined;
  }
}

/** The first compilable source under `root` (name order) that `hasEntry` says the database doesn't list, within a directory budget. */
function firstUnlisted(root: string, hasEntry: (file: string) => boolean, platform: NodeJS.Platform, read: DirectoryReader): string | undefined {
  let budget = DIRECTORY_BUDGET;
  const visit = (dir: string): string | undefined => {
    if (budget-- <= 0) {
      return undefined;
    }
    const items = read(dir) ?? [];
    for (const item of items.filter((candidate) => !candidate.isDirectory && COMPILABLE.test(candidate.name))) {
      const file = normalizePath(path.join(dir, item.name));
      if (!hasEntry(file) && !isOtherPlatformPath(file, platform)) {
        return file;
      }
    }
    for (const item of items.filter((candidate) => candidate.isDirectory && !SKIPPED_DIRS.test(candidate.name))) {
      const hit = visit(path.join(dir, item.name));
      if (hit) {
        return hit;
      }
    }
    return undefined;
  };
  return visit(root);
}

/**
 * Up to `limit` sources that have no entry in the database - the files clangd must guess flags for. One candidate per
 * root, the user's own roots and the engine's taking turns, so the sample shows both.
 */
export function findEntrylessSources(
  roots: ScanRoot[],
  hasEntry: (file: string) => boolean,
  limit: number = MAX_ENTRYLESS,
  platform: NodeJS.Platform = process.platform,
  read: DirectoryReader = readDirectory,
): string[] {
  const found: Record<ScanRoot["group"], string[]> = { own: [], engine: [] };
  const taken = new Set<string>();
  for (const root of roots) {
    if (found[root.group].length >= limit) {
      continue;
    }
    const hit = firstUnlisted(root.dir, hasEntry, platform, read);
    if (hit && !taken.has(hit.toLowerCase())) {
      taken.add(hit.toLowerCase());
      found[root.group].push(hit);
    }
  }
  const turns: string[] = [];
  for (let i = 0; turns.length < limit && (i < found.own.length || i < found.engine.length); i++) {
    for (const file of [found.own[i], found.engine[i]]) {
      if (file !== undefined && turns.length < limit) {
        turns.push(file);
      }
    }
  }
  return turns;
}

// ---- Which database is checked ---------------------------------------------
export interface CheckedDatabaseInputs {
  /** The --compile-commands-dir of clangd.arguments, variables already substituted; undefined when clangd.arguments names none. */
  configuredDir?: string;
  workspaceRoot?: string; // a relative configuredDir is relative to it
  selectedDir: string; // the folder O3DE selected: generated, or the user's own
  selectionSource?: string; // "user" when the selected database is the user's own, else generated
  platform?: NodeJS.Platform; // decides whether folder names differ by case
}

/**
 * The database the check reads: the folder clangd's own arguments name, else the one O3DE selected. `kind` says whose it
 * is; `inUse` is whether clangd.arguments points at it.
 */
export function checkedDatabase(inputs: CheckedDatabaseInputs): { dir: string; kind: DatabaseKind; inUse: boolean } {
  const clangdDir = inputs.configuredDir === undefined ? undefined : path.resolve(inputs.workspaceRoot ?? "", inputs.configuredDir);
  const elsewhere = clangdDir !== undefined && !sameDirectory(clangdDir, inputs.selectedDir, inputs.platform);
  return {
    dir: clangdDir ?? inputs.selectedDir,
    kind: elsewhere ? "clangdArguments" : inputs.selectionSource === "user" ? "user" : "generated",
    inUse: clangdDir !== undefined,
  };
}

// ---- Where to look for sources the database doesn't list -------------------
export interface OwnScanInputs {
  projectPath: string;
  externalSubdirectories: string[]; // project.json's, relative to the project or absolute
  manifestGems: string[]; // the o3de manifest's gems that belong to this workspace (databasePlan.relevantManifestGems), absolute
  hasGemJson: (dir: string) => boolean;
  cap: number; // gems kept, so a machine with hundreds of gems stays quick
}

/** The user's own roots: the project first, then the code folder of each gem it names, once each. The cap cuts the gems, never the project. */
export function ownScanRoots(inputs: OwnScanInputs): ScanRoot[] {
  const named = [...inputs.externalSubdirectories.map((dir) => path.resolve(inputs.projectPath, dir)), ...inputs.manifestGems];
  const gems = uniqueStable(named.filter(inputs.hasGemJson).map(gemCodeRoot)).slice(0, inputs.cap);
  return [inputs.projectPath, ...gems].map((dir): ScanRoot => ({ dir, group: "own" }));
}

/**
 * The engine's tool and gem code worth scanning: the source engine's when navigation is redirected to one, else the build
 * engine's when the project builds it from source. A headers-only or unresolved engine has no sources to scan.
 */
export function engineScanRoots(engine: Pick<EngineModeReport, "mode" | "sourceEngine" | "buildEngine">, isDirectory: (dir: string) => boolean): ScanRoot[] {
  const root = engine.sourceEngine?.path ?? (engine.mode === "native" ? engine.buildEngine?.path : undefined);
  return root ? ["Code/Tools", "Code/Editor", "Gems"].map((sub) => path.join(root, sub)).filter(isDirectory).map((dir): ScanRoot => ({ dir, group: "engine" })) : [];
}

// ---- Folders a build makes -------------------------------------------------
export interface BuildOutputInputs {
  entries: DatabaseEntry[];
  buildDir?: string; // the project's own build tree
  databaseDir: string; // the folder the database is read from
  exists: (file: string) => boolean;
}

const isAbsolutePath = (dir: string): boolean => path.isAbsolute(dir) || /^[A-Za-z]:[\\/]/.test(dir);

/**
 * The folders a build writes into, so a missing include dir inside one reads "build once" instead of "stale database". From
 * the user's own data, not a fixed layout: the project's build folder; the working directory of every entry that is NOT an
 * ancestor of its own source (a CMake build tree is apart from the sources, while a capture that records the source folder, or
 * an in-source build, is not one); and the database's folder, or the nearest folder above it, that holds a CMakeCache.txt.
 */
export function buildOutputRoots(inputs: BuildOutputInputs): string[] {
  const roots: string[] = inputs.buildDir ? [inputs.buildDir] : [];
  const added = new Set<string>(); // entries mostly share one directory: decide each once
  for (const { directory, file } of inputs.entries) {
    if (directory !== "" && isAbsolutePath(directory) && !added.has(directory) && !isUnderRoot(file, directory)) {
      added.add(directory);
      roots.push(directory);
    }
  }
  for (let dir = normalizePath(inputs.databaseDir).replace(/\/+$/, ""); dir !== ""; ) {
    if (inputs.exists(`${dir}/CMakeCache.txt`)) {
      roots.push(dir);
      break;
    }
    const parent = path.posix.dirname(dir);
    dir = parent === dir ? "" : parent;
  }
  return uniqueStable(roots.map((dir) => normalizePath(dir).replace(/\/+$/, "")));
}
