import * as assert from "assert";
import { buildProviderModel } from "../intellisense/providerModel";
import { FileApiReply, parseTargetSourcePaths } from "../intellisense/fileApi";
import { RootMapping } from "../intellisense/remap";
import { normalizePath } from "../intellisense/paths";

const keyOf = (abs: string): string => normalizePath(abs).toLowerCase();

suite("intellisense/fileApi.parseTargetSourcePaths", () => {
  test("keeps C/C++ sources, drops the unity blob's non-code neighbours (.cmake/.props)", () => {
    const sources = parseTargetSourcePaths({
      sources: [
        { path: "build/windows/.../Unity/unity_0_cxx.cxx" }, // unity blob (still .cxx → kept)
        { path: "Gem/Source/CurvesTestSystemComponent.cpp" },
        { path: "Gem/Source/CurvesTestSystemComponent.h" },
        { path: "D:/Eng/cmake/Platform/Common/Configurations_common.cmake" }, // dropped
        { path: "D:/Eng/cmake/MSVC/TestProject.props" }, // dropped
      ],
    });
    assert.deepStrictEqual(sources, [
      "build/windows/.../Unity/unity_0_cxx.cxx",
      "Gem/Source/CurvesTestSystemComponent.cpp",
      "Gem/Source/CurvesTestSystemComponent.h",
    ]);
  });
});

suite("intellisense/providerModel", () => {
  const PROJECT_ROOT = "D:/OffLocalDev/CurvesTest";
  // Engine build → source engine, ABSOLUTE (provider responses aren't ${var}-resolved).
  const mappings: RootMapping[] = [
    { fromRoot: "D:/GS/GS_Play_Engine", toRef: "D:/OffLocalDev/o3de_sourcedev" },
  ];

  const reply: FileApiReply = {
    configName: "profile",
    compilerPath: "C:/msvc/cl.exe",
    targets: [
      {
        compile: {
          includes: [
            { path: "D:/OffLocalDev/CurvesTest/Gem/Include" },
            { path: "D:/GS/GS_Play_Engine/Code/Framework/AzCore/.", isSystem: true },
          ],
          defines: ["AZ_PROFILE_BUILD", "WIN64"],
          forcedIncludes: ["D:/GS/GS_Play_Engine/Code/Framework/AzCore/Platform/Common/VSCompat.h"],
          standard: "20",
        },
        sourcePaths: ["Gem/Source/CurvesTestSystemComponent.cpp", "Gem/Include/CurvesTest/CurvesTestBus.h"],
        compiles: true,
      },
    ],
  };

  test("per-file config maps a project source to its target (paths absolute, engine remapped)", () => {
    const model = buildProviderModel(reply, PROJECT_ROOT, mappings);
    const cfg = model.perFile.get(keyOf("D:/OffLocalDev/CurvesTest/Gem/Source/CurvesTestSystemComponent.cpp"));
    assert.ok(cfg, "the .cpp is indexed to its target");
    assert.ok(cfg!.includePath.includes("D:/OffLocalDev/CurvesTest/Gem/Include"), "project include kept absolute");
    assert.ok(
      cfg!.includePath.includes("D:/OffLocalDev/o3de_sourcedev/Code/Framework/AzCore"),
      "engine include remapped to the source engine (absolute)",
    );
    assert.strictEqual(cfg!.standard, "c++20");
    assert.strictEqual(cfg!.intelliSenseMode, "windows-msvc-x64");
    assert.strictEqual(cfg!.compilerPath, "C:/msvc/cl.exe");
    assert.strictEqual((cfg!.forcedInclude ?? []).length, 1);
  });

  test("browse config is the consolidated union; default fallback exists for headers/unknown", () => {
    const model = buildProviderModel(reply, PROJECT_ROOT, mappings);
    assert.ok(model.browsePath.includes("D:/OffLocalDev/o3de_sourcedev/Code/Framework/AzCore"));
    assert.ok(model.defaultConfig.includePath.length >= model.browsePath.length - 1);
    // a header listed under the target is also indexed per-file
    assert.ok(model.perFile.has(keyOf("D:/OffLocalDev/CurvesTest/Gem/Include/CurvesTest/CurvesTestBus.h")));
  });
});

