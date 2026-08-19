// ============================================================================
//  launch.json builder (pure) — O3DE debug/run targets.
//
//  Templatized from the user's proven cppvsdbg / debugpy configs, but with the
//  natvis + engine references pointed at the workspace SOURCE engine (fixing the
//  find/replace error common in hand-made configs, where visualizerFile pointed
//  at the project folder). Path resolution (prebuilt-engine vs project-build
//  Editor, folder refs, disk probing) happens in launchGenerate.ts; this file
//  just assembles the JSON from already-resolved strings.
// ============================================================================

export interface LaunchInputs {
  projectRef: string; // "${workspaceFolder}" (launch.json lives in <project>/.vscode)
  editorProgram: string; // resolved Editor.exe (absolute, or ${workspaceFolder:…})
  gameLauncherProgram: string; // resolved <Project>.GameLauncher.exe
  natvisPath?: string; // source-engine azcore.natvis; omit visualizer/attach-visualized if absent
  sourceEngineRef?: string; // source-engine folder ref; omit ClassWizard if absent
}

/** Our config names carry this prefix so regeneration can replace only our set. */
export const O3DE_LAUNCH_PREFIX = "O3DE: ";

// ---- Build ----------------------------------------------------------------
export function buildLaunchConfigurations(inputs: LaunchInputs): Record<string, unknown>[] {
  const configs: Record<string, unknown>[] = [];

  // Native C++ debugger for this OS: cppvsdbg on Windows, cppdbg (gdb) on Linux.
  const isWin = process.platform === "win32";
  const nativeType = isWin ? "cppvsdbg" : "cppdbg";
  const launchExtras: Record<string, unknown> = isWin
    ? { console: "integratedTerminal" }
    : {
        MIMode: "gdb",
        externalConsole: false,
        setupCommands: [{ description: "Enable pretty-printing for gdb", text: "-enable-pretty-printing", ignoreFailures: true }],
      };

  // Editor (native debug) — launches the resolved Editor against this project.
  configs.push({
    name: "O3DE: Editor",
    type: nativeType,
    request: "launch",
    program: inputs.editorProgram,
    args: ["--project-path", inputs.projectRef],
    cwd: inputs.projectRef,
    stopAtEntry: false,
    environment: [],
    ...launchExtras,
    // natvis is an MSVC/cppvsdbg visualizer — Windows only.
    ...(isWin && inputs.natvisPath ? { visualizerFile: inputs.natvisPath } : {}),
  });

  // GameLauncher (native debug) — the project's built game runtime.
  configs.push({
    name: "O3DE: GameLauncher",
    type: nativeType,
    request: "launch",
    program: inputs.gameLauncherProgram,
    args: [],
    cwd: inputs.projectRef,
    stopAtEntry: false,
    environment: [],
    ...launchExtras,
  });

  // Attach configs are Windows-only for now: cppvsdbg attaches by pid alone, but
  // cppdbg (gdb) attach also requires the target program path, which a generic
  // "pick any process" attach doesn't have. Linux users debug via the launch
  // configs above (or "O3DE: Run in Debug").
  if (isWin) {
    configs.push({
      name: "O3DE: Attach",
      type: "cppvsdbg",
      request: "attach",
      processId: "${command:pickProcess}",
    });
    if (inputs.natvisPath) {
      configs.push({
        name: "O3DE: Attach (visualized)",
        type: "cppvsdbg",
        request: "attach",
        processId: "${command:pickProcess}",
        visualizerFile: inputs.natvisPath,
      });
    }
  }

  // Class Creation Wizard (Python) — runs from the source engine's Tools/.
  if (inputs.sourceEngineRef) {
    configs.push({
      name: "O3DE: Class Creation Wizard",
      type: "debugpy",
      request: "launch",
      justMyCode: true,
      python: "${command:python.interpreterPath}",
      program: `${inputs.sourceEngineRef}/Tools/ClassCreationWizard/ClassWizard.py`,
      cwd: inputs.projectRef,
      args: ["--engine-path", inputs.sourceEngineRef, "--project-path", inputs.projectRef],
    });
  }

  return configs;
}

// ---- Merge (own our configs, preserve the user's) --------------------------
/** Replace our previously-generated "O3DE: " configs, keep everything the user added. */
export function mergeLaunchJson(
  existing: Record<string, unknown> | undefined,
  ours: Record<string, unknown>[],
): Record<string, unknown> {
  const current = Array.isArray(existing?.["configurations"])
    ? (existing!["configurations"] as Record<string, unknown>[])
    : [];
  const kept = current.filter((cfg) => {
    const name = cfg?.["name"];
    return !(typeof name === "string" && name.startsWith(O3DE_LAUNCH_PREFIX));
  });
  return { version: "0.2.0", configurations: [...kept, ...ours] };
}
