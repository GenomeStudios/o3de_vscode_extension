// ============================================================================
//  IntelliSense health check - the rules (vscode-free).
//
//  Reading real `clangd --check` output (captured from clangd 22.1.6, see
//  clangdCheckFixtures.ts), the deterministic stratified sample, entry origins, the
//  include directories that don't exist, finding clangd, and the sources with no entry.
//  Files are real temp files where the code touches the file system; nothing depends on
//  this machine's paths.
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CHECK_FROM_ENTRY, CHECK_INFERRED_WITH_ERRORS, CHECK_NOISE_ONLY } from "./clangdCheckFixtures";
import { substituteClangdVariables } from "../deps/clangdServer";
import {
  ClassifiedFile,
  DirectoryItem,
  buildOutputRoots,
  checkArguments,
  checkedDatabase,
  clampSampleSize,
  classifyEntries,
  classifyOrigin,
  compileRelevantArguments,
  databaseToolchain,
  describeError,
  engineScanRoots,
  findEntrylessSources,
  findExtensionClangd,
  includeDirsOf,
  locateClangd,
  missingIncludeDirs,
  ownScanRoots,
  parseCheckOutput,
  parseClangdVersion,
  parseDatabase,
  pickSample,
  readDatabaseFile,
} from "../intellisense/healthCheck";
import { Origin, OriginRoots, ScanRoot } from "../intellisense/healthModel";
import { normalizePath } from "../intellisense/paths";

// ---- Reading --check output ------------------------------------------------
suite("healthCheck.parseCheckOutput: real clangd output", () => {
  test("a file with its own entry: flags from the entry, and NO compile errors although clangd says '1 errors'", () => {
    const output = parseCheckOutput(CHECK_FROM_ENTRY);
    assert.strictEqual(output.command, "entry");
    assert.strictEqual(output.inferredFrom, undefined);
    assert.deepStrictEqual(output.errors, [], "the one E[ line is a refactoring tweak failing, not a compile error");
    assert.strictEqual(output.completed, true);
    assert.strictEqual(output.clangdVersion, "22.1.6");
    assert.match(CHECK_FROM_ENTRY, /All checks completed, 1 errors/, "clangd's own count is the trap this parser avoids");
  });

  test("a file with no entry: flags inferred from a neighbour, and every real compile error read", () => {
    const output = parseCheckOutput(CHECK_INFERRED_WITH_ERRORS);
    assert.strictEqual(output.command, "inferred");
    assert.match(output.inferredFrom ?? "", /canvas_gem\/Code\/Source\/Clients\/CanvasModule\.cpp$/);
    assert.strictEqual(output.errors.length, 9);
    assert.deepStrictEqual(output.errors[0], { line: 4, code: "pp_file_not_found", message: "in included file: 'GraphModel/Model/GraphContext.h' file not found" });
    assert.deepStrictEqual(
      output.errors.map((error) => error.line),
      [4, 19, 20, 20, 32, 32, 35, 36, 37],
    );
    assert.deepStrictEqual(
      [...new Set(output.errors.map((error) => error.code))].sort(),
      ["mem_init_not_member_or_class", "no_member", "pp_file_not_found", "undeclared_var_use"],
    );
    assert.strictEqual(output.completed, true);
  });

  test("a header whose only E[ lines are 'tweak ... FAIL' has no compile errors, although clangd counts 5", () => {
    const output = parseCheckOutput(CHECK_NOISE_ONLY);
    assert.deepStrictEqual(output.errors, []);
    assert.strictEqual(output.command, "inferred");
    assert.match(CHECK_NOISE_ONLY, /All checks completed, 5 errors/);
  });

  test("'Failed to resolve URI' noise (clangd prints it for files outside the database) is not a compile error", () => {
    const noise = [
      "E[04:08:16.433] Failed to resolve URI : Scheme must be provided in URI: ",
      "E[04:08:16.433] Failed to resolve URI : Scheme must be provided in URI: ",
      "I[04:08:16.500] All checks completed, 2 errors",
    ].join("\n");
    const output = parseCheckOutput(noise);
    assert.deepStrictEqual(output.errors, []);
    assert.strictEqual(output.completed, true);
  });

  test("a warning-level or info line that looks like an error is not read as one", () => {
    const output = parseCheckOutput(["W[00:00:01.000] [-Wswitch] Line 7: enumeration value not handled", "I[00:00:01.000] [x] Line 8: not an error"].join("\n"));
    assert.deepStrictEqual(output.errors, []);
  });

  test("a promoted warning (-Wswitch) shows as the error it became, with its name as the code", () => {
    const output = parseCheckOutput("E[00:00:01.000] [-Wswitch] Line 7: enumeration value 'X' not handled in switch");
    assert.deepStrictEqual(output.errors, [{ line: 7, code: "-Wswitch", message: "enumeration value 'X' not handled in switch" }]);
  });

  test("Windows line endings are read the same", () => {
    const output = parseCheckOutput(CHECK_INFERRED_WITH_ERRORS.replace(/\n/g, "\r\n"));
    assert.strictEqual(output.errors.length, 9);
    assert.strictEqual(output.command, "inferred");
    assert.strictEqual(output.errors[0].message, "in included file: 'GraphModel/Model/GraphContext.h' file not found");
  });

  test("clangd stopping early (no 'All checks completed') is reported as not completed", () => {
    const cut = CHECK_FROM_ENTRY.split("\n").slice(0, 12).join("\n");
    const output = parseCheckOutput(cut);
    assert.strictEqual(output.completed, false);
    assert.strictEqual(output.command, "unknown", "the command line comes after this cut");
  });

  test("clangd's own fallback command counts as inferred, named as such", () => {
    const output = parseCheckOutput("I[00:00:00.100] Compile command clangd fallback is: [/tmp] clang -- /tmp/a.cpp");
    assert.strictEqual(output.command, "inferred");
    assert.strictEqual(output.inferredFrom, "clangd fallback");
  });

  test("no output at all reads as unknown, not completed, no errors", () => {
    assert.deepStrictEqual(parseCheckOutput(""), { errors: [], command: "unknown", completed: false });
  });

  test("describeError: line, code, message; a very long message is cut", () => {
    assert.strictEqual(describeError({ line: 19, code: "undeclared_var_use", message: "use of undeclared identifier 'X'" }), "line 19 [undeclared_var_use] use of undeclared identifier 'X'");
    const long = describeError({ line: 1, code: "x", message: "y".repeat(500) });
    assert.ok(long.length < 260, String(long.length));
    assert.ok(long.endsWith("..."));
  });

  test("parseClangdVersion reads `clangd --version`", () => {
    assert.strictEqual(parseClangdVersion("clangd version 22.1.6 (https://github.com/llvm/llvm-project fc4aad7)\nFeatures: windows+grpc\n"), "22.1.6");
    assert.strictEqual(parseClangdVersion("command not found"), undefined);
  });
});

