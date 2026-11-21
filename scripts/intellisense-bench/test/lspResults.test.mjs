import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MIN_TWIN_TAIL_SEGMENTS,
  anyMatchesSuffix,
  capEvidence,
  commonTailSegments,
  distinctPaths,
  emptyEvidence,
  findPathTwins,
  judgeCodeAction,
  judgeCompletion,
  judgeFiles,
  normalizeCodeActions,
  normalizeCompletion,
  normalizeHierarchyItems,
  normalizeIncomingCalls,
  normalizeLocations,
  normalizeSymbols,
  problemEvidence,
  spellingCounts,
  summariseWorkspaceEdit,
} from "../lib/lspResults.mjs";

// Real clangd 22.1.6 responses for the self-test project (see test/fixtures/lsp-responses.json),
// with the scratch folder rewritten to D:/zoo. Note clangd's own habit of spelling one file as
// both D:/zoo/... and d:/zoo/...
const R = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "lsp-responses.json"), "utf8"));

const evidenceOf = (files = [], labels = [], counts = {}) => ({ ...emptyEvidence(), files, labels, counts });

// ============================================================================
//  flattening
// ============================================================================

test("normalizeLocations on a real references answer: one row per location, in order", () => {
  const rows = normalizeLocations(R.referencesClass);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[1], { path: "D:/zoo/include/bird.h", line: 5, character: 24 });
  assert.deepEqual(rows[6], { path: "D:/zoo/src/zoo.cpp", line: 10, character: 24 });
});

test("distinctPaths merges the D:/ and d:/ spellings of one file, keeps first-seen order and spelling", () => {
  const files = distinctPaths(normalizeLocations(R.referencesClass));
  assert.deepEqual(files, ["d:/zoo/include/creature.h", "D:/zoo/include/bird.h", "D:/zoo/include/dog.h", "D:/zoo/src/creature.cpp", "D:/zoo/src/zoo.cpp"]);
});

test("spellingCounts: empty unless a file came back under two spellings", () => {
  assert.deepEqual(spellingCounts(normalizeLocations(R.referencesVirtualCall)), {});
  assert.deepEqual(spellingCounts(normalizeLocations(R.referencesClass)), { uris: 6 }, "creature.h as d:/ and D:/, plus 4 other files");
  assert.deepEqual(spellingCounts([]), {});
});

test("normalizeLocations on the implementation answer", () => {
  assert.deepEqual(normalizeLocations(R.implementationPureVirtual).map((r) => r.path), ["D:/zoo/src/bird.cpp", "D:/zoo/src/dog.cpp"]);
});

test("normalizeHierarchyItems: the prepare answer and the subtypes answers", () => {
  assert.deepEqual(normalizeHierarchyItems(R.prepareTypeHierarchy), [{ name: "Creature", path: "d:/zoo/include/creature.h", line: 4 }]);
  assert.deepEqual(normalizeHierarchyItems(R.subtypesOfCreature).map((r) => [r.name, r.path]), [
    ["Dog", "D:/zoo/include/dog.h"],
    ["Bird", "D:/zoo/include/bird.h"],
    ["Lazy", "D:/zoo/src/zoo.cpp"],
  ]);
  assert.deepEqual(normalizeHierarchyItems(R.subtypesOfBird), []);
  assert.deepEqual(normalizeHierarchyItems(null), []);
  assert.deepEqual(normalizeHierarchyItems([{ name: "x", uri: "untitled:x" }, null]), [], "non-file items are dropped");
});

test("normalizeIncomingCalls: one row per caller with its number of call sites", () => {
  assert.deepEqual(normalizeIncomingCalls(R.incomingCallsOfArea), [{ name: "main", path: "d:/zoo/src/main.cpp", line: 2, calls: 1 }]);
  assert.deepEqual(normalizeIncomingCalls(null), []);
  assert.deepEqual(normalizeIncomingCalls([{ from: null, fromRanges: [] }]), []);
});

test("summariseWorkspaceEdit on a real rename answer: edits, distinct files, and the spellings", () => {
  const edit = summariseWorkspaceEdit(R.renameArea);
  assert.equal(edit.edits, 4, "main.cpp is named twice, once as D:/ and once as d:/");
  assert.deepEqual(edit.files, ["D:/zoo/include/shape.h", "D:/zoo/src/main.cpp", "d:/zoo/src/shape.cpp"]);
  assert.deepEqual(spellingCounts(edit.spellings), { uris: 4 });
});

