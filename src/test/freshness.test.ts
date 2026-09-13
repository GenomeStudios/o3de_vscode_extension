// ============================================================================
//  Freshness — the rules behind IntelliSense ▸ Status ▸ C++ Data / Lua Reflection.
//
//  Shapes come from gs_play's measured reply: a working project whose gem.json
//  files were rewritten in bulk must read UP TO DATE, while gems rebuilt five
//  weeks after the Lua dump must read STALE.
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cppFreshness,
  cppFreshnessDetail,
  cppFreshnessLabel,
  luaFreshness,
  luaFreshnessDetail,
  luaFreshnessLabel,
  readDumpEngine,
} from "../intellisense/freshness";
import { parseModuleArtifacts, parseTargetDefiningInputs } from "../intellisense/fileApi";

const JUL_21 = Date.parse("2026-07-21T04:26:00Z"); // the gs_play Lua dump
const AUG_26 = Date.parse("2026-08-26T21:04:00Z"); // last gem build
const AUG_31 = Date.parse("2026-08-31T19:47:00Z"); // last configure
const SEP_05 = Date.parse("2026-09-05T07:47:00Z"); // bulk gem.json rewrite

// ---- C++ data ----------------------------------------------------------------
suite("freshness.cppFreshness", () => {
  test("never configured → notConfigured", () => {
    assert.strictEqual(cppFreshness(undefined, undefined).state, "notConfigured");
  });

  test("configured but the reply can't list its inputs → unknown, never claimed fresh", () => {
    assert.strictEqual(cppFreshness(AUG_31, undefined).state, "unknown");
  });

  test("no target-defining input changed since configure → upToDate", () => {
    const inputs = [{ path: "D:/g/gs_core/Code/gs_core_files.cmake", mtime: AUG_26 }];
    assert.strictEqual(cppFreshness(AUG_31, inputs).state, "upToDate");
  });

  test("a *_files.cmake edited after configure → stale, and names it", () => {
    const inputs = [
      { path: "D:/g/gs_core/Code/gs_core_files.cmake", mtime: SEP_05 },
      { path: "D:/g/gs_core/CMakeLists.txt", mtime: AUG_26 },
    ];
    const result = cppFreshness(AUG_31, inputs);
    assert.strictEqual(result.state, "stale");
    assert.deepStrictEqual(result.changed, ["D:/g/gs_core/Code/gs_core_files.cmake"]);
  });

  test("an input written in the same instant as the configure is not stale", () => {
    assert.strictEqual(cppFreshness(AUG_31, [{ path: "D:/p/CMakeLists.txt", mtime: AUG_31 }]).state, "upToDate");
  });

  test("stale detail shows at most three files and counts the rest", () => {
    const inputs = ["a", "b", "c", "d", "e"].map((n) => ({ path: `D:/g/${n}/Code/${n}_files.cmake`, mtime: SEP_05 }));
    const detail = cppFreshnessDetail(cppFreshness(AUG_31, inputs));
    assert.ok(detail.includes("5 file(s)"));
    assert.ok(detail.includes("and 2 more"));
    assert.strictEqual(cppFreshnessLabel(cppFreshness(AUG_31, inputs)), "Stale (reconfigure)");
  });
});

// ---- Which inputs are watched ------------------------------------------------
suite("fileApi.parseTargetDefiningInputs", () => {
  const cmakeFiles = {
    paths: { source: "D:/OffLocalDev/gs_play" },
    inputs: [
      { path: "CMakeLists.txt" },
      { path: "D:/g/gs_core/Code/gs_core_files.cmake", isExternal: true },
      { path: "D:/g/gs_core/CMakeLists.txt", isExternal: true },
      { path: "project.json" },
      { path: "D:/g/gs_core/gem.json", isExternal: true }, // bulk-rewritten on gs_play → not watched
      { path: "C:/Users/u/.o3de/o3de_manifest.json", isExternal: true }, // rewritten by tooling → not watched
      { path: "C:/Program Files/CMake/share/cmake-3.30/Modules/CheckCXXSourceCompiles.cmake", isCMake: true },
      { path: "D:/OffLocalDev/gs_play/build/windows/generated.cmake", isGenerated: true },
      { path: "D:/G/GS_CORE/CODE/GS_CORE_FILES.CMAKE", isExternal: true }, // same file, other case
    ],
  };

  test("keeps CMakeLists.txt, *.cmake and project.json; resolves relative paths against the source dir", () => {
    assert.deepStrictEqual(
      parseTargetDefiningInputs(cmakeFiles).map((p) => p.split("\\").join("/")),
      [
        "D:/OffLocalDev/gs_play/CMakeLists.txt",
        "D:/g/gs_core/Code/gs_core_files.cmake",
        "D:/g/gs_core/CMakeLists.txt",
        "D:/OffLocalDev/gs_play/project.json",
      ],
    );
  });

  test("never watches gem.json or the o3de manifest", () => {
    const watched = parseTargetDefiningInputs(cmakeFiles).join("|");
    assert.ok(!watched.includes("gem.json") && !watched.includes("o3de_manifest.json"));
  });
});

