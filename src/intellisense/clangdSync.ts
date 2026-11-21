// ============================================================================
//  clangd automation — two jobs, run on the same events:
//
//    1. clangd-only mode   no C/C++ extension + clangd installed → switch clangd on
//                          by itself, once per workspace, and say so once (plan Q13)
//    2. database sync      keep O3DE's compile database current while clangd uses
//                          it; restart clangd only when the database changed
//
//    configure wrote a new reply     watcher: reply/index-*.json
//    build config switched           options.onDidChange (config only)
//    workspace folders changed       a source engine added/removed changes engine entries
//    engineCoverage setting changed  how much engine source the database holds
//    compileDatabase setting changed the user's own database (userDatabase.ts) chosen or dropped
//    extensions changed             clangd installed / C/C++ extension removed (clangd-only)
//    startup                         catches up on a configure run while VS Code was closed
//
//  Events are coalesced (a configure writes hundreds of reply files). A generation
//  takes ~270 ms on gs_play (1,759 entries) and writes nothing when the content is
//  identical — so a configure that changed no flags restarts nothing.
//
//  Never touches a clangd that isn't using O3DE's database (clangdDatabase.ts).
//  Never restarts a clangd with no server: its download prompt would come back
//  after every configure.
//
//  A user-provided database (o3de.intellisense.compileDatabase) is never generated, synced or
//  written. The sync only follows the setting: it re-points a clangd that O3DE itself pointed,
//  and only when clangd is the sole engine (with both engines running, the engine picker owns
//  the switch, so the C/C++ extension is never turned off behind the user's back).
// ============================================================================

import * as vscode from "vscode";
import { log } from "../log";
import { BuildOptions } from "../build/buildOptions";
import { fileApiReplyDir, projectBuildDir } from "../build/configureCommand";
import { findClangdServer } from "../deps/detectors";
import { O3deProject, readProject } from "../o3de/identity";
import { primaryO3deFolder } from "../workspace/projectScope";
import {
  DatabaseGeneration,
  DatabaseStatus,
  clangdUsesDatabase,
  compileCommandsDirOf,
  databaseDetail,
  databaseFileNote,
  databaseState,
  needsRepoint,
  sameDirectory,
} from "./clangdDatabase";
import {
  EngineSwitchResult,
  appliedDatabaseDir,
  generateWorkspaceDatabase,
  lastDatabaseGeneration,
  readDatabaseSelection,
  readEngineInputs,
  runClangdCommand,
  switchEngine,
} from "./clangdMode";
import { compileDatabaseDir } from "./compileDb";
import type { EngineCoverage } from "./databasePlan";
import { replyTimestamp } from "./fileApi";
import { ClangdOnlyDecision, RunningEngine, clangdOnlyDecision, runningEngine } from "./intellisenseEngine";
import type { IntelliSenseStatus } from "./intellisenseStatus";
import type { DatabaseSelection } from "./userDatabase";

// ---- Status ----------------------------------------------------------------
/** The database folder clangd should read for `project`: the user's own when they named one, else O3DE's generated one. */
function databaseDirOf(project: O3deProject | undefined, selection: DatabaseSelection | undefined): string | undefined {
  return selection?.dir ?? (project ? compileDatabaseDir(projectBuildDir(project.path)) : undefined);
}

/** Is clangd using the selected database for `project` (generated or the user's own), and is a generated one current? */
export function readDatabaseStatus(project: O3deProject | undefined, configName: string, running: RunningEngine): DatabaseStatus {
  const selection = readDatabaseSelection(project);
  const dir = databaseDirOf(project, selection);
  const clangdDir = compileCommandsDirOf(vscode.workspace.getConfiguration("clangd").get("arguments"));
  const last = lastDatabaseGeneration();
  const state = databaseState({
    inUse: clangdUsesDatabase(running, clangdDir, dir),
    userProvided: selection?.source === "user",
    last,
    config: configName,
    replyTimestamp: project ? replyTimestamp(fileApiReplyDir(project.path)) : undefined,
  });
  return { state, dir, last, selection };
}

function primaryProject(): O3deProject | undefined {
  const folder = primaryO3deFolder();
  return folder ? readProject(folder.uri.fsPath) : undefined;
}

// ---- clangd-only mode ------------------------------------------------------
const CLANGD_ONLY_KEY = "o3de.intellisense.clangdOnlyApplied"; // workspaceState: applied once in this workspace

export interface ClangdOnlyOutcome {
  decision: ClangdOnlyDecision;
  result?: EngineSwitchResult; // when decision is "apply"
}

