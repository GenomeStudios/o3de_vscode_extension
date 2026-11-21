// ============================================================================
//  IntelliSense health check - the shared model. vscode-free, types and limits only.
//
//  The health check answers one question on the user's own machine: does clangd
//  actually understand THIS project's sources? It samples files from the compile
//  database clangd reads, runs `clangd --check` on them, and reports what failed.
//
//    healthCheck.ts   the rules: parsing --check output, sampling, origins, locating clangd
//    healthRun.ts     running clangd and assembling the report
//    healthReport.ts  the findings, the Markdown document and the one-line summary
//    healthQuery.ts   the vscode side: reads the workspace, serves the command and the MCP tool
// ============================================================================

import type { EngineCoverage, OriginCounts } from "./databasePlan";
import type { EngineMode } from "./engineMode";
import type { RunningEngine } from "./intellisenseEngine";
import type { FlagStyle } from "./compileDb";

// ---- Limits ----------------------------------------------------------------
export const DEFAULT_SAMPLE_SIZE = 6;
export const MIN_SAMPLE_SIZE = 1;
export const MAX_SAMPLE_SIZE = 20;
export const MAX_ENTRYLESS = 2; // sources with no entry in the database that join the sample
export const CHECK_CONCURRENCY = 2; // clangd runs at once: each one builds a preamble (hundreds of MB of headers)
export const CHECK_TIMEOUT_MS = 60_000; // one file
export const TOTAL_BUDGET_MS = 300_000; // a whole check, for a client that streams progress
export const INLINE_BUDGET_MS = 45_000; // a client that sends no progress token cannot be held longer
export const MAX_ERROR_LINES = 3; // first errors kept per file
export const MAX_EXAMPLES = 5; // missing include dirs listed

// ---- Vocabulary ------------------------------------------------------------
/** Where an entry of the database came from (databasePlan.ts decides it when O3DE generates the database). */
export type Origin = keyof OriginCounts;

/** A sampled file's origin: an entry's, or `noEntry` for a source the database doesn't list at all. */
export type SampleOrigin = Origin | "noEntry";

export type DatabaseKind = "generated" | "user" | "clangdArguments"; // O3DE's, the user's own setting, or clangd.arguments pointing elsewhere
export type ClangdSource = "setting" | "extension" | "path"; // clangd.path, the clangd extension's own download, PATH
export type CommandSource = "entry" | "inferred" | "unknown"; // flags from the file's own entry, borrowed from a neighbour, or not reported
export type FileStatus = "ok" | "errors" | "timedOut" | "failed" | "skipped";
export type PartialReason = "timeBudget" | "cancelled";

// ---- What a check needs ----------------------------------------------------
export interface ClangdLocation {
  path: string;
  source: ClangdSource;
}

/** Where the files of the database came from, to tell each entry's origin. */
export interface OriginRoots {
  projectRoot: string;
  sourceEngineRoot?: string;
  /** Lower-case files the build compiles (project and gem entries); known only when O3DE generated the database. */
  planFiles?: ReadonlySet<string>;
  participatingGems?: string[]; // engine gems the project uses
  fallbackGems?: string[]; // gems reached whose sources no target lists
  skippedManifestGems?: number; // gems registered in the o3de manifest that the project doesn't enable and the workspace doesn't contain
}

/** A folder to look for sources the database doesn't list. `own` folders are the user's, `engine` folders the engine's. */
export interface ScanRoot {
  dir: string;
  group: "own" | "engine";
}

export interface HealthInputs {
  extensionVersion: string;
  platform: NodeJS.Platform;
  project: { name: string; path: string };
  buildDir?: string; // the project's build tree: an include dir inside it is made by a build, so it may not exist yet (the database names more)
  intellisenseEngine: RunningEngine; // which C++ engine runs: the check is only about clangd
  clangd: ClangdLocation | undefined;
  clangdArguments: string[]; // the clangd.arguments that change how a file compiles (--query-driver, --resource-dir)
  database: {
    dir: string; // clangd's --compile-commands-dir for the check
    kind: DatabaseKind;
    inUse: boolean; // clangd.arguments points at this folder
  };
  engine: { mode: EngineMode; sourceEngineName?: string; remedyAvailable: boolean; coverage: EngineCoverage };
  roots: OriginRoots;
  scanRoots: ScanRoot[];
  sampleSize: number;
  includeEntryless: boolean;
}

export interface HealthOptions {
  maxTotalMs: number; // the whole check; files not started in time are skipped
  signal?: AbortSignal;
  onProgress?: (checked: number, total: number) => void;
}

// ---- What a check reports --------------------------------------------------
export interface FileCheck {
  file: string;
  origin: SampleOrigin;
  status: FileStatus;
  command: CommandSource;
  inferredFrom?: string; // command inferred: the file whose flags clangd borrowed
  errorCount: number; // real compile errors
  firstErrors: string[]; // "line 19 [undeclared_var_use] use of undeclared identifier 'X'"
  seconds: number;
  note?: string; // why it wasn't checked, or what went wrong
}

export interface HealthSummary {
  sampled: number;
  clean: number; // checked, no compile errors
  withErrors: number;
  notChecked: number; // timed out, failed to run, or skipped
  withoutEntry: number; // checked files clangd had no entry for
}

export interface HealthReport {
  extensionVersion: string;
  platform: NodeJS.Platform;
  project: { name: string; path: string };
  intellisenseEngine: RunningEngine;
  clangd: { found: boolean; path?: string; source?: ClangdSource; version?: string; problem?: string };
  toolchain?: { compiler: string; style: FlagStyle };
  database: {
    dir: string;
    file: string;
    kind: DatabaseKind;
    inUse: boolean;
    exists: boolean;
    problem?: string; // exists but unreadable
    entries: number;
    origins: OriginCounts;
    skippedManifestGems?: number; // known only when O3DE generated the database: registered gems it left out as none of this project's
    // include dirs the entries name, those not on disk, and how many of those sit in the build folder (a build creates them)
    includeDirs: { checked: number; missing: number; inBuildFolder: number; examples: string[] };
  };
  engine: { mode: EngineMode; sourceEngine?: string; coverage: EngineCoverage; hint?: string };
  files: FileCheck[];
  summary: HealthSummary;
  partial?: { reason: PartialReason; skipped: number };
  findings: string[]; // plain sentences: what is wrong and what to do
}

/** The outcome of a health check request: a report, or a refusal because there is nothing to check. */
export type HealthOutcome = { ok: true; report: HealthReport } | { ok: false; reason: "noProject"; message: string };
