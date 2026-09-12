// ============================================================================
//  Dependency detectors — one probe per O3DE Development Tools dependency.
//
//  Each returns a CheckResult (state + optional detail like a version/path).
//  Process-spawning probes are timeout-guarded and never throw. Existing
//  detectors (Visual Studio, Ninja, engine/project) are reused; this module
//  adds the rest of the exhaustive set (CMake, Clang, Git, long-paths, …).
// ============================================================================

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { findVisualStudioInstalls, pickBestInstall } from "../env/visualStudio";
import { findNinja } from "../build/ninja";
import { readManifest } from "../o3de/manifest";
import { discoverEngines } from "../o3de/discovery";
import { readProject } from "../o3de/identity";
import { workspaceSourceEngines } from "../build/workspaceFolders";
import { isO3deWorkspace, primaryO3deFolder, enableStateForFolder } from "../workspace/projectScope";
import { llmConnectionStatus } from "../mcp/server";

export type CheckState = "ok" | "missing" | "warn" | "absent" | "unknown";
export interface CheckResult {
  state: CheckState;
  detail?: string;
}

const PROBE_TIMEOUT_MS = 6000;

// Run `exe args`, capture stdout+stderr, extract a version via `re` (group 1).
function probe(exe: string, args: string[], re: RegExp): Promise<CheckResult> {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`;
      if (err && !out) {
        resolve({ state: "missing" });
        return;
      }
      const m = out.match(re);
      resolve({ state: "ok", detail: m ? m[1] : undefined });
    });
  });
}

// ---- Build toolchain -------------------------------------------------------

export async function detectVisualStudio(): Promise<CheckResult> {
  const best = pickBestInstall(await findVisualStudioInstalls());
  if (!best) {
    return { state: "missing" };
  }
  if (!best.hasCppTools) {
    return { state: "warn", detail: `${best.displayName} — no C++ workload` };
  }
  return { state: "ok", detail: best.displayName };
}

export function detectCMake(): Promise<CheckResult> {
  return probe("cmake", ["--version"], /cmake version ([\d.]+)/i);
}

export async function detectNinja(): Promise<CheckResult> {
  const found = await findNinja();
  return found ? { state: "ok", detail: found.version } : { state: "missing" };
}

// Standalone LLVM/Clang on PATH (drives the Ninja+clang toolchain).
export function detectClang(): Promise<CheckResult> {
  return probe("clang", ["--version"], /clang version ([\d.]+)/i);
}

// GCC — the standard Linux compiler.
export function detectGcc(): Promise<CheckResult> {
  return probe("gcc", ["--version"], /gcc.*?([\d.]+)/i);
}

// clang-cl ships with VS ("C++ Clang tools for Windows"); MSVC-compatible.
export function detectClangCl(): Promise<CheckResult> {
  return probe("clang-cl", ["--version"], /clang version ([\d.]+)/i);
}

// Windows SDK — via the standard install-roots registry key.
export function detectWindowsSdk(): Promise<CheckResult> {
  if (process.platform !== "win32") {
    return Promise.resolve({ state: "absent" });
  }
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots", "/v", "KitsRoot10"],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        resolve(err || !/KitsRoot10/.test(stdout ?? "") ? { state: "missing" } : { state: "ok" });
      },
    );
  });
}

// ---- Engine & project ------------------------------------------------------

// Base: ANY registered engine (SDK/prebuilt or source) is enough to have a project.
export function detectEngine(): CheckResult {
  const engines = discoverEngines();
  return engines.length > 0
    ? { state: "ok", detail: engines.map((e) => e.engineName).join(", ") }
    : { state: "missing" };
}

// C++ track: a SOURCE engine present IN THE WORKSPACE — this follows the workspace
// integration (the setup wizard adds the source engine as a folder), rather than
// the global manifest. It's what actually lets you browse engine code + drives
// C++ IntelliSense. A project on a prebuilt SDK engine won't have one until added.
export function detectSourceEngine(): CheckResult {
  // Same lookup the IntelliSense redirect uses — they must never disagree again.
  const engines = workspaceSourceEngines();
  return engines.length > 0
    ? { state: "ok", detail: engines.map((e) => e.engineName).join(", ") }
    : { state: "missing" };
}

export function detectProject(): CheckResult {
  const project = (vscode.workspace.workspaceFolders ?? [])
    .map((f) => readProject(f.uri.fsPath))
    .find((p) => p !== undefined);
  return project ? { state: "ok", detail: project.projectName } : { state: "missing" };
}

// Whether O3DE Tools is opted in for this project (per-project o3de.enabled).
export function detectProjectEnabled(): CheckResult {
  if (!isO3deWorkspace()) {
    return { state: "unknown" };
  }
  const folder = primaryO3deFolder();
  if (!folder) {
    return { state: "unknown" };
  }
  switch (enableStateForFolder(folder)) {
    case "enabled":
      return { state: "ok", detail: "opted in" };
    case "never":
      return { state: "missing", detail: "disabled for this project" };
    default:
      return { state: "missing", detail: "not enabled yet" };
  }
}

export function detectThirdParty(): CheckResult {
  const folder = readManifest()?.defaultThirdPartyFolder;
  if (!folder) {
    return { state: "missing" };
  }
  return fs.existsSync(folder) ? { state: "ok", detail: folder } : { state: "warn", detail: `${folder} (missing)` };
}

// Whether this extension's .vscode/settings.json (CMake + C++ wiring) is written.
export function detectWorkspaceSettings(): CheckResult {
  const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => readProject(f.uri.fsPath));
  if (!folder) {
    return { state: "unknown" };
  }
  const settings = path.join(folder.uri.fsPath, ".vscode", "settings.json");
  try {
    if (!fs.existsSync(settings)) {
      return { state: "missing" };
    }
    const text = fs.readFileSync(settings, "utf8");
    return /"cmake\.(generator|sourceDirectory|configureSettings)"/.test(text)
      ? { state: "ok" }
      : { state: "missing" };
  } catch {
    return { state: "unknown" };
  }
}

export function detectGit(): Promise<CheckResult> {
  return probe("git", ["--version"], /git version ([\d.]+)/i);
}

export async function detectGitLfs(): Promise<CheckResult> {
  const r = await probe("git", ["lfs", "version"], /git-lfs\/([\d.]+)/i);
  return r.state === "ok" ? r : { state: "absent" };
}

// ---- VS Code companions ----------------------------------------------------

export function detectExtension(extensionId: string): CheckResult {
  return vscode.extensions.getExtension(extensionId) ? { state: "ok" } : { state: "missing" };
}

// ---- Lua track -------------------------------------------------------------

// RemoteTools gem enabled on the active project (needed for Lua debug + live dump).
export function detectRemoteToolsGem(): CheckResult {
  const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => readProject(f.uri.fsPath));
  if (!folder) {
    return { state: "unknown" };
  }
  try {
    const json = JSON.parse(fs.readFileSync(path.join(folder.uri.fsPath, "project.json"), "utf8"));
    const gems: string[] = Array.isArray(json.gem_names)
      ? json.gem_names.map((g: unknown) => (typeof g === "string" ? g : (g as { name?: string })?.name ?? ""))
      : [];
    return gems.some((g) => g === "RemoteTools") ? { state: "ok" } : { state: "absent" };
  } catch {
    return { state: "unknown" };
  }
}

export function detectReflectionDump(): CheckResult {
  const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => readProject(f.uri.fsPath));
  if (!folder) {
    return { state: "unknown" };
  }
  const dump = path.join(folder.uri.fsPath, "user", "lua_symbols.json");
  return fs.existsSync(dump) ? { state: "ok" } : { state: "absent" };
}

// Is VS Code registered as O3DE's Lua editor? "O3DE: Register VS Code as Lua Editor"
// writes vscode_lua_editor.setreg (key /O3DE/Lua/Debugger/Uri = <scheme>://…) into
// the project's user/ or shared Registry. Match the Uri scheme to THIS app so a
// stale registration for a different editor still reads as "not registered here".
export function detectLuaEditorRegistration(): CheckResult {
  const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => readProject(f.uri.fsPath));
  if (!folder) {
    return { state: "unknown" };
  }
  const scheme = vscode.env.uriScheme;
  const candidates: Array<{ file: string; scope: string }> = [
    { file: path.join(folder.uri.fsPath, "user", "Registry", "vscode_lua_editor.setreg"), scope: "per-user" },
    { file: path.join(folder.uri.fsPath, "Registry", "vscode_lua_editor.setreg"), scope: "shared" },
  ];
  for (const { file, scope } of candidates) {
    try {
      if (!fs.existsSync(file)) {
        continue;
      }
      const uri = JSON.parse(fs.readFileSync(file, "utf8"))?.O3DE?.Lua?.Debugger?.Uri;
      if (typeof uri === "string" && uri.startsWith(`${scheme}://`)) {
        return { state: "ok", detail: scope };
      }
    } catch {
      // fall through to the next candidate
    }
  }
  return { state: "missing" };
}

