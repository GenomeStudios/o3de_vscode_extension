// ============================================================================
//  clangd compile database — is clangd using O3DE's database, and is it current?
//
//  While clangd provides IntelliSense from O3DE's compile database, the database
//  must follow the project: a configure, a build-config switch, or a source engine
//  added to the workspace all change what it should contain. clangdSync.ts
//  regenerates it on those events; this module holds the pure rules:
//
//    in use      clangd is running AND its --compile-commands-dir is the database
//                directory O3DE selected (generated, or the user's own: userDatabase.ts)
//                — read from the setting clangd actually uses, so a clangd pointed
//                elsewhere is never touched
//    up to date  the last generation used this build config and this configure
//                (the reply's timestamp). Never asked of a user-provided database:
//                O3DE doesn't generate it, so it has no generation to be current with.
//
//  Pure: inputs in, state and labels out.
// ============================================================================

import { normalizePath } from "./paths";
import { RunningEngine } from "./intellisenseEngine";
import type { EngineCoverage, OriginCounts } from "./databasePlan";
import type { DatabaseSelection } from "./userDatabase";

// ---- Model -----------------------------------------------------------------
/** One successful generation of the database. */
export interface DatabaseRecord {
  ok: true;
  at: number; // ms
  trigger: string; // what asked for it: "switch", "configure", "config", "folders", "setting", "startup", "manual", "mcp"
  config: string; // build config selected when it was generated (what freshness compares)
  flagsConfig: string; // configuration the flags actually came from — differs when the configure lacks `config`
  replyTimestamp?: number; // configure the database was built from
  dir: string; // what clangd's --compile-commands-dir points at
  file: string;
  entries: number;
  engineCoverage: EngineCoverage; // how far engine sources went into it (o3de.intellisense.engineCoverage, or an MCP override)
  origins: OriginCounts; // entries by origin — they add up to `entries`
  engineEntries: number; // engine sources: Framework + participating gems (redirected projects)
  engineModuleDefines: number; // of those, the ones given their module's export defines (AZCORE_EXPORTS...)
  skippedManifestGems: number; // gems registered in the o3de manifest that the project doesn't enable and the workspace doesn't contain
  queryDriver?: string; // the GNU-style compiler clangd should query for system includes (none for cl / clang-cl)
  changed: boolean; // false = identical to what was on disk, nothing written
  durationMs: number;
}

/** A generation that couldn't run. */
export interface DatabaseFailure {
  ok: false;
  at: number;
  trigger: string;
  reason: "noProject" | "notConfigured";
}

export type DatabaseGeneration = DatabaseRecord | DatabaseFailure;

export type DatabaseState = "notInUse" | "upToDate" | "updatePending" | "notConfigured" | "noProject" | "userProvided";

export interface DatabaseStatus {
  state: DatabaseState;
  dir?: string; // the database directory clangd should read for the project: the generated one, or the user's own
  last?: DatabaseGeneration;
  selection?: DatabaseSelection; // which database that is and why; undefined when no project is open
}

// ---- clangd arguments ------------------------------------------------------
const COMPILE_COMMANDS_DIR = "--compile-commands-dir";

/** The directory clangd reads its compile database from, per its arguments (attached or detached form). */
export function compileCommandsDirOf(args: unknown): string | undefined {
  if (!Array.isArray(args)) {
    return undefined;
  }
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === COMPILE_COMMANDS_DIR && typeof args[i + 1] === "string") {
      dir = args[i + 1] as string; // the last one wins, as in clangd
      i += 1;
    } else if (typeof arg === "string" && arg.startsWith(`${COMPILE_COMMANDS_DIR}=`)) {
      dir = arg.slice(COMPILE_COMMANDS_DIR.length + 1);
    }
  }
  return dir;
}

