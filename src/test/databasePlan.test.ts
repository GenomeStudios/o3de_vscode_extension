// ============================================================================
//  Database plan — which engine gems take part, which gem sources the build never
//  lists, and the entries both get (databasePlan.ts), plus the shared-command groups
//  in compileDb.ts they ride on.
//
//  Fixtures are tiny fake trees in a temp dir: an SDK engine, a source engine with
//  two gems, and three gems of the user's own. Nothing depends on a real engine, a
//  real project or this machine's paths — the plan reads only what the tree holds.
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildCompileDatabase, listGemSources } from "../intellisense/compileDb";
import {
  OriginCounts,
  PlanInputs,
  gemCodeRoot,
  gemDeclaredIncludeDirs,
  gemIncludeDirs,
  parseEngineCoverage,
  participatingGemRoots,
  planCompileDatabase,
  reachedGemRoots,
  readManifestGems,
  relevantManifestGems,
} from "../intellisense/databasePlan";
import { CommandGroup, CommandReply, CommandTarget, IncludeEntry } from "../intellisense/fileApi";
import { normalizePath } from "../intellisense/paths";
import { O3deProject } from "../o3de/identity";

const CL = "C:/MSVC/bin/Hostx64/x64/cl.exe";

// ---- Fixture tree ------------------------------------------------------------
let root: string;
let R: string; // the tree's root, forward slashes

function write(rel: string, text = ""): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/**
 *  sdk/                      an SDK engine: headers only
 *  src/                      its source engine
 *    Code/Framework/AzCore   reachable by the project (own export define)
 *    Code/Framework/AzFramework   not reachable
 *    Gems/Atom/RPI           an engine gem the project's includes reach (Tests, Linux PAL, vendored, build output beside the code)
 *    Gems/Atom/Utils         include dir reached, but no gem.json anywhere above it
 *    Gems/Unused             a gem nothing reaches
 *  gems/mygem                the user's gem: one source in a target, one the build never lists
 *  gems/notenabled           named by project.json external_subdirectories
 *  gems/registered           in the o3de manifest AND enabled by the project (gem_names)
 *  gems/unrelated            in the o3de manifest only: the project doesn't enable it, the workspace doesn't hold it
 *  project/                  the project, with its build tree under build/windows
 */
function buildTree(): void {
  write("sdk/engine.json", JSON.stringify({ engine_name: "sdk-engine", sdk_engine: true }));
  write("src/engine.json", JSON.stringify({ engine_name: "source-engine" }));

  write("src/Code/Framework/AzCore/AzCore/Component.cpp");
  write("src/Code/Framework/AzCore/CMakeLists.txt", "ly_add_target(\n  NAME AzCore SHARED\n  COMPILE_DEFINITIONS\n    PRIVATE\n      AZCORE_EXPORTS\n)\n");
  write("src/Code/Framework/AzFramework/AzFramework/Entity.cpp");

  write("src/Gems/Atom/RPI/gem.json", JSON.stringify({ gem_name: "Atom_RPI" }));
  write("src/Gems/Atom/RPI/Code/CMakeLists.txt", "ly_add_target(\n  NAME Atom_RPI.Public STATIC\n  COMPILE_DEFINITIONS\n    PRIVATE\n      ATOM_RPI_PUBLIC_EXPORTS\n)\n");
  write("src/Gems/Atom/RPI/Code/Include/Atom/RPI/Pass.h");
  write("src/Gems/Atom/RPI/Code/Source/Pass.cpp");
  write("src/Gems/Atom/RPI/Code/Source/Tests/PassTests.cpp");
  write("src/Gems/Atom/RPI/Code/Tests/RPITests.cpp");
  write("src/Gems/Atom/RPI/Code/External/Vendored.cpp");
  write("src/Gems/Atom/RPI/Code/build/Generated.cpp");
  write("src/Gems/Atom/RPI/Code/Platform/Windows/Pass_Windows.cpp");
  write("src/Gems/Atom/RPI/Code/Platform/Linux/Pass_Linux.cpp");
  write("src/Gems/Atom/RPI/Code/Platform/Mac/Pass_Mac.cpp");
  write("src/Gems/Atom/RPI/Code/Source/Platform/Windows/Traits_Platform.h"); // PAL headers most engine gems keep under Source
  write("src/Gems/Atom/RPI/Code/Source/Platform/Linux/Traits_Platform.h");
  write("src/Gems/Atom/RPI/Code/Source/Platform/Mac/Traits_Platform.h");
  write("src/Gems/Atom/RPI/Code/Source/Platform/Common/Traits_Common.h");
  write("src/Gems/Atom/RPI/Code/Platform/Common/UnixLike/Unix.cpp");
  write("src/Gems/Atom/RPI/Code/Platform/Common/Common.h");
  write("src/Gems/Atom/Utils/Code/Include/Utils.h");
  write("src/Gems/Unused/gem.json", JSON.stringify({ gem_name: "Unused" }));
  write("src/Gems/Unused/Code/Source/Unused.cpp");

  write("gems/mygem/gem.json", JSON.stringify({ gem_name: "MyGem" }));
  write("gems/mygem/Code/Include/MyGem/Bus.h");
  write("gems/mygem/Code/Source/InTarget.cpp");
  write("gems/mygem/Code/Source/Fallback.cpp");
  write("gems/mygem/Code/Tests/FallbackTests.cpp");
  write("gems/notenabled/gem.json", JSON.stringify({ gem_name: "NotEnabled" }));
  write("gems/notenabled/Code/Include/NotEnabled/Bus.h");
  write("gems/notenabled/Code/Source/Other.cpp");
  write("gems/registered/gem.json", JSON.stringify({ gem_name: "Registered" }));
  write("gems/registered/Source/Reg.cpp"); // no Code folder: the gem root is its code
  write("gems/registered/Include/Registered/Bus.h");
  write("gems/unrelated/gem.json", JSON.stringify({ gem_name: "Unrelated" }));
  write("gems/unrelated/Code/Source/Unrelated.cpp");
  write("gems/notagem/Code/Source/Nothing.cpp"); // named, but no gem.json: skipped quietly

  write("project/project.json", JSON.stringify({ project_name: "Proj" }));
  write("project/Source/Main.cpp");
  write("project/build/windows/Unity/unity_0_cxx.cxx");
}

/** Give the calling suite a fresh fixture tree for every test. */
function useTree(): void {
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-plan-"));
    R = normalizePath(root);
    buildTree();
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));
}

// ---- Fixture reply -----------------------------------------------------------
function group(overrides: Partial<CommandGroup>): CommandGroup {
  return { language: "CXX", fragments: [], includes: [], defines: [], sourceIndexes: [], ...overrides };
}
function target(spec: Omit<CommandTarget, "compile">): CommandTarget {
  return {
    ...spec,
    compile: {
      includes: spec.groups.flatMap((g) => g.includes),
      defines: spec.groups.flatMap((g) => g.defines),
      forcedIncludes: [],
      standard: "20",
    },
  };
}

