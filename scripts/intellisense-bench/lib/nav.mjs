// ============================================================================
//  nav.mjs - "does F12 / Ctrl+T / find references / rename ... answer correctly?"
//
//  Starts a real clangd (the same flags the extension's users get: background
//  index on, low priority), waits for the background index to finish, then:
//    1. opens each probe file, waits for its diagnostics,
//    2. asks the probe type's question at the probe token: textDocument/definition
//       (the default) or one of the relationship requests in probeTypes.mjs,
//    3. judges the answer (F12: a result ends with the expected file suffix; the
//       relationship types: see lspResults.mjs).
//  Finally runs workspace/symbol for each symbol query (the Ctrl+T box).
//
//  If the index does not finish within the cap, the probes that can only pass through
//  the index (F12 onto another .cpp, and every relationship probe) and all symbol queries
//  are SKIPPED, not run: their outcome would measure how far the index got, not the
//  IntelliSense quality.
//
//  Isolation: clangd is pointed at a COPY of the compile database inside the work
//  directory, so its background index lands in <variantDir>/.cache/clangd/index -
//  verified empirically for clangd 22.1.6, see README.md. Nothing else is written.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { LspClient } from "./lsp.mjs";
import { clangdEnv } from "./procs.mjs";
import { assertInside, extOf, hasPathSuffix, isUnder, normalizePath, pathKey, pathToUri, uriToPath } from "./paths.mjs";
import { SOURCE_EXTENSIONS } from "./compdb.mjs";
import { anyMatchesSuffix, capEvidence, findPathTwins, normalizeLocations, normalizeSymbols } from "./lspResults.mjs";
import { PROBE_TYPES, describeExpect } from "./probeTypes.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
//  VARIANT FOLDERS AND ISOLATION
// ============================================================================

// assertInside lives in paths.mjs (the run lock needs it too); it stays importable from here
export { assertInside };

/**
 * <workDir>/variants/<name>
 * @param {string} workDir
 * @param {string} name
 * @returns {string}
 */
export function variantDir(workDir, name) {
  const dir = normalizePath(`${workDir}/variants/${name}`);
  assertInside(workDir, dir);
  return dir;
}

/**
 * Where clangd keeps the background index for a compile DB folder.
 * @param {string} dir  the variant folder (the one holding compile_commands.json)
 * @returns {string}
 */
export function indexDirOf(dir) {
  return normalizePath(`${dir}/.cache/clangd/index`);
}

/**
 * Copy the variant's compile DB into its folder under the work directory and return that folder.
 * The copy is skipped when it is already identical, so a warm index is not disturbed.
 * @param {string} workDir
 * @param {{name: string, db: string}} variant
 * @returns {string} folder to pass as --compile-commands-dir
 */
export function prepareVariant(workDir, variant) {
  const dir = variantDir(workDir, variant.name);
  writeIfChanged(workDir, `${dir}/compile_commands.json`, fs.readFileSync(variant.db));
  return dir;
}

/**
 * Write a reduced compile DB (the entries navigation needs, see selectNavSubset) into its own
 * folder, <variantDir>/nav-subset, so the check stage keeps using the full copy. clangd's
 * background index for the subset lands in <that folder>/.cache, apart from the full DB's index.
 * @param {string} workDir
 * @param {{name: string}} variant
 * @param {object[]} entries  raw compile-DB entries
 * @returns {string} folder to pass as --compile-commands-dir for the nav stage
 */
export function prepareNavSubset(workDir, variant, entries) {
  const dir = normalizePath(`${variantDir(workDir, variant.name)}/nav-subset`);
  writeIfChanged(workDir, `${dir}/compile_commands.json`, Buffer.from(JSON.stringify(entries, null, 2) + "\n"));
  return dir;
}

/**
 * Write `bytes` to `target` unless the file already holds exactly them, so a warm index is not disturbed.
 * @param {string} workDir
 * @param {string} target
 * @param {Buffer} bytes
 */
function writeIfChanged(workDir, target, bytes) {
  assertInside(workDir, target);
  fs.mkdirSync(path.posix.dirname(target), { recursive: true });
  const same = fs.existsSync(target) && fs.statSync(target).size === bytes.length && fs.readFileSync(target).equals(bytes);
  if (!same) fs.writeFileSync(target, bytes);
}

