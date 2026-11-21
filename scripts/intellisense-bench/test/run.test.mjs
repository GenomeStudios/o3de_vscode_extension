import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { lockPathFor } from "../lib/lock.mjs";
import { loadRecipe } from "../lib/recipe.mjs";
import { prepareVariant } from "../lib/nav.mjs";
import { navFolder, runBenchmark } from "../lib/run.mjs";

// These tests run the real runBenchmark with `node` standing in for clangd: it answers
// "--version", and fails fast on the clangd-style flags, so every checked file comes back
// "failed". That is enough to see WHICH files were checked and how the run is locked,
// without starting clangd.

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoots = [];
after(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

const names = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);

/**
 * A project with two variants whose DBs differ: A builds a00..a19, B builds b00..b19, both build a05.
 * @param {object} [overrides]  recipe fields to replace
 */
function makeProject(overrides = {}) {
  const root = fs.mkdtempSync(path.join(here, ".tmp-run-")).split("\\").join("/");
  tmpRoots.push(root);
  const proj = `${root}/proj`;
  fs.mkdirSync(`${proj}/src`, { recursive: true });

  const db = (files) => files.map((f) => ({ directory: proj, file: `${proj}/src/${f}.cpp`, arguments: ["clang++", `${proj}/src/${f}.cpp`] }));
  fs.writeFileSync(`${root}/a.json`, JSON.stringify(db(names("a", 20))));
  fs.writeFileSync(`${root}/b.json`, JSON.stringify(db([...names("b", 20), "a05"])));

  const recipe = {
    name: "runtest",
    clangd: process.execPath,
    workDir: `${root}/work`,
    project: proj,
    parts: { project: [proj] },
    variants: [
      { name: "A", db: `${root}/a.json` },
      { name: "B", db: `${root}/b.json` },
    ],
    sample: { perPart: 8, extraFiles: [`${proj}/include/x.h`] },
    limits: { checkTimeoutSec: 30, checkConcurrency: 4 },
    ...overrides,
  };
  fs.writeFileSync(`${root}/recipe.json`, JSON.stringify(recipe, null, 2));
  return { root, proj, loaded: loadRecipe(`${root}/recipe.json`), work: `${root}/work` };
}

const checkedFiles = (report, index) => report.variants[index].check.files.map((f) => path.posix.basename(f.file));

// ============================================================================
//  one check sample for every variant
// ============================================================================

test("both variants are checked on the same files, drawn from the union of their DBs", async () => {
  const { loaded } = makeProject();
  const { report } = await runBenchmark(loaded, { only: ["check"] });

  const expected = ["a00.cpp", "a05.cpp", "a10.cpp", "a15.cpp", "b00.cpp", "b05.cpp", "b10.cpp", "b15.cpp", "x.h"];
  assert.deepEqual(checkedFiles(report, 0), expected);
  assert.deepEqual(checkedFiles(report, 1), expected);
  assert.equal(report.variants[0].sampleSize, expected.length);
  assert.equal(report.variants[1].sampleSize, expected.length);
});

test("choosing one variant with --variant does not change the sample", async () => {
  const { loaded } = makeProject();
  const both = (await runBenchmark(loaded, { only: ["check"] })).report;
  const onlyA = (await runBenchmark(loaded, { only: ["check"], variants: ["A"] })).report;
  const onlyB = (await runBenchmark(loaded, { only: ["check"], variants: ["B"] })).report;

  assert.deepEqual(checkedFiles(onlyA, 0), checkedFiles(both, 0));
  assert.deepEqual(checkedFiles(onlyB, 0), checkedFiles(both, 1));
  assert.deepEqual(checkedFiles(onlyA, 0), checkedFiles(onlyB, 0), "A-only and B-only runs check identical files");
});

