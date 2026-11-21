// ============================================================================
//  Engine module export defines — read from the user's own source engine, so an
//  engine file compiles as its module does (dllexport), not as a consumer (dllimport).
//  Fixtures are tiny fake CMakeLists texts shaped like the engine's own; nothing here
//  depends on a real engine on this machine.
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CMakeReader,
  createModuleDefineLookup,
  declaresTarget,
  exportDefinesIn,
  fallbackExportDefines,
} from "../intellisense/moduleDefines";

const ROOT = "/eng";
const core = (rest: string) => `${ROOT}/Code/Framework/AzCore/${rest}`;

/** A fake disk: directory → CMakeLists text. Counts reads so caching can be asserted. */
function fakeDisk(files: Record<string, string>): { read: CMakeReader; reads: string[] } {
  const reads: string[] = [];
  const byDir = new Map(Object.entries(files).map(([dir, text]) => [dir.toLowerCase(), text]));
  return {
    reads,
    read: (dir) => {
      reads.push(dir);
      return byDir.get(dir.toLowerCase());
    },
  };
}

// ---- Fixtures: the shapes the engine's own CMakeLists use ---------------------------
const AZCORE_CMAKE = `
set(pal_dir \${CMAKE_CURRENT_LIST_DIR}/Platform/\${PAL_PLATFORM_NAME})

ly_add_target(
    NAME AzCore \${PAL_TRAIT_MONOLITHIC_DRIVEN_LIBRARY_TYPE}
    NAMESPACE AZ
    FILES_CMAKE
        AzCore/azcore_files.cmake
    COMPILE_DEFINITIONS
        PRIVATE
            AZCORE_EXPORTS
    INCLUDE_DIRECTORIES
        PUBLIC
            .
    BUILD_DEPENDENCIES
        PRIVATE
            NOT_A_DEFINE_EXPORTS
            3rdParty::mimalloc
)

ly_add_source_properties(
    SOURCES AzCore/Memory/SystemAllocator.cpp
    PROPERTY COMPILE_DEFINITIONS
    VALUES AZCORE_SYSTEM_ALLOCATOR=AZCORE_SYSTEM_ALLOCATOR_MALLOC
)

if(PAL_TRAIT_BUILD_TESTS_SUPPORTED)
    ly_add_target(
        NAME AzCore.Tests \${PAL_TRAIT_TEST_TARGET_TYPE}
        COMPILE_DEFINITIONS
            PRIVATE
                AZ_NUMERICCAST_ENABLED
    )
endif()
`;

const AZFRAMEWORK_CMAKE = `
ly_add_target(
    NAME AzFramework SHARED
    COMPILE_DEFINITIONS
        PRIVATE
            AZF_EXPORTS
)
ly_add_target(
    NAME AzFramework.NativeUI SHARED
    COMPILE_DEFINITIONS
        PRIVATE
            AZF_EXPORTS
            AZF_NATIVEUI_EXPORTS
)
`;

// ---- Parsing ----------------------------------------------------------------------------
suite("moduleDefines.exportDefinesIn", () => {
  test("reads the export define of an ly_add_target COMPILE_DEFINITIONS block, and stops at the next keyword", () => {
    assert.deepStrictEqual(exportDefinesIn(AZCORE_CMAKE), ["AZCORE_EXPORTS"]);
  });

  test("several targets in one file: every export define, first-seen order, no repeats", () => {
    assert.deepStrictEqual(exportDefinesIn(AZFRAMEWORK_CMAKE), ["AZF_EXPORTS", "AZF_NATIVEUI_EXPORTS"]);
  });

  test("the _EXPORT_SYMBOLS spelling, a generator expression and a plain target_compile_definitions call are read too", () => {
    const cmake = `
      ly_add_target(
          NAME AzQtComponents SHARED
          COMPILE_DEFINITIONS
              PRIVATE
                  AZ_QT_COMPONENTS_EXPORT_SYMBOLS
                  $<$<PLATFORM_ID:Windows>:AZ_QT_WIN_EXPORTS>
      )
      target_compile_definitions(Other PRIVATE OTHER_EXPORTS)
    `;
    assert.deepStrictEqual(exportDefinesIn(cmake), ["AZ_QT_COMPONENTS_EXPORT_SYMBOLS", "AZ_QT_WIN_EXPORTS", "OTHER_EXPORTS"]);
  });

  test("comments, ${variables} and text outside COMPILE_DEFINITIONS blocks are ignored", () => {
    const cmake = `
      set(SOME_EXPORTS ON)
      # COMPILE_DEFINITIONS OLD_EXPORTS
      #[[ COMPILE_DEFINITIONS BRACKET_EXPORTS ]]
      ly_add_target(
          NAME Thing SHARED
          COMPILE_DEFINITIONS
              PRIVATE
                  # REMOVED_EXPORTS
                  \${PAL_TRAIT_VARIABLE_EXPORTS}
                  THING_EXPORTS
      )
    `;
    assert.deepStrictEqual(exportDefinesIn(cmake), ["THING_EXPORTS"]);
  });

  test("defines that are not exports are not collected; no block or no CMake text means none", () => {
    assert.deepStrictEqual(exportDefinesIn("ly_add_target(NAME T COMPILE_DEFINITIONS PRIVATE AZ_PROFILE_BUILD)"), []);
    assert.deepStrictEqual(exportDefinesIn("add_subdirectory(Code)"), []);
    assert.deepStrictEqual(exportDefinesIn(""), []);
  });
});