/**
 * Delete ONLY <variantDir>/.cache - the one folder --cold is allowed to remove.
 * @param {string} workDir
 * @param {string} dir  the variant folder
 */
export function coldReset(workDir, dir) {
  const cache = normalizePath(`${dir}/.cache`);
  assertInside(workDir, cache);
  assertInside(normalizePath(`${workDir}/variants`), cache);
  if (path.posix.basename(cache) !== ".cache") throw new Error(`Refusing to delete "${cache}": not a .cache folder`);
  fs.rmSync(cache, { recursive: true, force: true });
}

/**
 * Total bytes of every file under a folder (0 when it does not exist).
 * @param {string} dir
 * @returns {number}
 */
export function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    for (const item of fs.readdirSync(stack.pop(), { withFileTypes: true })) {
      const full = `${item.parentPath ?? item.path}/${item.name}`;
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile()) total += fs.statSync(full).size;
    }
  }
  return total;
}

// ============================================================================
//  PROBE GEOMETRY
// ============================================================================

export class ProbeError extends Error {
  /**
   * @param {string} code  short machine-readable reason
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Locate the probe position: the line holding the unique anchor, and the column of the token on it.
 * Columns are UTF-16 code units, which is what LSP counts and what JS string indices are.
 * An identifier token matches as a whole word; a token made of punctuation ("->", "::") matches as is.
 * @param {string} text        file contents
 * @param {string} anchor      substring unique in the file
 * @param {string} token       identifier (or "->", "::", ".") on the anchor's line
 * @param {number} [occurrence] which match of the token on that line (0-based)
 * @returns {{line: number, character: number, lineText: string}}  line is 0-based
 */
export function findProbePosition(text, anchor, token, occurrence = 0) {
  const first = text.indexOf(anchor);
  if (first < 0) throw new ProbeError("anchor-not-found", `anchor not found in file: ${JSON.stringify(anchor)}`);
  if (text.indexOf(anchor, first + 1) >= 0) throw new ProbeError("anchor-not-unique", `anchor is not unique in file: ${JSON.stringify(anchor)}`);

  const line = (text.slice(0, first).match(/\r\n|\n|\r/g) ?? []).length;
  const lineText = text.split(/\r\n|\n|\r/)[line];

  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = /^\w/.test(token) ? "(?<![A-Za-z0-9_])" : ""; // a word boundary only where the token has a word edge
  const after = /\w$/.test(token) ? "(?![A-Za-z0-9_])" : "";
  const wholeWord = new RegExp(`${before}${escaped}${after}`, "g");
  let seen = 0;
  for (let m = wholeWord.exec(lineText); m; m = wholeWord.exec(lineText)) {
    if (seen++ === occurrence) return { line, character: m.index, lineText };
  }
  throw new ProbeError("token-not-found", `token ${JSON.stringify(token)} (occurrence ${occurrence}) not found on line ${line + 1}: ${lineText.trim()}`);
}

/**
 * The position a probe is asked at: the start of its token, or just after it for a completion
 * probe with afterToken (the cursor right after "->" or "::").
 * @param {string} text
 * @param {import("./recipe.mjs").Probe} probe
 * @returns {{line: number, character: number, lineText: string}}
 */
export function locateProbe(text, probe) {
  const found = findProbePosition(text, probe.anchor, probe.token, probe.occurrence ?? 0);
  return probe.afterToken ? { ...found, character: found.character + probe.token.length } : found;
}

// ============================================================================
//  LSP RESULTS
//  (flattening and judging live in lspResults.mjs; these stay importable from here)
// ============================================================================

export { anyMatchesSuffix, normalizeLocations, normalizeSymbols };

// ============================================================================
//  BACKGROUND INDEX PROGRESS
// ============================================================================

/** Tracks clangd's $/progress reports for its background index. */
export class IndexProgress {
  constructor() {
    /** @type {Set<string>} every progress token the server announced */
    this.tokens = new Set();
    this.sawBegin = false;
    this.active = false;
    this.endedAt = 0;
    this.lastMessage = "";
  }

