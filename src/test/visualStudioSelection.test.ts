// ============================================================================
//  Visual Studio selection (#38) — the vscode-side seam, the guard's alerts, the
//  picker's rows and the build-tree mismatch warning.
//
//  Reads and writes the real `o3de.build.visualStudio` setting in the test host's
//  USER scope (restored afterwards), so it proves package.json's declaration and
//  the seam together. The installs are fakes: the machine's real Visual Studios
//  must not decide the result.
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { commandOutput } from "../build/commandOutput";
import { EXTENSION_ID } from "../constants";
import { log } from "../log";
import { ToolchainEnv, warnIfCompilerMismatch } from "../build/toolchain";
import { selectVisualStudio, vsPickItems } from "../env/selectVisualStudio";
import { VisualStudioInstall, VsPreference } from "../env/visualStudio";
import { checkInstalls } from "../env/visualStudioGuard";
import {
  describeVsSelection,
  invalidVsPreference,
  readVsPreference,
  selectInstall,
  vsPreferenceOverride,
  writeVsPreference,
} from "../env/visualStudioPreference";

// ---- Fixture ---------------------------------------------------------------
const install = (displayName: string, version: string, hasCppTools = true): VisualStudioInstall => ({
  displayName,
  installationPath: `C:\\VS\\${displayName}`,
  version,
  isPrerelease: false,
  hasCppTools,
  vcvars64Path: hasCppTools ? `C:\\VS\\${displayName}\\vcvars64.bat` : undefined,
});
const vs2019 = install("Visual Studio Community 2019", "16.11.40");
const vs2022 = install("Visual Studio Community 2022", "17.14.2");
const vs2026 = install("Visual Studio Community 2026", "18.11.12315.225");

const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("o3de");

async function setGlobal(value: string | undefined): Promise<void> {
  await config().update("build.visualStudio", value, vscode.ConfigurationTarget.Global);
}

/** Restore the user's own value of the setting once the suite is done. */
function restoreGlobalValueAfterSuite(): void {
  let original: string | undefined;
  suiteSetup(() => {
    original = config().inspect<string>("build.visualStudio")?.globalValue;
  });
  suiteTeardown(async () => {
    await setGlobal(original);
  });
}

/** Replace vscode.window's message functions with recorders; each returns a promise that never resolves. */
function recordToasts(): { calls: { severity: string; message: string; buttons: string[] }[]; restore(): void } {
  const windowApi = vscode.window as unknown as Record<string, unknown>;
  const names = ["showErrorMessage", "showWarningMessage", "showInformationMessage"];
  const originals = names.map((name) => windowApi[name]);
  const calls: { severity: string; message: string; buttons: string[] }[] = [];
  names.forEach((name) => {
    windowApi[name] = (message: string, ...buttons: string[]) => {
      calls.push({ severity: name, message, buttons });
      return new Promise<never>(() => undefined); // an unanswered toast: a caller that awaited it would hang
    };
  });
  return {
    calls,
    restore: () => names.forEach((name, i) => (windowApi[name] = originals[i])),
  };
}

