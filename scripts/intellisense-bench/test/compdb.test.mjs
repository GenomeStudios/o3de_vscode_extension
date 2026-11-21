import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  OTHER_PART,
  computeCoverage,
  distinctFiles,
  entryFilePath,
  filesInEveryDb,
  filesWithoutEntry,
  loadCompileDb,
  loadRawCompileDb,
  makeClassifier,
  navWanted,
  pickEvenly,
  scanDisk,
  selectNavSubset,
  sharedSample,
  stratifiedSample,
} from "../lib/compdb.mjs";
import { pathKey } from "../lib/paths.mjs";

const parts = {
  projectGem: ["D:/Dev/gs_play/Gem"],
  project: ["D:/Dev/gs_play"],
  workspaceGems: ["D:/Dev/gs_play_gems"],
  engineSource: ["d:/Dev/o3de_sourcedev"],
  engineSdk: ["C:/Users/me/.o3de/Engines/GS_Play_Engine"],
};
const classify = makeClassifier(parts);

// ============================================================================
//  classification
// ============================================================================

test("classify: first matching part wins (project gem before project)", () => {
  assert.equal(classify("D:/Dev/gs_play/Gem/Code/a.cpp"), "projectGem");
  assert.equal(classify("D:/Dev/gs_play/Source/b.cpp"), "project");
});

test("classify: case-insensitive and slash-insensitive", () => {
  assert.equal(classify("d:\\dev\\GS_PLAY_GEMS\\gs_core\\a.cpp"), "workspaceGems");
  assert.equal(classify("D:/DEV/O3DE_SOURCEDEV/Code/a.cpp"), "engineSource");
  assert.equal(classify("c:/users/me/.o3de/engines/gs_play_engine/Code/a.cpp"), "engineSdk");
});

test("classify: a sibling folder that merely shares a prefix is not matched", () => {
  assert.equal(classify("D:/Dev/gs_play_extra/a.cpp"), OTHER_PART);
});

test("classify: unknown location is 'other'", () => {
  assert.equal(classify("E:/elsewhere/a.cpp"), OTHER_PART);
});

// ============================================================================
//  sampling
// ============================================================================

function entriesFor(files) {
  return files.map((file) => ({ file, directory: "D:/build" }));
}

test("pickEvenly: evenly spaced, first included, deterministic", () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(pickEvenly(items, 4), [0, 5, 10, 15]);
  assert.deepEqual(pickEvenly(items, 4), pickEvenly(items, 4));
  assert.deepEqual(pickEvenly([1, 2, 3], 8), [1, 2, 3]);
  assert.deepEqual(pickEvenly(items, 0), []);
});

test("stratifiedSample: per part, independent of DB order", () => {
  const files = [];
  for (let i = 0; i < 30; i++) files.push(`D:/Dev/gs_play_gems/gs_core/f${String(i).padStart(2, "0")}.cpp`);
  for (let i = 0; i < 10; i++) files.push(`d:/Dev/o3de_sourcedev/Code/g${i}.cpp`);

  const forward = stratifiedSample(entriesFor(files), classify, Object.keys(parts), 5, []);
  const backward = stratifiedSample(entriesFor([...files].reverse()), classify, Object.keys(parts), 5, []);
  assert.deepEqual(forward, backward);

  assert.equal(forward.filter((s) => s.part === "workspaceGems").length, 5);
  assert.equal(forward.filter((s) => s.part === "engineSource").length, 5);
  assert.equal(forward.filter((s) => s.part === "project").length, 0);
  // evenly spaced over the sorted list: indices 0, 6, 12, 18, 24
  assert.deepEqual(
    forward.filter((s) => s.part === "workspaceGems").map((s) => path.posix.basename(s.file)),
    ["f00.cpp", "f06.cpp", "f12.cpp", "f18.cpp", "f24.cpp"],
  );
});

test("stratifiedSample: a file built for two targets counts once", () => {
  const files = ["D:/Dev/gs_play_gems/a.cpp", "D:/Dev/gs_play_gems/a.cpp", "D:/Dev/gs_play_gems/b.cpp"];
  assert.deepEqual(distinctFiles(entriesFor(files)), ["D:/Dev/gs_play_gems/a.cpp", "D:/Dev/gs_play_gems/b.cpp"]);
});