  /** @param {{token: any, value?: {kind?: string, message?: string, percentage?: number, title?: string}}} params */
  onProgress(params) {
    const token = String(params?.token);
    this.tokens.add(token);
    if (!/index/i.test(token)) return; // clangd names its token "backgroundIndexProgress"
    const value = params.value ?? {};
    if (value.kind === "begin") {
      this.sawBegin = true;
      this.active = true;
    } else if (value.kind === "end") {
      this.active = false;
      this.endedAt = Date.now();
    }
    const detail = [value.message, value.percentage === undefined ? "" : `${value.percentage}%`].filter(Boolean).join(" ");
    if (detail) this.lastMessage = detail;
  }
}

/**
 * Wait until the background index reports it is done.
 * Done = a progress "end" followed by `settleMs` of quiet, or no progress at all for
 * `graceMs` (an already up-to-date or empty index may report nothing). Gives up at `capMs`.
 * @param {IndexProgress} progress
 * @param {LspClient} client
 * @param {{capMs: number, graceMs?: number, settleMs?: number, pollMs?: number, onTick?: (message: string, elapsedMs: number) => void}} options
 * @returns {Promise<{complete: boolean, ms: number | null, note: string}>}  ms is the time to the end event
 */
export async function waitForIndex(progress, client, { capMs, graceMs = 30000, settleMs = 2000, pollMs = 250, onTick }) {
  const start = Date.now();
  let lastTick = start;
  for (;;) {
    await sleep(pollMs);
    if (client.exited) throw new Error(`clangd exited while indexing: ${client.stderrTail.trim() || `code ${client.exitCode}`}`);
    const now = Date.now();

    if (progress.sawBegin && !progress.active && now - progress.endedAt >= settleMs) {
      return { complete: true, ms: progress.endedAt - start, note: "" };
    }
    if (!progress.sawBegin && now - start >= graceMs) {
      return { complete: true, ms: null, note: "clangd reported no index progress (index already up to date, or nothing to index)" };
    }
    if (now - start >= capMs) {
      return { complete: false, ms: now - start, note: `index not finished after ${Math.round(capMs / 60000)} min; results may undercount` };
    }
    if (onTick && now - lastTick >= 15000) {
      onTick(progress.lastMessage, now - start);
      lastTick = now;
    }
  }
}

// ============================================================================
//  CLANGD SESSION
// ============================================================================

/**
 * @typedef {object} Session
 * @property {LspClient} client
 * @property {IndexProgress} progress
 * @property {Map<string, any[]>} diagnostics   latest publishDiagnostics per file (by path key)
 * @property {Map<string, string>} openFiles    path key -> uri, for files currently open
 * @property {Record<string, any>} serverCapabilities   what clangd answered in `initialize` (filled once the handshake is done)
 */

/**
 * Start clangd on the variant folder and run the LSP handshake.
 * @param {import("./recipe.mjs").Recipe} recipe
 * @param {import("./recipe.mjs").Variant} variant
 * @param {string} dir  variant folder
 * @returns {Promise<Session>}
 */
export async function startSession(recipe, variant, dir) {
  const args = [
    `--compile-commands-dir=${dir}`,
    "--background-index",
    "--background-index-priority=low",
    `-j=${recipe.limits.jobs}`,
    "--log=error",
    ...variant.extraArgs,
  ];
  const client = LspClient.spawn(recipe.clangd, args, { env: clangdEnv(recipe.workDir), cwd: dir });
  const progress = new IndexProgress();
  /** @type {Session} */
  const session = { client, progress, diagnostics: new Map(), openFiles: new Map(), serverCapabilities: {} };

  client.onRequest("window/workDoneProgress/create", (params) => {
    progress.tokens.add(String(params?.token));
    return null;
  });
  client.onRequest("workspace/configuration", (params) => (params?.items ?? []).map(() => null));
  client.onNotification("$/progress", (params) => progress.onProgress(params));
  client.onNotification("textDocument/publishDiagnostics", (params) => {
    // When we close a file clangd publishes an empty list for it; that is not a diagnostics
    // report for the next time we open the file, so only files that are open are recorded.
    const key = pathKey(safeUriToPath(params.uri));
    if (session.openFiles.has(key)) session.diagnostics.set(key, params.diagnostics ?? []);
  });

  const rootUri = pathToUri(recipe.project);
  try {
    const initialized = await client.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "intellisense-bench", version: "1" },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.posix.basename(recipe.project) }],
        capabilities: CLIENT_CAPABILITIES,
      },
      120000,
    );
    session.serverCapabilities = initialized?.capabilities ?? {};
  } catch (err) {
    client.kill();
    throw err;
  }
  client.notify("initialized", {});
  return session;
}

