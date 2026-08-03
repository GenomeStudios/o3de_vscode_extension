// ============================================================================
//  Run state — is an O3DE run target live? Drives the Run/Stop toolbar toggle.
//
//  The toolbar shows ONE button in the Run slot: Play when nothing is running,
//  Stop (force-quit) when the app is up. "Running" is detected two ways so the
//  toggle is both instant and robust:
//    - the in-memory tracked launches (runManager) — flips the moment we spawn;
//    - a process-image check (tasklist) on the run-target exes — the SAME basis
//      Stop's force-quit sweep uses, so it also catches apps launched before
//      this session (e.g. after an extension reload) and clears once they exit.
//
//  The result is published as the `o3de.appRunning` context key, which the
//  view/title menus gate on (see package.json).
// ============================================================================

import * as vscode from "vscode";
import { readProject } from "../o3de/identity";
import { gameLauncherExeName } from "./runCommand";
import { anyImageRunning } from "./processProbe";
import * as runManager from "./runManager";

const CONTEXT_KEY = "o3de.appRunning";
const POLL_MS = 3000;

// ---- Run-target image names ------------------------------------------------
/** The run-target exes for every O3DE project open in the workspace (Editor + each GameLauncher). */
function runTargetImages(): string[] {
  const images = new Set<string>(["Editor.exe"]);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const proj = readProject(folder.uri.fsPath);
    if (proj) {
      images.add(gameLauncherExeName(proj.projectName));
    }
  }
  return [...images];
}

// ---- Poller ----------------------------------------------------------------
export class RunState {
  private timer: NodeJS.Timeout | undefined;
  private current: boolean | undefined; // undefined = not yet published
  private readonly changed = new vscode.EventEmitter<boolean>();
  /** Fires with the new running state whenever it flips (the Execute row listens to toggle Run/Stop). */
  readonly onDidChange = this.changed.event;

  /**
   * @param extraImages Additional exe images to probe beyond the standard
   * Editor/GameLauncher set — the panel's CUSTOM run target (any executable
   * target), supplied live so a selection change is picked up next poll.
   */
  constructor(private readonly extraImages: () => string[] = () => []) {}

  /** Latest known state (false until first published). */
  get isRunning(): boolean {
    return this.current === true;
  }

  /** Publish the initial state and begin polling for external start/stop (idempotent). */
  start(): void {
    if (this.timer) {
      return; // already polling
    }
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  /** Stop polling (e.g. when O3DE Tools is disabled for the project). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Re-detect and republish if it changed. Call after Run / Stop for an instant flip. */
  async refresh(): Promise<void> {
    const images = [...new Set([...runTargetImages(), ...this.extraImages()])];
    const running = runManager.anyRunning() || (await anyImageRunning(images));
    if (running !== this.current) {
      this.current = running;
      await vscode.commands.executeCommand("setContext", CONTEXT_KEY, running);
      this.changed.fire(running);
    }
  }

  dispose(): void {
    this.stop();
    this.changed.dispose();
  }
}
