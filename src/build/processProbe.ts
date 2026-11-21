// ============================================================================
//  Process probe — is an O3DE app live? (tasklist on Windows, pgrep on Linux).
//
//  Shared by the Run/Stop toolbar poller (runState), the LLM/MCP is-running
//  tool and the o3de_run_debug already-running guard (runQuery): all ask "is
//  Editor.exe / <Project>.GameLauncher.exe up?" the SAME way Stop's force-quit
//  sweep works, so it also catches apps launched outside this session. Other
//  platforms resolve to false.
// ============================================================================

import { exec, execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

// ---- Pure matching rules ---------------------------------------------------
/**
 * True if `tasklist /FO CSV` output lists this image. The name is matched as the quoted first CSV field, so a
 * longer name cannot match it. (The default table output cuts image names at 25 characters, which hides a long
 * `<Project>.GameLauncher.exe`; CSV output is not cut.)
 */
export function tasklistListsImage(stdout: string, image: string): boolean {
  return stdout.toLowerCase().includes(`"${image.toLowerCase()}"`);
}

/**
 * The `pgrep -f` pattern for ONE executable: its full path at the START of a command line, followed by a space or
 * the end. Anchoring keeps unrelated processes that merely contain the name (a tool under an `O3DEEditor`
 * folder, a shell that is running the probe) from matching.
 */
export function exePathPattern(exePath: string): string {
  const escaped = exePath.replace(REGEX_SPECIALS, "\\$&");
  return `^${escaped}( |$)`;
}

// ---- Probes ----------------------------------------------------------------
/** True if pgrep finds a match (exit 0). No shell is used, so no wrapper process can match its own command line. */
async function pgrepMatches(pattern: string): Promise<boolean> {
  try {
    await execFileAsync("pgrep", ["-f", "--", pattern]);
    return true;
  } catch {
    return false; // exit 1 = no match; a missing pgrep also reads as "not running"
  }
}

/** True if a process with this image name is live. Windows: tasklist row; Linux: pgrep match. */
export async function isImageRunning(image: string): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execAsync(`tasklist /FI "IMAGENAME eq ${image}" /NH /FO CSV`);
      return tasklistListsImage(stdout, image);
    } catch {
      return false;
    }
  }
  if (process.platform === "linux") {
    // Linux binaries carry no .exe; match the full command line (pgrep -f) the
    // same way the force-quit sweep (pkill -f) does.
    return pgrepMatches(image.toLowerCase().endsWith(".exe") ? image.slice(0, -4) : image);
  }
  return false; // macOS / other — unsupported
}

/**
 * True if this exact executable is live. Windows: its image name (an exact match). Linux: its full path at the
 * start of a command line, so "Editor" cannot match every process that has "Editor" somewhere in its arguments.
 */
export async function isExePathRunning(exePath: string): Promise<boolean> {
  if (process.platform === "linux") {
    return pgrepMatches(exePathPattern(exePath));
  }
  return isImageRunning(path.basename(exePath));
}

/** True if ANY of the given image names is live. */
export async function anyImageRunning(images: string[]): Promise<boolean> {
  if (images.length === 0) {
    return false;
  }
  const results = await Promise.all(images.map(isImageRunning));
  return results.some(Boolean);
}
