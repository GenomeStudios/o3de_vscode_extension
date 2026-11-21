// ============================================================================
//  recipe.mjs - load and validate a benchmark recipe
//
//  A recipe is one JSON file that names the project, how its files fall into
//  "parts", the compile databases to compare (variants), the files to sample,
//  and the navigation probes. See README.md for the full format.
//
//  The recipe hash is sha256(recipe text + every variant's compile DB). Two runs
//  with the same hash measured the same inputs.
// ============================================================================

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizePath } from "./paths.mjs";
import { PROBE_TYPE_NAMES } from "./probeTypes.mjs";

/**
 * @typedef {object} Variant
 * @property {string} name
 * @property {string} db            absolute path of the compile_commands.json to measure
 * @property {string[]} extraArgs   extra clangd command-line arguments
 *
 * @typedef {object} Probe
 * @property {string} id
 * @property {"definition" | "references" | "implementation" | "typeHierarchy" | "incomingCalls" | "rename" | "codeAction" | "completion"} type
 *   which LSP question is asked at the token (default "definition"); see probeTypes.mjs
 * @property {string} part
 * @property {string} category
 * @property {string} file
 * @property {string} anchor        substring unique in the file, on the probe line
 * @property {string} token         text on that line the probe is placed on (an identifier, or "->" / "::" for completion)
 * @property {number} [occurrence]  which match of token on the line (0-based, default 0)
 * @property {boolean} afterToken   completion only: put the cursor just after the token instead of at its start
 * @property {ProbeExpect} expect   which fields are set depends on the type, see normalizeProbeExpect
 * @property {boolean} expectedBuilt  false when the probe file's gem is not part of this build
 *
 * @typedef {object} ProbeExpect
 * @property {string} [fileSuffix]                   definition
 * @property {"definition" | "any"} [kind]           definition
 * @property {string[]} [mustIncludeFileSuffixes]    references, implementation, incomingCalls, rename
 * @property {number} [minFiles]                     references, rename
 * @property {string[]} [subtypeFileSuffixes]        typeHierarchy
 * @property {string} [titleIncludes]                codeAction
 * @property {string[]} [labelsInclude]              completion
 *
 * @typedef {object} Recipe
 * @property {string} name
 * @property {string} clangd
 * @property {string} workDir
 * @property {string} project
 * @property {Record<string, string[]>} parts          ordered: first matching prefix wins
 * @property {string[]} excludeDirs
 * @property {Variant[]} variants
 * @property {{perPart: number, extraFiles: string[]}} sample
 * @property {Probe[]} probes
 * @property {{query: string, expectFileSuffix: string}[]} symbols
 * @property {{checkTimeoutSec: number, checkConcurrency: number, indexWaitMin: number, jobs: number, diagnosticsWaitSec: number}} limits
 * @property {{dbSubset: {neighbours: number} | null}} nav   dbSubset: give the nav stage a reduced compile DB so its index can finish (null = the full DB)
 */

export const DEFAULT_LIMITS = {
  checkTimeoutSec: 180,
  checkConcurrency: 3,
  indexWaitMin: 30,
  jobs: 4,
  diagnosticsWaitSec: 60,
};

/** How many extra entries per folder a "nav.dbSubset": true keeps beside the files the probes need. */
export const DEFAULT_SUBSET_NEIGHBOURS = 2;

// ============================================================================
//  LOADING
// ============================================================================

/**
 * Read, validate and normalise a recipe file.
 * @param {string} recipeFile
 * @returns {{recipe: Recipe, hash: string, text: string, file: string}}
 */
export function loadRecipe(recipeFile) {
  const file = normalizePath(path.resolve(recipeFile));
  const text = fs.readFileSync(file, "utf8");
  const recipe = parseRecipeText(text);
  return { recipe, text, file, hash: recipeHash(text, recipe.variants) };
}

/**
 * Parse recipe JSON text (comments allowed), validate it and return the normalised recipe.
 * @param {string} text
 * @returns {Recipe}
 */
export function parseRecipeText(text) {
  let raw;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (err) {
    throw new Error(`Recipe is not valid JSON: ${err.message}`);
  }
  return normalizeRecipe(raw);
}

/**
 * Remove // and block comments that sit outside strings, so recipes can carry notes.
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      // copy a whole string literal, honouring escapes
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// ============================================================================
//  VALIDATION AND NORMALISING
// ============================================================================

/**
 * @param {any} raw
 * @returns {Recipe}
 */
