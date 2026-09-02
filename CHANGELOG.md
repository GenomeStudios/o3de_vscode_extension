# Changelog

All notable changes to the **O3DE Development Tools** extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [pending_version] — 2026-09-01

### Changed

- **Linux is now a supported platform, on by default — O3DE Development Tools is a
  Windows *and* Linux extension.** External testing confirmed the Linux build / run /
  debug loop holds up for everyday use, so the paths that shipped dormant in 0.2.2 are
  live out of the box: Configure, Build, Run, Stop, Run in Debug, C++ and Lua IntelliSense
  and launch.json generation all work on Linux with no setting to flip. **Windows is
  unchanged.** The toggle survives as an escape hatch, renamed to **`o3de.linuxSupport`**
  (default **on**, per-project) — turn it off only if the Linux paths misbehave on your
  machine. The old `o3de.experimental.linuxSupport` key is deprecated but still honoured,
  so a tester's existing setting keeps working; the current key wins if both are set.
  Still missing on Linux: gdb AZ-type pretty-printers, and the build's process-guard
  remains a deliberate no-op.
- The headless build's blocked-reason code `not-windows` is now `unsupported-platform` —
  it no longer means "not Windows", since Linux is supported. It fires on unsupported
  platforms (macOS) and when Linux support is switched off for the project.

### Fixed

- **The project's engine now resolves by directory, not by the manifest's legacy name map.**
  `~/.o3de/o3de_manifest.json` registers engines two ways: `engines`, a plain list of engine
  **directories** — the forward-looking form, and the only one still being written — and
  `engines_path`, a legacy name → path map that is routinely stale or missing entries. A
  project whose `project.json` names a generically-named engine (e.g. `"engine": "o3de"`)
  often has no entry in that map at all, so it failed to resolve and the Class Creation
  Wizard reported *"could not resolve the project's engine"* even with the engine sitting
  right there in the workspace. Resolution is now directory-first: the engine folders in
  **this workspace** are checked first (the "Source engine in workspace" you set up), then
  every `engines` directory, matching on what each `engine.json` actually declares. If the
  name matches nothing, a lone source engine in the workspace is used. `engines_path` is
  consulted last and never ahead of the workspace's own engine, so a stale entry can no
  longer win. This fixes the Class Wizard, Run / Run in Debug, launch.json generation, C++
  and Lua IntelliSense, and the environment report alike.

## [0.2.2] — 2026-08-19

### Added

- **Experimental Linux support — the full build/run/debug loop.** With the
  `o3de.experimental.linuxSupport` setting on (per-project, off by default; the flag
  shipped dormant in 0.2.1), Configure, Build, Run, Stop, Run in Debug, C++ and Lua
  IntelliSense, and launch.json generation now work on Linux. **Windows is unchanged.**
  On Linux the toolchain runs Ninja Multi-Config with gcc/clang — no MSVC/vcvars, the
  compiler is inherited from your shell; the Editor and launchers resolve without the
  `.exe` suffix from `bin/Linux`; Stop and is-running use `pgrep`/`pkill`; C++ IntelliSense
  reports the `linux-gcc-x64` / `linux-clang-x64` mode; and Run in Debug launches under gdb
  (`cppdbg`). A **GCC** compiler option joins Clang in the picker, which also hides the
  Windows-only choices (MSVC, the Visual Studio generator) on Linux. Intended for testers —
  see `docs/TESTING-LINUX.md`. Known gaps this round: gdb AZ-type pretty-printers, and the
  build's process-guard is a deliberate no-op on Linux.

## [0.2.1] — 2026-08-03

### Changed

