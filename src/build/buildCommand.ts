// ============================================================================
//  Build command — pure helpers (vscode-free, unit-tested).
//
//  The shape of the `cmake --build` invocation and the small string helpers the
//  target picker + tooling view need. Kept free of vscode / I/O so it can be
//  exercised directly by unit tests. Running it (MSVC environment, process-guard,
//  the managed command) lives in buildRun.ts; the picker in selectTargets.ts.
// ============================================================================

// ---- Build command line ----------------------------------------------------
export interface BuildInputs {
  buildDir: string; // <project>/build/<platform>
  config: string; // profile | debug | release
  targets: string[]; // CMake target names; empty = build everything (no --target)
  coreCount?: number; // parallel jobs; 0/undefined = auto (omit --parallel)
}

/**
 * The argv for the O3DE build:
 *   cmake --build <buildDir> --target <T…> --config <config> [--parallel <N>]
 * Mirrors the user's .bat (`--target Editor --config profile`). With no targets,
 * `--target` is omitted so CMake builds the default `all` target (build everything).
 * `--parallel <N>` is added only when a positive core count is set (else the
 * generator's own default parallelism applies).
 */
export function buildBuildArgs(inputs: BuildInputs): string[] {
  const argv = ["cmake", "--build", inputs.buildDir];
  if (inputs.targets.length > 0) {
    argv.push("--target", ...inputs.targets);
  }
  argv.push("--config", inputs.config);
  if (inputs.coreCount && inputs.coreCount > 0) {
    argv.push("--parallel", String(Math.floor(inputs.coreCount)));
  }
  return argv;
}

// ---- Curated targets -------------------------------------------------------
/** The two targets every O3DE project has, pinned to the top of the picker. */
export function curatedTargets(projectName: string): string[] {
  return ["Editor", `${projectName}.GameLauncher`];
}

// ---- Display ---------------------------------------------------------------
/** How the current target selection reads in the tree (empty = "All targets"). */
export function targetsLabel(targets: string[]): string {
  if (targets.length === 0) {
    return "All targets";
  }
  if (targets.length <= 3) {
    return targets.join(", ");
  }
  return `${targets.slice(0, 2).join(", ")} +${targets.length - 2} more`;
}

/** How the current core-count selection reads in the panel (0 = auto). */
export function coreCountLabel(coreCount: number): string {
  return coreCount > 0 ? `${coreCount} cores` : "Auto (all cores)";
}

// ---- Free-text parsing -----------------------------------------------------
/** Split a user-typed custom-target string on commas / whitespace, dropping blanks. */
export function parseCustomTargets(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
