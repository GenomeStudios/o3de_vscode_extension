import * as assert from "assert";
import * as path from "path";
import {
  buildConfigureArgs,
  exeSuffix,
  engineBinDirName,
  platformBuildDir,
} from "../build/configureCommand";
import { gameLauncherExeName, editorExeCandidates, runtimeSweepImages, customRunImage } from "../build/runCommand";
import { intelliSenseModeFor } from "../intellisense/cppProperties";
import type { O3deEngine } from "../o3de/identity";

// The Linux-support foundation: pure helpers with a platform seam. The
// intelliSenseMode + configure-arg tests run the full OS matrix regardless of the
// host; the exe-naming tests assert the CURRENT OS spelling — on the Windows dev
// machine that is the regression net that proves nothing shifted for Windows.
suite("linuxSupport", () => {
  const sdkEngine: O3deEngine = {
    engineName: "o3de",
    isSdkEngine: true,
    externalSubdirectories: [],
    path: path.join("D:", "o3de"),
  };

  // ---- intelliSenseMode (platform-injectable → full matrix) ----------------
  test("intelliSenseModeFor maps OS + compiler", () => {
    assert.strictEqual(intelliSenseModeFor(undefined, "win32"), "windows-msvc-x64");
    assert.strictEqual(intelliSenseModeFor("C:/VS/cl.exe", "win32"), "windows-msvc-x64");
    assert.strictEqual(intelliSenseModeFor("/usr/bin/clang++", "linux"), "linux-clang-x64");
    assert.strictEqual(intelliSenseModeFor("/usr/bin/g++", "linux"), "linux-gcc-x64");
    assert.strictEqual(intelliSenseModeFor(undefined, "linux"), "linux-gcc-x64");
    assert.strictEqual(intelliSenseModeFor("/usr/bin/clang", "darwin"), "macos-clang-x64");
  });

  // ---- configure compiler flags (compiler is an input → cross-platform) ----
  test("buildConfigureArgs emits the compiler flags per selection", () => {
    const base = {
      projectPath: "P",
      buildDir: "B",
      generator: "Ninja Multi-Config",
      thirdPartyPath: "T",
    };
    const gcc = buildConfigureArgs({ ...base, compiler: "GCC" });
    assert.ok(gcc.includes("-DCMAKE_C_COMPILER=gcc"));
    assert.ok(gcc.includes("-DCMAKE_CXX_COMPILER=g++"));

    const clang = buildConfigureArgs({ ...base, compiler: "Clang" });
    assert.ok(clang.includes("-DCMAKE_C_COMPILER=clang"));
    assert.ok(clang.includes("-DCMAKE_CXX_COMPILER=clang++"));

    const clangVs = buildConfigureArgs({ ...base, generator: "Visual Studio 17 2022", compiler: "Clang" });
    assert.ok(clangVs.join(" ").includes("-T ClangCl"));

    const msvc = buildConfigureArgs({ ...base, compiler: "MSVC" });
    assert.ok(!msvc.join(" ").includes("CMAKE_C_COMPILER"), "MSVC adds no compiler override");
  });

  // ---- exe naming (current-OS regression net) ------------------------------
  test("exe naming follows the current OS", () => {
    const suffix = exeSuffix();
    assert.strictEqual(suffix, process.platform === "win32" ? ".exe" : "");
    assert.strictEqual(gameLauncherExeName("Foo"), `Foo.GameLauncher${suffix}`);

    const sweep = runtimeSweepImages("Foo");
    assert.deepStrictEqual(sweep, [
      `Editor${suffix}`,
      `Foo.GameLauncher${suffix}`,
      `AssetProcessor${suffix}`,
      `ScriptCanvasApplication${suffix}`,
    ]);
  });

  test("editorExeCandidates uses the capitalized engine bin dir + OS exe suffix", () => {
    const cands = editorExeCandidates(sdkEngine, "P", "profile");
    assert.ok(cands.every((c) => c.endsWith(`Editor${exeSuffix()}`)));
    assert.ok(cands[0].includes(path.join("bin", engineBinDirName(), "profile")));
  });

  test("customRunImage respects the OS exe suffix", () => {
    if (process.platform === "win32") {
      assert.strictEqual(customRunImage("Gallery"), "Gallery.exe");
      assert.strictEqual(customRunImage("Gallery.exe"), "Gallery.exe");
    } else {
      assert.strictEqual(customRunImage("Gallery"), "Gallery");
    }
    assert.strictEqual(customRunImage("Editor"), undefined);
    assert.strictEqual(customRunImage("GameLauncher"), undefined);
  });

  test("platform build dir is lowercase, engine bin dir is capitalized", () => {
    if (process.platform === "win32") {
      assert.strictEqual(platformBuildDir(), "windows");
      assert.strictEqual(engineBinDirName(), "Windows");
    } else if (process.platform === "linux") {
      assert.strictEqual(platformBuildDir(), "linux");
      assert.strictEqual(engineBinDirName(), "Linux");
    }
  });
});
