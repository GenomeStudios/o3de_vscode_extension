// ============================================================================
//  Visual Studio guard — the user-facing check + alert.
//
//  Wraps the detection data layer (visualStudio.ts) with VS Code messaging:
//    - none found         -> error   + "Download Visual Studio"
//    - pinned, not found  -> error   + "Select Visual Studio Version" (strict: no silent fallback)
//    - found, no C++ tools-> warning + link (MSVC workload required)
//    - found + C++ tools  -> log; (interactive) success toast
//
//  Toasts never block the caller: they are fired and their buttons handled when
//  clicked. `quiet` (the MCP / headless paths) skips them entirely and only logs;
//  the reason travels back in the result instead.
// ============================================================================

import * as vscode from "vscode";
import { log } from "../log";
import { explainSelection, findVisualStudioInstalls, lacksCppToolsMessage, VisualStudioInstall } from "./visualStudio";
import { readVsPreference, selectInstall } from "./visualStudioPreference";

const VS_DOWNLOAD_URL = "https://visualstudio.microsoft.com/downloads/";
const DOWNLOAD_VS = "Download Visual Studio";
const OPEN_DOWNLOADS = "Open Visual Studio downloads";
const SELECT_VS = "Select Visual Studio Version";

async function openDownloads(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(VS_DOWNLOAD_URL));
}

// ---- Result ----------------------------------------------------------------
export interface VisualStudioCheck {
  /** The selected install; present even when it lacks the C++ tools (check `problem`). */
  install?: VisualStudioInstall;
  /** Why there is no usable install; undefined when the selected install is ready. */
  problem?: string;
}

export interface VisualStudioCheckOptions {
  interactive: boolean; // shows the "ready" toast
  quiet?: boolean; // log only: no toasts at all (headless callers)
}

// ---- Alerts ----------------------------------------------------------------
/** Show a toast (never awaited) and run the clicked button's action; nothing at all when quiet. */
function alert(
  options: VisualStudioCheckOptions,
  severity: "error" | "warning",
  message: string,
  buttons: Record<string, () => unknown>,
): void {
  if (options.quiet) {
    return;
  }
  const show = severity === "error" ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
  void show(message, ...Object.keys(buttons)).then((pick) => (pick ? buttons[pick]?.() : undefined));
}

// ---- Check -----------------------------------------------------------------
/**
 * Judge the detected installs against the selection (o3de.build.visualStudio): log what was found, alert unless
 * `quiet`, and say what is wrong with the pick, if anything. Never waits on an alert.
 */
export function checkInstalls(installs: VisualStudioInstall[], options: VisualStudioCheckOptions): VisualStudioCheck {
  const preference = readVsPreference();
  const chosen = selectInstall(installs); // also remembers the installs for the dashboard's Visual Studio row

  // ---- None found -> hard alert ----
  if (installs.length === 0) {
    const problem = explainSelection(preference, installs);
    log().error(problem);
    alert(
      options,
      "error",
      "O3DE Development Tools: no Visual Studio installation was found. Building O3DE on " +
        "Windows requires Visual Studio with the “Desktop development with C++” workload.",
      { [DOWNLOAD_VS]: openDownloads },
    );
    return { problem };
  }

  // ---- Report everything found ----
  for (const i of installs) {
    log().info(
      `Found: ${i.displayName} (${i.version}) @ ${i.installationPath} — ` +
        `C++ tools: ${i.hasCppTools ? "yes" : "no"}`,
    );
  }

  // ---- A pinned version that is not installed: strict, never fall back ----
  if (!chosen) {
    const problem = explainSelection(preference, installs);
    log().error(problem);
    alert(options, "error", `O3DE Development Tools: ${problem}`, {
      [SELECT_VS]: () => vscode.commands.executeCommand("o3de.selectVisualStudio"),
    });
    return { problem };
  }

  // ---- Found, but MSVC C++ toolset missing ----
  if (!chosen.hasCppTools) {
    const problem = lacksCppToolsMessage(chosen);
    log().warn(problem);
    alert(
      options,
      "warning",
      `O3DE Development Tools: ${chosen.displayName} was found, but the MSVC C++ toolset ` +
        "(“Desktop development with C++”) is not installed — required to build O3DE.",
      { [OPEN_DOWNLOADS]: openDownloads },
    );
    return { install: chosen, problem };
  }

  // ---- Ready ----
  const how = preference === "auto" ? "auto: newest" : `pinned ${preference}`;
  log().info(
    `Visual Studio ready: ${chosen.displayName} (${how}) ` +
      `(env script: ${chosen.vsDevCmdPath ?? chosen.vcvars64Path}).`,
  );
  if (options.interactive && !options.quiet) {
    void vscode.window.showInformationMessage(`O3DE: Visual Studio ready — ${chosen.displayName}.`);
  }
  return { install: chosen };
}

/** Detect the installs and judge them (Windows only; elsewhere there is nothing to check). */
export async function checkVisualStudio(options: VisualStudioCheckOptions): Promise<VisualStudioCheck> {
  if (process.platform !== "win32") {
    log().info("Visual Studio check skipped — not a Windows host.");
    return {};
  }
  return checkInstalls(await findVisualStudioInstalls(), options);
}

/**
 * Ensure a usable Visual Studio (MSVC) install exists on Windows.
 * Returns the chosen install, or undefined when none is usable.
 */
export async function ensureVisualStudio(options: VisualStudioCheckOptions): Promise<VisualStudioInstall | undefined> {
  return (await checkVisualStudio(options)).install;
}