/** The project's reply: the SDK's include dirs (the source engine has the same layout), one gem source, one project source. */
function projectReply(): CommandReply {
  const includes: IncludeEntry[] = [
    { path: `${R}/gems/mygem/Code/Include` },
    { path: `${R}/sdk/Code/Framework/AzCore`, isSystem: true },
    { path: `${R}/sdk/Gems/Atom/RPI/Code/Include`, isSystem: true },
    { path: `${R}/sdk/Gems/Atom/Utils/Code/Include`, isSystem: true },
  ];
  const compiled = target({
    name: "MyGem",
    groups: [group({ sourceIndexes: [0, 1], defines: ["AZ_PROFILE_BUILD", "MYGEM_EXPORTS"], includes, fragments: [" /W4 /WX /permissive-"] })],
    sources: [
      { path: `${R}/gems/mygem/Code/Source/InTarget.cpp`, groupIndex: 0 },
      { path: `${R}/project/Source/Main.cpp`, groupIndex: 0 },
      { path: `${R}/project/build/windows/Unity/unity_0_cxx.cxx`, groupIndex: 0 },
    ],
  });
  return { config: "profile", sourceDir: `${R}/project`, buildDir: `${R}/project/build/windows`, compilerPath: CL, targets: [compiled] };
}

function project(): O3deProject {
  return {
    projectName: "Proj",
    externalSubdirectories: ["../gems/notenabled"], // relative to the project root, as project.json writes it
    gemNames: ["Registered>=1.0"], // enabled, with a version specifier as project.json may write it
    path: path.join(root, "project"),
  };
}

function inputs(overrides: Partial<PlanInputs> = {}): PlanInputs {
  return {
    reply: projectReply(),
    project: project(),
    coverage: "participating",
    platform: "win32",
    buildEngineRoot: `${R}/sdk`,
    sourceEngineRoot: `${R}/src`,
    manifestGems: [
      path.join(root, "gems", "registered"),
      path.join(root, "gems", "unrelated"),
      path.join(root, "gems", "notagem"),
      path.join(root, "gems", "missing"),
      path.join(root, "src", "Gems", "Unused"),
    ],
    ...overrides,
  };
}

/** The plan's files, relative to the tree's root. */
const filesOf = (commands: { file: string }[]): string[] => commands.map((command) => command.file.slice(R.length + 1));
const rel = (files: string[]): string[] => files.map((file) => file.slice(R.length + 1));

// ---- Setting -----------------------------------------------------------------
suite("databasePlan.parseEngineCoverage", () => {
  test("the three values pass through", () => {
    for (const value of ["participating", "framework", "off"] as const) {
      assert.strictEqual(parseEngineCoverage(value), value);
    }
  });

  test("anything else is the default, participating", () => {
    for (const value of [undefined, null, "", "all", "Participating", 3, {}]) {
      assert.strictEqual(parseEngineCoverage(value), "participating");
    }
  });
});

// ---- Gem discovery -----------------------------------------------------------
suite("databasePlan.participatingGemRoots", () => {
  useTree();

  test("include dirs under the engine's Gems walk up to the nearest gem.json", () => {
    const includes = [
      `${R}/src/Gems/Atom/RPI/Code/Include`,
      `${R}/src/Gems/Atom/RPI/Code/Include/Atom/RPI`, // a deeper dir of the same gem
      `${R}/src/Gems/Atom/RPI/Code/Source`,
    ];
    assert.deepStrictEqual(rel(participatingGemRoots(includes, `${R}/src`)), ["src/Gems/Atom/RPI"]);
  });

  test("an include dir with no gem.json above it, a non-Gems dir and another tree's Gems are ignored", () => {
    const includes = [
      `${R}/src/Gems/Atom/Utils/Code/Include`,
      `${R}/src/Code/Framework/AzCore`,
      `${R}/gems/mygem/Code/Include`,
      `${R}/sdk/Gems/Atom/RPI/Code/Include`, // the SDK, not the source engine
    ];
    assert.deepStrictEqual(participatingGemRoots(includes, `${R}/src`), []);
  });

  test("the Gems folder itself is never a gem root, even with a gem.json in it", () => {
    write("src/Gems/gem.json", "{}");
    assert.deepStrictEqual(participatingGemRoots([`${R}/src/Gems/Atom/Utils/Code/Include`], `${R}/src`), []);
  });

  test("several gems come back sorted, each once", () => {
    const includes = [`${R}/src/Gems/Unused/Code/Source`, `${R}/src/Gems/Atom/RPI/Code/Include`, `${R}/src/Gems/Unused/Code/Source`];
    assert.deepStrictEqual(rel(participatingGemRoots(includes, `${R}/src`)), ["src/Gems/Atom/RPI", "src/Gems/Unused"]);
  });
});

suite("databasePlan.reachedGemRoots", () => {
  useTree();

  test("the gem of every compiled source, found by walking up to gem.json", () => {
    const sources = [`${R}/gems/mygem/Code/Source/InTarget.cpp`, `${R}/gems/mygem/Code/Source/Fallback.cpp`, `${R}/project/Source/Main.cpp`];
    assert.deepStrictEqual(rel(reachedGemRoots(sources, [], [])), ["gems/mygem"]); // the project's own source sits in no gem
  });

  test("external subdirectories that are gems join; non-gems and missing folders are skipped quietly", () => {
    const named = [`${R}/gems/notenabled`, `${R}/gems/notagem`, `${R}/gems/missing`];
    assert.deepStrictEqual(rel(reachedGemRoots([], named, [])), ["gems/notenabled"]);
  });

  test("gems inside an excluded root (an engine) are left out", () => {
    const named = [`${R}/src/Gems/Unused`, `${R}/gems/registered`];
    assert.deepStrictEqual(rel(reachedGemRoots([`${R}/src/Gems/Atom/RPI/Code/Source/Pass.cpp`], named, [`${R}/src`])), ["gems/registered"]);
  });

  test("a gem reached twice (a source and a name) is listed once", () => {
    assert.deepStrictEqual(rel(reachedGemRoots([`${R}/gems/mygem/Code/Source/InTarget.cpp`], [`${R}/gems/mygem/`], [])), ["gems/mygem"]);
  });
});

suite("databasePlan.readManifestGems", () => {
  useTree();
  let savedHome: string | undefined;

  setup(() => {
    savedHome = process.env["O3DE_HOME"];
    process.env["O3DE_HOME"] = path.join(root, "o3de-home");
  });
  teardown(() => {
    if (savedHome === undefined) {
      delete process.env["O3DE_HOME"];
    } else {
      process.env["O3DE_HOME"] = savedHome;
    }
  });

  const writeManifest = (external: unknown[]): void => write("o3de-home/o3de_manifest.json", JSON.stringify({ external_subdirectories: external }));

  test("relative external_subdirectories resolve against the manifest's folder; absolute ones are taken as they are", () => {
    const absolute = path.join(root, "elsewhere", "gem");
    writeManifest(["gems/relative", absolute]);
    assert.deepStrictEqual(readManifestGems(), [path.join(root, "o3de-home", "gems", "relative"), absolute]);
  });

  test("a missing manifest, or one that isn't JSON, gives no gems", () => {
    assert.deepStrictEqual(readManifestGems(), []);
    write("o3de-home/o3de_manifest.json", "{ nope");
    assert.deepStrictEqual(readManifestGems(), []);
  });

  test("an entry that isn't a string is skipped, the rest kept", () => {
    const absolute = path.join(root, "elsewhere", "gem");
    writeManifest([42, null, { path: "x" }, absolute]);
    assert.deepStrictEqual(readManifestGems(), [absolute]);
  });

  test("a manifest with no external_subdirectories gives none", () => {
    write("o3de-home/o3de_manifest.json", JSON.stringify({ engines: ["x"] }));
    assert.deepStrictEqual(readManifestGems(), []);
  });
});

