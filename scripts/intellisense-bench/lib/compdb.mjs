// ============================================================================
//  compdb.mjs - compile database, part classification, coverage and sampling
//
//  A "part" is a named group of folders (project, gems, engine source, SDK ...).
//  Each file is classified into the FIRST part whose folder is a prefix of it.
//  Coverage answers: of the .cpp files on disk in a part, how many have an entry
//  in the compile database? A file without an entry gets no real IntelliSense.
//
//  Also here: the check sample (one per run, shared by every variant) and the
//  reduced "navigation subset" of a compile database.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { extOf, hasPathSuffix, isUnder, normalizePath, pathKey } from "./paths.mjs";
import { expectedSuffixes } from "./recipe.mjs";

export const OTHER_PART = "other";
export const SOURCE_EXTENSIONS = new Set([".cpp", ".cxx", ".cc"]);

/**
 * @typedef {object} DbEntry
 * @property {string} file       normalised absolute path
 * @property {string} directory  working directory recorded in the entry
 *
 * @typedef {(file: string) => string} Classifier
 */

// ============================================================================
//  LOADING
// ============================================================================

/**
 * Read a compile_commands.json as it is: the JSON entries that name a file, untouched.
 * @param {string} dbPath
 * @returns {{file: string, directory?: string}[]}
 */
