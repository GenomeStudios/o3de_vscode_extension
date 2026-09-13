// ============================================================================
//  Freshness — is the data behind IntelliSense still true?
//
//  C++ data   the File API reply our Configure produced. Stale when a file that
//             DEFINES targets or source lists changed after that configure (a new
//             file added to *_files.cmake has no owning target until reconfigured).
//  Lua        the reflection dump (<project>/user/lua_symbols.json). Stale when it
//             was captured from a different engine, or when this build's modules —
//             what the Editor reflects from — were rebuilt after it.
//
//  Rules are pure (timestamps + paths in, verdict out) so they unit-test without a
//  disk; the read* functions gather those inputs. A state is only reported when
//  there is evidence for it — no evidence reads as "unknown", never as fresh.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { loadModuleArtifacts, loadTargetDefiningInputs, replyTimestamp } from "./fileApi";
import { normalizePath } from "./paths";

// ---- Model -----------------------------------------------------------------
export type CppDataState = "upToDate" | "stale" | "notConfigured" | "unknown";

export interface CppFreshness {
  state: CppDataState;
  configuredAt?: number; // ms — the last configure
  changed: string[]; // target-defining inputs newer than the configure (stale only)
}

export type LuaReflectionState = "upToDate" | "gemsRebuilt" | "engineChanged" | "notGenerated";

export interface LuaFreshness {
  state: LuaReflectionState;
  capturedAt?: number; // ms — the dump file's write time (the Python dump records no timestamp)
  capturedEngine?: string; // engine path recorded in the dump
  buildEngine?: string; // engine the project builds against now
  rebuiltCount: number; // module binaries newer than the dump
  latestBuild?: number; // ms — newest module binary
}

export interface Timestamped {
  path: string;
  mtime: number;
}

// ---- Pure rules ------------------------------------------------------------
/**
 * @param configuredAt  last configure time, undefined when never configured
 * @param inputs        target-defining inputs with mtimes, undefined when the reply can't list them
 */
export function cppFreshness(configuredAt: number | undefined, inputs: Timestamped[] | undefined): CppFreshness {
  if (configuredAt === undefined) {
    return { state: "notConfigured", changed: [] };
  }
  if (inputs === undefined) {
    return { state: "unknown", configuredAt, changed: [] };
  }
  const changed = inputs.filter((input) => input.mtime > configuredAt).map((input) => input.path);
  return { state: changed.length ? "stale" : "upToDate", configuredAt, changed };
}

const sameEngine = (a: string, b: string): boolean =>
  normalizePath(a).replace(/\/+$/, "").toLowerCase() === normalizePath(b).replace(/\/+$/, "").toLowerCase();

/**
 * A different engine outranks a rebuild: it means the WRONG API (a category error), where a
 * rebuild means possibly-missing API (a degree error).
 * @param dump          the dump's write time + recorded engine, undefined when no dump exists
 * @param buildEngine   the engine path the project builds against now
 * @param moduleMtimes  write times of this build's module binaries
 */
export function luaFreshness(
  dump: { mtime: number; engine?: string } | undefined,
  buildEngine: string | undefined,
  moduleMtimes: number[],
): LuaFreshness {
  if (!dump) {
    return { state: "notGenerated", buildEngine, rebuiltCount: 0 };
  }
  const base = { capturedAt: dump.mtime, capturedEngine: dump.engine, buildEngine };
  const latestBuild = moduleMtimes.length ? Math.max(...moduleMtimes) : undefined;
  const rebuiltCount = moduleMtimes.filter((mtime) => mtime > dump.mtime).length;
  // An empty recorded engine (env var unset at dump time) is no evidence of a mismatch.
  if (dump.engine && buildEngine && !sameEngine(dump.engine, buildEngine)) {
    return { state: "engineChanged", ...base, rebuiltCount, latestBuild };
  }
  return { state: rebuiltCount ? "gemsRebuilt" : "upToDate", ...base, rebuiltCount, latestBuild };
}

// ---- Copy ------------------------------------------------------------------
const day = (ms: number | undefined): string => (ms === undefined ? "an unknown date" : new Date(ms).toISOString().slice(0, 10));

/** The last three segments of a path — enough to recognise a file without a wall of prefix. */
const shortPath = (file: string): string => normalizePath(file).split("/").slice(-3).join("/");

