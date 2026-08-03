// ============================================================================
//  O3DE Development Tools — the single control panel for the O3DE tab.
//
//  One webview owns the whole surface. It shows as the "Dashboard" view under
//  the "O3DE Development Tools <version>" container (the version-carrying title
//  lives on the container, so the view header just reads "Dashboard").
//  Everything lives here, styled by us:
//
//    BUILD & RUN            header carries the discreet status readout on the
//    [ Build ] [ Run ]      right (● Ready, or attention pills). Build/Run
//                           disable when there's no project to act on.
//    UTILITIES              Show Log · Terminal · Editor Log · Error Log
//    ── divider ──
//    ▸ CONFIGURATION        collapsible — Build Options / Project Setup / Launch
//    ▸ ONBOARDING           collapsible — Prerequisites / Workspace (status dots)
//
//  Collapse state persists via the webview state API. Status: satisfied checks
//  fold into one green cluster; only items needing attention surface as named
//  pills (red = missing → install on demand, yellow = update available).
// ============================================================================

import * as vscode from "vscode";
import { RunState } from "../build/runState";
import { ActivitySnapshot, BuildState } from "../build/buildState";
import { OnboardingStatus } from "./onboardingStatus";
import { BuildOptions } from "../build/buildOptions";
import { targetsLabel, coreCountLabel } from "../build/buildCommand";
import { launchArgsLabel } from "../build/runCommand";
import { DependencyStatus } from "../deps/dependencyStatus";
import { buildOnboardingModel, resolveGuidedAction, View } from "../deps/registry";
import { runGuidedAction } from "../deps/actions";
import { loadIcon } from "./svgAssets";
import { getNonce } from "./webviewUtil";

// ---- Webview → command dispatch table (whitelist) --------------------------
const COMMANDS: Record<string, string> = {
  build: "o3de.build",
  run: "o3de.run",
  runDebug: "o3de.runDebug",
  stop: "o3de.stopRun",
  stopBuild: "o3de.stopBuild",
  stopConfigure: "o3de.stopConfigure",
  terminal: "o3de.openDeveloperTerminal",
  log: "o3de.showLog",
  openSettings: "o3de.openSettings",
  editorLog: "o3de.showEditorLog",
  errorLog: "o3de.showErrorLog",
  checkVs: "o3de.checkVisualStudio",
  checkNinja: "o3de.checkNinja",
  setup: "o3de.setupWorkspace",
  addGems: "o3de.addGems",
  selectGenerator: "o3de.selectGenerator",
  selectConfig: "o3de.selectConfig",
  selectCompiler: "o3de.selectCompiler",
  selectTargets: "o3de.selectTargets",
  setCoreCount: "o3de.setCoreCount",
  configureProject: "o3de.configureProject",
  generateCppProperties: "o3de.generateCppProperties",
  classWizard: "o3de.classWizard",
  selectRunTarget: "o3de.selectRunTarget",
  setLaunchArgs: "o3de.setLaunchArgs",
  // Lua
  newLuaScript: "o3de.newLuaScript",
  debugLuaFile: "o3de.debugLuaFile",
  generateLuaIntelliSense: "o3de.generateLuaIntelliSense",
};

// ---- Payloads --------------------------------------------------------------
interface StatusPayload {
  base: boolean; // project + engine — the bare minimum (gates Build/Run)
  cpp: boolean;
  lua: boolean;
}

// The header readout: two ready/not statuses (C++ / Lua), from the deps model.
function statusPayload(deps: DependencyStatus): StatusPayload {
  const r = deps.readiness;
  return { base: r.base, cpp: r.cpp, lua: r.lua };
}