test("each check row says whether this variant's DB has an entry, and whether every variant's does", async () => {
  const { loaded } = makeProject();
  const { report } = await runBenchmark(loaded, { only: ["check"] });
  const flags = (index) => Object.fromEntries(report.variants[index].check.files.map((f) => [path.posix.basename(f.file), [f.inDb, f.inAllDbs]]));

  const a = flags(0);
  assert.deepEqual(a["a00.cpp"], [true, false]); // only A builds it
  assert.deepEqual(a["a05.cpp"], [true, true]); // both build it
  assert.deepEqual(a["b00.cpp"], [false, false]); // A has no entry: clangd infers a command
  assert.deepEqual(a["x.h"], [false, false]);

  const b = flags(1);
  assert.deepEqual(b["a00.cpp"], [false, false]);
  assert.deepEqual(b["a05.cpp"], [true, true]);
  assert.deepEqual(b["b00.cpp"], [true, false]);

  // A's DB has 4 of the 9 sampled files (one of them also in B's); the other 4 B files and the header are inferred.
  // B's DB has 5 (its 4 plus the shared a05); the 3 other A files and the header are inferred.
  assert.deepEqual([report.variants[0].check.inDb.total, report.variants[0].check.common.total, report.variants[0].check.inferred.total], [4, 1, 5]);
  assert.deepEqual([report.variants[1].check.inDb.total, report.variants[1].check.common.total, report.variants[1].check.inferred.total], [5, 1, 4]);
});

// ============================================================================
//  one run per work directory
// ============================================================================

test("a run takes the work dir lock, records it, and gives it back", async () => {
  const { loaded, work } = makeProject();
  const { report } = await runBenchmark(loaded, { only: ["check"], variants: ["A"] });
  assert.equal(report.run.exclusive, true);
  assert.ok(report.run.otherClangdProcesses === null || Number.isInteger(report.run.otherClangdProcesses));
  assert.equal(fs.existsSync(lockPathFor(work)), false, "released at the end");
});

test("a second run is refused while another live process holds the work dir, before anything is touched", async () => {
  const { loaded, work } = makeProject();
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(lockPathFor(work), JSON.stringify({ pid: process.ppid, startedAt: "2026-11-21T10:00:00.000Z", recipe: "other" }));

  await assert.rejects(runBenchmark(loaded, { only: ["nav"], cold: true }), new RegExp(`${work.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is in use by bench pid ${process.ppid}`));
  assert.equal(fs.existsSync(`${work}/variants`), false, "no variant folder was prepared (or, with --cold, its .cache removed)");
  assert.equal(fs.existsSync(`${work}/runs`), false, "no run folder was made");
  assert.equal(fs.existsSync(lockPathFor(work)), true, "the other run's lock is left alone");
});

test("a coverage-only run starts no clangd, so it does not need the lock", async () => {
  const { loaded, work } = makeProject();
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(lockPathFor(work), JSON.stringify({ pid: process.ppid, recipe: "other" }));

  const { report } = await runBenchmark(loaded, { only: ["coverage"] });
  assert.equal(report.run.exclusive, false);
  assert.equal(report.run.otherClangdProcesses, null);
  assert.equal(JSON.parse(fs.readFileSync(lockPathFor(work), "utf8")).recipe, "other");
});

test("the lock is given back when the run fails part-way", async () => {
  const { loaded, work } = makeProject({ clangd: "D:/definitely/not/here/clangd.exe" });
  await assert.rejects(runBenchmark(loaded, { only: ["check"] }), /Cannot run clangd/);
  assert.equal(fs.existsSync(lockPathFor(work)), false);
});

test("a stale lock from a dead run does not block a new one", async () => {
  const { loaded, work } = makeProject();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(lockPathFor(work), JSON.stringify({ pid: dead, recipe: "crashed" }));

  const { report } = await runBenchmark(loaded, { only: ["check"], variants: ["A"] });
  assert.equal(report.run.exclusive, true);
  assert.equal(fs.existsSync(lockPathFor(work)), false);
});

// ============================================================================
//  nav stage: where an entry-less probe file's flags come from
// ============================================================================

// A probe file with no entry (include/x.h) that should land in src/a07.cpp; the DB builds src/a00..a19.cpp.
// A fake finder stands in for "clangd --check" (which says which entry clangd infers the flags from).
function makeNavProject(nav) {
  const project = makeProject({ nav });
  const { proj, loaded } = project;
  const probe = (id, file) => ({
    id,
    part: "project",
    category: "c",
    file,
    anchor: "x",
    token: "x",
    expect: { fileSuffix: "src/a07.cpp", kind: "any" },
    expectedBuilt: false,
  });
  loaded.recipe.probes = [probe("entryless", `${proj}/include/x.h`), probe("own-entry", `${proj}/src/a01.cpp`)];
  const variant = loaded.recipe.variants[0];
  return { ...project, recipe: loaded.recipe, variant, fullDir: prepareVariant(loaded.recipe.workDir, variant) };
}

