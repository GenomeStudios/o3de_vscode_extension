// ============================================================================
//  Onboarding status — the completion model behind the "Onboarding" section.
//
//  Onboarding is the one-time startup work: install the prerequisites (Visual
//  Studio + Ninja) and set up the workspace (an O3DE project + at least one
//  engine source). This module answers "is each of those done?" so the tree can
//  paint a green/red marker and auto-collapse the section once everything's set.
//
//  Two kinds of checks:
//    - Workspace (project / engine source)  — SYNC, read live from the open folders.
//    - Prerequisites (Visual Studio / Ninja) — ASYNC (spawns processes), so the
//      last result is CACHED in workspaceState and rendered synchronously; a
//      background refresh() updates the cache and fires onDidChange.
// ============================================================================

import * as vscode from "vscode";
import { findVisualStudioInstalls } from "../env/visualStudio";
import { describeVsSelection, selectInstall } from "../env/visualStudioPreference";
import { findNinja } from "../build/ninja";
import { readProject, readEngine } from "../o3de/identity";

const KEY_VS = "o3de.onboarding.visualStudio";
const KEY_NINJA = "o3de.onboarding.ninja";

export class OnboardingStatus {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when a cached prerequisite result changes (the view listens to refresh). */
  readonly onDidChange = this.changed.event;

  private vs: boolean;
  private ninja: boolean;

  constructor(private readonly state: vscode.Memento) {
    this.vs = state.get<boolean>(KEY_VS) ?? false;
    this.ninja = state.get<boolean>(KEY_NINJA) ?? false;
  }

  // ---- Workspace checks (sync, live from the open folders) -----------------
  /** True when a folder with a project.json is open. */
  get hasProject(): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((f) => readProject(f.uri.fsPath) !== undefined);
  }

  /** True when a folder with an engine.json (a source engine) is open. */
  get hasEngineSource(): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((f) => readEngine(f.uri.fsPath) !== undefined);
  }

  // ---- Prerequisite checks (cached; refreshed in the background) -----------
  get hasVisualStudio(): boolean {
    return this.vs;
  }

  get hasNinja(): boolean {
    return this.ninja;
  }

  /**
   * Hook for the "update available" (yellow) state — e.g. an installed-but-outdated Ninja.
   * Live detection needs a winget-upgrade poll (slow / network), so this is a stub for now:
   * flip it (cache a workspaceState flag + set it from refresh()) to light the yellow path.
   */
  get ninjaUpdateAvailable(): boolean {
    return false;
  }

  // ---- Roll-ups ------------------------------------------------------------
  get prerequisitesComplete(): boolean {
    return this.vs && this.ninja;
  }

  get workspaceComplete(): boolean {
    return this.hasProject && this.hasEngineSource;
  }

  get complete(): boolean {
    return this.prerequisitesComplete && this.workspaceComplete;
  }

  /** How many of the four onboarding checks are still outstanding (0 = complete). */
  get pendingCount(): number {
    return [this.hasVisualStudio, this.hasNinja, this.hasProject, this.hasEngineSource].filter(
      (done) => !done,
    ).length;
  }

  // ---- Refresh (re-detect the prerequisites, update the cache) -------------
  /** Silently re-detect Visual Studio + Ninja; fires onDidChange only if something changed. */
  async refresh(): Promise<void> {
    const shown = describeVsSelection();
    const best = selectInstall(await findVisualStudioInstalls()); // the install o3de.build.visualStudio selects
    const vs = best !== undefined && best.hasCppTools;
    const ninja = (await findNinja()) !== undefined;

    // The dashboard's Visual Studio row reads what detection last saw, so a new answer repaints it too.
    let dirty = describeVsSelection() !== shown;
    if (vs !== this.vs) {
      this.vs = vs;
      await this.state.update(KEY_VS, vs);
      dirty = true;
    }
    if (ninja !== this.ninja) {
      this.ninja = ninja;
      await this.state.update(KEY_NINJA, ninja);
      dirty = true;
    }
    if (dirty) {
      this.changed.fire();
    }
  }

  /** Force a view refresh (e.g. after the workspace folders change). */
  notifyChanged(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
