// ============================================================================
//  Compile database flag style — MSVC switches for cl / clang-cl, GNU switches for
//  everything else (clang++, g++ on Linux). Issue #27: a Linux database written with
//  /D /I /TP made clangd read "/Ifoo" as an input file, so no include path or define
//  reached it. Fixtures use Linux paths so they hold on any host.
//
//  Also here: warnings never become errors on any entry, and engine entries carry the
//  export defines of their own module (the lookup is injected; moduleDefines.test.ts
//  covers the real one).
// ============================================================================

import * as assert from "assert";
import { buildCompileDatabase, compilerToolchain, queryDriverFor, remapFlagTokens, withoutWarningsAsErrors } from "../intellisense/compileDb";
import { CommandGroup, CommandReply, CommandTarget, extractForcedIncludes, extractFragmentIncludes } from "../intellisense/fileApi";
import { RootMapping } from "../intellisense/remap";

const BUILD = "/home/dev/gs_play/build/linux";
const SOURCE = "/home/dev/gs_play";
const SDK = "/opt/o3de";
const SRC = "/home/dev/o3de_src";
const GEM_FILE = "/home/dev/gs_play_gems/gs_core/Code/Source/CoreSystem.cpp";
const C_FILE = "/home/dev/gs_play_gems/gs_core/Code/Source/Legacy.c";
const ENGINE_FILE = `${SRC}/Code/Framework/AzCore/AzCore/Component/Component.cpp`;
const mappings: RootMapping[] = [{ fromRoot: SDK, toRef: SRC }];

const MSVC_COMPILER = "C:/MSVC/bin/Hostx64/x64/cl.exe";
const CLANG_CL = "C:/LLVM/bin/clang-cl.exe";
const CLANG = "/usr/bin/clang++";
const GCC = "/usr/bin/g++";

// ---- Fixtures ----------------------------------------------------------------
function group(overrides: Partial<CommandGroup>): CommandGroup {
  return { language: "CXX", fragments: [], includes: [], defines: [], sourceIndexes: [], ...overrides };
}
/** A hand-built target with `compile` merged from its groups, as parseTarget merges real ones. */
function target(spec: Omit<CommandTarget, "compile">): CommandTarget {
  const fragments = (g: CommandGroup) => g.fragments.map((fragment) => ({ fragment }));
  return {
    ...spec,
    compile: {
      includes: spec.groups.flatMap((g) => [
        ...g.includes,
        ...extractFragmentIncludes(fragments(g)).map((p) => ({ path: p, isSystem: true })),
      ]),
      defines: spec.groups.flatMap((g) => g.defines),
      forcedIncludes: spec.groups.flatMap((g) => extractForcedIncludes(fragments(g))),
      standard: "20",
    },
  };
}
function reply(targets: CommandTarget[], compilerPath: string | undefined): CommandReply {
  return { config: "profile", sourceDir: SOURCE, buildDir: BUILD, compilerPath, targets };
}

/** A gem target in the shape CMake emits for GCC / clang: system includes in `includes`, flags in fragments. */
const gnuGem = target({
  name: "GS_Core",
  groups: [
    group({
      sourceIndexes: [0],
      defines: ["AZ_PROFILE_BUILD", 'LY_CMAKE_TARGET="GS_Core"'],
      includes: [
        { path: "/home/dev/gs_play_gems/gs_core/Code/Include" },
        { path: `${SDK}/Code/Framework/AzCore`, isSystem: true },
      ],
      fragments: [` -std=gnu++20 -fPIC -Wall -Werror -include ${SDK}/Compat/Compat.h`],
    }),
    group({ language: "C", sourceIndexes: [1], defines: ["AZ_PROFILE_BUILD"], fragments: [" -fPIC"] }),
  ],
  sources: [{ path: GEM_FILE, groupIndex: 0 }, { path: C_FILE, groupIndex: 1 }],
});

/** The same gem as a Windows build reports it. */
const msvcGem = target({
  name: "GS_Core",
  groups: [
    group({
      sourceIndexes: [0],
      defines: ["AZ_PROFILE_BUILD"],
      includes: [{ path: "/home/dev/gs_play_gems/gs_core/Code/Include" }, { path: `${SDK}/Code/Framework/AzCore`, isSystem: true }],
      fragments: [` /W4 /WX /FI${SDK}/Compat/VSCompat.h`],
    }),
  ],
  sources: [{ path: GEM_FILE, groupIndex: 0 }],
});