const subsetNames = (work) => JSON.parse(fs.readFileSync(`${work}/variants/A/nav-subset/compile_commands.json`, "utf8")).map((e) => path.posix.basename(e.file));

test("nav subset: the entry clangd infers an entry-less probe file's flags from is kept, and the probe is marked 'full-DB inferred' from it", async () => {
  const { recipe, variant, fullDir, proj, work } = makeNavProject({ dbSubset: { neighbours: 0 } });
  const asked = [];
  const finder = async ({ file, dbDir }) => {
    asked.push([path.posix.basename(file), dbDir]);
    return { proxy: `${proj}/src/a12.cpp`, note: "" };
  };
  const logs = [];
  const nav = await navFolder(recipe, variant, fullDir, (m) => logs.push(m), finder);

  assert.deepEqual(asked, [["x.h", fullDir]], "asked once, of the FULL DB, and not for the probe file that has an entry");
  assert.deepEqual(subsetNames(work), ["a01.cpp", "a07.cpp", "a12.cpp"], "the probe files' entries, the target, and the proxy (no neighbours needed)");
  assert.deepEqual([...nav.entryless.values()], [{ source: "full-DB inferred", from: `${proj}/src/a12.cpp` }]);
  assert.equal(nav.dir.endsWith("/nav-subset"), true);
  assert.match(logs.join("\n"), /x\.h has no DB entry: flags inferred from .*a12\.cpp/);
});

test("nav subset: when clangd names no entry, the subset is what it was before, the probe is 'subset-inferred' and a warning is logged", async () => {
  const { recipe, variant, fullDir, work } = makeNavProject({ dbSubset: { neighbours: 0 } });
  const logs = [];
  const nav = await navFolder(recipe, variant, fullDir, (m) => logs.push(m), async () => ({ proxy: null, note: "clangd printed no line" }));

  assert.deepEqual(subsetNames(work), ["a01.cpp", "a07.cpp"]);
  assert.deepEqual([...nav.entryless.values()], [{ source: "subset-inferred", from: "" }]);
  assert.match(logs.join("\n"), /WARNING: .*x\.h has no DB entry and clangd did not name an entry it infers from \(clangd printed no line\)/);
});

test("nav subset: a named entry that the DB does not hold is not trusted: the same fallback", async () => {
  const { recipe, variant, fullDir, proj, work } = makeNavProject({ dbSubset: { neighbours: 0 } });
  const logs = [];
  const nav = await navFolder(recipe, variant, fullDir, (m) => logs.push(m), async () => ({ proxy: `${proj}/src/not_in_db.cpp`, note: "" }));

  assert.deepEqual(subsetNames(work), ["a01.cpp", "a07.cpp"]);
  assert.deepEqual([...nav.entryless.values()], [{ source: "subset-inferred", from: "" }]);
  assert.match(logs.join("\n"), /not_in_db\.cpp is not in the DB/);
});

test("full-DB nav (no subset): the flags are the full DB's whether or not clangd named the entry, and the folder is the full copy", async () => {
  const { recipe, variant, fullDir, proj } = makeNavProject(undefined);
  const named = await navFolder(recipe, variant, fullDir, () => {}, async () => ({ proxy: `${proj}/src/a12.cpp`, note: "" }));
  assert.equal(named.dir, fullDir);
  assert.equal(named.dbSubset, null);
  assert.deepEqual([...named.entryless.values()], [{ source: "full-DB inferred", from: `${proj}/src/a12.cpp` }]);

  const unnamed = await navFolder(recipe, variant, fullDir, () => {}, async () => ({ proxy: null, note: "no line" }));
  assert.deepEqual([...unnamed.entryless.values()], [{ source: "full-DB inferred", from: "" }]);
});

test("nav subset: nothing is asked of clangd when every probe file has an entry", async () => {
  const { recipe, variant, fullDir, proj } = makeNavProject({ dbSubset: { neighbours: 0 } });
  recipe.probes = recipe.probes.filter((p) => p.file === `${proj}/src/a01.cpp`);
  let asked = 0;
  const nav = await navFolder(recipe, variant, fullDir, () => {}, async () => (asked++, { proxy: null, note: "" }));
  assert.equal(asked, 0);
  assert.equal(nav.entryless.size, 0);
});
