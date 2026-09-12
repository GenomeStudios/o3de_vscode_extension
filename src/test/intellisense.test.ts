import * as assert from "assert";
import {
  extractFragmentIncludes,
  extractForcedIncludes,
  parseTarget,
  parseCompilerPath,
  pickConfiguration,
} from "../intellisense/fileApi";
import { agreedCompile, consolidateTargets } from "../intellisense/consolidate";
import { remapPath, remapIncludes, RootMapping } from "../intellisense/remap";
import { buildCppConfiguration, cppStandardFromApi, mergeCppProperties } from "../intellisense/cppProperties";
import { normalizePath, isUnderRoot, replaceRoot, uniqueStable } from "../intellisense/paths";

// ---- paths -----------------------------------------------------------------
suite("intellisense/paths", () => {
  test("normalizePath forward-slashes and collapses . / ..", () => {
    assert.strictEqual(normalizePath("D:\\a\\AzCore\\."), "D:/a/AzCore");
    assert.strictEqual(normalizePath("D:/a/AzGameFramework/.."), "D:/a");
    assert.strictEqual(normalizePath("D:/a/Legacy/CryCommon/.."), "D:/a/Legacy");
  });

  test("isUnderRoot is segment-aware + case-insensitive", () => {
    assert.ok(isUnderRoot("D:/Eng/Code/AzCore", "d:/eng"));
    assert.ok(isUnderRoot("D:/Eng", "D:/Eng/"));
    assert.ok(!isUnderRoot("D:/Engine2/Code", "D:/Eng")); // not a segment boundary
  });

  test("replaceRoot swaps the prefix, keeps the tail", () => {
    assert.strictEqual(
      replaceRoot("D:/GS/GS_Play_Engine/Code/Framework/AzCore/.", "D:/GS/GS_Play_Engine", "${workspaceFolder:Eng}"),
      "${workspaceFolder:Eng}/Code/Framework/AzCore",
    );
  });

  test("uniqueStable dedupes case-insensitively, keeps first order", () => {
    assert.deepStrictEqual(uniqueStable(["A", "b", "a", "B", "c"]), ["A", "b", "c"]);
  });
});

// ---- File API parsing ------------------------------------------------------
suite("intellisense/fileApi", () => {
  test("extractFragmentIncludes pulls -external:I / /I paths (O3DE 3rd-party)", () => {
    const got = extractFragmentIncludes([
      { fragment: "-external:IC:/tp/Lua/include" },
      { fragment: "/external:IC:/tp/zlib/include" },
      { fragment: "-std:c++20" }, // not an include
      { fragment: "/W4" }, // not an include
      { fragment: '-I"C:/tp/quoted/include"' },
    ]);
    assert.deepStrictEqual(got, [
      "C:/tp/Lua/include",
      "C:/tp/zlib/include",
      "C:/tp/quoted/include",
    ]);
  });

  test("extractForcedIncludes finds /FI inside combined flag fragments", () => {
    assert.deepStrictEqual(
      extractForcedIncludes([
        { fragment: " /Gd /MP /FID:/Eng/Compat/VSCompat.h /wd4201 -std:c++20" },
        { fragment: "/nologo" },
      ]),
      ["D:/Eng/Compat/VSCompat.h"],
    );
  });

  test("parseTarget extracts includes (+external), defines, and CXX standard", () => {
    const target = parseTarget({
      compileGroups: [
        {
          language: "CXX",
          includes: [
            { path: "D:/Proj/Gem/Include" },
            { path: "D:/Eng/Code/Framework/AzCore/.", isSystem: true },
          ],
          defines: [{ define: "AZ_ENABLE_TRACING" }, { define: "_HAS_EXCEPTIONS=0" }],
          compileCommandFragments: [
            { fragment: " /W4 /FID:/Eng/Compat/VSCompat.h /Zc:preprocessor" },
            { fragment: "-external:IC:/tp/Lua/include" },
          ],
          languageStandard: { standard: "20" },
        },
      ],
    });
    assert.deepStrictEqual(target.defines, ["AZ_ENABLE_TRACING", "_HAS_EXCEPTIONS=0"]);
    assert.deepStrictEqual(target.forcedIncludes, ["D:/Eng/Compat/VSCompat.h"]);
    assert.strictEqual(target.standard, "20");
    assert.deepStrictEqual(
      target.includes.map((i) => i.path),
      ["D:/Proj/Gem/Include", "D:/Eng/Code/Framework/AzCore/.", "C:/tp/Lua/include"],
    );
    assert.strictEqual(target.includes[2].isSystem, true); // external → system
  });

  test("parseCompilerPath picks the CXX toolchain; pickConfiguration matches by name", () => {
    assert.strictEqual(
      parseCompilerPath({
        toolchains: [
          { language: "C", compiler: { path: "cc.exe" } },
          { language: "CXX", compiler: { path: "cl.exe" } },
        ],
      }),
      "cl.exe",
    );
    const cfg = pickConfiguration(
      { configurations: [{ name: "debug", targets: [] }, { name: "profile", targets: [{ name: "T", jsonFile: "t.json" }] }] },
      "profile",
    );
    assert.strictEqual(cfg?.name, "profile");
    assert.strictEqual(cfg?.targets[0].jsonFile, "t.json");
  });
});