test("stratifiedSample: extra files appended once, flagged, and classified", () => {
  const sample = stratifiedSample(entriesFor(["D:/Dev/gs_play_gems/a.cpp"]), classify, Object.keys(parts), 8, [
    "D:/Dev/gs_play_gems/include/a.h",
    "d:/dev/gs_play_gems/A.CPP", // already sampled from the DB
  ]);
  assert.deepEqual(sample, [
    { file: "D:/Dev/gs_play_gems/a.cpp", part: "workspaceGems", extra: false },
    { file: "D:/Dev/gs_play_gems/include/a.h", part: "workspaceGems", extra: true },
  ]);
});

// ============================================================================
//  one sample for all variants
// ============================================================================

const gemFiles = (names) => names.map((n) => `D:/Dev/gs_play_gems/gs_core/${n}.cpp`);
const nameList = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);

test("sharedSample: variants with different DBs get ONE identical sample, drawn from the union", () => {
  const a = entriesFor(gemFiles([...nameList(20, "a"), "common"]));
  const b = entriesFor(gemFiles([...nameList(20, "b"), "common"]));
  const partNames = Object.keys(parts);

  const shared = sharedSample([a, b], classify, partNames, 6, []);
  assert.equal(shared.length, 6);
  // the old per-variant draw really did differ between the two DBs ...
  assert.notDeepEqual(stratifiedSample(a, classify, partNames, 6, []), stratifiedSample(b, classify, partNames, 6, []));
  // ... and the shared draw is the same whichever way round the variants are listed
  assert.deepEqual(sharedSample([b, a], classify, partNames, 6, []), shared);
  // it is a sample of the union: files from both DBs can appear
  const names = shared.map((s) => path.posix.basename(s.file));
  assert.ok(names.some((n) => n.startsWith("a")) && names.some((n) => n.startsWith("b")), names.join(","));
  // a file both DBs build is listed once
  assert.equal(distinctFiles([...a, ...b]).length, 41);
});

test("sharedSample: the same DBs always give the same sample, and extra files are appended once", () => {
  const a = entriesFor(gemFiles(nameList(10, "a")));
  const extras = ["D:/Dev/gs_play_gems/gs_core/include/a.h"];
  const first = sharedSample([a, a], classify, Object.keys(parts), 4, extras);
  assert.deepEqual(sharedSample([a, a], classify, Object.keys(parts), 4, extras), first);
  assert.deepEqual(first, stratifiedSample(a, classify, Object.keys(parts), 4, extras), "one variant: the same as the plain draw");
  assert.equal(first.filter((s) => s.extra).length, 1);
});

test("filesInEveryDb: only files every variant has an entry for (case-insensitive)", () => {
  const a = entriesFor(["D:/x/one.cpp", "D:/x/two.cpp", "D:/x/three.cpp"]);
  const b = entriesFor(["d:/X/ONE.cpp", "D:/x/three.cpp"]);
  const c = entriesFor(["D:/x/one.cpp", "D:/x/three.cpp", "D:/x/four.cpp"]);
  assert.deepEqual([...filesInEveryDb([a, b, c])].sort(), ["d:/x/one.cpp", "d:/x/three.cpp"]);
  assert.deepEqual([...filesInEveryDb([a])].sort(), ["d:/x/one.cpp", "d:/x/three.cpp", "d:/x/two.cpp"]);
  assert.deepEqual([...filesInEveryDb([])], []);
});

// ============================================================================
//  navigation subset of a compile DB
// ============================================================================

const raw = (file, extra = {}) => ({ directory: "D:/build", file, command: `cl ${file}`, ...extra });
const subsetFiles = (entries) => entries.map((e) => entryFilePath(e));

test("entryFilePath: relative files resolve against the entry's directory", () => {
  assert.equal(entryFilePath({ directory: "D:/build", file: "../src/a.cpp" }), "D:/src/a.cpp");
  assert.equal(entryFilePath({ directory: "D:/build", file: "C:\\abs\\b.cpp" }), "C:/abs/b.cpp");
});

