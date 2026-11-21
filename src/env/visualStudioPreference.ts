// ============================================================================
//  Visual Studio selection — the vscode-side seam.
//
//  `o3de.build.visualStudio` ("auto" or a year) says which Visual Studio's MSVC
//  environment Configure, Build, the O3DE Developer terminal and the onboarding
//  row use. Every consumer reads the pick through selectInstall(), so there is
//  exactly one place the rule is applied (the pure rules live in visualStudio.ts).
// ============================================================================

import * as vscode from "vscode";
import { log } from "../log";
import { primaryO3deFolder } from "../workspace/projectScope";
import { captureMsvcEnvironmentDelta, EnvMap } from "./msvcEnvironment";
import {
  isVsPreference,
  pickInstall,
  VisualStudioInstall,
  VsPreference,
} from "./visualStudio";

const SECTION = "o3de";
const SETTING = "build.visualStudio";

// ---- Read ------------------------------------------------------------------
// readVsPreference runs many times per build and per render: warn once per bad value, again after a good one.
let lastWarnedInvalid: string | undefined;

function readSetting(): unknown {
  return vscode.workspace.getConfiguration(SECTION, primaryO3deFolder()?.uri).get<unknown>(SETTING, "auto");
}

function warnInvalidOnce(shown: string): void {
  if (shown === lastWarnedInvalid) {
    return;
  }
  lastWarnedInvalid = shown;
  log().warn(
    `o3de.build.visualStudio is ${shown}, which is not "auto", "2019", "2022" or "2026": ignoring it and using ` +
      "auto (the newest Visual Studio).",
  );
}

/**
 * The selection, validated: anything that is not a known value reads as "auto" (the newest Visual Studio), and the
 * log says so, because a mistyped pin would otherwise behave like no pin at all.
 */
export function readVsPreference(): VsPreference {
  const value = readSetting();
  if (isVsPreference(value)) {
    lastWarnedInvalid = undefined;
    return value;
  }
  warnInvalidOnce(JSON.stringify(value));
  return "auto";
}

/** The stored value, JSON-quoted so 2022 and "2022" differ, when it is set but not a known selection. */
export function invalidVsPreference(): string | undefined {
  const value = readSetting();
  return isVsPreference(value) ? undefined : JSON.stringify(value);
}

/** "folder" or "workspace" when such a value is set: it wins over the user setting this extension writes. */
export function vsPreferenceOverride(): "workspace" | "folder" | undefined {
  const inspected = vscode.workspace.getConfiguration(SECTION, primaryO3deFolder()?.uri).inspect<string>(SETTING);
  if (inspected?.workspaceFolderValue !== undefined) {
    return "folder";
  }
  return inspected?.workspaceValue !== undefined ? "workspace" : undefined;
}

// ---- Write -----------------------------------------------------------------
export interface VsPreferenceWrite {
  /** The value in force after the write (a workspace or folder value can still win). */
  effective: VsPreference;
  /** Set when a workspace or folder value overrides the one just written. */
  overriddenBy?: "workspace" | "folder";
}

/**
 * Save the selection to the USER settings: which Visual Studios are installed is a fact about this machine,
 * so it never goes into the repo's .vscode/settings.json.
 */
export async function writeVsPreference(value: VsPreference): Promise<VsPreferenceWrite> {
  await vscode.workspace
    .getConfiguration(SECTION, primaryO3deFolder()?.uri)
    .update(SETTING, value, vscode.ConfigurationTarget.Global);
  const effective = readVsPreference();
  return { effective, overriddenBy: effective === value ? undefined : vsPreferenceOverride() };
}

// ---- Select ----------------------------------------------------------------
// The installs the last detection saw, kept so the dashboard can describe the pick without running vswhere
// inside a render. The preference is re-read each time, so a changed setting shows before the next detection.
let lastInstalls: VisualStudioInstall[] | undefined;

/** The install the current selection picks from `installs` (undefined when a pinned year is not installed). */
export function selectInstall(installs: VisualStudioInstall[]): VisualStudioInstall | undefined {
  lastInstalls = installs;
  return pickInstall(installs, readVsPreference());
}

/**
 * One line for the dashboard: "Auto -> Visual Studio Community 2026", "2022 (not installed)", or just "Auto" before
 * any detection. A setting that is not a known value reads `Auto (invalid setting "2022")`.
 */
export function describeVsSelection(): string {
  const preference = readVsPreference();
  const invalid = invalidVsPreference();
  const label = preference !== "auto" ? preference : invalid === undefined ? "Auto" : `Auto (invalid setting ${invalid})`;
  if (!lastInstalls) {
    return label;
  }
  const chosen = pickInstall(lastInstalls, preference);
  if (chosen) {
    return `${label} -> ${chosen.displayName}`;
  }
  return preference === "auto" ? "Auto (none found)" : `${preference} (not installed)`;
}

// ---- Environment -----------------------------------------------------------
/**
 * The MSVC environment delta for the selected install: what Configure, Build and the Developer terminal receive.
 * Variables inherited from a Visual Studio developer prompt are cleared only when a version is pinned (they would
 * cancel the pin); with "auto" the capture is exactly what it always was.
 */
export function captureSelectedMsvcEnvironment(vcvars64Path: string): Promise<EnvMap> {
  return captureMsvcEnvironmentDelta(vcvars64Path, { scrubInherited: readVsPreference() !== "auto" });
}