/** No C/C++ extension + clangd installed → make clangd this workspace's C++ IntelliSense, once, without asking. */
export async function applyClangdOnlyMode(options: BuildOptions, workspaceState: vscode.Memento): Promise<ClangdOnlyOutcome> {
  const inputs = readEngineInputs();
  const database = readDatabaseStatus(primaryProject(), options.config, runningEngine(inputs));
  const clangdDir = compileCommandsDirOf(vscode.workspace.getConfiguration("clangd").get("arguments"));
  const decision = clangdOnlyDecision({
    cppToolsInstalled: inputs.cppToolsInstalled,
    clangdInstalled: inputs.clangdInstalled,
    inUse: database.state !== "notInUse",
    applied: workspaceState.get<boolean>(CLANGD_ONLY_KEY) === true,
    pointedElsewhere: clangdDir !== undefined && !(database.dir !== undefined && sameDirectory(clangdDir, database.dir)),
  });

  if (decision === "alreadyInUse") {
    await workspaceState.update(CLANGD_ONLY_KEY, true); // in place already (e.g. chosen by hand) — from here on it's the user's
  } else if (decision === "pointedElsewhere") {
    log().info(`clangd-only: clangd reads its own compile database (${clangdDir}) — left as it is.`);
  }
  if (decision !== "apply") {
    return { decision };
  }

  const result = await switchEngine("clangd", options, workspaceState);
  if (!result.ok) {
    log().info(`clangd-only: clangd not switched on yet — ${result.message}`); // retried on the next configure / change
    return { decision, result };
  }
  await workspaceState.update(CLANGD_ONLY_KEY, true);
  const own = result.compileDatabase?.source === "user" ? result.compileDatabase.file : undefined; // the user's own database, not O3DE's
  log().info(
    `clangd-only: the C/C++ extension isn't installed — clangd switched on with ` +
      (own ? `your compile database (${own}).` : `O3DE's compile database (${result.database?.entries ?? 0} entries).`),
  );
  void vscode.window.showInformationMessage(
    own
      ? `O3DE: clangd now provides C++ IntelliSense in this workspace, from your compile database (${own}). The C/C++ extension ` +
          "isn't installed, so O3DE switched clangd on automatically. It never writes your database."
      : "O3DE: clangd now provides C++ IntelliSense in this workspace, from O3DE's compile database. The C/C++ extension " +
          "isn't installed, so O3DE switched clangd on automatically and keeps its database up to date.",
  );
  return { decision, result };
}

// ---- Follow the setting ----------------------------------------------------
/**
 * The compile database setting changed (or a configure, config switch, folder or extension change re-evaluated it):
 * point clangd at the database the selection now names — but only a clangd that O3DE itself pointed, and only when
 * clangd is the sole running engine (needsRepoint). With both engines running nothing happens here: the follow never
 * touches the C/C++ extension, and the status shows the mismatch until the user picks an engine. Runs the engine
 * switch, which generates nothing for a user database. Returns the switch's result when it re-pointed clangd.
 * Nothing watches the named file itself: it appearing or vanishing is noticed at the next of those events.
 */
export async function followDatabaseSetting(options: BuildOptions, workspaceState: vscode.Memento): Promise<EngineSwitchResult | undefined> {
  const project = primaryProject();
  const selection = readDatabaseSelection(project);
  const repoint = needsRepoint({
    running: runningEngine(readEngineInputs()),
    clangdDir: compileCommandsDirOf(vscode.workspace.getConfiguration("clangd").get("arguments")),
    targetDir: databaseDirOf(project, selection),
    ownDirs: [project ? compileDatabaseDir(projectBuildDir(project.path)) : undefined, appliedDatabaseDir(workspaceState)],
  });
  if (!repoint) {
    return undefined;
  }
  const result = await switchEngine("clangd", options, workspaceState);
  log().info(
    result.ok
      ? `clangd re-pointed at ${selection?.source === "user" ? `your compile database (${selection.file})` : "O3DE's generated compile database"}.`
      : `clangd not re-pointed at the selected compile database yet — ${result.message}`,
  );
  return result;
}

// ---- Sync ------------------------------------------------------------------
export type SyncOutcome =
  | { ran: false; reason: "clangdNotInstalled" | "notInUse" | "userDatabase" }
  | { ran: true; generation: DatabaseGeneration; restarted: boolean };

/**
 * Regenerate the database if clangd uses it; restart clangd only when the content changed. `coverage`
 * overrides the engineCoverage setting for this one generation (the next automatic update goes back to the setting).
 * A user-provided database is never regenerated or written: reason "userDatabase".
 */
export async function syncClangdDatabase(options: BuildOptions, trigger: string, coverage?: EngineCoverage): Promise<SyncOutcome> {
  const inputs = readEngineInputs();
  if (!inputs.clangdInstalled) {
    return { ran: false, reason: "clangdNotInstalled" };
  }
  const { state } = readDatabaseStatus(primaryProject(), options.config, runningEngine(inputs));
  if (state === "notInUse") {
    return { ran: false, reason: "notInUse" };
  }
  if (state === "userProvided") {
    return { ran: false, reason: "userDatabase" };
  }

  const generation = generateWorkspaceDatabase(options, trigger, coverage);
  let restarted = false;
  if (generation.ok && generation.changed) {
    if (findClangdServer()) {
      restarted = await runClangdCommand("clangd.restart"); // open files pick up the new flags
    } else {
      log().info("clangd compile database changed, but no clangd server was found — clangd not restarted.");
    }
  }
  return { ran: true, generation, restarted };
}

