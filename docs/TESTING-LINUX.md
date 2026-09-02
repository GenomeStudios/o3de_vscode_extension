# Linux Test Protocol — O3DE Development Tools

Linux is a supported platform and its paths are **on by default** — nothing to enable.
The extension is still developed on Windows, though, so **Linux users are the only ones
who can confirm the behaviour on real hardware.** This checklist walks the whole loop;
each step says what you should see and what to send back if it differs. Use it to
validate a new release, or to narrow down a Linux issue before filing it.

Please work top to bottom. If a step fails, **don't stop** — note it, run
**O3DE: Copy Environment Report** (step 0), and continue where you can. Partial
results are still useful.

---

## What you need

- Linux (Ubuntu 22.04 LTS or newer is the primary target; other distros welcome —
  tell us which).
- A working O3DE engine + a project you can already build **from the command line**
  (this protocol tests the VS Code layer, not your engine install).
- VS Code, plus the C/C++ extension (`ms-vscode.cpptools`) and, for Lua steps, the
  Lua language server (`sumneko.lua`).
- The extension — from the Marketplace / Open VSX, or a `.vsix` we sent you.

## Setup

1. Install it (skip if you have it from the Marketplace):
   ```bash
   code --install-extension o3de-development-tools-<version>.vsix
   ```
2. Open your O3DE **project folder** (the one with `project.json`) in VS Code.
3. Nothing to turn on — the Linux paths are active by default. If the build/run
   commands say Linux support is *turned off*, someone set **O3DE ▸ Linux Support**
   (`o3de.linuxSupport`) to false in this project's `.vscode/settings.json`; set it
   back to true.
4. Reload the window (Ctrl+Shift+P ▸ *Developer: Reload Window*).

---

## Step 0 — Baseline report (do this first)

Run **O3DE: Copy Environment Report** (Ctrl+Shift+P). It copies a Markdown snapshot
to your clipboard. **Paste it into the tracking issue / Slack thread now.** This is
your baseline and tells us your OS, compilers, engine layout, and resolved paths.

> Re-run this command any time a later step fails and paste the fresh copy with the
> failure — it's the single most useful thing you can send.

Expected: an info toast *"environment report copied…"* and the report also appears
in the **O3DE Development Tools** Output channel.

---

## The loop

For each step: do the action, compare to **Expected**, and if it differs, file it as
`Step N — <what happened>` with a fresh environment report + the **O3DE Development
Tools** Output channel contents.

| # | Action | Expected |
|---|--------|----------|
| 1 | Open the O3DE sidebar ▸ Onboarding | gcc (or clang), CMake, Ninja show green. **No** Visual Studio / Windows SDK / long-paths rows. |
| 2 | **O3DE: Configure Project** | Runs `cmake -G "Ninja Multi-Config" …` in a terminal; finishes without an MSVC/vcvars error; a `build/linux` tree appears. |
| 3 | **O3DE: Build** (pick a small target, e.g. the Editor) | Compiles; on error, the failures are listed, not swallowed. |
| 4 | **O3DE: Run** (target = Editor) | The Editor launches (note: no `.exe`). |
| 5 | **O3DE: Run** again (or Stop) | The app **and its helpers** exit — no orphaned Editor / AssetProcessor left running (check `ps aux \| grep -i editor`). |
| 6 | Open a project `.cpp`; hover an `AZ::` type after indexing settles | Completion + hover work; no "cannot open source file" storm and no MSVC-mode misparse. |
| 7 | **O3DE: Run in Debug (C++)**, set a breakpoint in your gameplay code | Launches under gdb; the breakpoint is hit. |
| 8 | **O3DE: Generate Lua IntelliSense** (Editor must build first) | Produces `user/lua_symbols.json`; completions appear in a `.lua` file; the Lua Palette populates. |
| 9 | Start **O3DE: Debug Lua** while the Editor/GameLauncher runs (RemoteTools gem on) | Attaches; a breakpoint in a Lua script is hit. |
| 10 | **O3DE: Class Creation Wizard** | The PySide wizard window opens and scaffolds a component into the project. |

---

## Known-not-done (don't report these)

- **AZ type visualisation in the C++ debugger** (the natvis/pretty-printer nicety) is
  not wired for gdb yet — plain values are expected for now.
- **Auto-install of CMake/Ninja/etc.** from the Onboarding buttons — on Linux these
  point you to your package manager rather than installing for you.
- The process-guard that closes a running Editor before a build is a **no-op on
  Linux** by design (Linux doesn't lock the `.so` files the way Windows locks DLLs).

## How to report

One issue per failing step is ideal. Include:
1. The step number and what you saw.
2. A fresh **O3DE: Copy Environment Report** paste.
3. The **O3DE Development Tools** Output channel (View ▸ Output ▸ pick it from the
   dropdown ▸ select-all ▸ copy).
4. Your distro + compiler versions (the report has these, but a one-liner helps).

Thank you — every step you can confirm shrinks what we're guessing at.