test("selectNavSubset: probe files, expected .cpp targets and same-stem sources are chosen; the rest is left out", () => {
  const db = [
    raw("D:/gems/gs_core/Code/Source/Probe.cpp"), // a probe file
    raw("D:/gems/gs_core/Code/Source/Other.cpp"), // nothing to do with the probes
    raw("D:/engine/AzCore/AzCore/Component/Entity.cpp"), // expected .cpp target
    raw("D:/engine/elsewhere/Entity.cpp"), // same name, wrong path: only the suffix match picks Entity.cpp
    raw("D:/gems/gs_item/Code/Source/StockWallet.cpp"), // same stem as an expected header
    raw("D:/gems/gs_item/Code/Source/Unrelated.cpp"),
  ];
  const wanted = navWanted(
    [{ file: "D:/gems/gs_core/Code/Source/Probe.cpp", expect: { fileSuffix: "AzCore/Component/Entity.cpp" } }],
    [{ expectFileSuffix: "gs_item/Code/Include/GS_Item/Stock/StockWallet.h" }],
  );
  const chosen = subsetFiles(selectNavSubset(db, wanted, 0));
  assert.deepEqual(chosen, ["D:/gems/gs_core/Code/Source/Probe.cpp", "D:/engine/AzCore/AzCore/Component/Entity.cpp", "D:/gems/gs_item/Code/Source/StockWallet.cpp"]);
});

test("navWanted: relationship probes contribute every suffix they expect, so the subset keeps those files", () => {
  const wanted = navWanted(
    [
      { file: "D:/g/a/Probe.cpp", expect: { mustIncludeFileSuffixes: ["src/Caller.cpp", "include/Base.h"], minFiles: 2 } },
      { file: "D:/g/a/Probe.cpp", expect: { subtypeFileSuffixes: ["src/Derived.cpp"] } },
      { file: "D:/g/a/Probe.cpp", expect: { titleIncludes: "override" } },
      { file: "D:/g/a/Probe.cpp", expect: { labelsInclude: ["Size"] } },
    ],
    [{ expectFileSuffix: "x/Y.h" }],
  );
  assert.deepEqual(wanted.targets, ["src/Caller.cpp", "include/Base.h", "src/Derived.cpp", "x/Y.h"]);
  assert.deepEqual(wanted.files, ["D:/g/a/Probe.cpp", "D:/g/a/Probe.cpp", "D:/g/a/Probe.cpp", "D:/g/a/Probe.cpp"]);

  const db = [raw("D:/g/a/Probe.cpp"), raw("D:/g/b/src/Caller.cpp"), raw("D:/g/c/src/Derived.cpp"), raw("D:/g/d/Other.cpp"), raw("D:/g/e/Base.cpp")];
  assert.deepEqual(subsetFiles(selectNavSubset(db, wanted, 0)), ["D:/g/a/Probe.cpp", "D:/g/b/src/Caller.cpp", "D:/g/c/src/Derived.cpp", "D:/g/e/Base.cpp"]);
});

test("selectNavSubset: a header probe file has no entry and selects nothing by itself", () => {
  const db = [raw("D:/gems/a/Code/Source/A.cpp")];
  const wanted = navWanted([{ file: "D:/gems/a/Code/Include/A.h", expect: { fileSuffix: "Code/Include/B.h" } }], []);
  assert.deepEqual(selectNavSubset(db, wanted, 5), []);
});

test("filesWithoutEntry: probe files that have no entry of their own, each once, matched ignoring case and slashes", () => {
  const db = [raw("D:/g/a/Code/Source/A.cpp"), raw("d:\\g\\b\\Code\\Source\\B.cpp")];
  const files = ["D:/g/a/Code/Source/A.cpp", "D:/g/a/Code/Include/A.h", "D:/G/B/Code/Source/b.cpp", "D:/g/c/Code/Source/C.cpp", "d:/g/a/code/include/a.h"];
  assert.deepEqual(filesWithoutEntry(db, files), ["D:/g/a/Code/Include/A.h", "D:/g/c/Code/Source/C.cpp"]);
});

