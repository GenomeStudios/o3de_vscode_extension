// ============================================================================
//  O3DE Development Tools — extension entry point.
//
//  This is the minimal skeleton. Real feature areas (env bootstrap, build/
//  launch, C++/Lua IntelliSense, reflection bridge, codegen) are layered in
//  under src/ per the staged plan.
//
//  All reporting goes through the dedicated Output channel in log.ts — never
//  console.log — so the test window has a clean, self-contained log.
// ============================================================================

import * as vscode from "vscode";
import { initLog, log } from "./log";
import { ensureVisualStudio } from "./env/visualStudioGuard";
import { openDeveloperTerminal } from "./env/developerTerminal";
import { ensureNinja } from "./build/ninjaGuard";
import { DashboardViewProvider } from "./view/dashboardView";
import { OnboardingStatus } from "./view/onboardingStatus";
import { openEditorLog, openErrorLog } from "./build/o3deLogs";
import { runSetupWizard, addGemsToWorkspace } from "./workspace/setupWizard";
import {
  isO3deWorkspace,
  isWorkspaceEnabled,
  primaryO3deFolder,
  o3deProjectFolders,
  enableStateForFolder,
  setProjectEnabled,
} from "./workspace/projectScope";
import { writeProjectConfig } from "./build/writeProjectConfig";
import { configureProject, stopConfigure } from "./build/configure";
import { buildProject, stopBuild } from "./build/build";
import { selectTargets } from "./build/selectTargets";
import { selectRunTarget } from "./build/selectRunTarget";
import { customRunImage } from "./build/runCommand";
import { runProject, stopRun } from "./build/run";
import { forceCloseRuntime } from "./build/runQuery";
import { runInDebug } from "./build/runDebug";
import { RunState } from "./build/runState";
import { BuildState } from "./build/buildState";
import { initCommandOutput } from "./build/commandOutput";
import { generateCppProperties, refreshCppPropertiesOnStartup } from "./intellisense/generate";
import { registerConfigurationProvider } from "./intellisense/provider";
import { registerLuaDebug, debugLuaFile } from "./lua/debug/debugAdapter";
import { registerLuaHandoff } from "./lua/handoff";
import { generateLuaIntelliSense, generateLuaStubsFromDump } from "./lua/intellisense/intelliSense";
import { launchClassWizard } from "./tools/classWizard";
import { copyEnvironmentReport } from "./platform/environmentReport";
import { LuaPaletteViewProvider, LUA_PALETTE_VIEW_ID } from "./lua/palette/luaPaletteProvider";
import { AdvancedViewProvider } from "./view/advancedView";
import { EXTENSION_ID } from "./constants";
import { DependencyStatus } from "./deps/dependencyStatus";
import { O3deMcpServer } from "./mcp/server";
import {
  BuildOptions,
  BUILD_CONFIGS,
  Generator,
  BuildConfig,
  Compiler,
  generatorsForPlatform,
  compilersForPlatform,
} from "./build/buildOptions";

