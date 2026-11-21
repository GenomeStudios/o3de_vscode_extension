import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CAPABILITY_LABELS, MAX_EXPANDED_SUBTYPES, PROBE_TYPES, PROBE_TYPE_NAMES, RELATION_TYPE_NAMES, RENAME_SUFFIX, describeExpect } from "../lib/probeTypes.mjs";

// Each type is driven with a stub client that replays real clangd 22.1.6 responses
// (test/fixtures/lsp-responses.json); the stub also records every request it was sent.
const R = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "lsp-responses.json"), "utf8"));

/**
 * @param {Record<string, any>} answers  method -> result, or a function (params) -> result; an Error is thrown
 */
function stubClient(answers) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      const answer = answers[method];
      const result = typeof answer === "function" ? answer(params) : answer;
      if (result instanceof Error) throw result;
      return result ?? null;
    },
  };
}

const ctxFor = (client, extra = {}) => ({
  client,
  uri: "file:///d%3A/zoo/include/creature.h",
  position: { line: 4, character: 10 },
  range: { start: { line: 4, character: 10 }, end: { line: 4, character: 18 } },
  token: "Creature",
  diagnostics: [],
  requestMs: 1000,
  ...extra,
});

/** A clangd error reply, as lsp.mjs reports it. */
const clangdSays = (message) => Object.assign(new Error(`method: ${message}`), { rpcError: { code: -32001, message } });

/** Run a type's fetch, then its judge. */
async function probe(type, ctx, expect) {
  const evidence = await PROBE_TYPES[type].fetch(ctx);
  return { evidence, verdict: PROBE_TYPES[type].judge(evidence, expect), calls: ctx.client.calls };
}

// ============================================================================
//  the table
// ============================================================================

test("every relationship type has describe, fetch and judge, and a capability label", () => {
  assert.deepEqual(RELATION_TYPE_NAMES, ["references", "implementation", "typeHierarchy", "incomingCalls", "rename", "codeAction", "completion"]);
  assert.deepEqual(PROBE_TYPE_NAMES, ["definition", ...RELATION_TYPE_NAMES]);
  for (const type of RELATION_TYPE_NAMES) {
    for (const part of ["describe", "fetch", "judge"]) assert.equal(typeof PROBE_TYPES[type][part], "function", `${type}.${part}`);
  }
  for (const type of [...PROBE_TYPE_NAMES, "workspaceSymbol"]) assert.ok(CAPABILITY_LABELS[type], `label for ${type}`);
});

test("describeExpect puts each expectation in words", () => {
  assert.equal(describeExpect("references", { mustIncludeFileSuffixes: ["a.cpp", "b.h"], minFiles: 3 }), "includes ...a.cpp, ...b.h; at least 3 files");
  assert.equal(describeExpect("references", { mustIncludeFileSuffixes: [], minFiles: 2 }), "at least 2 files");
  assert.equal(describeExpect("implementation", { mustIncludeFileSuffixes: ["dog.cpp"] }), "includes ...dog.cpp");
  assert.equal(describeExpect("typeHierarchy", { subtypeFileSuffixes: ["dog.h", "bird.h"] }), "subtypes in ...dog.h, ...bird.h");
  assert.equal(describeExpect("codeAction", { titleIncludes: "override" }), 'an action titled like "override"');
  assert.equal(describeExpect("completion", { labelsInclude: ["Size", "Area"] }), "completions include Size, Area");
});

// ============================================================================
//  references and implementation
// ============================================================================

test("references: asks with includeDeclaration false and judges the files that came back", async () => {
  const client = stubClient({ "textDocument/references": R.referencesClass });
  const { evidence, verdict, calls } = await probe("references", ctxFor(client), { mustIncludeFileSuffixes: ["include/dog.h", "src/zoo.cpp"], minFiles: 5 });

  assert.deepEqual(calls.map((c) => c.method), ["textDocument/references"]);
  assert.equal(calls[0].params.context.includeDeclaration, false);
  assert.deepEqual(calls[0].params.position, { line: 4, character: 10 });
  assert.deepEqual(evidence.counts, { locations: 7, files: 5, uris: 6 });
  assert.deepEqual(verdict, { pass: true, reason: "" });
});

