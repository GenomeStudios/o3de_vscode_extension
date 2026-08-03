// ============================================================================
//  Build options — user-selectable build attributes shown in the O3DE tab.
//
//  Holds the current CMake generator + build config, persisted per-workspace
//  (workspaceState). The tooling view renders the current values and refreshes
//  when they change; Configure/Build/WriteConfig consume them.
// ============================================================================

import * as vscode from "vscode";

export type Generator = "Ninja Multi-Config" | "Visual Studio 17 2022";
export type BuildConfig = "profile" | "debug" | "release";
/**
 * What Run launches. "Editor" and "GameLauncher" are special values with their
 * own exe resolution (engine-aware Editor, <Project>.GameLauncher.exe); any
 * other string is an executable CMake target / built exe name in the project's
 * build output (e.g. "O3DEQtControlGallery") — see runTargetExeName.
 */
export type RunTarget = string;
export type Compiler = "MSVC" | "Clang";

export const GENERATORS: Generator[] = ["Ninja Multi-Config", "Visual Studio 17 2022"];
export const BUILD_CONFIGS: BuildConfig[] = ["profile", "debug", "release"];
/** The always-offered run targets — the picker adds every discovered executable after these. */
export const RUN_TARGETS: RunTarget[] = ["Editor", "GameLauncher"];
export const COMPILERS: Compiler[] = ["MSVC", "Clang"];

const KEY_GENERATOR = "o3de.build.generator";
const KEY_COMPILER = "o3de.build.compiler";
const KEY_CONFIG = "o3de.build.config";
const KEY_TARGETS = "o3de.build.targets";
const KEY_CORE_COUNT = "o3de.build.coreCount";
const KEY_RUN_TARGET = "o3de.run.target";
const KEY_LAUNCH_ARGS = "o3de.run.launchArgs";

export class BuildOptions {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires whenever a selection changes (the view listens to refresh). */
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {}

  get generator(): Generator {
    return this.state.get<Generator>(KEY_GENERATOR) ?? "Ninja Multi-Config";
  }

  /** C++ compiler: MSVC (platform default) or Clang (clang-cl under VS, clang under Ninja). */
  get compiler(): Compiler {
    return this.state.get<Compiler>(KEY_COMPILER) ?? "MSVC";
  }

  get config(): BuildConfig {
    return this.state.get<BuildConfig>(KEY_CONFIG) ?? "profile";
  }

  /** CMake target(s) the Build command builds. Empty = build everything (no --target). */
  get targets(): string[] {
    const stored = this.state.get<string[]>(KEY_TARGETS);
    return Array.isArray(stored) ? stored : [];
  }

  /**
   * Parallel build jobs passed to `cmake --build --parallel N`.
   * 0 = auto: omit the flag and let the generator decide (Ninja already uses all cores).
   */
  get coreCount(): number {
    const stored = this.state.get<number>(KEY_CORE_COUNT);
    return typeof stored === "number" && stored > 0 ? Math.floor(stored) : 0;
  }

  /** What the Run command launches (Editor, GameLauncher, or any executable target name). */
  get runTarget(): RunTarget {
    return this.state.get<RunTarget>(KEY_RUN_TARGET) ?? "Editor";
  }

  /** Extra command-line args passed when running (e.g. "+LoadLevel DefaultLevel +r_displayInfo 1"). */
  get launchArgs(): string {
    return this.state.get<string>(KEY_LAUNCH_ARGS) ?? "";
  }

  async setGenerator(value: Generator): Promise<void> {
    await this.state.update(KEY_GENERATOR, value);
    this.changed.fire();
  }

  async setCompiler(value: Compiler): Promise<void> {
    await this.state.update(KEY_COMPILER, value);
    this.changed.fire();
  }

  async setConfig(value: BuildConfig): Promise<void> {
    await this.state.update(KEY_CONFIG, value);
    this.changed.fire();
  }

  async setTargets(value: string[]): Promise<void> {
    await this.state.update(KEY_TARGETS, value);
    this.changed.fire();
  }

  /** Set the parallel job count (0 or negative = auto/omit the flag). */
  async setCoreCount(value: number): Promise<void> {
    const normalized = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    await this.state.update(KEY_CORE_COUNT, normalized);
    this.changed.fire();
  }

  async setRunTarget(value: RunTarget): Promise<void> {
    await this.state.update(KEY_RUN_TARGET, value);
    this.changed.fire();
  }

  async setLaunchArgs(value: string): Promise<void> {
    await this.state.update(KEY_LAUNCH_ARGS, value);
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
