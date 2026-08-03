// ============================================================================
//  Class Creation Wizard — launch O3DE's standalone PySide6 class-scaffolding
//  tool (engine Tools/ClassCreationWizard/ClassWizard.py) from inside VS Code.
//
//  It runs through the engine's bundled Python (python/python.cmd) and needs
//  --engine-path (the engine hosting the wizard) + --project-path (where to
//  scaffold). We resolve the project's TARGET engine (project.json `engine` →
//  manifest), then run that engine's wizard — the one it's registered against,
//  not whatever copy happens to be open in the workspace.
//
//  Runs as a managed command, NOT in a terminal. A terminal was previously held
//  open for the wizard's entire GUI lifetime, which needed two workarounds that
//  are now both gone: an `&& exit` chained onto the command to auto-close the
//  orphaned terminal (issue #15), and a cmd.exe pin via ComSpec so PowerShell
//  wouldn't choke on the quoted python.cmd path. The launcher's bootstrap output
//  goes to “O3DE Build Output” instead.
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { log } from "../log";
import { resolveProjectEngine } from "../o3de/discovery";
import { readProject } from "../o3de/identity";
import { detectProjectRoot } from "../lua/projectPaths";
import { startManagedCommand, describeResult, managedJob } from "../build/managedCommand";

const WIZARD_REL = path.join("Tools", "ClassCreationWizard", "ClassWizard.py");

function pythonLauncher(engineRoot: string): string | undefined {
  const name = process.platform === "win32" ? "python.cmd" : "python.sh";
  const candidate = path.join(engineRoot, "python", name);
  return fs.existsSync(candidate) ? candidate : undefined;
}

export async function launchClassWizard(): Promise<void> {
  const projectPath = detectProjectRoot();
  if (!projectPath) {
    void vscode.window.showErrorMessage("O3DE: open an O3DE project first — the Class Wizard scaffolds into a project.");
    return;
  }

  // Resolve the engine THIS project targets (project.json `engine` → manifest),
  // and run that engine's wizard — the one it's registered against.
  const project = readProject(projectPath);
  const engine = project ? resolveProjectEngine(project) : undefined;
  if (!engine) {
    void vscode.window.showErrorMessage(
      "O3DE: could not resolve the project's engine. Ensure project.json's \"engine\" names a registered engine " +
        "(o3de register --this-engine).",
    );
    return;
  }

  const script = path.join(engine.path, WIZARD_REL);
  const python = pythonLauncher(engine.path);
  if (!fs.existsSync(script) || !python) {
    void vscode.window.showErrorMessage(
      `O3DE: Class Creation Wizard not available in the project's engine (${engine.engineName} at ${engine.path}). ` +
        "Expected Tools/ClassCreationWizard/ClassWizard.py and a set-up python/ (run get_python).",
    );
    return;
  }

  const key = classWizardJobKey(projectPath);
  if (managedJob(key)) {
    void vscode.window.showInformationMessage("O3DE: the Class Creation Wizard is already open.");
    return;
  }

  const argv = [python, script, "--engine-path", engine.path, "--project-path", projectPath];
  const label = `Class Wizard (${engine.engineName})`;
  log().info(`Launching ${label} — output streams to “O3DE Build Output”.`);

  // shell: true ONLY because python.cmd is a batch file — Windows spawn cannot
  // execute one directly. Nothing here is user-typed, so there is no injection
  // surface. No `&& exit`, no terminal: the job clears itself when the GUI exits.
  const job = startManagedCommand({
    key,
    kind: "classWizard",
    label,
    argv,
    cwd: projectPath,
    shell: process.platform === "win32",
  });

  void job.done.then((result) => {
    log().info(describeResult(label, result));
    if (!result.cancelled && result.exitCode !== 0) {
      void vscode.window.showErrorMessage(
        `O3DE: the Class Creation Wizard exited with code ${result.exitCode ?? "?"} — see “O3DE Build Output”.`,
      );
    }
  });
}

/** The registry key for a project's Class Wizard — one wizard per project. */
export function classWizardJobKey(projectPath: string): string {
  return `classWizard:${projectPath}`;
}
