// ============================================================================
//  Experimental feature gates.
//
//  Opt-in flags for functionality that isn't proven on the current machine yet.
//  The Linux support paths (toolchain abstraction, non-Windows build/run/debug)
//  land behind `o3de.experimental.linuxSupport` so the code can merge to main and
//  ship in normal Windows releases while staying dormant for everyone else — only
//  the testers who flip this setting activate it. Defaults OFF; becomes the
//  default (or is removed) at GA once external testing confirms the loop.
// ============================================================================

import * as vscode from "vscode";

/** Setting key (under the `o3de` section) for the experimental Linux support opt-in. */
export const LINUX_SUPPORT_SETTING = "experimental.linuxSupport";

/**
 * Whether the experimental Linux support paths are opted in (default off).
 * Read against a project folder (resource scope) so it behaves like the other
 * per-project gates; pass the primary O3DE folder's Uri when one is available.
 */
export function isLinuxSupportEnabled(scope?: vscode.Uri): boolean {
  return vscode.workspace.getConfiguration("o3de", scope).get<boolean>(LINUX_SUPPORT_SETTING, false);
}
