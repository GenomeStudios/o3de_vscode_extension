// ============================================================================
//  Run in Debug — launch the selected run target (Editor, GameLauncher, or any
//  executable target) under VS Code's C++ debugger (cppvsdbg), from inside the
//  O3DE tooling window.
//
//  Same resolution as Run (engine-aware exe + args), but instead of spawning we
//  start a debug session so C++ breakpoints work — a one-stop "Run in Debug"
//  that configures the launch itself (no hand-edited launch.json needed).
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import { log } from "../log";
import { BuildOptions } from "./buildOptions";
import { resolveWorkspaceProject } from "./projectResolve";
import { runArgsFor } from "./runCommand";
import { buildInFlightReason, resolveRunnable } from "./run";
import { isPlatformToolsEnabled, platformDisabledMessage } from "../platform/platformSupport";

// The debugger `environment` adds/overrides — clear the VS Code-injected vars so a
// debugged Editor's own child launches (e.g. the Lua-editor handoff) aren't poisoned.
function scrubbedEnvironment(): { name: string; value: string }[] {
  return ["VSCODE_IPC_HOOK_CLI", "VSCODE_PID", "VSCODE_CWD", "VSCODE_NLS_CONFIG", "ELECTRON_RUN_AS_NODE"].map(
    (name) => ({ name, value: "" }),
  );
}

// The native C++ debug configuration for this OS: cppvsdbg on Windows, cppdbg
// (gdb) on Linux. Both take the same program/args/cwd; the launcher fields differ.
function nativeDebugConfig(name: string, program: string, args: string[], cwd: string): vscode.DebugConfiguration {
  const common = { request: "launch", name, program, args, cwd, environment: scrubbedEnvironment() };
  if (process.platform === "win32") {
    return { type: "cppvsdbg", ...common, console: "integratedTerminal" };
  }
  return {
    type: "cppdbg",
    ...common,
    MIMode: "gdb",
    externalConsole: false,
    setupCommands: [{ description: "Enable pretty-printing for gdb", text: "-enable-pretty-printing", ignoreFailures: true }],
  };
}

export async function runInDebug(options: BuildOptions): Promise<void> {
  if (!isPlatformToolsEnabled()) {
    void vscode.window.showInformationMessage(platformDisabledMessage());
    return;
  }
  const blocked = buildInFlightReason();
  if (blocked) {
    void vscode.window.showWarningMessage(`O3DE: ${blocked}`);
    return;
  }
  if (!vscode.extensions.getExtension("ms-vscode.cpptools")) {
    const pick = await vscode.window.showErrorMessage(
      "O3DE: Run in Debug needs the C/C++ extension (ms-vscode.cpptools).",
      "Install C/C++",
    );
    if (pick === "Install C/C++") {
      await vscode.commands.executeCommand("workbench.extensions.installExtension", "ms-vscode.cpptools");
    }
    return;
  }

  const project = await resolveWorkspaceProject("O3DE: Run in Debug");
  if (!project) {
    return;
  }

  const target = options.runTarget;
  const exe = resolveRunnable(project, target, options.config);

  if (!fs.existsSync(exe)) {
    const pick = await vscode.window.showErrorMessage(
      `O3DE: ${target} not built for config "${options.config}". Build it first.`,
      "Build",
    );
    if (pick === "Build") {
      await vscode.commands.executeCommand("o3de.build");
    }
    return;
  }

  const args = runArgsFor(target, project.path, options.launchArgs);
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.path));
  log().info(`Run in Debug (${target}): ${exe} ${args.join(" ")}`);

  const started = await vscode.debug.startDebugging(
    folder,
    nativeDebugConfig(`O3DE: Debug ${target}`, exe, args, project.path),
  );
  if (!started) {
    void vscode.window.showErrorMessage("O3DE: failed to start the C++ debug session (see the O3DE log).");
  }
}