// ---- Running clangd --------------------------------------------------------
suite("healthCheck: the clangd command line", () => {
  test("a check names the file and the database folder, and builds no index", () => {
    const args = checkArguments("/p/a.cpp", "/p/build/clangd");
    assert.deepStrictEqual(args, ["--check=/p/a.cpp", "--compile-commands-dir=/p/build/clangd", "--background-index=false", "--log=info"]);
    assert.ok(!args.some((arg) => /background-index(?!=false)|--index|--pch-storage=disk|--clang-tidy/.test(arg)), "nothing that indexes or writes");
  });

  test("the user's compile-relevant clangd arguments follow, the rest are left out", () => {
    const relevant = compileRelevantArguments([
      "--background-index",
      "--query-driver=/usr/bin/g++",
      "--compile-commands-dir=/elsewhere",
      "--resource-dir",
      "/opt/llvm/lib/clang/22",
      "--clang-tidy",
      42,
    ]);
    assert.deepStrictEqual(relevant, ["--query-driver=/usr/bin/g++", "--resource-dir=/opt/llvm/lib/clang/22"]);
    assert.deepStrictEqual(checkArguments("f.cpp", "d", relevant).slice(-2), relevant);
  });

  test("clangd.arguments that isn't a list reads as no arguments", () => {
    assert.deepStrictEqual(compileRelevantArguments(undefined), []);
    assert.deepStrictEqual(compileRelevantArguments("--query-driver=x"), []);
  });
});

// ---- Finding clangd --------------------------------------------------------
suite("healthCheck.locateClangd", () => {
  const win = (existing: string[], searchPath = "C:\\bin;C:\\tools") => ({
    env: { PATH: searchPath, PATHEXT: ".exe;.cmd" } as Record<string, string>,
    platform: "win32" as NodeJS.Platform,
    home: "C:\\Users\\dev",
    workspaceRoot: undefined,
    exists: (file: string) => existing.includes(file),
  });
  const STORAGE = "C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\globalStorage";
  const download = (version: string): string => `${STORAGE}\\llvm-vs-code-extensions.vscode-clangd\\install\\${version}\\clangd_${version}\\bin\\clangd.exe`;
  const readDir = (versions: string[]) => (dir: string) => (dir.endsWith("\\install") ? versions : []);

  test("an explicit clangd.path that exists wins over the extension's download and PATH", () => {
    const context = win(["D:\\llvm\\bin\\clangd.exe", download("22.1.6"), "C:\\bin\\clangd.exe"]);
    const found = locateClangd({ setting: "D:\\llvm\\bin\\clangd.exe", context, storageRoot: STORAGE, readDir: readDir(["22.1.6"]) });
    assert.deepStrictEqual(found, { path: "D:\\llvm\\bin\\clangd.exe", source: "setting" });
  });

  test("the default clangd.path ('clangd') means: the extension's download first, then PATH", () => {
    const context = win([download("22.1.6"), "C:\\bin\\clangd.exe"]);
    assert.deepStrictEqual(locateClangd({ setting: "clangd", context, storageRoot: STORAGE, readDir: readDir(["22.1.6"]) }), {
      path: download("22.1.6"),
      source: "extension",
    });
    assert.deepStrictEqual(locateClangd({ setting: undefined, context: win(["C:\\bin\\clangd.exe"]), storageRoot: STORAGE, readDir: readDir([]) }), {
      path: "C:\\bin\\clangd.exe",
      source: "path",
    });
  });

  test("a clangd.path naming a file that isn't there falls through to the next place", () => {
    const context = win([download("22.1.6")]);
    const found = locateClangd({ setting: "D:\\gone\\clangd.exe", context, storageRoot: STORAGE, readDir: readDir(["22.1.6"]) });
    assert.strictEqual(found?.source, "extension");
  });

  test("nowhere: undefined", () => {
    assert.strictEqual(locateClangd({ setting: "clangd", context: win([]), storageRoot: STORAGE, readDir: readDir([]) }), undefined);
    assert.strictEqual(locateClangd({ setting: undefined, context: win([]) }), undefined, "no storage root known, nothing on PATH");
  });

  test("the extension's newest download is used (numeric order, not text order)", () => {
    const existing = [download("9.0.0"), download("18.1.3"), download("22.1.6")];
    const found = findExtensionClangd(STORAGE, "win32", (file) => existing.includes(file), readDir(["9.0.0", "22.1.6", "18.1.3"]));
    assert.strictEqual(found, download("22.1.6"));
  });

  test("a newer download folder with no binary in it is skipped for an older one that has it", () => {
    const found = findExtensionClangd(STORAGE, "win32", (file) => file === download("18.1.3"), readDir(["18.1.3", "22.1.6"]));
    assert.strictEqual(found, download("18.1.3"));
  });

  test("on Linux the binary is clangd with no extension, under the same layout", () => {
    const root = "/home/u/.config/Code/User/globalStorage";
    const binary = `${root}/llvm-vs-code-extensions.vscode-clangd/install/19.1.2/clangd_19.1.2/bin/clangd`;
    const found = findExtensionClangd(root, "linux", (file) => file === binary, (dir) => (dir.endsWith("/install") ? ["19.1.2"] : []));
    assert.strictEqual(found, binary);
  });

  test("no storage root: nothing to look in", () => {
    assert.strictEqual(findExtensionClangd(undefined, "win32", () => true, () => ["1.0.0"]), undefined);
  });
});

