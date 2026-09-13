// ============================================================================
//  IntelliSense status — the cached readout behind the dashboard's
//  IntelliSense ▸ Status rows (IntelliSense Engine, Engine Sources, C++ Data,
//  Lua Reflection).
//
//  Computing it reads engine.json files, the File API reply, ~1.7k CMake input
//  timestamps and the build's module binaries (tens of ms). The dashboard
//  re-renders on every build progress tick, so it must NEVER compute there — it
//  reads `current`. This service owns every event that can actually change the
//  answer and recomputes only then:
//
//    panel re-scan / workspace folders      deps.onDidChange
//    build config switched                  options.onDidChange
//    a build or configure finished          buildState running → idle
//    configure wrote a new reply            watcher: reply/index-*.json
//    a Lua dump was written                 watcher: user/lua_symbols.json
//    the running C++ engine changed         C_Cpp.intelliSenseEngine / clangd.enable /
//                                           clangd.arguments settings, installed extensions
// ============================================================================

import * as vscode from "vscode";
import { BuildOptions } from "../build/buildOptions";
import { ActivitySnapshot, BuildState } from "../build/buildState";
import { fileApiReplyDir } from "../build/configureCommand";
import { DependencyStatus } from "../deps/dependencyStatus";
import { readProject } from "../o3de/identity";
import { primaryO3deFolder } from "../workspace/projectScope";
import { EngineModeReport, detectEngineMode } from "./engineMode";
import { readEngineInputs } from "./clangdMode";
import { EngineInputs, RunningEngine, runningEngine } from "./intellisenseEngine";
import {
  CppFreshness,
  LuaFreshness,
  cppFreshness,
  cppFreshnessDetail,
  luaFreshness,
  luaFreshnessDetail,
  readCppFreshness,
  readLuaFreshness,
} from "./freshness";

// ---- Snapshot --------------------------------------------------------------
export interface IntelliSenseSnapshot {
  activeEngine: { running: RunningEngine; inputs: EngineInputs }; // which C++ engine is running (C/C++ or clangd)
  engine: EngineModeReport;
  cpp: CppFreshness;
  lua: LuaFreshness;
}

/** Compute every status row for the workspace's primary O3DE project. Never prompts. */
export function computeIntelliSenseSnapshot(configName: string): IntelliSenseSnapshot {
  const inputs = readEngineInputs();
  const activeEngine = { running: runningEngine(inputs), inputs };
  const folder = primaryO3deFolder();
  const project = folder ? readProject(folder.uri.fsPath) : undefined;
  const engine = detectEngineMode(project);
  if (!project) {
    return { activeEngine, engine, cpp: cppFreshness(undefined, undefined), lua: luaFreshness(undefined, undefined, []) };
  }
  const replyDir = fileApiReplyDir(project.path);
  return {
    activeEngine,
    engine,
    cpp: readCppFreshness(replyDir),
    lua: readLuaFreshness(project.path, replyDir, configName, engine.buildEngine?.path),
  };
}

// ---- Cache -----------------------------------------------------------------
const COALESCE_MS = 300; // a configure writes hundreds of reply files; recompute once

const isWorking = (activity: ActivitySnapshot): boolean => Boolean(activity.build || activity.configure);

export class IntelliSenseStatus implements vscode.Disposable {
  private snapshot: IntelliSenseSnapshot;
  private readonly changed = new vscode.EventEmitter<IntelliSenseSnapshot>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wasWorking: boolean;

  constructor(
    private readonly options: BuildOptions,
    buildState: BuildState,
    deps: DependencyStatus,
  ) {
    this.snapshot = computeIntelliSenseSnapshot(options.config);
    this.wasWorking = isWorking(buildState.activity);

    const replyWatcher = vscode.workspace.createFileSystemWatcher("**/.cmake/api/v1/reply/index-*.json");
    const dumpWatcher = vscode.workspace.createFileSystemWatcher("**/user/lua_symbols.json");
    for (const watcher of [replyWatcher, dumpWatcher]) {
      this.subs.push(watcher, watcher.onDidCreate(() => this.schedule()), watcher.onDidChange(() => this.schedule()));
    }
    this.subs.push(
      deps.onDidChange(() => this.schedule()),
      options.onDidChange(() => this.schedule()),
      // Which engine runs follows these settings and which extensions are installed.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("C_Cpp.intelliSenseEngine") ||
          e.affectsConfiguration("clangd.enable") ||
          e.affectsConfiguration("clangd.arguments")
        ) {
          this.schedule();
        }
      }),
      vscode.extensions.onDidChange(() => this.schedule()),
      // Progress ticks fire constantly — only the running → idle edge can change the answer.
      buildState.onDidChange((activity) => {
        const working = isWorking(activity);
        if (this.wasWorking && !working) {
          this.schedule();
        }
        this.wasWorking = working;
      }),
    );
  }

  /** The last computed snapshot — free to read on every render. */
  get current(): IntelliSenseSnapshot {
    return this.snapshot;
  }

  /** Recompute right now (a user asked) and publish. */
  refreshNow(): IntelliSenseSnapshot {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.snapshot = computeIntelliSenseSnapshot(this.options.config);
    this.changed.fire(this.snapshot);
    return this.snapshot;
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.refreshNow(), COALESCE_MS);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const sub of this.subs) {
      sub.dispose();
    }
    this.changed.dispose();
  }
}

// ---- Commands --------------------------------------------------------------
/** Explain a status row, offering its remedy only when one applies. */
async function explain(detail: string, remedy: { label: string; command: string } | undefined): Promise<void> {
  const choice = await vscode.window.showInformationMessage(detail, ...(remedy ? [remedy.label] : []));
  if (remedy && choice === remedy.label) {
    await vscode.commands.executeCommand(remedy.command);
  }
}

/** "O3DE: Show C++ IntelliSense Data Status" */
export function showCppDataStatus(status: IntelliSenseStatus): Promise<void> {
  const cpp = status.refreshNow().cpp;
  const remedy = cpp.state === "upToDate" ? undefined : { label: "Configure Project", command: "o3de.configureProject" };
  return explain(cppFreshnessDetail(cpp), remedy);
}

/** "O3DE: Show Lua Reflection Status" */
export function showLuaReflectionStatus(status: IntelliSenseStatus): Promise<void> {
  const lua = status.refreshNow().lua;
  const remedy = lua.state === "upToDate" ? undefined : { label: "Generate Lua IntelliSense", command: "o3de.generateLuaIntelliSense" };
  return explain(luaFreshnessDetail(lua), remedy);
}
