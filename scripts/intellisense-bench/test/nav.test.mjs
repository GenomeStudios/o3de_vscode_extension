import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  IndexProgress,
  OWN_ENTRY,
  ProbeError,
  SKIPPED_INDEX_INCOMPLETE,
  anyMatchesSuffix,
  assertInside,
  coldReset,
  dirSize,
  findProbePosition,
  indexDirOf,
  locateProbe,
  normalizeLocations,
  normalizeSymbols,
  prepareNavSubset,
  prepareVariant,
  probeNeedsIndex,
  skippedProbe,
  skippedSymbol,
  variantDir,
  waitForIndex,
} from "../lib/nav.mjs";
import { pathKey, pathToUri } from "../lib/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoots = [];
function makeTmp() {
  const root = fs.mkdtempSync(path.join(here, ".tmp-nav-")).split("\\").join("/");
  tmpRoots.push(root);
  return root;
}
after(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

// ============================================================================
//  probe position (anchor + token)
// ============================================================================

test("findProbePosition: line from the anchor, column from the token", () => {
  const text = "int a;\nreturn Foo::Bar(1);\nint b;\n";
  assert.deepEqual(findProbePosition(text, "return Foo::Bar(1);", "Bar"), { line: 1, character: 12, lineText: "return Foo::Bar(1);" });
});

test("findProbePosition: whole words only, and 'occurrence' picks the nth match", () => {
  const text = "x = AreaOf(Area) + Area;\n";
  assert.equal(findProbePosition(text, "x = AreaOf", "Area").character, 11); // not the "Area" inside AreaOf
  assert.equal(findProbePosition(text, "x = AreaOf", "Area", 1).character, 19);
});

test("findProbePosition: CRLF files count lines correctly", () => {
  const text = "line0\r\nline1\r\n  call(Target);\r\nline3\r\n";
  assert.deepEqual(findProbePosition(text, "call(Target)", "Target"), { line: 2, character: 7, lineText: "  call(Target);" });
});

test("findProbePosition: columns are UTF-16 code units (an emoji counts as 2)", () => {
  const text = 'auto s = "\ud83d\ude00"; Foo(x);\n';
  const { character } = findProbePosition(text, "Foo(x)", "Foo");
  assert.equal(character, text.indexOf("Foo")); // JS string indices ARE UTF-16 units
  assert.equal(character, 'auto s = "'.length + 2 + '"; '.length);
});

test("findProbePosition: a punctuation token ('->', '::', '.') matches as it is, even touching identifiers", () => {
  const line = "return health->IsFull() && ns::Fn(w.Size());";
  const text = `int a;\n${line}\n`;
  const anchor = "return health->IsFull()";
  assert.equal(findProbePosition(text, anchor, "->").character, line.indexOf("->"));
  assert.equal(findProbePosition(text, anchor, "::").character, line.indexOf("::"));
  assert.equal(findProbePosition(text, anchor, ".").character, line.indexOf("."));
  assert.equal(findProbePosition(text, anchor, "&&").character, line.indexOf("&&"));
  assert.throws(() => findProbePosition(text, anchor, "<<"), /token "<<" .* not found/);
  // an identifier token still needs word boundaries
  assert.equal(findProbePosition(text, anchor, "Fn").character, line.indexOf("Fn"));
  assert.throws(() => findProbePosition(text, anchor, "Fu"), /not found/);
});

test("locateProbe: the token start, or just after the token with afterToken", () => {
  const text = "x = widget->Size();\n";
  const probe = { anchor: "x = widget->Size()", token: "->", occurrence: 0, afterToken: false };
  assert.deepEqual(locateProbe(text, probe), { line: 0, character: 10, lineText: "x = widget->Size();" });
  assert.deepEqual(locateProbe(text, { ...probe, afterToken: true }), { line: 0, character: 12, lineText: "x = widget->Size();" });
  assert.equal(locateProbe(text, { anchor: "x = widget", token: "widget" }).character, 4, "a probe from an older recipe has no afterToken");
});

test("findProbePosition: failures carry a machine-readable code", () => {
  const text = "a();\nb();\nb();\n";
  const code = (fn) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof ProbeError);
      return err.code;
    }
    return "no error";
  };
  assert.equal(code(() => findProbePosition(text, "zzz", "a")), "anchor-not-found");
  assert.equal(code(() => findProbePosition(text, "b();", "b")), "anchor-not-unique");
  assert.equal(code(() => findProbePosition(text, "a();", "missing")), "token-not-found");
  assert.equal(code(() => findProbePosition(text, "a();", "a", 3)), "token-not-found");
});

