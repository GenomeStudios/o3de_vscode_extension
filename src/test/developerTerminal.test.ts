// ============================================================================
//  O3DE Developer terminal (#42) -- the "O3DE Developer (MSVC)" terminal profile
//  and the options both it and the command start a terminal with.
//
//  The profile provider itself cannot be driven from the test host (VS Code owns
//  the "launch profile" call), so the pieces are proven instead: the manifest
//  declares the id the code registers, the command's terminal keeps the user's
//  default shell, the profile picks an explicit shell, and the non-Windows answer
//  is "no terminal, with a message".
// ============================================================================

import * as assert from "assert";
import * as vscode from "vscode";
import { EXTENSION_ID } from "../constants";
import {
  developerProfileOptions,
  developerTerminalOptions,
  DEVELOPER_TERMINAL_PROFILE_ID,
  provideDeveloperTerminalProfile,
  resolveDeveloperTerminalOptions,
} from "../env/developerTerminal";

// ---- The manifest ------------------------------------------------------------
suite("O3DE Developer terminal profile (manifest)", () => {
  test("package.json contributes the profile under the id the code registers", () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON;
    const profiles: { id: string; title: string; icon?: string }[] = pkg?.contributes?.terminal?.profiles ?? [];
    const profile = profiles.find((p) => p.id === DEVELOPER_TERMINAL_PROFILE_ID);
    assert.ok(profile, "contributes.terminal.profiles lists the profile");
    assert.strictEqual(DEVELOPER_TERMINAL_PROFILE_ID, "o3de.developerTerminal");
    assert.strictEqual(profile.title, "O3DE Developer (MSVC)");
  });
});

// ---- The terminal options (pure) ---------------------------------------------
suite("developerTerminalOptions", () => {
  test("names the terminal and passes the captured environment, in the user's default shell", () => {
    const env = { INCLUDE: "C:\\inc", Path: "C:\\bin" };
    const options = developerTerminalOptions(env);
    assert.strictEqual(options.name, "O3DE Developer");
    assert.strictEqual(options.env, env);
    assert.strictEqual(options.shellPath, undefined, "the command keeps the user's default shell (PowerShell, cmd...)");
  });
});

// ---- The profile's fallback --------------------------------------------------
// A profile provider that returns nothing makes VS Code open no terminal at all, which breaks every new terminal
// once the profile is the default. On Windows an unusable Visual Studio selection must degrade to a plain shell.
suite("developerProfileOptions (the profile's fallback)", () => {
  const resolved: vscode.TerminalOptions = { name: "O3DE Developer", env: { INCLUDE: "C:\\inc" } };

  test("a resolved developer terminal becomes the profile, in an explicit shell (the profile may be the default)", () => {
    const options = developerProfileOptions(resolved, "win32", "C:\\Windows\\System32\\cmd.exe");
    assert.deepStrictEqual(options, { ...resolved, shellPath: "C:\\Windows\\System32\\cmd.exe" });
    assert.strictEqual(resolved.shellPath, undefined, "the resolved options are not mutated");
    assert.strictEqual(developerProfileOptions(resolved, "win32", undefined)?.shellPath, "cmd.exe");
  });

  test("Windows, nothing resolved: a plain shell named so it is not mistaken for a working one", () => {
    const options = developerProfileOptions(undefined, "win32", "C:\\Windows\\System32\\cmd.exe");
    assert.notStrictEqual(options?.name, "O3DE Developer");
    assert.strictEqual(options?.env, undefined, "no environment is faked");
    assert.deepStrictEqual(options, { name: "O3DE Developer (no MSVC env)", shellPath: "C:\\Windows\\System32\\cmd.exe" });
  });

  test("Windows without ComSpec falls back to cmd.exe", () => {
    assert.strictEqual(developerProfileOptions(undefined, "win32", undefined)?.shellPath, "cmd.exe");
  });

  test("off Windows the profile is only ever picked by hand: nothing resolved means no profile", () => {
    assert.strictEqual(developerProfileOptions(undefined, "linux", undefined), undefined);
    assert.strictEqual(developerProfileOptions(undefined, "darwin", undefined), undefined);
  });
});

// ---- Off Windows -------------------------------------------------------------
suite("provideDeveloperTerminalProfile", () => {
  test("on Windows it always provides a profile, with the MSVC environment or with the plain fallback", async function () {
    if (process.platform !== "win32") {
      return this.skip(); // off Windows the answer is no profile (the next test)
    }
    this.timeout(30_000);
    const windowApi = vscode.window as unknown as Record<string, unknown>;
    const names = ["showErrorMessage", "showWarningMessage", "showInformationMessage"];
    const originals = names.map((name) => windowApi[name]);
    names.forEach((name) => (windowApi[name] = () => new Promise<never>(() => undefined))); // toasts are not under test
    try {
      const profile = await provideDeveloperTerminalProfile();
      assert.ok(profile, "a Windows terminal is never left without a profile");
      const options = profile.options as vscode.TerminalOptions;
      assert.ok(["O3DE Developer", "O3DE Developer (no MSVC env)"].includes(options.name ?? ""), String(options.name));
    } finally {
      names.forEach((name, i) => (windowApi[name] = originals[i]));
    }
  });

  test("off Windows it provides no profile (and says it is Windows-only)", async function () {
    if (process.platform === "win32") {
      return this.skip();
    }
    const windowApi = vscode.window as unknown as Record<string, unknown>;
    const original = windowApi["showInformationMessage"];
    windowApi["showInformationMessage"] = () => new Promise<never>(() => undefined);
    try {
      assert.strictEqual(await provideDeveloperTerminalProfile(), undefined);
    } finally {
      windowApi["showInformationMessage"] = original;
    }
  });
});

suite("resolveDeveloperTerminalOptions", () => {
  test("off Windows: no terminal, and a message saying it is Windows-only", async function () {
    if (process.platform === "win32") {
      return this.skip(); // on Windows the answer depends on the Visual Studios installed here
    }
    const windowApi = vscode.window as unknown as Record<string, unknown>;
    const original = windowApi["showInformationMessage"];
    const messages: string[] = [];
    windowApi["showInformationMessage"] = (message: string) => {
      messages.push(message);
      return new Promise<never>(() => undefined);
    };
    try {
      assert.strictEqual(await resolveDeveloperTerminalOptions(), undefined);
    } finally {
      windowApi["showInformationMessage"] = original;
    }
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /Windows-only/);
  });
});
