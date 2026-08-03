// ============================================================================
//  Environment Report — a copy-to-clipboard diagnostic snapshot.
//
//  The remote-testing enabler: because Linux behaviour is proven by colleagues on
//  machines the developer can't see, "it didn't work" has to travel as a
//  structured, self-diagnosing report. This command gathers everything that
//  usually explains a failure — OS/distro, the whole toolchain detector matrix,
//  the resolved engine/project, the current build selections, and the resolved
//  exe paths (with exists? markers) — and drops it on the clipboard as Markdown a
//  tester pastes into an issue or Slack. It also tees to the O3DE log.
//
//  Cross-platform by design: it runs (and is useful) on Windows too, which is how
//  the developer verifies it without a Linux box.
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import { CHECKS, appliesToPlatform } from "../deps/registry";
import { DependencyStatus } from "../deps/dependencyStatus";
import { BuildOptions } from "../build/buildOptions";
import { firstWorkspaceProject } from "../build/projectResolve";
import { discoverEngines, resolveProjectEngine } from "../o3de/discovery";
import { projectBuildDir, fileApiReplyDir, platformBuildDir } from "../build/configureCommand";
import { resolveRunnable } from "../build/run";
import { readManifest } from "../o3de/manifest";
import { primaryO3deFolder, enableStateForFolder } from "../workspace/projectScope";
import { isLinuxSupportEnabled } from "./experimental";
import { log } from "../log";

// ---- Small formatting helpers ----------------------------------------------

/** "yes" / "no" existence marker for a resolved path. */
function existsMark(p: string): string {
  return fs.existsSync(p) ? "exists" : "MISSING";
}

/** A Markdown table row, pipe-escaped. */
function row(cells: string[]): string {
  return `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
}

/** Linux pretty distro name from /etc/os-release, or undefined off Linux / when absent. */
function linuxDistro(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const text = fs.readFileSync("/etc/os-release", "utf8");
    const match = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

// ---- Report sections -------------------------------------------------------

function sectionHeader(extensionVersion: string): string[] {
  const distro = linuxDistro();
  const lines = [
    "# O3DE Development Tools — Environment Report",
    "",
    row(["Field", "Value"]),
    row(["---", "---"]),
    row(["Extension version", extensionVersion]),
    row(["VS Code", `${vscode.env.appName} ${vscode.version}`]),
    row(["URI scheme", vscode.env.uriScheme]),
    row(["Platform / arch", `${process.platform} / ${process.arch}`]),
    row(["OS release", `${os.type()} ${os.release()}`]),
  ];
  if (distro) {
    lines.push(row(["Linux distro", distro]));
  }
  lines.push(row(["Experimental Linux support", isLinuxSupportEnabled(primaryO3deFolder()?.uri) ? "ON" : "off"]));
  return lines;
}

function sectionToolchain(deps: DependencyStatus): string[] {
  const lines = ["", "## Toolchain & dependencies (detectors)", "", row(["Check", "State", "Detail"]), row(["---", "---", "---"])];
  for (const check of CHECKS.filter((c) => appliesToPlatform(c))) {
    const result = deps.resultFor(check.id);
    lines.push(row([check.label, result?.state ?? "unknown", result?.detail ?? ""]));
  }
  return lines;
}

function sectionEngineProject(): string[] {
  const lines = ["", "## Engine & project", ""];

  const thirdParty = readManifest()?.defaultThirdPartyFolder;
  lines.push(row(["Field", "Value"]), row(["---", "---"]));
  lines.push(row(["3rd-party path", thirdParty ? `${thirdParty} (${existsMark(thirdParty)})` : "(none in manifest)"]));

  const engines = discoverEngines();
  lines.push(row(["Registered engines", engines.length ? String(engines.length) : "none"]));
  for (const engine of engines) {
    lines.push(row([`- ${engine.engineName}`, `${engine.isSdkEngine ? "SDK/prebuilt" : "source"} — ${engine.path}`]));
  }

  const project = firstWorkspaceProject();
  if (!project) {
    lines.push(row(["Workspace project", "none open"]));
    return lines;
  }
  const targetEngine = resolveProjectEngine(project);
  const folder = primaryO3deFolder();
  lines.push(
    row(["Workspace project", `${project.projectName} — ${project.path}`]),
    row(["Project engine ref", project.engine ?? "(unset)"]),
    row(["Resolved target engine", targetEngine ? `${targetEngine.engineName} (${targetEngine.isSdkEngine ? "SDK" : "source"})` : "UNRESOLVED"]),
    row(["RemoteTools gem", project.gemNames.includes("RemoteTools") ? "enabled" : "not enabled"]),
    row(["O3DE Tools enabled", folder ? enableStateForFolder(folder) : "unknown"]),
  );
  return lines;
}

function sectionBuildSelections(options: BuildOptions): string[] {
  const lines = ["", "## Build selections & resolved paths", "", row(["Field", "Value"]), row(["---", "---"])];
  lines.push(
    row(["Generator", options.generator]),
    row(["Compiler", options.compiler]),
    row(["Config", options.config]),
    row(["Targets", options.targets.length ? options.targets.join(", ") : "(all)"]),
    row(["Core count", options.coreCount > 0 ? String(options.coreCount) : "auto"]),
    row(["Run target", options.runTarget]),
    row(["Launch options", options.launchArgs || "(none)"]),
    row(["platformBuildDir()", platformBuildDir()]),
  );

  const project = firstWorkspaceProject();
  if (!project) {
    return lines;
  }
  const buildDir = projectBuildDir(project.path);
  const replyDir = fileApiReplyDir(project.path);
  const editorExe = resolveRunnable(project, "Editor", options.config);
  const launcherExe = resolveRunnable(project, "GameLauncher", options.config);
  lines.push(
    row(["Build dir", `${buildDir} (${existsMark(buildDir)})`]),
    row(["File API reply", `${replyDir} (${existsMark(replyDir)})`]),
    row(["Resolved Editor exe", `${editorExe} (${existsMark(editorExe)})`]),
    row(["Resolved GameLauncher exe", `${launcherExe} (${existsMark(launcherExe)})`]),
  );
  return lines;
}

function sectionFooter(): string[] {
  return [
    "",
    "---",
    "_Also paste the **O3DE Development Tools** Output channel (View ▸ Output ▸ O3DE Development Tools)",
    "if you're reporting a failure — it carries the command output this snapshot doesn't._",
  ];
}

// ---- Report assembly -------------------------------------------------------

/** Build the full Markdown report from the current workspace + detector state. */
export function buildEnvironmentReport(deps: DependencyStatus, options: BuildOptions, extensionVersion: string): string {
  return [
    ...sectionHeader(extensionVersion),
    ...sectionToolchain(deps),
    ...sectionEngineProject(),
    ...sectionBuildSelections(options),
    ...sectionFooter(),
  ].join("\n");
}

// ---- Command ---------------------------------------------------------------

/** "O3DE: Copy Environment Report" — refresh detectors, build the report, copy + log it. */
export async function copyEnvironmentReport(
  deps: DependencyStatus,
  options: BuildOptions,
  extensionVersion: string,
): Promise<void> {
  await deps.refresh(); // freshest detector state for the snapshot
  const report = buildEnvironmentReport(deps, options, extensionVersion);

  await vscode.env.clipboard.writeText(report);
  log().info(`Environment report:\n${report}`);
  log().show(true);
  void vscode.window.showInformationMessage(
    "O3DE: environment report copied to the clipboard — paste it into your issue or Slack.",
  );
}
