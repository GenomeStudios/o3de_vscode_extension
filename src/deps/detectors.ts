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
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { GuidedAction } from "./registry";
import { resolveClangdExecutable } from "./clangdServer";
import { defaultLlvmBinDir } from "./llvm";
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
  /** A STAGED check names its own next step for this state, overriding the check's default action
   *  (e.g. clangd: extension installed → the next step is the server, not installing the extension). */
  action?: GuidedAction;
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

// Standalone LLVM/Clang (drives the Ninja+clang toolchain, which hands CMake bare `clang`/`clang++`
// and so finds them on PATH). Optional — like every other optional tool, absent reads grey
// "Not installed", never red. An install in LLVM's default folder that isn't on PATH (winget's LLVM
// package has been reported not to add itself) is found and flagged, with adding it to PATH next.
const CLANG_VERSION = /clang version ([\d.]+)/i;

export async function detectClang(): Promise<CheckResult> {
  const onPath = await probe("clang", ["--version"], CLANG_VERSION);
  if (onPath.state === "ok") {
    return onPath;
  }
  const bin = defaultLlvmBinDir(process.env, process.platform, (file) => fs.existsSync(file));
  if (bin) {
    const installed = await probe(path.join(bin, "clang.exe"), ["--version"], CLANG_VERSION);
    const version = installed.state === "ok" && installed.detail ? `${installed.detail} · ` : "";
    return {
      state: "warn",
      detail: `${version}Installed · not on PATH (${bin})`,
      action: { label: "Add LLVM to PATH", kind: "addToPath", payload: bin },
    };
  }
  return { state: "absent", detail: "Not installed" };
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

// An OPTIONAL extension is never a fault when absent: it reads "Not installed" on a
// neutral dot (absent), and once installed shows its version — a visible not-done → done.
// Required extensions keep detectExtension (missing = red, it blocks the track).
// clangd is STAGED — two pieces, three states:
//   extension not installed            → absent "Not installed"   (the check's Install clangd action)
//   extension installed, no server     → warn, next step = clangd's OWN download prompt
//   extension + working server         → ok "clangd <version>"
// The server is found the way the clangd extension finds it (clangdServer.ts), then run once
// with --version — a file that exists but won't start is not a working server.
//
// The next step is `clangd.activate`, not `clangd.install`: clangd only registers clangd.install
// while its context is alive, and disposes it when the server wasn't found and the prompt was
// dismissed — exactly this state. clangd.activate (always registered) re-runs clangd's startup,
// which re-shows its own "not found … download and install clangd?" prompt.
const CLANGD_EXTENSION = "llvm-vs-code-extensions.vscode-clangd";
const CLANGD_SERVER_STEP: GuidedAction = { label: "Download clangd server…", kind: "command", payload: "clangd.activate" };

/** The clangd server the clangd extension would start (its `clangd.path`), or undefined when there is none. */
export function findClangdServer(): string | undefined {
  return resolveClangdExecutable(vscode.workspace.getConfiguration("clangd").get<string>("path") ?? "clangd", {
    env: process.env,
    platform: process.platform,
    home: os.homedir(),
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    exists: (file) => fs.existsSync(file) && fs.statSync(file).isFile(),
  });
}

export async function detectClangd(): Promise<CheckResult> {
  if (!vscode.extensions.getExtension(CLANGD_EXTENSION)) {
    return { state: "absent", detail: "Not installed" };
  }
  const server = findClangdServer();
  if (!server) {
    return { state: "warn", detail: "Extension installed · clangd server not found", action: CLANGD_SERVER_STEP };
  }
  const run = await probe(server, ["--version"], /clangd version ([\d.]+)/i);
  return run.state === "ok"
    ? { state: "ok", detail: run.detail ? `clangd ${run.detail}` : "clangd server found" }
    : { state: "warn", detail: "Extension installed · clangd server didn't start", action: CLANGD_SERVER_STEP };
}

export function detectOptionalExtension(extensionId: string): CheckResult {
  const extension = vscode.extensions.getExtension(extensionId);
  if (!extension) {
    return { state: "absent", detail: "Not installed" };
  }
  const version = (extension.packageJSON as { version?: unknown } | undefined)?.version;
  return { state: "ok", detail: typeof version === "string" ? `v${version}` : "Installed" };
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
