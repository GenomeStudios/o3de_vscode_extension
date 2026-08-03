// ============================================================================
//  Select Run Target — the picker behind Launch Options ▸ Run Target.
//
//  Editor and GameLauncher are pinned first (they carry special exe resolution),
//  then EVERY other runnable the project can produce: executable targets from
//  the CMake File API reply (so a target is offered even before it's built) and
//  any exe actually sitting in the build output (so a freshly built tool — e.g.
//  O3DEQtControlGallery — appears even without a fresh Configure). Entries say
//  whether they're built for the current config; a "Custom executable…" row
//  covers names we can't see yet.
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { BuildOptions } from "./buildOptions";
import { resolveWorkspaceProject } from "./projectResolve";
import { fileApiReplyDir, projectBuildDir } from "./configureCommand";
import { loadExecutableTargets } from "../intellisense/fileApi";
import { orderRunTargets, runTargetExeName, gameLauncherExeName } from "./runCommand";

const CUSTOM_ITEM_LABEL = "$(edit) Custom executable…";

interface RunTargetItem extends vscode.QuickPickItem {
  target?: string; // the run-target name to persist (absent on custom / separator rows)
}

// ---- Built-exe scan ----------------------------------------------------------
/** The exe base names (no ".exe") sitting in <project>/build/<platform>/bin/<config>/. */
export function scanBuiltExes(binDir: string): string[] {
  try {
    return fs
      .readdirSync(binDir)
      .filter((name) => name.toLowerCase().endsWith(".exe"))
      .map((name) => name.slice(0, -".exe".length));
  } catch {
    return []; // no build output yet — nothing built
  }
}

// ---- Command -----------------------------------------------------------------
export async function selectRunTarget(options: BuildOptions): Promise<void> {
  const project = await resolveWorkspaceProject("O3DE: Run Target");
  if (!project) {
    return;
  }

  // Discover runnables both ways: what CMake says is buildable (File API) and
  // what's actually on disk (bin scan) — either alone misses cases (no reply
  // before the first Configure; no exe before the first build).
  const replyDir = fileApiReplyDir(project.path);
  const apiExecutables = fs.existsSync(replyDir)
    ? loadExecutableTargets(replyDir, options.config).map((t) => t.name)
    : [];
  const binDir = path.join(projectBuildDir(project.path), "bin", options.config);
  const builtExes = scanBuiltExes(binDir);
  const builtSet = new Set(builtExes.map((n) => n.toLowerCase()));

  const discovered = orderRunTargets(project.projectName, apiExecutables, builtExes, options.runTarget);

  const isBuilt = (name: string): boolean =>
    builtSet.has(name.toLowerCase()) || builtSet.has(runTargetExeName(name, project.projectName).replace(/\.exe$/i, "").toLowerCase());

  const items: RunTargetItem[] = [
    { label: "Editor", target: "Editor", description: "the O3DE Editor (engine-aware)" },
    { label: "GameLauncher", target: "GameLauncher", description: gameLauncherExeName(project.projectName) },
  ];
  if (discovered.length > 0) {
    items.push({ label: "executables", kind: vscode.QuickPickItemKind.Separator });
    for (const name of discovered) {
      items.push({
        label: name,
        target: name,
        description: isBuilt(name) ? `built · bin/${options.config}` : "not built — build it first",
      });
    }
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: CUSTOM_ITEM_LABEL });

  const pick = await vscode.window.showQuickPick(items, {
    title: "O3DE: Run Target",
    placeHolder:
      `Current: ${options.runTarget}` +
      (apiExecutables.length === 0 ? " — run Configure to list every executable target" : ""),
    matchOnDescription: true,
  });
  if (!pick) {
    return; // cancelled — leave the selection unchanged
  }

  // The "Custom executable…" row opens an input box for names we can't see yet.
  if (pick.label === CUSTOM_ITEM_LABEL) {
    const typed = await vscode.window.showInputBox({
      title: "O3DE: Custom Run Target",
      prompt: "Executable target or exe name in the project's build output",
      placeHolder: "e.g. MyTool  or  MyTool.exe",
    });
    const name = typed?.trim();
    if (name) {
      await options.setRunTarget(name);
    }
    return;
  }

  if (pick.target !== undefined) {
    await options.setRunTarget(pick.target);
  }
}