// ---- System & optional -----------------------------------------------------

// Windows long-path support (O3DE hits MAX_PATH without it).
export function detectLongPaths(): Promise<CheckResult> {
  if (process.platform !== "win32") {
    return Promise.resolve({ state: "absent" });
  }
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        const on = /LongPathsEnabled\s+REG_DWORD\s+0x1/i.test(stdout ?? "");
        resolve(on ? { state: "ok" } : { state: "warn", detail: "disabled" });
      },
    );
  });
}

export async function detectFfmpeg(): Promise<CheckResult> {
  const r = await probe("ffmpeg", ["-version"], /ffmpeg version ([\w.-]+)/i);
  return r.state === "ok" ? r : { state: "absent" };
}

export async function detectPerforce(): Promise<CheckResult> {
  const r = await probe("p4", ["-V"], /Rev\.\s*\S+\/([\d.]+)/i);
  return r.state === "ok" ? r : { state: "absent" };
}

export async function detectSvn(): Promise<CheckResult> {
  const r = await probe("svn", ["--version", "--quiet"], /([\d.]+)/);
  return r.state === "ok" ? r : { state: "absent" };
}

export async function detectPlastic(): Promise<CheckResult> {
  // Plastic SCM / Unity Version Control ships the `cm` CLI.
  const r = await probe("cm", ["version"], /([\d.]+)/);
  return r.state === "ok" ? r : { state: "absent" };
}

// LLM connections (local MCP endpoint) — a setting toggle, not an installable
// tool. Reports the TRUE state (server listening AND .mcp.json present), so it
// never claims "on" when a client couldn't actually connect:
//   off        → absent (grey)  → "Set up LLM connections" button
//   incomplete → warn (yellow)  → enabled but no server and/or no .mcp.json
//   on         → ok (green)     → "on · port N"
export function detectLlmConnections(): CheckResult {
  const status = llmConnectionStatus();
  if (status.state === "off") {
    return { state: "absent" };
  }
  if (status.state === "on") {
    return { state: "ok", detail: `on · port ${status.port}` };
  }
  const why =
    status.port === undefined
      ? "enabled, but the server isn't running"
      : `server on :${status.port}, but no .mcp.json — click to finish setup`;
  return { state: "warn", detail: `not connected — ${why}` };
}
