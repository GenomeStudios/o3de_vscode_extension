// ============================================================================
//  lspResults.mjs - LSP responses -> plain rows, and the judges that decide pass/fail
//
//  Pure functions, no clangd needed, so every one of them is unit-tested against real
//  clangd responses (test/fixtures/lsp-*.json).
//
//    1. FLATTENING   Location / SymbolInformation / hierarchy item / call / edit /
//                    code action / completion item  ->  small plain rows
//    2. EVIDENCE     what a probe got back, in one shape for every probe type
//    3. JUDGES       evidence + the recipe's "expect"  ->  { pass, reason }
//    4. PATH TWINS   the same symbol coming back from two copies of one file
// ============================================================================

import { hasPathSuffix, normalizePath, pathKey, uriToPath } from "./paths.mjs";

// ============================================================================
//  1. FLATTENING
// ============================================================================

/**
 * Flatten whatever textDocument/definition (or references, implementation) returned (null,
 * Location, Location[], LocationLink[]) into plain {path, line, character} rows.
 * Non-file URIs are dropped.
 * @param {any} result
 * @returns {{path: string, line: number, character: number}[]}
 */
export function normalizeLocations(result) {
  if (!result) return [];
  const rows = [];
  for (const item of Array.isArray(result) ? result : [result]) {
    const uri = item?.targetUri ?? item?.uri;
    const range = item?.targetSelectionRange ?? item?.targetRange ?? item?.range;
    const file = fileOfUri(uri);
    if (file) rows.push({ path: file, line: range?.start?.line ?? 0, character: range?.start?.character ?? 0 });
  }
  return rows;
}

/**
 * Flatten a workspace/symbol result (SymbolInformation[] or WorkspaceSymbol[]).
 * @param {any} result
 * @returns {{name: string, path: string, line: number, container: string}[]}
 */
export function normalizeSymbols(result) {
  if (!Array.isArray(result)) return [];
  const rows = [];
  for (const item of result) {
    const file = fileOfUri(item?.location?.uri);
    if (file) rows.push({ name: String(item.name ?? ""), path: file, line: item.location.range?.start?.line ?? 0, container: String(item.containerName ?? "") });
  }
  return rows;
}

/**
 * Flatten TypeHierarchyItem[] or CallHierarchyItem[] (what the prepare and subtypes requests return).
 * @param {any} result
 * @returns {{name: string, path: string, line: number}[]}
 */
export function normalizeHierarchyItems(result) {
  if (!Array.isArray(result)) return [];
  const rows = [];
  for (const item of result) {
    const file = fileOfUri(item?.uri);
    if (file) rows.push({ name: String(item.name ?? ""), path: file, line: item.selectionRange?.start?.line ?? item.range?.start?.line ?? 0 });
  }
  return rows;
}

/**
 * Flatten CallHierarchyIncomingCall[]: one row per caller, in the caller's file.
 * @param {any} result
 * @returns {{name: string, path: string, line: number, calls: number}[]}  calls = how many call sites that caller has
 */
export function normalizeIncomingCalls(result) {
  if (!Array.isArray(result)) return [];
  const rows = [];
  for (const item of result) {
    const [caller] = normalizeHierarchyItems([item?.from]);
    if (caller) rows.push({ ...caller, calls: Array.isArray(item.fromRanges) ? item.fromRanges.length : 0 });
  }
  return rows;
}

/**
 * Count what a WorkspaceEdit would change, without changing anything. Handles both shapes:
 * `changes` (uri -> TextEdit[]) and `documentChanges` (TextDocumentEdit[], file operations ignored).
 *
 * clangd can name one file under two URI spellings (the drive letter in "D:" and "d:"), so
 * `files` counts distinct files while `spellings` has the file paths as spelled, one per URI.
 * @param {any} edit
 * @returns {{edits: number, files: string[], spellings: {path: string}[]}}  files: distinct paths, first spelling kept
 */
export function summariseWorkspaceEdit(edit) {
  const perUri = new Map(); // uri -> edit count
  const add = (uri, count) => perUri.set(uri, (perUri.get(uri) ?? 0) + count);
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) add(uri, Array.isArray(edits) ? edits.length : 0);
  for (const change of edit?.documentChanges ?? []) {
    if (change?.textDocument?.uri && Array.isArray(change.edits)) add(change.textDocument.uri, change.edits.length);
  }
  const rows = [];
  let edits = 0;
  for (const [uri, count] of perUri) {
    const file = fileOfUri(uri);
    if (!file) continue;
    rows.push({ path: file });
    edits += count;
  }
  return { edits, files: distinctPaths(rows), spellings: rows };
}

