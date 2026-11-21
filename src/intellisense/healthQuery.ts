// ============================================================================
//  IntelliSense health query - the vscode side of the health check.
//
//  Backs the command "O3DE: Check IntelliSense Health" and the MCP tool
//  o3de_intellisense_health with ONE headless core (healthRun.ts). This module reads
//  the workspace - the project, the compile database clangd reads, clangd's own
//  settings, the engine - and hands the core plain inputs. Nothing here prompts or
//  notifies except the command wrapper at the bottom.
//
//  Which database is checked is the one clangd READS: the folder in clangd.arguments'
//  --compile-commands-dir, else the one O3DE selected (generated, or the user's own).
//  When they differ the report says so, and which one it checked.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { BuildOptions } from "../build/buildOptions";
import { fileApiReplyDir, projectBuildDir } from "../build/configureCommand";
import { sourceEngineFolder } from "../build/workspaceFolders";
import { substituteClangdVariables } from "../deps/clangdServer";
import { O3deProject, readProject } from "../o3de/identity";
import { primaryO3deFolder } from "../workspace/projectScope";
import { compileCommandsDirOf } from "./clangdDatabase";
import { clangdResolveContext, readEngineCoverage, readEngineInputs, workspaceFolderPaths } from "./clangdMode";
import { readDatabaseStatus } from "./clangdSync";
import { compileDatabaseDir, replySourceFiles } from "./compileDb";
import { planCompileDatabase, readManifestGems, relevantManifestGems } from "./databasePlan";
import { EngineModeReport, detectEngineMode } from "./engineMode";
import { loadCommandReply } from "./fileApi";
import { checkedDatabase, clampSampleSize, compileRelevantArguments, engineScanRoots, locateClangd, ownScanRoots } from "./healthCheck";
import {
  HealthInputs,
  HealthOutcome,
  OriginRoots,
  ScanRoot,
  TOTAL_BUDGET_MS,
} from "./healthModel";
import { formatHealthReport } from "./healthReport";
import { runHealthCheck } from "./healthRun";
import { runningEngine } from "./intellisenseEngine";

// ---- Request and run -------------------------------------------------------
export interface HealthEnvironment {
  extensionVersion: string;
  globalStorageRoot?: string; // the folder holding every extension's global storage: where the clangd extension downloads clangd
}

export interface HealthRequest {
  sampleSize?: number; // 1..20, default 6
  includeEntryless?: boolean; // default true
  maxTotalMs?: number; // default 5 minutes
  signal?: AbortSignal;
  onProgress?: (checked: number, total: number) => void;
}

/** A check in flight. `result` is set when it finishes - the shape the MCP progress heartbeat waits on. */
export interface HealthRun {
  startedAt: number;
  result?: HealthOutcome;
  done: Promise<HealthOutcome>;
  progress: { checked: number; total: number };
}

/** What the command and the MCP tool both need from the extension: its version, and where global storage lives. */
export function healthEnvironment(context: vscode.ExtensionContext): HealthEnvironment {
  return {
    extensionVersion: (context.extension.packageJSON as { version?: string }).version ?? "0.0.0",
    globalStorageRoot: path.dirname(context.globalStorageUri.fsPath),
  };
}

/** Start a check. A missing project is the outcome (`ok: false`), not an error; `done` only rejects on an unexpected failure. */
export function startHealthCheck(buildOptions: BuildOptions, env: HealthEnvironment, request: HealthRequest = {}): HealthRun {
  const progress = { checked: 0, total: 0 };
  const run: HealthRun = {
    startedAt: Date.now(),
    progress,
    done: execute(buildOptions, env, request, progress).then((outcome) => {
      run.result = outcome;
      return outcome;
    }),
  };
  return run;
}

async function execute(
  buildOptions: BuildOptions,
  env: HealthEnvironment,
  request: HealthRequest,
  progress: { checked: number; total: number },
): Promise<HealthOutcome> {
  const inputs = collectInputs(buildOptions, env, request);
  if (!inputs) {
    return { ok: false, reason: "noProject", message: "No O3DE project is open in this workspace, so there is no compile database to check." };
  }
  const report = await runHealthCheck(inputs, {
    maxTotalMs: request.maxTotalMs ?? TOTAL_BUDGET_MS,
    signal: request.signal,
    onProgress: (checked, total) => {
      progress.checked = checked;
      progress.total = total;
      request.onProgress?.(checked, total);
    },
  });
  return { ok: true, report };
}

// ---- Reading the workspace -------------------------------------------------
const MAX_OWN_ROOTS = 20; // gems scanned for sources the database doesn't list

const isDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The roots that tell each entry's origin. For a database O3DE generated, the build plan is replayed (nothing is written)
 * so gems, fallback gems and engine gems are told apart exactly as they were counted; a user's own database has no plan,
 * so only paths speak.
 */
function originRoots(project: O3deProject, buildOptions: BuildOptions, generated: boolean): OriginRoots {
  const sourceEngineRoot = sourceEngineFolder()?.path;
  const base: OriginRoots = { projectRoot: project.path, sourceEngineRoot };
  const reply = generated ? loadCommandReply(fileApiReplyDir(project.path), buildOptions.config) : undefined;
  if (!reply) {
    return base;
  }
  const planned = planCompileDatabase({ reply, project, sourceEngineRoot, coverage: readEngineCoverage(), workspaceFolders: workspaceFolderPaths() });
  return {
    ...base,
    planFiles: new Set(replySourceFiles(reply).map((file) => file.toLowerCase())),
    participatingGems: planned.participatingGems,
    fallbackGems: planned.fallbackGems,
    skippedManifestGems: planned.skippedManifestGems,
  };
}

/** Where to look for sources the database doesn't list: the user's project and gems, then the engine's tool and gem code. */
function scanRoots(project: O3deProject, engine: EngineModeReport): ScanRoot[] {
  const manifest = relevantManifestGems(readManifestGems(), project, workspaceFolderPaths()); // the same gems the plan reaches
  const own = ownScanRoots({
    projectPath: project.path,
    externalSubdirectories: project.externalSubdirectories,
    manifestGems: manifest.relevant,
    hasGemJson: (dir) => fs.existsSync(path.join(dir, "gem.json")),
    cap: MAX_OWN_ROOTS,
  });
  return [...own, ...engineScanRoots(engine, isDirectory)];
}

function collectInputs(buildOptions: BuildOptions, env: HealthEnvironment, request: HealthRequest): HealthInputs | undefined {
  const folder = primaryO3deFolder();
  const project = folder ? readProject(folder.uri.fsPath) : undefined;
  if (!project) {
    return undefined;
  }

  const running = runningEngine(readEngineInputs());
  const status = readDatabaseStatus(project, buildOptions.config, running);
  const clangdConfig = vscode.workspace.getConfiguration("clangd");
  const clangdArguments = clangdConfig.get<unknown>("arguments");

  // The database clangd reads: its own --compile-commands-dir (variables substituted, relative to the workspace), else the one O3DE selected.
  const context = clangdResolveContext();
  const configuredDir = compileCommandsDirOf(clangdArguments);
  const database = checkedDatabase({
    configuredDir: configuredDir === undefined ? undefined : substituteClangdVariables(configuredDir, context),
    workspaceRoot: context.workspaceRoot,
    selectedDir: status.dir ?? compileDatabaseDir(projectBuildDir(project.path)),
    selectionSource: status.selection?.source,
  });

  const engine = detectEngineMode(project);
  return {
    extensionVersion: env.extensionVersion,
    platform: process.platform,
    project: { name: project.projectName, path: project.path },
    buildDir: projectBuildDir(project.path),
    intellisenseEngine: running,
    clangd: locateClangd({ setting: clangdConfig.get<string>("path"), context, storageRoot: env.globalStorageRoot }),
    clangdArguments: compileRelevantArguments(clangdArguments).map((arg) => substituteClangdVariables(arg, context)),
    database,
    engine: { mode: engine.mode, sourceEngineName: engine.sourceEngine?.name, remedyAvailable: engine.remedyAvailable, coverage: readEngineCoverage() },
    roots: originRoots(project, buildOptions, database.kind === "generated"),
    scanRoots: scanRoots(project, engine),
    sampleSize: clampSampleSize(request.sampleSize),
    includeEntryless: request.includeEntryless ?? true,
  };
}

// ---- Command ---------------------------------------------------------------
/** "O3DE: Check IntelliSense Health" - run the check with a cancellable notification, then open the report as Markdown. */
export async function showIntellisenseHealth(buildOptions: BuildOptions, env: HealthEnvironment): Promise<void> {
  let outcome: HealthOutcome;
  try {
    outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "O3DE: Checking IntelliSense health", cancellable: true },
      (notification, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        return startHealthCheck(buildOptions, env, {
          signal: abort.signal,
          onProgress: (checked, total) => notification.report({ message: `${checked} of ${total} files checked` }),
        }).done;
      },
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`O3DE: the IntelliSense health check failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!outcome.ok) {
    void vscode.window.showWarningMessage(`O3DE: ${outcome.message}`);
    return;
  }
  const document = await vscode.workspace.openTextDocument({ language: "markdown", content: formatHealthReport(outcome.report) });
  await vscode.window.showTextDocument(document, { preview: false });
}
