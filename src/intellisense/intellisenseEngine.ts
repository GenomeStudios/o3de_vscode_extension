// ============================================================================
//  IntelliSense engine — which C++ language engine is RUNNING, and the exact
//  workspace settings that make one run and the other not.
//
//  Two engines can serve C++ IntelliSense:
//    C/C++ extension  runs unless `C_Cpp.intelliSenseEngine` is "disabled"
//    clangd           runs unless `clangd.enable` is false
//  (each only when its extension is installed). Reading the running state from the
//  EFFECTIVE settings means a clangd the user installed before O3DE ever touched
//  anything shows exactly as it is — including "both running".
//
//  Choosing an engine writes WORKSPACE settings only (never user-global), and the
//  planner records the value each key had before O3DE first changed it, so
//  choosing the C/C++ extension again restores the workspace as it was.
//  Choosing clangd also points clangd at O3DE's compile database.
//
//  Pure: inputs in, labels and a write plan out.
// ============================================================================

// ---- Model -----------------------------------------------------------------
export type RunningEngine = "cpptools" | "clangd" | "both" | "none";
export type EngineChoice = "cpptools" | "clangd";

export interface EngineInputs {
  cppToolsInstalled: boolean;
  clangdInstalled: boolean;
  cppToolsEngine?: string; // effective C_Cpp.intelliSenseEngine ("default" | "Tag Parser" | "disabled")
  clangdEnable?: boolean; // effective clangd.enable
}

/** The workspace-scope settings the switch manages, as `section.key`. */
export type ManagedKey = "C_Cpp.intelliSenseEngine" | "clangd.enable" | "clangd.arguments";

/** One workspace write. `value: undefined` removes the key (the workspace inherits again). */
export interface SettingWrite {
  key: ManagedKey;
  value: unknown;
}

/** Workspace values each managed key had BEFORE O3DE first changed it (`null` = the key wasn't set). */
export type PriorValues = Partial<Record<ManagedKey, unknown>>;

// ---- Running state ---------------------------------------------------------
export function runningEngine(inputs: EngineInputs): RunningEngine {
  const cppTools = inputs.cppToolsInstalled && (inputs.cppToolsEngine ?? "default").toLowerCase() !== "disabled";
  const clangd = inputs.clangdInstalled && inputs.clangdEnable !== false;
  if (cppTools && clangd) {
    return "both";
  }
  return cppTools ? "cpptools" : clangd ? "clangd" : "none";
}

/** Short value text for the dashboard row. */
export function runningEngineLabel(running: RunningEngine): string {
  switch (running) {
    case "cpptools":
      return "C/C++ IntelliSense";
    case "clangd":
      return "clangd IntelliSense";
    case "both":
      return "Both running (conflict)";
    case "none":
      return "None running";
  }
}

/** One sentence for the tooltip. */
export function runningEngineDetail(running: RunningEngine, inputs: EngineInputs): string {
  switch (running) {
    case "cpptools":
      return (
        "The Microsoft C/C++ extension provides C++ IntelliSense" +
        (inputs.clangdInstalled ? "; clangd is installed but switched off here." : ".") +
        " Click to choose the engine."
      );
    case "clangd":
      return (
        "clangd provides C++ IntelliSense" +
        (inputs.cppToolsInstalled ? "; the C/C++ extension's IntelliSense is off here (it still handles debugging)." : ".") +
        " Click to choose the engine."
      );
    case "both":
      return "The C/C++ extension and clangd are both providing IntelliSense, which duplicates completions and diagnostics. Click to choose one.";
    case "none":
      return inputs.cppToolsInstalled || inputs.clangdInstalled
        ? "No C++ IntelliSense engine is switched on for this workspace. Click to choose one."
        : "Neither the C/C++ extension nor clangd is installed. Click to choose and install one.";
  }
}

// ---- Switch rules ----------------------------------------------------------
/** Why `choice` can't be switched to, if it can't: its extension isn't installed. */
export function engineSwitchBlocker(
  choice: EngineChoice,
  inputs: Pick<EngineInputs, "cppToolsInstalled" | "clangdInstalled">,
): "notInstalled" | undefined {
  const installed = choice === "clangd" ? inputs.clangdInstalled : inputs.cppToolsInstalled;
  return installed ? undefined : "notInstalled";
}