export function loadRawCompileDb(dbPath) {
  const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${dbPath}: a compile database must be a JSON array`);
  return raw.filter((e) => e && typeof e.file === "string");
}

/**
 * The normalised absolute path a raw entry names. A relative "file" is resolved against "directory".
 * @param {{file: string, directory?: string}} raw
 * @returns {string}
 */
export function entryFilePath(raw) {
  const directory = normalizePath(raw.directory ?? "");
  const isRelative = !/^([A-Za-z]:)?[\\/]/.test(raw.file);
  return normalizePath(isRelative ? `${directory}/${raw.file}` : raw.file);
}

/**
 * Load a compile_commands.json as normalised entries.
 * @param {string} dbPath
 * @returns {DbEntry[]}
 */
export function loadCompileDb(dbPath) {
  return loadRawCompileDb(dbPath).map((raw) => ({ directory: normalizePath(raw.directory ?? ""), file: entryFilePath(raw) }));
}

/**
 * One path per distinct file (a file built for two targets has two entries).
 * Sorted by comparison key, so the order never depends on the DB's own order.
 * @param {DbEntry[]} entries
 * @returns {string[]}
 */
export function distinctFiles(entries) {
  const byKey = new Map();
  for (const e of entries) if (!byKey.has(pathKey(e.file))) byKey.set(pathKey(e.file), e.file);
  return [...byKey.keys()].sort().map((key) => byKey.get(key));
}

// ============================================================================
//  CLASSIFICATION
// ============================================================================

/**
 * Build a classifier from ordered parts: first matching folder prefix wins.
 * @param {Record<string, string[]>} parts
 * @returns {Classifier}
 */
export function makeClassifier(parts) {
  const ordered = Object.entries(parts);
  return (file) => {
    for (const [name, roots] of ordered) {
      if (roots.some((root) => isUnder(file, root))) return name;
    }
    return OTHER_PART;
  };
}

// ============================================================================
//  ON-DISK COVERAGE
// ============================================================================

/**
 * List the source files on disk per part, skipping excluded folders.
 * A file nested under two part roots is listed only under the part that classifies it.
 * @param {Record<string, string[]>} parts
 * @param {string[]} excludeDirs  normalised as "/name/"
 * @param {Classifier} classify
 * @returns {Map<string, string[]>}
 */
export function scanDisk(parts, excludeDirs, classify) {
  const excludes = excludeDirs.map((d) => d.toLowerCase());
  /** @type {Map<string, string[]>} */
  const found = new Map();
  const visitedRoots = new Set();

  for (const [partName, roots] of Object.entries(parts)) {
    const files = [];
    for (const root of roots) {
      if (visitedRoots.has(pathKey(root))) continue;
      visitedRoots.add(pathKey(root));
      for (const file of walkSources(root, excludes)) {
        if (classify(file) === partName) files.push(file);
      }
    }
    found.set(partName, files);
  }
  return found;
}

/**
 * Walk a folder iteratively, yielding source files. Symlinks are not followed.
 * Exclusion patterns are tested against the path relative to the walked root.
 * @param {string} root
 * @param {string[]} excludes  lower-case "/name/" patterns
 * @returns {Generator<string>}
 */
function* walkSources(root, excludes) {
  const base = normalizePath(root);
  if (!fs.existsSync(base)) return;
  const stack = [base];
  while (stack.length > 0) {
    const dir = stack.pop();
    const relative = `${dir.slice(base.length)}/`.toLowerCase(); // "/sub/dir/"
    if (excludes.some((pattern) => relative.includes(pattern))) continue;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder
    }
    for (const item of items) {
      const full = `${dir}/${item.name}`;
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile() && SOURCE_EXTENSIONS.has(extOf(item.name))) yield full;
    }
  }
}

/**
 * Coverage of the on-disk source files by compile database entries, per part.
 * @param {DbEntry[]} entries
 * @param {Map<string, string[]>} onDisk  result of scanDisk()
 * @param {Classifier} classify
 * @param {string[]} partNames  recipe part order
 * @returns {Record<string, CoverageRow>}
 *
 * @typedef {object} CoverageRow
 * @property {number} onDisk         source files found on disk
 * @property {number} withEntries    of those, how many have a DB entry
 * @property {number | null} pct     withEntries / onDisk * 100 (null when nothing is on disk)
 * @property {number} dbEntries      DB entries classified into this part
 * @property {number} dbFiles        distinct files those entries name
 * @property {number} dbOnly         DB files not found by the disk scan (generated, or in excluded folders)
 * @property {string[]} missingSample  up to 15 on-disk files without an entry
 */
export function computeCoverage(entries, onDisk, classify, partNames) {
  const dbKeysByPart = new Map();
  const entryCount = new Map();
  for (const e of entries) {
    const part = classify(e.file);
    entryCount.set(part, (entryCount.get(part) ?? 0) + 1);
    if (!dbKeysByPart.has(part)) dbKeysByPart.set(part, new Set());
    dbKeysByPart.get(part).add(pathKey(e.file));
  }

  /** @type {Record<string, CoverageRow>} */
  const rows = {};
  for (const part of [...partNames, OTHER_PART]) {
    const diskFiles = onDisk.get(part) ?? [];
    const dbKeys = dbKeysByPart.get(part) ?? new Set();
    const diskKeys = new Set(diskFiles.map(pathKey));
    const missing = diskFiles.filter((f) => !dbKeys.has(pathKey(f))).sort();
    const withEntries = diskFiles.length - missing.length;
    rows[part] = {
      onDisk: diskFiles.length,
      withEntries,
      pct: diskFiles.length === 0 ? null : (100 * withEntries) / diskFiles.length,
      dbEntries: entryCount.get(part) ?? 0,
      dbFiles: dbKeys.size,
      dbOnly: [...dbKeys].filter((k) => !diskKeys.has(k)).length,
      missingSample: missing.slice(0, 15),
    };
  }
  return rows;
}

// ============================================================================
//  DETERMINISTIC SAMPLING
// ============================================================================

/**
 * @typedef {object} SampleFile
 * @property {string} file
 * @property {string} part
 * @property {boolean} extra   true for recipe "extraFiles" (not drawn from the DB)
 */

/**
 * Per part: sort the distinct DB files by path and take `perPart` evenly spaced ones.
 * Same DB in, same sample out. Then append the recipe's extra files (e.g. headers that
 * are not in the DB at all).
 * @param {DbEntry[]} entries
 * @param {Classifier} classify
 * @param {string[]} partNames
 * @param {number} perPart
 * @param {string[]} extraFiles
 * @returns {SampleFile[]}
 */
export function stratifiedSample(entries, classify, partNames, perPart, extraFiles = []) {
  const filesByPart = new Map();
  for (const file of distinctFiles(entries)) {
    const part = classify(file);
    if (!filesByPart.has(part)) filesByPart.set(part, []);
    filesByPart.get(part).push(file);
  }

  /** @type {SampleFile[]} */
  const sample = [];
  const taken = new Set();
  for (const part of partNames) {
    for (const file of pickEvenly(filesByPart.get(part) ?? [], perPart)) {
      sample.push({ file, part, extra: false });
      taken.add(pathKey(file));
    }
  }
  for (const file of extraFiles) {
    if (taken.has(pathKey(file))) continue;
    sample.push({ file, part: classify(file), extra: true });
    taken.add(pathKey(file));
  }
  return sample;
}

/**
 * ONE check sample for a whole run, drawn from every variant's DB together, so each variant is
 * checked on the same files and its clean percentage means the same thing as the others'.
 * Same DBs in, same sample out, whatever order the variants are listed in.
 * @param {DbEntry[][]} entriesPerVariant
 * @param {Classifier} classify
 * @param {string[]} partNames
 * @param {number} perPart
 * @param {string[]} extraFiles
 * @returns {SampleFile[]}
 */
export function sharedSample(entriesPerVariant, classify, partNames, perPart, extraFiles = []) {
  return stratifiedSample(entriesPerVariant.flat(), classify, partNames, perPart, extraFiles);
}

/**
 * Path keys of the files that EVERY one of the lists has an entry for.
 * @param {DbEntry[][]} entriesPerVariant
 * @returns {Set<string>}
 */
export function filesInEveryDb(entriesPerVariant) {
  const keySets = entriesPerVariant.map((entries) => new Set(entries.map((e) => pathKey(e.file))));
  const [first, ...rest] = keySets;
  return new Set([...(first ?? [])].filter((key) => rest.every((keys) => keys.has(key))));
}

/**
 * Take `count` evenly spaced items (first item included). All items when count >= length.
 * @template T
 * @param {T[]} sorted
 * @param {number} count
 * @returns {T[]}
 */
export function pickEvenly(sorted, count) {
  if (count <= 0) return [];
  if (sorted.length <= count) return [...sorted];
  const picked = [];
  for (let i = 0; i < count; i++) picked.push(sorted[Math.floor((i * sorted.length) / count)]);
  return picked;
}

// ============================================================================
//  NAVIGATION SUBSET
// ============================================================================

/**
 * What the navigation stage will ask clangd about: the probe files, and the files it
 * expects to land in (probe targets and symbol targets, both as path suffixes).
 * A probe of any type contributes every file suffix it expects (see expectedSuffixes).
 * @param {{file: string, expect: object}[]} probes
 * @param {{expectFileSuffix: string}[]} symbols
 * @returns {{files: string[], targets: string[]}}
 */
export function navWanted(probes, symbols) {
  return {
    files: probes.map((p) => p.file),
    targets: [...probes.flatMap(expectedSuffixes), ...symbols.map((s) => s.expectFileSuffix)],
  };
}

/** @param {string} file  lower-cased file name without its extension */
function stemOf(file) {
  return path.posix.basename(file, path.posix.extname(file)).toLowerCase();
}

/**
 * The files among `files` that have no entry of their own in the DB, each once, in the order given.
 * clangd gives such a file the flags of another entry (see findInferredProxy in clangdCheck.mjs).
 * @param {{file: string, directory?: string}[]} rawEntries  from loadRawCompileDb()
 * @param {string[]} files
 * @returns {string[]}
 */
export function filesWithoutEntry(rawEntries, files) {
  const withEntry = new Set(rawEntries.map((raw) => pathKey(entryFilePath(raw))));
  const seen = new Set();
  return files.filter((file) => {
    const key = pathKey(file);
    if (withEntry.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Pick the compile-DB entries a navigation run needs, so clangd's background index can FINISH
 * (a full gs_play index takes about an hour and a half; this takes minutes). Chosen:
 *   1. every entry for a probe file,
 *   2. every entry for a proxy file: the entry clangd infers a probe file's flags from when that file
 *      has no entry of its own. clangd scores every candidate on its own, so the full DB's winner is
 *      still the winner in any subset that holds it, and the probe file gets the same flags as in the
 *      full DB (the caller asks clangd for the proxy on the full DB; see run.mjs),
 *   3. every entry for a source file a probe or symbol is expected to land in (suffix match),
 *   4. for an expected HEADER, the sources with the same file name stem (Foo.h -> Foo.cpp),
 *   5. up to `neighbours` further entries from the folder of each chosen entry (sorted by path),
 *      which also gives clangd real neighbours to infer header commands from.
 * A header-only target is found because some chosen file includes it: clangd indexes every
 * header an indexed file includes. The raw entries come back in the DB's own order.
 * @param {{file: string, directory?: string}[]} rawEntries  from loadRawCompileDb()
 * @param {{files: string[], targets: string[], proxies?: string[]}} wanted  from navWanted(), plus the proxy files
 * @param {number} neighbours
 * @returns {{file: string, directory?: string}[]}
 */
export function selectNavSubset(rawEntries, wanted, neighbours) {
  const rows = rawEntries.map((raw) => ({ raw, file: entryFilePath(raw) }));
  const wantedFiles = new Set([...wanted.files, ...(wanted.proxies ?? [])].map(pathKey));
  const sourceTargets = wanted.targets.filter((t) => SOURCE_EXTENSIONS.has(extOf(t)));
  const headerStems = new Set(wanted.targets.filter((t) => !SOURCE_EXTENSIONS.has(extOf(t))).map(stemOf));

  /** @type {Set<number>} indexes into rows */
  const chosen = new Set();
  rows.forEach((row, i) => {
    const isSource = SOURCE_EXTENSIONS.has(extOf(row.file));
    if (wantedFiles.has(pathKey(row.file))) chosen.add(i);
    else if (isSource && sourceTargets.some((suffix) => hasPathSuffix(row.file, suffix))) chosen.add(i);
    else if (isSource && headerStems.has(stemOf(row.file))) chosen.add(i);
  });

  const folderOf = (row) => pathKey(path.posix.dirname(row.file));
  const folders = new Set([...chosen].map((i) => folderOf(rows[i])));
  for (const folder of folders) {
    const others = rows
      .map((row, i) => ({ i, key: pathKey(row.file) }))
      .filter(({ i }) => !chosen.has(i) && folderOf(rows[i]) === folder)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const { i } of others.slice(0, neighbours)) chosen.add(i);
  }
  return rows.filter((_, i) => chosen.has(i)).map((row) => row.raw);
}
