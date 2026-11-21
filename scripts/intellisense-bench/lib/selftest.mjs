// ============================================================================
//  selftest.mjs - prove the whole pipeline on a tiny scratch C++ project
//
//  Builds <workDir>/selftest/proj (6 .cpp + headers, hand-written compile DB, no
//  standard-library includes so it needs no toolchain), then runs the real harness
//  twice - cold, then warm - and asserts:
//    * go-to-definition works across files, through the background index
//    * a deliberately wrong probe FAILS (so a pass means something)
//    * workspace/symbol finds symbols
//    * the relationship probes work end to end: references, implementation, type hierarchy
//      (two levels), incoming calls, rename (a dry run: no file is changed), clangd's override
//      code action, and completion after "." and "::"
//    * clangd --check is clean, coverage is 100%
//    * the background index landed inside the work directory, and nothing was
//      written next to the project or its compile DB
//    * the second run sees a warm index
//    * the check rows say which files had a DB entry, the probes know which need the
//      index, and the work directory lock is held for a run and given back
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { lockPathFor } from "./lock.mjs";
import { loadRecipe } from "./recipe.mjs";
import { findClangd } from "./procs.mjs";
import { runBenchmark } from "./run.mjs";
import { isUnder } from "./paths.mjs";

export const DEFAULT_SELFTEST_WORKDIR = "D:/ib";

// ============================================================================
//  THE SCRATCH PROJECT
// ============================================================================

const SHAPE_H = `#pragma once

namespace selftest
{
    int Area(int width, int height);

    class Widget
    {
    public:
        explicit Widget(int size);
        int Size() const;

    private:
        int m_size;
    };
}
`;

const SHAPE_CPP = `#include "shape.h"

namespace selftest
{
    static int HelperOnlyInCpp(int value)
    {
        return value * 2;
    }

    int Area(int width, int height)
    {
        return HelperOnlyInCpp(width) * height / 2;
    }

    Widget::Widget(int size)
        : m_size(size)
    {
    }

    int Widget::Size() const
    {
        return m_size;
    }
}
`;

const MAIN_CPP = `#include "shape.h"

int main()
{
    selftest::Widget widget(4);
    return selftest::Area(widget.Size(), 3);
}
`;

// ---- the relationship part: a base class with a virtual, derived classes in separate files, a caller ----

const CREATURE_H = `#pragma once

namespace selftest
{
    class Creature
    {
    public:
        virtual ~Creature() = default;
        virtual int Legs() const;
        virtual int Sound() const = 0;
    };
}
`;

const CREATURE_CPP = `#include "creature.h"

namespace selftest
{
    int Creature::Legs() const
    {
        return 4;
    }
}
`;

const DOG_H = `#pragma once
#include "creature.h"

namespace selftest
{
    class Dog : public Creature
    {
    public:
        int Sound() const override;
    };
}
`;

const DOG_CPP = `#include "dog.h"

namespace selftest
{
    int Dog::Sound() const
    {
        return 1;
    }
}
`;

const BIRD_H = `#pragma once
#include "creature.h"

namespace selftest
{
    class Bird : public Creature
    {
    public:
        int Legs() const override;
        int Sound() const override;
    };
}
`;

const BIRD_CPP = `#include "bird.h"

namespace selftest
{
    int Bird::Legs() const
    {
        return 2;
    }

    int Bird::Sound() const
    {
        return 2;
    }
}
`;

// a second-level subtype, in a file of its own
const PUPPY_H = `#pragma once
#include "dog.h"

namespace selftest
{
    class Puppy : public Dog
    {
    };
}
`;

// the caller; Lazy derives from Creature and implements nothing, which is where clangd offers its override action
const ZOO_CPP = `#include "bird.h"
#include "dog.h"
#include "puppy.h"

namespace selftest
{
    class Lazy : public Creature
    {
    };

    int CountLegs(const Creature& creature)
    {
        return creature.Legs();
    }

    int TotalLegs()
    {
        Dog dog;
        Bird bird;
        Puppy puppy;
        return CountLegs(dog) + CountLegs(bird) + CountLegs(puppy);
    }
}
`;

const SOURCE_FILES = ["src/main.cpp", "src/shape.cpp", "src/creature.cpp", "src/dog.cpp", "src/bird.cpp", "src/zoo.cpp"];