test("selectNavSubset: a proxy file keeps every one of its entries, wherever it sits, so an entry-less probe file infers the full DB's flags", () => {
  // The probe file has no entry. In the full DB clangd infers its flags from Module.cpp in ANOTHER tree (two entries: it is built twice).
  // The proxy's folder has no probe and shares no ancestor with the probe file, so neither the probe-file rule nor the neighbour rule reaches it.
  const probeFile = "D:/gems/gs_ai/Code/Source/Probe.cpp";
  const proxyA = raw("D:/other/Volumetric/Code/Source/Clients/Module.cpp", { arguments: ["cl", "-DEDITOR"] });
  const proxyB = raw("D:/other/Volumetric/Code/Source/Clients/Module.cpp", { arguments: ["cl", "-DCLIENT"] });
  const db = [raw("D:/gems/gs_core/Code/Source/Target.cpp"), proxyA, raw("D:/other/Volumetric/Code/Source/Clients/Unrelated.cpp"), proxyB, raw("D:/gems/gs_ai/Code/Source/Sibling.cpp")];
  const wanted = navWanted([{ file: probeFile, expect: { fileSuffix: "gs_core/Code/Source/Target.cpp" } }], []);

  const before = selectNavSubset(db, wanted, 0);
  assert.deepEqual(subsetFiles(before), ["D:/gems/gs_core/Code/Source/Target.cpp"], "without the proxy the subset holds only the target, so clangd would infer the probe file's flags from something else");

  const withProxy = selectNavSubset(db, { ...wanted, proxies: ["d:/other/volumetric/code/source/clients/module.cpp"] }, 0);
  assert.equal(withProxy.length, 3);
  assert.deepEqual(withProxy.map((e) => e.arguments?.[1]).filter(Boolean), ["-DEDITOR", "-DCLIENT"]);
  assert.strictEqual(withProxy[1], proxyA);
  assert.strictEqual(withProxy[2], proxyB);
  assert.ok(!subsetFiles(withProxy).includes("D:/other/Volumetric/Code/Source/Clients/Unrelated.cpp"), "no neighbour cap needed: only the proxy, not its folder");
});

test("selectNavSubset: a proxy in a sibling subtree of the probe file (same gem, other folder) is kept the same way", () => {
  const db = [raw("D:/gems/gs_ui/Code/Source/Clients/Module.cpp"), raw("D:/gems/gs_ui/Code/Source/Clients/Other.cpp"), raw("D:/gems/gs_ui/Code/Source/Tools/Editor.cpp")];
  const wanted = navWanted([{ file: "D:/gems/gs_ui/Code/Source/UINavigation/Hub.cpp", expect: { fileSuffix: "gs_ui/Code/Include/GS_UI/Hub.h" } }], []);
  assert.deepEqual(selectNavSubset(db, wanted, 0), []);
  assert.deepEqual(subsetFiles(selectNavSubset(db, { ...wanted, proxies: ["D:/gems/gs_ui/Code/Source/Clients/Module.cpp"] }, 0)), ["D:/gems/gs_ui/Code/Source/Clients/Module.cpp"]);
});

test("selectNavSubset: up to N neighbours per folder of a chosen file, in path order, DB order kept in the result", () => {
  const db = [raw("D:/g/src/e.cpp"), raw("D:/g/src/probe.cpp"), raw("D:/g/src/b.cpp"), raw("D:/g/src/a.cpp"), raw("D:/g/src/c.cpp"), raw("D:/g/far/z.cpp")];
  const wanted = navWanted([{ file: "D:/g/src/probe.cpp", expect: { fileSuffix: "src/probe.cpp" } }], []);

  assert.deepEqual(subsetFiles(selectNavSubset(db, wanted, 0)), ["D:/g/src/probe.cpp"]);
  // neighbours a.cpp and b.cpp (first two by path); they keep the DB's order; the other folder is untouched
  assert.deepEqual(subsetFiles(selectNavSubset(db, wanted, 2)), ["D:/g/src/probe.cpp", "D:/g/src/b.cpp", "D:/g/src/a.cpp"]);
  assert.equal(selectNavSubset(db, wanted, 99).length, 5, "never more than the folder holds");
});

test("selectNavSubset: matching ignores case and slashes, every entry of a multi-target file is kept, entries are returned untouched", () => {
  const first = raw("d:\\GEMS\\Probe.CPP", { directory: "D:\\build", arguments: ["cl", "-DA"] });
  const second = raw("D:/gems/probe.cpp", { directory: "D:/build2", arguments: ["cl", "-DB"] });
  const chosen = selectNavSubset([first, raw("D:/gems/x/Other.cpp"), second], navWanted([{ file: "D:/gems/Probe.cpp", expect: { fileSuffix: "nope.h" } }], []), 0);
  assert.equal(chosen.length, 2);
  assert.strictEqual(chosen[0], first);
  assert.strictEqual(chosen[1], second);
});

