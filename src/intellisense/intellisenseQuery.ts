// ============================================================================
//  IntelliSense query — read the IntelliSense state + switch the C++ engine.
//
//  Backs the LLM/MCP IntelliSense tools (o3de_intellisense_status /
//  o3de_set_intellisense_engine) with the SAME answers the dashboard shows:
//    - IntelliSense ▸ Status rows (IntelliSense Engine, Engine Sources, C++ Data,
//      Lua Reflection)
//    - Setup & Onboarding's C/C++ and clangd extension rows
//  Switching runs the same headless core as the dashboard's switch, so settings
//  written from an assistant show up on the dashboard live.
// ============================================================================

import * as vscode from "vscode";
import { BuildOptions } from "../build/buildOptions";
import { CLANGD_EXTENSION_ID, CPPTOOLS_EXTENSION_ID } from "../constants";
import { detectClangd } from "../deps/detectors";
import { EngineSwitchResult, cppToolsStopsAfterReload, switchEngine } from "./clangdMode";
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
  };
  extensions: {
    cppTools: ExtensionInstall;
    clangd: ExtensionInstall & { server: { found: boolean; detail: string } }; // the onboarding row's staged state
  };
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
  return {
    engine: {
      running,
      label: runningEngineLabel(running),
      detail: runningEngineDetail(running, inputs),
      settings: { cppToolsIntelliSenseEngine: inputs.cppToolsEngine, clangdEnable: inputs.clangdEnable },
      cppToolsStopsAfterReload: cppToolsStopsAfterReload(),
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
    engineSources: { ...snapshot.engine, label: engineModeLabel(snapshot.engine), detail: engineModeDetail(snapshot.engine) },
    cppData: { ...snapshot.cpp, label: cppFreshnessLabel(snapshot.cpp), detail: cppFreshnessDetail(snapshot.cpp) },
    luaReflection: { ...snapshot.lua, label: luaFreshnessLabel(snapshot.lua), detail: luaFreshnessDetail(snapshot.lua) },
  };
}

// ---- Switch (set) ----------------------------------------------------------
/** Make `engine` the running C++ IntelliSense engine for this workspace (never installs anything). */
export function setIntelliSenseEngine(
  buildOptions: BuildOptions,
  workspaceState: vscode.Memento,
  engine: EngineChoice,
): Promise<EngineSwitchResult> {
  return switchEngine(engine, buildOptions, workspaceState);
}

// ---- Internal --------------------------------------------------------------
function extensionInstall(id: string): ExtensionInstall {
  const extension = vscode.extensions.getExtension(id);
  const version = (extension?.packageJSON as { version?: unknown } | undefined)?.version;
  return { id, installed: extension !== undefined, version: typeof version === "string" ? version : undefined };
}