test("references: a missing file fails with what is missing; too few files fails", async () => {
  const client = () => stubClient({ "textDocument/references": R.referencesVirtualCall });
  const missing = await probe("references", ctxFor(client()), { mustIncludeFileSuffixes: ["src/bird.cpp"] });
  assert.deepEqual(missing.verdict, { pass: false, reason: "missing ...src/bird.cpp" });
  const few = await probe("references", ctxFor(client()), { minFiles: 2 });
  assert.equal(few.verdict.pass, false);
  assert.match(few.verdict.reason, /1 file\(s\), expected at least 2/);
});

test("references: no answer is 'no result'; a clangd error is an answer, a timeout is not", async () => {
  const empty = await probe("references", ctxFor(stubClient({})), { minFiles: 1 });
  assert.deepEqual(empty.verdict, { pass: false, reason: "no result" });

  const refused = await probe("references", ctxFor(stubClient({ "textDocument/references": clangdSays("no symbol here") })), { minFiles: 1 });
  assert.deepEqual(refused.verdict, { pass: false, reason: "clangd refused textDocument/references: no symbol here" });

  await assert.rejects(PROBE_TYPES.references.fetch(ctxFor(stubClient({ "textDocument/references": new Error("textDocument/references: no response within 60000 ms") }))), /no response within/);
});

test("implementation: asks textDocument/implementation and judges the files", async () => {
  const client = stubClient({ "textDocument/implementation": R.implementationPureVirtual });
  const { verdict, calls } = await probe("implementation", ctxFor(client), { mustIncludeFileSuffixes: ["src/dog.cpp", "src/bird.cpp"] });
  assert.deepEqual(calls.map((c) => c.method), ["textDocument/implementation"]);
  assert.equal(verdict.pass, true);

  const wrong = await probe("implementation", ctxFor(stubClient({ "textDocument/implementation": R.implementationPureVirtual })), { mustIncludeFileSuffixes: ["src/cat.cpp"] });
  assert.deepEqual(wrong.verdict, { pass: false, reason: "missing ...src/cat.cpp" });
});

test("implementation: LocationLink answers work too", async () => {
  const links = [{ targetUri: "file:///d%3A/zoo/src/dog.cpp", targetRange: { start: { line: 1, character: 0 } }, targetSelectionRange: { start: { line: 4, character: 13 } } }];
  const { verdict } = await probe("implementation", ctxFor(stubClient({ "textDocument/implementation": links })), { mustIncludeFileSuffixes: ["src/dog.cpp"] });
  assert.equal(verdict.pass, true);
});

// ============================================================================
//  type hierarchy
// ============================================================================

/** The real two-level answers: Creature -> Dog, Bird, Lazy; Dog -> Puppy. Subtypes are asked for by the item's name. */
const hierarchyClient = () =>
  stubClient({
    "textDocument/prepareTypeHierarchy": R.prepareTypeHierarchy,
    "typeHierarchy/subtypes": ({ item }) => ({ Creature: R.subtypesOfCreature, Dog: R.subtypesOfDog, Bird: R.subtypesOfBird }[item.name] ?? []),
  });

test("typeHierarchy: prepare, one level of subtypes, then a second level for each of them", async () => {
  const { evidence, verdict, calls } = await probe("typeHierarchy", ctxFor(hierarchyClient()), { subtypeFileSuffixes: ["include/dog.h", "include/bird.h", "src/zoo.cpp", "include/puppy.h"] });

  assert.deepEqual(calls.map((c) => c.method), ["textDocument/prepareTypeHierarchy", "typeHierarchy/subtypes", "typeHierarchy/subtypes", "typeHierarchy/subtypes", "typeHierarchy/subtypes"]);
  assert.deepEqual(calls.slice(1).map((c) => c.params.item.name), ["Creature", "Dog", "Bird", "Lazy"], "the raw item goes back to clangd");
  assert.deepEqual(evidence.labels, ["Dog", "Bird", "Lazy", "Puppy"]);
  assert.deepEqual(evidence.counts, { level1: 3, level2: 1, files: 4 });
  assert.deepEqual(verdict, { pass: true, reason: "" });
});

