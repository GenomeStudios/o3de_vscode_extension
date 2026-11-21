// ============================================================================
//  Declared include dirs — read from a gem's own CMakeLists.txt, so a folder the gem
//  names (`../External/CubeMapGen`) is on its include path, not only the conventional
//  Include / Source folders. Fixtures are tiny CMakeLists texts shaped like the engine's
//  own; nothing here depends on a real engine or this machine's layout.
// ============================================================================

import * as assert from "assert";
import { declaredIncludeDirsIn, palFolderName } from "../intellisense/declaredIncludes";
import { blocksOf } from "../intellisense/moduleDefines";

const DIR = "/gem/Code";
const dirsOf = (cmake: string, platform: NodeJS.Platform = "win32", variables: Record<string, string> = {}): string[] =>
  declaredIncludeDirsIn(cmake, DIR, platform, variables);

// ---- Fixtures ----------------------------------------------------------------------------
/** The shape of ImageProcessingAtom's Code/CMakeLists.txt: two targets, PAL variables, a loop-built list, `.`, `../External/X`. */
const IMAGE_PROCESSING_CMAKE = `
ly_add_target(
    NAME \${gem_name}.Headers HEADERONLY
    NAMESPACE Gem
    FILES_CMAKE
        imageprocessingatom_headers_files.cmake
    INCLUDE_DIRECTORIES
        INTERFACE
            Include
)

set(pal_tools_include_dirs)
foreach(enabled_platform \${LY_PAL_TOOLS_ENABLED})
    o3de_pal_dir(pal_tools_source_dir \${CMAKE_CURRENT_LIST_DIR}/Source/Platform/\${enabled_platform} "\${gem_restricted_path}" "\${gem_path}" "\${gem_parent_relative_path}")
    list(APPEND pal_tools_include_dirs \${pal_tools_source_dir})
endforeach()

o3de_pal_dir(pal_source_dir \${CMAKE_CURRENT_LIST_DIR}/Source/Platform/\${PAL_PLATFORM_NAME} "\${gem_restricted_path}" "\${gem_path}" "\${gem_parent_relative_path}")
set(common_source_dir \${CMAKE_CURRENT_LIST_DIR}/Source/Platform/Common)

ly_add_target(
    NAME \${gem_name}.Editor.Static STATIC
    NAMESPACE Gem
    AUTOMOC
    FILES_CMAKE
        imageprocessing_files.cmake
        \${pal_source_dir}/platform_\${PAL_PLATFORM_NAME_LOWERCASE}_files.cmake
    INCLUDE_DIRECTORIES
        PUBLIC
            Include
            \${pal_source_dir}
            \${pal_tools_include_dirs}
            .
            Source
            ../External/CubeMapGen
    BUILD_DEPENDENCIES
        PUBLIC
            3rdParty::Qt::Core
            AZ::AzFramework
)
`;