/**
 * Write the scratch project and its compile database. Returns the project folder.
 * @param {string} root  <workDir>/selftest
 * @returns {string}
 */
export function writeScratchProject(root) {
  const proj = `${root}/proj`;
  fs.mkdirSync(`${proj}/include`, { recursive: true });
  fs.mkdirSync(`${proj}/src`, { recursive: true });
  const files = {
    "include/shape.h": SHAPE_H,
    "src/shape.cpp": SHAPE_CPP,
    "src/main.cpp": MAIN_CPP,
    "include/creature.h": CREATURE_H,
    "src/creature.cpp": CREATURE_CPP,
    "include/dog.h": DOG_H,
    "src/dog.cpp": DOG_CPP,
    "include/bird.h": BIRD_H,
    "src/bird.cpp": BIRD_CPP,
    "include/puppy.h": PUPPY_H,
    "src/zoo.cpp": ZOO_CPP,
  };
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(`${proj}/${file}`, text);

  const db = SOURCE_FILES.map((file) => ({
    directory: proj,
    file: `${proj}/${file}`,
    arguments: ["clang++", "-std=c++17", `-I${proj}/include`, `${proj}/${file}`],
  }));
  fs.writeFileSync(`${proj}/compile_commands.json`, JSON.stringify(db, null, 2) + "\n");
  return proj;
}

/**
 * @param {string} clangd
 * @param {string} proj
 * @param {string} work
 */
export function selftestRecipe(clangd, proj, work) {
  const file = (rel) => `${proj}/${rel}`;
  const relation = (id, type, category, rel, anchor, token, expect, extra = {}) => ({ id, type, part: "project", category, file: file(rel), anchor, token, expect, ...extra });
  return {
    name: "selftest",
    clangd,
    workDir: work,
    project: proj,
    parts: { project: [proj] },
    excludeDirs: [],
    variants: [{ name: "tiny", db: `${proj}/compile_commands.json`, extraArgs: [] }],
    sample: { perPart: 8, extraFiles: [`${proj}/include/shape.h`] },
    probes: [
      // F12 on a call lands in the .cpp: needs the background index (declaration is in the header)
      { id: "call-to-cpp-definition", part: "project", category: "cross-file .cpp", file: `${proj}/src/main.cpp`, anchor: "return selftest::Area(", token: "Area", expect: { fileSuffix: "src/shape.cpp", kind: "definition" } },
      // a probe in another file between two probes in main.cpp: main.cpp is closed and must be reopened properly
      { id: "static-call-in-same-file", part: "project", category: "same-file", file: `${proj}/src/shape.cpp`, anchor: "return HelperOnlyInCpp(width)", token: "HelperOnlyInCpp", expect: { fileSuffix: "src/shape.cpp", kind: "definition" } },
      { id: "method-to-cpp-definition", part: "project", category: "cross-file .cpp", file: `${proj}/src/main.cpp`, anchor: "widget.Size()", token: "Size", expect: { fileSuffix: "src/shape.cpp", kind: "definition" } },
      // a type used in main.cpp is declared in the header
      { id: "type-to-header", part: "project", category: "cross-file header", file: `${proj}/src/main.cpp`, anchor: "selftest::Widget widget(4);", token: "Widget", expect: { fileSuffix: "include/shape.h", kind: "any" } },
      // negative control: must FAIL, otherwise a "pass" proves nothing
      { id: "negative-control", part: "project", category: "control", file: `${proj}/src/main.cpp`, anchor: "return selftest::Area(", token: "Area", expect: { fileSuffix: "src/does_not_exist.cpp", kind: "definition" } },

      // ---- relationship probes: every one needs the background index ----
      // the call in zoo.cpp is the only reference to the virtual Legs(); the class name is used in four files
      relation("references-virtual-call", "references", "references", "include/creature.h", "virtual int Legs() const;", "Legs", { mustIncludeFileSuffixes: ["src/zoo.cpp"] }),
      relation("references-class-across-files", "references", "references", "include/creature.h", "class Creature", "Creature", { mustIncludeFileSuffixes: ["include/dog.h", "include/bird.h", "src/zoo.cpp"], minFiles: 4 }),
      // clangd answers with the overriding definitions
      relation("implementation-of-pure-virtual", "implementation", "implementation", "include/creature.h", "virtual int Sound() const = 0;", "Sound", { mustIncludeFileSuffixes: ["src/dog.cpp", "src/bird.cpp"] }),
      // Dog, Bird, Lazy (level 1) and Puppy, which is only a subtype of Dog (level 2, in a file of its own)
      relation("subtypes-two-levels", "typeHierarchy", "type hierarchy", "include/creature.h", "class Creature", "Creature", { subtypeFileSuffixes: ["include/dog.h", "include/bird.h", "src/zoo.cpp", "include/puppy.h"] }),
      relation("callers-of-area", "incomingCalls", "call hierarchy", "src/shape.cpp", "int Area(int width, int height)", "Area", { mustIncludeFileSuffixes: ["src/main.cpp"] }),
      // Area is declared in shape.h, defined in shape.cpp and called in main.cpp
      relation("rename-area-dry-run", "rename", "rename", "src/shape.cpp", "int Area(int width, int height)", "Area", { minFiles: 3, mustIncludeFileSuffixes: ["include/shape.h", "src/shape.cpp", "src/main.cpp"] }),
      // Lazy derives from a class with a pure virtual and overrides nothing
      relation("action-override-pure-virtuals", "codeAction", "code action", "src/zoo.cpp", "class Lazy : public Creature", "Lazy", { titleIncludes: "override pure virtual" }),
      relation("complete-member-after-dot", "completion", "completion", "src/main.cpp", "widget.Size()", ".", { labelsInclude: ["Size"] }, { afterToken: true }),
      relation("complete-scope-after-colons", "completion", "completion", "src/main.cpp", "return selftest::Area(", "::", { labelsInclude: ["Area", "Widget"] }, { afterToken: true }),
      // negative controls: these must FAIL, one for each kind of judge (files, names)
      relation("negative-control-references", "references", "control", "include/creature.h", "virtual int Legs() const;", "Legs", { mustIncludeFileSuffixes: ["src/does_not_exist.cpp"] }),
      relation("negative-control-completion", "completion", "control", "src/main.cpp", "widget.Size()", ".", { labelsInclude: ["NoSuchMember"] }, { afterToken: true }),
    ],
    symbols: [
      { query: "Widget", expectFileSuffix: "include/shape.h" },
      { query: "HelperOnlyInCpp", expectFileSuffix: "src/shape.cpp" },
    ],
    limits: { checkTimeoutSec: 60, checkConcurrency: 2, indexWaitMin: 2, jobs: 2, diagnosticsWaitSec: 30 },
  };
}

