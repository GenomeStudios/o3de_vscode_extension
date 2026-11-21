// ============================================================================
//  O3DE runtime logs — open the Editor / Error logs from the Dashboard.
//
//  O3DE writes per-project logs under <project>/user/log/. The utility buttons
//  open Editor.log (the Editor's run log) and Error.log; if the file isn't there
//  yet (the app hasn't run), we offer to reveal the log folder instead.
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { resolveWorkspaceProject } from "./projectResolve";
import { runLogFileName } from "./runLog";

const EDITOR_LOG = runLogFileName("editor");
const ERROR_LOG = runLogFileName("error"); // lowercase, as the engine writes it (matters on Linux)

async function openLog(fileName: string, title: string): Promise<void> {
  const project = await resolveWorkspaceProject(title);
  if (!project) {
    return;
  }
  const logDir = path.join(project.path, "user", "log");
  const file = path.join(logDir, fileName);

  if (fs.existsSync(file)) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `O3DE: ${fileName} not found for ${project.projectName} — has the app run yet?`,
    "Open Log Folder",
  );
  if (choice !== "Open Log Folder") {
    return;
  }
  if (fs.existsSync(logDir)) {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(logDir));
  } else {
    void vscode.window.showInformationMessage(`O3DE: the log folder does not exist yet (${logDir}).`);
  }
}

export function openEditorLog(): Promise<void> {
  return openLog(EDITOR_LOG, "O3DE: Editor Log");
}

export function openErrorLog(): Promise<void> {
  return openLog(ERROR_LOG, "O3DE: Error Log");
}