- **Build, Configure and the Class Creation Wizard no longer use a terminal.** They now run
  as *managed commands*: the extension spawns them directly with the Visual Studio (MSVC)
  environment it establishes itself, and streams their output to a new **O3DE Build Output**
  channel. Integrated terminals were only ever used because CMake Tools cannot set up the
  MSVC environment for an O3DE project — that reason is gone, so the terminals are too.
  What you get:
  - **No more piled-up terminals**, and no more rival builds. A second Build while one is
    running joins the running job instead of starting a competing `cmake` on the same build
    tree. (Disposing a terminal never reliably killed *grandchildren* — `cmake` → `ninja` →
    `cl.exe` — so re-running could leave orphaned compilers behind. It now kills the tree.)
  - **A progress bar in the panel**, directly under Build/Run: the newest line of build
    output with the percentage beside it, over a bar filled from ninja's `[n/m]` output.
    It shows for Build and Configure, and sweeps instead of guessing a percentage when the
    generator reports no counts.
  - **The Build button becomes a Stop Build button while a build runs**, mirroring Run/Stop.
    Pressing Build (or its hotkey) mid-build stops it — the replacement for a terminal's
    Ctrl+C — and kills the whole process tree. A new **O3DE: Stop Build** command does the
    same from the palette. No progress notification is shown: the panel's bar and button
    are the progress and stop controls, so there's no toast whose only button is one that
    kills your build.
  - **Readable output.** Progress lines are throttled to a heartbeat while warnings, errors
    and CMake/linker messages always pass through immediately, so a full engine build no
    longer buries the few lines that matter. The complete raw output is still parsed for
    diagnostics — nothing is lost to the shaping.
  - **Builds you start are visible to the LLM endpoint.** The tab's Build now registers the
    same job MCP does, so `o3de_build_status` / `o3de_build_log` report on it too.
  - **Guards against overlapping operations.** **Run** and **Run in Debug** grey out while a
    build is running — mid-link the binaries are half-written, so launching then either fails
    or silently loads the previous build and reads as a bug in your code. **Build** greys out
    while a Configure is running, since that Configure is rewriting the CMake cache the build
    would read. Both rules are enforced in the commands themselves, not just the buttons, so
    a hotkey, the palette, and the MCP `o3de_run` tool all respect them. **Stop is never
    blocked** — force-quitting the Editor mid-build is precisely what unblocks a failing link.
  - **Configure can be stopped from where you started it.** While a configure runs, the
    **Configure Project** row becomes **■ Stop Configure** (it previously just reported
    "already running", leaving no way to cancel). A new **O3DE: Stop Configure** command does
    the same from the palette.
- **Class Creation Wizard** no longer holds a terminal open for the wizard's whole lifetime.
  This removes both workarounds it needed: the `&& exit` chained onto the command to close
  the orphaned terminal (#15), and the `cmd.exe` pin that stopped PowerShell choking on the
  quoted `python.cmd` path. The button now shows the wizard is open.
- **`O3DE: Open Developer Terminal` is unchanged** — a terminal with the MSVC environment
  ready is the point of that command, and it stays the deliberate escape hatch for running
  commands by hand. Dependency installs (winget) also still use a terminal, where their
  progress output belongs.

### Added

- **Run Target now offers every executable, not just Editor/GameLauncher.** The Run
  Target picker discovers every runnable the project can produce, two ways: every
  **executable CMake target** from the CMake File API reply (offered even before it's
  built, marked "not built — build it first"), and every **exe actually present** in
  `build/<platform>/bin/<config>/` (so a freshly built tool — e.g. `O3DEQtControlGallery`
  — appears even without a fresh Configure). Editor and GameLauncher stay pinned on top
  with their special resolution (engine-aware Editor, `<Project>.GameLauncher.exe`), and
  a **Custom executable…** row covers anything the extension can't see yet. Run, **Run in
  Debug**, the Run/Stop toolbar toggle, and the LLM tools (`o3de_run`,
  `o3de_set_config runTarget`) all accept the same open set; `o3de_list_targets` now
  reports the runnable subset in a new `executables` field. Custom targets launch with
  only your Launch Options — no injected args (apps in the project build output locate
  their project from the registry files deployed beside them; only the Editor needs an
  explicit `--project-path`).
- **Environment Report** — a new **O3DE: Copy Environment Report** command copies a
  Markdown diagnostic snapshot to the clipboard (OS/distro, the full toolchain detector
  matrix, the resolved engine/project, current build selections, and resolved exe paths
  with exists? markers). Built to make remote bug reports — especially from Linux testers
  — self-diagnosing. Runs on every platform.
- **Experimental Linux support flag** — a new `o3de.experimental.linuxSupport` setting
  (per-project, **off by default**) that will gate the forthcoming Linux build/run/debug
  paths, so they can ship dormant in normal releases and be activated only by testers.
  No behavior change yet — the Linux paths land in later updates.

## [0.2.0] — 2026-07-20

### Added

- **Settings shortcut** — a gear button in the dashboard's Utilities row (and the **O3DE: Open Settings**
  command) opens VS Code Settings filtered to just this extension's settings.