suite("moduleDefines.declaresTarget", () => {
  test("ly_add_target, add_library and add_executable declare a target", () => {
    assert.ok(declaresTarget("ly_add_target(NAME X SHARED)"));
    assert.ok(declaresTarget("add_library(x STATIC a.cpp)"));
    assert.ok(declaresTarget("add_executable (x a.cpp)"));
  });

  test("a folder that only forwards, or only mentions a target in a comment, declares none", () => {
    assert.ok(!declaresTarget("add_subdirectory(AzCore)\nadd_subdirectory(AzFramework)"));
    assert.ok(!declaresTarget("# ly_add_target(NAME Old)\nadd_subdirectory(x)"));
  });
});

// ---- Fallback table ---------------------------------------------------------------------
suite("moduleDefines.fallbackExportDefines", () => {
  test("the four known Framework modules", () => {
    assert.deepStrictEqual(fallbackExportDefines(core("AzCore/a.cpp"), ROOT), ["AZCORE_EXPORTS"]);
    assert.deepStrictEqual(fallbackExportDefines(`${ROOT}/Code/Framework/AzFramework/AzFramework/a.cpp`, ROOT), ["AZF_EXPORTS"]);
    assert.deepStrictEqual(fallbackExportDefines(`${ROOT}/Code/Framework/AzToolsFramework/AzToolsFramework/a.cpp`, ROOT), ["AZTF_EXPORTS"]);
    assert.deepStrictEqual(fallbackExportDefines(`${ROOT}/Code/Framework/AzQtComponents/AzQtComponents/a.cpp`, ROOT), [
      "AZ_QT_COMPONENTS_EXPORT_SYMBOLS",
    ]);
  });

  test("case and slash direction don't matter", () => {
    assert.deepStrictEqual(fallbackExportDefines("D:\\Eng\\code\\framework\\AZCORE\\AzCore\\a.cpp", "d:/eng"), ["AZCORE_EXPORTS"]);
  });

  test("any other module, a gem, or a file outside the engine: none", () => {
    assert.deepStrictEqual(fallbackExportDefines(`${ROOT}/Code/Framework/AzNetworking/AzNetworking/a.cpp`, ROOT), []);
    assert.deepStrictEqual(fallbackExportDefines(`${ROOT}/Gems/Foo/Code/Source/a.cpp`, ROOT), []);
    assert.deepStrictEqual(fallbackExportDefines("/elsewhere/Code/Framework/AzCore/AzCore/a.cpp", ROOT), []);
  });
});

