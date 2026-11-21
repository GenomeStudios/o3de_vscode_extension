// ============================================================================
//  IntelliSense query — read the IntelliSense state + switch the C++ engine.
//
//  Backs the LLM/MCP IntelliSense tools (o3de_intellisense_status /
//  o3de_set_intellisense_engine / o3de_update_clangd_database) with the SAME
//  answers the dashboard shows:
//    - IntelliSense ▸ Status rows (IntelliSense Engine, clangd Database, Engine
//      Sources, C++ Data, Lua Reflection)
//    - Setup & Onboarding's C/C++ and clangd extension rows
//  Switching runs the same headless core as the dashboard's switch, so settings
//  written from an assistant show up on the dashboard live.
// ============================================================================

import * as vscode from "vscode";
import { BuildOptions } from "../build/buildOptions";
import { CLANGD_EXTENSION_ID, CPPTOOLS_EXTENSION_ID } from "../constants";
import { detectClangd } from "../deps/detectors";
import { EngineSwitchResult, cppToolsStopsAfterReload, readEngineCoverage, switchEngine } from "./clangdMode";
import { DatabaseStatus, databaseDetail, databaseLabel } from "./clangdDatabase";
import { SyncOutcome, syncClangdDatabase } from "./clangdSync";
import { EngineCoverage, engineCoverageDetail } from "./databasePlan";
import { EngineModeReport, engineModeDetail, engineModeLabel } from "./engineMode";
import { CppFreshness, LuaFreshness, cppFreshnessDetail, cppFreshnessLabel, luaFreshnessDetail, luaFreshnessLabel } from "./freshness";
import { EngineChoice, RunningEngine, runningEngineDetail, runningEngineLabel } from "./intellisenseEngine";
import { computeIntelliSenseSnapshot } from "./intellisenseStatus";

// ---- Report (get) ----------------------------------------------------------
export interface ExtensionInstall {
  id: string;
  installed: boolean;
  version?: string;
}

export interface IntelliSenseReport {
  engine: {
    running: RunningEngine;
    label: string;
    detail: string;
    settings: { cppToolsIntelliSenseEngine?: string; clangdEnable?: boolean }; // effective values
    cppToolsStopsAfterReload: boolean; // switched off by O3DE, still running until the window reloads
    clangdOnly: boolean; // no C/C++ extension + clangd installed → O3DE switches clangd on automatically
  };
  extensions: {
    cppTools: ExtensionInstall;
    clangd: ExtensionInstall & { server: { found: boolean; detail: string } }; // the onboarding row's staged state
  };
  // state notInUse unless clangd uses the selected database; last.origins counts entries by origin; selection says which
  // database is selected — generated, or the user's own (o3de.intellisense.compileDatabase) — and why, with any hint or missing file
  clangdDatabase: DatabaseStatus & { label: string; detail: string };
  engineCoverage: { setting: EngineCoverage; detail: string }; // o3de.intellisense.engineCoverage: how much engine source the database holds
  engineSources: EngineModeReport & { label: string; detail: string };
  cppData: CppFreshness & { label: string; detail: string };
  luaReflection: LuaFreshness & { label: string; detail: string };
}

/** Everything the IntelliSense section and the C++ extension rows show, computed now. */
export async function intellisenseReport(buildOptions: BuildOptions): Promise<IntelliSenseReport> {
  const snapshot = computeIntelliSenseSnapshot(buildOptions.config);
  const { running, inputs } = snapshot.activeEngine;
  const clangd = extensionInstall(CLANGD_EXTENSION_ID);
  const server = clangd.installed ? await detectClangd() : undefined;
  const engineCoverage = readEngineCoverage();
  return {
    engine: {
      running,
      label: runningEngineLabel(running),
      detail: runningEngineDetail(running, inputs),
      settings: { cppToolsIntelliSenseEngine: inputs.cppToolsEngine, clangdEnable: inputs.clangdEnable },
      cppToolsStopsAfterReload: cppToolsStopsAfterReload(),
      clangdOnly: !inputs.cppToolsInstalled && inputs.clangdInstalled,
    },
    extensions: {
      cppTools: extensionInstall(CPPTOOLS_EXTENSION_ID),
      clangd: {
        ...clangd,
        server: server
          ? { found: server.state === "ok", detail: server.detail ?? "" }
          : { found: false, detail: "clangd extension not installed" },
      },
    },
    clangdDatabase: {
      ...snapshot.clangdDatabase,
      label: databaseLabel(snapshot.clangdDatabase),
      detail: databaseDetail(snapshot.clangdDatabase),
    },
    engineCoverage: { setting: engineCoverage, detail: engineCoverageDetail(engineCoverage) },
    engineSources: { ...snapshot.engine, label: engineModeLabel(snapshot.engine), detail: engineModeDetail(snapshot.engine) },
    cppData: { ...snapshot.cpp, label: cppFreshnessLabel(snapshot.cpp), detail: cppFreshnessDetail(snapshot.cpp) },
    luaReflection: { ...snapshot.lua, label: luaFreshnessLabel(snapshot.lua), detail: luaFreshnessDetail(snapshot.lua) },
  };
}

// ---- Switch (set) ----------------------------------------------------------
/**
 * Make `engine` the running C++ IntelliSense engine for this workspace (never installs anything).
 * `compileDatabase`, when given, is stored as o3de.intellisense.compileDatabase first: a compile_commands.json, its
 * folder (absolute, or relative to the project), or "" for the generated database.
 */
export function setIntelliSenseEngine(
  buildOptions: BuildOptions,
  workspaceState: vscode.Memento,
  engine: EngineChoice,
  compileDatabase?: string,
): Promise<EngineSwitchResult> {
  return switchEngine(engine, buildOptions, workspaceState, compileDatabase);
}

/**
 * Regenerate clangd's compile database now (only while clangd uses it); restarts clangd if it changed.
 * A user-provided database is never regenerated (ran: false, reason userDatabase).
 * `engineCoverage` overrides the setting for this one run — the next automatic update goes back to the setting.
 */
export function updateClangdDatabase(buildOptions: BuildOptions, engineCoverage?: EngineCoverage): Promise<SyncOutcome> {
  return syncClangdDatabase(buildOptions, "mcp", engineCoverage);
}

// ---- Internal --------------------------------------------------------------
function extensionInstall(id: string): ExtensionInstall {
  const extension = vscode.extensions.getExtension(id);
  const version = (extension?.packageJSON as { version?: unknown } | undefined)?.version;
  return { id, installed: extension !== undefined, version: typeof version === "string" ? version : undefined };
}
