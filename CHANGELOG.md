# Changelog

All notable changes to the **O3DE Development Tools** extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.3.0] — 2026-09-13

### Added

- **An IntelliSense section on the dashboard**, covering C++ and Lua in one place, between the
  Lua and Setup & Onboarding sections. It opens by default — it's where to look when code
  insight seems wrong.
- **IntelliSense ▸ Status ▸ Engine Sources** shows how far C++ navigation can reach into the
  engine, and why:
  - **Indexed (source engine)** — your project builds against a source engine, so engine code is
    part of the build.
  - **Redirected to *name*** — your project builds against a prebuilt SDK engine (which ships
    headers only), and engine navigation is sent to the source engine in your workspace instead.
  - **Headers only (SDK engine)** — a prebuilt SDK engine with no source engine in the workspace:
    Go to Definition cannot reach engine implementation, because an SDK install contains no
    engine `.cpp` files.
  - **Not resolved** — no project found, or its engine couldn't be resolved.

  Hover the row for the full explanation, or click it (also available as **O3DE: Show IntelliSense
  Engine Mode**). When the mode is *Headers only* and a source engine is registered on your
  machine, the message offers **Set Up Workspace…** to add it; when none is registered, no remedy
  is offered, because there isn't one.
- **IntelliSense ▸ Status ▸ C++ Data** tells you whether C++ IntelliSense still matches your CMake
  project. It reads **Stale (reconfigure)** when a file that defines targets or source lists —
  `CMakeLists.txt`, any `*.cmake` such as a gem's `*_files.cmake`, or `project.json` — changed after
  the last configure, so a file you just added won't have correct IntelliSense until you
  reconfigure; the message names the files. **Not configured** means the extension's Configure
  hasn't run for this project yet, so the live C++ IntelliSense provider has nothing to serve.
  `gem.json` edits and the O3DE manifest are deliberately ignored: they are often rewritten in bulk
  without changing any build target, and counting them flagged working projects as stale.
- **IntelliSense ▸ Status ▸ Lua Reflection** tells you whether Lua completions still reflect your
  code. It reads **Stale (gems rebuilt)** when any of this build's modules — what the Editor
  reflects the scripting API from — were rebuilt after the last Lua IntelliSense generation, and
  **Stale (different engine)** when the reflection was captured from another engine than the one
  the project builds against now. Only modules this build produces count; engine and third-party
  DLLs copied into `bin/` do not.

  Click either row for details and the fix (**Configure Project** or **Generate Lua
  IntelliSense**), or use **O3DE: Show C++ IntelliSense Data Status** / **O3DE: Show Lua Reflection
  Status**. The rows update when a configure or build finishes, when IntelliSense data is
  regenerated, and when the panel is shown — not on every build progress tick, so the dashboard
  stays responsive during builds.
- **clangd extension** in Setup & Onboarding's C++ optionals, next to CMake Tools. It is optional
  and never blocks setup. clangd comes in two pieces — the extension, and the clangd language server
  it downloads — so the row shows which stage you're at:
  - **Not installed** → **Install clangd** installs the extension.
  - **Extension installed · clangd server not found** (a yellow dot) — the extension is there but its
    server was never downloaded, for example because its download prompt was dismissed or never seen.
    **Download clangd server…** brings back clangd's own download prompt.
  - **clangd *version*** — both pieces present, and the server actually runs.

  The row updates as soon as clangd finishes downloading. Which engine actually runs is chosen on
  **IntelliSense ▸ Status ▸ IntelliSense Engine** (below).

  **When O3DE Development Tools installs clangd,** it also records clangd's own **Never show this
  warning** choice, so clangd's repeating "conflicts with the C/C++ extension" warning doesn't appear.
  **If you installed clangd some other way,** that warning shows every few seconds and dismissing it
  only brings it back. Choose **Never show this warning**. Do **not** choose **Disable
  IntelliSense** — clangd writes that to your user settings, which turns off the C/C++ extension's
  IntelliSense in *every* project. If that already happened, remove
  `"C_Cpp.intelliSenseEngine": "disabled"` from your user settings.
