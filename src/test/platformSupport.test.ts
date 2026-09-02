// ============================================================================
//  Platform support gate — the Linux toggle's default and its legacy alias.
//
//  Reads real VS Code configuration (the test host's global scope), so it proves
//  the package.json declarations and the resolution order together.
// ============================================================================

import * as assert from "assert";
import * as vscode from "vscode";
import {
  isLinuxSupportEnabled,
  isPlatformToolsEnabled,
  LINUX_SUPPORT_SETTING,
  LEGACY_LINUX_SUPPORT_SETTING,
} from "../platform/platformSupport";

async function setGlobal(key: string, value: boolean | undefined): Promise<void> {
  await vscode.workspace.getConfiguration("o3de").update(key, value, vscode.ConfigurationTarget.Global);
}

suite("platformSupport — Linux toggle", () => {
  teardown(async () => {
    await setGlobal(LINUX_SUPPORT_SETTING, undefined);
    await setGlobal(LEGACY_LINUX_SUPPORT_SETTING, undefined);
  });

  test("Linux support is ON when nothing is set", () => {
    assert.strictEqual(isLinuxSupportEnabled(), true);
  });

  test("the toggle turns it off", async () => {
    await setGlobal(LINUX_SUPPORT_SETTING, false);
    assert.strictEqual(isLinuxSupportEnabled(), false);
  });

  test("a leftover experimental opt-out is still honoured", async () => {
    await setGlobal(LEGACY_LINUX_SUPPORT_SETTING, false);
    assert.strictEqual(isLinuxSupportEnabled(), false);
  });

  test("the current key wins over the deprecated one", async () => {
    await setGlobal(LEGACY_LINUX_SUPPORT_SETTING, false);
    await setGlobal(LINUX_SUPPORT_SETTING, true);
    assert.strictEqual(isLinuxSupportEnabled(), true);
  });

  test("Windows is always on; the toggle only governs Linux", async () => {
    await setGlobal(LINUX_SUPPORT_SETTING, false);
    if (process.platform === "win32") {
      assert.strictEqual(isPlatformToolsEnabled(), true);
    } else if (process.platform === "linux") {
      assert.strictEqual(isPlatformToolsEnabled(), false);
    } else {
      assert.strictEqual(isPlatformToolsEnabled(), false); // macOS — not a target yet
    }
  });

  test("with nothing set, tooling is active on both supported platforms", () => {
    const expected = process.platform === "win32" || process.platform === "linux";
    assert.strictEqual(isPlatformToolsEnabled(), expected);
  });
});