test("typeHierarchy: a subtype that does not exist fails and names it", async () => {
  const { verdict } = await probe("typeHierarchy", ctxFor(hierarchyClient()), { subtypeFileSuffixes: ["include/dog.h", "include/cat.h"] });
  assert.deepEqual(verdict, { pass: false, reason: "missing ...include/cat.h" });
});

test("typeHierarchy: only the first MAX_EXPANDED_SUBTYPES subtypes are expanded", async () => {
  const many = Array.from({ length: MAX_EXPANDED_SUBTYPES + 5 }, (_, i) => ({ name: `S${i}`, kind: 5, uri: `file:///d%3A/zoo/s${i}.h`, range: { start: { line: 0, character: 0 } }, selectionRange: { start: { line: 0, character: 0 } } }));
  const client = stubClient({ "textDocument/prepareTypeHierarchy": R.prepareTypeHierarchy, "typeHierarchy/subtypes": ({ item }) => (item.name === "Creature" ? many : []) });
  const { evidence, calls } = await probe("typeHierarchy", ctxFor(client), { subtypeFileSuffixes: ["s0.h"] });
  assert.equal(calls.filter((c) => c.method === "typeHierarchy/subtypes").length, 1 + MAX_EXPANDED_SUBTYPES);
  assert.equal(evidence.counts.level1, MAX_EXPANDED_SUBTYPES + 5);
});

test("typeHierarchy: nothing at the token, and a clangd error", async () => {
  const nothing = await probe("typeHierarchy", ctxFor(stubClient({ "textDocument/prepareTypeHierarchy": null })), { subtypeFileSuffixes: ["a.h"] });
  assert.deepEqual(nothing.verdict, { pass: false, reason: "prepareTypeHierarchy returned nothing at the token" });
  const refused = await probe("typeHierarchy", ctxFor(stubClient({ "textDocument/prepareTypeHierarchy": clangdSays("not a type") })), { subtypeFileSuffixes: ["a.h"] });
  assert.match(refused.verdict.reason, /clangd refused textDocument\/prepareTypeHierarchy: not a type/);
});

test("typeHierarchy: a class with no subtypes is 'no result'", async () => {
  const client = stubClient({ "textDocument/prepareTypeHierarchy": R.prepareTypeHierarchy, "typeHierarchy/subtypes": [] });
  const { verdict } = await probe("typeHierarchy", ctxFor(client), { subtypeFileSuffixes: ["a.h"] });
  assert.deepEqual(verdict, { pass: false, reason: "no result" });
});

// ============================================================================
//  incoming calls
// ============================================================================

test("incomingCalls: prepare, then incomingCalls for the prepared item; the callers' files are judged", async () => {
  const client = stubClient({ "textDocument/prepareCallHierarchy": R.prepareCallHierarchy, "callHierarchy/incomingCalls": R.incomingCallsOfArea });
  const { evidence, verdict, calls } = await probe("incomingCalls", ctxFor(client), { mustIncludeFileSuffixes: ["src/main.cpp"] });
  assert.deepEqual(calls.map((c) => c.method), ["textDocument/prepareCallHierarchy", "callHierarchy/incomingCalls"]);
  assert.equal(calls[1].params.item.name, "Area");
  assert.deepEqual(evidence.labels, ["main"]);
  assert.deepEqual(evidence.counts, { callers: 1, files: 1 });
  assert.equal(verdict.pass, true);

  const wrong = await probe("incomingCalls", ctxFor(stubClient({ "textDocument/prepareCallHierarchy": R.prepareCallHierarchy, "callHierarchy/incomingCalls": R.incomingCallsOfArea })), { mustIncludeFileSuffixes: ["src/zoo.cpp"] });
  assert.deepEqual(wrong.verdict, { pass: false, reason: "missing ...src/zoo.cpp" });
});