// ============================================================================
//  definition / symbol normalisation and matching
// ============================================================================

const range = (line, character = 0) => ({ start: { line, character }, end: { line, character: character + 3 } });

test("normalizeLocations: null, Location, Location[], LocationLink[]", () => {
  assert.deepEqual(normalizeLocations(null), []);
  assert.deepEqual(normalizeLocations([]), []);

  assert.deepEqual(normalizeLocations({ uri: "file:///d%3A/a/b.cpp", range: range(4, 2) }), [{ path: "d:/a/b.cpp", line: 4, character: 2 }]);

  assert.deepEqual(
    normalizeLocations([
      { uri: "file:///d%3A/a/b.cpp", range: range(1) },
      { uri: "file:///d%3A/a/c.h", range: range(9, 5) },
    ]),
    [
      { path: "d:/a/b.cpp", line: 1, character: 0 },
      { path: "d:/a/c.h", line: 9, character: 5 },
    ],
  );

  // LocationLink prefers targetSelectionRange (the name) over targetRange (the whole declaration)
  assert.deepEqual(
    normalizeLocations([{ targetUri: "file:///d%3A/a/d.cpp", targetRange: range(10), targetSelectionRange: range(12, 7), originSelectionRange: range(0) }]),
    [{ path: "d:/a/d.cpp", line: 12, character: 7 }],
  );
});

test("normalizeLocations drops non-file URIs and malformed items", () => {
  assert.deepEqual(normalizeLocations([{ uri: "untitled:x", range: range(0) }, { range: range(0) }, null]), []);
});

test("normalizeSymbols: SymbolInformation and WorkspaceSymbol without a range", () => {
  const rows = normalizeSymbols([
    { name: "Entity", kind: 5, containerName: "AZ", location: { uri: "file:///d%3A/x/Entity.h", range: range(33) } },
    { name: "Bare", kind: 12, location: { uri: "file:///d%3A/x/Bare.h" } },
    { name: "Broken" },
  ]);
  assert.deepEqual(rows, [
    { name: "Entity", path: "d:/x/Entity.h", line: 33, container: "AZ" },
    { name: "Bare", path: "d:/x/Bare.h", line: 0, container: "" },
  ]);
  assert.deepEqual(normalizeSymbols(null), []);
});

test("anyMatchesSuffix: pass when ANY result ends with the suffix (case and slash insensitive)", () => {
  const rows = [{ path: "d:/o3de/Code/Framework/AzCore/AzCore/Component/Entity.h" }, { path: "d:/o3de/Code/Framework/AzCore/AzCore/Component/Entity.cpp" }];
  assert.equal(anyMatchesSuffix(rows, "AzCore/Component/Entity.cpp"), true);
  assert.equal(anyMatchesSuffix(rows, "azcore\\component\\entity.CPP"), true);
  assert.equal(anyMatchesSuffix(rows, "AzCore/Component/Other.cpp"), false);
  assert.equal(anyMatchesSuffix([], "x.cpp"), false);
  assert.equal(anyMatchesSuffix([{ path: "d:/a/XEntity.cpp" }], "Entity.cpp"), false);
});

// ============================================================================
//  probes that need the background index
// ============================================================================

const aProbe = (file, fileSuffix, extra = {}) => ({
  id: "p",
  part: "workspaceGems",
  category: "c",
  file,
  anchor: "a",
  token: "t",
  occurrence: 0,
  expect: { fileSuffix, kind: "definition" },
  expectedBuilt: true,
  ...extra,
});

test("probeNeedsIndex: true only when the target is a source file other than the probe's own", () => {
  // F12 in a .cpp onto a function defined in ANOTHER .cpp: only the index knows
  assert.equal(probeNeedsIndex(aProbe("D:/g/Code/Source/A.cpp", "Code/Source/B.cpp")), true);
  // from a header onto its .cpp definition: the same
  assert.equal(probeNeedsIndex(aProbe("D:/g/Code/Include/A.h", "Code/Source/A.cpp")), true);
  for (const ext of [".cxx", ".cc", ".CPP"]) assert.equal(probeNeedsIndex(aProbe("D:/g/a.h", `x/B${ext}`)), true, ext);

  // the target is the probe's own file: the AST has it
  assert.equal(probeNeedsIndex(aProbe("D:/g/Code/Source/A.cpp", "Code/Source/A.cpp")), false);
  assert.equal(probeNeedsIndex(aProbe("d:\\G\\Code\\SOURCE\\a.cpp", "code/source/A.cpp")), false);
  // a header target is reached through the includes
  assert.equal(probeNeedsIndex(aProbe("D:/g/Code/Source/A.cpp", "Code/Include/A.h")), false);
});