suite("databasePlan.relevantManifestGems", () => {
  useTree();
  const manifest = (): string[] => ["registered", "unrelated", "notagem", "missing"].map((name) => path.join(root, "gems", name));
  const names = (dirs: string[]): string[] => dirs.map((dir) => path.basename(dir));

  test("a gem the project enables (project.json gem_names) is relevant, with or without a version specifier", () => {
    for (const gemName of ["Registered", "registered", "Registered>=1.0", "Registered==2.0.1", "Registered ~= 1.2"]) {
      const split = relevantManifestGems(manifest(), { ...project(), gemNames: [gemName] });
      assert.deepStrictEqual(names(split.relevant), ["registered"], gemName);
      assert.deepStrictEqual(names(split.skipped), ["unrelated"], "the gem the project doesn't touch is skipped");
    }
  });

  test("folders that are no gem (no gem.json, or missing) are in neither list", () => {
    const split = relevantManifestGems(manifest(), { ...project(), gemNames: [] });
    assert.ok(![...split.relevant, ...split.skipped].some((dir) => /notagem|missing/.test(dir)));
  });

  test("a gem under the project folder is relevant without being enabled", () => {
    write("project/Gems/Local/gem.json", JSON.stringify({ gem_name: "Local" }));
    const split = relevantManifestGems([path.join(root, "project", "Gems", "Local"), ...manifest()], { ...project(), gemNames: [] });
    assert.deepStrictEqual(names(split.relevant), ["Local"]);
  });

  test("a gem under a workspace folder is relevant, and so is a gem whose own folder is the workspace", () => {
    const project_ = { ...project(), gemNames: [] };
    assert.deepStrictEqual(names(relevantManifestGems(manifest(), project_, [path.join(root, "gems")]).relevant), ["registered", "unrelated"]);
    assert.deepStrictEqual(names(relevantManifestGems(manifest(), project_, [path.join(root, "gems", "unrelated")]).relevant), ["unrelated"]);
  });

  test("a sibling folder with a similar name is not 'under' a workspace folder", () => {
    write("gems/unrelated2/gem.json", JSON.stringify({ gem_name: "Unrelated2" }));
    const split = relevantManifestGems([path.join(root, "gems", "unrelated2")], { ...project(), gemNames: [] }, [path.join(root, "gems", "unrelated")]);
    assert.deepStrictEqual(split.relevant, []);
  });

  test("manifest order is kept and nothing is relevant with no project link and no workspace", () => {
    const split = relevantManifestGems(manifest(), { ...project(), gemNames: [], path: path.join(root, "project") });
    assert.deepStrictEqual(split.relevant, []);
    assert.deepStrictEqual(names(split.skipped), ["registered", "unrelated"]);
  });
});

suite("databasePlan gem folders", () => {
  useTree();

  test("a gem's code lives in Code, or in the gem root when it has no Code folder", () => {
    assert.strictEqual(gemCodeRoot(`${R}/gems/mygem`), `${R}/gems/mygem/Code`);
    assert.strictEqual(gemCodeRoot(`${R}/gems/registered`), `${R}/gems/registered`);
    assert.strictEqual(gemCodeRoot(`${R}/gems/registered/`), `${R}/gems/registered`);
  });

  test("include dirs: Include, Source, their Platform/<host> and Platform/Common, then the code folder's own — only the ones that exist", () => {
    assert.deepStrictEqual(rel(gemIncludeDirs(`${R}/src/Gems/Atom/RPI`, "win32")), [
      "src/Gems/Atom/RPI/Code/Include",
      "src/Gems/Atom/RPI/Code/Source",
      "src/Gems/Atom/RPI/Code/Source/Platform/Windows",
      "src/Gems/Atom/RPI/Code/Source/Platform/Common",
      "src/Gems/Atom/RPI/Code/Platform/Windows",
      "src/Gems/Atom/RPI/Code/Platform/Common",
    ]);
    assert.deepStrictEqual(rel(gemIncludeDirs(`${R}/src/Gems/Atom/RPI`, "linux")), [
      "src/Gems/Atom/RPI/Code/Include",
      "src/Gems/Atom/RPI/Code/Source",
      "src/Gems/Atom/RPI/Code/Source/Platform/Linux",
      "src/Gems/Atom/RPI/Code/Source/Platform/Common",
      "src/Gems/Atom/RPI/Code/Platform/Linux",
      "src/Gems/Atom/RPI/Code/Platform/Common",
    ]);
    assert.deepStrictEqual(rel(gemIncludeDirs(`${R}/src/Gems/Atom/RPI`, "darwin")), [
      "src/Gems/Atom/RPI/Code/Include",
      "src/Gems/Atom/RPI/Code/Source",
      "src/Gems/Atom/RPI/Code/Source/Platform/Mac",
      "src/Gems/Atom/RPI/Code/Source/Platform/Common",
      "src/Gems/Atom/RPI/Code/Platform/Mac",
      "src/Gems/Atom/RPI/Code/Platform/Common",
    ]);
    assert.deepStrictEqual(rel(gemIncludeDirs(`${R}/gems/notenabled`, "win32")), ["gems/notenabled/Code/Include", "gems/notenabled/Code/Source"], "a gem without those dirs is unchanged");
  });

  test("include dirs: an Include/Platform/<host> folder follows Include", () => {
    write("src/Gems/Atom/RPI/Code/Include/Platform/Windows/Handle.h");
    assert.deepStrictEqual(rel(gemIncludeDirs(`${R}/src/Gems/Atom/RPI`, "win32")).slice(0, 3), [
      "src/Gems/Atom/RPI/Code/Include",
      "src/Gems/Atom/RPI/Code/Include/Platform/Windows",
      "src/Gems/Atom/RPI/Code/Source",
    ]);
  });

  test("a gem without a Code folder takes its Include and Source from the gem root", () => {
    assert.deepStrictEqual(rel(gemIncludeDirs(`${R}/gems/registered`, "win32")), ["gems/registered/Include", "gems/registered/Source"]);
  });

  test("listGemSources: sources for this platform only — no tests, vendored code, build output or other platforms' PAL", () => {
    assert.deepStrictEqual(rel(listGemSources(`${R}/src/Gems/Atom/RPI/Code`, "win32")), [
      "src/Gems/Atom/RPI/Code/Platform/Windows/Pass_Windows.cpp",
      "src/Gems/Atom/RPI/Code/Source/Pass.cpp",
    ]);
    assert.deepStrictEqual(rel(listGemSources(`${R}/src/Gems/Atom/RPI/Code`, "linux")), [
      "src/Gems/Atom/RPI/Code/Platform/Common/UnixLike/Unix.cpp", // shared by every Unix-like platform, Linux's included
      "src/Gems/Atom/RPI/Code/Platform/Linux/Pass_Linux.cpp",
      "src/Gems/Atom/RPI/Code/Source/Pass.cpp",
    ]);
  });

  test("listGemSources: a folder with its own gem.json is another gem's — a gem enclosing gems lists only its own sources", () => {
    write("src/Gems/Atom/gem.json", JSON.stringify({ gem_name: "Atom" })); // encloses RPI, which has its own gem.json
    write("src/Gems/Atom/Source/AtomOwn.cpp");
    assert.strictEqual(gemCodeRoot(`${R}/src/Gems/Atom`), `${R}/src/Gems/Atom`, "no Code folder: the gem root");
    assert.deepStrictEqual(rel(listGemSources(gemCodeRoot(`${R}/src/Gems/Atom`), "win32")), ["src/Gems/Atom/Source/AtomOwn.cpp"]);
  });

  test("listGemSources: dot-folders are not entered; a missing folder lists nothing", () => {
    write("gems/mygem/.git/hooks/Hook.cpp");
    write("gems/mygem/Code/Source/.cache/Cached.cpp");
    assert.deepStrictEqual(rel(listGemSources(gemCodeRoot(`${R}/gems/mygem`), "win32")), ["gems/mygem/Code/Source/Fallback.cpp", "gems/mygem/Code/Source/InTarget.cpp"]);
    assert.deepStrictEqual(listGemSources(`${R}/gems/missing`, "win32"), []);
  });

  test("listGemSources: an Assets folder deep in the code is code (Source/Integration/Assets); the gem-root Assets beside Code is not walked", () => {
    write("gems/mygem/Code/Source/Integration/Assets/ActorAsset.cpp");
    write("gems/mygem/Assets/Textures/NotCode.cpp"); // beside Code: gemCodeRoot never reaches it
    assert.deepStrictEqual(rel(listGemSources(gemCodeRoot(`${R}/gems/mygem`), "win32")), [
      "gems/mygem/Code/Source/Fallback.cpp",
      "gems/mygem/Code/Source/InTarget.cpp",
      "gems/mygem/Code/Source/Integration/Assets/ActorAsset.cpp",
    ]);
  });

  test("listGemSources: in a gem with no Code folder the root's Assets is skipped, a nested one is not", () => {
    write("gems/registered/Assets/Textures/NotCode.cpp");
    write("gems/registered/Source/Assets/Importer.cpp");
    assert.deepStrictEqual(rel(listGemSources(gemCodeRoot(`${R}/gems/registered`), "win32")), ["gems/registered/Source/Assets/Importer.cpp", "gems/registered/Source/Reg.cpp"]);
  });

  test("listGemSources: tests, external, 3rdparty and build folders stay skipped at any depth", () => {
    for (const folder of ["Tests", "test", "External", "3rdParty", "Build"]) {
      write(`gems/mygem/Code/Source/Deep/${folder}/Skipped.cpp`);
    }
    assert.deepStrictEqual(rel(listGemSources(gemCodeRoot(`${R}/gems/mygem`), "win32")), ["gems/mygem/Code/Source/Fallback.cpp", "gems/mygem/Code/Source/InTarget.cpp"]);
  });

  test("listGemSources: darwin lists the Mac PAL sources and not the Windows or Linux ones", () => {
    assert.deepStrictEqual(rel(listGemSources(`${R}/src/Gems/Atom/RPI/Code`, "darwin")), [
      "src/Gems/Atom/RPI/Code/Platform/Common/UnixLike/Unix.cpp",
      "src/Gems/Atom/RPI/Code/Platform/Mac/Pass_Mac.cpp",
      "src/Gems/Atom/RPI/Code/Source/Pass.cpp",
    ]);
  });
});