const entryFor = (compilerPath: string | undefined, gem: CommandTarget, file: string, platform?: NodeJS.Platform) =>
  buildCompileDatabase(reply([gem], compilerPath), mappings, [], platform).find((command) => command.file === file)!;

/** MSVC-only spellings. A GNU argv holding any of these is the #27 bug. */
const MSVC_TOKEN = /^\/(D|I|FI|TP$|TC$|W|external:)/;

// ---- Choosing the style --------------------------------------------------------
suite("compileDb.compilerToolchain", () => {
  test("cl and clang-cl are MSVC-style, whatever the case, extension or separators", () => {
    for (const compiler of [MSVC_COMPILER, CLANG_CL, "C:\\VS\\bin\\CL.EXE", "cl", "clang-cl"]) {
      assert.deepStrictEqual(compilerToolchain(compiler, "linux"), { compiler, style: "msvc" }, compiler);
    }
  });

  test("every other compiler is GNU-style", () => {
    for (const compiler of [CLANG, GCC, "/usr/bin/c++", "/usr/bin/g++-12", "/usr/bin/clang++-17", "C:/mingw/bin/g++.exe", "/opt/clang-cl-tools/bin/clang++"]) {
      assert.deepStrictEqual(compilerToolchain(compiler, "win32"), { compiler, style: "gnu" }, compiler);
    }
  });

  test("no compiler known: the host's default", () => {
    assert.deepStrictEqual(compilerToolchain(undefined, "win32"), { compiler: "cl.exe", style: "msvc" });
    assert.deepStrictEqual(compilerToolchain(undefined, "linux"), { compiler: "c++", style: "gnu" });
    assert.deepStrictEqual(compilerToolchain(undefined, "darwin"), { compiler: "c++", style: "gnu" });
  });
});

// ---- clangd --query-driver -----------------------------------------------------
suite("compileDb.queryDriverFor", () => {
  test("cl and clang-cl need no query", () => {
    for (const compiler of [MSVC_COMPILER, "C:\\VS\\bin\\Hostx64\\x64\\cl.exe", "C:\\VS\\bin\\CL.EXE", "cl.exe", CLANG_CL]) {
      assert.strictEqual(queryDriverFor(compiler), undefined, compiler);
    }
  });

  test("a GNU-style compiler is returned unchanged", () => {
    for (const compiler of [GCC, CLANG, "/usr/bin/c++", "C:/LLVM/bin/clang++.exe"]) {
      assert.strictEqual(queryDriverFor(compiler), compiler, compiler);
    }
  });

  test("no compiler known: nothing to query", () => {
    assert.strictEqual(queryDriverFor(undefined), undefined);
    assert.strictEqual(queryDriverFor(""), undefined);
  });
});