test("probeNeedsIndex: every relationship type needs the index, whatever file it expects", () => {
  const relation = (type, expect) => ({ ...aProbe("D:/g/Code/Source/A.cpp", "Code/Include/A.h"), type, expect });
  assert.equal(probeNeedsIndex(relation("references", { mustIncludeFileSuffixes: ["Code/Include/A.h"] })), true);
  assert.equal(probeNeedsIndex(relation("implementation", { mustIncludeFileSuffixes: ["Code/Source/A.cpp"] })), true, "even the probe's own file");
  assert.equal(probeNeedsIndex(relation("typeHierarchy", { subtypeFileSuffixes: ["x.h"] })), true);
  assert.equal(probeNeedsIndex(relation("incomingCalls", { mustIncludeFileSuffixes: ["x.h"] })), true);
  assert.equal(probeNeedsIndex(relation("rename", { minFiles: 2 })), true);
  assert.equal(probeNeedsIndex(relation("codeAction", { titleIncludes: "override" })), true);
  assert.equal(probeNeedsIndex(relation("completion", { labelsInclude: ["Size"] })), true);
  assert.equal(probeNeedsIndex({ ...aProbe("D:/g/a.h", "Code/Include/A.h"), type: "definition" }), false, "an explicit definition type behaves as before");
});

test("skippedProbe and skippedSymbol: a blank result marked skipped, with the reason and no outcome", () => {
  const probe = aProbe("D:/g/Code/Source/A.cpp", "Code/Source/B.cpp", { id: "cross-cpp", expectedBuilt: false });
  const skipped = skippedProbe(probe);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.reason, SKIPPED_INDEX_INCOMPLETE);
  assert.equal(skipped.needsIndex, true);
  assert.equal(skipped.id, "cross-cpp");
  assert.equal(skipped.type, "definition");
  assert.equal(skipped.expected, "definition in ...Code/Source/B.cpp");
  assert.equal(skipped.returned, null);
  assert.equal(skipped.expectedBuilt, false);
  assert.deepEqual(skipped.targets, []);
  assert.equal(skipped.line, null);
  assert.deepEqual(skipped.flags, OWN_ENTRY, "a probe is assumed to have an entry of its own until runNav says otherwise");

  const symbol = skippedSymbol({ query: "AZ::Entity", expectFileSuffix: "AzCore/Component/Entity.h" });
  assert.deepEqual(symbol, { query: "AZ::Entity", expectedSuffix: "AzCore/Component/Entity.h", status: "skipped", reason: "skipped: index incomplete", resultCount: 0, top: [], twinCount: 0, twins: [], ms: 0 });
});

test("skippedProbe for a relationship probe says what it expected and has no F12 fields set", () => {
  const probe = { ...aProbe("D:/g/Code/Source/A.cpp", ""), id: "refs", type: "references", expect: { mustIncludeFileSuffixes: ["Code/Source/B.cpp"], minFiles: 2 } };
  const skipped = skippedProbe(probe);
  assert.equal(skipped.type, "references");
  assert.equal(skipped.expected, "includes ...Code/Source/B.cpp; at least 2 files");
  assert.equal(skipped.expectedSuffix, "");
  assert.equal(skipped.kind, "");
  assert.equal(skipped.needsIndex, true);
  assert.equal(skipped.status, "skipped");
});

// ============================================================================
//  isolation helpers
// ============================================================================

test("assertInside refuses the parent itself, siblings and outsiders", () => {
  assert.doesNotThrow(() => assertInside("D:/ib", "D:/ib/variants/a"));
  assert.throws(() => assertInside("D:/ib", "D:/ib"), /Refusing/);
  assert.throws(() => assertInside("D:/ib", "D:/ib2/x"), /Refusing/);
  assert.throws(() => assertInside("D:/ib", "D:/OffLocalDev/gs_play/.cache"), /Refusing/);
});

test("variantDir and indexDirOf follow the documented layout", () => {
  assert.equal(variantDir("D:/ib", "A-extension"), "D:/ib/variants/A-extension");
  assert.equal(indexDirOf("D:/ib/variants/A-extension"), "D:/ib/variants/A-extension/.cache/clangd/index");
  assert.throws(() => variantDir("D:/ib", "../../escape"), /Refusing/);
});

