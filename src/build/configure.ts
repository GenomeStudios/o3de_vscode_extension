// ============================================================================
//  Configure — run the CMake configure for the project (build_launch B.2).
//
//  Reproduces the user's reconfigure step natively:
//    MSVC env (vcvars64) → cmake -G <generator> -S <project> -B build/<platform>
//                          -DLY_3RDPARTY_PATH=<3rd party>
//  Runs as a managed command (streamed to “O3DE Build Output”, cancellable, one
//  at a time — see managedCommand.ts), triggered by the user: configure is not
//  needed every build, only on first setup or when CMake inputs / the generator
//  change.
//
//  Before running, a CMake File API query is written so the configure emits a
//  reply (build/<platform>/.cmake/api/v1/reply). That reply is the data source
//  for C++ IntelliSense (Approach 2) and backs the generator-consistency check
//  the Build step relies on (isConfiguredFor).
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { log } from "../log";
import { commandOutput } from "./commandOutput";
import { BuildDiagnostic, diagnosticConclusion, parseBuildOutput, tailLines } from "./buildOutput";
import { readCmakeFlags } from "./configureArgs";
import { buildJobKey, configureJobKey } from "./jobKeys";
import { runManagedCommand, describeResult, cancelManagedCommand, managedJob } from "./managedCommand";
import { ensureNinja } from "./ninjaGuard";
import { resolveBuildEnvironment } from "./toolchain";
import { isPlatformToolsEnabled, platformDisabledMessage } from "../platform/platformSupport";
import { readManifest } from "../o3de/manifest";
import { O3deProject } from "../o3de/identity";
import { BuildOptions, Compiler, Generator } from "./buildOptions";
import { firstWorkspaceProject, resolveWorkspaceProject } from "./projectResolve";
import {
  buildConfigureArgs,
  formatCommand,
  parseCachedGenerator,
  projectBuildDir,
  FILE_API_REQUESTS,
} from "./configureCommand";

const FILE_API_CLIENT = "client-o3de-dev-tools";

// ---- Build-tree state (I/O) ------------------------------------------------
/** The generator a project's build tree was configured with, or undefined. */
function readCachedGenerator(buildDir: string): string | undefined {
  const cache = path.join(buildDir, "CMakeCache.txt");
  if (!fs.existsSync(cache)) {
    return undefined;
  }
  try {
    return parseCachedGenerator(fs.readFileSync(cache, "utf8"));
  } catch {
    return undefined;
  }
}

/** True when the project is configured AND with the given generator (Build's guard). */
export function isConfiguredFor(project: O3deProject, generator: string): boolean {
  return readCachedGenerator(projectBuildDir(project.path)) === generator;
}

// ---- File API query --------------------------------------------------------
/** Ask CMake to emit a File API reply for this build tree at next configure. */
function writeFileApiQuery(buildDir: string): void {
  const queryDir = path.join(buildDir, ".cmake", "api", "v1", "query", FILE_API_CLIENT);
  fs.mkdirSync(queryDir, { recursive: true });
  fs.writeFileSync(
    path.join(queryDir, "query.json"),
    `${JSON.stringify({ requests: FILE_API_REQUESTS }, null, 2)}\n`,
    "utf8",
  );
}

/** Clear only the CMake cache (not built artifacts) so a generator switch can proceed. */
function clearCmakeCache(buildDir: string): void {
  for (const entry of ["CMakeCache.txt", "CMakeFiles"]) {
    fs.rmSync(path.join(buildDir, entry), { recursive: true, force: true });
  }
  log().info(`Cleared CMake cache in ${buildDir} (generator switch).`);
}

// ---- Job identity ----------------------------------------------------------
export { configureJobKey } from "./jobKeys"; // one configure per project

/** Stop the running configure for the workspace's project. */
export async function stopConfigure(): Promise<boolean> {
  const project = await resolveWorkspaceProject("O3DE: Stop Configure");
  return project ? cancelManagedCommand(configureJobKey(project.path)) : false;
}