/**
 * What the benchmark's client tells clangd it can do: what an editor like VS Code advertises for the
 * requests the probes use. Without these clangd may leave a feature out (rename's prepareSupport,
 * code actions as literals, snippet-free completion).
 */
export const CLIENT_CAPABILITIES = {
  window: { workDoneProgress: true },
  workspace: { symbol: {}, workspaceFolders: true, configuration: true },
  textDocument: {
    synchronization: {},
    publishDiagnostics: {},
    definition: { linkSupport: true },
    declaration: { linkSupport: true },
    references: {},
    implementation: { linkSupport: true },
    typeHierarchy: {},
    callHierarchy: {},
    rename: { prepareSupport: true },
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"] },
      },
    },
    completion: { completionItem: { snippetSupport: false } },
  },
};

/**
 * Open a file in the server (a file that is already open is left as it is) and
 * wait for its diagnostics.
 * @param {Session} session
 * @param {string} file
 * @param {string} text
 * @param {number} diagnosticsWaitMs
 * @returns {Promise<boolean>} resolves true when diagnostics arrived, false when the wait timed out
 */
export function openFile(session, file, text, diagnosticsWaitMs) {
  const key = pathKey(file);
  const alreadyOpen = session.openFiles.has(key);
  if (alreadyOpen && session.diagnostics.has(key)) return Promise.resolve(true); // published before we asked

  // register the waiter BEFORE sending didOpen so the notification cannot slip past
  const arrived = session.client
    .waitForNotification("textDocument/publishDiagnostics", (params) => pathKey(safeUriToPath(params.uri)) === key, diagnosticsWaitMs)
    .then(() => true, () => false);

  if (!alreadyOpen) {
    const uri = pathToUri(file);
    session.openFiles.set(key, uri);
    session.client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: path.posix.extname(file).toLowerCase() === ".c" ? "c" : "cpp", version: 1, text },
    });
  }
  return arrived;
}

/**
 * @param {Session} session
 * @param {string} file
 */
export function closeFile(session, file) {
  const key = pathKey(file);
  const uri = session.openFiles.get(key);
  if (!uri) return;
  session.openFiles.delete(key);
  session.diagnostics.delete(key);
  session.client.notify("textDocument/didClose", { textDocument: { uri } });
}

/** @param {string} uri */
function safeUriToPath(uri) {
  try {
    return uriToPath(uri);
  } catch {
    return "";
  }
}

// ============================================================================
//  PROBES (F12 and the relationship types)
// ============================================================================

/** Cache of file -> lines, for showing the line a result landed on. */
class LineReader {
  constructor() {
    /** @type {Map<string, string[] | null>} */
    this.cache = new Map();
  }

  /**
   * @param {string} file
   * @param {number} line  0-based
   * @returns {string} trimmed line text ("" when unreadable)
   */
  text(file, line) {
    const key = pathKey(file);
    if (!this.cache.has(key)) {
      try {
        this.cache.set(key, fs.readFileSync(file, "utf8").split(/\r\n|\n|\r/));
      } catch {
        this.cache.set(key, null);
      }
    }
    return (this.cache.get(key)?.[line] ?? "").trim().slice(0, 200);
  }
}

/**
 * Where clangd gets the compile flags for a probe's file.
 *   own entry          the compile DB has an entry for the file
 *   full-DB inferred   no entry; the flags clangd infers from the FULL DB, as the editor would
 *                      (`from` names the entry it borrows them from, when known)
 *   subset-inferred    no entry, and the entry clangd would borrow from is unknown, so the flags are whatever
 *                      the nav subset happens to offer. Not comparable with the full-DB numbers.
 * @typedef {object} ProbeFlags
 * @property {"own entry" | "full-DB inferred" | "subset-inferred"} source
 * @property {string} from  the DB file the flags are inferred from ("" for an own entry or when unknown)
 */