// ---- Project entries -----------------------------------------------------------
suite("compileDb project entries by compiler", () => {
  test("cl.exe: MSVC switches, /WX dropped", () => {
    assert.deepStrictEqual(entryFor(MSVC_COMPILER, msvcGem, GEM_FILE).arguments, [
      MSVC_COMPILER,
      "/DAZ_PROFILE_BUILD",
      "/I/home/dev/gs_play_gems/gs_core/Code/Include",
      `/external:I${SRC}/Code/Framework/AzCore`,
      "/W4",
      `/FI${SRC}/Compat/VSCompat.h`,
      "/TP",
      GEM_FILE,
    ]);
  });

  test("clang-cl.exe is MSVC-style too", () => {
    const args = entryFor(CLANG_CL, msvcGem, GEM_FILE).arguments;
    assert.strictEqual(args[0], CLANG_CL);
    assert.deepStrictEqual(args.slice(1, 4), ["/DAZ_PROFILE_BUILD", "/I/home/dev/gs_play_gems/gs_core/Code/Include", `/external:I${SRC}/Code/Framework/AzCore`]);
    assert.deepStrictEqual(args.slice(-2), ["/TP", GEM_FILE]);
  });

  for (const compiler of [CLANG, GCC]) {
    test(`${compiler}: GNU switches — -D, -I, -isystem <dir>, -x c++ before the file, -Werror dropped, nothing MSVC`, () => {
      const args = entryFor(compiler, gnuGem, GEM_FILE).arguments;
      assert.deepStrictEqual(args, [
        compiler,
        "-DAZ_PROFILE_BUILD",
        '-DLY_CMAKE_TARGET="GS_Core"',
        "-I/home/dev/gs_play_gems/gs_core/Code/Include",
        "-isystem",
        `${SRC}/Code/Framework/AzCore`, // remapped into the source engine
        "-std=gnu++20",
        "-fPIC",
        "-Wall",
        // -Werror is gone: a clang-only warning must not turn red
        "-include",
        `${SRC}/Compat/Compat.h`, // the two-token forced include is remapped too
        "-x",
        "c++",
        GEM_FILE,
      ]);
      assert.deepStrictEqual(args.filter((token) => MSVC_TOKEN.test(token)), []);
    });
  }

  test("a C source is `-x c`", () => {
    const args = entryFor(GCC, gnuGem, C_FILE).arguments;
    assert.deepStrictEqual(args.slice(-3), ["-x", "c", C_FILE]);
    assert.ok(!args.includes("c++"));
  });

  test("GNU include dirs that differ only in case are kept (Linux paths are case-sensitive); true repeats are dropped", () => {
    const gem = target({
      name: "T",
      groups: [
        group({
          includes: [{ path: "/inc/Foo" }, { path: "/inc/foo" }, { path: "/inc/Foo" }, { path: "/inc/Foo", isSystem: true }],
        }),
      ],
      sources: [{ path: GEM_FILE }],
    });
    const args = entryFor(GCC, gem, GEM_FILE).arguments;
    assert.deepStrictEqual(args.slice(1, 6), ["-I/inc/Foo", "-I/inc/foo", "-isystem", "/inc/Foo", "-x"]);
  });

  test("cl.exe: a C source is /TC", () => {
    const gem = target({
      name: "T",
      groups: [group({ language: "C", sourceIndexes: [0] })],
      sources: [{ path: C_FILE, groupIndex: 0 }],
    });
    assert.deepStrictEqual(entryFor(MSVC_COMPILER, gem, C_FILE).arguments.slice(-2), ["/TC", C_FILE]);
  });

  test("cl.exe: include dirs that differ only in case collapse (Windows paths ignore case)", () => {
    const gem = target({
      name: "T",
      groups: [
        group({
          sourceIndexes: [0],
          includes: [{ path: "/inc/Foo" }, { path: "/inc/foo" }, { path: "/inc/Foo", isSystem: true }, { path: "/inc/foo", isSystem: true }],
        }),
      ],
      sources: [{ path: GEM_FILE, groupIndex: 0 }],
    });
    const args = entryFor(MSVC_COMPILER, gem, GEM_FILE).arguments;
    assert.deepStrictEqual(args.slice(1, 3), ["/I/inc/Foo", "/external:I/inc/Foo"]); // the first spelling wins
    assert.strictEqual(args.filter((token) => /^\/(I|external:I)/.test(token)).length, 2);
  });

  test("no compiler in the reply: cl.exe + MSVC on a Windows host, c++ + GNU elsewhere", () => {
    const windows = entryFor(undefined, msvcGem, GEM_FILE, "win32").arguments;
    assert.strictEqual(windows[0], "cl.exe");
    assert.deepStrictEqual(windows.slice(-2), ["/TP", GEM_FILE]);

    const linux = entryFor(undefined, gnuGem, GEM_FILE, "linux").arguments;
    assert.strictEqual(linux[0], "c++");
    assert.deepStrictEqual(linux.slice(-3), ["-x", "c++", GEM_FILE]);
    assert.deepStrictEqual(linux.filter((token) => MSVC_TOKEN.test(token)), []);
  });
});

