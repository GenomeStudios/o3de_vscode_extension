// ============================================================================
//  MSVC environment capture (#38) -- the wiring behind "a pin beats the Visual
//  Studio developer prompt VS Code was started from". vcvars64.bat is first-wins:
//  it keeps the Visual Studio variables it finds. These tests run the real
//  capture against a FAKE vcvars64.bat that behaves the same way, so they need no
//  Visual Studio install, and prove:
//    - pinned: the inherited prompt is cleared, so the called install answers;
//    - "auto": the capture is untouched, so the inherited install still wins;
//    - a pin with NO prompt inherited leaves the user's own INCLUDE/LIB alone.
//  Windows only (the capture runs cmd.exe). The process environment is shared
//  with the whole extension host, so every change is restored afterwards.
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { captureMsvcEnvironmentDelta, EnvMap } from "../env/msvcEnvironment";
import { captureSelectedMsvcEnvironment } from "../env/visualStudioPreference";

// ---- Fixture ---------------------------------------------------------------
const FROM_PROMPT = { VSINSTALLDIR: "C:\\old\\2022\\", VCToolsVersion: "14.44-old" }; // a "Developer Command Prompt for VS 2022"
const FROM_VCVARS = { VSINSTALLDIR: "C:\\new\\2026\\", VCToolsVersion: "14.51-new" }; // what the fake vcvars would set
const USER_INCLUDE = "D:\\vendor\\inc"; // a machine-wide INCLUDE that no developer prompt put there
const VCVARS_INCLUDE = "C:\\vs\\inc";

/** First-wins per variable (as vcvars is), and INCLUDE is prepended to (as vcvars does). */
const FAKE_VCVARS = [
  "@echo off",
  `if not defined VSINSTALLDIR set VSINSTALLDIR=${FROM_VCVARS.VSINSTALLDIR}`,
  `if not defined VCToolsVersion set VCToolsVersion=${FROM_VCVARS.VCToolsVersion}`,
  `set "INCLUDE=${VCVARS_INCLUDE};%INCLUDE%"`,
  "exit /b 0",
  "",
].join("\r\n");

const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("o3de");
const setGlobal = (value: string | undefined): Thenable<void> =>
  config().update("build.visualStudio", value, vscode.ConfigurationTarget.Global);

/** The value of a variable in a captured delta (Windows names are case-insensitive). */
function valueOf(env: EnvMap, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/** Set (or, with undefined, remove) variables in the real process environment for the duration of `run`. */
async function withEnvironment<T>(changes: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.keys(changes).map((name) => [name, process.env[name]] as const);
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** Every variable in this process that marks an inherited developer prompt, cleared (for the "no prompt" case). */
function clearedPromptMarkers(): Record<string, undefined> {
  const markers = Object.keys(process.env).filter((key) => /^(vsinstalldir|vcinstalldir|vscmd_.*|__vscmd_.*)$/i.test(key));
  return Object.fromEntries(markers.map((key) => [key, undefined]));
}

const suiteOnWindows = process.platform === "win32" ? suite : suite.skip;

suiteOnWindows("MSVC environment capture (a pin beats an inherited developer prompt)", function () {
  this.timeout(30_000);
  let dir: string;
  let bat: string;
  let originalSetting: string | undefined;

  suiteSetup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-fake-vcvars-"));
    bat = path.join(dir, "vcvars64.bat");
    fs.writeFileSync(bat, FAKE_VCVARS);
    originalSetting = config().inspect<string>("build.visualStudio")?.globalValue;
  });

  suiteTeardown(async () => {
    await setGlobal(originalSetting);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  teardown(async () => {
    await setGlobal(undefined);
  });

  // ---- The capture itself ----------------------------------------------------
  test("scrubInherited: the called install's variables replace the inherited prompt's", async () => {
    const delta = await withEnvironment(FROM_PROMPT, () => captureMsvcEnvironmentDelta(bat, { scrubInherited: true }));
    assert.strictEqual(valueOf(delta, "VSINSTALLDIR"), FROM_VCVARS.VSINSTALLDIR);
    assert.strictEqual(valueOf(delta, "VCToolsVersion"), FROM_VCVARS.VCToolsVersion);
  });

  test("without scrubInherited the inherited prompt wins (first-wins): nothing of the called install is applied", async () => {
    const delta = await withEnvironment(FROM_PROMPT, () => captureMsvcEnvironmentDelta(bat));
    assert.strictEqual(valueOf(delta, "VSINSTALLDIR"), undefined);
    assert.strictEqual(valueOf(delta, "VCToolsVersion"), undefined);
  });

  // ---- The selection wiring --------------------------------------------------
  test("captureSelectedMsvcEnvironment: auto leaves the capture alone, a pinned year clears the inherited prompt", async () => {
    await withEnvironment(FROM_PROMPT, async () => {
      await setGlobal(undefined); // auto
      const auto = await captureSelectedMsvcEnvironment(bat);
      assert.strictEqual(valueOf(auto, "VSINSTALLDIR"), undefined, "auto: the inherited install still wins, exactly as before");

      for (const year of ["2019", "2022", "2026"]) {
        await setGlobal(year);
        const pinned = await captureSelectedMsvcEnvironment(bat);
        assert.strictEqual(valueOf(pinned, "VSINSTALLDIR"), FROM_VCVARS.VSINSTALLDIR, `pinned ${year}`);
        assert.strictEqual(valueOf(pinned, "VCToolsVersion"), FROM_VCVARS.VCToolsVersion, `pinned ${year}`);
      }
    });
  });

  test("a pin with no developer prompt inherited keeps the user's own INCLUDE, exactly as auto does", async () => {
    await withEnvironment({ ...clearedPromptMarkers(), INCLUDE: USER_INCLUDE }, async () => {
      const expected = `${VCVARS_INCLUDE};${USER_INCLUDE}`;
      await setGlobal(undefined);
      assert.strictEqual(valueOf(await captureSelectedMsvcEnvironment(bat), "INCLUDE"), expected, "auto");
      await setGlobal("2022");
      assert.strictEqual(valueOf(await captureSelectedMsvcEnvironment(bat), "INCLUDE"), expected, "pinned 2022");
    });
  });
});