// ---- The setting -------------------------------------------------------------
suite("o3de.build.visualStudio (the setting and its seam)", () => {
  restoreGlobalValueAfterSuite();

  teardown(async () => {
    await setGlobal(undefined);
  });

  test("declared in package.json: auto by default, auto + the pinnable years, resource scope", () => {
    assert.strictEqual(config().inspect<string>("build.visualStudio")?.defaultValue, "auto");
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON;
    const declared = pkg?.contributes?.configuration?.properties?.["o3de.build.visualStudio"];
    assert.ok(declared, "the setting is declared in package.json");
    assert.deepStrictEqual(declared.enum, ["auto", "2019", "2022", "2026"]);
    assert.strictEqual(declared.scope, "resource");
  });

  test("reads auto when nothing is set", () => {
    assert.strictEqual(readVsPreference(), "auto");
  });

  test("reads a set year; anything that is not a known value reads as auto", async () => {
    await setGlobal("2022");
    assert.strictEqual(readVsPreference(), "2022");
    await setGlobal("2030");
    assert.strictEqual(readVsPreference(), "auto");
  });

  test("an invalid stored value still reads as auto, but is logged once and flagged on the dashboard line", async () => {
    const channel = log() as unknown as { warn: (...args: unknown[]) => void };
    const originalWarn = channel.warn;
    const warnings: string[] = [];
    channel.warn = (message: unknown) => {
      if (String(message).startsWith("o3de.build.visualStudio is ")) {
        warnings.push(String(message)); // the extension's own background refreshes may log other warnings meanwhile
      }
    };
    try {
      // The extension's own background refresh may replace the remembered installs; set them again before each look.
      const described = (): string => {
        selectInstall([vs2022, vs2026]);
        return describeVsSelection();
      };
      assert.strictEqual(invalidVsPreference(), undefined, "nothing invalid while the setting is unset");

      // What a mistyped settings.json holds: an unquoted number, and a year that cannot be pinned. Written as-is.
      await config().update("build.visualStudio", 2022, vscode.ConfigurationTarget.Global);
      assert.strictEqual(readVsPreference(), "auto");
      assert.strictEqual(readVsPreference(), "auto");
      assert.strictEqual(invalidVsPreference(), "2022", "JSON-quoted: the number, not the string");
      assert.strictEqual(described(), "Auto (invalid setting 2022) -> Visual Studio Community 2026");
      assert.strictEqual(warnings.length, 1, "once per bad value, however often it is read");
      assert.match(warnings[0], /o3de\.build\.visualStudio is 2022, which is not "auto", "2019", "2022" or "2026"/);

      await setGlobal("2025");
      assert.strictEqual(described(), 'Auto (invalid setting "2025") -> Visual Studio Community 2026');
      assert.strictEqual(warnings.length, 2, "a different bad value warns again");

      await setGlobal("2022"); // a good value ends the episode ...
      assert.strictEqual(invalidVsPreference(), undefined);
      assert.strictEqual(described(), "2022 -> Visual Studio Community 2022");
      await config().update("build.visualStudio", 2022, vscode.ConfigurationTarget.Global);
      assert.strictEqual(readVsPreference(), "auto"); // ... so the same bad value warns again after it
      assert.strictEqual(warnings.length, 3);
    } finally {
      channel.warn = originalWarn;
    }
  });

  test("writing saves to the USER settings and reports the value in force", async () => {
    const written = await writeVsPreference("2019");
    assert.deepStrictEqual(written, { effective: "2019", overriddenBy: undefined });
    assert.strictEqual(config().inspect<string>("build.visualStudio")?.globalValue, "2019");
    assert.strictEqual(vsPreferenceOverride(), undefined, "no workspace or folder value in the test host");
    assert.strictEqual(readVsPreference(), "2019");
  });

  test("selectInstall applies the selection to the given installs", async () => {
    const all = [vs2019, vs2022, vs2026];
    assert.strictEqual(selectInstall(all), vs2026, "auto = newest");
    await setGlobal("2022");
    assert.strictEqual(selectInstall(all), vs2022);
    await setGlobal("2019");
    assert.strictEqual(selectInstall([vs2022, vs2026]), undefined, "a pinned year that is not installed selects nothing");
  });

  test("describeVsSelection: what the dashboard row shows, read live from the setting", async () => {
    selectInstall([vs2019, vs2022, vs2026]);
    assert.strictEqual(describeVsSelection(), "Auto -> Visual Studio Community 2026");
    await setGlobal("2022");
    assert.strictEqual(describeVsSelection(), "2022 -> Visual Studio Community 2022", "no new detection needed");
    selectInstall([vs2026]);
    assert.strictEqual(describeVsSelection(), "2022 (not installed)");
    await setGlobal(undefined);
    selectInstall([]);
    assert.strictEqual(describeVsSelection(), "Auto (none found)");
  });
});

