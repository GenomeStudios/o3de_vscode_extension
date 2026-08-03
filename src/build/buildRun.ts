// ============================================================================
//  Build core — run `cmake --build` and return a structured result.
//
//  THE single build implementation. Both callers share it:
//    - MCP `o3de_build`  -> interactive: false  (blocked preconditions come back
//      as a BuildBlockedReason for the assistant to read)
//    - the tab's Build   -> build.ts wraps this with interactive: true (blocked
//      preconditions become prompts)
//  They used to be near-duplicate code paths that diverged only in their last
//  three lines (spawn vs terminal); the terminal is gone, so there is one path.
//
//  Preconditions, in order: Windows -> not already building -> safe target names
//  -> a project -> Visual Studio -> a tree configured with this generator -> no
//  Editor/ScriptCanvas holding gem DLLs. Then the MSVC environment is captured
//  (the thing CMake Tools cannot do) and the build runs as a managed command:
//  cancellable, streamed to the O3DE Build Output channel, one at a time.
// ============================================================================

import * as vscode from "vscode";
import { log } from "../log";
import { ensureVisualStudio } from "../env/visualStudioGuard";
import { captureMsvcEnvironmentDelta } from "../env/msvcEnvironment";
import { readProject, O3deProject } from "../o3de/identity";
import { projectBuildDir, formatCommand } from "./configureCommand";
import { buildBuildArgs } from "./buildCommand";
import { isConfiguredFor, configureJobKey } from "./configure";
import { runningGuardedProcesses, guardEditorProcesses } from "./processGuard";
import { managedJob, runManagedCommand, describeResult } from "./managedCommand";
import {
  BuildBlockedReason,
  BuildResult,
  parseBuildOutput,
  summarize,
  summarizeCancelled,
  tailLines,
} from "./buildOutput";

// A build target can arrive from an LLM. There is no shell in the managed
// command path, so this is not injection defence any more — it stops a name
// that cmake would misread as a flag (e.g. a leading "-") or that is simply
// not a legal CMake target.
const SAFE_TARGET = /^[A-Za-z0-9_.+-]+$/;

const MAX_DIAGNOSTICS = 100; // cap the returned lists; rawTail still carries the full context
const RAW_TAIL_LINES = 120;

export interface HeadlessBuildParams {
  generator: string; // must match the configured tree's generator
  config: string; // profile | debug | release
  targets: string[]; // empty = build everything
  coreCount?: number; // parallel jobs; 0/undefined = auto
  /**
   * Prompt on recoverable preconditions (process-guard) instead of reporting
   * them as blocked. The tab sets this; MCP leaves it off.
   */
  interactive?: boolean;
  /**
   * The project to build. Supplied by the interactive path, which may have asked
   * the user which project; omitted by MCP, which takes the first in the
   * workspace.
   */
  project?: O3deProject;
}

/** The registry key for a project's build — one build per project. */
export function buildJobKey(projectPath: string): string {
  return `build:${projectPath}`;
}

// ---- Public entry ----------------------------------------------------------
/** Run the build for the given params, returning a structured result. */
export async function runBuildHeadless(params: HeadlessBuildParams): Promise<BuildResult> {
  const targets = params.targets ?? [];

  const blocked = (reason: BuildBlockedReason, summary: string, command = ""): BuildResult => ({
    ok: false,
    exitCode: null,
    durationMs: 0,
    command,
    targets,
    config: params.config,
    errors: [],
    warnings: [],
    summary,
    rawTail: "",
    blocked: reason,
  });

  if (process.platform !== "win32") {
    return blocked("not-windows", "Build currently targets Windows (MSVC).");
  }

  const bad = targets.filter((t) => !SAFE_TARGET.test(t));
  if (bad.length > 0) {
    return blocked("invalid-targets", `Rejected unsafe target name(s): ${bad.join(", ")}.`);
  }

  const project = params.project ?? resolveProjectHeadless();
  if (!project) {
    return blocked("no-project", "No O3DE project in this workspace — run “O3DE: Set Up Workspace…” first.");
  }

  // One build per project. The managed registry is the single source of truth,
  // so the tab and MCP agree about what "busy" means.
  if (managedJob(buildJobKey(project.path))) {
    return blocked("busy", "A build is already running — wait for it to finish, then retry.");
  }

  // A configure is rewriting CMakeCache.txt and the generator files this build
  // would read. Building into that is how you get a half-generated tree.
  if (managedJob(configureJobKey(project.path))) {
    return blocked("busy", "A configure is running — wait for it to finish, then build.");
  }

  const vs = await ensureVisualStudio({ interactive: false });
  if (!vs?.vcvars64Path) {
    return blocked("no-msvc", "No usable Visual Studio (MSVC) — vcvars64.bat not found.");
  }

  if (!isConfiguredFor(project, params.generator)) {
    return blocked(
      "not-configured",
      `${project.projectName} isn't configured for "${params.generator}". Run “O3DE: Configure Project” first.`,
    );
  }

  // Process-guard: a running Editor/ScriptCanvas locks gem DLLs -> the link step
  // fails mid-build. Interactively we offer to close them; headlessly we report.
  if (params.interactive) {
    if (!(await guardEditorProcesses())) {
      return blocked("editor-running", "Build cancelled by the process-guard.");
    }
  } else {
    const running = await runningGuardedProcesses();
    if (running.length > 0) {
      const verb = running.length > 1 ? "are" : "is";
      return blocked(
        "editor-running",
        `${running.join(" and ")} ${verb} running — O3DE gem DLLs are locked and the link step will fail. ` +
          "Stop the app before building.",
      );
    }
  }

  const buildDir = projectBuildDir(project.path);
  const argv = buildBuildArgs({ buildDir, config: params.config, targets, coreCount: params.coreCount });
  const command = formatCommand(argv);

  let env: Record<string, string>;
  try {
    env = await captureMsvcEnvironmentDelta(vs.vcvars64Path);
  } catch (err) {
    const message = (err as { message?: string }).message ?? String(err);
    return blocked("env-failed", `Failed to establish the MSVC environment: ${message}`, command);
  }

  const label = `Build ${project.projectName}`;
  log().info(`${label} — targets=[${targets.join(", ") || "all"}], config=${params.config}`);
  log().info(`  ${command} (streaming to “O3DE Build Output”)`);

  const result = await runManagedCommand({
    key: buildJobKey(project.path),
    kind: "build",
    label,
    argv,
    cwd: buildDir,
    env: { ...process.env, ...env },
  });

  log().info(describeResult(label, result));

  const { errors, warnings } = parseBuildOutput(result.output);
  const ok = result.exitCode === 0 && !result.cancelled;
  return {
    ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    command,
    targets,
    config: params.config,
    errors: errors.slice(0, MAX_DIAGNOSTICS),
    warnings: warnings.slice(0, MAX_DIAGNOSTICS),
    summary: result.cancelled
      ? summarizeCancelled(result.durationMs)
      : summarize(ok, errors.length, warnings.length, result.durationMs),
    rawTail: tailLines(result.output, RAW_TAIL_LINES),
    cancelled: result.cancelled || undefined,
  };
}

// ---- Internals -------------------------------------------------------------
/** The single O3DE project in the workspace (first one if several); no prompt. */
function resolveProjectHeadless(): O3deProject | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const project = readProject(folder.uri.fsPath);
    if (project) {
      return project;
    }
  }
  return undefined;
}