// ---- consolidation ---------------------------------------------------------
suite("intellisense/consolidate", () => {
  test("unions + dedupes includes/defines across targets, normalizes paths", () => {
    const c = consolidateTargets([
      {
        includes: [{ path: "D:/Eng/Code/Framework/AzCore/." }, { path: "D:/Proj/Gem/Include" }],
        defines: ["WIN64", "AZ_PROFILE_BUILD"],
        forcedIncludes: ["D:/Eng/Compat/VSCompat.h"],
        standard: "20",
      },
      {
        includes: [{ path: "D:\\Eng\\Code\\Framework\\AzCore\\.", isSystem: true }, { path: "D:/Eng/Code/Framework/AzFramework/." }],
        defines: ["WIN64", "NDEBUG"],
        forcedIncludes: ["D:\\Eng\\Compat\\VSCompat.h"], // dup (different separators) → deduped
        standard: "17",
      },
    ]);
    assert.deepStrictEqual(c.includes.map((i) => i.path), [
      "D:/Eng/Code/Framework/AzCore", // normalized + deduped across the two targets
      "D:/Proj/Gem/Include",
      "D:/Eng/Code/Framework/AzFramework",
    ]);
    assert.deepStrictEqual(c.defines, ["WIN64", "AZ_PROFILE_BUILD", "NDEBUG"]);
    assert.deepStrictEqual(c.forcedIncludes, ["D:/Eng/Compat/VSCompat.h"]); // normalized + deduped
    assert.strictEqual(c.standard, "20"); // first seen
  });
});

suite("intellisense/consolidate.agreedCompile (union includes, intersect semantics)", () => {
  // Shapes taken from gs_play's real reply: a runtime gem module vs a launcher.
  const gem = {
    includes: [{ path: "D:/Eng/Code/Framework/AzCore/." }, { path: "D:/Gems/gs_core/Code/Include" }],
    defines: ["AZ_PROFILE_BUILD", "WIN64", "GS_Core_EXPORTS", "O3DE_GEM_NAME=GS_Core"],
    forcedIncludes: ["D:/Eng/Compat/VSCompat.h"],
    standard: "20",
  };
  const headless = {
    includes: [{ path: "D:\\Eng\\Code\\Framework\\AzCore\\." }, { path: "D:/Proj/Launcher" }],
    defines: ["WIN64", "AZ_PROFILE_BUILD", "O3DE_HEADLESS_SERVER=1", "O3DE_GEM_NAME=GS_Unit"],
    forcedIncludes: ["D:\\eng\\compat\\vscompat.h"], // same file, different separators + case
    standard: "20",
  };

  test("defines are the INTERSECTION — only what every target agrees on", () => {
    assert.deepStrictEqual(agreedCompile([gem, headless]).defines, ["AZ_PROFILE_BUILD", "WIN64"]);
  });

  test("a macro with conflicting values drops out entirely rather than picking one", () => {
    assert.ok(!agreedCompile([gem, headless]).defines.some((d) => d.startsWith("O3DE_GEM_NAME")));
  });

  test("a one-target flag like O3DE_HEADLESS_SERVER=1 never leaks into shared files", () => {
    assert.ok(!agreedCompile([gem, headless]).defines.includes("O3DE_HEADLESS_SERVER=1"));
  });

  test("include paths stay the UNION — a header any target reaches still resolves", () => {
    assert.deepStrictEqual(agreedCompile([gem, headless]).includes.map((i) => i.path), [
      "D:/Eng/Code/Framework/AzCore",
      "D:/Gems/gs_core/Code/Include",
      "D:/Proj/Launcher",
    ]);
  });

  test("forced includes intersect on the normalized, case-insensitive path", () => {
    assert.deepStrictEqual(agreedCompile([gem, headless]).forcedIncludes, ["D:/Eng/Compat/VSCompat.h"]);
  });

  test("order-independent — the same answer whichever target comes first", () => {
    const forward = agreedCompile([gem, headless]);
    const reversed = agreedCompile([headless, gem]);
    assert.deepStrictEqual(new Set(forward.defines), new Set(reversed.defines));
    assert.deepStrictEqual(new Set(forward.forcedIncludes.map((f) => f.toLowerCase())), new Set(reversed.forcedIncludes.map((f) => f.toLowerCase())));
  });

  test("a single target is its own agreed compile", () => {
    assert.deepStrictEqual(agreedCompile([gem]).defines, gem.defines);
  });

  test("no targets → empty, never a crash", () => {
    const empty = agreedCompile([]);
    assert.deepStrictEqual([empty.includes, empty.defines, empty.forcedIncludes], [[], [], []]);
  });
});