// The two language sections mirror each other: "always-use" first, "sometimes-
// use" next, and one-and-done setup lives in Onboarding (not here). C++ and Lua
// each render into their own collapsible section.
function configPayload(options: BuildOptions, onboarding: OnboardingStatus, activity: ActivitySnapshot) {
  // Configure is a config ROW rather than a button, but it still TOGGLES: while a
  // configure runs the row becomes its own Stop control (the progress itself is on
  // the bar up top). Clicking it used to just report "already running", which gave
  // the user no way to stop it from where they started it.
  const configuring = activity.configure;
  return {
    // Both gate on "a project is present" — the real precondition (generator/
    // config/runTarget always have defaults, so there's no other unset state).
    canBuild: onboarding.hasProject,
    canRun: onboarding.hasProject,
    cpp: [
      {
        title: "Build Options",
        rows: [
          { label: "Generator", value: options.generator, cmd: "selectGenerator" },
          { label: "Compiler", value: options.compiler, cmd: "selectCompiler" },
          { label: "Config", value: options.config, cmd: "selectConfig" },
          { label: "Core Count", value: coreCountLabel(options.coreCount), cmd: "setCoreCount" },
          { label: "Targets", value: targetsLabel(options.targets), cmd: "selectTargets" },
        ],
      },
      {
        title: "Launch Options",
        rows: [
          { label: "Run Target", value: options.runTarget, cmd: "selectRunTarget" },
          { label: "Launch Options", value: launchArgsLabel(options.launchArgs), cmd: "setLaunchArgs" },
        ],
      },
      {
        title: "Configuration",
        rows: [
          configuring
            ? {
                label: "Configure Project",
                value: configuring.cancelling ? "Stopping…" : "■ Stop Configure",
                cmd: "stopConfigure",
              }
            : { label: "Configure Project", cmd: "configureProject" },
          { label: "Generate C++ IntelliSense", cmd: "generateCppProperties" },
          { label: "Add Gems / Folders", cmd: "addGems" },
        ],
      },
    ],
    lua: [
      {
        title: "Scripts",
        rows: [
          { label: "New Lua Script", cmd: "newLuaScript" },
          { label: "Debug Lua File", cmd: "debugLuaFile" },
        ],
      },
      {
        title: "Configuration",
        rows: [{ label: "Generate Lua IntelliSense", cmd: "generateLuaIntelliSense" }],
      },
    ],
  };
}

