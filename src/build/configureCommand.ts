// ============================================================================
//  Configure command — pure helpers (vscode-free, unit-tested).
//
//  The shape of the CMake configure invocation and the small bits of build-tree
//  inspection that back it. Kept free of vscode / I/O so it can be exercised
//  directly by unit tests and node proofs. Running it (MSVC environment, File API
//  query, the managed command) lives in configure.ts.
// ============================================================================

import * as path from "path";

// ---- Build directory -------------------------------------------------------
/** Per-platform build sub-directory name (build/<platform>). */
export function platformBuildDir(): string {
  if (process.platform === "win32") {
    return "windows";
  }
  return process.platform === "darwin" ? "mac" : "linux";
}

/** Executable file suffix for the current OS (".exe" on Windows, "" elsewhere). */
export function exeSuffix(): string {
  return process.platform === "win32" ? ".exe" : "";
}

/**
 * Engine prebuilt bin subdirectory on disk — capitalized (Windows/Linux/Mac),
 * distinct from platformBuildDir()'s lowercase project build folder. O3DE ships
 * an SDK engine's binaries under <engine>/bin/<EngineBinDir>/<config>.
 */
export function engineBinDirName(): string {
  if (process.platform === "win32") {
    return "Windows";
  }
  return process.platform === "darwin" ? "Mac" : "Linux";
}

/** Absolute build tree for a project: <project>/build/<platform>. */
export function projectBuildDir(projectPath: string): string {
  return path.join(projectPath, "build", platformBuildDir());
}

/** The CMake File API reply directory for a project's build tree. */
export function fileApiReplyDir(projectPath: string): string {
  return path.join(projectBuildDir(projectPath), ".cmake", "api", "v1", "reply");
}

// ---- CMakeCache inspection -------------------------------------------------
/**
 * The generator a build tree was configured with, read from CMakeCache.txt's
 * `CMAKE_GENERATOR:INTERNAL=` line, or undefined if not present. CMake refuses
 * to switch generators in place, so this drives the reconfigure decision.
 */
export function parseCachedGenerator(cacheText: string): string | undefined {
  for (const line of cacheText.split(/\r?\n/)) {
    const match = /^CMAKE_GENERATOR:INTERNAL=(.*)$/.exec(line.trim());
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/** A cache entry's value by name, from a `NAME:TYPE=VALUE` line (e.g. LY_RENDERDOC_ENABLED:BOOL=ON). */
export function readCachedValue(cacheText: string, name: string): string | undefined {
  for (const line of cacheText.split(/\r?\n/)) {
    const match = /^([^:=/#]+):[^=]+=(.*)$/.exec(line.trim());
    if (match && match[1] === name) {
      return match[2];
    }
  }
  return undefined;
}

// ---- Configure command line ------------------------------------------------
export interface ConfigureInputs {
  projectPath: string;
  buildDir: string;
  generator: string; // "Ninja Multi-Config" | "Visual Studio 17 2022"
  thirdPartyPath: string; // LY_3RDPARTY_PATH
  compiler?: "MSVC" | "Clang" | "GCC"; // default MSVC (Windows) / Clang (Linux)
  extraCacheArgs?: Record<string, string>; // Advanced-tab -D<VAR>=<value> cache flags
}

/**
 * The argv for the O3DE configure: cmake -G <gen> -S <project> -B <build>
 * -DLY_3RDPARTY_PATH=<3rd>, plus the compiler selection.
 *   - Clang, VS generator  → -T ClangCl  (the clang-cl toolset that ships with VS)
 *   - Clang, Ninja         → -DCMAKE_C_COMPILER=clang  -DCMAKE_CXX_COMPILER=clang++
 *   - GCC   (Linux/Ninja)  → -DCMAKE_C_COMPILER=gcc    -DCMAKE_CXX_COMPILER=g++
 *   - MSVC                 → no override (the default toolset for the VS/Ninja env)
 */
export function buildConfigureArgs(inputs: ConfigureInputs): string[] {
  const args = [
    "cmake",
    "-G",
    inputs.generator,
    "-S",
    inputs.projectPath,
    "-B",
    inputs.buildDir,
    `-DLY_3RDPARTY_PATH=${inputs.thirdPartyPath}`,
  ];

  if (inputs.compiler === "Clang") {
    if (inputs.generator.startsWith("Visual Studio")) {
      args.push("-T", "ClangCl");
    } else {
      args.push("-DCMAKE_C_COMPILER=clang", "-DCMAKE_CXX_COMPILER=clang++");
    }
  } else if (inputs.compiler === "GCC") {
    args.push("-DCMAKE_C_COMPILER=gcc", "-DCMAKE_CXX_COMPILER=g++");
  }

  // Advanced-tab extra cache variables (e.g. LY_RENDERDOC_ENABLED, CMAKE_OBJECT_PATH_MAX).
  // Sorted for a stable, diff-friendly command line.
  for (const key of Object.keys(inputs.extraCacheArgs ?? {}).sort()) {
    args.push(`-D${key}=${inputs.extraCacheArgs![key]}`);
  }
  return args;
}

/** Join argv into a shell line, double-quoting tokens with spaces, `=`, or path chars. */
export function formatCommand(argv: string[]): string {
  return argv.map((token) => (/[\s="\\/:]/.test(token) ? `"${token}"` : token)).join(" ");
}

// ---- CMake File API query --------------------------------------------------
/** Object kinds we ask CMake to emit (a File API reply) at configure time. */
export const FILE_API_REQUESTS = [
  { kind: "codemodel", version: 2 },
  { kind: "cache", version: 2 },
  { kind: "cmakeFiles", version: 1 },
  { kind: "toolchains", version: 1 },
];