export function cppFreshnessLabel(freshness: CppFreshness): string {
  switch (freshness.state) {
    case "upToDate":
      return "Up to date";
    case "stale":
      return "Stale (reconfigure)";
    case "notConfigured":
      return "Not configured";
    case "unknown":
      return "Configured";
  }
}

export function cppFreshnessDetail(freshness: CppFreshness): string {
  const when = day(freshness.configuredAt);
  switch (freshness.state) {
    case "upToDate":
      return `Matches your CMake project: nothing that defines targets or source lists (CMakeLists.txt, *.cmake, project.json) changed since the last configure (${when}).`;
    case "stale": {
      const examples = freshness.changed.slice(0, 3).map(shortPath).join(", ");
      const more = freshness.changed.length > 3 ? ` and ${freshness.changed.length - 3} more` : "";
      return (
        `${freshness.changed.length} file(s) that define targets or source lists changed since the last configure (${when}): ` +
        `${examples}${more}. New files and target changes won't have correct IntelliSense until you reconfigure.`
      );
    }
    case "notConfigured":
      return "This project hasn't been configured by O3DE Development Tools, so the live C++ IntelliSense provider has no data. Run Configure Project.";
    case "unknown":
      return `Configured (${when}), but that configure predates change tracking, so freshness can't be checked. Reconfiguring enables it.`;
  }
}

export function luaFreshnessLabel(freshness: LuaFreshness): string {
  switch (freshness.state) {
    case "upToDate":
      return "Up to date";
    case "gemsRebuilt":
      return "Stale (gems rebuilt)";
    case "engineChanged":
      return "Stale (different engine)";
    case "notGenerated":
      return "Not generated";
  }
}

export function luaFreshnessDetail(freshness: LuaFreshness): string {
  const captured = day(freshness.capturedAt);
  switch (freshness.state) {
    case "upToDate":
      return `Lua reflection was captured ${captured} with this project's engine, and none of this build's modules were rebuilt since.`;
    case "gemsRebuilt":
      return (
        `Lua reflection was captured ${captured}, but ${freshness.rebuiltCount} of this build's modules were rebuilt since ` +
        `(latest ${day(freshness.latestBuild)}). API added or changed since then won't complete in Lua until you regenerate.`
      );
    case "engineChanged":
      return (
        `Lua reflection was captured from ${freshness.capturedEngine}, but this project now builds against ${freshness.buildEngine}. ` +
        "Completions reflect the other engine's API until you regenerate."
      );
    case "notGenerated":
      return "No Lua reflection yet. Generate Lua IntelliSense captures the engine's scripting API for completion.";
  }
}

// ---- Readers (disk) --------------------------------------------------------
function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** C++ data freshness for a build tree's File API reply. */
export function readCppFreshness(replyDir: string): CppFreshness {
  const configuredAt = replyTimestamp(replyDir);
  if (configuredAt === undefined) {
    return cppFreshness(undefined, undefined);
  }
  const inputs = loadTargetDefiningInputs(replyDir)?.flatMap((file) => {
    const mtime = mtimeOf(file);
    return mtime === undefined ? [] : [{ path: file, mtime }]; // a deleted input shows up as a CMake change elsewhere
  });
  return cppFreshness(configuredAt, inputs);
}

/** The engine path the dump recorded — read from the file head (the dump is MBs; the field is near the top). */
export function readDumpEngine(dumpPath: string): string | undefined {
  try {
    const fd = fs.openSync(dumpPath, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const head = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
      const match = head.match(/"engine"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      return match ? (JSON.parse(`"${match[1]}"`) as string) : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Lua reflection freshness for a project. */
export function readLuaFreshness(
  projectPath: string,
  replyDir: string,
  configName: string,
  buildEngine: string | undefined,
): LuaFreshness {
  const dumpPath = path.join(projectPath, "user", "lua_symbols.json");
  const dumpTime = mtimeOf(dumpPath);
  const dump = dumpTime === undefined ? undefined : { mtime: dumpTime, engine: readDumpEngine(dumpPath) };
  const moduleMtimes =
    dump && replyTimestamp(replyDir) !== undefined
      ? loadModuleArtifacts(replyDir, configName).flatMap((file) => mtimeOf(file) ?? [])
      : [];
  return luaFreshness(dump, buildEngine, moduleMtimes);
}