// ---- remap -----------------------------------------------------------------
suite("intellisense/remap", () => {
  const mappings: RootMapping[] = [
    { fromRoot: "D:/GS/GS_Play_Engine", toRef: "${workspaceFolder:Engine (source): o3de_sourcedev}" },
    { fromRoot: "D:/OffLocalDev/CurvesTest", toRef: "${workspaceFolder}" },
  ];

  test("build-engine paths remap to the workspace source engine", () => {
    assert.strictEqual(
      remapPath("D:/GS/GS_Play_Engine/Code/Framework/AzCore/.", mappings),
      "${workspaceFolder:Engine (source): o3de_sourcedev}/Code/Framework/AzCore",
    );
  });

  test("project paths relativize to ${workspaceFolder}; 3rd-party stays absolute", () => {
    assert.strictEqual(remapPath("D:/OffLocalDev/CurvesTest/Gem/Include", mappings), "${workspaceFolder}/Gem/Include");
    assert.strictEqual(remapPath("C:/Users/x/.o3de/3rdParty/Lua/include", mappings), "C:/Users/x/.o3de/3rdParty/Lua/include");
  });

  test("remapIncludes preserves the system flag", () => {
    const out = remapIncludes([{ path: "D:/GS/GS_Play_Engine/Code/Framework/AzCore/.", isSystem: true }], mappings);
    assert.strictEqual(out[0].isSystem, true);
    assert.ok(out[0].path.startsWith("${workspaceFolder:Engine (source)"));
  });

  test("engine redirect falls back to the build path when the source lacks it (generated dirs)", () => {
    // Source engine has AzCore but NOT the build-generated Azcg dir.
    const sourceHas = (abs: string) => !abs.includes("/Azcg/Generated/");
    const verified: RootMapping[] = [
      {
        fromRoot: "D:/GS/GS_Play_Engine",
        toRef: "${workspaceFolder:Engine (source): o3de_sourcedev}",
        verifyBase: "D:/OffLocalDev/o3de_sourcedev",
        exists: sourceHas,
      },
    ];
    // Present in source → remaps to the workspace source engine.
    assert.strictEqual(
      remapPath("D:/GS/GS_Play_Engine/Code/Framework/AzCore/.", verified),
      "${workspaceFolder:Engine (source): o3de_sourcedev}/Code/Framework/AzCore",
    );
    // Build-only generated dir → keeps the absolute build-engine path (headers still resolve).
    assert.strictEqual(
      remapPath("D:/GS/GS_Play_Engine/Code/Framework/AzNetworking/Azcg/Generated/AzNetworking", verified),
      "D:/GS/GS_Play_Engine/Code/Framework/AzNetworking/Azcg/Generated/AzNetworking",
    );
  });
});

// ---- c_cpp_properties ------------------------------------------------------
suite("intellisense/cppProperties", () => {
  test("cppStandardFromApi maps digits, defaults to c++20", () => {
    assert.strictEqual(cppStandardFromApi("20"), "c++20");
    assert.strictEqual(cppStandardFromApi("17"), "c++17");
    assert.strictEqual(cppStandardFromApi(undefined), "c++20");
  });

  test("buildCppConfiguration sets MSVC fields + forcedInclude + browse.path", () => {
    const cfg = buildCppConfiguration({
      name: "O3DE",
      includePath: ["${workspaceFolder}/Gem/Include"],
      defines: ["WIN64"],
      forcedInclude: ["${workspaceFolder:Engine (source): o3de_sourcedev}/Code/Framework/AzCore/Platform/Common/VisualStudio/AzCore/Compat/VSCompat.h"],
      compilerPath: "C:/msvc/cl.exe",
      standard: "20",
    });
    assert.strictEqual(cfg["intelliSenseMode"], "windows-msvc-x64");
    assert.strictEqual(cfg["compilerPath"], "C:/msvc/cl.exe");
    assert.strictEqual(cfg["cppStandard"], "c++20");
    assert.deepStrictEqual((cfg["browse"] as Record<string, unknown>)["path"], ["${workspaceFolder}/Gem/Include"]);
    assert.strictEqual((cfg["forcedInclude"] as string[]).length, 1);
  });

  test("buildCppConfiguration omits forcedInclude when empty", () => {
    const cfg = buildCppConfiguration({ name: "O3DE", includePath: [], defines: [], forcedInclude: [] });
    assert.ok(!("forcedInclude" in cfg));
  });

  test("mergeCppProperties replaces our config by name, keeps others + version", () => {
    const existing = {
      version: 4,
      configurations: [{ name: "Linux" }, { name: "O3DE", includePath: ["old"] }],
    };
    const merged = mergeCppProperties(existing, { name: "O3DE", includePath: ["new"] });
    const configs = merged["configurations"] as Record<string, unknown>[];
    assert.strictEqual(configs.length, 2);
    assert.strictEqual(configs[0]["name"], "Linux"); // preserved
    assert.deepStrictEqual(configs[1]["includePath"], ["new"]); // replaced
    assert.strictEqual(merged["version"], 4);
  });
});
