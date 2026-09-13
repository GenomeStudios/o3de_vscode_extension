// ============================================================================
//  clangd server resolution + the staged clangd onboarding row.
//
//  The resolver must agree with how the clangd extension finds its server. The real
//  dev-machine value is the absolute path clangd's own installer writes back:
//  …\globalStorage\llvm-vs-code-extensions.vscode-clangd\install\22.1.6\clangd_22.1.6\bin\clangd.exe
// ============================================================================

import * as assert from "assert";
import { resolveClangdExecutable, substituteClangdVariables, ClangdResolveContext } from "../deps/clangdServer";
import { buildOnboardingModel, resolveGuidedAction } from "../deps/registry";

const DOWNLOADED = "C:\\Users\\u\\AppData\\Roaming\\Code\\User\\globalStorage\\llvm-vs-code-extensions.vscode-clangd\\install\\22.1.6\\clangd_22.1.6\\bin\\clangd.exe";

function windows(files: string[], env: Record<string, string> = {}, workspaceRoot = "D:\\OffLocalDev\\gs_play"): ClangdResolveContext {
  const present = new Set(files.map((f) => f.toLowerCase()));
  return { env, platform: "win32", home: "C:\\Users\\u", workspaceRoot, exists: (f) => present.has(f.toLowerCase()) };
}

// ---- Variables ---------------------------------------------------------------
suite("clangdServer.substituteClangdVariables", () => {
  test("the variables the clangd extension supports", () => {
    const context = windows([], { LLVM: "C:\\LLVM" });
    assert.strictEqual(substituteClangdVariables("${userHome}\\bin\\clangd.exe", context), "C:\\Users\\u\\bin\\clangd.exe");
    assert.strictEqual(substituteClangdVariables("${workspaceFolder}\\tools\\clangd.exe", context), "D:\\OffLocalDev\\gs_play\\tools\\clangd.exe");
    assert.strictEqual(substituteClangdVariables("${workspaceRoot}|${cwd}|${workspaceFolderBasename}", context), "D:\\OffLocalDev\\gs_play|D:\\OffLocalDev\\gs_play|gs_play");
    assert.strictEqual(substituteClangdVariables("${env:LLVM}\\bin\\clangd.exe", context), "C:\\LLVM\\bin\\clangd.exe");
  });

  test("${config:…} and ${command:…} stay unresolved — probing never runs a command", () => {
    assert.strictEqual(substituteClangdVariables("${command:pick.clangd}", windows([])), "${command:pick.clangd}");
  });
});

// ---- Resolution --------------------------------------------------------------
suite("clangdServer.resolveClangdExecutable", () => {
  test("the absolute path clangd's own installer writes back → found", () => {
    assert.strictEqual(resolveClangdExecutable(DOWNLOADED, windows([DOWNLOADED])), DOWNLOADED);
  });

  test("that path after the download folder was removed → not found (stage 2)", () => {
    assert.strictEqual(resolveClangdExecutable(DOWNLOADED, windows([])), undefined);
  });

  test("default bare 'clangd' is looked up on PATH with PATHEXT", () => {
    const context = windows(["C:\\LLVM\\bin\\clangd.EXE"], { PATH: "C:\\Windows;C:\\LLVM\\bin", PATHEXT: ".COM;.EXE" });
    assert.strictEqual(resolveClangdExecutable("clangd", context), "C:\\LLVM\\bin\\clangd.EXE");
  });

  test("an empty setting behaves like the default 'clangd'", () => {
    const context = windows(["C:\\LLVM\\bin\\clangd.exe"], { PATH: "C:\\LLVM\\bin", PATHEXT: ".EXE" });
    assert.ok(resolveClangdExecutable("  ", context));
  });

  test("on PATH: a clangd.exe wins over a same-named extensionless entry", () => {
    const context = windows(["C:\\tools\\clangd", "C:\\tools\\clangd.exe"], { PATH: "C:\\tools", PATHEXT: ".EXE" });
    // Windows paths are case-insensitive: the PATHEXT casing (".EXE") names the same file.
    assert.strictEqual(resolveClangdExecutable("clangd", context)?.toLowerCase(), "c:\\tools\\clangd.exe");
  });

  test("a relative path with a slash sits under the workspace root", () => {
    const context = windows(["D:\\OffLocalDev\\gs_play\\tools\\clangd.exe"]);
    assert.strictEqual(resolveClangdExecutable("tools/clangd.exe", context), "D:\\OffLocalDev\\gs_play\\tools\\clangd.exe");
  });

  test("a variable that can't be resolved can't name a real file", () => {
    assert.strictEqual(resolveClangdExecutable("${config:my.clangd}", windows(["${config:my.clangd}"])), undefined);
  });

  test("not on PATH at all → not found", () => {
    assert.strictEqual(resolveClangdExecutable("clangd", windows([], { PATH: "C:\\Windows", PATHEXT: ".EXE" })), undefined);
  });

  test("linux: bare name on PATH, no extension games", () => {
    const context: ClangdResolveContext = {
      env: { PATH: "/usr/local/bin:/usr/bin" },
      platform: "linux",
      home: "/home/u",
      exists: (f) => f === "/usr/bin/clangd",
    };
    assert.strictEqual(resolveClangdExecutable("clangd", context), "/usr/bin/clangd");
  });
});

// ---- The staged row ----------------------------------------------------------
suite("onboarding: staged clangd row", () => {
  const serverStep = { label: "Download clangd server…", kind: "command" as const, payload: "clangd.activate" };
  const row = (result: Parameters<typeof resolveGuidedAction>[1]) =>
    buildOnboardingModel(result ? { clangd: result } : {}, "cpp", "win32").optionals.find((v) => v.id === "clangd")!;

  test("stage 1 — extension not installed: 'Not installed', the check's own Install clangd action", () => {
    const view = row({ state: "absent", detail: "Not installed" });
    assert.strictEqual(view.actionLabel, "Install clangd");
    assert.strictEqual(view.staged, false);
    assert.strictEqual(resolveGuidedAction("clangd", { state: "absent" }).action?.payload, "llvm-vs-code-extensions.vscode-clangd");
  });

  test("stage 2 — extension installed, no server: the row names the server step and says why", () => {
    const result = { state: "warn" as const, detail: "Extension installed · clangd server not found", action: serverStep };
    const view = row(result);
    assert.strictEqual(view.staged, true);
    assert.strictEqual(view.actionLabel, "Download clangd server…");
    assert.strictEqual(view.detail, "Extension installed · clangd server not found");
  });

  test("stage 2's click runs clangd's own startup (clangd.activate) — not our install", () => {
    const result = { state: "warn" as const, detail: "…", action: serverStep };
    assert.deepStrictEqual(resolveGuidedAction("clangd", result).action, serverStep);
  });

  test("stage 3 — both present: done, with the server version", () => {
    const view = row({ state: "ok", detail: "clangd 22.1.6" });
    assert.strictEqual(view.state, "ok");
    assert.strictEqual(view.detail, "clangd 22.1.6");
    assert.strictEqual(view.staged, false);
  });
});
