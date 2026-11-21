// ============================================================================
//  Visual Studio detection (Windows) — data layer.
//
//  O3DE builds on Windows against the MSVC toolchain, provided by a Visual
//  Studio installation (Community / Professional / Enterprise / Build Tools).
//  "Establishing the terminal environment" means invoking that install's
//  VsDevCmd.bat / vcvars script — so first we must locate an install.
//
//  This module is deliberately free of any `vscode` dependency so it can be
//  unit-tested. All UI/alerting lives in visualStudioGuard.ts.
//
//  Detection order: vswhere.exe (authoritative) -> probe well-known roots.
// ============================================================================

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { readCachedValue } from "../build/configureCommand";

const execFileAsync = promisify(execFile);

// ---- Public data shape -----------------------------------------------------
export interface VisualStudioInstall {
  displayName: string;
  installationPath: string;
  version: string;
  isPrerelease: boolean;
  hasCppTools: boolean; // VC\Auxiliary\Build\vcvars64.bat present
  vsDevCmdPath?: string; // Common7\Tools\VsDevCmd.bat
  vcvars64Path?: string; // VC\Auxiliary\Build\vcvars64.bat
}

// Base fields known before we touch the filesystem (from vswhere or a probe).
export interface VsWhereInstall {
  displayName: string;
  installationPath: string;
  version: string;
  isPrerelease: boolean;
}

// ---- vswhere JSON parsing (pure — unit-testable) ---------------------------
interface RawVsWhereEntry {
  displayName?: string;
  installationName?: string;
  installationPath?: string;
  installationVersion?: string;
  isPrerelease?: boolean;
}

/** Parse `vswhere -format json` output into base install records. Never throws. */
export function parseVsWhereJson(stdout: string): VsWhereInstall[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  return (raw as RawVsWhereEntry[])
    .filter((e) => typeof e.installationPath === "string" && e.installationPath.length > 0)
    .map((e) => ({
      displayName: e.displayName ?? e.installationName ?? "Visual Studio",
      installationPath: e.installationPath as string,
      version: e.installationVersion ?? "unknown",
      isPrerelease: e.isPrerelease ?? false,
    }));
}

// ---- Enrich a base record with on-disk env-script locations ----------------
function describeInstall(base: VsWhereInstall): VisualStudioInstall {
  const vsDevCmd = path.join(base.installationPath, "Common7", "Tools", "VsDevCmd.bat");
  const vcvars64 = path.join(base.installationPath, "VC", "Auxiliary", "Build", "vcvars64.bat");
  return {
    ...base,
    hasCppTools: fs.existsSync(vcvars64),
    vsDevCmdPath: fs.existsSync(vsDevCmd) ? vsDevCmd : undefined,
    vcvars64Path: fs.existsSync(vcvars64) ? vcvars64 : undefined,
  };
}

// ---- Detection layer 1: vswhere.exe ----------------------------------------
function vswherePath(): string {
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
}

async function queryVsWhere(): Promise<VsWhereInstall[]> {
  const exe = vswherePath();
  if (!fs.existsSync(exe)) {
    return [];
  }
  const { stdout } = await execFileAsync(
    exe,
    ["-all", "-prerelease", "-products", "*", "-format", "json", "-utf8"],
    { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
  );
  return parseVsWhereJson(stdout);
}

// ---- Detection layer 2: probe well-known install roots ---------------------
function probeWellKnownRoots(): VsWhereInstall[] {
  const bases = [
    process.env["ProgramFiles"] ?? "C:\\Program Files",
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  ];
  const years = ["2022", "2019", "2017"];
  const editions = ["Community", "Professional", "Enterprise", "BuildTools"];
  const found: VsWhereInstall[] = [];
  for (const base of bases) {
    for (const year of years) {
      for (const edition of editions) {
        const root = path.join(base, "Microsoft Visual Studio", year, edition);
        if (fs.existsSync(path.join(root, "Common7", "Tools", "VsDevCmd.bat"))) {
          found.push({
            displayName: `Visual Studio ${edition} ${year}`,
            installationPath: root,
            version: "unknown",
            isPrerelease: false,
          });
        }
      }
    }
  }
  return found;
}

// ---- Public API ------------------------------------------------------------
/** Detect Visual Studio installations. Windows only; returns [] elsewhere. */
export async function findVisualStudioInstalls(): Promise<VisualStudioInstall[]> {
  if (process.platform !== "win32") {
    return [];
  }
  let bases: VsWhereInstall[] = [];
  try {
    bases = await queryVsWhere();
  } catch {
    bases = [];
  }
  if (bases.length === 0) {
    bases = probeWellKnownRoots();
  }
  return bases.map(describeInstall);
}

// Compare dotted version strings ("17.14.36518.9"); true if `a` is newer than `b`.
function isNewerVersion(a: string, b: string): boolean {
  const toParts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const av = toParts(a);
  const bv = toParts(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) {
      return diff > 0;
    }
  }
  return false;
}

/**
 * Choose the best install: prefer those with the MSVC C++ tools, and among
 * those the newest version. Falls back to the newest overall if none have C++
 * tools. (A machine may have several VS installs — e.g. 2022 alongside 2019.)
 */
export function pickBestInstall(
  installs: VisualStudioInstall[],
): VisualStudioInstall | undefined {
  const cppCapable = installs.filter((i) => i.hasCppTools);
  const pool = cppCapable.length > 0 ? cppCapable : installs;
  return pool.reduce<VisualStudioInstall | undefined>(
    (best, cur) => (!best || isNewerVersion(cur.version, best.version) ? cur : best),
    undefined,
  );
}

