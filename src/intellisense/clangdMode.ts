// ============================================================================
//  IntelliSense engine switch (vscode side) — plan I.7.
//
//  Reads which C++ engine is running, and makes one run and the other not:
//
//    clangd   generate O3DE's compile database (project sources, plus engine
//             Framework sources for redirected projects — plan I.5), write the
//             workspace settings (C/C++ IntelliSense off, clangd pointed at the
//             database), then restart clangd.
//    C/C++    restore the workspace settings O3DE changed, switch clangd off for
//             the workspace, and shut clangd down.
//
//  ORDER MATTERS with clangd (verified in its source): `clangd.restart` while
//  clangd.enable is false shows clangd's own "enable?" prompt, whose button writes
//  the USER setting — so the workspace enable is written before restarting.
//  `clangd.shutdown` stops clangd without prompting. A clangd with no server yet
//  shows its own "download clangd?" prompt on restart — that's the next step.
//
//  The C/C++ extension (verified in cpptools 1.34.4): turning its IntelliSense OFF
//  only takes effect after a window reload (it prompts once); turning it back ON
//  re-activates live. It reads the setting for the FIRST workspace folder.
//
//  Pure decisions live in intellisenseEngine.ts; this module does the I/O.
// ============================================================================

import * as vscode from "vscode";
import { log } from "../log";
import { BuildOptions } from "../build/buildOptions";
import { fileApiReplyDir } from "../build/configureCommand";
import { CLANGD_EXTENSION_ID, CPPTOOLS_EXTENSION_ID } from "../constants";
import { runGuidedAction } from "../deps/actions";
import { readProject } from "../o3de/identity";
import { primaryO3deFolder } from "../workspace/projectScope";
import { loadCommandReply, replyTimestamp } from "./fileApi";
import { DatabaseGeneration, DatabaseRecord } from "./clangdDatabase";
import { buildCompileDatabase, compileDatabaseDir, listFrameworkSources, projectIncludePaths, writeCompileDatabase } from "./compileDb";
import { absoluteEngineMappings } from "./engineMappings";
import { detectEngineMode } from "./engineMode";
import {
  EngineChoice,
  EngineInputs,
  ManagedKey,
  PriorValues,
  RunningEngine,
  engineSwitchBlocker,
  nextReloadPending,
  planEngine,
  runningEngine,
  runningEngineLabel,
} from "./intellisenseEngine";
import type { IntelliSenseStatus } from "./intellisenseStatus";

const PRIOR_KEY = "o3de.intellisense.enginePrior"; // workspaceState: values O3DE replaced

// ---- Reading state ---------------------------------------------------------
/** Installed extensions + the EFFECTIVE engine settings. */
export function readEngineInputs(): EngineInputs {
  const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri; // where the C/C++ extension reads its engine
  return {
    cppToolsInstalled: vscode.extensions.getExtension(CPPTOOLS_EXTENSION_ID) !== undefined,
    clangdInstalled: vscode.extensions.getExtension(CLANGD_EXTENSION_ID) !== undefined,
    cppToolsEngine: vscode.workspace.getConfiguration("C_Cpp", firstFolder).get<string>("intelliSenseEngine"),
    clangdEnable: vscode.workspace.getConfiguration("clangd").get<boolean>("enable"),
  };
}

function splitKey(key: ManagedKey): { section: string; name: string } {
  const dot = key.indexOf(".");
  return { section: key.slice(0, dot), name: key.slice(dot + 1) };
}

