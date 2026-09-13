// ============================================================================
//  Clang / LLVM onboarding row — optional, so absent is grey; an install that
//  isn't on PATH is found and gets an "Add LLVM to PATH" step.
// ============================================================================

import * as assert from "assert";
import { defaultLlvmBinDir } from "../deps/llvm";
import { buildOnboardingModel, CHECKS, resolveGuidedAction } from "../deps/registry";

const has = (...files: string[]) => (file: string) => files.map((f) => f.toLowerCase()).includes(file.toLowerCase());

suite("llvm.defaultLlvmBinDir", () => {
  test("finds clang in LLVM's default Program Files folder", () => {
    const env = { ProgramFiles: "C:\\Program Files" };
    assert.strictEqual(
      defaultLlvmBinDir(env, "win32", has("C:\\Program Files\\LLVM\\bin\\clang.exe")),
      "C:\\Program Files\\LLVM\\bin",
    );
  });

  test("prefers the 64-bit Program Files (ProgramW6432) and checks each root once", () => {
    const seen: string[] = [];
    const exists = (file: string) => {
      seen.push(file);
      return file === "C:\\Program Files\\LLVM\\bin\\clang.exe";
    };
    const env = { ProgramW6432: "C:\\Program Files", ProgramFiles: "C:\\Program Files" };
    assert.strictEqual(defaultLlvmBinDir(env, "win32", exists), "C:\\Program Files\\LLVM\\bin");
    assert.strictEqual(seen.length, 1, "the same root listed twice is probed once");
  });

  test("an LLVM folder without clang.exe is not an install", () => {
    assert.strictEqual(defaultLlvmBinDir({ ProgramFiles: "C:\\Program Files" }, "win32", has()), undefined);
  });

  test("not Windows → undefined (package managers put clang on PATH)", () => {
    assert.strictEqual(defaultLlvmBinDir({ ProgramFiles: "/opt" }, "linux", () => true), undefined);
  });
});

suite("onboarding: Clang / LLVM row", () => {
  const row = (result: Parameters<typeof resolveGuidedAction>[1]) =>
    buildOnboardingModel({ clang: result! }, "cpp", "win32").optionals.find((v) => v.id === "clang")!;
  const addToPath = { label: "Add LLVM to PATH", kind: "addToPath" as const, payload: "C:\\Program Files\\LLVM\\bin" };

  test("stays optional — it never blocks setup", () => {
    assert.strictEqual(CHECKS.find((c) => c.id === "clang")!.tier, "optional");
  });

  test("not installed → grey 'Not installed' with Install LLVM (not a red fault)", () => {
    const view = row({ state: "absent", detail: "Not installed" });
    assert.strictEqual(view.state, "absent");
    assert.strictEqual(view.detail, "Not installed");
    assert.strictEqual(view.actionLabel, "Install LLVM");
  });

  test("installed but not on PATH → staged, says where it is, next step Add LLVM to PATH", () => {
    const result = { state: "warn" as const, detail: "18.1.8 · Installed · not on PATH (C:\\Program Files\\LLVM\\bin)", action: addToPath };
    const view = row(result);
    assert.strictEqual(view.staged, true);
    assert.strictEqual(view.actionLabel, "Add LLVM to PATH");
    assert.deepStrictEqual(resolveGuidedAction("clang", result).action, addToPath);
  });

  test("on PATH → done with its version", () => {
    const view = row({ state: "ok", detail: "18.1.8" });
    assert.strictEqual(view.state, "ok");
    assert.strictEqual(view.staged, false);
  });
});