export function normalizeRecipe(raw) {
  /** @type {string[]} */
  const errors = [];
  const fail = (msg) => errors.push(msg);
  const isStr = (v) => typeof v === "string" && v.length > 0;
  const isAbs = (v) => isStr(v) && path.isAbsolute(v);
  const absPath = (v, what) => {
    if (!isAbs(v)) {
      fail(`${what} must be an absolute path, got ${JSON.stringify(v)}`);
      return "";
    }
    return normalizePath(v);
  };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Recipe must be a JSON object");

  if (!isStr(raw.name) || !/^[A-Za-z0-9._-]+$/.test(raw.name)) fail('"name" must be a file-name-safe string');
  if (!isStr(raw.clangd)) fail('"clangd" must be a path');
  const workDir = absPath(raw.workDir, '"workDir"');
  const project = absPath(raw.project, '"project"');

  // parts: ordered map of part name -> folder list
  /** @type {Record<string, string[]>} */
  const parts = {};
  if (!raw.parts || typeof raw.parts !== "object" || Array.isArray(raw.parts) || Object.keys(raw.parts).length === 0) {
    fail('"parts" must be an object with at least one part');
  } else {
    for (const [partName, folders] of Object.entries(raw.parts)) {
      if (!Array.isArray(folders)) {
        fail(`part "${partName}" must be an array of folders`);
        continue;
      }
      parts[partName] = folders.map((f) => absPath(f, `part "${partName}" folder`));
    }
  }

  const excludeDirs = (raw.excludeDirs ?? []).map((d) => `/${normalizePath(String(d)).replace(/^\/+|\/+$/g, "")}/`);

  // variants
  /** @type {Variant[]} */
  const variants = [];
  if (!Array.isArray(raw.variants) || raw.variants.length === 0) {
    fail('"variants" must be a non-empty array');
  } else {
    const seen = new Set();
    for (const v of raw.variants) {
      if (!isStr(v?.name) || !/^[A-Za-z0-9._-]+$/.test(v.name)) {
        fail(`variant name must be a file-name-safe string, got ${JSON.stringify(v?.name)}`);
        continue;
      }
      if (seen.has(v.name)) fail(`duplicate variant name "${v.name}"`);
      seen.add(v.name);
      const extraArgs = Array.isArray(v.extraArgs) ? v.extraArgs.map(String) : [];
      if (extraArgs.some((a) => a.startsWith("--compile-commands-dir"))) {
        fail(`variant "${v.name}": extraArgs must not set --compile-commands-dir (the harness points clangd at its own copy)`);
      }
      variants.push({ name: v.name, db: absPath(v.db, `variant "${v.name}" db`), extraArgs });
    }
  }

  // sample
  const sample = {
    perPart: Number.isInteger(raw.sample?.perPart) ? raw.sample.perPart : 8,
    extraFiles: (raw.sample?.extraFiles ?? []).map((f) => absPath(f, "sample.extraFiles entry")),
  };
  if (sample.perPart < 0) fail('"sample.perPart" must be >= 0');

  // probes
  /** @type {Probe[]} */
  const probes = [];
  const probeIds = new Set();
  for (const p of raw.probes ?? []) {
    const label = `probe "${p?.id}"`;
    if (!isStr(p?.id)) {
      fail("every probe needs an id");
      continue;
    }
    if (probeIds.has(p.id)) fail(`duplicate probe id "${p.id}"`);
    probeIds.add(p.id);
    if (!(p.part in parts)) fail(`${label}: part "${p.part}" is not one of the recipe parts`);
    for (const key of ["category", "anchor", "token"]) if (!isStr(p[key])) fail(`${label}: "${key}" is required`);
    const type = p.type ?? "definition";
    if (!PROBE_TYPE_NAMES.includes(type)) fail(`${label}: type must be one of ${PROBE_TYPE_NAMES.join(", ")}, got ${JSON.stringify(p.type)}`);
    if (p.afterToken !== undefined && (typeof p.afterToken !== "boolean" || type !== "completion")) fail(`${label}: afterToken is a boolean, and only for completion probes`);
    probes.push({
      id: p.id,
      type,
      part: p.part,
      category: p.category,
      file: absPath(p.file, `${label} file`),
      anchor: p.anchor,
      token: p.token,
      occurrence: Number.isInteger(p.occurrence) ? p.occurrence : 0,
      afterToken: p.afterToken === true,
      expect: normalizeProbeExpect(type, p.expect, label, fail),
      expectedBuilt: p.expectedBuilt !== false,
    });
  }

  // symbols
  const symbols = [];
  for (const s of raw.symbols ?? []) {
    if (!isStr(s?.query) || !isStr(s?.expectFileSuffix)) {
      fail("every symbol needs query and expectFileSuffix");
      continue;
    }
    symbols.push({ query: s.query, expectFileSuffix: s.expectFileSuffix });
  }

  const limits = { ...DEFAULT_LIMITS, ...(raw.limits ?? {}) };
  for (const [key, value] of Object.entries(limits)) {
    if (typeof value !== "number" || !(value > 0)) fail(`limits.${key} must be a positive number`);
  }

  // nav.dbSubset: true, or { neighbours: n }; absent or false means the full DB
  /** @type {Recipe["nav"]["dbSubset"]} */
  let dbSubset = null;
  const rawSubset = raw.nav?.dbSubset;
  if (rawSubset === true) {
    dbSubset = { neighbours: DEFAULT_SUBSET_NEIGHBOURS };
  } else if (rawSubset && typeof rawSubset === "object" && !Array.isArray(rawSubset)) {
    const neighbours = rawSubset.neighbours ?? DEFAULT_SUBSET_NEIGHBOURS;
    if (!Number.isInteger(neighbours) || neighbours < 0) fail('"nav.dbSubset.neighbours" must be an integer >= 0');
    dbSubset = { neighbours };
  } else if (rawSubset !== undefined && rawSubset !== false) {
    fail('"nav.dbSubset" must be true, false or an object like { "neighbours": 2 }');
  }

  if (errors.length > 0) throw new Error(`Invalid recipe:\n  - ${errors.join("\n  - ")}`);

  return { name: raw.name, clangd: raw.clangd, workDir, project, parts, excludeDirs, variants, sample, probes, symbols, limits, nav: { dbSubset } };
}

