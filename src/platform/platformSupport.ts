// ============================================================================
//  Platform support gate.
//
//  The single question the build/configure/run/debug commands ask before doing
//  anything OS-specific: "is O3DE tooling active on this platform right now?"
//    - Windows: always (the original, proven path).
//    - Linux:   only when the user opts into the experimental flag — so the Linux
//               paths ship dormant and light up for testers, not everyone.
//    - macOS:   not a target yet (helpers stay mac-aware where free, untested).
//  Keeping this in one place means the gate reads identically from the tab, the
//  palette, a hotkey, and the MCP tools.
// ============================================================================

import * as vscode from "vscode";
import { isLinuxSupportEnabled } from "./experimental";

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
      "O3DE: Linux support is experimental — turn on “O3DE ▸ Experimental: Linux Support” " +
      "in Settings to use build/run/debug on Linux."
    );
  }
  return "O3DE: build/run currently target Windows and Linux.";
}
