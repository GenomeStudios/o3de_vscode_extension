// ============================================================================
//  Process-guard — the #1 O3DE build failure (locked gem DLLs).
//
//  A running Editor.exe / ScriptCanvasApplication.exe holds the project's gem
//  DLLs open, so the link step fails mid-build. The user's .bats warn (and one
//  kills) before building; we replicate that as a native, modal pre-flight so
//  the Build command doesn't fail halfway through a link.
// ============================================================================

import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import { log } from "../log";
import { tasklistListsImage } from "./processProbe";

const execAsync = promisify(exec);

/** Processes that lock gem DLLs during an O3DE link (mirrors the user's build .bats). */
const GUARDED_PROCESSES = ["Editor.exe", "ScriptCanvasApplication.exe"];

// ---- Windows process probing -----------------------------------------------
/**
 * The guarded images listed in `tasklist /FO CSV` output. CSV keeps full image names; the default table cuts them
 * at 25 characters, which hid the 27-character ScriptCanvasApplication.exe.
 */
export function guardedImagesListed(stdout: string): string[] {
  return GUARDED_PROCESSES.filter((image) => tasklistListsImage(stdout, image));
}

async function killProcess(imageName: string): Promise<void> {
  try {
    await execAsync(`taskkill /F /IM ${imageName}`);
    log().info(`Process-guard: closed ${imageName}.`);
  } catch (err) {
    log().warn(`Process-guard: failed to close ${imageName}: ${String(err)}`);
  }
}

// ---- Detection (non-interactive) -------------------------------------------
/** The guarded processes (Editor/ScriptCanvas) currently running. Empty on non-Windows. */
export async function runningGuardedProcesses(): Promise<string[]> {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    const { stdout } = await execAsync("tasklist /NH /FO CSV");
    return guardedImagesListed(stdout);
  } catch {
    return []; // tasklist unavailable → don't block the build
  }
}

// ---- Guard -----------------------------------------------------------------
/** Returns true to proceed with the build, false to cancel. Non-Windows always proceeds. */
export async function guardEditorProcesses(): Promise<boolean> {
  if (process.platform !== "win32") {
    return true;
  }

  const running = await runningGuardedProcesses();
  if (running.length === 0) {
    return true;
  }

  const verb = running.length > 1 ? "are" : "is";
  const choice = await vscode.window.showWarningMessage(
    `${running.join(" and ")} ${verb} running. O3DE gem DLLs may be locked during the link step and ` +
      "the build can fail. Close before building?",
    { modal: true },
    "Close & Build",
    "Build Anyway",
  );

  if (choice === "Close & Build") {
    for (const image of running) {
      await killProcess(image);
    }
    return true;
  }
  return choice === "Build Anyway"; // dismissed → cancel the build
}
