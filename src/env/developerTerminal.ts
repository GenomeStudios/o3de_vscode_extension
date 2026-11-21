// ============================================================================
//  O3DE Developer terminal.
//
//  A terminal with the MSVC developer environment already established — the
//  extension-native equivalent of `call vcvars64.bat` at the top of a build
//  script. Any command run here (cmake, ninja, cl) works without a manual
//  environment call.
//
//  Two ways in, one core (resolveDeveloperTerminalOptions):
//    - the "O3DE: Open Developer Terminal" command / dashboard button, and
//    - the "O3DE Developer (MSVC)" terminal profile, in the terminal dropdown
//      and in "Terminal: Select Default Profile".
//  Both get the environment of the selected Visual Studio (o3de.build.visualStudio).
//  The command opens the user's default shell with that environment applied
//  (vcvars is first-wins, so a default profile that runs its own vcvars64.bat
//  is a no-op on top of it). The profile picks its shell explicitly (ComSpec),
//  because the profile can itself BE the default and must not resolve to itself.
//  When no environment can be built, the command opens nothing (and says why);
//  the profile opens a plain shell instead, so a default profile never leaves
//  VS Code without a terminal.
// ============================================================================

import * as vscode from "vscode";
import { log } from "../log";
import { EnvMap } from "./msvcEnvironment";
import { ensureVisualStudio } from "./visualStudioGuard";
import { captureSelectedMsvcEnvironment, readVsPreference } from "./visualStudioPreference";

/** The id package.json's contributes.terminal.profiles declares. */
export const DEVELOPER_TERMINAL_PROFILE_ID = "o3de.developerTerminal";

const TERMINAL_NAME = "O3DE Developer";
const FALLBACK_TERMINAL_NAME = "O3DE Developer (no MSVC env)";

// ---- Options (pure) --------------------------------------------------------
/** The terminal for a captured environment. No shell is named: the command opens the user's default shell. */
export function developerTerminalOptions(env: EnvMap): vscode.TerminalOptions {
  return { name: TERMINAL_NAME, env };
}

// ---- Options (the shared core) ---------------------------------------------
/**
 * Everything a terminal needs to start in the selected Visual Studio's environment, or undefined when it cannot
 * (not Windows, no usable Visual Studio, vcvars failed). The user is told why, so callers just stop on undefined.
 */
export async function resolveDeveloperTerminalOptions(): Promise<vscode.TerminalOptions | undefined> {
  if (process.platform !== "win32") {
    void vscode.window.showInformationMessage(
      "The O3DE Developer terminal (MSVC environment) is Windows-only.",
    );
    return undefined;
  }

  // Locate the selected Visual Studio (o3de.build.visualStudio; alerts the user itself if none/no C++ tools).
  const vs = await ensureVisualStudio({ interactive: false });
  if (!vs?.vcvars64Path) {
    log().error("Cannot open developer terminal — no usable Visual Studio (vcvars64.bat) found.");
    if (vs?.hasCppTools) {
      // The guard stays silent for an install that has the C++ tools, so this one is ours to report.
      void vscode.window.showErrorMessage(
        `O3DE: ${vs.displayName} has no vcvars64.bat, so its Visual Studio environment cannot be established.`,
      );
    }
    return undefined;
  }

  // Establish the MSVC environment (equivalent to `call vcvars64.bat`).
  log().info(`Establishing MSVC environment from ${vs.vcvars64Path} (o3de.build.visualStudio=${readVsPreference()})`);
  let env: EnvMap;
  try {
    env = await captureSelectedMsvcEnvironment(vs.vcvars64Path);
  } catch (err) {
    const e = err as { message?: string; stderr?: string };
    log().error(`Failed to capture MSVC environment: ${e.message ?? String(err)}`);
    if (e.stderr) {
      log().error(e.stderr);
    }
    void vscode.window.showErrorMessage(
      "O3DE: failed to establish the Visual Studio environment (see the O3DE Development Tools log).",
    );
    return undefined;
  }

  log().info(`MSVC environment ready — ${vs.displayName} (${Object.keys(env).length} vars applied).`);
  return developerTerminalOptions(env);
}

// ---- Command ---------------------------------------------------------------
export async function openDeveloperTerminal(): Promise<void> {
  const options = await resolveDeveloperTerminalOptions();
  if (options) {
    vscode.window.createTerminal(options).show();
  }
}

// ---- Terminal profile ------------------------------------------------------
/**
 * What the profile starts: the resolved developer terminal in an explicit shell (ComSpec), or on Windows a plain shell
 * when none could be resolved. The shell is named because the profile can be the user's default profile, and a
 * profile that defers to "the default shell" would then point back at itself. A provider that returns nothing makes
 * VS Code open no terminal at all, which breaks every new terminal once the profile is the default (a pinned year that
 * is not installed here, the settings synced from another machine). The fallback's name says it has no MSVC
 * environment, so it is never mistaken for a working one.
 */
export function developerProfileOptions(
  resolved: vscode.TerminalOptions | undefined,
  platform: NodeJS.Platform,
  comSpec: string | undefined,
): vscode.TerminalOptions | undefined {
  const shellPath = comSpec ?? "cmd.exe";
  if (resolved) {
    return { ...resolved, shellPath };
  }
  return platform === "win32" ? { name: FALLBACK_TERMINAL_NAME, shellPath } : undefined;
}

/** The profile the terminal dropdown launches. Exported for the tests. */
export async function provideDeveloperTerminalProfile(): Promise<vscode.TerminalProfile | undefined> {
  const options = developerProfileOptions(await resolveDeveloperTerminalOptions(), process.platform, process.env["ComSpec"]);
  return options ? new vscode.TerminalProfile(options) : undefined;
}

/** Offer "O3DE Developer (MSVC)" in the terminal dropdown. Inert until the user picks it. */
export function registerDeveloperTerminalProfile(): vscode.Disposable {
  return vscode.window.registerTerminalProfileProvider(DEVELOPER_TERMINAL_PROFILE_ID, {
    provideTerminalProfile: provideDeveloperTerminalProfile,
  });
}