test("incomingCalls: nothing at the token; no callers; a clangd error", async () => {
  const nothing = await probe("incomingCalls", ctxFor(stubClient({})), { mustIncludeFileSuffixes: ["a.cpp"] });
  assert.deepEqual(nothing.verdict, { pass: false, reason: "prepareCallHierarchy returned nothing at the token" });

  const none = await probe("incomingCalls", ctxFor(stubClient({ "textDocument/prepareCallHierarchy": R.prepareCallHierarchy, "callHierarchy/incomingCalls": [] })), { mustIncludeFileSuffixes: ["a.cpp"] });
  assert.deepEqual(none.verdict, { pass: false, reason: "no result" });

  const refused = await probe("incomingCalls", ctxFor(stubClient({ "textDocument/prepareCallHierarchy": R.prepareCallHierarchy, "callHierarchy/incomingCalls": clangdSays("stale item") })), { mustIncludeFileSuffixes: ["a.cpp"] });
  assert.match(refused.verdict.reason, /clangd refused callHierarchy\/incomingCalls: stale item/);
});

// ============================================================================
//  rename: a dry run
// ============================================================================

test("rename: prepareRename, then rename to <token>_BenchRename; the edit is counted and never applied", async () => {
  const client = stubClient({ "textDocument/prepareRename": R.prepareRename, "textDocument/rename": R.renameArea });
  const { evidence, verdict, calls } = await probe("rename", ctxFor(client, { token: "Area" }), { minFiles: 3, mustIncludeFileSuffixes: ["include/shape.h", "src/main.cpp"] });

  assert.deepEqual(calls.map((c) => c.method), ["textDocument/prepareRename", "textDocument/rename"], "no workspace/applyEdit, no didChange: nothing is applied");
  assert.equal(calls[1].params.newName, `Area${RENAME_SUFFIX}`);
  assert.equal(calls[1].params.newName, "Area_BenchRename");
  assert.deepEqual(evidence.counts, { edits: 4, files: 3, uris: 4 });
  assert.deepEqual(verdict, { pass: true, reason: "" });
});

test("rename: too few files fails and says how many there were", async () => {
  const client = stubClient({ "textDocument/prepareRename": R.prepareRename, "textDocument/rename": R.renameArea });
  const { verdict } = await probe("rename", ctxFor(client, { token: "Area" }), { minFiles: 5 });
  assert.deepEqual(verdict, { pass: false, reason: "3 file(s), expected at least 5" });
});

test("rename: clangd refusing (prepareRename error, or an empty prepare) is a failed probe, and rename is never sent", async () => {
  const refused = stubClient({ "textDocument/prepareRename": clangdSays("Cannot rename symbol: there is no symbol at the given location") });
  const first = await probe("rename", ctxFor(refused, { token: "x" }), { minFiles: 1 });
  assert.equal(first.verdict.pass, false);
  assert.match(first.verdict.reason, /clangd refused textDocument\/prepareRename: Cannot rename symbol/);
  assert.deepEqual(refused.calls.map((c) => c.method), ["textDocument/prepareRename"]);

  const empty = stubClient({ "textDocument/prepareRename": null });
  const second = await probe("rename", ctxFor(empty, { token: "x" }), { minFiles: 1 });
  assert.match(second.verdict.reason, /prepareRename returned nothing/);
  assert.deepEqual(empty.calls.map((c) => c.method), ["textDocument/prepareRename"]);
});