// ============================================================================
//  Selection (pure) — which install the user wants the MSVC environment from.
//
//  `o3de.build.visualStudio` is "auto" (the newest install, the old behaviour) or
//  a year that pins one Visual Studio, so a newly installed version never takes
//  over. The year is derived from the install's MAJOR version, never from vswhere's
//  productLineVersion (it reports "18" for Visual Studio 2026).
// ============================================================================

export type VsYear = "2019" | "2022" | "2026";
export type VsPreference = "auto" | VsYear;
export const VS_PREFERENCES: VsPreference[] = ["auto", "2019", "2022", "2026"];

// Pinnable years -> installationVersion major.
const MAJOR_BY_YEAR: Record<VsYear, number> = { "2019": 16, "2022": 17, "2026": 18 };
// Display only: 2017 can be named but not pinned.
const YEAR_BY_MAJOR: Record<number, string> = { 15: "2017", 16: "2019", 17: "2022", 18: "2026" };

export function isVsPreference(value: unknown): value is VsPreference {
  return typeof value === "string" && (VS_PREFERENCES as string[]).includes(value);
}

/** The major of a dotted version ("17.14.2" -> 17); undefined for "unknown" or garbage. */
export function vsMajor(version: string): number | undefined {
  const major = Number.parseInt(version.split(".")[0], 10);
  return Number.isNaN(major) ? undefined : major;
}

/** The product year of an install ("2026"), "v<major>" for a version this table doesn't know, undefined when unreadable. */
export function vsYear(install: Pick<VisualStudioInstall, "version">): string | undefined {
  const major = vsMajor(install.version);
  return major === undefined ? undefined : (YEAR_BY_MAJOR[major] ?? `v${major}`);
}

/**
 * The install a preference selects. auto = the best install (pickBestInstall); a year = the best install of that
 * major, so a pinned install lacking the C++ tools is still returned (the guard then warns about it). An install
 * whose version is unreadable (the fallback probe) never matches a pin.
 */
export function pickInstall(installs: VisualStudioInstall[], preference: VsPreference): VisualStudioInstall | undefined {
  if (preference === "auto") {
    return pickBestInstall(installs);
  }
  const major = MAJOR_BY_YEAR[preference];
  return pickBestInstall(installs.filter((i) => vsMajor(i.version) === major));
}

/** Why pickInstall found nothing: what is selected and what is installed instead. */
export function explainSelection(preference: VsPreference, installs: VisualStudioInstall[]): string {
  if (installs.length === 0) {
    return "No Visual Studio installation was found.";
  }
  if (preference === "auto") {
    return "No usable Visual Studio installation was found.";
  }
  const unreadable = installs.filter((i) => vsMajor(i.version) === undefined).length;
  return (
    `Visual Studio ${preference} is selected (o3de.build.visualStudio) but not installed. ` +
    `Found: ${installs.map((i) => i.displayName).join(", ")}.` +
    (unreadable > 0 ? ` ${unreadable} of them could not report a version, so they cannot match a pinned year.` : "")
  );
}

export function lacksCppToolsMessage(install: VisualStudioInstall): string {
  return `${install.displayName} lacks the MSVC C++ toolset.`;
}

/** What is wrong with the pick, if anything: nothing selected (explainSelection) or the selected install has no C++ tools. */
export function selectionProblem(
  preference: VsPreference,
  installs: VisualStudioInstall[],
  chosen: VisualStudioInstall | undefined,
): string | undefined {
  if (!chosen) {
    return explainSelection(preference, installs);
  }
  return chosen.hasCppTools ? undefined : lacksCppToolsMessage(chosen);
}

// ---- A build tree's cached compiler ----------------------------------------
function normalisePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** True for a compiler path inside a Visual Studio install ("…/Microsoft Visual Studio/…" or "…/VC/Tools/MSVC/…"). */
function isMsvcCompilerPath(compiler: string): boolean {
  const p = normalisePath(compiler);
  return p.includes("/microsoft visual studio/") || p.includes("/vc/tools/msvc/");
}

/**
 * The compiler CMake cached for a build tree (CMAKE_CXX_COMPILER) when it is an MSVC compiler that does NOT live
 * under the selected install; undefined when it matches, is not MSVC (clang, gcc), or the cache names none.
 * CMake keeps the cached compiler, so this is how "the build switched Visual Studio" shows.
 */
export function cachedCompilerMismatch(cacheText: string, installationPath: string): string | undefined {
  const compiler = readCachedValue(cacheText, "CMAKE_CXX_COMPILER");
  if (!compiler || !isMsvcCompilerPath(compiler)) {
    return undefined;
  }
  const root = normalisePath(installationPath).replace(/\/+$/, "");
  return normalisePath(compiler).startsWith(`${root}/`) ? undefined : compiler;
}

/** The one-line warning for a build tree whose cached compiler is outside the selected Visual Studio. */
export function compilerMismatchWarning(buildDir: string, compiler: string, selectedDisplayName: string): string {
  return (
    `${buildDir} was configured with ${compiler}; the selected Visual Studio is ${selectedDisplayName}. ` +
    "The build tree keeps its compiler: select the matching version in the dashboard's Visual Studio row, " +
    "or delete CMakeCache.txt and CMakeFiles and Configure to switch."
  );
}

/** A build tree's CMakeCache.txt text, or undefined when there is none (not configured yet). */
export function readBuildCache(buildDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(buildDir, "CMakeCache.txt"), "utf8");
  } catch {
    return undefined;
  }
}