test("summariseWorkspaceEdit: the documentChanges shape, file operations ignored, nothing to change", () => {
  const edit = summariseWorkspaceEdit({
    documentChanges: [
      { textDocument: { uri: "file:///d%3A/p/a.cpp", version: 1 }, edits: [{ newText: "x", range: {} }, { newText: "x", range: {} }] },
      { kind: "rename", oldUri: "file:///d%3A/p/b.cpp", newUri: "file:///d%3A/p/c.cpp" },
      { textDocument: { uri: "file:///d%3A/p/d.h" }, edits: [{ newText: "x", range: {} }] },
    ],
  });
  assert.deepEqual([edit.edits, edit.files], [3, ["d:/p/a.cpp", "d:/p/d.h"]]);

  for (const nothing of [null, {}, { changes: {} }]) assert.deepEqual([summariseWorkspaceEdit(nothing).edits, summariseWorkspaceEdit(nothing).files], [0, []]);
});

test("normalizeCodeActions: titles and kinds of CodeAction and Command items", () => {
  assert.deepEqual(normalizeCodeActions(R.codeActionLazy), [
    { title: "Override pure virtual methods", kind: "quickfix" },
    { title: "Declare implicit copy/move members", kind: "refactor" },
  ]);
  assert.deepEqual(normalizeCodeActions([{ title: "Run", command: "x.run" }, { nope: 1 }]), [{ title: "Run", kind: "" }]);
  assert.deepEqual(normalizeCodeActions(null), []);
});

test("normalizeCompletion: name is the filterText; decorated labels fall back to the bare identifier", () => {
  const dot = normalizeCompletion(R.completionAfterDot);
  assert.deepEqual(dot, [{ label: " Size() const", name: "Size", kind: 2 }]);

  assert.deepEqual(normalizeCompletion(R.completionAfterScope).map((i) => i.name), ["Widget", "Area", "Creature", "Bird", "Dog", "Puppy", "Widget", "Widget", "Widget"]);

  // no filterText: strip the leading space or bullet and the signature
  const bare = normalizeCompletion([{ label: " Size() const" }, { label: "\u2022Dog" }, { label: " ~Widget()" }, { label: "plain" }, { filterText: "x" }]);
  assert.deepEqual(bare.map((i) => i.name), ["Size", "Dog", "~Widget", "plain"]);
  assert.deepEqual(normalizeCompletion(null), []);
  assert.deepEqual(normalizeCompletion([]), []);
});

test("normalizeSymbols and anyMatchesSuffix are still exported from here", () => {
  const rows = normalizeSymbols([{ name: "Entity", containerName: "AZ", location: { uri: "file:///d%3A/x/AzCore/Entity.h", range: { start: { line: 3, character: 0 } } } }]);
  assert.deepEqual(rows, [{ name: "Entity", path: "d:/x/AzCore/Entity.h", line: 3, container: "AZ" }]);
  assert.equal(anyMatchesSuffix(rows, "AzCore/Entity.h"), true);
});

// ============================================================================
//  evidence
// ============================================================================

test("problemEvidence carries the problem and nothing else; capEvidence cuts the lists, not the counts", () => {
  assert.deepEqual(problemEvidence("clangd said no"), { problem: "clangd said no", files: [], labels: [], counts: {} });
  const many = evidenceOf(Array.from({ length: 80 }, (_, i) => `d:/f${i}.cpp`), Array.from({ length: 60 }, (_, i) => `n${i}`), { files: 80 });
  const capped = capEvidence(many, 50);
  assert.deepEqual([capped.files.length, capped.labels.length, capped.counts.files], [50, 50, 80]);
});

// ============================================================================
//  judges: references / implementation / type hierarchy / incoming calls / rename share judgeFiles
// ============================================================================

test("judgeFiles: every required suffix must be present (a path-segment match, any case)", () => {
  const evidence = evidenceOf(distinctPaths(normalizeLocations(R.referencesClass)));
  assert.deepEqual(judgeFiles(evidence, { mustIncludeFileSuffixes: ["include/dog.h", "SRC/zoo.cpp"] }), { pass: true, reason: "" });
  assert.deepEqual(judgeFiles(evidence, { mustIncludeFileSuffixes: ["include/dog.h", "src/missing.cpp", "src/other.cpp"] }), { pass: false, reason: "missing ...src/missing.cpp, ...src/other.cpp" });
  assert.equal(judgeFiles(evidence, { mustIncludeFileSuffixes: ["g.h"] }).pass, false, "a suffix must start on a path segment: g.h is not dog.h");
});

