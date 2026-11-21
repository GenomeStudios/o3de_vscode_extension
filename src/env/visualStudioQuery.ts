// ============================================================================
//  Visual Studio status — the read-only report behind o3de_visual_studio_status.
//
//  The same answers the dashboard's Visual Studio row, the onboarding row and the
//  build give, from the same code (selectInstall): which installs exist, which one
//  the selection (o3de.build.visualStudio) picks, whether the project's build tree
//  was configured with a different one, and, on request, the environment Configure,
//  Build and the O3DE Developer terminal receive.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { firstWorkspaceProject } from "../build/projectResolve";
import { projectBuildDir, readCachedValue } from "../build/configureCommand";
import { EnvMap } from "./msvcEnvironment";
import {
  cachedCompilerMismatch,
  findVisualStudioInstalls,
  readBuildCache,
  selectionProblem,
  vsYear,
  VisualStudioInstall,
  VsPreference,
} from "./visualStudio";
import { captureSelectedMsvcEnvironment, invalidVsPreference, readVsPreference, selectInstall } from "./visualStudioPreference";

// ---- Report shape ----------------------------------------------------------
export interface VsInstallInfo {
  displayName: string;
  version: string;
  year?: string; // "2026"; undefined when the version could not be read
  installationPath: string;
  hasCppTools: boolean;
  selected: boolean;
}

export interface VisualStudioStatus {
  supported: boolean; // false off Windows
  preference: VsPreference;
  // Set when o3de.build.visualStudio holds something that is not a known selection (JSON-quoted): it reads as "auto".
  invalidSetting?: string;
  installs: VsInstallInfo[];
  selected?: VsInstallInfo; // what the selection picks right now
  problem?: string; // why the selection is not usable (not installed, no C++ tools, none found)
  // Set when VS Code itself was started from a Visual Studio developer prompt: those variables are ignored by
  // builds only while a year is pinned (with "auto" they win, because vcvars is first-wins).
  inheritedEnvironment?: { VSINSTALLDIR?: string; VCToolsVersion?: string };
  // The first workspace project's build tree: the compiler CMake cached, and whether it lies outside the selected install.
  configuredWith?: { buildDir: string; cachedCompiler?: string; mismatch: boolean };
  // Only with captureEnvironment: what a build / the Developer terminal gets.
  environment?: { VCToolsVersion?: string; VCToolsInstallDir?: string; VSINSTALLDIR?: string; clPath?: string; error?: string };
}

// ---- Report ----------------------------------------------------------------
export async function visualStudioStatus(options: { captureEnvironment?: boolean } = {}): Promise<VisualStudioStatus> {
  const preference = readVsPreference();
  if (process.platform !== "win32") {
    return { supported: false, preference, installs: [], problem: "Visual Studio selection is Windows-only." };
  }

  const installs = await findVisualStudioInstalls();
  const chosen = selectInstall(installs);
  const status: VisualStudioStatus = {
    supported: true,
    preference,
    invalidSetting: invalidVsPreference(),
    installs: installs.map((install) => describe(install, install === chosen)),
    selected: chosen ? describe(chosen, true) : undefined,
    problem: selectionProblem(preference, installs, chosen),
    inheritedEnvironment: inheritedEnvironment(),
    configuredWith: chosen ? configuredWith(chosen) : undefined,
  };
  if (options.captureEnvironment && chosen?.vcvars64Path) {
    status.environment = await captureEnvironment(chosen.vcvars64Path);
  }
  return status;
}

// ---- Parts -----------------------------------------------------------------
function describe(install: VisualStudioInstall, selected: boolean): VsInstallInfo {
  return {
    displayName: install.displayName,
    version: install.version,
    year: vsYear(install),
    installationPath: install.installationPath,
    hasCppTools: install.hasCppTools,
    selected,
  };
}

function inheritedEnvironment(): VisualStudioStatus["inheritedEnvironment"] {
  const VSINSTALLDIR = process.env["VSINSTALLDIR"];
  const VCToolsVersion = process.env["VCToolsVersion"];
  return VSINSTALLDIR || VCToolsVersion ? { VSINSTALLDIR, VCToolsVersion } : undefined;
}

/** The first workspace project's build tree: its cached compiler and whether it belongs to the selected install. */
function configuredWith(chosen: VisualStudioInstall): VisualStudioStatus["configuredWith"] {
  const project = firstWorkspaceProject();
  const buildDir = project ? projectBuildDir(project.path) : undefined;
  const cache = buildDir ? readBuildCache(buildDir) : undefined;
  if (!buildDir || cache === undefined) {
    return undefined;
  }
  return {
    buildDir,
    cachedCompiler: readCachedValue(cache, "CMAKE_CXX_COMPILER"),
    mismatch: cachedCompilerMismatch(cache, chosen.installationPath) !== undefined,
  };
}

/** The environment a build gets: the process environment with the captured MSVC delta on top. */
async function captureEnvironment(vcvars64Path: string): Promise<NonNullable<VisualStudioStatus["environment"]>> {
  let env: EnvMap;
  try {
    env = { ...(process.env as EnvMap), ...(await captureSelectedMsvcEnvironment(vcvars64Path)) };
  } catch (err) {
    return { error: `Failed to establish the MSVC environment: ${(err as Error).message ?? String(err)}` };
  }
  const get = (name: string): string | undefined => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : env[key];
  };
  const clDir = (get("Path") ?? "")
    .split(path.delimiter)
    .find((dir) => dir !== "" && fs.existsSync(path.join(dir, "cl.exe")));
  return {
    VCToolsVersion: get("VCToolsVersion"),
    VCToolsInstallDir: get("VCToolsInstallDir"),
    VSINSTALLDIR: get("VSINSTALLDIR"),
    clPath: clDir ? path.join(clDir, "cl.exe") : undefined,
  };
}