// ============================================================================
//  ASSERTIONS
// ============================================================================

/**
 * Collects named pass/fail checks and prints each as it is made.
 * @param {(message: string) => void} log
 */
function makeAsserter(log) {
  const checks = [];
  return {
    checks,
    /**
     * @param {string} name
     * @param {boolean} condition
     * @param {string} [detail]  shown when the check fails
     */
    that(name, condition, detail = "") {
      checks.push({ name, ok: Boolean(condition) });
      log(`  ${condition ? "PASS" : "FAIL"}  ${name}${condition || !detail ? "" : `  -> ${detail}`}`);
    },
  };
}

/**
 * Every file under a folder with its text, for before/after comparisons.
 * @param {string} dir
 * @returns {Map<string, string>}
 */
function readTree(dir) {
  const files = new Map();
  const stack = [dir];
  while (stack.length > 0) {
    for (const item of fs.readdirSync(stack.pop(), { withFileTypes: true })) {
      const full = `${item.parentPath ?? item.path}/${item.name}`;
      if (item.isDirectory()) stack.push(full);
      else files.set(full, fs.readFileSync(full, "utf8"));
    }
  }
  return files;
}

/** @param {Map<string, string>} a @param {Map<string, string>} b */
function sameTree(a, b) {
  return a.size === b.size && [...a].every(([file, text]) => b.get(file) === text);
}

/**
 * The relationship probes: every positive one passes, the negative controls FAIL (not error),
 * the Capabilities rows add up, and the answers carry the evidence the report shows.
 * @param {ReturnType<typeof makeAsserter>} t
 * @param {import("./report.mjs").VariantResult["nav"] | any} nav  the report's nav section
 */