test("rename: the rename request itself can be refused (the file limit, say)", async () => {
  const client = stubClient({ "textDocument/prepareRename": R.prepareRename, "textDocument/rename": clangdSays("The number of affected files (60) exceeds the limit (50)") });
  const { verdict } = await probe("rename", ctxFor(client, { token: "Area" }), { minFiles: 1 });
  assert.match(verdict.reason, /clangd refused textDocument\/rename: The number of affected files/);
});

// ============================================================================
//  code action
// ============================================================================

test("codeAction: asks over the token's range with the published diagnostics and no 'only'; judges the titles", async () => {
  const diagnostics = [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, severity: 2, message: "unused" }];
  const client = stubClient({ "textDocument/codeAction": R.codeActionLazy });
  const ctx = ctxFor(client, { diagnostics, range: { start: { line: 6, character: 10 }, end: { line: 6, character: 14 } }, token: "Lazy" });
  const { evidence, verdict, calls } = await probe("codeAction", ctx, { titleIncludes: "override pure virtual" });

  assert.deepEqual(calls.map((c) => c.method), ["textDocument/codeAction"]);
  assert.deepEqual(calls[0].params.range, { start: { line: 6, character: 10 }, end: { line: 6, character: 14 } });
  assert.deepEqual(calls[0].params.context, { diagnostics }, "the diagnostics clangd published, and no 'only' filter");
  assert.equal("only" in calls[0].params.context, false);
  assert.deepEqual(evidence.labels, ["Override pure virtual methods", "Declare implicit copy/move members"]);
  assert.deepEqual(verdict, { pass: true, reason: "" });
});

test("codeAction: wrong title, no actions, a clangd error", async () => {
  const wrong = await probe("codeAction", ctxFor(stubClient({ "textDocument/codeAction": R.codeActionLazy })), { titleIncludes: "extract" });
  assert.deepEqual(wrong.verdict, { pass: false, reason: 'no action title contains "extract"' });

  const none = await probe("codeAction", ctxFor(stubClient({ "textDocument/codeAction": R.codeActionNone })), { titleIncludes: "extract" });
  assert.deepEqual(none.verdict, { pass: false, reason: "no code actions offered" });

  const refused = await probe("codeAction", ctxFor(stubClient({ "textDocument/codeAction": clangdSays("file not open") })), { titleIncludes: "x" });
  assert.match(refused.verdict.reason, /clangd refused textDocument\/codeAction: file not open/);
});

// ============================================================================
//  completion
// ============================================================================

test("completion: asks at the cursor position and judges the inserted names", async () => {
  const client = stubClient({ "textDocument/completion": R.completionAfterScope });
  const ctx = ctxFor(client, { position: { line: 5, character: 21 } });
  const { evidence, verdict, calls } = await probe("completion", ctx, { labelsInclude: ["Area", "Widget"] });

  assert.deepEqual(calls.map((c) => c.method), ["textDocument/completion"]);
  assert.deepEqual(calls[0].params.position, { line: 5, character: 21 });
  assert.deepEqual(evidence.labels, ["Widget", "Area", "Creature", "Bird", "Dog", "Puppy"], "distinct names, in clangd's order");
  assert.deepEqual(evidence.counts, { items: 9 });
  assert.deepEqual(verdict, { pass: true, reason: "" });
});

test("completion: a missing name fails and names it; an empty answer; a clangd error", async () => {
  const missing = await probe("completion", ctxFor(stubClient({ "textDocument/completion": R.completionAfterDot })), { labelsInclude: ["Size", "Resize"] });
  assert.deepEqual(missing.verdict, { pass: false, reason: "missing Resize" });

  const empty = await probe("completion", ctxFor(stubClient({ "textDocument/completion": { isIncomplete: false, items: [] } })), { labelsInclude: ["Size"] });
  assert.deepEqual(empty.verdict, { pass: false, reason: "no completion items" });

  const refused = await probe("completion", ctxFor(stubClient({ "textDocument/completion": clangdSays("no preamble yet") })), { labelsInclude: ["Size"] });
  assert.match(refused.verdict.reason, /clangd refused textDocument\/completion: no preamble yet/);
});