- **IntelliSense ▸ Status ▸ IntelliSense Engine** shows which C++ IntelliSense engine is running in
  this workspace: **C/C++ IntelliSense** (the Microsoft C/C++ extension), **clangd IntelliSense**,
  **Both running (conflict)** or **None running**. It reads your settings as they are — nothing is
  changed until you choose. Click it (or run **O3DE: Select IntelliSense Engine**) to choose which
  engine runs and which does not; an engine whose extension isn't installed is installed first.
  - **clangd** — generates a compile database for clangd from the project's CMake configure:
    every project source with its real flags, plus, for a project that builds against a prebuilt SDK
    engine with a source engine in the workspace, that engine's Framework sources, so clangd indexes
    engine code too. It then turns the C/C++ extension's IntelliSense off and clangd on, points clangd
    at the database, and restarts clangd. Reload the window when asked: the C/C++ extension only
    stops its IntelliSense after a reload. It still handles debugging. A clangd whose language server
    hasn't been downloaded yet shows its own download prompt at this point.
  - **C/C++** — puts back the settings O3DE changed, switches clangd off, and shuts it down.

  Every change is a **workspace** setting — never your user settings — and switching back restores
  the values the workspace had before O3DE changed them. The project must be configured first;
  if it isn't, the switch offers **Configure Project**.
- **clangd's compile database keeps itself up to date.** While clangd is using O3DE's compile
  database, it is regenerated automatically:
  - after a project configure;
  - when you switch build config;
  - when a workspace folder is added or removed — adding a source engine adds its Framework
    sources;
  - when VS Code starts.

  clangd restarts only when the database's content actually changed, so a configure that changed no
  flags doesn't interrupt it. clangd is never restarted when its language server hasn't been
  downloaded, which would re-show clangd's download prompt after every configure. A clangd pointed
  at its own compile database is never touched.

  **IntelliSense ▸ Status ▸ clangd Database** appears while clangd is using O3DE's database. It shows
  **Up to date · *n* entries**, **Update pending**, or **Not configured**. Hover it for details, or
  click it (or run **O3DE: Show clangd Compile Database Status**) to see the file and **Update Now**.
- **clangd switches itself on when the C/C++ extension isn't installed.** Without the Microsoft C/C++
  extension, clangd is the only C++ IntelliSense available. That's the case in editors that use
  Open VSX, where the C/C++ extension isn't published. So O3DE Development Tools turns clangd on
  without asking, on O3DE's compile database, and tells you once.
  - It happens once per workspace. If you later switch clangd off or point it at your own compile
    database, that choice stands.
  - A clangd already pointed at its own compile database is never overridden.
  - If the project isn't configured yet, it waits and switches clangd on after the first configure.
  - Installing the C/C++ extension later changes nothing automatically. The IntelliSense Engine row
    shows **Both running (conflict)**; click it to choose.
- **MCP IntelliSense tools** — the LLM/MCP endpoint gains three tools:
  - **`o3de_intellisense_status`** (read-only) returns what the dashboard's IntelliSense section
    shows:
    - which C++ IntelliSense engine is running, and whether a window reload is still needed to stop
      the C/C++ extension;
    - `clangdOnly`: the C/C++ extension isn't installed but clangd is, so clangd is switched on
      automatically;
    - whether the C/C++ and clangd extensions are installed, with versions, and whether clangd's
      language server has been downloaded;
    - while clangd uses O3DE's compile database, whether that database is up to date, with entry
      counts;
    - the Engine Sources, C++ Data and Lua Reflection status.
  - **`o3de_set_intellisense_engine`** (`cpptools` or `clangd`) switches the engine exactly as the
    dashboard does. It reports the result as data instead of showing prompts: settings changed,
    compile database entries, and `reloadRequired`. It never installs an extension; a missing one
    is reported as `notInstalled`.
  - **`o3de_update_clangd_database`** regenerates clangd's compile database on demand, exactly like
    the clangd Database row's **Update Now**. It does nothing while clangd isn't using O3DE's
    database.

### Changed

- **Generate C++ IntelliSense** and **Generate Lua IntelliSense** moved from the C++ and Lua
  sections into the new IntelliSense section. The Lua section's now-empty *Configuration* group is
  gone. The commands themselves, and the Setup & Onboarding checklist, are unchanged.
- **Optional extensions read "Not installed" instead of showing a red fault.** CMake Tools,
  Python and clangd are optional, so when they are absent their row shows a neutral dot and the
  words *Not installed*; once installed it shows the installed version. Installing or removing
  an extension now updates Setup & Onboarding immediately, without reloading the window.
  Required extensions (C/C++, Lua) still show red when missing.

### Fixed

- **Run in Debug's "Install C/C++" offer uses this editor's own marketplace**, like every other install
  in Setup & Onboarding. If the in-app install fails, it opens the extension's page on that same
  marketplace, or says there is none, instead of failing silently. The message also explains that
  the C/C++ extension provides the C++ debugger, which is still needed while clangd provides
  IntelliSense.