function assertRelationships(t, nav) {
  const rel = nav?.relationships;
  const probe = (id) => rel?.results.find((p) => p.id === id);
  const positive = ["references-virtual-call", "references-class-across-files", "implementation-of-pure-virtual", "subtypes-two-levels", "callers-of-area", "rename-area-dry-run", "action-override-pure-virtuals", "complete-member-after-dot", "complete-scope-after-colons"];

  for (const id of positive) t.that(`relationship probe ${id} passes`, probe(id)?.status === "pass", JSON.stringify(probe(id)));
  for (const id of ["negative-control-references", "negative-control-completion"]) {
    t.that(`relationship probe ${id} FAILS (not errors)`, probe(id)?.status === "fail", JSON.stringify(probe(id)));
  }
  t.that(
    "relationships: 9 of 11 pass, all needed the index, none skipped",
    rel?.built.pass === positive.length && rel?.built.total === positive.length + 2 && rel?.built.skipped === 0 && rel?.results.every((p) => p.needsIndex),
    JSON.stringify(rel?.built),
  );

  // what the report shows for them
  const rename = probe("rename-area-dry-run")?.returned;
  t.that("rename: edit and file counts recorded (4 or more edits in 3 files)", rename?.counts.edits >= 3 && rename?.counts.files === 3, JSON.stringify(rename?.counts));
  t.that("code action: clangd's real title is 'Override pure virtual methods'", probe("action-override-pure-virtuals")?.returned?.labels.includes("Override pure virtual methods"), JSON.stringify(probe("action-override-pure-virtuals")?.returned?.labels));
  t.that("type hierarchy: second level reached (Puppy is only a subtype of Dog)", probe("subtypes-two-levels")?.returned?.labels.includes("Puppy"), JSON.stringify(probe("subtypes-two-levels")?.returned));

  const capability = (type) => nav?.capabilities.find((row) => row.type === type);
  const rate = (type) => `${capability(type)?.pass}/${capability(type)?.total}`;
  const expected = { definition: "4/5", references: "2/3", implementation: "1/1", typeHierarchy: "1/1", incomingCalls: "1/1", rename: "1/1", codeAction: "1/1", completion: "2/3", workspaceSymbol: "2/2" };
  for (const [type, want] of Object.entries(expected)) t.that(`capabilities: ${type} is ${want}`, rate(type) === want, `got ${rate(type)}`);
}

// ============================================================================
//  THE SELF-TEST
// ============================================================================

/**
 * @param {{workDir?: string, clangd?: string, log?: (message: string) => void}} [options]
 * @returns {Promise<boolean>} true when every assertion passed
 */
