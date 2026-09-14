// ============================================================================
//  Configure jobs — background tracking so a long configure survives the MCP
//  request window (the configure counterpart of buildJobs.ts).
//
//  A first configure can download 3rd-party packages for minutes, longer than an
//  MCP client waits on one call. o3de_configure starts the job here, holds the call
//  open with progress while it can, and otherwise hands back a configureId to poll
//  with o3de_configure_status. The finished result is also written to
//  <project>/user/o3de-configure-result.json, so any other tool can read it.
//
//  Configures are serialized per project by the managed-command registry, so a
//  single latest job is tracked.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { log } from "../log";
import { firstWorkspaceProject } from "./projectResolve";
import { ConfigureResult, HeadlessConfigureParams, runConfigureHeadless } from "./configure";

export interface ConfigureJob {
  configureId: string;
  state: "running" | "done";
  startedAt: number;
  finishedAt?: number;
  params: HeadlessConfigureParams;
  result?: ConfigureResult;
  resultPath?: string; // where the finished result was written
  done: Promise<ConfigureResult>;
}

const RESULT_FILE = "o3de-configure-result.json"; // under <project>/user/
let latestJob: ConfigureJob | undefined;

// ---- Start / query ---------------------------------------------------------
/** Start a configure in the background (or return the one already running). Non-blocking. */
export function startConfigureJob(params: HeadlessConfigureParams): ConfigureJob {
  if (latestJob?.state === "running") {
    return latestJob;
  }
  const job: ConfigureJob = {
    configureId: randomUUID().slice(0, 8),
    state: "running",
    startedAt: Date.now(),
    params,
    done: runConfigureHeadless(params).then((result) => {
      job.result = result;
      job.state = "done";
      job.finishedAt = Date.now();
      job.resultPath = persistResult(result);
      log().info(`o3de_configure[${job.configureId}] ${result.summary}`);
      return result;
    }),
  };
  latestJob = job;
  return job;
}

/** The latest job, or the one matching `configureId` (undefined if it doesn't match). */
export function getConfigureJob(configureId?: string): ConfigureJob | undefined {
  if (!latestJob) {
    return undefined;
  }
  return !configureId || configureId === latestJob.configureId ? latestJob : undefined;
}

// ---- Persistence -----------------------------------------------------------
/** Write the finished result to <project>/user/o3de-configure-result.json (best effort). */
function persistResult(result: ConfigureResult): string | undefined {
  const project = firstWorkspaceProject();
  if (!project) {
    return undefined;
  }
  try {
    const dir = path.join(project.path, "user");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, RESULT_FILE);
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return file;
  } catch (err) {
    log().warn(`o3de_configure: could not write the result file: ${String(err)}`);
    return undefined;
  }
}