// ============================================================================
//  The configuration stack — three tiers, shapes taken from gs_play's real reply.
// ============================================================================
suite("intellisense/providerModel — configuration tiers", () => {
  const ROOT = "D:/OffLocalDev/gs_play";
  const noRemap: RootMapping[] = [];
  const UNIVERSAL = ["AZ_PROFILE_BUILD", "WIN64", "_HAS_EXCEPTIONS=0"];

  const gsCore = {
    compile: {
      includes: [{ path: "D:/Eng/Code/Framework/AzCore" }, { path: "D:/Gems/gs_core/Code/Include" }],
      defines: [...UNIVERSAL, "GS_Core_EXPORTS", "O3DE_GEM_NAME=GS_Core"],
      forcedIncludes: [],
      standard: "20",
    },
    sourcePaths: ["D:/Gems/gs_core/Code/Source/CoreSystem.cpp", "D:/Gems/gs_core/Code/Include/GS_Core/CoreBus.h"],
    compiles: true,
  };
  const gameLauncher = {
    compile: {
      includes: [{ path: "D:/Eng/Code/Framework/AzCore" }, { path: "D:/Proj/Launcher" }],
      defines: [...UNIVERSAL, 'LY_CMAKE_TARGET="GS_Play_GameLauncher"'],
      forcedIncludes: [],
      standard: "20",
    },
    sourcePaths: ["D:/Proj/Launcher/LauncherMain.cpp"],
    compiles: true,
  };
  const headlessLauncher = {
    compile: {
      includes: [{ path: "D:/Eng/Code/Framework/AzCore" }, { path: "D:/Proj/Launcher" }],
      defines: [...UNIVERSAL, 'LY_CMAKE_TARGET="GS_Play_HeadlessServerLauncher"', "O3DE_HEADLESS_SERVER=1"],
      forcedIncludes: [],
      standard: "20",
    },
    sourcePaths: ["D:/Proj/Launcher/LauncherMain.cpp"], // shared with gameLauncher
    compiles: true,
  };
  const model = (targets: FileApiReply["targets"]) =>
    buildProviderModel({ configName: "profile", targets }, ROOT, noRemap);

  // ---- Tier 1 --------------------------------------------------------------
  test("tier 1: a single-owner file keeps its owner's target-specific defines (precision)", () => {
    const cfg = model([gsCore, gameLauncher]).perFile.get(keyOf("D:/Gems/gs_core/Code/Include/GS_Core/CoreBus.h"));
    assert.ok(cfg!.defines.includes("GS_Core_EXPORTS"));
    assert.ok(cfg!.defines.includes("O3DE_GEM_NAME=GS_Core"));
  });

  test("tier 1: files of one target share ONE config object (remap runs once per target, not per file)", () => {
    const perFile = model([gsCore]).perFile;
    assert.strictEqual(
      perFile.get(keyOf("D:/Gems/gs_core/Code/Source/CoreSystem.cpp")),
      perFile.get(keyOf("D:/Gems/gs_core/Code/Include/GS_Core/CoreBus.h")),
    );
  });

  // ---- Tier 2 --------------------------------------------------------------
  test("tier 2: a file several targets compile gets only what those owners agree on", () => {
    const cfg = model([gameLauncher, headlessLauncher]).perFile.get(keyOf("D:/Proj/Launcher/LauncherMain.cpp"));
    assert.deepStrictEqual(cfg!.defines, UNIVERSAL);
    assert.ok(!cfg!.defines.includes("O3DE_HEADLESS_SERVER=1"), "one launcher's flag must not colour the shared file");
  });

  test("tier 2: deterministic — the old last-writer-wins depended on codemodel order", () => {
    const forward = model([gameLauncher, headlessLauncher]).perFile.get(keyOf("D:/Proj/Launcher/LauncherMain.cpp"));
    const reversed = model([headlessLauncher, gameLauncher]).perFile.get(keyOf("D:/Proj/Launcher/LauncherMain.cpp"));
    assert.deepStrictEqual(new Set(forward!.defines), new Set(reversed!.defines));
  });

  // ---- Tier 3 --------------------------------------------------------------
  test("tier 3: a file no target owns (engine source) gets the agreed compile of every target", () => {
    const m = model([gsCore, gameLauncher, headlessLauncher]);
    assert.ok(!m.perFile.has(keyOf("D:/OffLocalDev/o3de_sourcedev/Code/Framework/AzCore/AzCore/Component/Component.cpp")));
    assert.deepStrictEqual(m.defaultConfig.defines, UNIVERSAL);
  });

  test("tier 3: no contradictory or one-target macros reach engine source", () => {
    const defines = model([gsCore, gameLauncher, headlessLauncher]).defaultConfig.defines;
    assert.ok(!defines.includes("O3DE_HEADLESS_SERVER=1"), "would grey out client code in every engine file");
    assert.ok(!defines.some((d) => d.startsWith("LY_CMAKE_TARGET")), "two conflicting values");
    assert.ok(!defines.includes("GS_Core_EXPORTS"), "a gem's export flag means nothing in engine code");
  });

  test("tier 3: include paths stay the union, so engine source still resolves every header", () => {
    const includes = model([gsCore, gameLauncher]).defaultConfig.includePath;
    assert.ok(includes.includes("D:/Gems/gs_core/Code/Include"));
    assert.ok(includes.includes("D:/Proj/Launcher"));
  });

  // ---- Non-compiling targets ------------------------------------------------
  // Regression: gs_play's VolumetricClouds.API is an INTERFACE library that lists 3 headers.
  // As the last writer it used to overwrite them with an EMPTY config (no includes at all).
  const cloudsModule = {
    compile: {
      includes: [{ path: "D:/Eng/Code/Framework/AzCore" }, { path: "D:/Clouds/Code/Include" }],
      defines: [...UNIVERSAL, "VolumetricClouds_EXPORTS"],
      forcedIncludes: [],
      standard: "20",
    },
    sourcePaths: ["D:/Clouds/Code/Include/VolumetricClouds/VolumetricCloudsBus.h"],
    compiles: true,
  };
  const cloudsApi = {
    compile: { includes: [], defines: [], forcedIncludes: [] },
    sourcePaths: [
      "D:/Clouds/Code/Include/VolumetricClouds/VolumetricCloudsBus.h",
      "D:/Clouds/Code/Include/VolumetricClouds/CloudTextureProviderBus.h",
    ],
    compiles: false,
  };

  test("an INTERFACE target listing a header can no longer empty its config", () => {
    const cfg = model([cloudsModule, cloudsApi]).perFile.get(
      keyOf("D:/Clouds/Code/Include/VolumetricClouds/VolumetricCloudsBus.h"),
    );
    assert.ok(cfg!.includePath.includes("D:/Clouds/Code/Include"), "keeps the compiling module's includes");
    assert.ok(cfg!.defines.includes("VolumetricClouds_EXPORTS"));
  });

  test("a header ONLY an INTERFACE target lists falls to tier 3 — never an empty config", () => {
    const m = model([cloudsModule, cloudsApi]);
    assert.ok(!m.perFile.has(keyOf("D:/Clouds/Code/Include/VolumetricClouds/CloudTextureProviderBus.h")));
    assert.ok(m.defaultConfig.includePath.length > 0);
  });

  test("non-compiling targets do not wipe the tier 3 intersection", () => {
    assert.deepStrictEqual(model([cloudsModule, cloudsApi]).defaultConfig.defines, [...UNIVERSAL, "VolumetricClouds_EXPORTS"]);
  });
});