/** @type {ProbeFlags} */
export const OWN_ENTRY = { source: "own entry", from: "" };

/**
 * @typedef {object} ProbeResult
 * @property {string} id
 * @property {string} type          "definition" (F12) or a relationship type, see probeTypes.mjs
 * @property {string} part
 * @property {string} category
 * @property {string} file
 * @property {boolean} expectedBuilt
 * @property {ProbeFlags} flags     where the compile flags for `file` come from
 * @property {string} expected      the expectation in words, for the report
 * @property {string} expectedSuffix   definition probes only ("" otherwise)
 * @property {"definition" | "any" | ""} kind   definition probes only
 * @property {import("./lspResults.mjs").Evidence | null} returned   relationship probes: what clangd answered (capped lists and counts)
 * @property {boolean} needsIndex   F12: the expected target is another .cpp, which clangd only finds through the background index. Every relationship type needs the index.
 * @property {"pass" | "fail" | "error" | "skipped"} status   skipped = not run because the index did not finish (see SKIPPED_INDEX_INCOMPLETE)
 * @property {string} reason
 * @property {"definition" | "declaration" | ""} via   which request produced the matching result
 * @property {number | null} line                     1-based probe line
 * @property {string} lineText
 * @property {{path: string, line: number, text: string}[]} targets
 * @property {{errors: number, warnings: number, messages: string[], timedOut: boolean}} diagnostics
 * @property {number} ms
 */

/** The reason shown for a probe or symbol that was not run because the background index did not finish. */
export const SKIPPED_INDEX_INCOMPLETE = "skipped: index incomplete";

/**
 * Can this probe only succeed once the background index has reached specific files?
 *
 * Every relationship type (references, implementation, type hierarchy, incoming calls, rename,
 * code action, completion) is answered across files, so it needs the index.
 *
 * F12 needs it when the expected target is a source file other than the probe's own file:
 * clangd finds a definition in ANOTHER .cpp only through the index. A header target (or the
 * probe's own file) comes from the AST, so it does not depend on the index.
 * @param {import("./recipe.mjs").Probe} probe
 * @returns {boolean}
 */
export function probeNeedsIndex(probe) {
  if ((probe.type ?? "definition") !== "definition") return true;
  return SOURCE_EXTENSIONS.has(extOf(probe.expect.fileSuffix)) && !hasPathSuffix(probe.file, probe.expect.fileSuffix);
}

/**
 * @param {import("./recipe.mjs").Probe} probe
 * @returns {ProbeResult}  a blank result (status "error") to fill in
 */
function newProbeResult(probe) {
  const type = probe.type ?? "definition";
  return {
    id: probe.id,
    type,
    part: probe.part,
    category: probe.category,
    file: probe.file,
    expectedBuilt: probe.expectedBuilt,
    flags: OWN_ENTRY,
    expected: type === "definition" ? `${probe.expect.kind} in ...${probe.expect.fileSuffix}` : describeExpect(type, probe.expect),
    expectedSuffix: probe.expect.fileSuffix ?? "",
    kind: probe.expect.kind ?? "",
    returned: null,
    needsIndex: probeNeedsIndex(probe),
    status: "error",
    reason: "",
    via: "",
    line: null,
    lineText: "",
    targets: [],
    diagnostics: { errors: 0, warnings: 0, messages: [], timedOut: false },
    ms: 0,
  };
}

/**
 * The result recorded for a probe that is not run because the index did not finish.
 * @param {import("./recipe.mjs").Probe} probe
 * @returns {ProbeResult}
 */
export function skippedProbe(probe) {
  return { ...newProbeResult(probe), status: "skipped", reason: SKIPPED_INDEX_INCOMPLETE };
}

/**
 * Run one probe: open the file, wait for its diagnostics, ask the probe type's question, judge.
 * The probe file is left open (the caller closes it when it moves to another file),
 * so several probes in one file share a single parse.
 *
 * type "definition" (default): textDocument/definition must land in the expected file.
 *   kind "definition": definition only.   kind "any": definition OR declaration (a header is fine).
 * any other type: see probeTypes.mjs.
 * @param {Session} session
 * @param {import("./recipe.mjs").Probe} probe
 * @param {import("./recipe.mjs").Recipe["limits"]} limits
 * @param {LineReader} lines
 * @returns {Promise<ProbeResult>}
 */