/**
 * Whether a window reload is owed after switching to `choice` (verified in cpptools 1.34.4): turning the
 * C/C++ extension's IntelliSense OFF while it runs only takes effect after a reload; turning it back ON
 * before that reload leaves it running as it was — nothing owed.
 */
export function nextReloadPending(choice: EngineChoice, before: RunningEngine, pending: boolean): boolean {
  if (choice === "cpptools") {
    return false;
  }
  return pending || before === "cpptools" || before === "both";
}

// ---- clangd arguments ------------------------------------------------------
const COMPILE_COMMANDS_DIR = "--compile-commands-dir";

/** `args` with any existing compile-commands dir replaced by `dir`; every other argument kept, in order. */
export function withCompileCommandsDir(args: string[] | undefined, dir: string): string[] {
  const kept: string[] = [];
  const source = args ?? [];
  for (let i = 0; i < source.length; i++) {
    const arg = source[i];
    if (arg === COMPILE_COMMANDS_DIR) {
      i += 1; // detached value
    } else if (!arg.startsWith(`${COMPILE_COMMANDS_DIR}=`)) {
      kept.push(arg);
    }
  }
  return [...kept, `${COMPILE_COMMANDS_DIR}=${dir}`];
}

// ---- Write plan ------------------------------------------------------------
export interface PlanInputs {
  cppToolsInstalled: boolean;
  clangdInstalled: boolean;
  /** Current WORKSPACE-scope values (not effective) of the managed keys. */
  workspace: Partial<Record<ManagedKey, unknown>>;
  /** What `clangd.enable` is WITHOUT a workspace value — the user setting, else the default (true). */
  inheritedClangdEnable: boolean;
  /** Values recorded before O3DE first changed a key (from an earlier switch). */
  prior: PriorValues;
  /** Where O3DE's compile database lives (clangd choice only). */
  databaseDir?: string;
}

export interface EnginePlan {
  writes: SettingWrite[];
  /** The prior-values record after this plan is applied. */
  prior: PriorValues;
}

/**
 * The workspace writes that make `choice` the running engine.
 *
 *   clangd   → C/C++ IntelliSense "disabled" (if installed); clangd.enable restored if O3DE had switched it off, and
 *              set true only if it would still be off; clangd.arguments pointed at O3DE's compile database.
 *   cpptools → the C/C++ and clangd.arguments keys restored to what they were before O3DE; clangd.enable false
 *              (if clangd is installed).
 *
 * A key's ORIGINAL workspace value is recorded once — the first time O3DE changes it — and only ever restored from
 * there, so repeated switching can never mistake a value O3DE wrote for the user's own.
 */
export function planEngine(choice: EngineChoice, inputs: PlanInputs): EnginePlan {
  const prior: PriorValues = { ...inputs.prior };
  const workspaceNow: Partial<Record<ManagedKey, unknown>> = { ...inputs.workspace }; // as planned writes apply
  const planned = new Map<ManagedKey, unknown>();

  const set = (key: ManagedKey, value: unknown): void => {
    if (!(key in prior)) {
      prior[key] = workspaceNow[key] === undefined ? null : workspaceNow[key];
    }
    workspaceNow[key] = value;
    planned.set(key, value);
  };
  const restore = (key: ManagedKey): void => {
    if (key in prior) {
      const original = prior[key] === null ? undefined : prior[key];
      delete prior[key];
      workspaceNow[key] = original;
      planned.set(key, original);
    }
  };

  if (choice === "clangd") {
    if (inputs.cppToolsInstalled) {
      set("C_Cpp.intelliSenseEngine", "disabled");
    }
    restore("clangd.enable");
    const enabled = workspaceNow["clangd.enable"] ?? inputs.inheritedClangdEnable;
    if (enabled === false) {
      set("clangd.enable", true);
    }
    if (inputs.databaseDir) {
      const current = workspaceNow["clangd.arguments"];
      set("clangd.arguments", withCompileCommandsDir(Array.isArray(current) ? (current as string[]) : undefined, inputs.databaseDir));
    }
  } else {
    restore("C_Cpp.intelliSenseEngine");
    restore("clangd.arguments");
    if (inputs.clangdInstalled) {
      set("clangd.enable", false);
    }
  }
  return { writes: [...planned].map(([key, value]) => ({ key, value })), prior };
}