test("selectNavSubset: the result does not depend on how the DB is ordered, apart from the order itself", () => {
  const db = nameList(12, "f").map((n) => raw(`D:/g/src/${n}.cpp`));
  const wanted = navWanted([{ file: "D:/g/src/f05.cpp", expect: { fileSuffix: "src/f09.cpp" } }], []);
  const forward = new Set(subsetFiles(selectNavSubset(db, wanted, 2)).map(pathKey));
  const backward = new Set(subsetFiles(selectNavSubset([...db].reverse(), wanted, 2)).map(pathKey));
  assert.deepEqual([...forward].sort(), [...backward].sort());
});

test("loadRawCompileDb keeps the raw entries that name a file", () => {
  const root = makeTree([]);
  fs.writeFileSync(`${root}/cc.json`, JSON.stringify([{ directory: "D:/b", file: "a.cpp", arguments: ["cl"] }, { directory: "D:/b" }, null]));
  assert.deepEqual(loadRawCompileDb(`${root}/cc.json`), [{ directory: "D:/b", file: "a.cpp", arguments: ["cl"] }]);
  fs.writeFileSync(`${root}/obj.json`, "{}");
  assert.throws(() => loadRawCompileDb(`${root}/obj.json`), /must be a JSON array/);
});

// ============================================================================
//  coverage on a real folder tree
// ============================================================================

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoots = [];
function makeTree(files) {
  const root = fs.mkdtempSync(path.join(here, ".tmp-compdb-")).split("\\").join("/");
  tmpRoots.push(root);
  for (const f of files) {
    fs.mkdirSync(path.dirname(`${root}/${f}`), { recursive: true });
    fs.writeFileSync(`${root}/${f}`, "// test\n");
  }
  return root;
}
after(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("coverage: counts on-disk sources, skips excluded folders, reports % with entries", () => {
  const root = makeTree([
    "Gem/Code/a.cpp",
    "Gem/Code/b.cpp",
    "Gem/Code/c.h", // not a source extension
    "Source/d.cc",
    "Source/e.cxx",
    "build/windows/generated.cpp", // excluded
    "3rdParty/lib/x.cpp", // excluded
  ]);
  const localParts = { projectGem: [`${root}/Gem`], project: [root] };
  const localClassify = makeClassifier(localParts);
  const onDisk = scanDisk(localParts, ["/build/", "/3rdparty/"], localClassify);

  assert.equal(onDisk.get("projectGem").length, 2);
  assert.equal(onDisk.get("project").length, 2); // the gem files are not double counted

  const entries = entriesFor([`${root}/Gem/Code/a.cpp`, `${root}/Source/d.cc`, `${root}/build/windows/generated.cpp`]);
  const coverage = computeCoverage(entries, onDisk, localClassify, Object.keys(localParts));

  assert.equal(coverage.projectGem.onDisk, 2);
  assert.equal(coverage.projectGem.withEntries, 1);
  assert.equal(coverage.projectGem.pct, 50);
  assert.equal(coverage.project.onDisk, 2);
  assert.equal(coverage.project.withEntries, 1);
  assert.equal(coverage.project.dbEntries, 2); // d.cc and the generated file
  assert.equal(coverage.project.dbOnly, 1); // generated.cpp lives in an excluded folder
  assert.deepEqual(coverage.projectGem.missingSample, [`${root}/Gem/Code/b.cpp`]);
});

test("coverage: a part with nothing on disk reports null, not a division error", () => {
  const coverage = computeCoverage([], new Map(), classify, Object.keys(parts));
  assert.equal(coverage.project.pct, null);
});

test("loadCompileDb: resolves relative file names against directory", () => {
  const root = makeTree([]);
  fs.writeFileSync(
    `${root}/compile_commands.json`,
    JSON.stringify([
      { directory: "D:/build", file: "../src/a.cpp", arguments: ["cl"] },
      { directory: "D:/build", file: "C:/abs/b.cpp", command: "cl" },
      { directory: "D:/build" }, // no file: dropped
    ]),
  );
  assert.deepEqual(
    loadCompileDb(`${root}/compile_commands.json`).map((e) => e.file),
    ["D:/src/a.cpp", "C:/abs/b.cpp"],
  );
});
