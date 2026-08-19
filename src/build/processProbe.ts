// ============================================================================
//  Process probe — is a Windows process image live? (tasklist).
//
//  Shared by the Run/Stop toolbar poller (runState) and the LLM/MCP is-running
//  tool (runQuery): both ask "is Editor.exe / <Project>.GameLauncher.exe up?"
//  the SAME way Stop's force-quit sweep works, so it also catches apps launched
//  outside this session. Non-Windows resolves to false (Run targets Windows).
// ============================================================================

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/** True if a process with this image name is live. Windows: tasklist row; Linux: pgrep match. */
export async function isImageRunning(image: string): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execAsync(`tasklist /FI "IMAGENAME eq ${image}" /NH`);
      return stdout.toLowerCase().includes(image.toLowerCase());
    } catch {
      return false;
    }
  }
  if (process.platform === "linux") {
    // Linux binaries carry no .exe; match the full command line (pgrep -f) the
    // same way the force-quit sweep (pkill -f) does. Exit 0 = at least one match.
    const name = image.toLowerCase().endsWith(".exe") ? image.slice(0, -4) : image;
    try {
      await execAsync(`pgrep -f -- ${JSON.stringify(name)}`);
      return true;
    } catch {
      return false; // exit 1 = no match
    }
  }
  return false; // macOS / other — unsupported
}

/** True if ANY of the given image names is live. */
export async function anyImageRunning(images: string[]): Promise<boolean> {
  if (images.length === 0) {
    return false;
  }
  const results = await Promise.all(images.map(isImageRunning));
  return results.some(Boolean);
}