// ---- Blocks ------------------------------------------------------------------------------
suite("declaredIncludes: reading INCLUDE_DIRECTORIES blocks", () => {
  test("PUBLIC, PRIVATE and INTERFACE paths all count, in order, and the block stops at the next keyword", () => {
    const cmake = `
      ly_add_target(
          NAME Thing STATIC
          INCLUDE_DIRECTORIES
              PRIVATE
                  Source
              PUBLIC
                  Include
              INTERFACE
                  Public
          COMPILE_DEFINITIONS
              PRIVATE
                  NOT_A_PATH_EXPORTS
          BUILD_DEPENDENCIES
              PRIVATE
                  AZ::AzCore
      )
    `;
    assert.deepStrictEqual(dirsOf(cmake), [`${DIR}/Source`, `${DIR}/Include`, `${DIR}/Public`]);
  });

  test("relative paths resolve against the CMakeLists.txt folder: '.', 'Source', '../External/X'", () => {
    const cmake = "ly_add_target(NAME T STATIC INCLUDE_DIRECTORIES PUBLIC . Source ../External/CubeMapGen ../../Shared)";
    assert.deepStrictEqual(dirsOf(cmake), [DIR, `${DIR}/Source`, "/gem/External/CubeMapGen", "/Shared"]);
  });

  test("absolute paths and Windows drive paths stay as they are; quoted paths and trailing slashes are cleaned", () => {
    const cmake = `ly_add_target(NAME T STATIC INCLUDE_DIRECTORIES PUBLIC /opt/lib/include D:/Libs/include "Quoted" Source/)`;
    assert.deepStrictEqual(dirsOf(cmake), ["/opt/lib/include", "D:/Libs/include", `${DIR}/Quoted`, `${DIR}/Source`]);
  });

  test("a CMakeLists folder given with backslashes or a trailing slash resolves the same", () => {
    assert.deepStrictEqual(declaredIncludeDirsIn("ly_add_target(NAME T STATIC INCLUDE_DIRECTORIES PUBLIC Source)", "D:\\Gems\\a\\Code\\", "win32"), ["D:/Gems/a/Code/Source"]);
  });

  test("several targets: every target's dirs, first-seen order, a dir named twice (or in another case) once", () => {
    const cmake = `
      ly_add_target(NAME A STATIC INCLUDE_DIRECTORIES PUBLIC Include Source)
      ly_add_target(NAME A.Editor STATIC INCLUDE_DIRECTORIES PRIVATE source Editor PUBLIC Include)
    `;
    assert.deepStrictEqual(dirsOf(cmake), [`${DIR}/Include`, `${DIR}/Source`, `${DIR}/Editor`]);
  });

  test("a plain target_include_directories call: the target is not a path; SYSTEM and BEFORE are skipped", () => {
    const cmake = `
      target_include_directories(MyTarget PRIVATE Source ../Vendored)
      target_include_directories (Other SYSTEM BEFORE PUBLIC third_party/include)
    `;
    assert.deepStrictEqual(dirsOf(cmake), [`${DIR}/Source`, "/gem/Vendored", `${DIR}/third_party/include`]);
  });

  test("a keyword that is part of a path is not a keyword", () => {
    const cmake = "ly_add_target(NAME T STATIC INCLUDE_DIRECTORIES PUBLIC Include/NAME Include/STATIC_Libs SHARED_Headers)";
    assert.deepStrictEqual(dirsOf(cmake), [`${DIR}/Include/NAME`, `${DIR}/Include/STATIC_Libs`, `${DIR}/SHARED_Headers`]);
  });

  test("an ly_add_target option after the block ends it (INCLUDE_DIRECTORIES ... HEADERONLY)", () => {
    assert.deepStrictEqual(dirsOf("ly_add_target(NAME T INCLUDE_DIRECTORIES PUBLIC Include HEADERONLY)"), [`${DIR}/Include`]);
  });

  test("line comments and bracket comments are ignored", () => {
    const cmake = `
      # INCLUDE_DIRECTORIES PUBLIC OldDir
      #[[ INCLUDE_DIRECTORIES PUBLIC BracketDir ]]
      ly_add_target(
          NAME T STATIC
          INCLUDE_DIRECTORIES
              PUBLIC
                  Include
                  # Removed
                  Source # trailing
      )
    `;
    assert.deepStrictEqual(dirsOf(cmake), [`${DIR}/Include`, `${DIR}/Source`]);
  });

  test("no include block, no text: no dirs", () => {
    assert.deepStrictEqual(dirsOf("add_subdirectory(Code)"), []);
    assert.deepStrictEqual(dirsOf("ly_add_target(NAME T STATIC COMPILE_DEFINITIONS PRIVATE X)"), []);
    assert.deepStrictEqual(dirsOf(""), []);
  });
});