- **The project's engine is taken from its direct engine path first.** O3DE records the exact engine
  a project uses as `engine_path` in `<project>/user/project.json`, and O3DE's own tools read it
  before anything else. The extension only looked at the engine *name* in `project.json` — which stops
  being unique once two registered engines share a name (for example two engines both called `o3de`),
  so a project could resolve to the wrong engine. `engine_path` now wins whenever it points at a valid
  engine; an `engine` entry in `user/project.json` overrides the name the same way O3DE merges the two;
  and projects without a `user/project.json`, or whose recorded path no longer exists, still resolve by
  name as before. This affects everything that uses the project's engine: Run / Run in Debug,
  launch.json generation, the Class Creation Wizard, Lua and C++ IntelliSense, and the environment
  report, which now also shows the recorded engine path and where the engine resolved to.
- **Go to Definition now reaches your source engine in hand-built workspaces.** When a
  project builds against a prebuilt SDK engine, the extension redirects engine include paths
  to a source engine you keep in the workspace, so F12 lands on real `.cpp` files instead of
  dead-ending in the SDK's headers (an SDK install ships headers only). That redirect only
  recognised the source-engine folder by the name the **Setup Workspace** command gives it
  (`Engine (source): …`). A workspace you assembled yourself — or one created before that
  naming existed — names the folder plainly, so the redirect silently did nothing and
  engine symbols kept resolving into the SDK. The source engine is now identified by what it
  **is**: a workspace folder whose `engine.json` does not declare `sdk_engine: true`. Folder
  names no longer matter. When several source engines are present, an `Engine (source): …`
  name still breaks the tie. Re-run **O3DE: Generate C++ IntelliSense** to pick it up.
- **Dead `C_Cpp.default.compileCommands` entries are cleared.** Older setups pointed the C/C++
  extension at a separate non-unity build's `compile_commands.json`. Once that build tree is
  gone the setting can never be used and only adds noise alongside the extension's live
  IntelliSense provider. When the extension generates or refreshes C++ IntelliSense for a
  project, it now removes entries whose file **no longer exists**. **This edits your
  workspace settings** (the `.code-workspace` file and each folder's `.vscode/settings.json`);
  each removal is logged to the O3DE output channel. It is deliberately conservative: only
  entries pointing at a missing file are removed, entries containing unresolved `${…}`
  variables are kept, and your user-wide settings are never touched.
- **Engine source no longer shows live code as inactive.** Files that no single build target
  owns — engine source you reach through the source-engine redirect, gems that aren't enabled
  in the project — got a fallback built from the defines of **every** target combined. On a
  real project that meant contradictory macros all at once: over a dozen different
  `O3DE_GEM_NAME` values, and a headless-server flag that made the C/C++ extension grey out
  client-side code (for example the `#if !O3DE_HEADLESS_SERVER` blocks in
  `GameApplication.cpp`) as if it were never compiled. The fallback now keeps only the defines
  that **every** target agrees on — the build configuration and platform baseline — while
  still offering every include path, so headers resolve exactly as before. Files a single
  target owns are unaffected.
- **Headers listed by an interface-only target no longer lose all IntelliSense.** A target that
  only lists headers without compiling anything (such as a gem's `.API` target) could overwrite
  those headers' configuration with an empty one, leaving every `#include` in them unresolved.
  Only targets that actually compile now decide a file's configuration.
- **Installing an extension from Setup & Onboarding uses your editor's own marketplace.** The
  install always ran through the editor's built-in extension marketplace, but when it failed the
  fallback opened the Visual Studio Marketplace — the wrong store for VSCodium and other
  VS Code-based editors, which use Open VSX. The fallback now opens the extension's page on the
  marketplace your editor is actually configured with (read from the editor's own settings, and
  honouring `VSCODE_GALLERY_ITEM_URL`), and the install message names that marketplace.
- **The optional Clang / LLVM row no longer shows red when Clang isn't installed.** It was the only
  optional tool that did; it now reads **Not installed** on a neutral dot, like the rest. It also
  recognises an LLVM install in its default folder (`C:\Program Files\LLVM\bin`) that isn't on your
  PATH — winget's LLVM package has been reported not to add itself — which the Clang + Ninja build
  can't use, because it looks `clang` up on PATH. That row reads **Installed · not on PATH** with an
  **Add LLVM to PATH** button, which adds the folder to your *user* PATH (no administrator rights; an
  existing entry is left alone). Quit and reopen the editor afterwards so builds can find clang.
  Note: *Clang / LLVM* is the compiler, used only if you build with Clang; the *clangd* row is the
  language server for IntelliSense. They are separate installs, and neither provides the other.

## [0.2.3] — 2026-09-02

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