// ---- Headless core ---------------------------------------------------------
//  The configure itself, with no prompts: the O3DE panel's Configure command and the
//  MCP o3de_configure tool both run this. Whatever the outcome, its conclusion is printed
//  into “O3DE Build Output” before it returns.

export type ConfigureBlockedReason =
  | "unsupported-platform"
  | "no-project"
  | "busy" // a configure or a build is already running for the project
  | "no-toolchain"
  | "no-ninja"
  | "generator-mismatch"; // configured with another generator — CMake can't switch in place

export interface ConfigureResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  command: string; // the exact cmake line ("" when it never started)
  project?: string;
  generator: string;
  errors: BuildDiagnostic[];
  warnings: BuildDiagnostic[];
  summary: string;
  rawTail: string;
  cancelled?: boolean;
  blocked?: ConfigureBlockedReason;
}

export interface HeadlessConfigureParams {
  generator: Generator;
  compiler: Compiler;
  project?: O3deProject; // omitted → the first O3DE project in the workspace
  interactive?: boolean; // the panel's command: Ninja detection may show its own messages
}

const RAW_TAIL_LINES = 100;

export async function runConfigureHeadless(params: HeadlessConfigureParams): Promise<ConfigureResult> {
  const result = await runConfigure(params);
  const conclusion = result.blocked
    ? [`=== Configure not started — ${result.summary} ===`]
    : result.ok || result.cancelled
      ? []
      : diagnosticConclusion(false, result.errors, result.warnings); // the runner already printed the outcome line
  for (const line of conclusion) {
    commandOutput().appendLine(line);
  }
  return result;
}

async function runConfigure(params: HeadlessConfigureParams): Promise<ConfigureResult> {
  const blocked = (reason: ConfigureBlockedReason, summary: string, project?: O3deProject): ConfigureResult => ({
    ok: false,
    exitCode: null,
    durationMs: 0,
    command: "",
    project: project?.projectName,
    generator: params.generator,
    errors: [],
    warnings: [],
    summary,
    rawTail: "",
    blocked: reason,
  });

  if (!isPlatformToolsEnabled()) {
    return blocked("unsupported-platform", platformDisabledMessage());
  }
  const project = params.project ?? firstWorkspaceProject();
  if (!project) {
    return blocked("no-project", "No O3DE project in this workspace — run “O3DE: Set Up Workspace…” first.");
  }

  // One configure per project, and never under a running build: both write the same build tree.
  if (managedJob(configureJobKey(project.path))) {
    return blocked("busy", `A configure is already running for ${project.projectName}.`, project);
  }
  if (managedJob(buildJobKey(project.path))) {
    return blocked("busy", `A build is running for ${project.projectName} — wait for it or stop it, then configure.`, project);
  }

  const buildDir = projectBuildDir(project.path);
  const cachedGenerator = readCachedGenerator(buildDir);
  if (cachedGenerator && cachedGenerator !== params.generator) {
    return blocked(
      "generator-mismatch",
      `${path.basename(buildDir)} was configured with "${cachedGenerator}", but "${params.generator}" is selected. CMake can't ` +
        `switch generators in place: select "${cachedGenerator}" again, or run Configure from the O3DE panel, which offers to clear the CMake cache.`,
      project,
    );
  }

  // Toolchain prerequisites: the compiler environment (Windows MSVC / Linux gcc-clang) always; Ninja for the Ninja generator.
  const toolchain = await resolveBuildEnvironment(params.compiler);
  if (!toolchain.ok) {
    log().error(`Configure aborted — ${toolchain.reason}`);
    return blocked("no-toolchain", toolchain.reason ?? "Could not establish the compiler environment.", project);
  }
  if (params.generator === "Ninja Multi-Config" && !(await ensureNinja({ interactive: params.interactive === true }))) {
    log().error("Configure aborted — Ninja generator selected but Ninja is not installed.");
    return blocked("no-ninja", "The Ninja generator is selected but Ninja isn't installed.", project);
  }

  // LY_3RDPARTY_PATH from the manifest — same source as the generated settings.json.
  const manifest = readManifest();
  const thirdPartyPath = manifest?.defaultThirdPartyFolder ?? path.join(os.homedir(), ".o3de", "3rdParty");

  // Request a File API reply so this configure yields the IntelliSense data
  // layer's source (and the reply the Build step's guard reads back).
  try {
    writeFileApiQuery(buildDir);
  } catch (err) {
    log().warn(`Could not write CMake File API query: ${String(err)}`);
  }

  const argv = buildConfigureArgs({
    projectPath: project.path,
    buildDir,
    generator: params.generator,
    thirdPartyPath,
    compiler: params.compiler,
    extraCacheArgs: readCmakeFlags(project.path),
  });
  const command = formatCommand(argv);

  const label = `Configure ${project.projectName}`;
  log().info(`Configuring ${project.projectName} → ${buildDir}`);
  log().info(`  ${command} (streaming to “O3DE Build Output”)`);

  const run = await runManagedCommand({
    key: configureJobKey(project.path),
    kind: "configure",
    label,
    argv,
    cwd: project.path, // the source dir; -B creates the build tree
    env: { ...process.env, ...toolchain.env }, // Windows MSVC delta; empty on Linux
  });
  log().info(describeResult(label, run));

  const { errors, warnings } = parseBuildOutput(run.output);
  const ok = run.exitCode === 0 && !run.cancelled;
  const seconds = (run.durationMs / 1000).toFixed(1);
  return {
    ok,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    command,
    project: project.projectName,
    generator: params.generator,
    errors,
    warnings,
    summary: run.cancelled
      ? `Configure stopped by the user after ${seconds}s`
      : ok
        ? `Configure succeeded in ${seconds}s`
        : `Configure FAILED — ${errors.length} error(s), ${warnings.length} warning(s) in ${seconds}s`,
    rawTail: tailLines(run.output, RAW_TAIL_LINES),
    cancelled: run.cancelled || undefined,
  };
}

