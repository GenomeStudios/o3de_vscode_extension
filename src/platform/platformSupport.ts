// ============================================================================
//  Platform support gate.
//
//  The single question the build/configure/run/debug commands ask before doing
//  anything OS-specific: "is O3DE tooling active on this platform right now?"
//    - Windows: always (MSVC + Ninja).
//    - Linux:   yes — gcc/clang + Ninja. Linux left experimental status once
//               external testing confirmed the build/run/debug loop; the
//               `o3de.linuxSupport` setting stays on as an escape hatch, so a
//               user who hits trouble can switch the paths back off per project.
//    - macOS:   not a target yet (helpers stay mac-aware where free, untested).
//  Keeping this in one place means the gate reads identically from the tab, the
//  palette, a hotkey, and the MCP tools.
// ============================================================================

import * as vscode from "vscode";

// ---- The Linux toggle ------------------------------------------------------

/** Setting key (under the `o3de` section) for the Linux support toggle. */
export const LINUX_SUPPORT_SETTING = "linuxSupport";

/** The tester-era opt-in key, still honoured so an existing choice keeps working. */
export const LEGACY_LINUX_SUPPORT_SETTING = "experimental.linuxSupport";

/** A setting's value ONLY where the user actually set one — otherwise undefined. */
function userValue(config: vscode.WorkspaceConfiguration, key: string): boolean | undefined {
  const inspected = config.inspect<boolean>(key);
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

/**
 * Whether the Linux build/run/debug paths are active (default ON — the setting
 * exists to turn them OFF). Read against a project folder (resource scope) so it
 * behaves like the other per-project gates; pass the primary O3DE folder's Uri.
 * An explicit `o3de.linuxSupport` wins; a leftover `o3de.experimental.linuxSupport`
 * from the tester builds is honoured next; otherwise Linux is on.
 */
export function isLinuxSupportEnabled(scope?: vscode.Uri): boolean {
  const config = vscode.workspace.getConfiguration("o3de", scope);
  return (
    userValue(config, LINUX_SUPPORT_SETTING) ?? userValue(config, LEGACY_LINUX_SUPPORT_SETTING) ?? true
  );
}

// ---- The gate --------------------------------------------------------------

/** Whether O3DE build/configure/run/debug are active on the current OS. */
export function isPlatformToolsEnabled(scope?: vscode.Uri): boolean {
  if (process.platform === "win32") {
    return true;
  }
  if (process.platform === "linux") {
    return isLinuxSupportEnabled(scope);
  }
  return false; // macOS / other — not supported yet
}

/** The message to show when a command runs on an OS where tooling isn't active. */
export function platformDisabledMessage(): string {
  if (process.platform === "linux") {
    return (
      "O3DE: Linux support is turned off for this project — turn “O3DE ▸ Linux Support” " +
      "back on in Settings to use build/run/debug."
    );
  }
  return "O3DE: build/run support Windows and Linux; this platform isn't supported yet.";
}