// ---- Lua reflection ----------------------------------------------------------
suite("freshness.luaFreshness", () => {
  const ENGINE = "D:/GS_Sys/Engines/GS_Play_Engine";
  const dump = { mtime: JUL_21, engine: ENGINE };

  test("no dump → notGenerated", () => {
    assert.strictEqual(luaFreshness(undefined, ENGINE, [AUG_26]).state, "notGenerated");
  });

  test("same engine, nothing rebuilt since → upToDate", () => {
    assert.strictEqual(luaFreshness(dump, ENGINE, [JUL_21 - 1000]).state, "upToDate");
  });

  test("modules rebuilt after the dump → gemsRebuilt, with count and latest build (the real gs_play state)", () => {
    const result = luaFreshness(dump, ENGINE, [AUG_26, AUG_26 - 5000, JUL_21 - 1000]);
    assert.strictEqual(result.state, "gemsRebuilt");
    assert.strictEqual(result.rebuiltCount, 2);
    assert.strictEqual(result.latestBuild, AUG_26);
    assert.strictEqual(luaFreshnessLabel(result), "Stale (gems rebuilt)");
  });

  test("a different engine outranks a rebuild — wrong API is worse than missing API", () => {
    const result = luaFreshness({ mtime: JUL_21, engine: "C:/O3DE/Engines/O3DE-2510.2-official" }, ENGINE, [AUG_26]);
    assert.strictEqual(result.state, "engineChanged");
    const detail = luaFreshnessDetail(result);
    assert.ok(detail.includes("O3DE-2510.2-official") && detail.includes("GS_Play_Engine"));
  });

  test("engine paths compare by normalized path — separators, case and trailing slash don't matter", () => {
    const result = luaFreshness({ mtime: JUL_21, engine: "d:\\gs_sys\\engines\\gs_play_engine\\" }, ENGINE, []);
    assert.strictEqual(result.state, "upToDate");
  });

  test("an empty recorded engine is no evidence of a mismatch", () => {
    assert.strictEqual(luaFreshness({ mtime: JUL_21, engine: "" }, ENGINE, []).state, "upToDate");
  });
});

// ---- Module artifacts --------------------------------------------------------
suite("fileApi.parseModuleArtifacts", () => {
  const BUILD = "D:/OffLocalDev/gs_play/build/windows";

  test("module and shared libraries yield their library binary, joined to the build dir", () => {
    const artifacts = parseModuleArtifacts(
      { type: "MODULE_LIBRARY", artifacts: [{ path: "bin/profile/GS_Core.dll" }, { path: "bin/profile/GS_Core.pdb" }] },
      BUILD,
    );
    assert.deepStrictEqual(artifacts.map((a) => a.split("\\").join("/")), [`${BUILD}/bin/profile/GS_Core.dll`]);
  });

  test("executables, static and interface libraries contribute nothing", () => {
    for (const type of ["EXECUTABLE", "STATIC_LIBRARY", "INTERFACE_LIBRARY", "UTILITY"]) {
      assert.deepStrictEqual(parseModuleArtifacts({ type, artifacts: [{ path: "bin/profile/x.dll" }] }, BUILD), []);
    }
  });
});

// ---- Dump head ---------------------------------------------------------------
suite("freshness.readDumpEngine", () => {
  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-dump-"));
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("reads the recorded engine from the head of a real-shaped dump, unescaping backslashes", () => {
    const file = path.join(dir, "lua_symbols.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, engine: "D:\\GS_Sys\\Engines\\GS_Play_Engine", project: "d:\\x", classes: [] }, null, 2),
    );
    assert.strictEqual(readDumpEngine(file), "D:\\GS_Sys\\Engines\\GS_Play_Engine");
  });

  test("a missing dump → undefined", () => {
    assert.strictEqual(readDumpEngine(path.join(dir, "absent.json")), undefined);
  });
});