export async function runProbe(session, probe, limits, lines) {
  const started = Date.now();
  const result = newProbeResult(probe);
  const finish = () => {
    result.ms = Date.now() - started;
    return result;
  };

  try {
    let text;
    try {
      text = fs.readFileSync(probe.file, "utf8");
    } catch (err) {
      throw new ProbeError("file-unreadable", `cannot read probe file: ${err.message}`);
    }
    const position = locateProbe(text, probe);
    result.line = position.line + 1;
    result.lineText = position.lineText.trim().slice(0, 200);

    const diagnosticsArrived = await openFile(session, probe.file, text, limits.diagnosticsWaitSec * 1000);
    result.diagnostics.timedOut = !diagnosticsArrived;

    const requestMs = Math.max(limits.diagnosticsWaitSec, 60) * 1000;
    if (result.type === "definition") await askDefinition(session, probe, position, requestMs, lines, result);
    else await askRelation(session, probe, position, requestMs, result);
  } catch (err) {
    result.status = "error";
    result.reason = err instanceof ProbeError ? err.message : `request failed: ${err.message}`;
  }

  // diagnostics as clangd last published them for this file
  const published = session.diagnostics.get(pathKey(probe.file)) ?? [];
  const errors = published.filter((d) => d.severity === 1);
  result.diagnostics.errors = errors.length;
  result.diagnostics.warnings = published.filter((d) => d.severity === 2).length;
  result.diagnostics.messages = errors.slice(0, 3).map((d) => String(d.message).slice(0, 200));

  return finish();
}

/**
 * F12: definition (and, for kind "any", declaration) must land in the expected file. Fills `result`.
 * @param {Session} session
 * @param {import("./recipe.mjs").Probe} probe
 * @param {{line: number, character: number}} position
 * @param {number} requestMs
 * @param {LineReader} lines
 * @param {ProbeResult} result
 */
async function askDefinition(session, probe, position, requestMs, lines, result) {
  const params = { textDocument: { uri: pathToUri(probe.file) }, position: { line: position.line, character: position.character } };

  let targets = normalizeLocations(await session.client.request("textDocument/definition", params, requestMs));
  let matched = anyMatchesSuffix(targets, probe.expect.fileSuffix);
  if (matched) result.via = "definition";

  if (!matched && probe.expect.kind === "any") {
    try {
      const declared = normalizeLocations(await session.client.request("textDocument/declaration", params, requestMs));
      targets = [...targets, ...declared];
      matched = anyMatchesSuffix(declared, probe.expect.fileSuffix);
      if (matched) result.via = "declaration";
    } catch {
      // an older clangd without textDocument/declaration: definition alone decides
    }
  }

  result.targets = targets.map((t) => ({ path: t.path, line: t.line + 1, text: lines.text(t.path, t.line) }));
  result.status = matched ? "pass" : "fail";
  result.reason = matched ? "" : targets.length === 0 ? "no result" : "landed in a different file";
}

/**
 * A relationship probe (references, implementation, ...): ask, then judge what came back. Fills `result`.
 * @param {Session} session
 * @param {import("./recipe.mjs").Probe} probe
 * @param {{line: number, character: number}} position
 * @param {number} requestMs
 * @param {ProbeResult} result
 */
async function askRelation(session, probe, position, requestMs, result) {
  const type = PROBE_TYPES[probe.type];
  const start = { line: position.line, character: position.character };
  const evidence = await type.fetch({
    client: session.client,
    uri: pathToUri(probe.file),
    position: start,
    range: { start, end: { line: start.line, character: start.character + probe.token.length } }, // the token itself, for code actions
    token: probe.token,
    diagnostics: session.diagnostics.get(pathKey(probe.file)) ?? [],
    requestMs,
  });
  const verdict = type.judge(evidence, probe.expect);

  result.returned = capEvidence(evidence);
  result.status = verdict.pass ? "pass" : "fail";
  result.reason = verdict.reason;
}