test("judgeFiles: minFiles counts distinct files, so one file under two spellings is one file", () => {
  const evidence = evidenceOf(distinctPaths(normalizeLocations(R.referencesClass))); // 7 locations, 5 files
  assert.equal(judgeFiles(evidence, { minFiles: 5 }).pass, true);
  assert.deepEqual(judgeFiles(evidence, { minFiles: 6 }), { pass: false, reason: "5 file(s), expected at least 6" });
  assert.deepEqual(judgeFiles(evidence, { mustIncludeFileSuffixes: ["src/nope.cpp"], minFiles: 6 }), { pass: false, reason: "missing ...src/nope.cpp; 5 file(s), expected at least 6" });
});

test("judgeFiles: no files is 'no result'; a problem is reported as it is", () => {
  assert.deepEqual(judgeFiles(emptyEvidence(), { mustIncludeFileSuffixes: ["a.cpp"] }), { pass: false, reason: "no result" });
  assert.deepEqual(judgeFiles(problemEvidence("clangd refused rename: nope"), { minFiles: 1 }), { pass: false, reason: "clangd refused rename: nope" });
});

test("references fixtures: the virtual call is only in zoo.cpp; the class is used in five files", () => {
  const call = evidenceOf(distinctPaths(normalizeLocations(R.referencesVirtualCall)));
  assert.equal(judgeFiles(call, { mustIncludeFileSuffixes: ["src/zoo.cpp"] }).pass, true);
  assert.equal(judgeFiles(call, { mustIncludeFileSuffixes: ["src/bird.cpp"] }).pass, false);
  assert.equal(judgeFiles(call, { minFiles: 2 }).pass, false);
});

test("implementation fixture: the overriding definitions in dog.cpp and bird.cpp", () => {
  const evidence = evidenceOf(distinctPaths(normalizeLocations(R.implementationPureVirtual)));
  assert.equal(judgeFiles(evidence, { mustIncludeFileSuffixes: ["src/dog.cpp", "src/bird.cpp"] }).pass, true);
  assert.equal(judgeFiles(evidence, { mustIncludeFileSuffixes: ["src/creature.cpp"] }).pass, false);
});

test("type hierarchy fixtures: level 1 alone misses Puppy, both levels have it", () => {
  const level1 = normalizeHierarchyItems(R.subtypesOfCreature);
  const level2 = normalizeHierarchyItems(R.subtypesOfDog);
  const expect = { mustIncludeFileSuffixes: ["include/dog.h", "include/bird.h", "src/zoo.cpp", "include/puppy.h"] };
  assert.equal(judgeFiles(evidenceOf(distinctPaths(level1)), expect).pass, false);
  assert.equal(judgeFiles(evidenceOf(distinctPaths([...level1, ...level2])), expect).pass, true);
});

test("incoming calls fixture: the caller's file", () => {
  const evidence = evidenceOf(distinctPaths(normalizeIncomingCalls(R.incomingCallsOfArea)));
  assert.equal(judgeFiles(evidence, { mustIncludeFileSuffixes: ["src/main.cpp"] }).pass, true);
  assert.equal(judgeFiles(evidence, { mustIncludeFileSuffixes: ["src/zoo.cpp"] }).pass, false);
});

test("rename fixture: 3 distinct files (4 edits) pass minFiles 3 and fail minFiles 4", () => {
  const edit = summariseWorkspaceEdit(R.renameArea);
  const evidence = evidenceOf(edit.files, [], { edits: edit.edits, files: edit.files.length });
  assert.equal(judgeFiles(evidence, { minFiles: 3, mustIncludeFileSuffixes: ["include/shape.h", "src/shape.cpp", "src/main.cpp"] }).pass, true);
  assert.deepEqual(judgeFiles(evidence, { minFiles: 4 }), { pass: false, reason: "3 file(s), expected at least 4" });
});

// ============================================================================
//  judges: code action and completion
// ============================================================================

test("judgeCodeAction: a title contains the text, case-insensitively", () => {
  const evidence = evidenceOf([], normalizeCodeActions(R.codeActionLazy).map((a) => a.title));
  assert.equal(judgeCodeAction(evidence, { titleIncludes: "override pure virtual" }).pass, true);
  assert.equal(judgeCodeAction(evidence, { titleIncludes: "COPY/MOVE" }).pass, true);
  assert.deepEqual(judgeCodeAction(evidence, { titleIncludes: "extract" }), { pass: false, reason: 'no action title contains "extract"' });
});

