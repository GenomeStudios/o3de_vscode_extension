// ============================================================================
//  Project config writer — materialize <project>/.vscode from detection.
//
//  `writeProjectSettings` is the reusable core (settings.json; used by both the
//  standalone command and the setup wizard). Values come from detection (3rd-party
//  path from the Advanced tab's LY_3RDPARTY_PATH, else the manifest; parallel jobs
//  from CPU count, platform) + the current BuildOptions (generator / config).
//  Existing settings are merged JSONC-tolerantly so user config is never clobbered.
//
//  The COMMAND (writeProjectConfig) also emits launch.json (O3DE debug/run targets)
//  and deploys the O3DE code snippets — one action to wire up the whole workspace.
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import { log } from "../log";
import { O3deProject } from "../o3de/identity";
import { readManifest } from "../o3de/manifest";
import { buildProjectSettings, mergeSettings } from "./vscodeConfig";
import { BuildOptions } from "./buildOptions";
import { normalizeCmakeFlags, readCmakeFlags } from "./configureArgs";
import { platformBuildDir, resolveThirdPartyPath } from "./configureCommand";
import { resolveWorkspaceProject } from "./projectResolve";
import { writeLaunchConfig } from "./launchGenerate";
import { writeSnippetsIfAbsent } from "./snippets";

// ---- Core: write <project>/.vscode/settings.json (reusable) ----------------
/** Returns the settings.json path on success, or undefined if not written. */
export async function writeProjectSettings(
  project: O3deProject,
  options: BuildOptions,
): Promise<string | undefined> {
  const vscodeDir = path.join(project.path, ".vscode");
  const settingsPath = path.join(vscodeDir, "settings.json");

  // Read existing settings JSONC-tolerantly so we never clobber user config.
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    const errors: jsonc.ParseError[] = [];
    const parsed = jsonc.parse(fs.readFileSync(settingsPath, "utf8"), errors, {
      allowTrailingComma: true,
    });
    if (parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
      void vscode.window.showErrorMessage(
        `Could not parse ${settingsPath}; leaving it untouched. Fix it and retry.`,
      );
      return undefined;
    }
    existing = parsed as Record<string, unknown>;
  }

  // The 3rd-party path Configure will use: an Advanced-tab LY_3RDPARTY_PATH wins over the manifest default.
  // The project's own settings.json is read directly too, since a project that isn't an open workspace
  // folder yet (the setup wizard) isn't visible to readCmakeFlags.
  const flags = {
    ...normalizeCmakeFlags(existing["o3de.cmake.configureArgs"]),
    ...readCmakeFlags(project.path),
  };
  const thirdParty = resolveThirdPartyPath(readManifest()?.defaultThirdPartyFolder, flags, os.homedir());

  const generated = buildProjectSettings({
    generator: options.generator,
    thirdPartyPath: thirdParty.path,
    parallelJobs: os.cpus().length,
    platformBuildDir: platformBuildDir(),
    defaultConfig: options.config,
  });

  const merged = mergeSettings(existing, generated);
  try {
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(merged, null, 4)}\n`, "utf8");
  } catch (err) {
    log().error(`Failed to write ${settingsPath}: ${String(err)}`);
    void vscode.window.showErrorMessage("O3DE: failed to write .vscode/settings.json (see the O3DE log).");
    return undefined;
  }

  log().info(
    `Wrote ${settingsPath} — generator=${options.generator}, config=${options.config}, ` +
      `3rdParty=${thirdParty.path} (${thirdParty.source}), jobs=${os.cpus().length}, IntelliSense=configurationProvider.`,
  );
  return settingsPath;
}

// ---- Command: resolve project, then write settings + launch + snippets -----
export async function writeProjectConfig(options: BuildOptions): Promise<void> {
  const project = await resolveWorkspaceProject("O3DE: Write Project Config");
  if (!project) {
    return;
  }
  const settingsPath = await writeProjectSettings(project, options);
  if (!settingsPath) {
    return; // writeProjectSettings already surfaced the error
  }
  const launchPath = writeLaunchConfig(project, options);
  const snippetsWritten = writeSnippetsIfAbsent(project.path);

  const parts = ["settings.json"];
  if (launchPath) {
    parts.push("launch.json");
  }
  if (snippetsWritten) {
    parts.push("snippets");
  }
  void vscode.window.showInformationMessage(
    `O3DE: wrote ${project.projectName}/.vscode — ${parts.join(" + ")}.`,
  );
}
