// ============================================================================
//  Build jobs — async tracking so long builds survive the MCP request window.
//
//  A full (non-incremental) engine build outlasts an MCP client's per-call
//  timeout, so a synchronous o3de_build can't return its result — the call dies
//  first even on success. This layer runs the build in the BACKGROUND and hands
//  back a handle: o3de_build waits a short grace period (fast incrementals return
//  inline), otherwise returns a buildId to poll via o3de_build_status /
//  o3de_build_log. The finished result is also persisted to a known file so
//  diagnostics survive a timed-out call or an extension reload.
//
//  Builds are serialized (one at a time) by the managed-command registry, so we
//  track a single latest job.
//
//  BOTH entry points register here — MCP `o3de_build` and the tab's Build button
//  (build.ts). That is deliberate: it means an assistant asking o3de_build_status
//  / o3de_build_log sees the build the USER just started, not only its own.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { log } from "../log";
import { readProject } from "../o3de/identity";
import { BuildResult } from "./buildOutput";
import { HeadlessBuildParams, runBuildHeadless } from "./buildRun";

export interface BuildJob {
  buildId: string;
  state: "running" | "done";
  startedAt: number;
  finishedAt?: number;
  params: HeadlessBuildParams;
  result?: BuildResult;
  resultPath?: string; // where the finished result was persisted
  /** Resolves with the finished result — how the interactive caller awaits it. */
  done: Promise<BuildResult>;
}

const RESULT_FILE = "o3de-build-result.json"; // under <project>/user/
let latestJob: BuildJob | undefined;

// ---- Start / query ---------------------------------------------------------
/** Kick off a build in the background (or return the in-flight one). Non-blocking. */
export function startBuildJob(params: HeadlessBuildParams): BuildJob {
  if (latestJob?.state === "running") {
    return latestJob; // one build at a time — hand back the running job
  }
  let settle!: (result: BuildResult) => void;
  const done = new Promise<BuildResult>((resolve) => {
    settle = resolve;
  });

  const job: BuildJob = {
    buildId: randomUUID().slice(0, 8),
    state: "running",
    startedAt: Date.now(),
    params,
    done,
  };
  latestJob = job;

  void runBuildHeadless(params).then((result) => {
    job.result = result;
    job.state = "done";
    job.finishedAt = Date.now();
    job.resultPath = persistResult(result);
    log().info(`o3de_build[${job.buildId}] ${result.summary}`);
    settle(result);
  });
  return job;
}

/** The latest job, or the one matching `buildId` (undefined if it doesn't match). */
export function getBuildJob(buildId?: string): BuildJob | undefined {
  if (!latestJob) {
    return undefined;
  }
  return !buildId || buildId === latestJob.buildId ? latestJob : undefined;
}

/** Resolve when the job finishes or `timeoutMs` elapses (→ result, or undefined if still running). */
export function awaitBuildJob(job: BuildJob, timeoutMs: number): Promise<BuildResult | undefined> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = (): void => {
      if (job.state === "done") {
        resolve(job.result);
      } else if (Date.now() - start >= timeoutMs) {
        resolve(undefined);
      } else {
        setTimeout(tick, 400);
      }
    };
    tick();
  });
}

// ---- Persistence -----------------------------------------------------------
/** Write the finished result to <project>/user/o3de-build-result.json (best effort). */
function persistResult(result: BuildResult): string | undefined {
  const project = firstProjectPath();
  if (!project) {
    return undefined;
  }
  try {
    const dir = path.join(project, "user");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, RESULT_FILE);
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return file;
  } catch (err) {
    log().warn(`o3de_build: could not persist result: ${String(err)}`);
    return undefined;
  }
}

function firstProjectPath(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (readProject(folder.uri.fsPath)) {
      return folder.uri.fsPath;
    }
  }
  return undefined;
}