// ---- The guard: alerts, strictness, headless parity ---------------------------
suite("checkInstalls (the guard)", () => {
  restoreGlobalValueAfterSuite();
  let toasts: ReturnType<typeof recordToasts>;

  setup(() => {
    toasts = recordToasts();
  });

  teardown(async () => {
    toasts.restore();
    await setGlobal(undefined);
  });

  test("auto picks the newest and logs it; no toast unless interactive", () => {
    const check = checkInstalls([vs2022, vs2026], { interactive: false });
    assert.strictEqual(check.install, vs2026);
    assert.strictEqual(check.problem, undefined);
    assert.strictEqual(toasts.calls.length, 0);
  });

  test("the interactive check shows its success toast without waiting for it; quiet does not show it", () => {
    checkInstalls([vs2026], { interactive: true });
    assert.deepStrictEqual(toasts.calls.map((c) => c.severity), ["showInformationMessage"]);
    toasts.calls.length = 0;
    checkInstalls([vs2026], { interactive: true, quiet: true });
    assert.strictEqual(toasts.calls.length, 0);
  });

  test("a pin is honoured over a newer install", async () => {
    await setGlobal("2022");
    assert.strictEqual(checkInstalls([vs2022, vs2026], { interactive: false }).install, vs2022);
  });

  test("a pinned year that is not installed is strict: no install, the reason, and a toast offering the picker", async () => {
    await setGlobal("2022");
    const check = checkInstalls([vs2026], { interactive: false });
    assert.strictEqual(check.install, undefined, "never falls back to another Visual Studio");
    assert.strictEqual(
      check.problem,
      "Visual Studio 2022 is selected (o3de.build.visualStudio) but not installed. Found: Visual Studio Community 2026.",
    );
    assert.strictEqual(toasts.calls.length, 1);
    assert.strictEqual(toasts.calls[0].severity, "showErrorMessage");
    assert.deepStrictEqual(toasts.calls[0].buttons, ["Select Visual Studio Version"]);
  });

  test("headless (quiet): the same answer, never a toast of any kind", async () => {
    await setGlobal("2022");
    const missing = checkInstalls([vs2026], { interactive: false, quiet: true });
    assert.strictEqual(missing.install, undefined);
    assert.ok(missing.problem);
    const none = checkInstalls([], { interactive: false, quiet: true });
    assert.strictEqual(none.problem, "No Visual Studio installation was found.");
    const noCpp = checkInstalls([install("Visual Studio Community 2022", "17.14.2", false)], { interactive: false, quiet: true });
    assert.strictEqual(noCpp.problem, "Visual Studio Community 2022 lacks the MSVC C++ toolset.");
    assert.strictEqual(toasts.calls.length, 0);
  });

  test("a pinned install without the C++ tools is returned with the problem, and a warning toast unless quiet", async () => {
    await setGlobal("2022");
    const noCpp = install("Visual Studio Community 2022", "17.14.2", false);
    const check = checkInstalls([noCpp, vs2026], { interactive: false });
    assert.strictEqual(check.install, noCpp);
    assert.match(check.problem ?? "", /lacks the MSVC C\+\+ toolset/);
    assert.deepStrictEqual(toasts.calls.map((c) => c.severity), ["showWarningMessage"]);
  });

  test("nothing installed: the error toast offers the download", () => {
    checkInstalls([], { interactive: false });
    assert.deepStrictEqual(toasts.calls.map((c) => [c.severity, c.buttons]), [["showErrorMessage", ["Download Visual Studio"]]]);
  });
});

