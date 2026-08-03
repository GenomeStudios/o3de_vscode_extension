import * as assert from "assert";
import * as path from "path";
import {
  parseLaunchArgs,
  runArgsFor,
  projectRuntimeExe,
  gameLauncherExeName,
  runTargetExeName,
  customRunImage,
  orderRunTargets,
  editorExeCandidates,
  runSummary,
  launchArgsLabel,
} from "../build/runCommand";
import { platformBuildDir } from "../build/configureCommand";
import type { O3deEngine } from "../o3de/identity";

suite("runCommand", () => {
  test("parseLaunchArgs splits on whitespace and honors double quotes", () => {
    assert.deepStrictEqual(parseLaunchArgs("+LoadLevel DefaultLevel +r_displayInfo 1"), [
      "+LoadLevel",
      "DefaultLevel",
      "+r_displayInfo",
      "1",
    ]);
    assert.deepStrictEqual(parseLaunchArgs('+LoadLevel "My Level"'), ["+LoadLevel", "My Level"]);
    assert.deepStrictEqual(parseLaunchArgs("   "), []);
    assert.deepStrictEqual(parseLaunchArgs(""), []);
  });

  test("runArgsFor: Editor gets --project-path + options; everything else gets only options", () => {
    assert.deepStrictEqual(runArgsFor("Editor", "D:/proj", ""), ["--project-path", "D:/proj"]);
    assert.deepStrictEqual(runArgsFor("Editor", "D:/proj", "+r_displayInfo 1"), [
      "--project-path",
      "D:/proj",
      "+r_displayInfo",
      "1",
    ]);
    assert.deepStrictEqual(runArgsFor("GameLauncher", "D:/proj", "+LoadLevel DefaultLevel"), [
      "+LoadLevel",
      "DefaultLevel",
    ]);
    assert.deepStrictEqual(runArgsFor("GameLauncher", "D:/proj", ""), []);
    // Custom executable targets launch clean — no surprise base args.
    assert.deepStrictEqual(runArgsFor("O3DEQtControlGallery", "D:/proj", ""), []);
    assert.deepStrictEqual(runArgsFor("O3DEQtControlGallery", "D:/proj", "--flag x"), ["--flag", "x"]);
  });

  test("runTargetExeName: special values resolve, custom names get .exe appended once", () => {
    assert.strictEqual(runTargetExeName("Editor", "GS_Play"), "Editor.exe");
    assert.strictEqual(runTargetExeName("GameLauncher", "GS_Play"), "GS_Play.GameLauncher.exe");
    assert.strictEqual(runTargetExeName("O3DEQtControlGallery", "GS_Play"), "O3DEQtControlGallery.exe");
    assert.strictEqual(runTargetExeName("MyTool.exe", "GS_Play"), "MyTool.exe");
    assert.strictEqual(runTargetExeName("GS_Play.ServerLauncher", "GS_Play"), "GS_Play.ServerLauncher.exe");
  });

  test("customRunImage: only custom targets add a probe image", () => {
    assert.strictEqual(customRunImage("Editor"), undefined);
    assert.strictEqual(customRunImage("GameLauncher"), undefined);
    assert.strictEqual(customRunImage("O3DEQtControlGallery"), "O3DEQtControlGallery.exe");
    assert.strictEqual(customRunImage("MyTool.EXE"), "MyTool.EXE");
  });

  test("orderRunTargets: API order first, then built-only exes, then the current pick", () => {
    assert.deepStrictEqual(
      orderRunTargets(
        "GS_Play",
        ["GS_Play.ServerLauncher", "AzTestRunner"], // File API executables
        ["O3DEQtControlGallery", "AzTestRunner"], // exes on disk (one overlaps)
        "MyCustomTool", // current selection typed by hand
      ),
      ["GS_Play.ServerLauncher", "AzTestRunner", "O3DEQtControlGallery", "MyCustomTool"],
    );
  });

  test("orderRunTargets: curated spellings are excluded, dedup is case-insensitive", () => {
    assert.deepStrictEqual(
      orderRunTargets(
        "GS_Play",
        ["Editor", "GS_Play.GameLauncher", "Tool"],
        ["GS_Play.GameLauncher", "TOOL"],
        "GameLauncher",
      ),
      ["Tool"],
    );
    assert.deepStrictEqual(orderRunTargets("GS_Play", [], [], "Editor"), []);
  });

  test("projectRuntimeExe composes <project>/build/<platform>/bin/<config>/<exe>", () => {
    assert.strictEqual(
      projectRuntimeExe("D:/proj", "profile", "Editor.exe"),
      path.join("D:/proj", "build", platformBuildDir(), "bin", "profile", "Editor.exe"),
    );
  });

  test("gameLauncherExeName is project-prefixed (matches the real build output)", () => {
    assert.strictEqual(gameLauncherExeName("GS_Play"), "GS_Play.GameLauncher.exe");
  });

  test("editorExeCandidates: SDK engine → engine prebuilt bin; source/none → project build", () => {
    const sdk = { engineName: "GS_Play_Engine", isSdkEngine: true, path: "D:/eng" } as O3deEngine;
    // SDK/prebuilt: the engine's own bin (Default/ preferred, flat as fallback) — NOT the project build.
    assert.deepStrictEqual(editorExeCandidates(sdk, "D:/proj", "profile"), [
      path.join("D:/eng", "bin", "Windows", "profile", "Default", "Editor.exe"),
      path.join("D:/eng", "bin", "Windows", "profile", "Editor.exe"),
    ]);

    // Source engine and unresolved engine both → the project's own built Editor.
    const projBuild = projectRuntimeExe("D:/proj", "profile", "Editor.exe");
    const source = { engineName: "SrcEngine", isSdkEngine: false, path: "D:/eng" } as O3deEngine;
    assert.deepStrictEqual(editorExeCandidates(source, "D:/proj", "profile"), [projBuild]);
    assert.deepStrictEqual(editorExeCandidates(undefined, "D:/proj", "profile"), [projBuild]);
  });

  test("runSummary / launchArgsLabel reflect the current selection", () => {
    assert.strictEqual(runSummary("Editor", ""), "Editor");
    assert.strictEqual(runSummary("GameLauncher", "+LoadLevel DefaultLevel"), "GameLauncher · +LoadLevel DefaultLevel");
    assert.strictEqual(launchArgsLabel(""), "(none)");
    assert.strictEqual(launchArgsLabel("  "), "(none)");
    assert.strictEqual(launchArgsLabel("+r_displayInfo 1"), "+r_displayInfo 1");
  });
});