/** WORKSPACE-scope values of the managed keys (not the effective ones). */
function readWorkspaceValues(): Partial<Record<ManagedKey, unknown>> {
  const keys: ManagedKey[] = ["C_Cpp.intelliSenseEngine", "clangd.enable", "clangd.arguments"];
  const out: Partial<Record<ManagedKey, unknown>> = {};
  for (const key of keys) {
    const { section, name } = splitKey(key);
    const value = vscode.workspace.getConfiguration(section).inspect(name)?.workspaceValue;
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** What clangd.enable is WITHOUT a workspace value: the user setting, else clangd's default. */
function inheritedClangdEnable(): boolean {
  const inspected = vscode.workspace.getConfiguration("clangd").inspect<boolean>("enable");
  return inspected?.globalValue ?? inspected?.defaultValue ?? true;
}

// ---- Compile database ------------------------------------------------------
// Every generation — from the engine switch, the automatic sync (clangdSync.ts), a command or an MCP
// call — is recorded here, so the status row and the MCP status report one truth.
let lastGeneration: DatabaseGeneration | undefined;
const generated = new vscode.EventEmitter<DatabaseGeneration>();

/** Fires after every generation attempt. */
export const onDidGenerateDatabase = generated.event;

/** This session's latest generation attempt (undefined until one runs). */
export function lastDatabaseGeneration(): DatabaseGeneration | undefined {
  return lastGeneration;
}

function record(generation: DatabaseGeneration): DatabaseGeneration {
  lastGeneration = generation;
  generated.fire(generation);
  return generation;
}

/** Build and write O3DE's compile database for the workspace's primary project. */
export function generateWorkspaceDatabase(options: BuildOptions, trigger: string): DatabaseGeneration {
  const started = Date.now();
  const folder = primaryO3deFolder();
  const project = folder ? readProject(folder.uri.fsPath) : undefined;
  if (!project) {
    return record({ ok: false, at: started, trigger, reason: "noProject" });
  }
  const replyDir = fileApiReplyDir(project.path);
  const reply = loadCommandReply(replyDir, options.config);
  if (!reply) {
    return record({ ok: false, at: started, trigger, reason: "notConfigured" });
  }
  const includePaths = reply.targets.flatMap((target) => target.compile.includes.map((include) => include.path));
  const mappings = absoluteEngineMappings(project, includePaths);

  // Redirected projects get engine Framework sources (their SDK engine ships no .cpp) — plan I.5.
  const mode = detectEngineMode(project, includePaths);
  const engineSources =
    mode.mode === "redirected" && mode.sourceEngine
      ? listFrameworkSources(mode.sourceEngine.path, process.platform, projectIncludePaths(reply, mappings))
      : [];

  const commands = buildCompileDatabase(reply, mappings, engineSources);
  const written = writeCompileDatabase(reply.buildDir, commands);
  const durationMs = Date.now() - started;
  const flags = reply.config.toLowerCase() === options.config.toLowerCase() ? reply.config : `${reply.config} flags — no ${options.config} configuration`;
  log().info(
    `clangd compile database (${trigger}, ${flags}): ${written.entries} entries (${engineSources.length} engine Framework) → ` +
      `${written.file}${written.changed ? "" : " (unchanged)"} in ${durationMs} ms`,
  );
  return record({
    ok: true,
    at: started,
    trigger,
    config: options.config,
    flagsConfig: reply.config,
    replyTimestamp: replyTimestamp(replyDir),
    dir: compileDatabaseDir(reply.buildDir),
    file: written.file,
    entries: written.entries,
    engineEntries: engineSources.length,
    changed: written.changed,
    durationMs,
  });
}

// ---- clangd commands -------------------------------------------------------
/** Run a clangd command; a clangd that isn't there or fails to run is logged, never raised. */
export async function runClangdCommand(command: "clangd.restart" | "clangd.shutdown"): Promise<boolean> {
  if (!vscode.extensions.getExtension(CLANGD_EXTENSION_ID)) {
    log().info(`${command} skipped: the clangd extension isn't installed.`);
    return false;
  }
  try {
    await vscode.commands.executeCommand(command);
    return true;
  } catch (err) {
    log().warn(`${command} failed: ${String(err)}`);
    return false;
  }
}

// ---- Applying a choice -----------------------------------------------------
async function writeSettings(writes: { key: ManagedKey; value: unknown }[]): Promise<void> {
  for (const { key, value } of writes) {
    const { section, name } = splitKey(key);
    await vscode.workspace.getConfiguration(section).update(name, value, vscode.ConfigurationTarget.Workspace);
    log().info(`IntelliSense engine: workspace ${key} = ${value === undefined ? "(removed)" : JSON.stringify(value)}`);
  }
}

// A reload is still owed when O3DE turned the C/C++ extension's IntelliSense off while it was running.
// Lives in the extension host, so a window reload clears it — exactly when the debt is paid.
let cppToolsReloadPending = false;

/** True while the C/C++ extension's IntelliSense keeps running until the window reloads. */
export function cppToolsStopsAfterReload(): boolean {
  return cppToolsReloadPending;
}

export type EngineSwitchResult =
  | {
      ok: true;
      engine: EngineChoice;
      running: RunningEngine; // effective state right after the writes
      changedSettings: ManagedKey[];
      database?: { file: string; entries: number; engineEntries: number; changed: boolean };
      reloadRequired: boolean; // the C/C++ extension stops its IntelliSense only after a window reload
    }
  | { ok: false; reason: "noWorkspace" | "notInstalled" | "noProject" | "notConfigured"; message: string };

// Switches run ONE AT A TIME. Two interleaved switches (e.g. the engine picker installing clangd while
// clangd-only mode reacts to that install) could each read the prior-values record before the other saved
// it, and record O3DE's own writes as the user's originals.
let switchQueue: Promise<unknown> = Promise.resolve();

/**
 * Make `choice` the running engine for this workspace — HEADLESS: no prompts, no notifications.
 * The dashboard's switch (applyEngineChoice), clangd-only mode and the MCP tool all run this.
 */
export function switchEngine(choice: EngineChoice, options: BuildOptions, memento: vscode.Memento): Promise<EngineSwitchResult> {
  const run = switchQueue.then(() => switchEngineNow(choice, options, memento));
  switchQueue = run.catch(() => undefined);
  return run;
}

async function switchEngineNow(
  choice: EngineChoice,
  options: BuildOptions,
  memento: vscode.Memento,
): Promise<EngineSwitchResult> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return { ok: false, reason: "noWorkspace", message: "No workspace is open." };
  }
  const inputs = readEngineInputs();
  if (engineSwitchBlocker(choice, inputs) === "notInstalled") {
    const extension = choice === "clangd" ? `clangd (${CLANGD_EXTENSION_ID})` : `the C/C++ extension (${CPPTOOLS_EXTENSION_ID})`;
    return { ok: false, reason: "notInstalled", message: `${extension} isn't installed — install it from Setup & Onboarding first.` };
  }

  // clangd needs O3DE's compile database before anything changes.
  let database: DatabaseRecord | undefined;
  if (choice === "clangd") {
    const outcome = generateWorkspaceDatabase(options, "switch");
    if (!outcome.ok) {
      return outcome.reason === "noProject"
        ? { ok: false, reason: "noProject", message: "No O3DE project is open in this workspace." }
        : { ok: false, reason: "notConfigured", message: "The project hasn't been configured yet, so there is no build data to give clangd." };
    }
    database = outcome;
  }

  const plan = planEngine(choice, {
    cppToolsInstalled: inputs.cppToolsInstalled,
    clangdInstalled: inputs.clangdInstalled,
    workspace: readWorkspaceValues(),
    inheritedClangdEnable: inheritedClangdEnable(),
    prior: memento.get<PriorValues>(PRIOR_KEY) ?? {},
    databaseDir: database?.dir,
  });
  await writeSettings(plan.writes);
  await memento.update(PRIOR_KEY, plan.prior);

  // restart: enable is already true for the workspace, so clangd doesn't prompt. shutdown: no prompt, no enable check.
  await runClangdCommand(choice === "clangd" ? "clangd.restart" : "clangd.shutdown");
  cppToolsReloadPending = nextReloadPending(choice, runningEngine(inputs), cppToolsReloadPending);

  return {
    ok: true,
    engine: choice,
    running: runningEngine(readEngineInputs()),
    changedSettings: plan.writes.map((write) => write.key),
    database: database && { file: database.file, entries: database.entries, engineEntries: database.engineEntries, changed: database.changed },
    reloadRequired: cppToolsReloadPending,
  };
}