// ============================================================================
//  SYMBOLS (Ctrl+T)
// ============================================================================

/**
 * @typedef {object} SymbolResult
 * @property {string} query
 * @property {string} expectedSuffix
 * @property {"pass" | "fail" | "error" | "skipped"} status   skipped = not run because the index did not finish
 * @property {string} reason
 * @property {number} resultCount
 * @property {{name: string, path: string, line: number}[]} top   first five results
 * @property {number} twinCount   path-identity pairs among ALL results (see findPathTwins): one symbol, one file tail, two roots
 * @property {{name: string, container: string, a: string, b: string, tail: number}[]} twins   the first few of them
 * @property {number} ms
 */

/** How many path-identity examples one symbol result keeps. */
const MAX_TWIN_EXAMPLES = 10;

/**
 * @param {{query: string, expectFileSuffix: string}} symbol
 * @returns {SymbolResult}  a blank result (status "error") to fill in
 */
function newSymbolResult(symbol) {
  return { query: symbol.query, expectedSuffix: symbol.expectFileSuffix, status: "error", reason: "", resultCount: 0, top: [], twinCount: 0, twins: [], ms: 0 };
}

/**
 * The result recorded for a symbol query that is not run because the index did not finish.
 * workspace/symbol answers come from the index, so with a partial index EVERY query is
 * index-dependent: even a header symbol needs the shard of some indexed file that includes it.
 * @param {{query: string, expectFileSuffix: string}} symbol
 * @returns {SymbolResult}
 */
export function skippedSymbol(symbol) {
  return { ...newSymbolResult(symbol), status: "skipped", reason: SKIPPED_INDEX_INCOMPLETE };
}

/**
 * Run one workspace/symbol query.
 * @param {Session} session
 * @param {{query: string, expectFileSuffix: string}} symbol
 * @returns {Promise<SymbolResult>}
 */
export async function runSymbol(session, symbol) {
  const started = Date.now();
  const result = newSymbolResult(symbol);
  try {
    const rows = normalizeSymbols(await session.client.request("workspace/symbol", { query: symbol.query }, 60000));
    result.resultCount = rows.length;
    result.top = rows.slice(0, 5).map((r) => ({ name: r.name, path: r.path, line: r.line + 1 }));
    const twins = findPathTwins(rows);
    result.twinCount = twins.length;
    result.twins = twins.slice(0, MAX_TWIN_EXAMPLES);
    const matched = anyMatchesSuffix(rows, symbol.expectFileSuffix);
    result.status = matched ? "pass" : "fail";
    result.reason = matched ? "" : rows.length === 0 ? "no result" : "no result in the expected file";
  } catch (err) {
    result.reason = `request failed: ${err.message}`;
  }
  result.ms = Date.now() - started;
  return result;
}

// ============================================================================
//  ONE VARIANT, END TO END
// ============================================================================

/**
 * @typedef {object} NavResult
 * @property {boolean} coldRequested   --cold was passed
 * @property {boolean} freshIndex      the index folder was empty when clangd started
 * @property {string} indexDir
 * @property {boolean} indexExists
 * @property {boolean} indexInsideWorkDir
 * @property {number} indexSizeBytes
 * @property {number | null} indexMs   time from start to the index "end" event
 * @property {boolean} indexComplete
 * @property {string} indexNote
 * @property {{entries: number, of: number} | null} dbSubset   set when clangd was given a reduced compile DB (nav.dbSubset in the recipe)
 * @property {string[]} progressTokens
 * @property {ProbeResult[]} probes
 * @property {SymbolResult[]} symbols
 * @property {string} clangdStderr     tail of clangd's stderr (empty when quiet)
 */

/**
 * Run the whole navigation stage for one variant.
 *
 * When the background index does not finish within the cap, every probe that needs the
 * index and every symbol query is recorded as "skipped" instead of being run: their
 * outcome would measure how far the index got, not the quality of the IntelliSense.
 * @param {object} options
 * @param {import("./recipe.mjs").Recipe} options.recipe
 * @param {import("./recipe.mjs").Variant} options.variant
 * @param {string} options.dir          folder holding the compile DB clangd uses (see prepareVariant / prepareNavSubset)
 * @param {boolean} options.cold        delete <dir>/.cache first
 * @param {string} [options.kickFile]   file opened right away so clangd loads the compile DB and starts indexing
 * @param {{entries: number, of: number} | null} [options.dbSubset]  how much of the variant's DB `dir` holds, when reduced
 * @param {Map<string, ProbeFlags>} [options.entryless]  probe files with no entry of their own, by pathKey: where their flags come from
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<NavResult>}
 */