test("prepareVariant copies the DB once and leaves an identical copy untouched", () => {
  const root = makeTmp();
  const work = `${root}/work`;
  fs.mkdirSync(work);
  fs.writeFileSync(`${root}/original.json`, '[{"file":"a.cpp"}]');

  const dir = prepareVariant(work, { name: "v", db: `${root}/original.json` });
  assert.equal(dir, `${work}/variants/v`);
  assert.equal(fs.readFileSync(`${dir}/compile_commands.json`, "utf8"), '[{"file":"a.cpp"}]');

  const firstStamp = fs.statSync(`${dir}/compile_commands.json`).mtimeMs;
  prepareVariant(work, { name: "v", db: `${root}/original.json` });
  assert.equal(fs.statSync(`${dir}/compile_commands.json`).mtimeMs, firstStamp, "an identical copy is not rewritten");

  fs.writeFileSync(`${root}/original.json`, '[{"file":"b.cpp"}]');
  prepareVariant(work, { name: "v", db: `${root}/original.json` });
  assert.equal(fs.readFileSync(`${dir}/compile_commands.json`, "utf8"), '[{"file":"b.cpp"}]');
  assert.equal(fs.readFileSync(`${root}/original.json`, "utf8"), '[{"file":"b.cpp"}]', "the original is never modified");
});