// ---- Dirs a gem's CMake declares ---------------------------------------------
suite("databasePlan declared include dirs", () => {
  useTree();

  /** A gem's Code/CMakeLists.txt: PAL variable, '.', a sibling-of-Code folder, ${gem_name}, and dirs that must be dropped. */
  const MYGEM_CMAKE = `
    o3de_pal_dir(pal_source_dir \${CMAKE_CURRENT_LIST_DIR}/Source/Platform/\${PAL_PLATFORM_NAME} "\${gem_restricted_path}" "\${gem_path}" "\${gem_parent_relative_path}")
    ly_add_target(
        NAME \${gem_name}.Static STATIC
        FILES_CMAKE mygem_files.cmake
        INCLUDE_DIRECTORIES
            PUBLIC
                Include
                \${pal_source_dir}
                .
                Source
                Source/\${gem_name}
                ../External/Vendor
                ../Vendor/Missing
                Source/Platform/Linux
                Tests
                build/Generated
    )
  `;

  /** The files that tree needs: every declared dir exists, so only the rules decide which are kept. */
  function buildMyGem(): void {
    write("gems/mygem/Code/CMakeLists.txt", MYGEM_CMAKE);
    write("gems/mygem/Code/Source/MyGem/MyGem.h");
    write("gems/mygem/Code/Source/Platform/Windows/Traits.h");
    write("gems/mygem/Code/Source/Platform/Linux/Traits.h");
    write("gems/mygem/Code/build/Generated/Generated.h");
    write("gems/mygem/External/Vendor/Vendor.h");
  }

  test("a gem's declared dirs: those that exist, in the order declared — never another platform's, tests or build output", () => {
    buildMyGem();
    assert.deepStrictEqual(rel(gemDeclaredIncludeDirs(`${R}/gems/mygem`, gemCodeRoot(`${R}/gems/mygem`), "win32")), [
      "gems/mygem/Code/Include",
      "gems/mygem/Code/Source/Platform/Windows",
      "gems/mygem/Code",
      "gems/mygem/Code/Source",
      "gems/mygem/Code/Source/MyGem", // ${gem_name} comes from gem.json
      "gems/mygem/External/Vendor", // beside Code, not inside it
    ]);
  });

  test("the host picks the PAL folder: Linux takes Source/Platform/Linux, Windows' is left", () => {
    buildMyGem();
    const dirs = rel(gemDeclaredIncludeDirs(`${R}/gems/mygem`, gemCodeRoot(`${R}/gems/mygem`), "linux"));
    assert.ok(dirs.includes("gems/mygem/Code/Source/Platform/Linux"));
    assert.ok(!dirs.includes("gems/mygem/Code/Source/Platform/Windows"));
  });

  test("gemIncludeDirs: the conventional dirs first, the declared ones after them, nothing twice", () => {
    buildMyGem();
    assert.deepStrictEqual(rel(gemIncludeDirs(`${R}/gems/mygem`, "win32")), [
      "gems/mygem/Code/Include",
      "gems/mygem/Code/Source",
      "gems/mygem/Code/Source/Platform/Windows",
      "gems/mygem/Code",
      "gems/mygem/Code/Source/MyGem",
      "gems/mygem/External/Vendor",
    ]);
  });

  test("every CMakeLists.txt under the code folder that declares a target counts, relative to its own folder", () => {
    buildMyGem();
    write("gems/mygem/Code/Source/Sub/CMakeLists.txt", "ly_add_target(NAME MyGem.Sub STATIC INCLUDE_DIRECTORIES PRIVATE ../Extra)");
    write("gems/mygem/Code/Source/Extra/Extra.h");
    const dirs = rel(gemDeclaredIncludeDirs(`${R}/gems/mygem`, gemCodeRoot(`${R}/gems/mygem`), "win32"));
    assert.strictEqual(dirs[dirs.length - 1], "gems/mygem/Code/Source/Extra", "after the code folder's own file");
    assert.strictEqual(dirs.length, 7);
  });

  test("a CMakeLists.txt that declares no target, one in a skipped folder (tests, vendored, build) and another gem's are not read", () => {
    buildMyGem();
    write("gems/mygem/Code/Source/Plain/CMakeLists.txt", "target_include_directories(Plain PRIVATE Inner)");
    write("gems/mygem/Code/Source/Plain/Inner/Inner.h");
    write("gems/mygem/Code/Tests/CMakeLists.txt", "ly_add_target(NAME T STATIC INCLUDE_DIRECTORIES PRIVATE Mocks)");
    write("gems/mygem/Code/Tests/Mocks/Mock.h");
    write("gems/mygem/Code/External/Lib/CMakeLists.txt", "ly_add_target(NAME Lib STATIC INCLUDE_DIRECTORIES PUBLIC Inside)");
    write("gems/mygem/Code/External/Lib/Inside/Inside.h");
    write("gems/mygem/Code/Source/Nested/gem.json", JSON.stringify({ gem_name: "Nested" }));
    write("gems/mygem/Code/Source/Nested/CMakeLists.txt", "ly_add_target(NAME Nested STATIC INCLUDE_DIRECTORIES PUBLIC Own)");
    write("gems/mygem/Code/Source/Nested/Own/Own.h");
    const dirs = rel(gemDeclaredIncludeDirs(`${R}/gems/mygem`, gemCodeRoot(`${R}/gems/mygem`), "win32"));
    assert.strictEqual(dirs.length, 6, dirs.join(", "));
  });

  test("sibling target folders are read in name order, whatever order the file system lists them", () => {
    for (const folder of ["Beta", "Alpha"]) {
      write(`gems/mygem/Code/Source/${folder}/CMakeLists.txt`, `ly_add_target(NAME ${folder} STATIC INCLUDE_DIRECTORIES PUBLIC Inc)`);
      write(`gems/mygem/Code/Source/${folder}/Inc/${folder}.h`);
    }
    assert.deepStrictEqual(rel(gemDeclaredIncludeDirs(`${R}/gems/mygem`, gemCodeRoot(`${R}/gems/mygem`), "win32")), [
      "gems/mygem/Code/Source/Alpha/Inc",
      "gems/mygem/Code/Source/Beta/Inc",
    ]);
  });

  test("a root-layout gem's CMake naming a tests folder beside the gem (../Code/Tests) is dropped; a folder beside it that isn't tests stays", () => {
    write("gems/rootgem/gem.json", JSON.stringify({ gem_name: "RootGem" }));
    write("gems/rootgem/CMakeLists.txt", "ly_add_target(NAME RootGem STATIC INCLUDE_DIRECTORIES PUBLIC Include ../Code/Tests ../Code/Common)");
    write("gems/rootgem/Include/RootGem/Bus.h");
    write("gems/Code/Tests/Mock.h");
    write("gems/Code/Common/Common.h");
    assert.deepStrictEqual(rel(gemDeclaredIncludeDirs(`${R}/gems/rootgem`, gemCodeRoot(`${R}/gems/rootgem`), "win32")), ["gems/rootgem/Include", "gems/Code/Common"]);
  });

  test("a gem with no CMakeLists.txt, or whose CMake declares nothing, adds nothing", () => {
    assert.deepStrictEqual(gemDeclaredIncludeDirs(`${R}/gems/notenabled`, gemCodeRoot(`${R}/gems/notenabled`), "win32"), []);
    assert.deepStrictEqual(gemDeclaredIncludeDirs(`${R}/gems/missing`, `${R}/gems/missing`, "win32"), []);
    assert.deepStrictEqual(gemDeclaredIncludeDirs(`${R}/src/Gems/Atom/RPI`, gemCodeRoot(`${R}/src/Gems/Atom/RPI`), "win32"), [], "RPI's CMake names no include dir");
  });

  test("a fallback gem entry carries them, after the conventional dirs and before the project's union", () => {
    buildMyGem();
    const argv = planCompileDatabase(inputs()).commands.find((command) => command.file === `${R}/gems/mygem/Code/Source/Fallback.cpp`)!.arguments;
    const vendor = `/I${R}/gems/mygem/External/Vendor`;
    assert.ok(argv.includes(vendor));
    assert.ok(argv.includes(`/I${R}/gems/mygem/Code`));
    assert.ok(argv.indexOf(`/I${R}/gems/mygem/Code/Source/Platform/Windows`) < argv.indexOf(vendor), "conventional first");
    assert.ok(argv.indexOf(vendor) < argv.indexOf(`/external:I${R}/src/Code/Framework/AzCore`), "own dirs before the shared union");
    assert.ok(!argv.includes(`/I${R}/gems/mygem/Code/Tests`) && !argv.some((token) => /Platform\/Linux$/.test(token)));
  });

  test("a root-layout gem (no Code folder) carries the dirs its own root CMakeLists.txt declares", () => {
    write("gems/registered/CMakeLists.txt", "ly_add_target(NAME Registered STATIC INCLUDE_DIRECTORIES PUBLIC Include Shared)");
    write("gems/registered/Shared/Shared.h"); // not a conventional folder: only the CMake names it
    const argv = planCompileDatabase(inputs()).commands.find((command) => command.file === `${R}/gems/registered/Source/Reg.cpp`)!.arguments;
    assert.ok(argv.includes(`/I${R}/gems/registered/Shared`));
    assert.ok(argv.includes(`/I${R}/gems/registered/Include`));
  });

  test("an engine gem entry carries them too", () => {
    write(
      "src/Gems/Atom/RPI/Code/CMakeLists.txt",
      "ly_add_target(NAME Atom_RPI.Public STATIC COMPILE_DEFINITIONS PRIVATE ATOM_RPI_PUBLIC_EXPORTS INCLUDE_DIRECTORIES PUBLIC Include ../External/Codec)",
    );
    write("src/Gems/Atom/RPI/External/Codec/Codec.h");
    const planned = planCompileDatabase(inputs());
    const argv = planned.commands.find((command) => command.file === `${R}/src/Gems/Atom/RPI/Code/Source/Pass.cpp`)!.arguments;
    const codec = `/I${R}/src/Gems/Atom/RPI/External/Codec`;
    assert.ok(argv.includes(codec));
    assert.ok(argv.indexOf(`/I${R}/src/Gems/Atom/RPI/Code/Platform/Common`) < argv.indexOf(codec), "after the conventional dirs");
    assert.ok(argv.includes("/DATOM_RPI_PUBLIC_EXPORTS"), "the export define still comes from the same CMake file");
  });

  test("the project's own entry is untouched: its dirs come from the File API alone", () => {
    buildMyGem();
    const argv = planCompileDatabase(inputs()).commands.find((command) => command.file === `${R}/gems/mygem/Code/Source/InTarget.cpp`)!.arguments;
    assert.ok(!argv.includes(`/I${R}/gems/mygem/External/Vendor`));
  });

  test("declared dirs change a gem's flags only: the database holds the same files", () => {
    const before = planCompileDatabase(inputs()).commands;
    buildMyGem();
    const after = planCompileDatabase(inputs()).commands;
    assert.deepStrictEqual(after.map((command) => command.file), before.map((command) => command.file));
  });
});