export async function runNav({ recipe, variant, dir, cold, kickFile, dbSubset = null, entryless = new Map(), log = () => {} }) {
  if (cold) {
    coldReset(recipe.workDir, dir);
    log(`cold: removed ${dir}/.cache`);
  }
  const indexDir = indexDirOf(dir);
  assertInside(recipe.workDir, indexDir);
  const freshIndex = dirSize(normalizePath(`${dir}/.cache`)) === 0;

  const session = await startSession(recipe, variant, dir);
  const lines = new LineReader();
  /** @type {NavResult} */
  let nav;
  try {
    // Opening one file makes clangd load the compile DB, which is what starts the background index.
    const indexStart = Date.now();
    if (kickFile) {
      try {
        void openFile(session, kickFile, fs.readFileSync(kickFile, "utf8"), 1000);
      } catch {
        // an unreadable kick file just means the index starts a little later
      }
    }
    log(`indexing (${freshIndex ? "fresh" : "warm"} index, cap ${recipe.limits.indexWaitMin} min) ...`);
    const index = await waitForIndex(session.progress, session.client, {
      capMs: recipe.limits.indexWaitMin * 60000,
      onTick: (message, elapsedMs) => log(`  indexing ${Math.round(elapsedMs / 1000)}s ${message}`),
    });
    log(`index ${index.complete ? "done" : "NOT done"} in ${Math.round((Date.now() - indexStart) / 1000)}s ${index.note}`);
    if (!index.complete) log("INDEX INCOMPLETE: probes that need the index and all symbol queries are skipped");

    // keep the kick file open only when the first probe is about to use it anyway
    const firstProbe = recipe.probes[0];
    const closeAfterIndex = Boolean(kickFile) && !(firstProbe && pathKey(firstProbe.file) === pathKey(kickFile));
    if (kickFile && closeAfterIndex) closeFile(session, kickFile);

    // probes run in recipe order; a file stays open until the next probe needs a different one
    const probes = [];
    let openFileNow = kickFile && !closeAfterIndex ? kickFile : null;
    for (const [i, probe] of recipe.probes.entries()) {
      if (!index.complete && probeNeedsIndex(probe)) {
        probes.push(skippedProbe(probe));
      } else {
        if (openFileNow && pathKey(openFileNow) !== pathKey(probe.file)) closeFile(session, openFileNow);
        openFileNow = probe.file;
        probes.push(await runProbe(session, probe, recipe.limits, lines));
      }
      probes.at(-1).flags = entryless.get(pathKey(probe.file)) ?? OWN_ENTRY;
      log(`probe ${i + 1}/${recipe.probes.length} ${probe.id}: ${probes.at(-1).status}`);
    }
    if (openFileNow) closeFile(session, openFileNow);
    const symbols = [];
    for (const symbol of recipe.symbols) {
      symbols.push(index.complete ? await runSymbol(session, symbol) : skippedSymbol(symbol));
      log(`symbol "${symbol.query}": ${symbols.at(-1).status}`);
    }

    nav = {
      coldRequested: cold,
      freshIndex,
      indexDir,
      indexExists: false,
      indexInsideWorkDir: isUnder(indexDir, recipe.workDir),
      indexSizeBytes: 0,
      indexMs: index.ms,
      indexComplete: index.complete,
      indexNote: index.note,
      dbSubset,
      progressTokens: [...session.progress.tokens],
      probes,
      symbols,
      clangdStderr: "",
    };
  } finally {
    await session.client.shutdown();
  }

  // measured after clangd has exited, so every shard is on disk
  nav.indexExists = fs.existsSync(indexDir);
  nav.indexSizeBytes = dirSize(normalizePath(`${dir}/.cache`));
  nav.clangdStderr = session.client.stderrTail.trim();
  return nav;
}