// ---- Engine entries ------------------------------------------------------------
suite("compileDb engine entries by compiler", () => {
  const runtime = target({
    name: "GS_Core",
    groups: [
      group({
        sourceIndexes: [0],
        defines: ["AZ_PROFILE_BUILD", "GS_Core_EXPORTS"],
        includes: [{ path: `${SDK}/Code/Framework/AzCore`, isSystem: true }, { path: "/home/dev/gs_play_gems/gs_core/Code/Include" }],
        fragments: [
          ` -std=gnu++20 -fPIC -Wall -Werror -Werror=format -Wno-error=unused-variable -I /stray/dir -isystem ${SDK}/Include/stray -include ${SDK}/Compat/Compat.h`,
        ],
      }),
    ],
    sources: [{ path: GEM_FILE }],
  });
  const engineEntries = (compilerPath: string, gem: CommandTarget) =>
    buildCompileDatabase(reply([gem], compilerPath), mappings, [ENGINE_FILE]).find((command) => command.file === ENGINE_FILE)!;

  for (const compiler of [CLANG, GCC]) {
    test(`${compiler}: GNU switches, -Werror dropped, fragment include dirs left to the union, forced include kept and remapped`, () => {
      const args = engineEntries(compiler, runtime).arguments;
      assert.deepStrictEqual(args, [
        compiler,
        "-DAZ_PROFILE_BUILD", // the AGREED defines: with one gem, its own
        "-DGS_Core_EXPORTS",
        "-isystem",
        `${SRC}/Code/Framework/AzCore`,
        "-I/home/dev/gs_play_gems/gs_core/Code/Include",
        "-std=gnu++20",
        "-fPIC",
        "-Wall",
        "-Wno-error=unused-variable", // only the errors-making forms go
        "-include",
        `${SRC}/Compat/Compat.h`,
        "-x",
        "c++",
        ENGINE_FILE,
      ]);
      assert.deepStrictEqual(args.filter((token) => MSVC_TOKEN.test(token)), []);
    });
  }

  test("clang-cl.exe: MSVC switches, /WX dropped, /TP", () => {
    const gem = target({
      name: "GS_Core",
      groups: [group({ sourceIndexes: [0], defines: ["AZ_PROFILE_BUILD"], fragments: [" /W4 /WX"] })],
      sources: [{ path: GEM_FILE }],
    });
    assert.deepStrictEqual(engineEntries(CLANG_CL, gem).arguments, [CLANG_CL, "/DAZ_PROFILE_BUILD", "/W4", "/TP", ENGINE_FILE]);
  });
});

// ---- Warnings stay warnings ----------------------------------------------------
suite("compileDb warnings-as-errors", () => {
  const withFlags = (fragment: string): CommandTarget =>
    target({ name: "T", groups: [group({ sourceIndexes: [0], fragments: [fragment] })], sources: [{ path: GEM_FILE, groupIndex: 0 }] });

  test("withoutWarningsAsErrors drops /WX, -WX, -Werror, -Werror=<x> and -Werror-<x>, and nothing else", () => {
    assert.deepStrictEqual(
      withoutWarningsAsErrors([
        "/W4", "/WX", "-WX", "-Werror", "-Werror=switch", "-Werror-implicit-function-declaration",
        "-Wno-error", "-Wno-error=switch", "/WX-", "-Wall", "-Wextra",
      ]),
      ["/W4", "-Wno-error", "-Wno-error=switch", "/WX-", "-Wall", "-Wextra"],
    );
  });

  test("a GNU project entry loses -Werror and -Werror=<x> but keeps -Wno-error=<x>", () => {
    const args = entryFor(GCC, withFlags(" -Wall -Werror -Werror=format -Wno-error=unused-variable -Wextra"), GEM_FILE).arguments;
    assert.deepStrictEqual(args.filter((token) => token.startsWith("-W")), ["-Wall", "-Wno-error=unused-variable", "-Wextra"]);
  });

  test("an MSVC project entry loses /WX and -WX", () => {
    for (const compiler of [MSVC_COMPILER, CLANG_CL]) {
      const args = entryFor(compiler, withFlags(" /W4 /WX -WX /permissive-"), GEM_FILE).arguments;
      assert.ok(!args.includes("/WX") && !args.includes("-WX"), compiler);
      assert.ok(args.includes("/W4") && args.includes("/permissive-"), "other switches stay");
    }
  });
});

