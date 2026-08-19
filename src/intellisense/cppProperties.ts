// ============================================================================
//  c_cpp_properties.json builder (pure).
//
//  Emits the single consolidated "O3DE" configuration cpptools reads for C++
//  IntelliSense. compilerPath (cl.exe) lets cpptools derive the MSVC / Windows
//  SDK system includes itself, so we only supply the O3DE include graph + defines.
//  mergeCppProperties replaces our named config in place, preserving any other
//  configurations the user keeps.
// ============================================================================

export interface CppConfigInput {
  name: string;
  includePath: string[];
  defines: string[];
  forcedInclude?: string[]; // headers force-included on every TU (O3DE's VSCompat.h)
  compilerPath?: string;
  standard?: string; // File API digits, e.g. "20" | "17"
}

/** Map File API C++ standard digits to a cpptools cppStandard value. */
export function cppStandardFromApi(standard: string | undefined): string {
  return standard ? `c++${standard}` : "c++20";
}

/**
 * The cpptools intelliSenseMode for the current OS and compiler. Windows is MSVC;
 * on Linux the compiler is inferred from the compilerPath basename (clang vs gcc)
 * so cpptools parses with the matching dialect instead of misreading MSVC syntax.
 */
export function intelliSenseModeFor(
  compilerPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return "windows-msvc-x64";
  }
  if (platform === "darwin") {
    return "macos-clang-x64";
  }
  return (compilerPath ?? "").toLowerCase().includes("clang") ? "linux-clang-x64" : "linux-gcc-x64";
}

/** Build one c_cpp_properties configuration (Win32 / MSVC). */
export function buildCppConfiguration(input: CppConfigInput): Record<string, unknown> {
  return {
    name: input.name,
    includePath: input.includePath,
    defines: input.defines,
    ...(input.forcedInclude && input.forcedInclude.length
      ? { forcedInclude: input.forcedInclude }
      : {}),
    ...(input.compilerPath ? { compilerPath: input.compilerPath } : {}),
    cStandard: "c17",
    cppStandard: cppStandardFromApi(input.standard),
    intelliSenseMode: intelliSenseModeFor(input.compilerPath),
    browse: {
      path: input.includePath,
      limitSymbolsToIncludedHeaders: true,
    },
  };
}

/** Merge our config into an existing c_cpp_properties.json (replace by name, keep others). */
export function mergeCppProperties(
  existing: Record<string, unknown> | undefined,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const current = Array.isArray(existing?.["configurations"])
    ? (existing!["configurations"] as Record<string, unknown>[]).slice()
    : [];
  const index = current.findIndex((c) => c && c["name"] === config["name"]);
  if (index >= 0) {
    current[index] = config;
  } else {
    current.push(config);
  }
  const version = typeof existing?.["version"] === "number" ? (existing!["version"] as number) : 4;
  return { version, configurations: current };
}