/** Same directory, ignoring slash direction and a trailing slash — and letter case on Windows. */
export function sameDirectory(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const clean = (value: string): string => {
    const normalized = normalizePath(value).replace(/\/+$/, "");
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return clean(a) === clean(b);
}

// ---- Rules -----------------------------------------------------------------
/** clangd is running on the database O3DE selected (generated or the user's own) — the only case O3DE manages it. */
export function clangdUsesDatabase(
  running: RunningEngine,
  clangdDir: string | undefined,
  databaseDir: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const clangdRuns = running === "clangd" || running === "both";
  return clangdRuns && clangdDir !== undefined && databaseDir !== undefined && sameDirectory(clangdDir, databaseDir, platform);
}

export interface RepointInputs {
  running: RunningEngine;
  clangdDir: string | undefined; // the --compile-commands-dir clangd reads now
  targetDir: string | undefined; // the folder the selection says it should read
  ownDirs: (string | undefined)[]; // folders O3DE pointed clangd at: the generated one, and the last it applied
}

/**
 * clangd is the ONLY running engine, on a database folder O3DE pointed it at, but the selection now names another
 * one (the setting changed; a configure, config switch, folder or extension change re-evaluated it, or the file it
 * named is gone). A clangd pointed anywhere else is the user's own and is never touched. The follow never touches
 * the C/C++ extension: with both engines running (state "both") it leaves the re-pointing to the engine picker.
 */
export function needsRepoint(inputs: RepointInputs, platform: NodeJS.Platform = process.platform): boolean {
  const { running, clangdDir, targetDir } = inputs;
  if (running !== "clangd" || clangdDir === undefined || targetDir === undefined) {
    return false;
  }
  const own = inputs.ownDirs.some((dir) => dir !== undefined && sameDirectory(clangdDir, dir, platform));
  return own && !sameDirectory(clangdDir, targetDir, platform);
}

export interface DatabaseStateInputs {
  inUse: boolean;
  userProvided?: boolean; // the selected database is the user's own (O3DE generates nothing for it)
  last: DatabaseGeneration | undefined; // this session's latest generation
  config: string; // current build config
  replyTimestamp: number | undefined; // current configure
}

export function databaseState(inputs: DatabaseStateInputs): DatabaseState {
  if (!inputs.inUse) {
    return "notInUse";
  }
  if (inputs.userProvided) {
    return "userProvided";
  }
  const last = inputs.last;
  if (!last) {
    return "updatePending"; // not generated this session yet (startup sync is on its way)
  }
  if (!last.ok) {
    return last.reason;
  }
  const replyMoved = inputs.replyTimestamp !== undefined && last.replyTimestamp !== inputs.replyTimestamp;
  return last.config !== inputs.config || replyMoved ? "updatePending" : "upToDate";
}

/** The configure had no `config` configuration, so another configuration's flags stand in (e.g. SDK engines: profile only). */
export function usesStandInFlags(record: DatabaseRecord): boolean {
  return record.config.toLowerCase() !== record.flagsConfig.toLowerCase();
}

// ---- Labels ----------------------------------------------------------------
const count = (value: number): string => value.toLocaleString("en-US");

/** What the database holds beyond the project's own targets: ", including 1,100 engine Framework sources and 165 engine gem sources (…) and 12 gem sources outside the build's targets". */
function sourcesDetail(record: DatabaseRecord): string {
  const { engineFramework, engineGems, fallback } = record.origins;
  const engine = [
    engineFramework > 0 ? `${count(engineFramework)} engine Framework sources` : "",
    engineGems > 0 ? `${count(engineGems)} engine gem sources` : "",
  ].filter(Boolean);
  const engineText = engine.length ? `, including ${engine.join(" and ")} (${count(record.engineModuleDefines)} with their module's export defines)` : "";
  const fallbackText = fallback > 0 ? `${engineText ? " and" : ", including"} ${count(fallback)} gem sources outside the build's targets` : "";
  return engineText + fallbackText;
}

export function databaseLabel(status: DatabaseStatus): string {
  switch (status.state) {
    case "notInUse":
      return "Not in use";
    case "upToDate":
      return status.last?.ok ? `Up to date · ${status.last.entries.toLocaleString("en-US")} entries` : "Up to date";
    case "updatePending":
      return "Update pending";
    case "notConfigured":
      return "Not configured";
    case "noProject":
      return "No project";
    case "userProvided":
      return "User-provided";
  }
}

/**
 * Show the dashboard row? Normally only while clangd uses a database O3DE manages. A setting the user wrote
 * (their own database, or one that is missing) is shown even before clangd is switched on: it has something to say.
 */
export function databaseRowVisible(status: DatabaseStatus): boolean {
  return status.state !== "notInUse" || status.selection?.source === "user" || status.selection?.missing !== undefined;
}

/** What the selection adds to the state's own sentence: a user database not in use yet, a missing one, or a database found but not chosen. */
function selectionNote(status: DatabaseStatus): string {
  const selection = status.selection;
  if (!selection || status.state === "userProvided") {
    return "";
  }
  const worthSaying = selection.source === "user" || selection.missing !== undefined || selection.hint !== undefined;
  return worthSaying ? ` ${selection.reason}` : "";
}

/**
 * " File: <generated file>" for the status command's message. Nothing for the user's own database: `last` is this
 * session's most recent generation and says nothing about a database O3DE never writes.
 */
export function databaseFileNote(status: DatabaseStatus): string {
  return status.state !== "userProvided" && status.last?.ok ? ` File: ${status.last.file}` : "";
}

export function databaseDetail(status: DatabaseStatus): string {
  return databaseStateDetail(status) + selectionNote(status);
}

/** " 3 gems registered in the O3DE manifest were left out: ..." - the manifest gems this project doesn't touch (nothing when none). */
function skippedGemsDetail(record: DatabaseRecord | undefined): string {
  const skipped = record?.skippedManifestGems ?? 0;
  if (skipped === 0) {
    return "";
  }
  const [gems, was, it] = skipped === 1 ? ["gem", "was", "it"] : ["gems", "were", "them"];
  return ` ${count(skipped)} ${gems} registered in the O3DE manifest ${was} left out: the project doesn't enable ${it} and the workspace doesn't contain ${it}.`;
}

function databaseStateDetail(status: DatabaseStatus): string {
  switch (status.state) {
    case "userProvided":
      return (
        `${status.selection?.reason ?? "clangd reads your own compile database."} A configure, a build config switch or a workspace ` +
        "folder change leave it alone, and engine coverage doesn't apply. Clear the setting to go back to the generated database."
      );
    case "notInUse":
      return "clangd isn't using O3DE's compile database in this workspace, so it isn't kept up to date.";
    case "upToDate": {
      const last = status.last?.ok ? status.last : undefined;
      const engine = last ? sourcesDetail(last) : "";
      const flags = !last
        ? ""
        : usesStandInFlags(last)
          ? ` It uses the ${last.flagsConfig} configuration's flags: the project's configure has no ${last.config} configuration.`
          : ` Flags from the ${last.flagsConfig} configuration.`;
      return (
        `clangd's compile database matches the project's last configure: ${last?.entries.toLocaleString("en-US") ?? "?"} ` +
        `entries${engine}.${flags}${skippedGemsDetail(last)} It updates itself after a configure, a build config switch, or a workspace folder change.`
      );
    }
    case "updatePending":
      return "The project changed since clangd's compile database was generated; it updates in a moment.";
    case "notConfigured":
      return "clangd's compile database can't be generated: the project hasn't been configured. Configure the project to update it.";
    case "noProject":
      return "clangd's compile database can't be generated: no O3DE project is open in this workspace.";
  }
}
