// ============================================================================
//  MSVC environment capture (Windows).
//
//  cl.exe/link.exe only work once the Visual Studio "developer" environment is
//  established (INCLUDE, LIB, PATH, VCINSTALLDIR, …). The user's build scripts
//  do this with `call vcvars64.bat` before any build command.
//
//  We reproduce that non-interactively: run vcvars64.bat in a cmd shell, dump
//  the resulting environment with `set`, and diff it against the base process
//  environment to isolate exactly what vcvars added/changed. Those vars are
//  then applied to integrated terminals (and, later, task execution).
//
//  parseSetOutput/diffEnvironment are pure and unit-tested; only the capture
//  functions perform I/O.
// ============================================================================

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type EnvMap = Record<string, string>;

// ---- Parsing (pure) --------------------------------------------------------
/** Parse `set` output ("KEY=VALUE" per line) into a map. Ignores non-KEY=VALUE lines. */
export function parseSetOutput(stdout: string): EnvMap {
  const env: EnvMap = {};
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue; // skip blank lines / banners / anything without a key
    }
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

// ---- Diff (pure) -----------------------------------------------------------
/**
 * Entries in `full` that are new or changed vs `base`. Keys compared
 * case-insensitively (Windows env vars are case-insensitive). Isolates the
 * vcvars contribution.
 */
export function diffEnvironment(base: EnvMap, full: EnvMap): EnvMap {
  const baseLower: EnvMap = {};
  for (const [key, value] of Object.entries(base)) {
    baseLower[key.toLowerCase()] = value;
  }
  const delta: EnvMap = {};
  for (const [key, value] of Object.entries(full)) {
    if (baseLower[key.toLowerCase()] !== value) {
      delta[key] = value;
    }
  }
  return delta;
}

// ---- Inherited Visual Studio variables (pure) ------------------------------
// vcvars64.bat is first-wins: on an environment that already holds one Visual Studio's variables (VS Code
// launched from a "Developer Command Prompt") it leaves them alone, so calling a second install's vcvars
// returns the FIRST install's toolset. These are the variables that make it so.
const VS_ENV_PREFIXES = ["vscmd_", "__vscmd_", "windowssdk"]; // VSCMD_*, __VSCMD_*, WindowsSdkDir / WindowsSDKVersion / ...
const VS_ENV_NAMES = new Set(
  [
    "VSINSTALLDIR",
    "VCINSTALLDIR",
    "VCIDEInstallDir",
    "VCToolsVersion",
    "VCToolsInstallDir",
    "VCToolsRedistDir",
    "DevEnvDir",
    "UCRTVersion",
    "UniversalCRTSdkDir",
    "WindowsLibPath",
    "ExtensionSdkDir",
    "NETFXSDKDir",
    "FrameworkDir",
    "FrameworkDir64",
    "FrameworkVersion",
    "FrameworkVersion64",
    "Framework40Version",
    "INCLUDE",
    "LIB",
    "LIBPATH",
    "EXTERNAL_INCLUDE",
    "Platform",
    "VisualStudioVersion",
    "CommandPromptType",
  ].map((name) => name.toLowerCase()),
);

function isInheritedVsVariable(key: string): boolean {
  const name = key.toLowerCase();
  return VS_ENV_NAMES.has(name) || VS_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) || /^vs\d+comntools$/.test(name);
}

/** Does `env` come from a Visual Studio developer prompt? Those always set VSCMD_*, VSINSTALLDIR and VCINSTALLDIR. */
function hasInheritedVsPrompt(env: EnvMap): boolean {
  return Object.keys(env).some((key) => {
    const name = key.toLowerCase();
    return name === "vsinstalldir" || name === "vcinstalldir" || name.startsWith("vscmd_") || name.startsWith("__vscmd_");
  });
}

/**
 * `env` without the variables a Visual Studio developer prompt left behind (keys compared case-insensitively).
 * An environment with no such prompt comes back unchanged, so the user's own INCLUDE / LIB / LIBPATH /
 * EXTERNAL_INCLUDE / Platform survive and a pin is captured exactly like "auto".
 */
export function scrubVisualStudioEnv(env: EnvMap): EnvMap {
  if (!hasInheritedVsPrompt(env)) {
    return { ...env };
  }
  const kept: EnvMap = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isInheritedVsVariable(key)) {
      kept[key] = value;
    }
  }
  return kept;
}

// ---- Capture (I/O) ---------------------------------------------------------
function currentEnvironment(): EnvMap {
  const env: EnvMap = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Run vcvars64.bat and capture the full resulting environment. Windows only. `baseEnv` is the environment
 * vcvars starts from; omitted, it inherits the process environment.
 */
export async function captureFullEnvironment(vcvars64Path: string, baseEnv?: EnvMap): Promise<EnvMap> {
  // Use exec (not execFile): Node runs this as `cmd.exe /d /s /c "<command>"` with
  // verbatim arguments, so the quoted path (which contains spaces) survives cmd's own
  // parsing. Passing cmd.exe through execFile escapes the embedded quotes and breaks it.
  const command = `call "${vcvars64Path}" >nul 2>&1 && set`;
  const { stdout } = await execAsync(command, {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    ...(baseEnv ? { env: baseEnv } : {}),
  });
  return parseSetOutput(stdout);
}

/**
 * Capture only the environment changes vcvars introduces vs the current process. `scrubInherited` starts vcvars
 * from the process environment minus any inherited Visual Studio variables, so the install being called is the
 * one that answers; the diff stays against the real process environment either way.
 */
export async function captureMsvcEnvironmentDelta(
  vcvars64Path: string,
  options: { scrubInherited?: boolean } = {},
): Promise<EnvMap> {
  const base = currentEnvironment();
  const full = await captureFullEnvironment(vcvars64Path, options.scrubInherited ? scrubVisualStudioEnv(base) : undefined);
  return diffEnvironment(base, full);
}