// ---- Automatic triggers ----------------------------------------------------
const SYNC_DELAY_MS = 1000; // a configure writes hundreds of reply files — sync once, after they settle

export class ClangdDatabaseSync implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private trigger = "startup";
  private syncing = false;
  private lastConfig: string;

  constructor(
    private readonly options: BuildOptions,
    private readonly workspaceState: vscode.Memento,
    private readonly isEnabled: () => boolean, // the per-project O3DE gate
  ) {
    this.lastConfig = options.config;
    const replyWatcher = vscode.workspace.createFileSystemWatcher("**/.cmake/api/v1/reply/index-*.json");
    this.subs.push(
      replyWatcher,
      replyWatcher.onDidCreate(() => this.schedule("configure")),
      replyWatcher.onDidChange(() => this.schedule("configure")),
      // BuildOptions fires for every option — only the build config changes the flags.
      options.onDidChange(() => {
        if (options.config !== this.lastConfig) {
          this.lastConfig = options.config;
          this.schedule("config");
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule("folders")),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("o3de.intellisense.engineCoverage") || event.affectsConfiguration("o3de.intellisense.compileDatabase")) {
          this.schedule("setting"); // how much engine source the database holds, or which database clangd reads, changed
        }
      }),
      vscode.extensions.onDidChange(() => this.schedule("extensions")),
    );
    this.schedule("startup");
  }

  private schedule(trigger: string): void {
    if (!this.isEnabled()) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.trigger = trigger;
    this.timer = setTimeout(() => void this.run(), SYNC_DELAY_MS);
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    if (this.syncing) {
      this.schedule(this.trigger); // one at a time — try again once the current sync finishes
      return;
    }
    this.syncing = true;
    try {
      const followed = await followDatabaseSetting(this.options, this.workspaceState);
      if (followed?.ok) {
        return; // the re-point ran the engine switch, which settled the database — no second pass
      }
      const clangdOnly = await applyClangdOnlyMode(this.options, this.workspaceState);
      if (!clangdOnly.result?.ok) {
        await syncClangdDatabase(this.options, this.trigger); // a clangd-only switch just generated it — no second pass
      }
    } catch (err) {
      log().warn(`clangd automation (${this.trigger}) failed: ${String(err)}`);
    } finally {
      this.syncing = false;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const sub of this.subs) {
      sub.dispose();
    }
  }
}

// ---- Command ---------------------------------------------------------------
/** "O3DE: Show clangd Compile Database Status" — explain the row; offer the update or its prerequisite. */
export async function showClangdDatabaseStatus(options: BuildOptions, status: IntelliSenseStatus): Promise<void> {
  const database = status.refreshNow().clangdDatabase;
  const update = "Update Now";
  const configure = "Configure Project";
  const buttons = database.state === "notConfigured" ? [configure] : database.state === "upToDate" || database.state === "updatePending" ? [update] : [];
  const pick = await vscode.window.showInformationMessage(databaseDetail(database) + databaseFileNote(database), ...buttons);

  if (pick === configure) {
    await vscode.commands.executeCommand("o3de.configureProject");
  } else if (pick === update) {
    const outcome = await syncClangdDatabase(options, "manual");
    status.refreshNow();
    void vscode.window.showInformationMessage(syncMessage(outcome));
  }
}

/** One sentence describing a sync outcome (the command's message and the MCP tool's summary line). */
export function syncMessage(outcome: SyncOutcome): string {
  if (!outcome.ran) {
    switch (outcome.reason) {
      case "clangdNotInstalled":
        return "clangd isn't installed, so there is no compile database to update.";
      case "userDatabase":
        return "clangd reads your own compile database (o3de.intellisense.compileDatabase) — O3DE never writes it, so there is nothing to update.";
      case "notInUse":
        return "clangd isn't using O3DE's compile database in this workspace — nothing to update.";
    }
  }
  const generation = outcome.generation;
  if (!generation.ok) {
    return generation.reason === "notConfigured"
      ? "clangd's compile database can't be generated: the project hasn't been configured."
      : "clangd's compile database can't be generated: no O3DE project is open.";
  }
  const what = `${generation.entries.toLocaleString("en-US")} entries`;
  return generation.changed
    ? `clangd's compile database updated (${what})${outcome.restarted ? "; clangd restarted to use it." : "."}`
    : `clangd's compile database is already up to date (${what}).`;
}
