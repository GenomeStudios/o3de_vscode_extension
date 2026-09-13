// ============================================================================
//  clangd compile database — is clangd using O3DE's database, and is it current?
//
//  While clangd provides IntelliSense from O3DE's compile database, the database
//  must follow the project: a configure, a build-config switch, or a source engine
//  added to the workspace all change what it should contain. clangdSync.ts
//  regenerates it on those events; this module holds the pure rules:
//
//    in use      clangd is running AND its --compile-commands-dir is O3DE's
//                database directory — read from the setting clangd actually uses,
//                so a clangd pointed elsewhere is never touched
//    up to date  the last generation used this build config and this configure
//                (the reply's timestamp)
//
//  Pure: inputs in, state and labels out.
// ============================================================================

import { normalizePath } from "./paths";
import { RunningEngine } from "./intellisenseEngine";

// ---- Model -----------------------------------------------------------------
/** One successful generation of the database. */
export interface DatabaseRecord {
  ok: true;
  at: number; // ms
  trigger: string; // what asked for it: "switch", "configure", "config", "folders", "startup", "manual", "mcp"
  config: string; // build config selected when it was generated (what freshness compares)
  flagsConfig: string; // configuration the flags actually came from — differs when the configure lacks `config`
  replyTimestamp?: number; // configure the database was built from
  dir: string; // what clangd's --compile-commands-dir points at
  file: string;
  entries: number;
  engineEntries: number; // engine Framework sources (redirected projects)
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

export type DatabaseState = "notInUse" | "upToDate" | "updatePending" | "notConfigured" | "noProject";

export interface DatabaseStatus {
  state: DatabaseState;
  dir?: string; // O3DE's database directory for the project
  last?: DatabaseGeneration;
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
/** clangd is running on O3DE's database — the only case O3DE keeps it in sync. */
export function clangdUsesDatabase(
  running: RunningEngine,
  clangdDir: string | undefined,
  databaseDir: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const clangdRuns = running === "clangd" || running === "both";
  return clangdRuns && clangdDir !== undefined && databaseDir !== undefined && sameDirectory(clangdDir, databaseDir, platform);
}

export interface DatabaseStateInputs {
  inUse: boolean;
  last: DatabaseGeneration | undefined; // this session's latest generation
  config: string; // current build config
  replyTimestamp: number | undefined; // current configure
}

export function databaseState(inputs: DatabaseStateInputs): DatabaseState {
  if (!inputs.inUse) {
    return "notInUse";
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
  }
}

export function databaseDetail(status: DatabaseStatus): string {
  switch (status.state) {
    case "notInUse":
      return "clangd isn't using O3DE's compile database in this workspace, so it isn't kept up to date.";
    case "upToDate": {
      const last = status.last?.ok ? status.last : undefined;
      const engine = last && last.engineEntries > 0 ? `, including ${last.engineEntries.toLocaleString("en-US")} engine Framework sources` : "";
      const flags = !last
        ? ""
        : usesStandInFlags(last)
          ? ` It uses the ${last.flagsConfig} configuration's flags: the project's configure has no ${last.config} configuration.`
          : ` Flags from the ${last.flagsConfig} configuration.`;
      return (
        `clangd's compile database matches the project's last configure: ${last?.entries.toLocaleString("en-US") ?? "?"} ` +
        `entries${engine}.${flags} It updates itself after a configure, a build config switch, or a workspace folder change.`
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