// ---- Reading the database --------------------------------------------------
let root: string;

/** A fresh temp folder for each test of the suite this is called in. */
function useTempRoot(): void {
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-health-"));
  });
  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
}

function write(rel: string, text: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

suite("healthCheck: reading compile_commands.json", () => {
  useTempRoot();

  test("both spellings read: O3DE's `arguments` list and CMake's `command` string", () => {
    const entries = parseDatabase([
      { directory: "/b", file: "/src/a.cpp", arguments: ["cl.exe", "/IC:/inc", "/src/a.cpp"] },
      { directory: "/b", file: "/src/b.cpp", command: 'cl.exe /D X=1 "/IC:/with space" /src/b.cpp' },
    ]);
    assert.deepStrictEqual(entries[0].args, ["cl.exe", "/IC:/inc", "/src/a.cpp"]);
    assert.deepStrictEqual(entries[1].args, ["cl.exe", "/D", "X=1", "/IC:/with space", "/src/b.cpp"]);
    assert.strictEqual(entries[0].file, "/src/a.cpp");
  });

  test("a relative file is made absolute against the entry's directory, with forward slashes", () => {
    const [entry] = parseDatabase([{ directory: "/proj/build", file: "../src/a.cpp", arguments: ["c++"] }]);
    assert.ok(entry.file.endsWith("/proj/src/a.cpp"), entry.file);
    assert.ok(!entry.file.includes("\\"));
  });

  test("malformed items are skipped, not fatal", () => {
    assert.strictEqual(parseDatabase([null, 4, { directory: "/b" }, { file: "/a.cpp", arguments: ["c++"] }]).length, 1);
    assert.deepStrictEqual(parseDatabase({ not: "a list" }), []);
  });

  test("a database file on disk is read (a BOM does not matter)", () => {
    const file = write("db/compile_commands.json", `\uFEFF${JSON.stringify([{ directory: "/b", file: "/a.cpp", arguments: ["c++", "-x", "c++", "/a.cpp"] }])}`);
    const read = readDatabaseFile(file);
    assert.ok(read.ok);
    assert.strictEqual(read.ok && read.entries.length, 1);
  });

  test("missing, not JSON and not a list are each said plainly", () => {
    const missing = readDatabaseFile(path.join(root, "nope", "compile_commands.json"));
    assert.ok(!missing.ok && missing.reason === "missing");
    const broken = readDatabaseFile(write("bad.json", "{ not json"));
    assert.ok(!broken.ok && broken.reason === "unreadable" && /isn't valid JSON/.test(broken.message));
    const notList = readDatabaseFile(write("obj.json", "{}"));
    assert.ok(!notList.ok && notList.reason === "unreadable" && /isn't a compile database/.test(notList.message));
  });

  test("the toolchain is the first entry's compiler and its switch style", () => {
    assert.deepStrictEqual(databaseToolchain(parseDatabase([{ directory: "/b", file: "/a.cpp", arguments: ["C:\\VS\\bin\\cl.exe", "/a.cpp"] }])), {
      compiler: "C:\\VS\\bin\\cl.exe",
      style: "msvc",
    });
    assert.strictEqual(databaseToolchain(parseDatabase([{ directory: "/b", file: "/a.cpp", arguments: ["/usr/bin/g++", "-c"] }]))?.style, "gnu");
    assert.strictEqual(databaseToolchain([]), undefined);
  });
});

// ---- Include directories ---------------------------------------------------
suite("healthCheck: include directories", () => {
  useTempRoot();

  test("MSVC switches, attached and detached", () => {
    assert.deepStrictEqual(
      includeDirsOf(["cl.exe", "/IC:/a", "/I", "C:/b", "-IC:/c", "/external:IC:/d", "/DX=1", "/TP", "C:/src/f.cpp"], "msvc"),
      ["C:/a", "C:/b", "C:/c", "C:/d"],
    );
  });

  test("GNU switches, attached and detached", () => {
    assert.deepStrictEqual(includeDirsOf(["c++", "-I/a", "-isystem", "/b", "-iquote/c", "-idirafter", "/d", "-DX=1", "-x", "c++", "/src/f.cpp"], "gnu"), ["/a", "/b", "/c", "/d"]);
  });

  test("a GNU source path that starts with /I is a file, not an include switch", () => {
    assert.deepStrictEqual(includeDirsOf(["c++", "-I/real", "/Include/f.cpp"], "gnu"), ["/real"]);
  });

  test("a detached switch with nothing after it is ignored", () => {
    assert.deepStrictEqual(includeDirsOf(["c++", "-I"], "gnu"), []);
  });

  test("the directories that don't exist are counted once, however many entries name them", () => {
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    const gone = path.join(root, "gone");
    const entries = parseDatabase(
      [1, 2, 3].map((n) => ({ directory: root, file: `/src/f${n}.cpp`, arguments: ["c++", `-I${real}`, `-I${gone}`, "-isystem", gone, `/src/f${n}.cpp`] })),
    );
    const report = missingIncludeDirs(entries, "gnu", fs.existsSync, "linux");
    assert.strictEqual(report.checked, 2);
    assert.deepStrictEqual(report.missing, [normalizePath(gone)]);
  });

  test("a relative include dir is checked against the entry's directory", () => {
    fs.mkdirSync(path.join(root, "inc"));
    const entries = parseDatabase([{ directory: root, file: "/src/f.cpp", arguments: ["c++", "-Iinc", "-Imissing", "/src/f.cpp"] }]);
    const report = missingIncludeDirs(entries, "gnu", fs.existsSync, "linux");
    assert.strictEqual(report.checked, 2);
    assert.deepStrictEqual(report.missing, [normalizePath(path.join(root, "missing"))]);
  });

  test("on Windows two spellings of one directory count once; on Linux they are two", () => {
    const entries = parseDatabase([{ directory: "/b", file: "/a.cpp", arguments: ["cl.exe", "/IC:/Inc", "/Ic:/inc", "/a.cpp"] }]);
    assert.strictEqual(missingIncludeDirs(entries, "msvc", () => false, "win32").checked, 1);
    assert.strictEqual(missingIncludeDirs(entries, "msvc", () => false, "linux").checked, 2);
  });
});

// ---- Origins ---------------------------------------------------------------
suite("healthCheck: entry origins", () => {
  const roots: OriginRoots = {
    projectRoot: "D:/work/game",
    sourceEngineRoot: "D:/work/engine",
    planFiles: new Set(["d:/work/game/gem/source/a.cpp", "d:/work/gems/mine/code/source/b.cpp"]),
    participatingGems: ["D:/work/engine/Gems/Atom/RPI"],
    fallbackGems: ["D:/work/gems/legacy"],
  };

  test("a replayed plan tells every origin apart", () => {
    assert.strictEqual(classifyOrigin("D:/work/game/Gem/Source/A.cpp", roots), "project");
    assert.strictEqual(classifyOrigin("D:/work/gems/mine/Code/Source/B.cpp", roots), "gem");
    assert.strictEqual(classifyOrigin("D:/work/engine/Code/Framework/AzCore/AzCore/X.cpp", roots), "engineFramework");
    assert.strictEqual(classifyOrigin("D:/work/engine/Gems/Atom/RPI/Code/Source/Pass.cpp", roots), "engineGems");
    assert.strictEqual(classifyOrigin("D:/work/gems/legacy/Code/Source/Old.cpp", roots), "fallback");
  });

  test("a file the build compiles wins over any root it also sits under", () => {
    const both: OriginRoots = { ...roots, planFiles: new Set(["d:/work/gems/legacy/code/source/old.cpp"]) };
    assert.strictEqual(classifyOrigin("D:/work/gems/legacy/Code/Source/Old.cpp", both), "gem");
  });

  test("with no plan (a database of the user's own) only paths speak", () => {
    const pathsOnly: OriginRoots = { projectRoot: "D:/work/game", sourceEngineRoot: "D:/work/engine" };
    assert.strictEqual(classifyOrigin("D:/work/game/Gem/Source/A.cpp", pathsOnly), "project");
    assert.strictEqual(classifyOrigin("D:/work/engine/Code/Framework/AzCore/X.cpp", pathsOnly), "engineFramework");
    assert.strictEqual(classifyOrigin("D:/work/engine/Code/Tools/Y.cpp", pathsOnly), "engineGems", "other engine code");
    assert.strictEqual(classifyOrigin("D:/elsewhere/gem/Z.cpp", pathsOnly), "gem");
  });

  test("with no source engine at all nothing is an engine origin", () => {
    assert.strictEqual(classifyOrigin("D:/work/engine/Code/Framework/AzCore/X.cpp", { projectRoot: "D:/work/game" }), "gem");
  });

  test("the counts add up to the entries", () => {
    const entries = parseDatabase(
      ["D:/work/game/Gem/Source/A.cpp", "D:/work/gems/mine/Code/Source/B.cpp", "D:/work/engine/Code/Framework/AzCore/X.cpp", "D:/work/engine/Code/Framework/AzCore/Y.cpp"].map((file) => ({
        directory: "D:/b",
        file,
        arguments: ["cl.exe"],
      })),
    );
    const { files, counts } = classifyEntries(entries, roots);
    assert.deepStrictEqual(counts, { project: 1, gem: 1, engineFramework: 2, engineGems: 0, fallback: 0 });
    assert.strictEqual(files.length, 4);
  });
});

// ---- Sampling --------------------------------------------------------------
suite("healthCheck.pickSample", () => {
  const files = (origin: Origin, count: number): ClassifiedFile[] =>
    Array.from({ length: count }, (_, i) => ({ file: `/${origin}/f${String(i).padStart(2, "0")}.cpp`, origin }));

  const database: ClassifiedFile[] = [
    ...files("project", 20),
    ...files("gem", 10),
    ...files("engineFramework", 30),
    ...files("engineGems", 5),
    ...files("fallback", 2),
  ];

  const countBy = (sample: { origin: string }[], origin: string): number => sample.filter((file) => file.origin === origin).length;

  test("five files reach all five origins", () => {
    const sample = pickSample(database, 5);
    for (const origin of ["project", "gem", "engineFramework", "engineGems", "fallback"]) {
      assert.strictEqual(countBy(sample, origin), 1, origin);
    }
  });

  test("the default six: the extra file goes to the project", () => {
    const sample = pickSample(database, 6);
    assert.strictEqual(sample.length, 6);
    assert.strictEqual(countBy(sample, "project"), 2);
  });

  test("within an origin the files are evenly spaced through its sorted list", () => {
    const projects = pickSample(database, 6).filter((file) => file.origin === "project");
    assert.deepStrictEqual(
      projects.map((file) => file.file),
      ["/project/f05.cpp", "/project/f15.cpp"],
    );
  });

  test("the same database gives the same sample, whatever order it comes in", () => {
    const first = pickSample(database, 8);
    const shuffled = [...database].reverse();
    assert.deepStrictEqual(pickSample(shuffled, 8), first);
    assert.deepStrictEqual(pickSample(database, 8), first);
  });

  test("a small origin is used up before its share goes to the others; nothing repeats", () => {
    const sample = pickSample(database, 20);
    assert.strictEqual(sample.length, 20);
    assert.strictEqual(new Set(sample.map((file) => file.file)).size, 20);
    assert.strictEqual(countBy(sample, "fallback"), 2, "all it has");
    assert.ok(countBy(sample, "engineGems") >= 4, "most of what it has");
  });

  test("more files asked for than the database holds: all of them, once", () => {
    const small = [...files("project", 2), ...files("gem", 1)];
    const sample = pickSample(small, 20);
    assert.strictEqual(sample.length, 3);
    assert.strictEqual(new Set(sample.map((file) => file.file)).size, 3);
  });

  test("an empty database or a size of zero samples nothing", () => {
    assert.deepStrictEqual(pickSample([], 6), []);
    assert.deepStrictEqual(pickSample(database, 0), []);
  });

  // A source can sit in several entries (one per target that compiles it): it is one candidate, not several.
  test("a file in several entries is sampled once", () => {
    const entry = (file: string): ClassifiedFile => ({ file, origin: "project" });
    const sample = pickSample([entry("/p/a.cpp"), entry("/p/a.cpp"), entry("/p/a.cpp"), entry("/p/b.cpp")], 3);
    assert.deepStrictEqual(
      sample.map((candidate) => candidate.file),
      ["/p/a.cpp", "/p/b.cpp"],
    );
  });

  test("twenty alternating duplicates of two files give those two files, however large the sample", () => {
    const duplicated = Array.from({ length: 20 }, (_, i): ClassifiedFile => ({ file: i % 2 === 0 ? "/p/x.cpp" : "/p/y.cpp", origin: "project" }));
    const sample = pickSample(duplicated, 6);
    assert.strictEqual(sample.length, 2);
    assert.deepStrictEqual(sample.map((candidate) => candidate.file).sort(), ["/p/x.cpp", "/p/y.cpp"]);
  });

  test("duplicates differing only in letter case are one file; the first spelling stays", () => {
    const sample = pickSample([{ file: "/p/Case.cpp", origin: "gem" }, { file: "/p/case.cpp", origin: "gem" }], 5);
    assert.deepStrictEqual(sample, [{ file: "/p/Case.cpp", origin: "gem" }]);
  });

  test("a duplicated database gives the same sample as the plain one, in any order", () => {
    const plain = pickSample(database, 8);
    const doubled = [...database, ...database];
    assert.deepStrictEqual(pickSample(doubled, 8), plain);
    assert.deepStrictEqual(pickSample([...doubled].reverse(), 8), plain);
  });

  test("the size asked for is kept inside 1..20, and a non-number falls back to the default", () => {
    assert.strictEqual(clampSampleSize(0), 1);
    assert.strictEqual(clampSampleSize(99), 20);
    assert.strictEqual(clampSampleSize(7.9), 7);
    assert.strictEqual(clampSampleSize(undefined), 6);
    assert.strictEqual(clampSampleSize("12"), 6);
    assert.strictEqual(clampSampleSize(Number.NaN), 6);
  });
});

// ---- Which database is checked ---------------------------------------------
suite("healthCheck.checkedDatabase", () => {
  useTempRoot();

  test("clangd.arguments names no folder: the one O3DE selected, generated, not in use", () => {
    const selected = path.join(root, "build", "clangd");
    assert.deepStrictEqual(checkedDatabase({ selectedDir: selected, platform: "win32" }), { dir: selected, kind: "generated", inUse: false });
  });

  test("the selected folder spelled another way (slashes, a trailing slash, letter case on Windows) is the same one", () => {
    const selected = path.join(root, "build", "clangd");
    const spellings = [`${selected}${path.sep}`, selected.replace(/\\/g, "/"), selected.toUpperCase()];
    for (const configuredDir of spellings) {
      const checked = checkedDatabase({ configuredDir, selectedDir: selected, platform: "win32" });
      assert.strictEqual(checked.kind, "generated", configuredDir);
      assert.strictEqual(checked.inUse, true, configuredDir);
    }
  });

  test("on Linux a folder differing only in case is another folder", () => {
    const selected = path.join(root, "build", "clangd");
    assert.strictEqual(checkedDatabase({ configuredDir: selected.toUpperCase(), selectedDir: selected, platform: "linux" }).kind, "clangdArguments");
  });

  test("the user's own database stays the user's when clangd.arguments points at it", () => {
    const own = path.join(root, "shared");
    assert.deepStrictEqual(checkedDatabase({ configuredDir: own, selectedDir: own, selectionSource: "user", platform: "win32" }), { dir: own, kind: "user", inUse: true });
    assert.strictEqual(checkedDatabase({ selectedDir: own, selectionSource: "user", platform: "win32" }).kind, "user", "selected, not yet in use");
    assert.strictEqual(checkedDatabase({ selectedDir: own, selectionSource: "user", platform: "win32" }).inUse, false);
  });

  test("clangd.arguments points elsewhere: that folder is the one checked, and it says whose it is", () => {
    const selected = path.join(root, "build", "clangd");
    const elsewhere = path.join(root, "other");
    assert.deepStrictEqual(checkedDatabase({ configuredDir: elsewhere, selectedDir: selected, platform: "win32" }), { dir: elsewhere, kind: "clangdArguments", inUse: true });
    assert.strictEqual(checkedDatabase({ configuredDir: elsewhere, selectedDir: selected, selectionSource: "user", platform: "win32" }).kind, "clangdArguments");
  });

  test("a relative folder resolves against the workspace root", () => {
    const checked = checkedDatabase({ configuredDir: path.join("build", "clangd"), workspaceRoot: root, selectedDir: path.join(root, "build", "clangd"), platform: "win32" });
    assert.strictEqual(checked.dir, path.join(root, "build", "clangd"));
    assert.strictEqual(checked.kind, "generated");
    assert.strictEqual(checked.inUse, true);
  });

  test("${workspaceFolder} in clangd.arguments, run through the real substitution, is checked against the same folder", () => {
    const context = { env: {}, platform: process.platform, home: os.homedir(), workspaceRoot: root, exists: () => false };
    const configuredDir = substituteClangdVariables("${workspaceFolder}/build/clangd", context);
    const checked = checkedDatabase({ configuredDir, workspaceRoot: root, selectedDir: path.join(root, "build", "clangd"), platform: "win32" });
    assert.strictEqual(checked.kind, "generated");
    assert.strictEqual(checked.inUse, true);
    assert.ok(!checked.dir.includes("${"), checked.dir);
  });
});

// ---- Where to look for sources the database doesn't list -------------------
suite("healthCheck.ownScanRoots", () => {
  useTempRoot();

  const hasGemJson = (dir: string): boolean => fs.existsSync(path.join(dir, "gem.json"));
  const gemDir = (...parts: string[]): string => normalizePath(path.join(root, "gems", ...parts)); // a gem's code root comes back in forward-slash form
  const scan =(overrides: Partial<Parameters<typeof ownScanRoots>[0]> = {}): ScanRoot[] =>
    ownScanRoots({ projectPath: path.join(root, "project"), externalSubdirectories: [], manifestGems: [], hasGemJson, cap: 20, ...overrides });

  function gems(): void {
    write("gems/a/gem.json", "{}");
    write("gems/a/Code/Source/A.cpp", "");
    write("gems/b/gem.json", "{}"); // no Code folder: the gem root is its code
    write("gems/c/Code/Source/C.cpp", ""); // no gem.json: no gem
  }

  test("the project comes first, tagged own", () => {
    gems();
    const roots = scan({ manifestGems: [path.join(root, "gems", "a")] });
    assert.deepStrictEqual(roots[0], { dir: path.join(root, "project"), group: "own" });
    assert.ok(roots.every((candidate) => candidate.group === "own"));
  });

  test("relative external subdirectories resolve against the project; each gem maps to its code folder", () => {
    gems();
    const roots = scan({ externalSubdirectories: [path.join("..", "gems", "a"), path.join("..", "gems", "b")] });
    assert.deepStrictEqual(
      roots.map((candidate) => candidate.dir),
      [path.join(root, "project"), gemDir("a", "Code"), gemDir("b")],
    );
  });

  test("absolute external subdirectories are taken as they are", () => {
    gems();
    assert.deepStrictEqual(
      scan({ externalSubdirectories: [path.join(root, "gems", "a")] }).map((candidate) => candidate.dir),
      [path.join(root, "project"), gemDir("a", "Code")],
    );
  });

  test("a folder with no gem.json is dropped", () => {
    gems();
    const roots = scan({ manifestGems: [path.join(root, "gems", "c"), path.join(root, "gems", "missing")] });
    assert.deepStrictEqual(roots.map((candidate) => candidate.dir), [path.join(root, "project")]);
  });

  test("a gem named twice (project.json and the manifest) is one root", () => {
    gems();
    const roots = scan({ externalSubdirectories: [path.join("..", "gems", "a")], manifestGems: [path.join(root, "gems", "a"), path.join(root, "gems", "b")] });
    assert.deepStrictEqual(
      roots.map((candidate) => candidate.dir),
      [path.join(root, "project"), gemDir("a", "Code"), gemDir("b")],
    );
  });

  test("the cap cuts the gem list, never the project root", () => {
    gems();
    const roots = scan({ manifestGems: [path.join(root, "gems", "a"), path.join(root, "gems", "b")], cap: 1 });
    assert.deepStrictEqual(roots.map((candidate) => candidate.dir), [path.join(root, "project"), gemDir("a", "Code")]);
    assert.deepStrictEqual(scan({ manifestGems: [path.join(root, "gems", "a")], cap: 0 }).map((candidate) => candidate.dir), [path.join(root, "project")]);
  });
});

suite("healthCheck.engineScanRoots", () => {
  const SRC = path.join(os.tmpdir(), "scan-src");
  const BUILD = path.join(os.tmpdir(), "scan-build");
  const identity = (dir: string) => ({ name: "e", path: dir });
  const all = (): boolean => true;
  const dirs = (roots: ScanRoot[]): string[] => roots.map((candidate) => candidate.dir);
  const expected = (base: string): string[] => ["Code/Tools", "Code/Editor", "Gems"].map((sub) => path.join(base, sub));

  test("a source engine's tool, editor and gem folders, tagged engine; its path wins over the build engine's", () => {
    const roots = engineScanRoots({ mode: "redirected", buildEngine: identity(BUILD), sourceEngine: identity(SRC) }, all);
    assert.deepStrictEqual(dirs(roots), expected(SRC));
    assert.ok(roots.every((candidate) => candidate.group === "engine"));
  });

  test("native mode, with only a build engine: the build engine's folders", () => {
    assert.deepStrictEqual(dirs(engineScanRoots({ mode: "native", buildEngine: identity(BUILD) }, all)), expected(BUILD));
  });

  test("headers only, or unresolved, has no sources to scan", () => {
    assert.deepStrictEqual(engineScanRoots({ mode: "headersOnly", buildEngine: identity(BUILD) }, all), []);
    assert.deepStrictEqual(engineScanRoots({ mode: "redirected", buildEngine: identity(BUILD) }, all), [], "redirected without a source engine");
    assert.deepStrictEqual(engineScanRoots({ mode: "unresolved" }, all), []);
  });

  test("only the folders that exist are returned", () => {
    const onlyGems = (dir: string): boolean => dir === path.join(SRC, "Gems");
    assert.deepStrictEqual(dirs(engineScanRoots({ mode: "redirected", sourceEngine: identity(SRC) }, onlyGems)), [path.join(SRC, "Gems")]);
    assert.deepStrictEqual(engineScanRoots({ mode: "redirected", sourceEngine: identity(SRC) }, () => false), []);
  });
});

// ---- Folders a build makes -------------------------------------------------
suite("healthCheck.buildOutputRoots", () => {
  useTempRoot();

  const entry = (directory: string, file: string): { directory: string; file: string; args: string[] } => ({ directory: normalizePath(directory), file: normalizePath(file), args: [] });
  const roots = (inputs: Partial<Parameters<typeof buildOutputRoots>[0]>): string[] =>
    buildOutputRoots({ entries: [], databaseDir: path.join(root, "db"), exists: () => false, ...inputs });

  test("the project's build folder is one", () => {
    assert.deepStrictEqual(roots({ buildDir: path.join(root, "project", "build", "windows") }), [normalizePath(path.join(root, "project", "build", "windows"))]);
  });

  test("an entry's working directory that is apart from its source is a build tree, from any location", () => {
    const build = path.join(root, "out", "build", "x64-debug");
    const found = roots({ entries: [entry(build, path.join(root, "src", "a.cpp")), entry(build, path.join(root, "src", "b.cpp"))] });
    assert.deepStrictEqual(found, [normalizePath(build)], "listed once");
  });

  test("an entry whose directory is the source folder, or above its source, is not a build tree", () => {
    const found = roots({
      entries: [entry(path.join(root, "src"), path.join(root, "src", "a.cpp")), entry(root, path.join(root, "src", "deep", "b.cpp")), entry(path.join(root, "src", "a.cpp"), path.join(root, "src", "a.cpp"))],
    });
    assert.deepStrictEqual(found, []);
  });

  test("a relative or empty directory says nothing", () => {
    const file = normalizePath(path.join(root, "a.cpp"));
    assert.deepStrictEqual(roots({ entries: [{ directory: "", file, args: [] }, { directory: "build", file, args: [] }] }), []);
  });

  test("the database folder, or the nearest folder above it, holding a CMakeCache.txt is one", () => {
    const build = path.join(root, "x", "build");
    const hasCache = (file: string): boolean => normalizePath(file) === normalizePath(path.join(build, "CMakeCache.txt"));
    assert.deepStrictEqual(roots({ databaseDir: path.join(build, "clangd"), exists: hasCache }), [normalizePath(build)]);
    assert.deepStrictEqual(roots({ databaseDir: build, exists: hasCache }), [normalizePath(build)]);
    assert.deepStrictEqual(roots({ databaseDir: path.join(root, "elsewhere"), exists: hasCache }), []);
  });

  test("the three sources are combined and each folder appears once, whatever the case", () => {
    const build = path.join(root, "out", "build");
    const hasCache = (file: string): boolean => normalizePath(file) === normalizePath(path.join(build, "CMakeCache.txt"));
    const found = roots({
      buildDir: build.toUpperCase(),
      entries: [entry(build, path.join(root, "src", "a.cpp"))],
      databaseDir: path.join(build, "clangd"),
      exists: hasCache,
    });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].toLowerCase(), normalizePath(build).toLowerCase());
  });
});

// ---- Sources with no entry -------------------------------------------------
suite("healthCheck.findEntrylessSources", () => {
  useTempRoot();

  const dir = (name: string): DirectoryItem => ({ name, isDirectory: true });
  const file = (name: string): DirectoryItem => ({ name, isDirectory: false });

  const tree = new Map<string, DirectoryItem[]>([
    ["/own/proj", [dir("Gem"), dir("build"), file("readme.txt")]],
    ["/own/proj/Gem", [dir("Source"), dir("Tests")]],
    ["/own/proj/Gem/Source", [file("A.cpp"), file("B.cpp"), file("B.h")]],
    ["/own/proj/Gem/Tests", [file("T.cpp")]],
    ["/own/proj/build", [file("Gen.cpp")]],
    ["/own/gem2", [file("G.cpp")]],
    ["/eng/Code/Tools", [dir("Platform"), file("tool.cpp")]],
    ["/eng/Gems", [dir("Linux"), file("g.cpp")]],
  ]);
  const read = (directory: string): DirectoryItem[] | undefined => tree.get(normalizePath(directory));
  const listed = new Set(["/own/proj/gem/source/a.cpp"]);
  const hasEntry = (name: string): boolean => listed.has(name.toLowerCase());
  const roots: ScanRoot[] = [
    { dir: "/own/proj", group: "own" },
    { dir: "/own/gem2", group: "own" },
    { dir: "/eng/Code/Tools", group: "engine" },
    { dir: "/eng/Gems", group: "engine" },
  ];

  test("the user's own source and the engine's take turns; tests, build output and listed files are passed over", () => {
    const found = findEntrylessSources(roots, hasEntry, 2, "win32", read);
    assert.deepStrictEqual(found, ["/own/proj/Gem/Source/B.cpp", "/eng/Code/Tools/tool.cpp"]);
  });

  test("a limit of one gives the user's own first", () => {
    assert.deepStrictEqual(findEntrylessSources(roots, hasEntry, 1, "win32", read), ["/own/proj/Gem/Source/B.cpp"]);
  });

  test("with no engine roots the user's own sources fill the sample", () => {
    const own = roots.filter((candidate) => candidate.group === "own");
    assert.deepStrictEqual(findEntrylessSources(own, hasEntry, 2, "win32", read), ["/own/proj/Gem/Source/B.cpp", "/own/gem2/G.cpp"]);
  });

  test("nothing unlisted anywhere: nothing to sample", () => {
    assert.deepStrictEqual(findEntrylessSources(roots, () => true, 2, "win32", read), []);
  });

  test("another platform's folders are not candidates", () => {
    const platformTree = new Map<string, DirectoryItem[]>([
      ["/eng/Gems", [dir("Platform")]],
      ["/eng/Gems/Platform", [dir("Linux"), dir("Windows")]],
      ["/eng/Gems/Platform/Linux", [file("l.cpp")]],
      ["/eng/Gems/Platform/Windows", [file("w.cpp")]],
    ]);
    const readPlatform = (directory: string): DirectoryItem[] | undefined => platformTree.get(normalizePath(directory));
    const only: ScanRoot[] = [{ dir: "/eng/Gems", group: "engine" }];
    assert.deepStrictEqual(findEntrylessSources(only, () => false, 2, "win32", readPlatform), ["/eng/Gems/Platform/Windows/w.cpp"]);
    assert.deepStrictEqual(findEntrylessSources(only, () => false, 2, "linux", readPlatform), ["/eng/Gems/Platform/Linux/l.cpp"]);
  });

  test("a root too deep to search within its budget gives up instead of walking forever", () => {
    let reads = 0;
    const endless = (directory: string): DirectoryItem[] | undefined => {
      reads += 1;
      return [dir(`d${normalizePath(directory).length}`)];
    };
    assert.deepStrictEqual(findEntrylessSources([{ dir: "/deep", group: "own" }], () => false, 2, "win32", endless), []);
    assert.ok(reads <= 801, `${reads} directories read`);
  });

  test("a folder that can't be read is passed over", () => {
    assert.deepStrictEqual(findEntrylessSources([{ dir: "/nowhere", group: "own" }], () => false, 2, "win32", () => undefined), []);
  });

  test("the real file system works too, in name order", () => {
    write("scan/b/Two.cpp", "");
    write("scan/a/One.cpp", "");
    write("scan/a/Tests/Skipped.cpp", "");
    const found = findEntrylessSources([{ dir: path.join(root, "scan"), group: "own" }], () => false, 1, "win32");
    assert.deepStrictEqual(found, [normalizePath(path.join(root, "scan", "a", "One.cpp"))]);
  });
});