// ============================================================================
//  PROBE EXPECTATIONS
// ============================================================================

/**
 * Check and normalise a probe's "expect" for its type. Problems go to `fail`.
 *
 *   definition      fileSuffix, kind ("definition" | "any", default "any")
 *   references      mustIncludeFileSuffixes and/or minFiles
 *   implementation  mustIncludeFileSuffixes
 *   typeHierarchy   subtypeFileSuffixes
 *   incomingCalls   mustIncludeFileSuffixes
 *   rename          minFiles, mustIncludeFileSuffixes (optional)
 *   codeAction      titleIncludes
 *   completion      labelsInclude
 * @param {string} type
 * @param {any} expect
 * @param {string} label  "probe <id>", for messages
 * @param {(message: string) => void} fail
 * @returns {ProbeExpect}
 */
function normalizeProbeExpect(type, expect, label, fail) {
  const raw = expect ?? {};
  const isText = (v) => typeof v === "string" && v.length > 0;
  const list = (key, required) => {
    if (raw[key] === undefined && !required) return [];
    if (!Array.isArray(raw[key]) || raw[key].length === 0 || !raw[key].every(isText)) {
      fail(`${label}: expect.${key} must be a non-empty array of strings`);
      return [];
    }
    return raw[key].map(String);
  };
  const count = (key, required) => {
    if (raw[key] === undefined && !required) return 0;
    if (!Number.isInteger(raw[key]) || raw[key] < 1) {
      fail(`${label}: expect.${key} must be an integer >= 1`);
      return 0;
    }
    return raw[key];
  };

  switch (type) {
    case "references": {
      const expected = { mustIncludeFileSuffixes: list("mustIncludeFileSuffixes", false), minFiles: count("minFiles", false) };
      if (expected.mustIncludeFileSuffixes.length === 0 && expected.minFiles === 0) fail(`${label}: a references probe needs expect.mustIncludeFileSuffixes and/or expect.minFiles`);
      return expected;
    }
    case "implementation":
    case "incomingCalls":
      return { mustIncludeFileSuffixes: list("mustIncludeFileSuffixes", true) };
    case "typeHierarchy":
      return { subtypeFileSuffixes: list("subtypeFileSuffixes", true) };
    case "rename":
      return { mustIncludeFileSuffixes: list("mustIncludeFileSuffixes", false), minFiles: count("minFiles", true) };
    case "codeAction":
      if (!isText(raw.titleIncludes)) fail(`${label}: expect.titleIncludes is required`);
      return { titleIncludes: String(raw.titleIncludes ?? "") };
    case "completion":
      return { labelsInclude: list("labelsInclude", true) };
    default: {
      // definition (an unknown type was already reported)
      if (!isText(raw.fileSuffix)) fail(`${label}: expect.fileSuffix is required`);
      const kind = raw.kind ?? "any";
      if (kind !== "definition" && kind !== "any") fail(`${label}: expect.kind must be "definition" or "any"`);
      return { fileSuffix: raw.fileSuffix, kind };
    }
  }
}

/**
 * Every file suffix a probe expects to see in an answer, whatever its type. The nav subset keeps the
 * compile-DB entries for these files so the background index can reach them.
 * @param {{expect?: ProbeExpect}} probe
 * @returns {string[]}
 */
export function expectedSuffixes(probe) {
  const expect = probe.expect ?? {};
  return [expect.fileSuffix, ...(expect.mustIncludeFileSuffixes ?? []), ...(expect.subtypeFileSuffixes ?? [])].filter((s) => typeof s === "string" && s.length > 0);
}

// ============================================================================
//  HASH
// ============================================================================

/**
 * sha256 over the recipe text and every variant's compile database bytes.
 * @param {string} text
 * @param {Variant[]} variants
 * @returns {string} hex digest
 */
export function recipeHash(text, variants) {
  const hash = crypto.createHash("sha256");
  hash.update(text);
  for (const v of variants) {
    hash.update(`\0${v.name}\0`);
    let bytes;
    try {
      bytes = fs.readFileSync(v.db);
    } catch (err) {
      throw new Error(`Variant "${v.name}": cannot read compile DB ${v.db}: ${err.message}`);
    }
    hash.update(bytes);
  }
  return hash.digest("hex");
}