// ---- Provider --------------------------------------------------------------
export class DashboardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "o3de.dashboard";
  private static readonly COLLAPSE_KEY = "o3de.dashboard.collapse";
  private subs: vscode.Disposable[] = [];

  constructor(
    private readonly runState: RunState,
    private readonly buildState: BuildState,
    private readonly onboarding: OnboardingStatus,
    private readonly options: BuildOptions,
    private readonly deps: DependencyStatus,
    // Section collapse state persists here so it survives full VS Code restarts.
    private readonly memento: vscode.Memento,
    private readonly extensionUri: vscode.Uri, // for media/icons/*.svg
    private readonly version: string, // shown in the panel footer (runtime, from package.json)
  ) {}

  private getCollapse(): Record<string, boolean> {
    return this.memento.get<Record<string, boolean>>(DashboardViewProvider.COLLAPSE_KEY) ?? {};
  }

  // Run a clicked onboarding action. When the check is already satisfied and
  // declares a re-run, resolveGuidedAction returns its re-run action + (optional)
  // confirmation, which we surface as a modal before firing.
  private async runAction(id: string): Promise<void> {
    const state = this.deps.resultMap[id]?.state ?? "unknown";
    const { action, confirm } = resolveGuidedAction(id, state);
    if (!action) {
      return;
    }
    if (confirm) {
      const choice = await vscode.window.showWarningMessage(confirm, { modal: true }, "Run Again");
      if (choice !== "Run Again") {
        return;
      }
    }
    await runGuidedAction(action);
    await this.deps.refresh();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webview = webviewView.webview;
    webview.options = { enableScripts: true };
    webview.html = this.html(webview);

    webview.onDidReceiveMessage(
      (msg: { command?: string; view?: View; action?: string; rescan?: boolean; collapse?: { key: string; open: boolean } }) => {
      if (msg.command) {
        const command = COMMANDS[msg.command];
        if (command) {
          void vscode.commands.executeCommand(command);
        }
        return;
      }
      if (msg.collapse) {
        const map = this.getCollapse();
        map[msg.collapse.key] = msg.collapse.open;
        void this.memento.update(DashboardViewProvider.COLLAPSE_KEY, map);
        return;
      }
      if (msg.view) {
        void this.deps.setView(msg.view);
        return;
      }
      if (msg.rescan) {
        void this.deps.refresh(); // re-detect (e.g. after enabling a gem or generating externally)
        return;
      }
      if (msg.action) {
        void this.runAction(msg.action);
      }
    });

    const postStatus = (): void =>
      void webview.postMessage({ type: "status", ...statusPayload(this.deps) });
    const postConfig = (): void =>
      void webview.postMessage({
        type: "config",
        ...configPayload(this.options, this.onboarding, this.buildState.activity),
      });
    const postDeps = (): void =>
      void webview.postMessage({ type: "deps", model: buildOnboardingModel(this.deps.resultMap, this.deps.view) });

    this.disposeSubs();
    this.subs.push(
      this.runState.onDidChange((running) => void webview.postMessage({ type: "runState", running })),
      // Job activity drives the Build/Stop toggle + the Class Wizard button, and
      // re-posts config so the Configure row shows its own running state.
      this.buildState.onDidChange((activity) => {
        void webview.postMessage({ type: "jobs", activity });
        postConfig();
      }),
      this.onboarding.onDidChange(() => postConfig()), // canBuild/canRun gate on project presence
      this.options.onDidChange(() => postConfig()),
      this.deps.onDidChange(() => {
        postStatus(); // the header C++/Lua readouts derive from deps
        postDeps();
      }),
      // Re-detect whenever the panel is revealed — catches changes made outside
      // the extension (enabling a gem, generating a dump via the live Editor).
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          void this.deps.refresh();
        }
      }),
    );
    void this.deps.refresh(); // fresh scan each time the view resolves
    webviewView.onDidDispose(() => this.disposeSubs());
  }

  private disposeSubs(): void {
    for (const s of this.subs) {
      s.dispose();
    }
    this.subs = [];
  }

  // ---- HTML ----------------------------------------------------------------
  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp =
      `default-src 'none'; style-src 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; img-src ${webview.cspSource};`;
    const initial = JSON.stringify({
      running: this.runState.isRunning,
      activity: this.buildState.activity,
      status: statusPayload(this.deps),
      config: configPayload(this.options, this.onboarding, this.buildState.activity),
      deps: buildOnboardingModel(this.deps.resultMap, this.deps.view),
      collapse: this.getCollapse(),
    });
    const icon = (name: string): string => loadIcon(this.extensionUri, name);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --ok: var(--vscode-testing-iconPassed, #89d185);
      --warn: var(--vscode-testing-iconQueued, #cca700);
      --bad: var(--vscode-testing-iconFailed, #f14c4c);
    }
    html, body { padding: 0; margin: 0; }
    .panel { display: flex; flex-direction: column; gap: 12px; padding: 10px; }
    .group { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
      color: var(--vscode-descriptionForeground); opacity: 0.8;
    }
    .hdr { display: flex; align-items: center; justify-content: space-between; gap: 8px; }

    /* Status readout (in the Build & Run header) */
    .status { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 5px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; display: inline-block; }
    .chip {
      display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
      border-radius: 11px; padding: 2px 8px; font-size: 11px; line-height: 1.4;
      border: 1px solid transparent; transition: background 80ms ease;
      color: var(--vscode-foreground); background: var(--vscode-badge-background);
    }
    .chip:hover { background: var(--vscode-toolbar-hoverBackground); }
    .chip:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .chip.ready { background: transparent; border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
    .chip.ready .dot { background: var(--ok); }
    .chip.ready .count { color: var(--ok); font-weight: 600; }
    .chip.bad { border-color: color-mix(in srgb, var(--bad) 55%, transparent); }
    .chip.bad .dot { background: var(--bad); }
    .chip.warn { border-color: color-mix(in srgb, var(--warn) 60%, transparent); }
    .chip.warn .dot { background: var(--warn); }
    .allclear { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .allclear .dot { background: var(--ok); }
    .allclear.celebrate { color: var(--ok); font-weight: 600; }

    /* Button rows */
    .row { display: flex; gap: 6px; align-items: stretch; flex-wrap: wrap; }
    button {
      font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
      height: 30px; border: none; border-radius: 4px; cursor: pointer; white-space: nowrap;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      transition: background 80ms ease, filter 80ms ease;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    button:disabled { opacity: 0.4; cursor: default; }
    button:disabled:hover { background: var(--vscode-button-background); }
    .primary { flex: 1 1 0; font-weight: 600; min-width: 96px; }
    /* Discreet full-width action — secondary palette, less loud than .primary. */
    .wide {
      width: 100%; font-weight: 600;
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    }
    .wide:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .icon {
      flex: 0 0 auto; width: 36px;
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    }
    .icon:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .util-link {
      flex: 1 1 auto; padding: 0 10px; font-size: 11px;
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    }
    .util-link:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .stop { background: var(--vscode-statusBarItem-errorBackground, #b91c1c); color: #ffffff; }
    .stop:hover { background: var(--vscode-statusBarItem-errorBackground, #b91c1c); filter: brightness(1.12); }
    .stop:disabled { opacity: 0.4; }
    /* The action's own glyph carries the Stop state, so drop the inline icon
       (Build's wrench) while stopped and let it return with the Build label. */
    .stop svg { display: none; }

    /* Progress bar — an Output channel can't redraw a status line, so ninja's
       [n/m] surfaces here: newest output line + percentage, then the track. */
    .prog { display: none; flex-direction: column; gap: 3px; padding: 2px 1px 0; }
    .prog.on { display: flex; }
    .prog-top { display: flex; align-items: baseline; gap: 8px; font-size: 10px; }
    /* Clips the END only, keeping the start of the line (the action/file it
       reports). The full text is on the element's title. */
    .prog-line {
      flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-descriptionForeground);
    }
    .prog-pct {
      flex: 0 0 auto; font-weight: 600; font-variant-numeric: tabular-nums;
      color: var(--vscode-foreground);
    }
    .prog-track {
      height: 6px; border-radius: 3px; overflow: hidden;
      background: var(--vscode-panel-border); opacity: 0.9;
    }
    .prog-fill {
      height: 100%; width: 0%; border-radius: 3px;
      background: var(--vscode-progressBar-background, #0e70c0);
      transition: width 200ms linear;
    }
    /* No [n/m] to read (e.g. the Visual Studio generator): sweep, don't fake a %. */
    .prog-track.indeterminate .prog-fill { width: 30%; animation: slide 1.3s ease-in-out infinite; }
    @keyframes slide { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
    .prog.cancelling .prog-fill { background: var(--vscode-statusBarItem-errorBackground, #b91c1c); }

    .divider { height: 1px; background: var(--vscode-panel-border); margin: 2px 0; opacity: 0.7; }
    .divider.wide { margin: 14px 0 8px; }

    .appfoot { text-align: center; font-size: 10px; letter-spacing: 0.03em;
      color: var(--vscode-descriptionForeground); opacity: 0.55; padding: 8px 0 2px; }

    /* Collapsible sections */
    .sec { display: flex; flex-direction: column; }
    .sec-hdr {
      justify-content: flex-start; gap: 6px; height: 28px; padding: 0 4px; border-radius: 4px;
      background: transparent; color: var(--vscode-foreground);
      font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    }
    .sec-hdr:hover { background: var(--vscode-list-hoverBackground); }
    .chev { font-size: 10px; transition: transform 120ms ease; opacity: 0.8; }
    .sec.open > .sec-hdr .chev { transform: rotate(90deg); }
    .hdr-actions { margin-left: auto; display: flex; align-items: center; gap: 9px; }
    .hdr-rescan {
      display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
      border-radius: 4px; cursor: pointer; font-size: 13px; opacity: 0.75;
      color: var(--vscode-descriptionForeground);
    }
    .hdr-rescan:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .sec-body { display: none; padding: 2px 0 2px; flex-direction: column; gap: 6px; }
    .sec.open > .sec-body { display: flex; }

    /* Config / onboarding rows */
    .subhead { font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
      color: var(--vscode-descriptionForeground); opacity: 0.6; padding: 0 8px 3px; margin-top: 16px; }
    .subhead:first-child { margin-top: 2px; }
    .rows { display: flex; flex-direction: column; }
    .cfg-row {
      height: auto; justify-content: space-between; gap: 8px; padding: 5px 8px; border-radius: 4px;
      font-size: 12px; font-weight: 400; background: transparent; color: var(--vscode-foreground);
    }
    .cfg-row:hover { background: var(--vscode-list-hoverBackground); }
    .rowlead { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .rowlead .dot.okdot { background: var(--ok); }
    .rowlead .dot.baddot { background: var(--bad); }
    .val {
      color: var(--vscode-descriptionForeground); font-size: 11px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 52%;
    }

    /* ---- Guided setup ---- */
    .intents { display: flex; gap: 6px; padding: 2px 4px 8px; }
    .intent {
      flex: 1 1 0; height: 30px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;
      display: flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground); background: transparent;
    }
    .intent.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
    .intent:hover { background: var(--vscode-list-hoverBackground); }
    .intent.on:hover { background: var(--vscode-button-hoverBackground); }

    .reports { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px 8px; }
    .rep { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 8px; border-radius: 11px;
      border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
    .rep .dot { width: 8px; height: 8px; border-radius: 50%; }
    .rep.ok { border-color: color-mix(in srgb, var(--ok) 45%, transparent); color: var(--ok); }
    .rep.ok .dot { background: var(--ok); }
    .rep.no .dot { background: var(--bad); }

    .next {
      margin: 0 4px 10px; padding: 9px 10px; border-radius: 6px;
      background: var(--vscode-inputValidation-infoBackground, rgba(100,150,255,0.08));
      border: 1px solid var(--vscode-focusBorder);
    }
    .next .nlabel { font-size: 12px; font-weight: 600; margin-bottom: 3px; }
    .next .nwhat { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; line-height: 1.4; }
    .fixbtn {
      height: 26px; padding: 0 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    .fixbtn:hover { background: var(--vscode-button-hoverBackground); }
    .fixbtn.small { height: 22px; padding: 0 8px; font-weight: 400;
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .fixbtn.small:hover { background: var(--vscode-button-secondaryHoverBackground); }

    .dep-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .dep-row:hover { background: var(--vscode-list-hoverBackground); }
    .dep-row .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
    .dep-row .dot.s-ok { background: var(--ok); }
    .dep-row .dot.s-missing { background: var(--bad); }
    .dep-row .dot.s-warn, .dep-row .dot.s-unknown { background: var(--warn); }
    .dep-row .dot.s-absent { background: var(--vscode-descriptionForeground); opacity: 0.5; }
    .dep-row .dlabel { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dep-row.isnext .dlabel { font-weight: 600; }
    .dep-row .ddetail { color: var(--vscode-descriptionForeground); font-size: 10px; max-width: 40%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body>
  <div class="panel">
    <div class="group">
      <div class="hdr">
        <span class="label">Build &amp; Run</span>
        <span class="status" id="status"></span>
      </div>
      <div class="row">
        <button id="build" class="primary" title="Build the selected target(s) with the current config">${icon("tools")}<span>Build</span></button>
        <button id="run" class="primary" title="Launch the selected run target"><span>▶ Run</span></button>
      </div>
      <!-- Live progress for the running build/configure: newest output line +
           percentage above the bar. Hidden entirely when nothing is running. -->
      <div class="prog" id="prog">
        <div class="prog-top">
          <span class="prog-line" id="prog-line"></span>
          <span class="prog-pct" id="prog-pct"></span>
        </div>
        <div class="prog-track" id="prog-track"><div class="prog-fill" id="prog-fill"></div></div>
      </div>
    </div>

    <div class="group">
      <div class="label">Utilities</div>
      <button id="classWizard" class="wide" title="Scaffold a new O3DE component/EBus class (Reflect boilerplate, m_ prefixes)">${icon("wand")}<span>Class Creation Wizard</span></button>
      <div class="row">
        <button id="log" class="icon" title="Reveal the O3DE Development Tools output channel">${icon("log")}</button>
        <button id="terminal" class="icon" title="Open a terminal with the MSVC environment established">${icon("terminal")}</button>
        <button id="editorLog" class="icon" title="Open the O3DE Editor.log for this project">${icon("doc")}</button>
        <button id="errorLog" class="icon" title="Open the O3DE Error.log for this project">${icon("error")}</button>
        <button id="runDebug" class="icon" title="Run the selected target under the C++ debugger">${icon("bug")}</button>
        <button id="openSettings" class="icon" title="Open O3DE Development Tools settings">${icon("gear")}</button>
      </div>
    </div>

    <div class="divider"></div>

    <div class="sec" id="sec-cpp">
      <button class="sec-hdr" data-key="cpp"><span class="chev">▶</span><span>C++</span></button>
      <div class="sec-body"><div id="cpp"></div></div>
    </div>

    <div class="sec" id="sec-lua">
      <button class="sec-hdr" data-key="lua"><span class="chev">▶</span><span>Lua</span></button>
      <div class="sec-body"><div id="lua"></div></div>
    </div>

    <div class="sec" id="sec-setup">
      <button class="sec-hdr" data-key="setup"><span class="chev">▶</span><span>Setup &amp; Onboarding</span><span class="hdr-actions"><span class="hdr-rescan" id="setup-rescan" title="Re-scan dependencies (e.g. after enabling a gem or generating a dump)">↻</span><span class="sec-status" id="setup-status"></span></span></button>
      <div class="sec-body"><div id="deps"></div></div>
    </div>

    <div class="appfoot">O3DE Development Tools · v${this.version}</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const INITIAL = ${initial};
    const runBtn = document.getElementById('run');
    const buildBtn = document.getElementById('build');
    const statusEl = document.getElementById('status');
    const cppEl = document.getElementById('cpp');
    const luaEl = document.getElementById('lua');
    const depsEl = document.getElementById('deps');
    const setupStatus = document.getElementById('setup-status');
    const wizardBtn = document.getElementById('classWizard');
    const debugBtn = document.getElementById('runDebug');
    const progEl = document.getElementById('prog');
    const progLine = document.getElementById('prog-line');
    const progPct = document.getElementById('prog-pct');
    const progTrack = document.getElementById('prog-track');
    const progFill = document.getElementById('prog-fill');
    let running = false, canBuild = false, canRun = false;
    let activity = {};

    function send(command) { vscode.postMessage({ command }); }
    function sendView(view) { vscode.postMessage({ view }); }
    function sendAction(id) { vscode.postMessage({ action: id }); }
    function sendRescan() { vscode.postMessage({ rescan: true }); }

    // ---- Collapsible sections ----
    // State is persisted in the extension's workspaceState (survives full VS Code
    // restarts, unlike webview getState which can drop when the view is disposed).
    // Defaults: C++ open, Lua + Onboarding closed.
    const DEFAULT_COLLAPSE = { cpp: true, lua: false, setup: false };
    const collapse = Object.assign({}, DEFAULT_COLLAPSE, INITIAL.collapse || {});
    function persistCollapse(key, open) {
      collapse[key] = open;
      vscode.postMessage({ collapse: { key, open } });
    }
    function initCollapse() {
      document.querySelectorAll('.sec-hdr').forEach((h) => {
        const key = h.dataset.key;
        const sec = h.parentElement;
        sec.classList.toggle('open', !!collapse[key]);
        h.onclick = () => {
          const open = !sec.classList.contains('open');
          sec.classList.toggle('open', open);
          persistCollapse(key, open);
        };
      });
    }
    function expandSetup() {
      const sec = document.getElementById('sec-setup');
      sec.classList.add('open');
      persistCollapse('setup', true);
      sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // ---- Build & Run enablement ----
    // While a build runs the Build slot stays enabled — it's the Stop control now,
    // the same way the Run slot stays enabled to become Stop.
    //
    // The cross-guards: don't build while a configure is rewriting the CMake cache,
    // and don't LAUNCH while a build is still writing the binaries. Stop is never
    // blocked — force-quitting the Editor mid-build is exactly what unblocks a link.
    function applyEnable() {
      const building = !!activity.build;
      const configuring = !!activity.configure;

      buildBtn.disabled = !building && (!canBuild || configuring);
      if (!building) {
        buildBtn.title = configuring
          ? 'A configure is running — wait for it to finish before building'
          : canBuild
            ? 'Build the selected target(s) with the current config'
            : 'No O3DE project in the workspace — complete Onboarding first';
      }

      runBtn.disabled = !running && (!canRun || building);
      if (!running) {
        runBtn.title = building
          ? "A build is running — its binaries are being written. Stop the build (or wait) before launching."
          : canRun ? 'Launch the selected run target' : 'No run target — set up a project first';
      }

      // Run in Debug launches the same binaries, so it's held back too.
      debugBtn.disabled = building;
      debugBtn.title = building
        ? 'A build is running — wait for it to finish before debugging'
        : 'Run the selected target under the C++ debugger';
    }

    // ---- Managed-job activity: Build <-> Stop Build, and the progress bar ----
    // The output line is NOT trimmed here: CSS text-overflow already clips the
    // END, and trimming the start as well compressed it from both sides
    // ("…log log log…"), hiding what the line actually says. One mechanism only,
    // and it keeps the beginning — the action or file the line is reporting.
    function setJobs(next) {
      activity = next || {};

      // Build slot: purely the Stop control now — the bar below owns progress.
      const b = activity.build;
      buildBtn.classList.toggle('stop', !!b);
      buildBtn.dataset.cmd = b ? 'stopBuild' : 'build';
      const buildLabel = buildBtn.querySelector('span');
      if (b) {
        buildLabel.textContent = b.cancelling ? 'Stopping…' : '■ Stop Build';
        buildBtn.title = b.cancelling
          ? 'Stopping the build — killing its process tree…'
          : 'Stop “' + b.label + '” (' + (b.progress || 'running') + ') and kill its process tree';
      } else {
        buildLabel.textContent = 'Build';
      }

      // Progress bar: follows whichever job claimed it (build, else configure).
      const bar = activity.bar;
      progEl.classList.toggle('on', !!bar);
      progEl.classList.toggle('cancelling', !!bar && bar.cancelling);
      if (bar) {
        progLine.textContent = bar.cancelling
          ? 'Stopping ' + bar.label + '…'
          : (bar.lastLine || bar.label + '…');
        progLine.title = bar.lastLine || bar.label;
        progPct.textContent = bar.percent ? bar.percent + '%' : '';
        progTrack.classList.toggle('indeterminate', !bar.percent);
        progFill.style.width = bar.percent ? bar.percent + '%' : '';
      }

      // Class Wizard — a GUI that's open, not work with a percentage, so it just
      // reflects "open" rather than feeding the bar.
      const w = activity.classWizard;
      wizardBtn.disabled = !!w;
      wizardBtn.querySelector('span').textContent = w
        ? 'Class Creation Wizard (open)'
        : 'Class Creation Wizard';

      applyEnable();
    }
    function setRunning(v) {
      running = v;
      runBtn.classList.toggle('stop', running);
      runBtn.dataset.cmd = running ? 'stop' : 'run';
      runBtn.firstChild.textContent = running ? '■ Stop' : '▶ Run';
      if (running) { runBtn.title = 'Force-quit the running app and its process tree'; }
      applyEnable();
    }

    // ---- Status readout: two ready/not badges (C++ / Lua) ----
    function setStatus(s) {
      statusEl.replaceChildren();
      const badge = (ok, text) => {
        const b = document.createElement('button');
        b.className = 'chip' + (ok ? ' ready' : '');
        b.title = text + (ok ? ' ready' : ' — open Setup to finish');
        const d = document.createElement('span'); d.className = 'dot';
        if (!ok) { d.style.background = 'var(--vscode-descriptionForeground)'; d.style.opacity = '0.5'; }
        b.appendChild(d);
        const t = document.createElement('span'); t.textContent = text; b.appendChild(t);
        b.onclick = expandSetup;
        return b;
      };
      statusEl.appendChild(badge(s.cpp, 'C++'));
      statusEl.appendChild(badge(s.lua, 'Lua'));
    }

    // ---- Row builders ----
    function valueRow(r, withDot) {
      const row = document.createElement('button'); row.className = 'cfg-row';
      const lead = document.createElement('span'); lead.className = 'rowlead';
      if (withDot && r.ok !== undefined) {
        const d = document.createElement('span'); d.className = 'dot ' + (r.ok ? 'okdot' : 'baddot'); lead.appendChild(d);
      }
      const l = document.createElement('span'); l.textContent = r.label; lead.appendChild(l);
      row.appendChild(lead);
      if (r.value !== undefined) {
        const v = document.createElement('span'); v.className = 'val'; v.textContent = r.value; row.appendChild(v);
      }
      row.onclick = () => send(r.cmd);
      return row;
    }

    function renderSections(container, sections) {
      container.replaceChildren();
      for (const section of sections) {
        const h = document.createElement('div'); h.className = 'subhead'; h.textContent = section.title; container.appendChild(h);
        const rows = document.createElement('div'); rows.className = 'rows';
        for (const r of section.rows) { rows.appendChild(valueRow(r, false)); }
        container.appendChild(rows);
      }
    }
    function setConfig(cfg) {
      canBuild = cfg.canBuild; canRun = cfg.canRun; applyEnable();
      renderSections(cppEl, cfg.cpp);
      renderSections(luaEl, cfg.lua);
    }

    // ---- Guided setup (intent ramp + acquisition) ----
    function depRow(v) {
      const row = document.createElement('div');
      row.className = 'dep-row' + (v.isNext ? ' isnext' : '');
      row.title = v.what + (v.detail ? '\\n\\n' + v.detail : '');
      const dot = document.createElement('span'); dot.className = 'dot s-' + v.state; row.appendChild(dot);
      const label = document.createElement('span'); label.className = 'dlabel'; label.textContent = v.label; row.appendChild(label);
      if (v.state === 'ok') {
        // Satisfied: show the detail, plus a small re-run button for checks that
        // support re-firing while green (e.g. rewrite workspace settings).
        if (v.detail) { const d = document.createElement('span'); d.className = 'ddetail'; d.textContent = v.detail; row.appendChild(d); }
        if (v.rerunLabel) {
          const b = document.createElement('button'); b.className = 'fixbtn small'; b.textContent = v.rerunLabel;
          b.title = 'Run this step again';
          b.onclick = () => sendAction(v.id); row.appendChild(b);
        }
      } else if (v.actionLabel && (v.state === 'missing' || v.state === 'warn' || v.state === 'absent' || v.state === 'unknown')) {
        const b = document.createElement('button'); b.className = 'fixbtn small'; b.textContent = v.actionLabel;
        b.onclick = () => sendAction(v.id); row.appendChild(b);
      }
      return row;
    }

    // Render a subhead + a block of dep-rows (skips entirely when empty).
    function depBlock(title, rows) {
      if (!rows || !rows.length) { return; }
      const h = document.createElement('div'); h.className = 'subhead'; h.textContent = title; depsEl.appendChild(h);
      const box = document.createElement('div'); box.className = 'rows';
      for (const v of rows) { box.appendChild(depRow(v)); }
      depsEl.appendChild(box);
    }

    function setDeps(model) {
      depsEl.replaceChildren();

      // STATUS — the read-out first: base / C++ / Lua ready + optionals count.
      // (The overall status dot + Re-scan live in the section header.)
      const reports = document.createElement('div'); reports.className = 'reports';
      const rep = (ok, text) => {
        const s = document.createElement('span'); s.className = 'rep ' + (ok ? 'ok' : 'no');
        const d = document.createElement('span'); d.className = 'dot'; s.appendChild(d);
        const t = document.createElement('span'); t.textContent = text; s.appendChild(t);
        return s;
      };
      reports.appendChild(rep(model.readiness.base, 'Project ready'));
      reports.appendChild(rep(model.readiness.cpp, 'C++ ready'));
      reports.appendChild(rep(model.readiness.lua, 'Lua ready'));
      const opt = model.readiness.optionals;
      const optRep = document.createElement('span'); optRep.className = 'rep';
      optRep.textContent = 'Optionals ' + opt.present + '/' + opt.total; reports.appendChild(optRep);
      depsEl.appendChild(reports);

      setupStatus.replaceChildren();
      const sdot = document.createElement('span'); sdot.className = 'dot';
      sdot.style.background = model.next ? 'var(--bad)' : 'var(--ok)'; setupStatus.appendChild(sdot);

      // NEXT — the single guided action to take now (may be a common or track step).
      if (model.next) {
        const card = document.createElement('div'); card.className = 'next';
        const l = document.createElement('div'); l.className = 'nlabel'; l.textContent = 'Next: ' + model.next.label; card.appendChild(l);
        const w = document.createElement('div'); w.className = 'nwhat'; w.textContent = model.next.what; card.appendChild(w);
        const b = document.createElement('button'); b.className = 'fixbtn'; b.textContent = model.next.actionLabel;
        b.onclick = () => sendAction(model.next.id); card.appendChild(b);
        depsEl.appendChild(card);
      }

      // COMMON — required base checks + both-track optionals (not track-specific).
      depBlock('Required', model.required);
      depBlock('Common Optionals', model.commonOptionals);

      // Spacer between the shared requirements and the track switcher.
      const div1 = document.createElement('div'); div1.className = 'divider wide'; depsEl.appendChild(div1);

      // TRACK SWITCHER — the "window changers": pick C++ or Lua; the rows below
      // carry only that track's own dependencies + configuration.
      const seg = document.createElement('div'); seg.className = 'intents';
      const mk = (key, text) => {
        const el = document.createElement('button');
        el.className = 'intent' + (model.view === key ? ' on' : '');
        el.textContent = text;
        el.onclick = () => sendView(key);
        return el;
      };
      seg.appendChild(mk('cpp', 'C++ setup'));
      seg.appendChild(mk('lua', 'Lua setup'));
      depsEl.appendChild(seg);

      // TRACK — the selected track's dynamic requirements + optionals.
      const trackName = model.view === 'cpp' ? 'C++' : 'Lua';
      if (model.ramp.length) {
        depBlock(trackName + ' Requirements', model.ramp);
      } else {
        const h = document.createElement('div'); h.className = 'subhead'; h.textContent = trackName + ' Requirements'; depsEl.appendChild(h);
        const none = document.createElement('div'); none.className = 'dep-row'; none.style.opacity = '0.6';
        none.textContent = 'Nothing beyond the common requirements.'; depsEl.appendChild(none);
      }
      depBlock(trackName + ' Optionals', model.optionals);

      // VERSION CONTROL — its own section, independent of track.
      if (model.versionControl.length) {
        const div2 = document.createElement('div'); div2.className = 'divider wide'; depsEl.appendChild(div2);
        depBlock('Version Control', model.versionControl);
      }
    }

    // ---- Wire static buttons ----
    buildBtn.onclick = () => { if (!buildBtn.disabled) { send(buildBtn.dataset.cmd === 'stopBuild' ? 'stopBuild' : 'build'); } };
    runBtn.onclick = () => { if (!runBtn.disabled) { send(runBtn.dataset.cmd === 'stop' ? 'stop' : 'run'); } };
    debugBtn.onclick = () => { if (!debugBtn.disabled) { send('runDebug'); } };
    document.getElementById('terminal').onclick = () => send('terminal');
    document.getElementById('log').onclick = () => send('log');
    document.getElementById('editorLog').onclick = () => send('editorLog');
    document.getElementById('errorLog').onclick = () => send('errorLog');
    document.getElementById('openSettings').onclick = () => send('openSettings');
    wizardBtn.onclick = () => { if (!wizardBtn.disabled) { send('classWizard'); } };
    // Re-scan sits inside the Onboarding header button — stop the click from also
    // toggling the section's collapse.
    document.getElementById('setup-rescan').onclick = (e) => { e.stopPropagation(); sendRescan(); };

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m) { return; }
      if (m.type === 'runState') { setRunning(m.running); }
      if (m.type === 'jobs') { setJobs(m.activity); }
      if (m.type === 'status') { setStatus(m); }
      if (m.type === 'config') { setConfig(m); }
      if (m.type === 'deps') { setDeps(m.model); }
    });

    initCollapse();
    setConfig(INITIAL.config);
    setDeps(INITIAL.deps);
    setRunning(INITIAL.running);
    setJobs(INITIAL.activity);
    setStatus(INITIAL.status);
  </script>
</body>
</html>`;
  }
}

// ---- Nonce (CSP) -----------------------------------------------------------