// ---- The plan ----------------------------------------------------------------
suite("databasePlan.planCompileDatabase", () => {
  useTree();
  const zero: OriginCounts = { project: 0, gem: 0, engineFramework: 0, engineGems: 0, fallback: 0 };

  test("participating: the project's own, Framework it includes, the gems it uses, and the gem sources outside the build", () => {
    const planned = planCompileDatabase(inputs());
    assert.strictEqual(planned.redirected, true);
    assert.deepStrictEqual(filesOf(planned.commands), [
      "gems/mygem/Code/Source/Fallback.cpp",
      "gems/mygem/Code/Source/InTarget.cpp",
      "gems/notenabled/Code/Source/Other.cpp",
      "gems/registered/Source/Reg.cpp",
      "project/Source/Main.cpp",
      "src/Code/Framework/AzCore/AzCore/Component.cpp",
      "src/Gems/Atom/RPI/Code/Platform/Windows/Pass_Windows.cpp",
      "src/Gems/Atom/RPI/Code/Source/Pass.cpp",
    ]);
    assert.deepStrictEqual(planned.origins, { project: 1, gem: 1, engineFramework: 1, engineGems: 2, fallback: 3 });
    assert.deepStrictEqual(rel(planned.participatingGems), ["src/Gems/Atom/RPI"]);
    assert.deepStrictEqual(rel(planned.fallbackGems), ["gems/mygem", "gems/notenabled", "gems/registered"]);
  });

  test("the origins add up to the entries", () => {
    for (const coverage of ["participating", "framework", "off"] as const) {
      const planned = planCompileDatabase(inputs({ coverage }));
      const sum = Object.values(planned.origins).reduce((total, count) => total + count, 0);
      assert.strictEqual(sum, planned.commands.length, coverage);
    }
  });

  test("framework: no engine gem entries, everything else as before", () => {
    const planned = planCompileDatabase(inputs({ coverage: "framework" }));
    assert.deepStrictEqual(planned.origins, { project: 1, gem: 1, engineFramework: 1, engineGems: 0, fallback: 3 });
    assert.deepStrictEqual(planned.participatingGems, []);
    assert.ok(!filesOf(planned.commands).some((file) => file.startsWith("src/Gems/")));
  });

  test("off: no engine entries at all; the user's own gem sources still get theirs", () => {
    const planned = planCompileDatabase(inputs({ coverage: "off" }));
    assert.deepStrictEqual(planned.origins, { ...zero, project: 1, gem: 1, fallback: 3 });
    assert.strictEqual(planned.engineModuleDefines, 0);
    assert.ok(!filesOf(planned.commands).some((file) => file.startsWith("src/")));
  });

  test("no source engine at hand: nothing redirected, no engine entries, fallback entries unchanged", () => {
    const manifestGems = [path.join(root, "gems", "registered"), path.join(root, "gems", "notagem")];
    const planned = planCompileDatabase(inputs({ sourceEngineRoot: undefined, manifestGems }));
    assert.strictEqual(planned.redirected, false);
    assert.deepStrictEqual(planned.origins, { ...zero, project: 1, gem: 1, fallback: 3 });
  });

  test("a build engine that is not an SDK is not redirected: its sources are already in the build", () => {
    write("sdk/engine.json", JSON.stringify({ engine_name: "built-from-source" }));
    const planned = planCompileDatabase(inputs());
    assert.strictEqual(planned.redirected, false);
    assert.strictEqual(planned.origins.engineFramework + planned.origins.engineGems, 0);
    assert.deepStrictEqual(planned.participatingGems, []);
    assert.ok(!planned.fallbackGems.some((gem) => gem.startsWith(`${R}/src/`)), "the source engine's gems are no fallback material");
  });

  test("a native engine: the build compiles the engine's own sources, so its gems are neither engine entries nor fallback gems", () => {
    write("native/engine.json", JSON.stringify({ engine_name: "native-engine" })); // no sdk_engine: built from source
    write("native/Gems/Foo/gem.json", JSON.stringify({ gem_name: "Foo" }));
    write("native/Gems/Foo/Code/Source/InBuild.cpp");
    write("native/Gems/Foo/Code/Source/NotInBuild.cpp"); // no target lists it, and no fallback may claim it
    const reply = projectReply();
    reply.targets[0].sources.push({ path: `${R}/native/Gems/Foo/Code/Source/InBuild.cpp`, groupIndex: 0 });
    const planned = planCompileDatabase(
      inputs({
        reply,
        buildEngineRoot: `${R}/native`,
        manifestGems: [path.join(root, "native", "Gems", "Foo"), path.join(root, "gems", "registered")],
        workspaceFolders: [path.join(root, "native")], // Foo is relevant (the workspace holds it): only the engine rule keeps it out
      }),
    );

    assert.strictEqual(planned.redirected, false);
    assert.deepStrictEqual(rel(planned.fallbackGems), ["gems/mygem", "gems/notenabled", "gems/registered"], "Foo lives in the build engine: not a fallback gem");
    assert.ok(filesOf(planned.commands).includes("native/Gems/Foo/Code/Source/InBuild.cpp"), "the build's own entry stays");
    assert.ok(!filesOf(planned.commands).includes("native/Gems/Foo/Code/Source/NotInBuild.cpp"));
    assert.deepStrictEqual(planned.origins, { project: 1, gem: 2, engineFramework: 0, engineGems: 0, fallback: 3 });
  });

  test("a source engine without an engine.json is not one", () => {
    fs.rmSync(path.join(root, "src", "engine.json"));
    assert.strictEqual(planCompileDatabase(inputs()).redirected, false);
  });

  test("the platform picks the PAL folder: a Linux host takes the Linux sources, not the Windows ones", () => {
    const planned = planCompileDatabase(inputs({ platform: "linux" }));
    const files = filesOf(planned.commands);
    assert.ok(files.includes("src/Gems/Atom/RPI/Code/Platform/Linux/Pass_Linux.cpp"));
    assert.ok(!files.includes("src/Gems/Atom/RPI/Code/Platform/Windows/Pass_Windows.cpp"));
  });

  test("a darwin host takes the Mac PAL folder: its sources and include dirs, never the Windows or Linux ones", () => {
    const planned = planCompileDatabase(inputs({ platform: "darwin" }));
    const files = filesOf(planned.commands);
    assert.ok(files.includes("src/Gems/Atom/RPI/Code/Platform/Mac/Pass_Mac.cpp"));
    assert.ok(!files.includes("src/Gems/Atom/RPI/Code/Platform/Windows/Pass_Windows.cpp"));
    assert.ok(!files.includes("src/Gems/Atom/RPI/Code/Platform/Linux/Pass_Linux.cpp"));
    const argv = planned.commands.find((command) => command.file === `${R}/src/Gems/Atom/RPI/Code/Source/Pass.cpp`)!.arguments;
    assert.ok(argv.includes(`/I${R}/src/Gems/Atom/RPI/Code/Source/Platform/Mac`));
    assert.ok(argv.includes(`/I${R}/src/Gems/Atom/RPI/Code/Platform/Mac`));
    assert.ok(!argv.some((token) => /Platform\/(Windows|Linux)$/.test(token)), "no other platform's include dir");
  });

  test("engine entries carry the export defines of their own module, read from the source engine", () => {
    const planned = planCompileDatabase(inputs());
    const argv = (file: string) => planned.commands.find((command) => command.file === `${R}/${file}`)!.arguments;
    assert.ok(argv("src/Code/Framework/AzCore/AzCore/Component.cpp").includes("/DAZCORE_EXPORTS"));
    assert.ok(argv("src/Gems/Atom/RPI/Code/Source/Pass.cpp").includes("/DATOM_RPI_PUBLIC_EXPORTS"));
    assert.ok(!argv("src/Gems/Atom/RPI/Code/Source/Pass.cpp").includes("/DAZCORE_EXPORTS"), "one module's define never leaks into another's");
    assert.strictEqual(planned.engineModuleDefines, 3, "Component.cpp, Pass.cpp and Pass_Windows.cpp");
  });

  test("an engine gem entry: the gem's own dirs come first, then the project's union; no /WX", () => {
    const argv = planCompileDatabase(inputs()).commands.find((command) => command.file === `${R}/src/Gems/Atom/RPI/Code/Source/Pass.cpp`)!.arguments;
    const own = [
      `/I${R}/src/Gems/Atom/RPI/Code/Include`,
      `/I${R}/src/Gems/Atom/RPI/Code/Source`,
      `/I${R}/src/Gems/Atom/RPI/Code/Source/Platform/Windows`,
      `/I${R}/src/Gems/Atom/RPI/Code/Source/Platform/Common`,
      `/I${R}/src/Gems/Atom/RPI/Code/Platform/Windows`,
      `/I${R}/src/Gems/Atom/RPI/Code/Platform/Common`,
    ];
    const union = `/external:I${R}/src/Code/Framework/AzCore`; // the SDK's include dir, redirected into the source engine
    own.forEach((token) => assert.ok(argv.includes(token), token));
    assert.ok(argv.includes(union));
    assert.ok(argv.indexOf(own[own.length - 1]) < argv.indexOf(union), "own dirs before the shared union");
    assert.ok(!argv.includes("/WX") && argv.includes("/W4") && argv.includes("/permissive-"));
    assert.deepStrictEqual(argv.slice(-2), ["/TP", `${R}/src/Gems/Atom/RPI/Code/Source/Pass.cpp`]);
  });

  test("a fallback entry: the project's union and base switches (no /WX), plus the gem's own Include and Source", () => {
    const argv = planCompileDatabase(inputs()).commands.find((command) => command.file === `${R}/gems/mygem/Code/Source/Fallback.cpp`)!.arguments;
    assert.ok(argv.includes(`/I${R}/gems/mygem/Code/Include`));
    assert.ok(argv.includes(`/I${R}/gems/mygem/Code/Source`));
    assert.ok(argv.includes(`/external:I${R}/src/Code/Framework/AzCore`), "the project's include union, redirected");
    assert.ok(argv.includes("/DAZ_PROFILE_BUILD"));
    assert.ok(!argv.includes("/WX") && argv.includes("/W4"));
    assert.ok(!argv.includes("/DAZCORE_EXPORTS"), "fallback gems are no engine module");
  });

  test("an enclosing engine gem and the gems inside it each get their own sources and their own dirs", () => {
    write("src/Gems/Atom/gem.json", JSON.stringify({ gem_name: "Atom" })); // the project's Utils include dir now walks up to it
    write("src/Gems/Atom/Source/AtomOwn.cpp");
    const planned = planCompileDatabase(inputs());
    assert.deepStrictEqual(rel(planned.participatingGems), ["src/Gems/Atom", "src/Gems/Atom/RPI"]);
    const argv = (file: string) => planned.commands.find((command) => command.file === `${R}/${file}`)!.arguments;
    assert.ok(argv("src/Gems/Atom/Source/AtomOwn.cpp").includes(`/I${R}/src/Gems/Atom/Source`));
    assert.ok(argv("src/Gems/Atom/RPI/Code/Source/Pass.cpp").includes(`/I${R}/src/Gems/Atom/RPI/Code/Source`), "RPI's own dirs, not the enclosing gem's");
    assert.strictEqual(planned.origins.engineGems, 3, "AtomOwn.cpp, Pass.cpp, Pass_Windows.cpp — each once");
  });

  test("a gem with no Code folder takes its dirs from the gem root", () => {
    const argv = planCompileDatabase(inputs()).commands.find((command) => command.file === `${R}/gems/registered/Source/Reg.cpp`)!.arguments;
    assert.ok(argv.includes(`/I${R}/gems/registered/Include`));
    assert.ok(argv.includes(`/I${R}/gems/registered/Source`));
  });

  test("a source the reply already lists keeps the project's own command, once", () => {
    const entries = planCompileDatabase(inputs()).commands.filter((command) => command.file === `${R}/gems/mygem/Code/Source/InTarget.cpp`);
    assert.strictEqual(entries.length, 1);
    assert.ok(!entries[0].arguments.includes(`/I${R}/gems/mygem/Code/Source`), "no fallback dirs: it is the project's entry");
  });

  test("the build tree's own sources get no entry", () => {
    write("gems/mygem/Code/Source/Generated/FromBuild.cpp");
    const reply = projectReply();
    const planned = planCompileDatabase(inputs({ reply: { ...reply, buildDir: `${R}/gems/mygem/Code/Source/Generated` } }));
    assert.ok(!filesOf(planned.commands).includes("gems/mygem/Code/Source/Generated/FromBuild.cpp"));
  });

  test("gems inside the engine are never fallback gems: the coverage setting alone decides engine sources", () => {
    const planned = planCompileDatabase(inputs({ coverage: "off" }));
    assert.ok(!planned.fallbackGems.some((gem) => gem.includes("/src/Gems/")), "Unused is named by the manifest, but it lives in the engine");
  });

  test("project.json's external subdirectories resolve against the project root, absolute ones as they are", () => {
    const absolute: O3deProject = { ...project(), externalSubdirectories: [path.join(root, "gems", "notenabled")] };
    const planned = planCompileDatabase(inputs({ project: absolute, manifestGems: [] }));
    assert.ok(filesOf(planned.commands).includes("gems/notenabled/Code/Source/Other.cpp"));
    assert.ok(!filesOf(planned.commands).includes("gems/registered/Source/Reg.cpp"), "no manifest gems given");
  });

  test("a registered gem the project doesn't touch gets no entries and is counted as left out", () => {
    const planned = planCompileDatabase(inputs());
    assert.ok(!filesOf(planned.commands).some((file) => file.startsWith("gems/unrelated/")));
    assert.ok(!rel(planned.fallbackGems).includes("gems/unrelated"));
    assert.strictEqual(planned.skippedManifestGems, 1, "unrelated; the engine's Unused is the coverage setting's business, not counted");
  });

  test("an unrelated registered gem changes nothing: adding a source to it leaves the commands byte-identical", () => {
    const before = JSON.stringify(planCompileDatabase(inputs()).commands);
    write("gems/unrelated/Code/Source/MoreCode.cpp");
    assert.strictEqual(JSON.stringify(planCompileDatabase(inputs()).commands), before);
  });

  test("a registered gem gets entries when the project enables it, or when the workspace holds it", () => {
    const enabled = planCompileDatabase(inputs({ project: { ...project(), gemNames: ["Registered"] } }));
    assert.ok(filesOf(enabled.commands).includes("gems/registered/Source/Reg.cpp"), "enabled by gem_names");

    const held = planCompileDatabase(inputs({ project: { ...project(), gemNames: [] }, workspaceFolders: [path.join(root, "gems", "registered")] }));
    assert.ok(filesOf(held.commands).includes("gems/registered/Source/Reg.cpp"), "inside a workspace folder");
    assert.ok(!filesOf(held.commands).includes("gems/unrelated/Code/Source/Unrelated.cpp"), "its neighbour is still out");

    const neither = planCompileDatabase(inputs({ project: { ...project(), gemNames: [] } }));
    assert.ok(!filesOf(neither.commands).includes("gems/registered/Source/Reg.cpp"), "no link to the project: left out");
    assert.strictEqual(neither.skippedManifestGems, 2, "registered and unrelated");
  });

  test("a gem the workspace holds joins, and is then not counted as left out", () => {
    const planned = planCompileDatabase(inputs({ workspaceFolders: [path.join(root, "gems")] }));
    assert.ok(filesOf(planned.commands).includes("gems/unrelated/Code/Source/Unrelated.cpp"));
    assert.strictEqual(planned.skippedManifestGems, 0);
  });

  test("the plan is deterministic: the same inputs give byte-identical commands", () => {
    assert.deepStrictEqual(planCompileDatabase(inputs()).commands, planCompileDatabase(inputs()).commands);
  });
});

