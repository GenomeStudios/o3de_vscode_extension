// ============================================================================
//  probeTypes.mjs - the relationship probes
//
//  A probe's "type" is which LSP question is asked at the token:
//
//    definition      (default, in nav.mjs)  textDocument/definition
//    references      textDocument/references
//    implementation  textDocument/implementation
//    typeHierarchy   prepareTypeHierarchy, then typeHierarchy/subtypes (two levels)
//    incomingCalls   prepareCallHierarchy, then callHierarchy/incomingCalls
//    rename          prepareRename, then rename - the WorkspaceEdit is only counted, NEVER applied
//    codeAction      textDocument/codeAction over the token's range
//    completion      textDocument/completion at the cursor
//
//  Each type here has three parts: describe() (the expectation in words, for the report),
//  fetch() (ask clangd, return Evidence) and judge() (Evidence + expect -> pass/fail).
//  fetch() needs only a client with request(method, params, timeoutMs), so the tests drive it
//  with a stub. All of them need the background index to answer across files.
// ============================================================================

import {
  distinctPaths,
  emptyEvidence,
  judgeCodeAction,
  judgeCompletion,
  judgeFiles,
  normalizeCodeActions,
  normalizeCompletion,
  normalizeHierarchyItems,
  normalizeIncomingCalls,
  normalizeLocations,
  problemEvidence,
  spellingCounts,
  summariseWorkspaceEdit,
} from "./lspResults.mjs";

/** Suffix added to the token for the rename dry run: "Area" -> "Area_BenchRename". */
export const RENAME_SUFFIX = "_BenchRename";

/** Type hierarchy: how many first-level subtypes are expanded to a second level (keeps the probe cheap). */
export const MAX_EXPANDED_SUBTYPES = 10;

/** Call hierarchy: how many prepared items are followed (clangd normally returns one). */
const MAX_CALL_ITEMS = 3;

// ============================================================================
//  CONTEXT AND HELPERS
// ============================================================================

/**
 * What fetch() is given.
 * @typedef {object} ProbeContext
 * @property {{request: (method: string, params: any, timeoutMs?: number) => Promise<any>}} client
 * @property {string} uri
 * @property {{line: number, character: number}} position   the probe position (after the token for completion)
 * @property {{start: {line: number, character: number}, end: {line: number, character: number}}} range   the token itself
 * @property {string} token
 * @property {any[]} diagnostics   what clangd last published for the file
 * @property {number} requestMs
 */

/**
 * Ask clangd. A clangd error reply ("cannot rename here") is an ANSWER, returned as `refusal`.
 * A timeout or a dead server still throws, so the probe is recorded as "could not run".
 * @param {ProbeContext} ctx
 * @param {string} method
 * @param {any} params
 * @returns {Promise<{result?: any, refusal?: string}>}
 */
async function ask(ctx, method, params) {
  try {
    return { result: await ctx.client.request(method, params, ctx.requestMs) };
  } catch (err) {
    if (err?.rpcError) return { refusal: `clangd refused ${method}: ${err.rpcError.message ?? err.message}` };
    throw err;
  }
}

/** @param {ProbeContext} ctx */
const documentAt = (ctx) => ({ textDocument: { uri: ctx.uri }, position: ctx.position });

/** Evidence for a request that answers with locations. */
function locationEvidence(result) {
  const rows = normalizeLocations(result);
  const files = distinctPaths(rows);
  return { ...emptyEvidence(), files, counts: { locations: rows.length, files: files.length, ...spellingCounts(rows) } };
}

// ============================================================================
//  THE TYPES
// ============================================================================

/** @param {string[]} list */
const suffixes = (list) => list.map((s) => `...${s}`).join(", ");

/** Phrase for an expect that is a file list plus an optional file count. */
function describeFiles({ mustIncludeFileSuffixes = [], minFiles = 0 }) {
  const parts = [];
  if (mustIncludeFileSuffixes.length > 0) parts.push(`includes ${suffixes(mustIncludeFileSuffixes)}`);
  if (minFiles > 0) parts.push(`at least ${minFiles} files`);
  return parts.join("; ");
}