// ---- Activation ------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  // The plain channel that raw build/configure/tool output streams to. Separate
  // from log() so cmake and ninja read verbatim, undecorated by log levels.
  initCommandOutput(context);
  log().info("O3DE Development Tools activated.");
  log().show(true); // reveal our Output channel (dev convenience; keeps focus)

  // Selectable build attributes (generator / config), shown in the O3DE tab.
  const buildOptions = new BuildOptions(context.workspaceState);

  // Onboarding completion model (prerequisites + workspace) — drives the
  // green/red markers and auto-collapse on the Onboarding section.
  const onboarding = new OnboardingStatus(context.workspaceState);

  // Exhaustive dependency model behind the guided Setup ramp (detectors + tracks
  // + intents + acquisition actions). Detect in the background on activation.
  const deps = new DependencyStatus(context.workspaceState);
  void deps.refresh();

  // Live run state (Editor / GameLauncher / custom run target up?) — toggles the
  // toolbar's single Run slot between Play and Stop via `o3de.appRunning`.
  const runState = new RunState(() => {
    const extra = customRunImage(buildOptions.runTarget);
    return extra ? [extra] : [];
  });

  // Live build state (is a managed command running?) — flips the tab's Build slot
  // between Build and Stop Build and carries the progress fill. Event-only: the
  // managed-command registry is in-process, so unlike RunState it needs no poll.
  const buildState = new BuildState();

  // LLM connections — a localhost MCP endpoint an assistant (e.g. Claude) uses to
  // trigger builds and read structured results. Off by default; the MCP SDK is
  // only loaded when started. Toggled from the Onboarding ▸ Optional section.
  const mcpServer = new O3deMcpServer(context, buildOptions);

  // `llm.enabled` is per-project (folder-scoped) so enabling it on one project
  // never affects another. Read it against the O3DE project's folder.
  const llmEnabledForProject = (): boolean =>
    vscode.workspace.getConfiguration("o3de", primaryO3deFolder()?.uri).get<boolean>("llm.enabled", false);

  // MCP runs only when BOTH the project is opted in AND LLM connections are on —
  // so a dormant/non-enabled workspace never starts a server or writes .mcp.json.
  const reconcileMcp = async (): Promise<void> => {
    if (isWorkspaceEnabled() && llmEnabledForProject()) {
      await mcpServer.restart(); // idempotent start + picks up a changed port; writes .mcp.json
    } else {
      await mcpServer.stop();
      mcpServer.removeClientConfig(); // clean the o3de entry out of .mcp.json when off
    }
    void deps.refresh(); // refresh the Optional row's dot/detail
  };

  // ---- Per-project gate: reconcile the automatic machinery to o3de.enabled ----
  // The extension activates in every window, but everything automatic runs ONLY
  // where the user opted this project in. Session-once pieces (VS guard, cpptools
  // provider) register at most once; restartable pieces (run-state watcher, MCP)
  // follow the toggle. A non-O3DE / not-enabled workspace stays fully dormant.
  let providersStarted = false;
  const applyEnablement = (): void => {
    if (isWorkspaceEnabled()) {
      if (!providersStarted) {
        providersStarted = true;
        void ensureVisualStudio({ interactive: false }); // log; alert only if broken
        if (vscode.workspace.getConfiguration("o3de").get<boolean>("intellisense.autoRefreshOnStartup", true)) {
          void refreshCppPropertiesOnStartup(buildOptions); // re-emit c_cpp_properties.json (no reconfigure)
        }
        void registerConfigurationProvider(context, buildOptions); // live C++ IntelliSense (cpptools)
      }
      runState.start(); // watch the running app for the Run/Stop toggle
      void reconcileMcp();
    } else {
      runState.stop();
      void mcpServer.stop();
    }
    void deps.refresh();
    onboarding.notifyChanged();
  };

  // One-time opt-in prompt for an undecided O3DE project (at most once per session).
  let promptedThisSession = false;
  const maybePromptEnable = async (): Promise<void> => {
    if (promptedThisSession || !isO3deWorkspace()) {
      return;
    }
    const folder = primaryO3deFolder();
    if (!folder || enableStateForFolder(folder) !== "undecided") {
      return;
    }
    promptedThisSession = true;
    const choice = await vscode.window.showInformationMessage(
      `Enable O3DE Tools for "${folder.name}"? Its automatic features (C++/Lua IntelliSense, ` +
        "build/run, MCP) run only in projects you enable — other workspaces stay untouched.",
      "Enable",
      "Not now",
      "Never",
    );
    if (choice === "Enable") {
      await setProjectEnabled(folder, true); // the config listener applies it live
    } else if (choice === "Never") {
      await setProjectEnabled(folder, false);
    }
    // "Not now" / dismiss writes nothing -> stays undecided -> asked again next session.
  };

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("o3de.enabled")) {
      applyEnablement(); // start/stop the runtime as the project is opted in/out
    }
    if (
      e.affectsConfiguration("o3de.llm.enabled") ||
      e.affectsConfiguration("o3de.llm.port") ||
      e.affectsConfiguration("o3de.llm.requireToken") ||
      e.affectsConfiguration("o3de.llm.allowForceClose") // re-register tools with the new setting
    ) {
      void reconcileMcp();
    }
  });

  // Commands: enable / disable the LLM endpoint + show the client connection info.
  const llmEnable = vscode.commands.registerCommand("o3de.llm.enable", async () => {
    // Complete, idempotent setup: turn it on, ensure the server is actually
    // listening, and write .mcp.json into the project — so it's genuinely
    // connectable, not just flagged "on".
    const folder = primaryO3deFolder();
    await vscode.workspace
      .getConfiguration("o3de", folder?.uri)
      .update(
        "llm.enabled",
        true,
        folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace,
      );
    await mcpServer.start(); // idempotent (no-op if already running)
    mcpServer.writeClientConfig(); // merge our entry into the project's .mcp.json
    void deps.refresh();
    const info = mcpServer.connectionInfo();
    void vscode.window.showInformationMessage(
      `O3DE: LLM connections on — endpoint ${info.url}. .mcp.json updated; run “/mcp” in Claude to connect.`,
      "Show Connection Info",
    ).then((choice) => {
      if (choice === "Show Connection Info") {
        void vscode.commands.executeCommand("o3de.llm.showConnectionInfo");
      }
    });
  });
  const llmDisable = vscode.commands.registerCommand("o3de.llm.disable", async () => {
    const folder = primaryO3deFolder();
    await vscode.workspace
      .getConfiguration("o3de", folder?.uri)
      .update(
        "llm.enabled",
        false,
        folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace,
      );
  });
  const llmShowInfo = vscode.commands.registerCommand("o3de.llm.showConnectionInfo", async () => {
    if (!llmEnabledForProject()) {
      void vscode.window.showInformationMessage(
        "O3DE: LLM connections are off. Enable them from Onboarding ▸ Optional (or “O3DE: Enable LLM Connections”).",
      );
      return;
    }
    const info = mcpServer.connectionInfo();
    log().info(`LLM (MCP) connection — add to your MCP client (e.g. .mcp.json):\n${info.mcpJson}`);
    log().show(true);
    const pick = await vscode.window.showInformationMessage(
      `O3DE LLM endpoint: ${info.url}`,
      "Write .mcp.json",
      "Copy .mcp.json",
      "Copy Token",
    );
    if (pick === "Write .mcp.json") {
      await mcpServer.writeClientConfigInteractive();
    } else if (pick === "Copy .mcp.json") {
      await vscode.env.clipboard.writeText(info.mcpJson);
    } else if (pick === "Copy Token") {
      await vscode.env.clipboard.writeText(info.token);
    }
  });

  // Commands: opt this project in / out of O3DE Tools (per-project o3de.enabled).
  const pickEnableFolder = async (): Promise<vscode.WorkspaceFolder | undefined> => {
    const folders = o3deProjectFolders();
    if (folders.length <= 1) {
      return folders[0] ?? primaryO3deFolder();
    }
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { title: "O3DE: which project?", placeHolder: "Choose the project to enable/disable" },
    );
    return pick?.folder;
  };
  const enableForProject = vscode.commands.registerCommand("o3de.enableForProject", async () => {
    const folder = await pickEnableFolder();
    if (!folder) {
      void vscode.window.showInformationMessage("O3DE: no O3DE project in this workspace to enable.");
      return;
    }
    await setProjectEnabled(folder, true);
    applyEnablement(); // start the runtime live (no reload)
    void vscode.window.showInformationMessage(`O3DE Tools enabled for "${folder.name}".`);
  });
  const disableForProject = vscode.commands.registerCommand("o3de.disableForProject", async () => {
    const folder = await pickEnableFolder();
    if (!folder) {
      return;
    }
    await setProjectEnabled(folder, false);
    applyEnablement();
    void vscode.window.showInformationMessage(
      `O3DE Tools disabled for "${folder.name}". Reload the window to fully unload the C++ providers.`,
    );
  });

  // Command: "O3DE: Hello World".
  const helloWorld = vscode.commands.registerCommand("o3de.helloWorld", () => {
    log().info("Hello World command invoked.");
    vscode.window.showInformationMessage("Hello from O3DE Development Tools!");
  });

  // Command: "O3DE: Show Log" — reveal this channel any time.
  const showLog = vscode.commands.registerCommand("o3de.showLog", () => {
    log().show();
  });

  // Command: "O3DE: Open Settings" — VS Code Settings filtered to this extension.
  const openSettings = vscode.commands.registerCommand("o3de.openSettings", () => {
    void vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${EXTENSION_ID}`);
  });

  // Command: "O3DE: Copy Environment Report" — a diagnostic snapshot for remote
  // (esp. Linux) bug reports. Copies OS/toolchain/engine/resolved-path state to
  // the clipboard so a tester's "it didn't work" arrives self-diagnosing.
  const copyEnvReport = vscode.commands.registerCommand("o3de.copyEnvironmentReport", () => {
    void copyEnvironmentReport(deps, buildOptions, context.extension.packageJSON.version as string);
  });

  // Commands: open the O3DE project's runtime logs (Editor.log / Error.log).
  const showEditorLog = vscode.commands.registerCommand("o3de.showEditorLog", () => {
    void openEditorLog();
  });
  const showErrorLog = vscode.commands.registerCommand("o3de.showErrorLog", () => {
    void openErrorLog();
  });

  // Command: "O3DE: Check Visual Studio" — re-run detection interactively.
  const checkVs = vscode.commands.registerCommand("o3de.checkVisualStudio", async () => {
    await ensureVisualStudio({ interactive: true });
    void onboarding.refresh();
  });

  // Command: "O3DE: Open Developer Terminal" — a terminal with the MSVC env ready.
  const openTerm = vscode.commands.registerCommand("o3de.openDeveloperTerminal", () => {
    void openDeveloperTerminal();
  });

  // Command: "O3DE: Check Ninja" — detect Ninja, offer to install it if missing.
  const checkNinja = vscode.commands.registerCommand("o3de.checkNinja", async () => {
    await ensureNinja({ interactive: true });
    void onboarding.refresh();
  });

  // Command: "O3DE: Set Up Workspace…" — project + engine source → .code-workspace + .vscode config.
  const setupWorkspace = vscode.commands.registerCommand("o3de.setupWorkspace", () => {
    void runSetupWizard(buildOptions);
  });

  // Command: "O3DE: Add Gems / Folders…" — add gem(s)/folders to the workspace (second pass).
  const addGems = vscode.commands.registerCommand("o3de.addGems", () => {
    void addGemsToWorkspace();
  });

  // Command: "O3DE: Write Project Config" — generate/merge <project>/.vscode/settings.json.
  const writeConfig = vscode.commands.registerCommand("o3de.writeProjectConfig", () => {
    void writeProjectConfig(buildOptions);
  });

  // Command: "O3DE: Configure Project" — run the CMake configure (build/<platform>)
  // with the MSVC environment, streamed to the O3DE Build Output channel.
  const configure = vscode.commands.registerCommand("o3de.configureProject", () => {
    void configureProject(buildOptions);
  });

  // Command: "O3DE: Stop Configure" — cancel the running configure + its tree.
  // The Configure row in the tab switches to this while one is in flight, so the
  // same control that started it stops it (as Build/Stop Build does).
  const stopConfigureCmd = vscode.commands.registerCommand("o3de.stopConfigure", async () => {
    if (!(await stopConfigure())) {
      void vscode.window.showInformationMessage("O3DE: no configure is running.");
    }
  });

  // Command: "O3DE: Build" — cmake --build for the selected target(s) + config
  // (MSVC env + process-guard), streamed to the O3DE Build Output channel.
  //
  // A toggle, like Run: a second Build while one is running is never useful (the
  // job registry refuses it), so pressing Build (or its hotkey) mid-build stops
  // it instead — the replacement for the Ctrl+C a terminal used to give. Unlike
  // Run's opt-in `run.toggleToQuit`, this is unconditional; a non-toggling Build
  // button would just sit dead for the length of a build.
  const build = vscode.commands.registerCommand("o3de.build", async () => {
    if (buildState.isBuilding) {
      await stopBuild();
    } else {
      await buildProject(buildOptions);
    }
  });

  // Command: "O3DE: Stop Build" — cancel the running build + its process tree.
  const stopBuildCmd = vscode.commands.registerCommand("o3de.stopBuild", async () => {
    if (!(await stopBuild())) {
      void vscode.window.showInformationMessage("O3DE: no build is running.");
    }
  });

  // Command: "O3DE: Run" — a toggle (setting-gated). The Editor can't run twice, so
  // with o3de.run.toggleToQuit on (default), pressing Run (or its hotkey) while an
  // app is already up instead force-quits it — one key to launch on demand and quit
  // on demand. Otherwise it launches the run target (detached, tracked for force-quit).
  const run = vscode.commands.registerCommand("o3de.run", async () => {
    const toggleToQuit = vscode.workspace
      .getConfiguration("o3de", primaryO3deFolder()?.uri)
      .get<boolean>("run.toggleToQuit", true);
    if (toggleToQuit && runState.isRunning) {
      const result = await forceCloseRuntime();
      if (!result.note) {
        void vscode.window.showInformationMessage("O3DE: force-quit the running app.");
      }
    } else {
      await runProject(buildOptions);
    }
    void runState.refresh(); // flip the toolbar (Play <-> Stop) immediately
  });

  // Command: "O3DE: Run in Debug (C++)" — launch the selected target under cppvsdbg.
  const runDebug = vscode.commands.registerCommand("o3de.runDebug", () => {
    void runInDebug(buildOptions);
  });

  // Command: "O3DE: Stop" — force-quit the running app + its process tree (or sweep orphans).
  const stop = vscode.commands.registerCommand("o3de.stopRun", async () => {
    await stopRun();
    void runState.refresh(); // flip the toolbar back to Play immediately
  });

  // Command: "O3DE: Generate C++ IntelliSense" — File API reply → <project>/.vscode/c_cpp_properties.json.
  const classWizard = vscode.commands.registerCommand("o3de.classWizard", () => {
    void launchClassWizard();
  });

  const genCpp = vscode.commands.registerCommand("o3de.generateCppProperties", () => {
    void generateCppProperties(buildOptions);
  });

  // Commands: choose the CMake generator / build config (shown in the tab, persisted).
  const selectGenerator = vscode.commands.registerCommand("o3de.selectGenerator", async () => {
    const pick = await vscode.window.showQuickPick(generatorsForPlatform(), {
      title: "O3DE: CMake Generator",
      placeHolder: `Current: ${buildOptions.generator}`,
    });
    if (pick) {
      await buildOptions.setGenerator(pick as Generator);
    }
  });
  const selectConfig = vscode.commands.registerCommand("o3de.selectConfig", async () => {
    const pick = await vscode.window.showQuickPick(BUILD_CONFIGS, {
      title: "O3DE: Build Configuration",
      placeHolder: `Current: ${buildOptions.config}`,
    });
    if (pick) {
      await buildOptions.setConfig(pick as BuildConfig);
    }
  });
  const selectCompiler = vscode.commands.registerCommand("o3de.selectCompiler", async () => {
    const pick = await vscode.window.showQuickPick(compilersForPlatform(), {
      title: "O3DE: Compiler",
      placeHolder: `Current: ${buildOptions.compiler} — switching may need a fresh Configure`,
    });
    if (pick) {
      await buildOptions.setCompiler(pick as Compiler);
    }
  });

  // Command: choose the CMake build target(s) — multi-select, File-API-sourced (shown in the tab, persisted).
  const selectTargetsCmd = vscode.commands.registerCommand("o3de.selectTargets", () => {
    void selectTargets(buildOptions);
  });

  // Commands: choose what Run launches + the launch options (shown in the tab, persisted).
  // The run-target picker discovers every executable target (File API + built exes).
  const selectRunTargetCmd = vscode.commands.registerCommand("o3de.selectRunTarget", () => {
    void selectRunTarget(buildOptions);
  });
  const setLaunchArgs = vscode.commands.registerCommand("o3de.setLaunchArgs", async () => {
    const value = await vscode.window.showInputBox({
      title: "O3DE: Launch Options",
      prompt: "Extra command-line args passed when running (blank to clear)",
      placeHolder: "+LoadLevel DefaultLevel +r_displayInfo 1",
      value: buildOptions.launchArgs,
    });
    if (value !== undefined) {
      await buildOptions.setLaunchArgs(value.trim());
    }
  });
  const setCoreCount = vscode.commands.registerCommand("o3de.setCoreCount", async () => {
    const value = await vscode.window.showInputBox({
      title: "O3DE: Core Count",
      prompt: "Parallel build jobs (cmake --build --parallel N). Blank or 0 = auto (all cores).",
      placeHolder: "e.g. 12",
      value: buildOptions.coreCount > 0 ? String(buildOptions.coreCount) : "",
      validateInput: (text) => {
        const t = text.trim();
        if (t === "") {
          return undefined; // blank clears back to auto
        }
        const n = Number(t);
        return Number.isInteger(n) && n >= 0 ? undefined : "Enter a whole number (0 = auto).";
      },
    });
    if (value !== undefined) {
      const t = value.trim();
      await buildOptions.setCoreCount(t === "" ? 0 : Number(t));
    }
  });

  // Status-bar button — persistent, clickable proof the extension is alive.
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusItem.text = "$(rocket) O3DE";
  statusItem.tooltip = "O3DE Development Tools — click to run Hello World";
  statusItem.command = "o3de.helloWorld";
  statusItem.show();

  // O3DE activity-bar tab → the single "O3DE Development Tools" webview
  // (status + Build/Run + Utilities + collapsible Configuration + Onboarding).
  const dashboardView = vscode.window.registerWebviewViewProvider(
    DashboardViewProvider.viewType,
    new DashboardViewProvider(
      runState,
      buildState,
      onboarding,
      buildOptions,
      deps,
      context.workspaceState,
      context.extensionUri,
      context.extension.packageJSON.version as string,
    ),
  );

  // Prerequisites are detected in the background so the tree paints markers
  // without spawning processes on every render; workspace changes re-render live.
  void onboarding.refresh();
  const foldersChanged = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    onboarding.notifyChanged();
    void deps.refresh(); // project/engine presence can change with the folders
    applyEnablement(); // an added/removed project can flip the enabled state
    void maybePromptEnable(); // a newly-added O3DE project may need the opt-in
  });

  // Gate the automatic machinery on the per-project opt-in: start it now when the
  // project is enabled (run-state watcher, C++ IntelliSense, MCP), else offer the
  // one-time prompt and stay dormant until accepted.
  applyEnablement();
  void maybePromptEnable();

  // Lua: remote debugger (DAP) + Editor "Open Lua Editor" handoff (vscode:// URI).
  registerLuaDebug(context);
  registerLuaHandoff(context);
  const debugLua = vscode.commands.registerCommand("o3de.debugLuaFile", (uri?: vscode.Uri) => {
    void debugLuaFile(uri);
  });

  // Lua function palette — browsable Classes / EBuses / Globals webview with a
  // docked search bar (2nd O3DE view). The search filters live in the webview,
  // so there's no filter command/context key anymore — just a refresh.
  const luaPalette = new LuaPaletteViewProvider(context.extensionUri);
  const luaPaletteView = vscode.window.registerWebviewViewProvider(LUA_PALETTE_VIEW_ID, luaPalette);
  const luaPaletteRefresh = vscode.commands.registerCommand("o3de.luaPalette.refresh", () => luaPalette.refresh());

  // Advanced view (3rd O3DE view) — extra CMake configure flags + future advanced tools.
  const advancedView = vscode.window.registerWebviewViewProvider(
    AdvancedViewProvider.viewType,
    new AdvancedViewProvider(),
  );

  // Lua IntelliSense: dump the reflected API (headless Editor) → LuaLS stubs.
  // Refresh the palette afterwards so it populates from the fresh dump.
  const genLuaIntelliSense = vscode.commands.registerCommand("o3de.generateLuaIntelliSense", async () => {
    await generateLuaIntelliSense(context, buildOptions);
    luaPalette.refresh();
    void deps.refresh(); // the reflection-dump check should now read green
  });
  const genLuaStubsFromDump = vscode.commands.registerCommand("o3de.generateLuaStubsFromDump", async () => {
    await generateLuaStubsFromDump();
    luaPalette.refresh();
    void deps.refresh();
  });

  context.subscriptions.push(
    buildOptions,
    onboarding,
    deps,
    runState,
    buildState,
    mcpServer,
    configListener,
    llmEnable,
    llmDisable,
    llmShowInfo,
    enableForProject,
    disableForProject,
    foldersChanged,
    helloWorld,
    showLog,
    openSettings,
    copyEnvReport,
    checkVs,
    openTerm,
    checkNinja,
    setupWorkspace,
    addGems,
    writeConfig,
    configure,
    stopConfigureCmd,
    build,
    stopBuildCmd,
    run,
    runDebug,
    stop,
    genCpp,
    selectGenerator,
    selectConfig,
    selectCompiler,
    classWizard,
    selectTargetsCmd,
    selectRunTargetCmd,
    setLaunchArgs,
    setCoreCount,
    showEditorLog,
    showErrorLog,
    debugLua,
    genLuaIntelliSense,
    genLuaStubsFromDump,
    luaPaletteView,
    luaPaletteRefresh,
    advancedView,
    dashboardView,
    statusItem,
  );
}

// ---- Deactivation ----------------------------------------------------------
export function deactivate(): void {
  // Disposables are cleaned up automatically via context.subscriptions.
}