// ---- Shared-command groups (compileDb.buildCompileDatabase) ------------------------
suite("compileDb shared-command groups", () => {
  const SDK = "D:/Sdk";
  const FRAMEWORK_FILE = "D:/Src/Code/Framework/AzCore/AzCore/A.cpp";
  const GEM_A = "D:/Gems/a/Code/Source/A.cpp";
  const GEM_B = "D:/Gems/b/Code/Source/B.cpp";
  const own = target({
    name: "T",
    groups: [
      group({
        sourceIndexes: [0],
        defines: ["AZ_PROFILE_BUILD"],
        includes: [{ path: `${SDK}/Code/AzCore`, isSystem: true }, { path: "D:/Proj/Include" }],
        fragments: [" /W4 /WX"],
      }),
    ],
    sources: [{ path: "D:/Proj/Source/Main.cpp", groupIndex: 0 }],
  });
  const replyOf = (compilerPath: string): CommandReply => ({ config: "profile", sourceDir: "D:/Proj", buildDir: "D:/Proj/build", compilerPath, targets: [own] });
  const argvOf = (commands: { file: string; arguments: string[] }[], file: string): string[] => commands.find((command) => command.file === file)!.arguments;

  test("a group's own include dirs go before the shared union, the file last", () => {
    const commands = buildCompileDatabase(replyOf(CL), [], [], "win32", undefined, [{ files: [GEM_A], includes: ["D:/Gems/a/Code/Include"] }]);
    assert.deepStrictEqual(argvOf(commands, GEM_A), [
      CL,
      "/DAZ_PROFILE_BUILD",
      "/ID:/Gems/a/Code/Include",
      `/external:I${SDK}/Code/AzCore`,
      "/ID:/Proj/Include",
      "/W4", // /WX is gone
      "/TP",
      GEM_A,
    ]);
  });

  test("a GNU-style compiler gets -I for the group's dirs", () => {
    const commands = buildCompileDatabase(replyOf("/usr/bin/clang++"), [], [], "linux", undefined, [{ files: [GEM_A], includes: ["/gems/a/Code/Include"] }]);
    const argv = argvOf(commands, GEM_A);
    assert.strictEqual(argv[2], "-I/gems/a/Code/Include");
    assert.deepStrictEqual(argv.slice(-3), ["-x", "c++", GEM_A]);
  });

  test("a dir the union already has is not repeated, and keeps the group's earlier place", () => {
    const commands = buildCompileDatabase(replyOf(CL), [], [], "win32", undefined, [{ files: [GEM_A], includes: ["D:/Proj/Include"] }]);
    const argv = argvOf(commands, GEM_A);
    assert.strictEqual(argv.filter((token) => token === "/ID:/Proj/Include").length, 1);
    assert.ok(argv.indexOf("/ID:/Proj/Include") < argv.indexOf(`/external:I${SDK}/Code/AzCore`));
  });

  test("a group's export defines apply to its own files only", () => {
    const commands = buildCompileDatabase(replyOf(CL), [], [], "win32", undefined, [
      { files: [GEM_A], exportDefines: () => ["GEM_A_EXPORTS"] },
      { files: [GEM_B] },
    ]);
    assert.deepStrictEqual(argvOf(commands, GEM_A).slice(0, 3), [CL, "/DAZ_PROFILE_BUILD", "/DGEM_A_EXPORTS"]);
    assert.ok(!argvOf(commands, GEM_B).includes("/DGEM_A_EXPORTS"));
  });

  test("the first group to name a file keeps it: Framework before gems, and no file appears twice", () => {
    const commands = buildCompileDatabase(
      replyOf(CL),
      [],
      [FRAMEWORK_FILE],
      "win32",
      () => ["AZCORE_EXPORTS"],
      [{ files: [FRAMEWORK_FILE, GEM_A], includes: ["D:/Gems/a/Code/Include"] }, { files: [GEM_A], includes: ["D:/Gems/b/Code/Include"] }],
    );
    assert.strictEqual(commands.filter((command) => command.file === FRAMEWORK_FILE).length, 1);
    assert.ok(argvOf(commands, FRAMEWORK_FILE).includes("/DAZCORE_EXPORTS") && !argvOf(commands, FRAMEWORK_FILE).includes("/ID:/Gems/a/Code/Include"));
    assert.ok(argvOf(commands, GEM_A).includes("/ID:/Gems/a/Code/Include") && !argvOf(commands, GEM_A).includes("/ID:/Gems/b/Code/Include"));
  });

  test("a project's real entry always wins over a group's file", () => {
    const commands = buildCompileDatabase(replyOf(CL), [], [], "win32", undefined, [{ files: ["D:/Proj/Source/Main.cpp"], includes: ["D:/Gems/a/Code/Include"] }]);
    assert.strictEqual(commands.length, 1);
    assert.ok(!argvOf(commands, "D:/Proj/Source/Main.cpp").includes("/ID:/Gems/a/Code/Include"));
  });

  test("no groups, or groups with no files: exactly the project's entries", () => {
    assert.strictEqual(buildCompileDatabase(replyOf(CL), []).length, 1);
    assert.strictEqual(buildCompileDatabase(replyOf(CL), [], [], "win32", undefined, [{ files: [], includes: ["D:/x"] }]).length, 1);
  });
});