/** Each type: { describe(expect), fetch(ctx) -> Evidence, judge(evidence, expect) -> Verdict }. */
export const PROBE_TYPES = {
  references: {
    describe: describeFiles,
    async fetch(ctx) {
      const answer = await ask(ctx, "textDocument/references", { ...documentAt(ctx), context: { includeDeclaration: false } });
      return answer.refusal ? problemEvidence(answer.refusal) : locationEvidence(answer.result);
    },
    judge: judgeFiles,
  },

  implementation: {
    describe: describeFiles,
    async fetch(ctx) {
      const answer = await ask(ctx, "textDocument/implementation", documentAt(ctx));
      return answer.refusal ? problemEvidence(answer.refusal) : locationEvidence(answer.result);
    },
    judge: judgeFiles,
  },

  // subtypes of the class at the token: one level, then (cheaply) a second level
  typeHierarchy: {
    describe: ({ subtypeFileSuffixes }) => `subtypes in ${suffixes(subtypeFileSuffixes)}`,
    async fetch(ctx) {
      const prepared = await ask(ctx, "textDocument/prepareTypeHierarchy", documentAt(ctx));
      if (prepared.refusal) return problemEvidence(prepared.refusal);
      const roots = Array.isArray(prepared.result) ? prepared.result : [];
      if (roots.length === 0) return problemEvidence("prepareTypeHierarchy returned nothing at the token");

      const subtypesOf = async (items) => {
        const found = [];
        for (const item of items) {
          const answer = await ask(ctx, "typeHierarchy/subtypes", { item });
          if (Array.isArray(answer.result)) found.push(...answer.result);
        }
        return found;
      };
      const level1 = await subtypesOf(roots);
      const level2 = await subtypesOf(level1.slice(0, MAX_EXPANDED_SUBTYPES));

      const rows = normalizeHierarchyItems([...level1, ...level2]);
      const files = distinctPaths(rows);
      return { ...emptyEvidence(), files, labels: rows.map((r) => r.name), counts: { level1: level1.length, level2: level2.length, files: files.length } };
    },
    judge: (evidence, { subtypeFileSuffixes }) => judgeFiles(evidence, { mustIncludeFileSuffixes: subtypeFileSuffixes }),
  },

  incomingCalls: {
    describe: describeFiles,
    async fetch(ctx) {
      const prepared = await ask(ctx, "textDocument/prepareCallHierarchy", documentAt(ctx));
      if (prepared.refusal) return problemEvidence(prepared.refusal);
      const items = Array.isArray(prepared.result) ? prepared.result.slice(0, MAX_CALL_ITEMS) : [];
      if (items.length === 0) return problemEvidence("prepareCallHierarchy returned nothing at the token");

      const callers = [];
      for (const item of items) {
        const answer = await ask(ctx, "callHierarchy/incomingCalls", { item });
        if (answer.refusal) return problemEvidence(answer.refusal);
        callers.push(...normalizeIncomingCalls(answer.result));
      }
      const files = distinctPaths(callers);
      return { ...emptyEvidence(), files, labels: callers.map((c) => c.name), counts: { callers: callers.length, files: files.length } };
    },
    judge: judgeFiles,
  },

  // The WorkspaceEdit is counted and then dropped. Nothing is applied, written or sent back to clangd.
  rename: {
    describe: describeFiles,
    async fetch(ctx) {
      const prepared = await ask(ctx, "textDocument/prepareRename", documentAt(ctx));
      if (prepared.refusal) return problemEvidence(prepared.refusal);
      if (!prepared.result) return problemEvidence("prepareRename returned nothing: clangd would not rename here");

      const renamed = await ask(ctx, "textDocument/rename", { ...documentAt(ctx), newName: `${ctx.token}${RENAME_SUFFIX}` });
      if (renamed.refusal) return problemEvidence(renamed.refusal);
      const edit = summariseWorkspaceEdit(renamed.result);
      return { ...emptyEvidence(), files: edit.files, counts: { edits: edit.edits, files: edit.files.length, ...spellingCounts(edit.spellings) } };
    },
    judge: judgeFiles,
  },

  codeAction: {
    describe: ({ titleIncludes }) => `an action titled like "${titleIncludes}"`,
    async fetch(ctx) {
      // context.diagnostics: what clangd published for the file (an editor sends the ones under the cursor); no "only" filter
      const answer = await ask(ctx, "textDocument/codeAction", { textDocument: { uri: ctx.uri }, range: ctx.range, context: { diagnostics: ctx.diagnostics } });
      if (answer.refusal) return problemEvidence(answer.refusal);
      const actions = normalizeCodeActions(answer.result);
      return { ...emptyEvidence(), labels: actions.map((a) => a.title), counts: { actions: actions.length } };
    },
    judge: judgeCodeAction,
  },

  completion: {
    describe: ({ labelsInclude }) => `completions include ${labelsInclude.join(", ")}`,
    async fetch(ctx) {
      const answer = await ask(ctx, "textDocument/completion", { ...documentAt(ctx), context: { triggerKind: 1 } });
      if (answer.refusal) return problemEvidence(answer.refusal);
      const items = normalizeCompletion(answer.result);
      return { ...emptyEvidence(), labels: [...new Set(items.map((i) => i.name))], counts: { items: items.length } };
    },
    judge: judgeCompletion,
  },
};

/** Every probe type, definition first, in the order the report lists them. */
export const PROBE_TYPE_NAMES = ["definition", ...Object.keys(PROBE_TYPES)];

/** The relationship types: everything but definition. */
export const RELATION_TYPE_NAMES = Object.keys(PROBE_TYPES);

/** What the report calls each capability. */
export const CAPABILITY_LABELS = {
  definition: "go to definition (F12)",
  references: "find references",
  implementation: "go to implementation",
  typeHierarchy: "type hierarchy (subtypes)",
  incomingCalls: "call hierarchy (incoming calls)",
  rename: "rename (dry run)",
  codeAction: "code actions (lightbulb)",
  completion: "completion",
  workspaceSymbol: "workspace symbol (Ctrl+T)",
};

/**
 * The expectation of a relationship probe in words.
 * @param {string} type
 * @param {any} expect
 * @returns {string}
 */
export function describeExpect(type, expect) {
  return PROBE_TYPES[type].describe(expect);
}
