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
//    extensions changed              clangd installed / C/C++ extension removed (clangd-only)
//    startup                         catches up on a configure run while VS Code was closed
//
//  Events are coalesced (a configure writes hundreds of reply files). A generation
//  takes ~270 ms on gs_play (1,759 entries) and writes nothing when the content is
//  identical — so a configure that changed no flags restarts nothing.
//
//  Never touches a clangd that isn't using O3DE's database (clangdDatabase.ts).
//  Never restarts a clangd with no server: its download prompt would come back
//  after every configure.
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
  databaseState,
  sameDirectory,
} from "./clangdDatabase";
import { EngineSwitchResult, generateWorkspaceDatabase, lastDatabaseGeneration, readEngineInputs, runClangdCommand, switchEngine } from "./clangdMode";
import { compileDatabaseDir } from "./compileDb";
import { replyTimestamp } from "./fileApi";
import { ClangdOnlyDecision, RunningEngine, clangdOnlyDecision, runningEngine } from "./intellisenseEngine";
import type { IntelliSenseStatus } from "./intellisenseStatus";

// ---- Status ----------------------------------------------------------------
/** Is clangd using O3DE's database for `project`, and is that database current? */
export function readDatabaseStatus(project: O3deProject | undefined, configName: string, running: RunningEngine): DatabaseStatus {
  const dir = project ? compileDatabaseDir(projectBuildDir(project.path)) : undefined;
  const clangdDir = compileCommandsDirOf(vscode.workspace.getConfiguration("clangd").get("arguments"));
  const last = lastDatabaseGeneration();
  const state = databaseState({
    inUse: clangdUsesDatabase(running, clangdDir, dir),
    last,
    config: configName,
    replyTimestamp: project ? replyTimestamp(fileApiReplyDir(project.path)) : undefined,
  });
  return { state, dir, last };
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
  log().info(`clangd-only: the C/C++ extension isn't installed — clangd switched on with O3DE's compile database (${result.database?.entries ?? 0} entries).`);
  void vscode.window.showInformationMessage(
    "O3DE: clangd now provides C++ IntelliSense in this workspace, from O3DE's compile database. The C/C++ extension " +
      "isn't installed, so O3DE switched clangd on automatically and keeps its database up to date.",
  );
  return { decision, result };
}

// ---- Sync ------------------------------------------------------------------
export type SyncOutcome =
  | { ran: false; reason: "clangdNotInstalled" | "notInUse" }
  | { ran: true; generation: DatabaseGeneration; restarted: boolean };

/** Regenerate the database if clangd uses it; restart clangd only when the content changed. */
export async function syncClangdDatabase(options: BuildOptions, trigger: string): Promise<SyncOutcome> {
  const inputs = readEngineInputs();
  if (!inputs.clangdInstalled) {
    return { ran: false, reason: "clangdNotInstalled" };
  }
  if (readDatabaseStatus(primaryProject(), options.config, runningEngine(inputs)).state === "notInUse") {
    return { ran: false, reason: "notInUse" };
  }

  const generation = generateWorkspaceDatabase(options, trigger);
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
  const file = database.last?.ok ? ` File: ${database.last.file}` : "";
  const pick = await vscode.window.showInformationMessage(databaseDetail(database) + file, ...buttons);

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
    return outcome.reason === "clangdNotInstalled"
      ? "clangd isn't installed, so there is no compile database to update."
      : "clangd isn't using O3DE's compile database in this workspace — nothing to update.";
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
