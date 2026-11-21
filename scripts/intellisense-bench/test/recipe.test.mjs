import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_SUBSET_NEIGHBOURS, expectedSuffixes, loadRecipe, normalizeRecipe, parseRecipeText, recipeHash, stripJsonComments } from "../lib/recipe.mjs";
import { runDirFor, timestampForPath } from "../lib/run.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoots = [];
function makeTmp() {
  const root = fs.mkdtempSync(path.join(here, ".tmp-recipe-")).split("\\").join("/");
  tmpRoots.push(root);
  return root;
}
after(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

const baseRecipe = () => ({
  name: "gs_play",
  clangd: "C:\\tools\\clangd.exe",
  workDir: "D:\\ib\\",
  project: "D:/OffLocalDev/gs_play",
  parts: { projectGem: ["D:/OffLocalDev/gs_play/Gem"], project: ["D:/OffLocalDev/gs_play"], engineSdk: ["C:/Engine"] },
  excludeDirs: ["/build/", "3rdParty", "\\Cache\\"],
  variants: [{ name: "A-extension", db: "D:/db/a.json", extraArgs: ["--header-insertion=never"] }, { name: "B", db: "D:/db/b.json" }],
  sample: { perPart: 4, extraFiles: ["D:/x/y.h"] },
  probes: [
    { id: "p1", part: "project", category: "c", file: "D:/OffLocalDev/gs_play/a.cpp", anchor: "Foo(", token: "Foo", expect: { fileSuffix: "A/b.cpp", kind: "definition" } },
    { id: "p2", part: "engineSdk", category: "c", file: "D:/x.cpp", anchor: "Bar(", token: "Bar", expect: { fileSuffix: "A/c.h" }, expectedBuilt: false },
  ],
  symbols: [{ query: "Entity", expectFileSuffix: "AzCore/Component/Entity.h" }],
});

// ============================================================================
//  validation and normalising
// ============================================================================

test("a complete recipe normalises paths, keeps part order, fills defaults", () => {
  const recipe = normalizeRecipe(baseRecipe());
  assert.equal(recipe.workDir, "D:/ib");
  assert.deepEqual(Object.keys(recipe.parts), ["projectGem", "project", "engineSdk"]);
  assert.deepEqual(recipe.excludeDirs, ["/build/", "/3rdParty/", "/Cache/"]);
  assert.deepEqual(recipe.limits, { checkTimeoutSec: 180, checkConcurrency: 3, indexWaitMin: 30, jobs: 4, diagnosticsWaitSec: 60 });
  assert.deepEqual(recipe.variants[1], { name: "B", db: "D:/db/b.json", extraArgs: [] });
  assert.equal(recipe.probes[0].expectedBuilt, true);
  assert.equal(recipe.probes[1].expectedBuilt, false);
  assert.equal(recipe.probes[1].expect.kind, "any");
  assert.equal(recipe.probes[0].occurrence, 0);
});

test("a recipe with only the required fields still loads", () => {
  const recipe = normalizeRecipe({ name: "min", clangd: "clangd", workDir: "D:/ib", project: "D:/p", parts: { project: ["D:/p"] }, variants: [{ name: "v", db: "D:/p/cc.json" }] });
  assert.equal(recipe.sample.perPart, 8);
  assert.deepEqual(recipe.probes, []);
  assert.deepEqual(recipe.symbols, []);
});

test("nav.dbSubset: absent or false is the full DB; true or an object asks for the reduced one", () => {
  assert.deepEqual(normalizeRecipe(baseRecipe()).nav, { dbSubset: null });
  assert.deepEqual(normalizeRecipe({ ...baseRecipe(), nav: { dbSubset: false } }).nav, { dbSubset: null });
  assert.deepEqual(normalizeRecipe({ ...baseRecipe(), nav: { dbSubset: true } }).nav, { dbSubset: { neighbours: DEFAULT_SUBSET_NEIGHBOURS } });
  assert.deepEqual(normalizeRecipe({ ...baseRecipe(), nav: { dbSubset: {} } }).nav, { dbSubset: { neighbours: DEFAULT_SUBSET_NEIGHBOURS } });
  assert.deepEqual(normalizeRecipe({ ...baseRecipe(), nav: { dbSubset: { neighbours: 0 } } }).nav, { dbSubset: { neighbours: 0 } });
  assert.deepEqual(normalizeRecipe({ ...baseRecipe(), nav: { dbSubset: { neighbours: 5 } } }).nav, { dbSubset: { neighbours: 5 } });
});

test("nav.dbSubset: bad values are rejected clearly", () => {
  assert.throws(() => normalizeRecipe({ ...baseRecipe(), nav: { dbSubset: { neighbours: -1 } } }), /nav\.dbSubset\.neighbours/);
  assert.throws(() => normalizeRecipe({ ...baseRecipe(), nav: { dbSubset: { neighbours: 1.5 } } }), /nav\.dbSubset\.neighbours/);
  assert.throws(() => normalizeRecipe({ ...baseRecipe(), nav: { dbSubset: "yes" } }), /"nav\.dbSubset" must be true, false or an object/);
  assert.throws(() => normalizeRecipe({ ...baseRecipe(), nav: { dbSubset: [1] } }), /"nav\.dbSubset" must be/);
});

test("every problem is reported at once", () => {
  const bad = baseRecipe();
  bad.name = "has space";
  bad.workDir = "relative/dir";
  bad.variants.push({ name: "B", db: "D:/db/c.json" }); // duplicate
  bad.variants.push({ name: "C", db: "D:/db/c.json", extraArgs: ["--compile-commands-dir=D:/x"] });
  bad.probes[0].part = "nope";
  bad.probes.push({ ...bad.probes[0], part: "project" }); // duplicate id
  bad.probes[1].expect.kind = "weird";
  bad.limits = { jobs: 0 };

  assert.throws(
    () => normalizeRecipe(bad),
    (err) => {
      for (const fragment of ['"name"', '"workDir" must be an absolute path', 'duplicate variant name "B"', "--compile-commands-dir", 'part "nope"', 'duplicate probe id "p1"', "expect.kind", "limits.jobs"]) {
        assert.ok(err.message.includes(fragment), `message should mention ${fragment}\n${err.message}`);
      }
      return true;
    },
  );
});

test("garbage input is rejected clearly", () => {
  assert.throws(() => parseRecipeText("{ not json"), /not valid JSON/);
  assert.throws(() => normalizeRecipe([]), /must be a JSON object/);
  assert.throws(() => normalizeRecipe({ ...baseRecipe(), parts: {} }), /at least one part/);
});

// ============================================================================
//  comments in recipes
// ============================================================================

test("stripJsonComments removes // and /* */ but not look-alikes inside strings", () => {
  const text = `{
    // a line comment
    "url": "http://example.com/a//b", /* block */
    "note": "has \\" quote // and still a string",
    "n": 1 // trailing
  }`;
  assert.deepEqual(JSON.parse(stripJsonComments(text)), { url: "http://example.com/a//b", note: 'has " quote // and still a string', n: 1 });
});

// ============================================================================
//  hash
// ============================================================================

test("recipeHash: stable, and changes with the recipe text or any variant DB", () => {
  const root = makeTmp();
  fs.writeFileSync(`${root}/a.json`, "[1]");
  fs.writeFileSync(`${root}/b.json`, "[2]");
  const variants = [
    { name: "A", db: `${root}/a.json`, extraArgs: [] },
    { name: "B", db: `${root}/b.json`, extraArgs: [] },
  ];

  const base = recipeHash("recipe text", variants);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(recipeHash("recipe text", variants), base);
  assert.notEqual(recipeHash("recipe text!", variants), base);

  fs.writeFileSync(`${root}/b.json`, "[3]");
  assert.notEqual(recipeHash("recipe text", variants), base);
});

test("recipeHash: a missing DB names the variant", () => {
  assert.throws(() => recipeHash("x", [{ name: "Gone", db: "D:/definitely/not/here.json", extraArgs: [] }]), /Variant "Gone": cannot read compile DB/);
});

test("loadRecipe reads a file end to end (comments allowed)", () => {
  const root = makeTmp();
  fs.writeFileSync(`${root}/cc.json`, "[]");
  const recipe = { name: "t", clangd: "clangd", workDir: `${root}/work`, project: root, parts: { project: [root] }, variants: [{ name: "v", db: `${root}/cc.json` }] };
  fs.writeFileSync(`${root}/recipe.json`, `// leading note\n${JSON.stringify(recipe, null, 2)}\n`);

  const loaded = loadRecipe(`${root}/recipe.json`);
  assert.equal(loaded.recipe.name, "t");
  assert.match(loaded.hash, /^[0-9a-f]{64}$/);
  assert.equal(loaded.file, `${root}/recipe.json`);
});

// ============================================================================
//  probe types
// ============================================================================

/** baseRecipe with one more probe of the given type */
const withProbe = (probe) => ({
  ...baseRecipe(),
  probes: [...baseRecipe().probes, { id: "x", part: "project", category: "c", file: "D:/OffLocalDev/gs_play/a.cpp", anchor: "Foo(", token: "Foo", ...probe }],
});
const probeOf = (probe) => normalizeRecipe(withProbe(probe)).probes.at(-1);

test("a probe without a type is a definition probe, as before", () => {
  const recipe = normalizeRecipe(baseRecipe());
  assert.equal(recipe.probes[0].type, "definition");
  assert.equal(recipe.probes[0].afterToken, false);
  assert.deepEqual(recipe.probes[0].expect, { fileSuffix: "A/b.cpp", kind: "definition" });
});

test("each relationship type normalises its expect", () => {
  assert.deepEqual(probeOf({ type: "references", expect: { mustIncludeFileSuffixes: ["a.cpp"], minFiles: 3 } }).expect, { mustIncludeFileSuffixes: ["a.cpp"], minFiles: 3 });
  assert.deepEqual(probeOf({ type: "references", expect: { minFiles: 2 } }).expect, { mustIncludeFileSuffixes: [], minFiles: 2 });
  assert.deepEqual(probeOf({ type: "references", expect: { mustIncludeFileSuffixes: ["a.cpp"] } }).expect, { mustIncludeFileSuffixes: ["a.cpp"], minFiles: 0 });
  assert.deepEqual(probeOf({ type: "implementation", expect: { mustIncludeFileSuffixes: ["b.cpp", "c.cpp"] } }).expect, { mustIncludeFileSuffixes: ["b.cpp", "c.cpp"] });
  assert.deepEqual(probeOf({ type: "typeHierarchy", expect: { subtypeFileSuffixes: ["d.h"] } }).expect, { subtypeFileSuffixes: ["d.h"] });
  assert.deepEqual(probeOf({ type: "incomingCalls", expect: { mustIncludeFileSuffixes: ["e.cpp"] } }).expect, { mustIncludeFileSuffixes: ["e.cpp"] });
  assert.deepEqual(probeOf({ type: "rename", expect: { minFiles: 4 } }).expect, { mustIncludeFileSuffixes: [], minFiles: 4 });
  assert.deepEqual(probeOf({ type: "rename", expect: { minFiles: 2, mustIncludeFileSuffixes: ["f.h"] } }).expect, { mustIncludeFileSuffixes: ["f.h"], minFiles: 2 });
  assert.deepEqual(probeOf({ type: "codeAction", expect: { titleIncludes: "override" } }).expect, { titleIncludes: "override" });
  assert.deepEqual(probeOf({ type: "completion", afterToken: true, token: "->", expect: { labelsInclude: ["Foo"] } }).expect, { labelsInclude: ["Foo"] });
  assert.equal(probeOf({ type: "completion", afterToken: true, expect: { labelsInclude: ["Foo"] } }).afterToken, true);
  assert.equal(probeOf({ type: "typeHierarchy", expect: { subtypeFileSuffixes: ["d.h"] } }).type, "typeHierarchy");
});

test("probe types: an unknown type and missing expectations are rejected, naming the probe", () => {
  const problems = (probe) => {
    try {
      normalizeRecipe(withProbe(probe));
      return "";
    } catch (err) {
      return err.message;
    }
  };
  assert.match(problems({ type: "hover", expect: { fileSuffix: "a.h" } }), /probe "x": type must be one of definition, references, implementation, typeHierarchy, incomingCalls, rename, codeAction, completion/);
  assert.match(problems({ type: "references", expect: {} }), /needs expect\.mustIncludeFileSuffixes and\/or expect\.minFiles/);
  assert.match(problems({ type: "references", expect: { minFiles: 0 } }), /expect\.minFiles must be an integer >= 1/);
  assert.match(problems({ type: "implementation", expect: { mustIncludeFileSuffixes: [] } }), /expect\.mustIncludeFileSuffixes must be a non-empty array of strings/);
  assert.match(problems({ type: "implementation" }), /expect\.mustIncludeFileSuffixes must be a non-empty array/);
  assert.match(problems({ type: "typeHierarchy", expect: { subtypeFileSuffixes: "a.h" } }), /expect\.subtypeFileSuffixes must be a non-empty array/);
  assert.match(problems({ type: "incomingCalls", expect: { mustIncludeFileSuffixes: [1] } }), /expect\.mustIncludeFileSuffixes must be a non-empty array/);
  assert.match(problems({ type: "rename", expect: {} }), /expect\.minFiles must be an integer >= 1/);
  assert.match(problems({ type: "codeAction", expect: {} }), /expect\.titleIncludes is required/);
  assert.match(problems({ type: "completion", expect: { labelsInclude: [] } }), /expect\.labelsInclude must be a non-empty array/);
  assert.match(problems({ expect: {} }), /expect\.fileSuffix is required/, "a definition probe still needs its fileSuffix");
});

test("afterToken: a boolean, and only for completion probes", () => {
  const message = (probe) => {
    try {
      normalizeRecipe(withProbe(probe));
      return "";
    } catch (err) {
      return err.message;
    }
  };
  assert.match(message({ type: "references", afterToken: true, expect: { minFiles: 1 } }), /afterToken is a boolean, and only for completion probes/);
  assert.match(message({ afterToken: true, expect: { fileSuffix: "a.h" } }), /afterToken is a boolean/);
  assert.match(message({ type: "completion", afterToken: "yes", expect: { labelsInclude: ["a"] } }), /afterToken is a boolean/);
  assert.equal(message({ type: "completion", afterToken: false, expect: { labelsInclude: ["a"] } }), "");
});

test("expectedSuffixes: every file suffix a probe expects, whatever its type", () => {
  assert.deepEqual(expectedSuffixes({ expect: { fileSuffix: "A/b.cpp", kind: "any" } }), ["A/b.cpp"]);
  assert.deepEqual(expectedSuffixes({ expect: { mustIncludeFileSuffixes: ["a.cpp", "b.h"], minFiles: 2 } }), ["a.cpp", "b.h"]);
  assert.deepEqual(expectedSuffixes({ expect: { subtypeFileSuffixes: ["c.h"] } }), ["c.h"]);
  assert.deepEqual(expectedSuffixes({ expect: { titleIncludes: "override" } }), []);
  assert.deepEqual(expectedSuffixes({ expect: { labelsInclude: ["x"] } }), []);
  assert.deepEqual(expectedSuffixes({}), []);
});

// ============================================================================
//  run folder naming
// ============================================================================

test("timestampForPath is sortable and path-safe", () => {
  assert.equal(timestampForPath(new Date("2026-11-21T04:16:12.563Z")), "20261121T041612Z");
});

test("runDirFor: <workDir>/runs/<timestamp>-<recipe>-<variant>, 'all' for several, --out must stay inside workDir", () => {
  const recipe = normalizeRecipe(baseRecipe());
  const at = new Date("2026-11-21T04:16:12Z");
  assert.equal(runDirFor(recipe, ["A-extension"], at), "D:/ib/runs/20261121T041612Z-gs_play-A-extension");
  assert.equal(runDirFor(recipe, ["A-extension", "B"], at), "D:/ib/runs/20261121T041612Z-gs_play-all");
  assert.equal(runDirFor(recipe, ["B"], at, "D:/ib/custom/run1"), "D:/ib/custom/run1");
  assert.throws(() => runDirFor(recipe, ["B"], at, "D:/OffLocalDev/gs_play/out"), /Refusing/);
});