test("judgeCodeAction: nothing offered, and a refusal", () => {
  assert.deepEqual(judgeCodeAction(evidenceOf([], normalizeCodeActions(R.codeActionNone).map((a) => a.title)), { titleIncludes: "x" }), { pass: false, reason: "no code actions offered" });
  assert.deepEqual(judgeCodeAction(problemEvidence("clangd refused"), { titleIncludes: "x" }), { pass: false, reason: "clangd refused" });
});

test("judgeCompletion: every wanted name must be among the items (exact match)", () => {
  const names = (result) => [...new Set(normalizeCompletion(result).map((i) => i.name))];
  const scope = evidenceOf([], names(R.completionAfterScope));
  assert.equal(judgeCompletion(scope, { labelsInclude: ["Area", "Widget"] }).pass, true);
  assert.equal(judgeCompletion(scope, { labelsInclude: ["Dog"] }).pass, true, "clangd offers headers it would add an include for");
  assert.deepEqual(judgeCompletion(scope, { labelsInclude: ["Area", "area", "Nope"] }), { pass: false, reason: "missing area, Nope" });

  const dot = evidenceOf([], names(R.completionAfterDot));
  assert.equal(judgeCompletion(dot, { labelsInclude: ["Size"] }).pass, true);
  assert.equal(judgeCompletion(dot, { labelsInclude: ["Area"] }).pass, false);
});

test("judgeCompletion: no items, and a refusal", () => {
  assert.deepEqual(judgeCompletion(emptyEvidence(), { labelsInclude: ["a"] }), { pass: false, reason: "no completion items" });
  assert.deepEqual(judgeCompletion(problemEvidence("clangd refused"), { labelsInclude: ["a"] }), { pass: false, reason: "clangd refused" });
});

// ============================================================================
//  path identity
// ============================================================================

const symbol = (name, container, file) => ({ name, container, path: file });
const SDK = "C:/Users/gaian/.o3de/Engines/GS_Play_Engine/Code/Framework/AzCore/AzCore/Component/Entity.h";
const SURROGATE = "d:/OffLocalDev/o3de_sourcedev/Code/Framework/AzCore/AzCore/Component/Entity.h";

test("commonTailSegments: trailing segments in common, case and slash insensitive", () => {
  assert.equal(commonTailSegments(SDK, SURROGATE), 6, "Code/Framework/AzCore/AzCore/Component/Entity.h");
  assert.equal(commonTailSegments("D:\\a\\Inc\\Foo.h", "e:/b/INC/foo.h"), 2);
  assert.equal(commonTailSegments("D:/a/Foo.h", "D:/a/Bar.h"), 0);
  assert.equal(commonTailSegments("D:/a/Foo.h", "D:/a/Foo.h"), 3, "the same path: every segment (the caller skips identical files)");
});

test("findPathTwins: the SDK copy and the surrogate copy of one header are a twin pair", () => {
  const twins = findPathTwins([symbol("Entity", "AZ", SDK), symbol("Entity", "AZ", SURROGATE), symbol("Component", "AZ", SDK)]);
  assert.deepEqual(twins, [{ name: "Entity", container: "AZ", a: SDK, b: SURROGATE, tail: 6 }]);
});

test("findPathTwins: not twins when the symbol differs, the file is one, or the tail is short", () => {
  assert.deepEqual(findPathTwins([symbol("Entity", "AZ", SDK), symbol("EntityId", "AZ", SURROGATE)]), [], "different names");
  assert.deepEqual(findPathTwins([symbol("Entity", "AZ", SDK), symbol("Entity", "Other", SURROGATE)]), [], "different containers");
  assert.deepEqual(findPathTwins([symbol("Entity", "AZ", SDK), symbol("Entity", "AZ", SDK.replace("C:/", "c:/"))]), [], "one file, spelled two ways");
  assert.deepEqual(findPathTwins([symbol("Entity", "AZ", "D:/a/Code/Entity.h"), symbol("Entity", "AZ", "D:/b/Code/Entity.h")]), [], "two segments only");
  assert.deepEqual(findPathTwins([symbol("Entity", "AZ", "D:/a/Include/Code/Entity.h"), symbol("Entity", "AZ", "D:/b/Include/Code/Entity.h")]).length, 1, "three segments is enough");
  assert.equal(MIN_TWIN_TAIL_SEGMENTS, 3);
  assert.deepEqual(findPathTwins([]), []);
});

test("findPathTwins: three copies make three pairs", () => {
  const rows = ["D:/a/x/y/Foo.h", "D:/b/x/y/Foo.h", "D:/c/x/y/Foo.h"].map((file) => symbol("Foo", "", file));
  assert.equal(findPathTwins(rows).length, 3);
});