// ---- The picker ----------------------------------------------------------------
suite("Select Visual Studio picker", () => {
  const all = [vs2019, vs2022, vs2026];

  test("Auto (newest) first, saying what it resolves to; then one row per detected install", () => {
    const items = vsPickItems(all, "auto");
    assert.strictEqual(items.length, 4);
    assert.strictEqual(items[0].preference, "auto");
    assert.match(items[0].description ?? "", /now Visual Studio Community 2026/);
    assert.deepStrictEqual(items.slice(1).map((i) => i.label), all.map((i) => i.displayName));
    assert.deepStrictEqual(items.slice(1).map((i) => i.detail), all.map((i) => i.installationPath));
    assert.deepStrictEqual(items.slice(1).map((i) => i.preference), ["2019", "2022", "2026"]);
  });

  test("the row in force is marked (current): Auto when auto, the install when pinned", () => {
    const current = (preference: VsPreference): string[] =>
      vsPickItems(all, preference)
        .filter((i) => i.description?.includes("(current)"))
        .map((i) => i.preference as string);
    assert.deepStrictEqual(current("auto"), ["auto"]);
    assert.deepStrictEqual(current("2022"), ["2022"]);
  });

  test("an install without the C++ tools says so", () => {
    const items = vsPickItems([install("Visual Studio Build Tools 2022", "17.9.0", false)], "auto");
    assert.match(items[1].description ?? "", /17\.9\.0 · no C\+\+ tools/);
  });

  test("an install whose year cannot be pinned (2017) has no preference and says so", () => {
    const items = vsPickItems([install("Visual Studio Community 2017", "15.9.1")], "auto");
    assert.strictEqual(items[1].preference, undefined);
    assert.match(items[1].description ?? "", /cannot be selected/);
  });

  test("with nothing installed there is still Auto, saying none was found", () => {
    const items = vsPickItems([], "auto");
    assert.strictEqual(items.length, 1);
    assert.match(items[0].description ?? "", /no Visual Studio found/);
  });

  test("the command is registered", async () => {
    assert.ok((await vscode.commands.getCommands(true)).includes("o3de.selectVisualStudio"));
    assert.strictEqual(typeof selectVisualStudio, "function");
  });
});

// ---- Build tree vs. selected Visual Studio -------------------------------------
suite("warnIfCompilerMismatch (build tree vs. selected Visual Studio)", () => {
  let buildDir: string;
  let lines: string[];
  let restoreChannel: () => void;

  const toolchain = (installationPath: string): ToolchainEnv => ({
    ok: true,
    env: {},
    label: "MSVC",
    visualStudio: { displayName: "Visual Studio Community 2022", installationPath },
  });
  const writeCache = (compiler: string): void =>
    fs.writeFileSync(path.join(buildDir, "CMakeCache.txt"), `CMAKE_CXX_COMPILER:FILEPATH=${compiler}\n`);
  const cl = (root: string): string => `${root.replace(/\\/g, "/")}/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/cl.exe`;
  const root2022 = "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community";
  const root2026 = "C:\\Program Files\\Microsoft Visual Studio\\18\\Community";

  setup(() => {
    buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-vs-mismatch-"));
    lines = [];
    const channel = commandOutput() as unknown as { appendLine: (line: string) => void };
    const original = channel.appendLine;
    channel.appendLine = (line: string) => void lines.push(line);
    restoreChannel = () => {
      channel.appendLine = original;
    };
  });

  teardown(() => {
    restoreChannel();
    fs.rmSync(buildDir, { recursive: true, force: true });
  });

  test("a tree configured with another Visual Studio gets one warning line in the Build Output", () => {
    writeCache(cl(root2026));
    warnIfCompilerMismatch(buildDir, toolchain(root2022));
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].startsWith(`${buildDir} was configured with ${cl(root2026)}; the selected Visual Studio is Visual Studio Community 2022.`));
    assert.match(lines[0], /delete CMakeCache\.txt and CMakeFiles and Configure/);
  });

  test("silent when the cached compiler belongs to the selected install", () => {
    writeCache(cl(root2022));
    warnIfCompilerMismatch(buildDir, toolchain(root2022));
    assert.deepStrictEqual(lines, []);
  });

  test("silent for a non-MSVC compiler, an unconfigured tree, and a toolchain with no Visual Studio", () => {
    writeCache("C:/Program Files/LLVM/bin/clang-cl.exe");
    warnIfCompilerMismatch(buildDir, toolchain(root2022));
    fs.rmSync(path.join(buildDir, "CMakeCache.txt"));
    warnIfCompilerMismatch(buildDir, toolchain(root2022));
    writeCache(cl(root2026));
    warnIfCompilerMismatch(buildDir, { ok: true, env: {}, label: "Clang" });
    assert.deepStrictEqual(lines, []);
  });
});
