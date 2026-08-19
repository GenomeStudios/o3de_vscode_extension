// ============================================================================
//  launch.json generator (vscode + I/O) — resolve paths, then write.
//
//  Auto-detects the Editor target by the build engine's sdk_engine flag and
//  verifies on disk (prebuilt SDK → engine bin; source-built → project build).
//  natvis + ClassWizard resolve to the workspace SOURCE engine. Folder refs use
//  the names our setup assigns, resolved live from the open workspace.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import { log } from "../log";
import { O3deProject } from "../o3de/identity";
import { resolveProjectEngine } from "../o3de/discovery";
import { BuildOptions } from "./buildOptions";
import { platformBuildDir } from "./configureCommand";
import { buildLaunchConfigurations, mergeLaunchJson, LaunchInputs } from "./launchConfig";
import { editorExeCandidates, gameLauncherExeName } from "./runCommand";
import { sourceEngineFolder, workspaceFolderForPath } from "./workspaceFolders";
import { normalizePath, replaceRoot } from "../intellisense/paths";

const NATVIS_REL = "/Code/Framework/AzCore/Platform/Common/VisualStudio/AzCore/Natvis/azcore.natvis";
const CLASSWIZARD_REL = "/Tools/ClassCreationWizard/ClassWizard.py";

// ---- Editor program: prebuilt-engine vs project-build (auto-detect) --------
//  Shares editorExeCandidates() with the Run command so both resolve the Editor
//  the same way; this file only rewrites the chosen path to a workspace-folder ref.
function resolveEditorProgram(project: O3deProject, config: string, projectRef: string): string {
  const engine = resolveProjectEngine(project);
  const candidates = editorExeCandidates(engine, project.path, config).map(normalizePath);
  const found = candidates.find((c) => fs.existsSync(c)) ?? candidates[0];

  // Prebuilt SDK engine → the engine's own Editor.exe; reference the build-engine
  // workspace folder if it's open, else keep it absolute.
  if (engine?.isSdkEngine) {
    if (!fs.existsSync(found)) {
      log().warn(`Editor.exe not found under ${engine.path} (engine not built here?); using ${found}.`);
    }
    const workspaceFolder = workspaceFolderForPath(engine.path);
    return workspaceFolder ? replaceRoot(found, engine.path, workspaceFolder.ref) : found;
  }

  // Source-built / custom / unresolved engine → the project's own built Editor,
  // rewritten to the ${workspaceFolder} ref (launch.json lives in <project>/.vscode).
  return replaceRoot(found, project.path, projectRef);
}

// ---- Write launch.json -----------------------------------------------------
export function writeLaunchConfig(project: O3deProject, options: BuildOptions): string | undefined {
  const config = options.config;
  const platform = platformBuildDir();
  const projectRef = "${workspaceFolder}";

  const source = sourceEngineFolder();
  let natvisPath: string | undefined;
  if (source) {
    // natvis is an MSVC visualizer (cppvsdbg) — only meaningful on Windows.
    if (process.platform === "win32") {
      natvisPath = source.ref + NATVIS_REL;
      if (!fs.existsSync(source.path + NATVIS_REL)) {
        log().warn(`azcore.natvis missing in source engine (${source.path + NATVIS_REL}); emitting anyway.`);
      }
    }
    if (!fs.existsSync(source.path + CLASSWIZARD_REL)) {
      log().warn(`ClassWizard.py missing in source engine (${source.path + CLASSWIZARD_REL}); emitting anyway.`);
    }
  }

  const inputs: LaunchInputs = {
    projectRef,
    editorProgram: resolveEditorProgram(project, config, projectRef),
    gameLauncherProgram: `${projectRef}/build/${platform}/bin/${config}/${gameLauncherExeName(project.projectName)}`,
    natvisPath,
    sourceEngineRef: source?.ref,
  };

  const launchPath = path.join(project.path, ".vscode", "launch.json");
  let existing: Record<string, unknown> | undefined;
  if (fs.existsSync(launchPath)) {
    const parsed = jsonc.parse(fs.readFileSync(launchPath, "utf8"), [], { allowTrailingComma: true });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  }
  const merged = mergeLaunchJson(existing, buildLaunchConfigurations(inputs));

  try {
    fs.mkdirSync(path.dirname(launchPath), { recursive: true });
    fs.writeFileSync(launchPath, `${JSON.stringify(merged, null, 4)}\n`, "utf8");
  } catch (err) {
    log().error(`Failed to write ${launchPath}: ${String(err)}`);
    return undefined;
  }
  const count = (merged["configurations"] as unknown[]).length;
  log().info(
    `launch.json written: ${launchPath} — ${count} configs; ` +
      `Editor=${inputs.editorProgram}; source engine=${source ? source.name : "(none)"}.`,
  );
  return launchPath;
}