// ---- Engine module export defines -----------------------------------------------
suite("compileDb engine module defines", () => {
  const AZ_FILE = `${SRC}/Code/Framework/AzCore/AzCore/Component/Component.cpp`;
  const AZF_FILE = `${SRC}/Code/Framework/AzFramework/AzFramework/Entity/EntityContext.cpp`;
  const OTHER_FILE = `${SRC}/Code/Framework/AzNetworking/AzNetworking/Utilities/Endian.cpp`;
  const lookup = (file: string): string[] =>
    file.includes("/AzCore/") ? ["AZCORE_EXPORTS"] : file.includes("/AzFramework/") ? ["AZF_EXPORTS", "AZF_NATIVEUI_EXPORTS"] : [];
  const gem = (fragment: string): CommandTarget =>
    target({
      name: "GS_Core",
      groups: [group({ sourceIndexes: [0], defines: ["AZ_PROFILE_BUILD"], fragments: [fragment] })],
      sources: [{ path: GEM_FILE, groupIndex: 0 }],
    });
  const build = (compiler: string, withLookup: boolean) =>
    buildCompileDatabase(reply([gem(" -std=gnu++20 /W4")], compiler), mappings, [AZ_FILE, AZF_FILE, OTHER_FILE], undefined, withLookup ? lookup : undefined);
  const argsOf = (commands: ReturnType<typeof build>, file: string) => commands.find((command) => command.file === file)!.arguments;

  test("GNU: each engine file gets its module's defines as -D, right after the agreed defines", () => {
    const commands = build(GCC, true);
    assert.deepStrictEqual(argsOf(commands, AZ_FILE).slice(0, 3), [GCC, "-DAZ_PROFILE_BUILD", "-DAZCORE_EXPORTS"]);
    assert.deepStrictEqual(argsOf(commands, AZF_FILE).slice(0, 4), [GCC, "-DAZ_PROFILE_BUILD", "-DAZF_EXPORTS", "-DAZF_NATIVEUI_EXPORTS"]);
  });

  test("MSVC: the same defines as /D", () => {
    for (const compiler of [MSVC_COMPILER, CLANG_CL]) {
      const commands = build(compiler, true);
      assert.deepStrictEqual(argsOf(commands, AZ_FILE).slice(0, 3), [compiler, "/DAZ_PROFILE_BUILD", "/DAZCORE_EXPORTS"], compiler);
      assert.deepStrictEqual(argsOf(commands, AZ_FILE).slice(-2), ["/TP", AZ_FILE], "the language switch stays right before the file");
    }
  });

  test("the rest of the command is the shared template, byte for byte: only the defines are added", () => {
    for (const compiler of [GCC, MSVC_COMPILER]) {
      const plain = build(compiler, false);
      const withDefines = build(compiler, true);
      for (const file of [AZ_FILE, AZF_FILE]) {
        assert.deepStrictEqual(
          argsOf(withDefines, file).filter((token) => !/^[-/]D\w*_EXPORTS$/.test(token)),
          argsOf(plain, file),
          `${compiler} ${file}`,
        );
      }
    }
  });

  test("a module the lookup knows nothing about keeps the shared command alone", () => {
    for (const compiler of [GCC, MSVC_COMPILER]) {
      assert.deepStrictEqual(argsOf(build(compiler, true), OTHER_FILE), argsOf(build(compiler, false), OTHER_FILE), compiler);
    }
  });

  test("no lookup: every engine entry is the shared command (unchanged behaviour)", () => {
    const commands = build(GCC, false);
    assert.strictEqual(argsOf(commands, AZ_FILE).filter((token) => /_EXPORTS$/.test(token)).length, 0);
    assert.deepStrictEqual(argsOf(commands, AZ_FILE).slice(0, -1), argsOf(commands, AZF_FILE).slice(0, -1));
  });

  test("a project's own entry is untouched by the lookup", () => {
    const entry = buildCompileDatabase(reply([gem(" /W4")], GCC), mappings, [], undefined, () => ["NEVER_EXPORTS"]).find((c) => c.file === GEM_FILE)!;
    assert.ok(!entry.arguments.some((token) => token.includes("NEVER_EXPORTS")));
  });
});

// ---- Two-token path switches ---------------------------------------------------
suite("compileDb.remapFlagTokens, GNU forms", () => {
  const remap = (tokens: string[]) => remapFlagTokens(tokens, mappings);

  test("-include, -isystem, -I, -iquote, -idirafter and -imacros remap a detached value", () => {
    for (const name of ["-include", "-isystem", "-I", "-iquote", "-idirafter", "-imacros"]) {
      assert.deepStrictEqual(remap([name, `${SDK}/Code/x`, "-fPIC"]), [name, `${SRC}/Code/x`, "-fPIC"], name);
    }
  });

  test("attached values remap too: -I<dir>, -isystem<dir>", () => {
    assert.deepStrictEqual(remap([`-I${SDK}/a`, `-isystem${SDK}/b`]), [`-I${SRC}/a`, `-isystem${SRC}/b`]);
  });

  test("a switch with no value left, and look-alike switches, pass through untouched", () => {
    const tokens = ["-std=c++20", "-fPIC", "-Wall", "-include-pch", `${SDK}/x.pch`, "-imultilib", "lib64", "-include"];
    assert.deepStrictEqual(remap(tokens), tokens);
  });
});