test("prepareNavSubset writes the reduced DB beside, not over, the full copy; an identical subset is not rewritten", () => {
  const root = makeTmp();
  const work = `${root}/work`;
  fs.mkdirSync(work);
  fs.writeFileSync(`${root}/original.json`, '[{"file":"a.cpp"},{"file":"b.cpp"}]');
  const fullDir = prepareVariant(work, { name: "v", db: `${root}/original.json` });

  const subsetDir = prepareNavSubset(work, { name: "v" }, [{ file: "a.cpp" }]);
  assert.equal(subsetDir, `${work}/variants/v/nav-subset`);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${subsetDir}/compile_commands.json`, "utf8")), [{ file: "a.cpp" }]);
  assert.equal(fs.readFileSync(`${fullDir}/compile_commands.json`, "utf8"), '[{"file":"a.cpp"},{"file":"b.cpp"}]', "the check stage's full copy is untouched");

  const stamp = fs.statSync(`${subsetDir}/compile_commands.json`).mtimeMs;
  prepareNavSubset(work, { name: "v" }, [{ file: "a.cpp" }]);
  assert.equal(fs.statSync(`${subsetDir}/compile_commands.json`).mtimeMs, stamp, "an identical subset is not rewritten, so a warm index survives");

  prepareNavSubset(work, { name: "v" }, [{ file: "a.cpp" }, { file: "b.cpp" }]);
  assert.equal(JSON.parse(fs.readFileSync(`${subsetDir}/compile_commands.json`, "utf8")).length, 2);
  assert.throws(() => prepareNavSubset(work, { name: "../../escape" }, []), /Refusing/);
});

test("coldReset also clears the subset folder's own .cache and nothing else", () => {
  const root = makeTmp();
  const work = `${root}/work`;
  const subsetDir = `${work}/variants/v/nav-subset`;
  fs.mkdirSync(`${subsetDir}/.cache/clangd/index`, { recursive: true });
  fs.mkdirSync(`${work}/variants/v/.cache`, { recursive: true });
  fs.writeFileSync(`${subsetDir}/compile_commands.json`, "[]");

  coldReset(work, subsetDir);

  assert.equal(fs.existsSync(`${subsetDir}/.cache`), false);
  assert.equal(fs.existsSync(`${subsetDir}/compile_commands.json`), true);
  assert.equal(fs.existsSync(`${work}/variants/v/.cache`), true, "the full DB's index is a different folder");
});

test("coldReset deletes ONLY <variantDir>/.cache", () => {
  const root = makeTmp();
  const work = `${root}/work`;
  const dir = `${work}/variants/v`;
  fs.mkdirSync(`${dir}/.cache/clangd/index`, { recursive: true });
  fs.writeFileSync(`${dir}/.cache/clangd/index/a.idx`, "idx");
  fs.writeFileSync(`${dir}/compile_commands.json`, "[]");
  fs.mkdirSync(`${work}/runs/old`, { recursive: true });
  fs.writeFileSync(`${work}/runs/old/report.md`, "keep");

  coldReset(work, dir);

  assert.equal(fs.existsSync(`${dir}/.cache`), false);
  assert.equal(fs.existsSync(`${dir}/compile_commands.json`), true);
  assert.equal(fs.existsSync(`${work}/runs/old/report.md`), true);
  coldReset(work, dir); // already gone: still fine
});

test("coldReset refuses a variant folder outside the work dir", () => {
  const root = makeTmp();
  const outsider = `${root}/not-in-work/variants/v`;
  fs.mkdirSync(`${outsider}/.cache`, { recursive: true });
  assert.throws(() => coldReset(`${root}/work`, outsider), /Refusing/);
  assert.equal(fs.existsSync(`${outsider}/.cache`), true);
});

test("dirSize sums nested files and tolerates a missing folder", () => {
  const root = makeTmp();
  fs.mkdirSync(`${root}/a/b`, { recursive: true });
  fs.writeFileSync(`${root}/a/one.bin`, Buffer.alloc(100));
  fs.writeFileSync(`${root}/a/b/two.bin`, Buffer.alloc(23));
  assert.equal(dirSize(`${root}/a`), 123);
  assert.equal(dirSize(`${root}/missing`), 0);
});

// ============================================================================
//  index progress and waiting
// ============================================================================

const stubClient = { exited: false, stderrTail: "", exitCode: null };
const progressMessage = (kind, extra = {}) => ({ token: "backgroundIndexProgress", value: { kind, ...extra } });

test("IndexProgress follows begin / report / end for the index token only", () => {
  const progress = new IndexProgress();
  progress.onProgress({ token: "somethingElse", value: { kind: "begin" } });
  assert.equal(progress.sawBegin, false);

  progress.onProgress(progressMessage("begin"));
  assert.equal(progress.active, true);
  progress.onProgress(progressMessage("report", { message: "5/10", percentage: 50 }));
  assert.equal(progress.lastMessage, "5/10 50%");
  progress.onProgress(progressMessage("end"));
  assert.equal(progress.active, false);
  assert.ok(progress.endedAt > 0);
  assert.deepEqual([...progress.tokens].sort(), ["backgroundIndexProgress", "somethingElse"]);
});

test("waitForIndex: complete after end + quiet, with the time to the end event", async () => {
  const progress = new IndexProgress();
  setTimeout(() => progress.onProgress(progressMessage("begin")), 20);
  setTimeout(() => progress.onProgress(progressMessage("end")), 120);
  const result = await waitForIndex(progress, stubClient, { capMs: 5000, settleMs: 100, pollMs: 10 });
  assert.equal(result.complete, true);
  assert.ok(result.ms >= 100 && result.ms < 1000, `ms=${result.ms}`);
});

test("waitForIndex: a new begin during the quiet period keeps waiting", async () => {
  const progress = new IndexProgress();
  progress.onProgress(progressMessage("begin"));
  progress.onProgress(progressMessage("end"));
  setTimeout(() => progress.onProgress(progressMessage("begin")), 50); // restarts inside the 200 ms settle window
  setTimeout(() => progress.onProgress(progressMessage("end")), 400);
  const started = Date.now();
  const result = await waitForIndex(progress, stubClient, { capMs: 5000, settleMs: 200, pollMs: 10 });
  assert.equal(result.complete, true);
  assert.ok(Date.now() - started >= 550, "waited for the second end plus the settle time");
});

test("waitForIndex: no progress at all resolves after the grace period", async () => {
  const result = await waitForIndex(new IndexProgress(), stubClient, { capMs: 5000, graceMs: 60, pollMs: 10 });
  assert.equal(result.complete, true);
  assert.equal(result.ms, null);
  assert.match(result.note, /no index progress/);
});

test("waitForIndex: gives up at the cap and says so", async () => {
  const progress = new IndexProgress();
  progress.onProgress(progressMessage("begin")); // never ends
  const result = await waitForIndex(progress, stubClient, { capMs: 80, graceMs: 10000, pollMs: 10 });
  assert.equal(result.complete, false);
  assert.match(result.note, /not finished/);
});

test("waitForIndex: a dead clangd is an error, not an endless wait", async () => {
  const dead = { exited: true, stderrTail: "boom", exitCode: 1 };
  await assert.rejects(waitForIndex(new IndexProgress(), dead, { capMs: 5000, pollMs: 10 }), /clangd exited while indexing: boom/);
});

test("pathToUri output is what normalizeLocations expects back", () => {
  const file = "D:/OffLocalDev/gs_play_gems/gs_core/a b.cpp";
  assert.equal(pathKey(normalizeLocations({ uri: pathToUri(file), range: range(2) })[0].path), pathKey(file));
});