// ---- Variables ---------------------------------------------------------------------------
suite("declaredIncludes: variables", () => {
  test("ImageProcessingAtom's real shape: its PAL folder, '.', Source and ../External/CubeMapGen; the loop-built list is skipped", () => {
    assert.deepStrictEqual(dirsOf(IMAGE_PROCESSING_CMAKE), [
      `${DIR}/Include`,
      `${DIR}/Source/Platform/Windows`,
      DIR,
      `${DIR}/Source`,
      "/gem/External/CubeMapGen",
    ]);
  });

  test("the PAL folder follows the host: Windows, Linux, Mac", () => {
    assert.ok(dirsOf(IMAGE_PROCESSING_CMAKE, "linux").includes(`${DIR}/Source/Platform/Linux`));
    assert.ok(dirsOf(IMAGE_PROCESSING_CMAKE, "darwin").includes(`${DIR}/Source/Platform/Mac`));
    assert.ok(!dirsOf(IMAGE_PROCESSING_CMAKE, "linux").some((dir) => dir.endsWith("/Windows")));
  });

  test("palFolderName: the three hosts, nothing for any other", () => {
    assert.deepStrictEqual([palFolderName("win32"), palFolderName("linux"), palFolderName("darwin"), palFolderName("freebsd")], ["Windows", "Linux", "Mac", undefined]);
  });

  test("a platform with no PAL name resolves no PAL variable, and the rest still resolves", () => {
    assert.deepStrictEqual(dirsOf(IMAGE_PROCESSING_CMAKE, "freebsd"), [`${DIR}/Include`, DIR, `${DIR}/Source`, "/gem/External/CubeMapGen"]);
  });

  test("the lower-case and PAL_HOST_ names resolve too", () => {
    const cmake = `
      ly_add_target(NAME T STATIC INCLUDE_DIRECTORIES PUBLIC
          Source/Platform/\${PAL_PLATFORM_NAME_LOWERCASE}
          Source/Host/\${PAL_HOST_PLATFORM_NAME}
          Source/HostLower/\${PAL_HOST_PLATFORM_NAME_LOWERCASE})
    `;
    assert.deepStrictEqual(dirsOf(cmake, "linux"), [`${DIR}/Source/Platform/linux`, `${DIR}/Source/Host/Linux`, `${DIR}/Source/HostLower/linux`]);
  });

  test("CMAKE_CURRENT_LIST_DIR and CMAKE_CURRENT_SOURCE_DIR are the CMakeLists.txt folder", () => {
    const cmake = "ly_add_target(NAME T STATIC INCLUDE_DIRECTORIES PUBLIC ${CMAKE_CURRENT_LIST_DIR}/A ${CMAKE_CURRENT_SOURCE_DIR}/B)";
    assert.deepStrictEqual(dirsOf(cmake), [`${DIR}/A`, `${DIR}/B`]);
  });

  test("set(<var> <literal path>) in the same file resolves, including chains; o3de_pal_dir and ly_get_list_relative_pal_filename too", () => {
    const cmake = `
      set(common_dir \${CMAKE_CURRENT_LIST_DIR}/Source/Common)
      set(deeper \${common_dir}/Deeper)
      o3de_pal_dir(pal_dir \${CMAKE_CURRENT_LIST_DIR}/Platform/\${PAL_PLATFORM_NAME} "\${gem_restricted_path}" "\${gem_path}")
      ly_get_list_relative_pal_filename(legacy_dir \${CMAKE_CURRENT_LIST_DIR}/Legacy/\${PAL_PLATFORM_NAME})
      ly_add_target(NAME T STATIC INCLUDE_DIRECTORIES PUBLIC \${common_dir} \${deeper} \${pal_dir} \${legacy_dir})
    `;
    assert.deepStrictEqual(dirsOf(cmake), [`${DIR}/Source/Common`, `${DIR}/Source/Common/Deeper`, `${DIR}/Platform/Windows`, `${DIR}/Legacy/Windows`]);
  });

  test("variables that can't be known are skipped quietly: loop-built, binary dir, unset, generator expressions", () => {
    const cmake = `
      ly_add_target(NAME T STATIC INCLUDE_DIRECTORIES PUBLIC
          \${pal_tools_include_dirs}
          \${CMAKE_CURRENT_BINARY_DIR}/Generated
          \${never_set}/Include
          Source/\${enabled_platform}
          $<BUILD_INTERFACE:Include>
          $<$<PLATFORM_ID:Windows>:Windows>
          Kept)
    `;
    assert.deepStrictEqual(dirsOf(cmake), [`${DIR}/Kept`]);
  });

  test("a set() that is a list, or ends in PARENT_SCOPE / CACHE, gives the variable no value", () => {
    const cmake = `
      set(several A B)
      set(scoped \${CMAKE_CURRENT_LIST_DIR}/Scoped PARENT_SCOPE)
      set(empty "")
      set(unset_list)
      ly_add_target(NAME T STATIC INCLUDE_DIRECTORIES PUBLIC \${several} \${scoped} \${empty} \${unset_list} Kept)
    `;
    assert.deepStrictEqual(dirsOf(cmake), [`${DIR}/Kept`]);
  });

  test("a set_target_properties or ly_set call is no variable definition", () => {
    const cmake = `
      ly_set(fake \${CMAKE_CURRENT_LIST_DIR}/Fake)
      set_target_properties(T PROPERTIES x 1)
      ly_add_target(NAME T STATIC INCLUDE_DIRECTORIES PUBLIC \${fake} Kept)
    `;
    assert.deepStrictEqual(dirsOf(cmake), [`${DIR}/Kept`]);
  });

  test("variables the caller knows (gem_name, gem_path) resolve; the file's own unconditional set() wins over them", () => {
    const cmake = `
      ly_add_target(NAME T STATIC INCLUDE_DIRECTORIES PUBLIC Source/\${gem_name} \${gem_path}/Shared)
    `;
    assert.deepStrictEqual(dirsOf(cmake, "win32", { gem_name: "MyGem", gem_path: "/gem" }), [`${DIR}/Source/MyGem`, "/gem/Shared"]);
    assert.deepStrictEqual(dirsOf(`set(gem_name Own)\n${cmake}`, "win32", { gem_name: "MyGem", gem_path: "/gem" })[0], `${DIR}/Source/Own`);
    assert.deepStrictEqual(dirsOf(cmake), [], "without them, skipped");
  });

  test("the gem template's preamble sets gem_name and gem_path only if not set: the caller's values win, its defaults fill in otherwise", () => {
    const cmake = `
      o3de_find_ancestor_gem_root(gem_path gem_name "\${CMAKE_CURRENT_SOURCE_DIR}")
      if(NOT gem_name)
          set(gem_name "X")
      endif()
      if(NOT gem_path)
          set(gem_path \${CMAKE_CURRENT_SOURCE_DIR})
      endif()
      ly_add_target(NAME \${gem_name}.Static STATIC INCLUDE_DIRECTORIES PUBLIC Source/\${gem_name} \${gem_path}/Shared)
    `;
    assert.deepStrictEqual(dirsOf(cmake, "win32", { gem_name: "MyGem", gem_path: "/gem" }), [`${DIR}/Source/MyGem`, "/gem/Shared"]);
    assert.deepStrictEqual(dirsOf(cmake, "win32", { gem_name: "MyGem" }), [`${DIR}/Source/MyGem`, `${DIR}/Shared`], "a variable the caller lacks takes the file's default");
    assert.deepStrictEqual(dirsOf(cmake), [`${DIR}/Source/X`, `${DIR}/Shared`], "with nothing from the caller, the defaults");
  });
});

// ---- The shared block scanner ------------------------------------------------------------
suite("moduleDefines.blocksOf", () => {
  test("each match's capture group, cut at the next ly_add_target keyword (whole words only)", () => {
    const text = "COMPILE_DEFINITIONS PRIVATE A_EXPORTS INCLUDE_DIRECTORIES PUBLIC x ) COMPILE_DEFINITIONS B_NAME_EXPORTS NAME";
    const blocks = blocksOf(text, /\bCOMPILE_DEFINITIONS\b([^)]*)/g).map((block) => block.trim().split(/\s+/));
    assert.deepStrictEqual(blocks, [["PRIVATE", "A_EXPORTS"], ["B_NAME_EXPORTS"]]);
  });

  test("a block with no keyword runs to the closing parenthesis; no match, no blocks", () => {
    assert.deepStrictEqual(blocksOf("x(a b)", /x\(([^)]*)/g), ["a b"]);
    assert.deepStrictEqual(blocksOf("nothing", /x\(([^)]*)/g), []);
  });
});