/** The dashboard's switch: run switchEngine, then tell the user what happened. Returns false when it couldn't apply. */
export async function applyEngineChoice(
  choice: EngineChoice,
  options: BuildOptions,
  memento: vscode.Memento,
): Promise<boolean> {
  const result = await switchEngine(choice, options, memento);
  if (!result.ok) {
    const configure = "Configure Project";
    const pick = await vscode.window.showWarningMessage(
      `O3DE: can't switch IntelliSense engine — ${result.message}`,
      ...(result.reason === "notConfigured" ? [configure] : []),
    );
    if (pick === configure) {
      void vscode.commands.executeCommand("o3de.configureProject");
    }
    return false;
  }

  if (choice === "cpptools") {
    void vscode.window.showInformationMessage("O3DE: C/C++ IntelliSense is on for this workspace; clangd is switched off here.");
  } else if (result.reloadRequired) {
    const reload = "Reload Window";
    const pick = await vscode.window.showInformationMessage(
      "O3DE: clangd IntelliSense is on for this workspace. Reload the window to finish switching — the C/C++ " +
        "extension stops its IntelliSense only after a reload (it still handles debugging).",
      reload,
    );
    if (pick === reload) {
      void vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } else {
    void vscode.window.showInformationMessage(
      "O3DE: clangd IntelliSense is on for this workspace. It indexes the project in the background on first use.",
    );
  }
  return true;
}

// ---- Command ---------------------------------------------------------------
interface EngineItem extends vscode.QuickPickItem {
  choice: EngineChoice;
}

/** "O3DE: Select IntelliSense Engine" — choose which engine runs and which does not. */
export async function selectIntelliSenseEngine(
  options: BuildOptions,
  memento: vscode.Memento,
  status: IntelliSenseStatus,
): Promise<void> {
  const inputs = readEngineInputs();
  const running = runningEngine(inputs);
  const mark = (engine: EngineChoice): string => (running === engine || running === "both" ? "running" : "");
  const items: EngineItem[] = [
    {
      choice: "cpptools",
      label: "C/C++ IntelliSense",
      description: inputs.cppToolsInstalled ? mark("cpptools") : "not installed",
      detail: "The Microsoft C/C++ extension provides IntelliSense; clangd is switched off for this workspace.",
    },
    {
      choice: "clangd",
      label: "clangd IntelliSense",
      description: inputs.clangdInstalled ? mark("clangd") : "not installed",
      detail:
        "clangd provides IntelliSense from O3DE's compile database, with whole-project indexing" +
        (inputs.cppToolsInstalled ? "; the C/C++ extension's IntelliSense is switched off here (it still handles debugging)." : "."),
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: `O3DE: IntelliSense Engine — currently ${runningEngineLabel(running)}`,
    placeHolder: "Choose which engine runs for this workspace",
  });
  if (!pick) {
    return;
  }

  // Not installed yet → install through onboarding's action (which, for clangd, also records clangd's
  // "don't show the conflict warning again" flag), then apply the choice once the extension is present.
  const extensionId = pick.choice === "clangd" ? CLANGD_EXTENSION_ID : CPPTOOLS_EXTENSION_ID;
  if (!vscode.extensions.getExtension(extensionId)) {
    await runGuidedAction({ label: `Install ${pick.label}`, kind: "extension", payload: extensionId });
    if (!(await waitForExtension(extensionId, EXTENSION_REGISTRATION_WAIT_MS))) {
      log().warn(`IntelliSense engine: ${extensionId} isn't available yet — choose the engine again once it is.`);
      return; // install failed or needs a reload — the install action's own message explains
    }
  }
  if (await applyEngineChoice(pick.choice, options, memento)) {
    status.refreshNow();
  }
}

// ---- helper ----------------------------------------------------------------
const EXTENSION_REGISTRATION_WAIT_MS = 15000;

/** Resolves true once `id` is registered (an install finishes a moment after its command returns), false on timeout. */
function waitForExtension(id: string, timeoutMs: number): Promise<boolean> {
  if (vscode.extensions.getExtension(id)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const finish = (found: boolean): void => {
      subscription.dispose();
      clearTimeout(timer);
      resolve(found);
    };
    const subscription = vscode.extensions.onDidChange(() => {
      if (vscode.extensions.getExtension(id)) {
        finish(true);
      }
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