/**
 * Flatten a textDocument/codeAction result (Command | CodeAction)[] to titles and kinds.
 * @param {any} result
 * @returns {{title: string, kind: string}[]}
 */
export function normalizeCodeActions(result) {
  if (!Array.isArray(result)) return [];
  return result.filter((item) => typeof item?.title === "string").map((item) => ({ title: item.title, kind: String(item.kind ?? "") }));
}

/**
 * Flatten a textDocument/completion result (CompletionItem[] or CompletionList).
 * `name` is the identifier the item inserts: filterText when clangd gives one, else the label
 * with clangd's decoration removed. clangd labels start with a space (or a bullet when the item
 * would add an include) and carry the signature: " Size() const", "•Dog".
 * @param {any} result
 * @returns {{label: string, name: string, kind: number}[]}
 */
export function normalizeCompletion(result) {
  const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];
  const undecorated = (label) => {
    const bare = label.replace(/^[\s•]+/, "");
    return /^[~\w]+/.exec(bare)?.[0] ?? bare;
  };
  return items
    .filter((item) => typeof item?.label === "string")
    .map((item) => ({ label: item.label, name: String(item.filterText ?? undecorated(item.label)), kind: item.kind ?? 0 }));
}

/**
 * Does any result live in a file whose path ends with `suffix`?
 * @param {{path: string}[]} rows
 * @param {string} suffix
 * @returns {boolean}
 */
export function anyMatchesSuffix(rows, suffix) {
  return rows.some((row) => hasPathSuffix(row.path, suffix));
}

/**
 * The distinct files among some rows, compared case-insensitively, in first-seen order.
 * @param {{path: string}[]} rows
 * @returns {string[]}
 */
export function distinctPaths(rows) {
  const seen = new Map();
  for (const row of rows) if (!seen.has(pathKey(row.path))) seen.set(pathKey(row.path), row.path);
  return [...seen.values()];
}

/**
 * clangd can name one file under two spellings (the drive letter in "D:/x" and "d:/x"), which an
 * editor would show as two files. Returns { uris: n } when some file came back under more than one
 * spelling, n being the number of distinct spellings; {} otherwise.
 * @param {{path: string}[]} rows
 * @returns {{uris?: number}}
 */
export function spellingCounts(rows) {
  const spellings = new Set(rows.map((row) => row.path)).size;
  return spellings > distinctPaths(rows).length ? { uris: spellings } : {};
}

/** @param {any} uri @returns {string} the file path, or "" for anything that is not a file: URI */
function fileOfUri(uri) {
  if (typeof uri !== "string") return "";
  try {
    return uriToPath(uri);
  } catch {
    return "";
  }
}

// ============================================================================
//  2. EVIDENCE: what a probe got back
// ============================================================================

/**
 * One shape for every probe type, so the judges, the report and report.json treat them alike.
 * @typedef {object} Evidence
 * @property {string} problem   non-empty when the request chain did not produce an answer (clangd refused, nothing at the token)
 * @property {string[]} files   distinct files that came back (references, subtypes, callers, edited files, ...)
 * @property {string[]} labels  names that came back (subtype names, caller names, action titles, completion names)
 * @property {Record<string, number>} counts   type-specific numbers: locations, edits, items, ...
 */

/** @returns {Evidence} */
export function emptyEvidence() {
  return { problem: "", files: [], labels: [], counts: {} };
}

/**
 * @param {string} problem
 * @returns {Evidence}
 */
export function problemEvidence(problem) {
  return { ...emptyEvidence(), problem };
}

/**
 * Keep report.json small: at most `limit` files and labels; counts say how many there were.
 * @param {Evidence} evidence
 * @param {number} [limit]
 * @returns {Evidence}
 */
export function capEvidence(evidence, limit = 50) {
  return { ...evidence, files: evidence.files.slice(0, limit), labels: evidence.labels.slice(0, limit) };
}

// ============================================================================
//  3. JUDGES
// ============================================================================

/**
 * @typedef {{pass: boolean, reason: string}} Verdict
 */