// ---- Command ---------------------------------------------------------------
/** “O3DE: Configure Project” — confirm with the user, run the headless core, report. True when it succeeded. */
export async function configureProject(options: BuildOptions): Promise<boolean> {
  if (!isPlatformToolsEnabled()) {
    void vscode.window.showInformationMessage(platformDisabledMessage());
    return false;
  }
  const project = await resolveWorkspaceProject("O3DE: Configure Project");
  if (!project) {
    return false;
  }
  if (managedJob(configureJobKey(project.path))) {
    void vscode.window.showInformationMessage("O3DE: a configure is already running for this project.");
    return false;
  }

  // The prompts live here, never in the core: a generator switch clears the cache only with consent.
  const buildDir = projectBuildDir(project.path);
  const cachedGenerator = readCachedGenerator(buildDir);
  if (cachedGenerator && cachedGenerator !== options.generator) {
    const choice = await vscode.window.showWarningMessage(
      `${path.basename(buildDir)} was configured with "${cachedGenerator}", but "${options.generator}" ` +
        "is selected. CMake cannot switch generators in place. Clear the CMake cache and configure fresh?",
      "Configure Fresh",
      "Cancel",
    );
    if (choice !== "Configure Fresh") {
      return false;
    }
    clearCmakeCache(buildDir);
  } else if (cachedGenerator) {
    const choice = await vscode.window.showInformationMessage(
      `${project.projectName} is already configured (${cachedGenerator}). Reconfigure now?`,
      "Reconfigure",
      "Cancel",
    );
    if (choice !== "Reconfigure") {
      return false;
    }
  }

  const result = await runConfigureHeadless({ generator: options.generator, compiler: options.compiler, project, interactive: true });
  if (result.blocked) {
    void vscode.window.showErrorMessage(`O3DE: ${result.summary}`);
    return false;
  }
  if (result.cancelled) {
    void vscode.window.showInformationMessage("O3DE: configure stopped.");
    return false;
  }
  if (result.ok) {
    void vscode.window.showInformationMessage(`O3DE: ${project.projectName} configured (${options.generator}).`);
    return true;
  }
  void vscode.window
    .showErrorMessage("O3DE: configure failed — see the output for details.", "Show Output")
    .then((choice) => {
      if (choice === "Show Output") {
        commandOutput().show(true);
      }
    });
  return false;
}
