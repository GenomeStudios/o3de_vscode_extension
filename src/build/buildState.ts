// ============================================================================
//  Build state — is a managed command running? Drives the Build/Stop toggle.
//
//  The direct mirror of runState.ts, and deliberately SIMPLER: RunState has to
//  poll (tasklist) because an Editor can be launched outside this session, so
//  the truth lives in the OS. A build cannot — the managed-command registry is
//  in-process and authoritative — so this is a pure event source with no timer.
//
//  The Build slot shows ONE button: Build when idle, Stop Build (with a progress
//  fill) while a build runs, exactly as the Run slot flips to Stop. Configure and
//  the Class Wizard publish their own activity so their controls can reflect it
//  too. Also published as the `o3de.buildRunning` context key for menus/keybinds.
// ============================================================================

import * as vscode from "vscode";
import { JobKind, ManagedJob, onDidChangeJobs, runningJobOfKind } from "./managedCommand";
import { progressLabel, progressPercent } from "./outputStream";

const CONTEXT_KEY = "o3de.buildRunning";

// ---- Payload ---------------------------------------------------------------
/** How one running job reads in the UI. */
export interface JobActivity {
  label: string; // "Build CurvesTest"
  progress: string; // "412/1337 - 31%", or "" when the tool reports no pairs
  percent: number; // 0..100 (0 = indeterminate)
  cancelling: boolean; // Stop pressed, tree-kill in flight
  lastLine: string; // newest line shown in the output channel
}

/**
 * Every kind's current activity (a missing key means "idle"), plus which job the
 * dashboard's progress bar should follow.
 */
export interface ActivitySnapshot extends Partial<Record<JobKind, JobActivity>> {
  /**
   * The job the progress bar tracks. Build outranks Configure because a build is
   * the long one. The Class Wizard is EXCLUDED on purpose: it is a GUI that is
   * simply open, not work that progresses, so its button carries that state
   * instead of pretending to have a percentage.
   */
  bar?: JobActivity;
}

const BAR_PRIORITY: JobKind[] = ["build", "configure"];

function describe(job: ManagedJob | undefined): JobActivity | undefined {
  if (!job) {
    return undefined;
  }
  return {
    label: job.label,
    progress: progressLabel(job.progress),
    percent: progressPercent(job.progress),
    cancelling: job.cancelled,
    lastLine: job.lastLine ?? "",
  };
}

// ---- Watcher ---------------------------------------------------------------
export class BuildState {
  private readonly changed = new vscode.EventEmitter<ActivitySnapshot>();
  /** Fires whenever any managed job starts, ticks, or finishes. */
  readonly onDidChange = this.changed.event;

  private readonly sub: vscode.Disposable;
  private published: boolean | undefined; // last value of the context key

  constructor() {
    this.sub = onDidChangeJobs(() => this.publish());
  }

  /** The current snapshot (cheap — reads the registry). */
  get activity(): ActivitySnapshot {
    const snapshot: ActivitySnapshot = {};
    for (const kind of ["build", "configure", "classWizard"] as JobKind[]) {
      const activity = describe(runningJobOfKind(kind));
      if (activity) {
        snapshot[kind] = activity;
      }
    }
    for (const kind of BAR_PRIORITY) {
      if (snapshot[kind]) {
        snapshot.bar = snapshot[kind];
        break;
      }
    }
    return snapshot;
  }

  /** True while a build (not a configure / wizard) is running. */
  get isBuilding(): boolean {
    return runningJobOfKind("build") !== undefined;
  }

  private publish(): void {
    const building = this.isBuilding;
    if (building !== this.published) {
      this.published = building;
      void vscode.commands.executeCommand("setContext", CONTEXT_KEY, building);
    }
    this.changed.fire(this.activity); // progress ticks fire without a state flip
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}