- **Advanced view + CMake configure flags** — a new **Advanced** tab (below the Lua Palette) manages
  extra CMake cache variables passed to Configure. Curated toggles for the common ones (RenderDoc
  `LY_RENDERDOC_ENABLED`, `CMAKE_OBJECT_PATH_MAX`) plus a generic add/edit/remove list for any
  `-D VAR=value`. Flags are stored per-project in `o3de.cmake.configureArgs` (`.vscode/settings.json`);
  editing only updates the setting, and an **Apply (Reconfigure)** button pushes them into CMakeCache. A
  "reconfigure pending" hint shows when the stored flags differ from the cache. (#18)
- **MCP run tools** — the LLM/MCP endpoint gains **`o3de_is_running`** (detect whether the Editor /
  GameLauncher is up *without* building — a running Editor locks gem DLLs and fails the link) and
  **`o3de_run`** (launch the selected run target detached, for a build-and-run flow; never
  force-closes a running app). A third, **`o3de_force_close`**, is **off by default** and gated by the
  new `o3de.llm.allowForceClose` setting; when enabled it is marked *destructive* so the client asks
  for approval before every call. Intended flow: `o3de_is_running` → ask the user → `o3de_force_close`
  → `o3de_build` → `o3de_run`. (#19, #20)
- **Per-project opt-in (`o3de.enabled`)** — O3DE Tools' automatic behavior (C++/Lua IntelliSense,
  the run-state watcher, MCP auto-start, the Visual Studio check) now runs **only** in projects you
  enable. A non-O3DE workspace (e.g. web development) stays fully dormant — no providers, no MCP, no
  toolchain alerts, no prompt. Opening an O3DE project offers a one-time **"Enable O3DE Tools for
  this project?"** prompt (Enable / Not now / Never); the choice is stored per folder in
  `.vscode/settings.json`. Enabling starts the machinery live (no reload). New commands
  **O3DE: Enable / Disable Tools for this Project**, and a new **Required** onboarding row shows the
  per-project state with an Enable/Disable button.

### Changed

- **Run is now a toggle** — pressing **O3DE: Run** (or its `Ctrl+Alt+R` hotkey) while an app is already
  running force-quits it instead of erroring — the Editor can't run twice, so one key now launches on
  demand and quits on demand. Running state is detected robustly (tracked launches and apps started
  outside the extension). Gated by the new `o3de.run.toggleToQuit` setting (on by default; turn off to
  make Run only ever launch). (#17)
- **The Class Wizard terminal now closes with its window** — launching the Class Creation Wizard left
  its terminal orphaned in the panel after you closed the wizard. The terminal now exits (and VS Code
  disposes it) when the wizard window closes; a launch error still leaves it open so the failure is
  visible. (#15)

- **Function completions now insert their parentheses** — accepting a function suggestion inserts
  `name(args)` with the cursor/placeholders inside the parens instead of just the bare name, in both Lua
  (`Lua.completion.callSnippet: Replace`) and C++ (`C_Cpp.autocompleteAddParentheses: true`). Written into
  the generated project settings; re-run Generate Lua IntelliSense / Write Workspace Settings, or add the
  settings, to pick it up. (cpptools can't add parens to function-like **macros** like `AZ_Printf` — so the
  `AZ_Printf`/`Print` snippet now carries the fillable call with tab stops instead.)

### Fixed

- **Lua IntelliSense now actually loads the O3DE API** — the generated stub file is several megabytes,
  but LuaLS silently skips any file larger than `Lua.workspace.preloadFileSize` (default 500 KB), so the
  O3DE symbols (`log`, `Print`, classes, EBuses) never completed. Generate Lua IntelliSense now writes a
  `Lua.workspace.preloadFileSize` sized to the stub (never lowering a larger user value). Re-run Generate
  Lua IntelliSense (or add the setting) to pick it up.
- **C++ snippets no longer leak into `.lua` (and other) files** — the deployed `O3DEDevSnippets`
  (e.g. the `AZ_Printf` "Print" snippet) had no language `scope`, so VS Code offered these C++ patterns in
  every file, including Lua. They are now scoped to `cpp,c` on write. Existing snippet files aren't
  overwritten — delete `<project>/.vscode/O3DEDevSnippets.code-snippets` and re-run Write Workspace
  Settings to refresh, or add `"scope": "cpp,c"` to each snippet. (#6)
- **LLM/MCP is now per-project, not global** — `o3de.llm.enabled` was written at global scope, so
  enabling MCP on one project turned it on in every window and wrote `.mcp.json` into unrelated
  folders. It is now folder-scoped, and MCP starts only when the project is both enabled and has LLM
  connections on. (#21)

- **Add Gems / Folders no longer reconfigures the project** — the action now adds the picked
  gem(s)/folder(s) to the live workspace via VS Code's native folder API (identical to
  File > "Add Folder to Workspace"). It previously rewrote the whole `.code-workspace` on disk and
  demanded a window reload, which broke the C++ config and forced a re-run of Set Up Workspace that
  dropped the gem folder again -- an infinite loop. Adding a gem for reference is now a pure
  workspace mutation: no `.code-workspace` surgery, no reload, no CMake, no `.vscode` config changes.
  (#22)
- **"Show built-in gems" now actually lists them** — the toggle read only the user manifest's
  registered gems, none of which live inside an engine, so it revealed nothing. The picker now also
  discovers each registered engine's built-in gems from its `engine.json` (`external_subdirectories`),
  deduped against the user gems, so toggling reveals the full engine gem set (~100+ per engine).

## [0.1.1] — 2026-07-10

A UX v2 pass that reorganizes the dashboard around how the tools are actually used, plus new
build/scripting controls and a broader, clearer onboarding.

### Added

- **Core Count** build option — set the parallel job count passed to `cmake --build --parallel N`
  (blank/0 = auto). Threaded through the interactive, headless, and LLM build paths.
- **Lua Palette live search** — the palette is now a panel with a docked search bar that filters
  the Classes / EBuses / Globals tree as you type (instant, per-frame rendering); clicking a symbol
  still inserts its call snippet.
- **Version Control** onboarding section — Git, Git LFS, and Perforce, plus new **Subversion** and
  **Plastic SCM (Unity Version Control)** detectors.
- **Re-runnable onboarding steps** — already-satisfied checks that can meaningfully be re-run now
  offer a button to do so: **Source engine** (Re-run) and **Workspace settings** (Rewrite) confirm
  first; **LLM connections** reports its live status.
- **Register VS Code as Lua Editor** is now a self-detecting Lua onboarding requirement (reads the
  `.setreg` it writes) with a **Re-register** action once set.
- **Add Gems / Folders** — restored as a dashboard action, and its picker gains a **Show built-in
  gems** toggle so the engine's built-in gems stay out of the way until you want them.

### Changed

- **Dashboard reorganized** — the single "Configuration" area is split into **C++** and **Lua**
  sections (each: everyday actions first, then configuration), alongside **Setup & Onboarding**.
  Section collapse state now persists across VS Code restarts.
- **Onboarding reformatted** — reads top-down as **Status → Required → Common Optionals →
  C++/Lua switcher → that track's requirements & optionals → Version Control**. Re-scan moved into
  the section header beside the status light.
- **Class Creation Wizard** moved into **Utilities** as a discreet full-width button.
- **Utilities icons** — Editor Log (document), Error Log (error), and Run in Debug (bug) are compact
  icon buttons; Run in Debug moved out of the Build & Run row.
- The dashboard view is titled **Dashboard** again (the panel header carries the name + version).

### Removed

- The redundant **Open Lua Palette** and **Write Workspace Settings** buttons from the config
  sections (the palette is a view; Write Workspace Settings is an onboarding step).
- The Lua Palette title-bar filter/clear commands — filtering is now the inline search bar.

## [0.0.15] — 2026-07-09

A follow-up pass resolving reported issues across build, run, Lua tooling, and onboarding.

### Added

- **Run in Debug (C++)** — launch the Editor / GameLauncher under VS Code's C++ debugger
  (`cppvsdbg`) straight from the tooling window: a keybindable command plus a debug caret next
  to **Run**. The launch is configured for you — no hand-edited `launch.json`.
- **Compiler selection** — choose **MSVC** or **Clang**; the choice flows into the CMake
  configure (Clang via `-T ClangCl` on the VS generator, or the Clang compiler flags on Ninja).
- **Class Creation Wizard** — launch the engine-side `Tools/ClassCreationWizard` PySide tool
  from the dashboard, wired to the active engine and project.
- **Lua Palette search** — filter the Classes / EBuses / Globals tree by name; matching
  containers auto-expand, and a clear-filter action resets it.

### Changed

- **Write Workspace Settings** — the former *Write Project Config* action is renamed and now
  treated as a required setup step (writes `.vscode/settings.json` CMake keys).
- Build and Configure reuse their named terminals instead of stacking new ones on every run.
- `.lua` files no longer surface C++ word-based suggestions — completion is LuaLS-only.
- The reflection-dump / RemoteTools status refreshes on panel focus and after a dump, with a
  manual **Re-scan** button, so it no longer shows stale results.

## [0.0.14] — 2026-07-09

The first Marketplace update since 0.0.2 — a major feature drop that adds full **Lua
development** support and a **guided onboarding** system on top of the build, run, and C++
foundation.

### Added — Lua development

- **Lua debugger** — a native Debug Adapter that speaks O3DE's RemoteTools protocol directly
  (no companion gem or helper process): breakpoints, step in/over/out, continue, call stack,
  locals, watch, and edit-value, against a running Editor or GameLauncher.
- **Lua IntelliSense** — generates LuaLS (sumneko) annotation stubs from O3DE's reflected
  scripting API for typed completion and hovers in `.lua` scripts. Reflection data can be
  scraped **live from a running Editor** (no boot) or from a **headless** Editor run.
- **Lua Function Palette** — a browsable, searchable Classes / EBuses / Globals tree in the
  O3DE activity bar (the VS Code equivalent of the built-in Lua Editor's Class Reference),
  with click-to-insert.
- **Editor handoff** — O3DE's *Open Lua Editor* (Tools menu and the Script component's Edit
  button) opens scripts in VS Code via a `vscode://` URI; new scripts open as unsaved buffers.
- A getting-started guide covering authoring, attaching a script to an entity, running it, and
  debugging with breakpoints.

### Added — Guided onboarding

- **Intent-driven setup ramp** — choose **C++** or **Lua**; the panel shows just that track's
  requirements, computes the single next step, and offers one-click acquisition (install /
  enable / configure) for every missing dependency.
- **Exhaustive, platform-aware dependency detection** — compiler (MSVC / Clang), CMake, Ninja,
  Windows SDK, engine, project, 3rd-Party path, Git / Git LFS, the C++ and Lua language-server
  extensions, the RemoteTools gem, and more (Windows / Linux).
- Per-track **Ready** sub-reports (C++ / Lua) in the panel header; Build & Run stay enabled on
  the bare minimum (a project) regardless of track readiness.
- The active extension version is shown in the O3DE panel title.

### Included — Build, run & C++ foundation

- Guided multi-root workspace setup (project + engine source + gems).
- Windows MSVC environment bootstrap; Ninja detection and install.
- One-click CMake configure / build / run with selectable generator, config, and targets.
- C++ IntelliSense via the CMake File API (cpptools), with engine-source path resolution.

## [0.0.2] — 2026-07-01

- Early preview: extension skeleton, MSVC environment, initial workspace/build scaffolding.