// ---- Lookup -----------------------------------------------------------------------------
suite("moduleDefines.createModuleDefineLookup", () => {
  test("walks up from a deep source to the module's CMakeLists.txt and returns its defines", () => {
    const disk = fakeDisk({ [`${ROOT}/Code/Framework/AzCore`]: AZCORE_CMAKE });
    const lookup = createModuleDefineLookup(ROOT, disk.read);
    assert.deepStrictEqual(lookup(core("AzCore/Component/Component.cpp")), ["AZCORE_EXPORTS"]);
  });

  test("parsed defines win over the fallback table", () => {
    const disk = fakeDisk({ [`${ROOT}/Code/Framework/AzCore`]: "ly_add_target(NAME AzCore SHARED COMPILE_DEFINITIONS PRIVATE AZCORE_NEXT_EXPORTS)" });
    assert.deepStrictEqual(createModuleDefineLookup(ROOT, disk.read)(core("AzCore/a.cpp")), ["AZCORE_NEXT_EXPORTS"]);
  });

  test("a gem's Code folder is a module too, whatever its name", () => {
    const disk = fakeDisk({ [`${ROOT}/Gems/Foo/Code`]: "ly_add_target(NAME Foo SHARED COMPILE_DEFINITIONS PRIVATE FOO_EXPORTS)" });
    assert.deepStrictEqual(createModuleDefineLookup(ROOT, disk.read)(`${ROOT}/Gems/Foo/Code/Source/Bar/Bar.cpp`), ["FOO_EXPORTS"]);
  });

  test("a CMakeLists.txt that declares no target is walked past; one that declares its own wins", () => {
    const disk = fakeDisk({
      [`${ROOT}/Code/Framework/AzCore`]: AZCORE_CMAKE,
      [`${ROOT}/Code/Framework/AzCore/AzCore`]: "add_subdirectory(Component)",
      [`${ROOT}/Code/Framework/AzCore/Tools`]: "ly_add_target(NAME AzCoreTools SHARED COMPILE_DEFINITIONS PRIVATE AZCORE_TOOLS_EXPORTS)",
    });
    const lookup = createModuleDefineLookup(ROOT, disk.read);
    assert.deepStrictEqual(lookup(core("AzCore/Component/Component.cpp")), ["AZCORE_EXPORTS"]);
    assert.deepStrictEqual(lookup(core("Tools/Editor/Tool.cpp")), ["AZCORE_TOOLS_EXPORTS"]);
  });

  test("the module's CMakeLists.txt is read once, however many of its files are asked about", () => {
    const disk = fakeDisk({ [`${ROOT}/Code/Framework/AzCore`]: AZCORE_CMAKE });
    const lookup = createModuleDefineLookup(ROOT, disk.read);
    for (const rest of ["AzCore/a.cpp", "AzCore/Component/b.cpp", "AzCore/Component/c.cpp", "AzCore/IO/d.cpp"]) {
      lookup(core(rest));
      lookup(core(rest));
    }
    const moduleReads = disk.reads.filter((dir) => dir === `${ROOT}/Code/Framework/AzCore`);
    assert.strictEqual(moduleReads.length, 1);
    assert.ok(disk.reads.length <= 4, `each directory at most once: ${disk.reads.join(", ")}`);
  });

  test("the engine root's own CMakeLists.txt is never consulted, and a file outside the engine gets nothing", () => {
    const disk = fakeDisk({ [ROOT]: "ly_add_target(NAME Everything SHARED COMPILE_DEFINITIONS PRIVATE ROOT_EXPORTS)" });
    const lookup = createModuleDefineLookup(ROOT, disk.read);
    assert.deepStrictEqual(lookup(`${ROOT}/Tools/x.cpp`), []);
    assert.ok(!disk.reads.includes(ROOT));
    disk.reads.length = 0;
    assert.deepStrictEqual(lookup("/elsewhere/Code/Framework/AzCore/AzCore/a.cpp"), []);
    assert.deepStrictEqual(disk.reads, []);
  });

  test("parsing finds nothing → the fallback table by folder; an unknown module → none", () => {
    const disk = fakeDisk({
      [`${ROOT}/Code/Framework/AzCore`]: "ly_add_target(NAME AzCore SHARED COMPILE_DEFINITIONS PRIVATE AZ_PROFILE_BUILD)",
      [`${ROOT}/Code/Framework/AzNetworking`]: "ly_add_target(NAME AzNetworking SHARED)",
    });
    const lookup = createModuleDefineLookup(ROOT, disk.read);
    assert.deepStrictEqual(lookup(core("AzCore/a.cpp")), ["AZCORE_EXPORTS"]);
    assert.deepStrictEqual(lookup(`${ROOT}/Code/Framework/AzFramework/AzFramework/a.cpp`), ["AZF_EXPORTS"], "no CMakeLists at all");
    assert.deepStrictEqual(lookup(`${ROOT}/Code/Framework/AzNetworking/AzNetworking/a.cpp`), []);
  });

  test("root and file may differ in case and slash direction (Windows)", () => {
    const disk = fakeDisk({ "d:/eng/code/framework/azcore": AZCORE_CMAKE });
    const lookup = createModuleDefineLookup("D:\\Eng", disk.read);
    assert.deepStrictEqual(lookup("D:\\Eng\\Code\\Framework\\AzCore\\AzCore\\Component\\Component.cpp"), ["AZCORE_EXPORTS"]);
  });
});

// ---- Disk (the default reader) ------------------------------------------------------------
suite("moduleDefines.createModuleDefineLookup on disk", () => {
  let root: string;
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-moduledefines-"));
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test("reads CMakeLists.txt files from a real directory tree", () => {
    const moduleDir = path.join(root, "Code", "Framework", "AzFramework");
    fs.mkdirSync(path.join(moduleDir, "AzFramework", "Entity"), { recursive: true });
    fs.writeFileSync(path.join(moduleDir, "CMakeLists.txt"), AZFRAMEWORK_CMAKE);
    const lookup = createModuleDefineLookup(root);
    assert.deepStrictEqual(lookup(path.join(moduleDir, "AzFramework", "Entity", "EntityContext.cpp")), ["AZF_EXPORTS", "AZF_NATIVEUI_EXPORTS"]);
  });

  test("an engine with no CMakeLists.txt at all falls back, never throws", () => {
    const file = path.join(root, "Code", "Framework", "AzToolsFramework", "AzToolsFramework", "a.cpp");
    assert.deepStrictEqual(createModuleDefineLookup(root)(file), ["AZTF_EXPORTS"]);
  });
});