/**
 * The files that came back must include every suffix, and be at least `minFiles` of them.
 * Used by references, implementation, type hierarchy, incoming calls and rename.
 * @param {Evidence} evidence
 * @param {{mustIncludeFileSuffixes?: string[], minFiles?: number}} expect
 * @returns {Verdict}
 */
export function judgeFiles(evidence, { mustIncludeFileSuffixes = [], minFiles = 0 }) {
  if (evidence.problem) return { pass: false, reason: evidence.problem };
  if (evidence.files.length === 0) return { pass: false, reason: "no result" };

  const problems = [];
  const missing = mustIncludeFileSuffixes.filter((suffix) => !evidence.files.some((file) => hasPathSuffix(file, suffix)));
  if (missing.length > 0) problems.push(`missing ...${missing.join(", ...")}`);
  if (evidence.files.length < minFiles) problems.push(`${evidence.files.length} file(s), expected at least ${minFiles}`);
  return problems.length === 0 ? { pass: true, reason: "" } : { pass: false, reason: problems.join("; ") };
}

/**
 * Some code action's title must contain the text (case-insensitive).
 * @param {Evidence} evidence
 * @param {{titleIncludes: string}} expect
 * @returns {Verdict}
 */
export function judgeCodeAction(evidence, { titleIncludes }) {
  if (evidence.problem) return { pass: false, reason: evidence.problem };
  if (evidence.labels.length === 0) return { pass: false, reason: "no code actions offered" };
  const wanted = titleIncludes.toLowerCase();
  return evidence.labels.some((title) => title.toLowerCase().includes(wanted)) ? { pass: true, reason: "" } : { pass: false, reason: `no action title contains "${titleIncludes}"` };
}

/**
 * Every wanted name must be among the completion items (exact, case-sensitive: the identifier that would be inserted).
 * @param {Evidence} evidence
 * @param {{labelsInclude: string[]}} expect
 * @returns {Verdict}
 */
export function judgeCompletion(evidence, { labelsInclude }) {
  if (evidence.problem) return { pass: false, reason: evidence.problem };
  if (evidence.labels.length === 0) return { pass: false, reason: "no completion items" };
  const missing = labelsInclude.filter((name) => !evidence.labels.includes(name));
  return missing.length === 0 ? { pass: true, reason: "" } : { pass: false, reason: `missing ${missing.join(", ")}` };
}

// ============================================================================
//  4. PATH TWINS: one file under two roots
// ============================================================================

/** Two paths are "the same file under different roots" when they share at least this many trailing segments (name + 2 folders). */
export const MIN_TWIN_TAIL_SEGMENTS = 3;

/**
 * How many trailing path segments two paths share (case-insensitive).
 * "a/Code/AzCore/Entity.h" and "b/x/Code/AzCore/Entity.h" share 3.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function commonTailSegments(a, b) {
  const left = pathKey(normalizePath(a)).split("/");
  const right = pathKey(normalizePath(b)).split("/");
  let shared = 0;
  while (shared < left.length && shared < right.length && left[left.length - 1 - shared] === right[right.length - 1 - shared]) shared++;
  return shared;
}

/**
 * Pairs of results that name the same symbol (same name and container) in two different files
 * whose paths end the same way under different roots, e.g. the SDK copy and the surrogate
 * copy of one header. clangd then has two symbols where the user sees one, and F12 or Ctrl+T
 * can land in the copy that is not the one being edited.
 * @param {{name: string, container: string, path: string}[]} rows  all rows of one workspace/symbol query
 * @param {number} [minTail]
 * @returns {{name: string, container: string, a: string, b: string, tail: number}[]}
 */
export function findPathTwins(rows, minTail = MIN_TWIN_TAIL_SEGMENTS) {
  /** @type {Map<string, {name: string, container: string, paths: Map<string, string>}>} */
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.container}\0${row.name}`;
    if (!groups.has(key)) groups.set(key, { name: row.name, container: row.container, paths: new Map() });
    groups.get(key).paths.set(pathKey(row.path), row.path);
  }

  const twins = [];
  for (const { name, container, paths } of groups.values()) {
    const files = [...paths.values()];
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const tail = commonTailSegments(files[i], files[j]);
        if (tail >= minTail) twins.push({ name, container, a: files[i], b: files[j], tail });
      }
    }
  }
  return twins;
}
