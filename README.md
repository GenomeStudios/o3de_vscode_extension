# O3DE Development Tools

A developer companion for [Open 3D Engine (O3DE)](https://o3de.org) in Visual Studio Code.

> ⚠️ **Early days.** Scope and features are actively evolving. **Windows** (MSVC) and
> **Linux** (gcc/clang) are both supported — the full build / run / debug loop works on
> each, out of the box, no flag to flip. See [Requirements](#requirements). macOS is not
> supported yet.

Everything is driven from a single **O3DE Development Tools** panel in the activity bar: a Dashboard
with live status, Build/Run, utilities, and collapsible Configuration & Onboarding sections, plus a
**Lua Palette** and an **Advanced** view.

## Features

- **Per-project opt-in** — the extension's automatic behavior runs only in projects you enable
  (a one-time prompt the first time you open an O3DE project; stored in `.vscode/settings.json`). A
  non-O3DE workspace (e.g. web development) stays completely dormant.
- **Guided workspace setup** — assemble the multi-root workspace (project + engine source + gems)
  into a `.code-workspace`, with `.vscode` settings generated for you. **Add Gems / Folders** adds
  more roots to the live workspace on demand.
- **Build toolchain, Windows and Linux** — on **Windows**, auto-detects Visual Studio and opens a
  developer terminal with the MSVC environment established, and detects Ninja (offering to install
  it). On **Linux**, builds use gcc/clang + Ninja Multi-Config inherited from your shell — no MSVC
  needed. The Onboarding panel checks whichever toolchain your OS actually uses.
- **One-click CMake configure & build** — selectable generator, config, and target(s), mirroring
  O3DE's build flow, with a process-guard for locked build outputs.
- **Run & force-quit** — launch the Editor or the project's GameLauncher (with custom launch
  options) and stop the whole process tree (AssetProcessor and friends included). Run is a toggle:
  pressing it (or `Ctrl+Alt+R`) while the app is up force-quits it (configurable).
- **Advanced CMake flags** — an **Advanced** view manages extra `-D` cache variables passed to
  Configure (curated toggles for RenderDoc / `CMAKE_OBJECT_PATH_MAX`, plus any custom flag), stored
  per-project and applied on the next reconfigure.
- **LLM connections (MCP)** — an opt-in localhost [MCP](https://modelcontextprotocol.io) endpoint so
  an assistant like Claude can build, run, check run-state, read structured build results, and
  read/change build config — per-project, off by default, localhost-bound.
- **Class Creation Wizard** — launch O3DE's component/EBus class-scaffolding tool for the project's
  engine straight from the panel.
- **C++ IntelliSense** — generates `c_cpp_properties.json` from the CMake File API and registers a
  live cpptools configuration provider; engine paths resolve to your source engine.
- **Project config generation** — `.vscode` `settings.json` + `launch.json` (Editor / GameLauncher /
  Attach / Class Creation Wizard) + O3DE code snippets.
- **Quick access** — Editor / Error logs, the extension output channel, and keybindings for Build
  (`Ctrl+Alt+B`) and Run (`Ctrl+Alt+R`).
- **Lua debugging** — a full Debug Adapter that speaks O3DE's RemoteTools protocol natively (no
  companion gem): breakpoints, stepping, call stack, locals, watch, and edit-value, against a
  running Editor or GameLauncher. Plus an **"Open in VS Code" handoff** so the Editor's *Tools ▸ Lua
  Editor* and a Script component's *Edit* button open scripts here.
- **Lua IntelliSense** — *O3DE: Generate Lua IntelliSense* dumps the engine's reflected scripting API
  (classes, EBuses, globals) and generates LuaLS (sumneko) annotation stubs, so `.lua` scripts get
  typed completion and hovers for the O3DE API — offline, no running Editor needed after the dump.
- **Lua function palette** — a browsable, searchable *Classes / EBuses / Globals* tree in the O3DE
  activity bar (the VS Code equivalent of the Lua IDE's Class Reference panel). Click a symbol to
  insert a call snippet. Opens automatically when O3DE hands a script over.

### Debugging Lua

1. Run **O3DE: Register VS Code as Lua Editor** once (writes `/O3DE/Lua/Debugger/Uri` into your
   project's registry). Restart the Editor. Now "Open Lua Editor" in O3DE opens the script here.
2. Open a `.lua` file, set breakpoints, and click **Debug Lua File** (the ▷ in the editor title bar)
   or press F5 with the *O3DE: Attach to Lua* configuration.
3. Start your game (Editor Game Mode, or the GameLauncher). It connects to VS Code automatically and
   breakpoints hit.

Requires a **non-Release** Editor/Launcher build with the **RemoteTools gem** enabled (the default in
O3DE's standard project templates). Debugging is localhost-only, one target at a time.

### Lua IntelliSense & palette

Run **O3DE: Generate Lua IntelliSense** — it launches the Editor headless, dumps the reflected API to
`<project>/user/lua_symbols.json`, generates `.vscode/o3de-lua-stubs/o3de_api.lua`, and points the Lua
language server at it. (Already have a dump? **O3DE: Generate Lua Stubs From Dump** skips the Editor.)
The **Lua Palette** view in the O3DE activity bar then lets you browse and insert from the reflected API.

Requires the [Lua language server](https://marketplace.visualstudio.com/items?itemName=sumneko.lua)
(`sumneko.lua`) for completion.

New to Lua? See the step-by-step [Lua Getting Started & Verification guide](docs/lua-getting-started.md) —
it walks through authoring, attaching a script to an entity, running it, and hitting a breakpoint.

## Planned features

- **Reflection browser** — deeper inspection of reflected components and the BehaviorContext.
- **Registerable templates** (Lua, components, EBuses, gems).
- **macOS support** (Windows and Linux are supported today — see [Requirements](#requirements)).

## Requirements

A registered O3DE project and engine, plus a platform toolchain. The extension's Onboarding panel
checks these for you and helps fill the gaps.

- **Windows** — **Visual Studio 2022** (Desktop development with C++), **CMake**, and optionally
  **Ninja**.
- **Linux** — a C++ toolchain (**Clang** recommended, or **GCC**), **CMake**, and **Ninja**. Nothing
  to enable: the build / run / debug paths are active by default. `o3de.linuxSupport` can turn them
  off per project if you need to. Notes and a walkthrough live in
  [`docs/TESTING-LINUX.md`](docs/TESTING-LINUX.md). One nicety is still missing: gdb AZ-type
  pretty-printers.

macOS is not supported yet.

## Development

```bash
npm install        # install dependencies
npm run compile    # type-check + bundle to dist/extension.js
```

### Run / debug the extension (F5)

1. Open this folder in VS Code.
2. Press **F5** (Run → Start Debugging) — this runs the **"Run Extension"** config,
   which builds first, then launches a second VS Code window: the
   **Extension Development Host**, with this extension loaded.
3. In that window open the Command Palette (**Ctrl+Shift+P**) and run
   **"O3DE: Hello World"** — a notification confirms the extension is live.
4. Edit code, then use **Ctrl+Shift+F5** (Restart) in the host, or relaunch, to reload.

For continuous rebuilds while iterating, run the **watch** task (`npm run watch`) in a terminal.

### Scripts

| Command | Purpose |
|---|---|
| `npm run compile` | Type-check and bundle to `dist/` |
| `npm run watch` | Incremental rebuild on save |
| `npm run lint` | ESLint over `src/` |
| `npm test` | Run the extension test suite (downloads a test VS Code build on first run) |
| `npm run package` | Production bundle (used by `vsce` when packaging a `.vsix`) |

### Packaging a shareable build

```bash
npx vsce package   # produces o3de-development-tools-<version>.vsix
```

Install a `.vsix` locally via **Extensions view → ⋯ → Install from VSIX…**, or
`code --install-extension o3de-development-tools-<version>.vsix`.

## License

MIT © Genome Studios Inc

## Disclaimer

**This is an unofficial, community-built extension from Genome Studios Inc.** It is not an official
O3DE implementation, and is not affiliated with, endorsed by, or sponsored by the Open 3D Foundation
or the Linux Foundation. "O3DE", "Open 3D Engine", and the O3DE logo are trademarks of their
respective owners and are used here only to identify the engine this tool supports.