export async function runSelfTest({ workDir = DEFAULT_SELFTEST_WORKDIR, clangd, log = console.error } = {}) {
  const clangdPath = findClangd(clangd);
  if (!clangdPath) throw new Error("No clangd found: pass --clangd <path>, set CLANGD, or install the VS Code clangd extension");

  const root = path.posix.join(workDir.replaceAll("\\", "/"), "selftest");
  const work = `${root}/work`;
  const proj = writeScratchProject(root);
  const recipeFile = `${root}/recipe.json`;
  fs.writeFileSync(recipeFile, JSON.stringify(selftestRecipe(clangdPath, proj, work), null, 2) + "\n");
  log(`selftest project: ${proj}`);

  const loaded = loadRecipe(recipeFile);
  const t = makeAsserter(log);
  const sourcesBefore = readTree(proj); // the rename probe must leave every file as it is

  // ---- run 1: cold --------------------------------------------------------
  log("selftest run 1 (cold)");
  const cold = await runBenchmark(loaded, { cold: true, log });
  const c = cold.report.variants[0];

  t.that("run 1: no stage errors", Object.keys(c.errors).length === 0, JSON.stringify(c.errors));
  t.that("run 1: run folder is inside the work dir", isUnder(cold.outDir, work), cold.outDir);

  const sourceCount = SOURCE_FILES.length;
  const coverage = c.coverage?.parts.find((p) => p.part === "project");
  t.that(`coverage: ${sourceCount} of ${sourceCount} .cpp files have entries`, coverage?.onDisk === sourceCount && coverage?.withEntries === sourceCount, JSON.stringify(coverage));

  t.that(`check: ${sourceCount + 1} files checked (${sourceCount} .cpp + 1 header outside the DB)`, c.check?.total === sourceCount + 1, `total=${c.check?.total}`);
  t.that("check: every file clean", c.check?.clean === c.check?.total, JSON.stringify(c.check?.files.filter((f) => !f.clean)));
  t.that(
    "check: the .cpp files used their DB entry, the header an inferred command",
    c.check?.inDb.total === sourceCount && c.check?.common.total === sourceCount && c.check?.inferred.total === 1,
    JSON.stringify({ inDb: c.check?.inDb, common: c.check?.common, inferred: c.check?.inferred }),
  );

  const nav = c.nav;
  t.that("nav: started from a fresh index", nav?.freshIndex === true);
  t.that("nav: index finished", nav?.indexComplete === true, nav?.indexNote);
  t.that("nav: index folder exists and is inside the work dir", nav?.indexExists === true && nav?.indexInsideWorkDir === true && isUnder(nav.indexDir, work), nav?.indexDir);
  t.that("nav: index has content on disk", (nav?.indexSizeBytes ?? 0) > 0, `bytes=${nav?.indexSizeBytes}`);
  t.that("nav: progress reported under an index token", (nav?.progressTokens ?? []).some((tok) => /index/i.test(tok)), JSON.stringify(nav?.progressTokens));

  const probe = (id) => nav?.probes.results.find((p) => p.id === id);
  for (const id of ["call-to-cpp-definition", "static-call-in-same-file", "method-to-cpp-definition", "type-to-header"]) {
    t.that(`probe ${id} passes`, probe(id)?.status === "pass", JSON.stringify(probe(id)));
  }
  t.that("probe negative-control FAILS (not errors)", probe("negative-control")?.status === "fail", JSON.stringify(probe("negative-control")));
  t.that("probe aggregation: 4 of 5 pass", nav?.probes.built.pass === 4 && nav?.probes.built.total === 5);
  t.that(
    "probes: 3 need the index (target is another .cpp), 2 do not, none skipped (the index finished)",
    nav?.probes.needsIndex.total === 3 && nav?.probes.independent.total === 2 && nav?.probes.built.skipped === 0 && nav?.symbols.skipped === 0,
    JSON.stringify({ needsIndex: nav?.probes.needsIndex, independent: nav?.probes.independent }),
  );
  t.that("run lock: held for the run, given back at the end", cold.report.run.exclusive === true && !fs.existsSync(lockPathFor(work)), lockPathFor(work));

  for (const symbol of nav?.symbols.results ?? []) {
    t.that(`symbol "${symbol.query}" found in ...${symbol.expectedSuffix}`, symbol.status === "pass", JSON.stringify(symbol));
  }
  t.that("path identity: the metric ran and found no duplicate across roots (the scratch project has one root)", nav?.symbols.pathIdentity.pairs === 0, JSON.stringify(nav?.symbols.pathIdentity));

  assertRelationships(t, nav);
  t.that("rename is a dry run: no file in the project was changed", sameTree(sourcesBefore, readTree(proj)));

  t.that("isolation: no .cache created inside the scratch project", !fs.existsSync(`${proj}/.cache`));
  t.that("isolation: no .cache created beside the original DB", !fs.existsSync(path.posix.join(path.posix.dirname(c.db), ".cache")));

  // ---- run 2: warm --------------------------------------------------------
  log("selftest run 2 (warm)");
  const warm = await runBenchmark(loaded, { only: ["nav"], log });
  const w = warm.report.variants[0].nav;
  t.that("run 2: index was warm (not fresh)", w?.freshIndex === false);
  t.that("run 2: probes still pass", w?.probes.built.pass === 4, JSON.stringify(w?.probes.failures));
  t.that("run 2: relationship probes still pass", w?.relationships.built.pass === 9, JSON.stringify(w?.relationships.failures));
  t.that("run 2: rename still changed no file", sameTree(sourcesBefore, readTree(proj)));

  const failed = t.checks.filter((check) => !check.ok);
  log(failed.length === 0 ? `SELFTEST PASSED (${t.checks.length} checks)` : `SELFTEST FAILED (${failed.length} of ${t.checks.length} checks): ${failed.map((f) => f.name).join("; ")}`);
  return failed.length === 0;
}
