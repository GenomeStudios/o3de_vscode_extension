// ============================================================================
//  run.mjs - runs the benchmark stages and writes the report
//
//    coverage  how many on-disk .cpp files have a compile-DB entry
//    check     clangd --check on a deterministic sample
//    nav       a real clangd: background index, F12 probes, Ctrl+T queries
//
//  Everything the run writes lives under <workDir>: the DB copies, the clangd
//  index, clangd's temp files, and the run folder with the report.
//
//  A run that starts clangd (check or nav) holds <workDir>/.bench.lock, so two runs
//  can never share one work directory (see lock.mjs).
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import {
  computeCoverage,
  distinctFiles,
  filesInEveryDb,
  filesWithoutEntry,
  loadCompileDb,
  loadRawCompileDb,
  makeClassifier,
  navWanted,
  scanDisk,
  selectNavSubset,
  sharedSample,
} from "./compdb.mjs";
import { findInferredProxy, runChecks } from "./clangdCheck.mjs";
import { acquireRunLock, releaseRunLock } from "./lock.mjs";
import { assertInside, prepareNavSubset, prepareVariant, runNav } from "./nav.mjs";
import { normalizePath, pathKey } from "./paths.mjs";
import { clangdEnv, clangdVersion, countClangdProcesses } from "./procs.mjs";
import { buildReport, writeReport } from "./report.mjs";

export const ALL_STAGES = ["coverage", "check", "nav"];

/**
 * @typedef {object} RunOptions
 * @property {string[]} [variants]  variant names to run (default: all)
 * @property {string[]} [only]      stages to run (default: all)
 * @property {boolean} [cold]       delete each variant's background index first
 * @property {string} [out]         run folder (must be inside the work directory)
 * @property {(message: string) => void} [log]
 */

// ============================================================================
//  RUN FOLDER
// ============================================================================

/** "20261121T041612Z" - sortable and safe in a Windows path. */
export function timestampForPath(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * <workDir>/runs/<timestamp>-<recipe>-<variant>, or the explicit --out folder.
 * @param {import("./recipe.mjs").Recipe} recipe
 * @param {string[]} variantNames
 * @param {Date} startedAt
 * @param {string} [explicit]
 * @returns {string}
 */
export function runDirFor(recipe, variantNames, startedAt, explicit) {
  const label = variantNames.length === 1 ? variantNames[0] : "all";
  const dir = normalizePath(explicit ?? `${recipe.workDir}/runs/${timestampForPath(startedAt)}-${recipe.name}-${label}`);
  assertInside(recipe.workDir, dir);
  return dir;
}

// ============================================================================
//  THE RUN
// ============================================================================

/**
 * @param {{recipe: import("./recipe.mjs").Recipe, hash: string, file: string}} loaded  result of loadRecipe()
 * @param {RunOptions} [options]
 * @returns {Promise<{report: ReturnType<typeof buildReport>, outDir: string}>}
 */
export async function runBenchmark(loaded, options = {}) {
  const { recipe } = loaded;
  const stages = options.only?.length ? options.only : ALL_STAGES;
  for (const stage of stages) if (!ALL_STAGES.includes(stage)) throw new Error(`Unknown stage "${stage}" (use ${ALL_STAGES.join(", ")})`);

  const variants = options.variants?.length ? options.variants.map((name) => findVariant(recipe, name)) : recipe.variants;
  const startedAt = new Date();
  const outDir = runDirFor(recipe, variants.map((v) => v.name), startedAt, options.out);

  // Take the lock before anything is created or touched: prepareVariant can rewrite a
  // compile DB under another run's live clangd, and --cold deletes its index. A coverage-only
  // run starts no clangd and writes only its report, so it needs no lock.
  const needsLock = stages.includes("check") || stages.includes("nav");
  const lockPath = needsLock ? acquireRunLock(recipe.workDir, { recipe: recipe.name }) : null;
  try {
    return await executeRun({ loaded, options, stages, variants, startedAt, outDir, exclusive: Boolean(lockPath) });
  } finally {
    if (lockPath) releaseRunLock(lockPath);
  }
}

/**
 * The run itself, with the work directory already locked (when it needs to be).
 * @param {object} run
 * @param {{recipe: import("./recipe.mjs").Recipe, hash: string, file: string}} run.loaded
 * @param {RunOptions} run.options
 * @param {string[]} run.stages
 * @param {import("./recipe.mjs").Variant[]} run.variants
 * @param {Date} run.startedAt
 * @param {string} run.outDir
 * @param {boolean} run.exclusive  the work directory lock is held
 */
async function executeRun({ loaded, options, stages, variants, startedAt, outDir, exclusive }) {
  const { recipe } = loaded;
  const log = options.log ?? (() => {});
  fs.mkdirSync(outDir, { recursive: true });
  clangdEnv(recipe.workDir); // creates <workDir>/tmp up front

  const version = clangdVersion(recipe.clangd);
  log(`clangd: ${version}`);
  log(`run folder: ${outDir}`);

  // other clangd processes (an editor's, say) take CPU from the run: count them before we start ours
  const otherClangdProcesses = exclusive ? countClangdProcesses() : null;
  if (otherClangdProcesses) log(`note: ${otherClangdProcesses} other clangd process(es) are running; timings may be skewed`);

  const partNames = Object.keys(recipe.parts);
  const classify = makeClassifier(recipe.parts);

  // the disk scan does not depend on the variant, so do it once
  let onDisk = null;
  if (stages.includes("coverage")) {
    log("scanning source files on disk ...");
    onDisk = scanDisk(recipe.parts, recipe.excludeDirs, classify);
    log(`  ${[...onDisk].map(([part, files]) => `${part}=${files.length}`).join("  ")}`);
  }

  // ONE check sample for the whole run, drawn from every variant in the recipe (not just the ones
  // chosen with --variant), so variants are always compared on the same files
  let checkSample = null;
  if (stages.includes("check")) {
    const allEntries = recipe.variants.map((v) => loadCompileDb(v.db));
    const files = sharedSample(allEntries, classify, partNames, recipe.sample.perPart, recipe.sample.extraFiles);
    checkSample = { files, commonKeys: filesInEveryDb(allEntries) };
    log(`check sample: ${files.length} files, the same for every variant`);
  }

  const results = [];
  for (const variant of variants) {
    results.push(await runVariant({ recipe, variant, stages, classify, partNames, onDisk, checkSample, cold: Boolean(options.cold), log }));
  }

  const report = buildReport({
    recipe,
    recipeFile: loaded.file,
    recipeHash: loaded.hash,
    clangdVersion: version,
    cold: Boolean(options.cold),
    stages,
    outDir,
    startedAt,
    finishedAt: new Date(),
    exclusive,
    otherClangdProcesses,
    variants: results,
  });
  writeReport(outDir, report);
  log(`report: ${path.posix.join(outDir, "report.md")}`);
  return { report, outDir };
}

/**
 * @param {import("./recipe.mjs").Recipe} recipe
 * @param {string} name
 * @returns {import("./recipe.mjs").Variant}
 */
function findVariant(recipe, name) {
  const found = recipe.variants.find((v) => v.name === name);
  if (!found) throw new Error(`No variant "${name}" in recipe (have: ${recipe.variants.map((v) => v.name).join(", ")})`);
  return found;
}

// ============================================================================
//  ONE VARIANT
// ============================================================================

/**
 * A stage that throws is recorded in `errors` and the run carries on with the next stage.
 * @param {object} input
 * @param {{files: import("./compdb.mjs").SampleFile[], commonKeys: Set<string>} | null} input.checkSample
 *   the run's one check sample, and the keys of the files every variant's DB has an entry for
 * @returns {Promise<import("./report.mjs").VariantResult>}
 */
async function runVariant({ recipe, variant, stages, classify, partNames, onDisk, checkSample, cold, log }) {
  log(`=== variant ${variant.name} ===`);
  /** @type {import("./report.mjs").VariantResult} */
  const result = { name: variant.name, db: variant.db, extraArgs: variant.extraArgs, dbEntries: 0, dbFiles: 0, coverage: null, sampleSize: 0, check: null, nav: null, errors: {} };

  const entries = loadCompileDb(variant.db);
  result.dbEntries = entries.length;
  result.dbFiles = distinctFiles(entries).length;
  log(`compile DB: ${entries.length} entries, ${result.dbFiles} distinct files`);

  if (stages.includes("coverage") && onDisk) {
    result.coverage = computeCoverage(entries, onDisk, classify, partNames);
  }

  // check and nav both read the harness's copy of the DB, never the original
  const needsCopy = stages.includes("check") || stages.includes("nav");
  let dir = "";
  if (needsCopy) {
    try {
      dir = prepareVariant(recipe.workDir, variant);
    } catch (err) {
      result.errors.prepare = err.message;
    }
  }

  if (stages.includes("check") && dir && checkSample) {
    try {
      const files = checkSample.files;
      result.sampleSize = files.length;
      log(`check: ${files.length} files, ${recipe.limits.checkConcurrency} at a time ...`);
      const checked = await runChecks(files, {
        clangd: recipe.clangd,
        dbDir: dir,
        extraArgs: variant.extraArgs,
        timeoutSec: recipe.limits.checkTimeoutSec,
        concurrency: recipe.limits.checkConcurrency,
        env: clangdEnv(recipe.workDir),
        onResult: (r, done, total) => log(`  check ${done}/${total} ${r.status} ${path.posix.basename(r.file)}`),
      });
      // say which files had a compile command of their own in this variant's DB, and which clangd had to guess
      const dbKeys = new Set(entries.map((e) => pathKey(e.file)));
      result.check = checked.map((r) => ({ ...r, inDb: dbKeys.has(pathKey(r.file)), inAllDbs: checkSample.commonKeys.has(pathKey(r.file)) }));
    } catch (err) {
      result.errors.check = err.message;
    }
  }

  if (stages.includes("nav") && dir) {
    try {
      const kickFile = recipe.probes[0]?.file ?? distinctFiles(entries)[0];
      const nav = await navFolder(recipe, variant, dir, (m) => log(`  ${m}`));
      result.nav = await runNav({ recipe, variant, dir: nav.dir, cold, kickFile, dbSubset: nav.dbSubset, entryless: nav.entryless, log: (m) => log(`  ${m}`) });
    } catch (err) {
      result.errors.nav = err.message;
    }
  }
  return result;
}

/**
 * The folder clangd is pointed at for the nav stage: the full DB copy, or, when the recipe sets
 * nav.dbSubset, a reduced DB so the background index can finish in minutes instead of hours.
 * The check stage always uses the full copy.
 *
 * Also says where each entry-less probe file's flags come from (see inferEntrylessFlags), and, for a
 * subset, keeps the entries those flags are borrowed from.
 * @param {import("./recipe.mjs").Recipe} recipe
 * @param {import("./recipe.mjs").Variant} variant
 * @param {string} fullDir  the variant folder holding the full DB copy
 * @param {(message: string) => void} log
 * @param {typeof findInferredProxy} [findProxy]  asks clangd which entry it infers flags from (replaceable in tests)
 * @returns {Promise<{dir: string, dbSubset: {entries: number, of: number} | null, entryless: Map<string, import("./nav.mjs").ProbeFlags>}>}
 */
export async function navFolder(recipe, variant, fullDir, log, findProxy = findInferredProxy) {
  const raw = loadRawCompileDb(variant.db);
  const wanted = navWanted(recipe.probes, recipe.symbols);
  const subsetNeighbours = recipe.nav.dbSubset?.neighbours;

  // asked of the FULL DB, so it has to happen before the nav stage is pointed at a subset
  const entryless = await inferEntrylessFlags({ recipe, variant, raw, files: wanted.files, fullDir, subset: subsetNeighbours !== undefined, log, findProxy });
  if (subsetNeighbours === undefined) return { dir: fullDir, dbSubset: null, entryless };

  const proxies = [...entryless.values()].map((flags) => flags.from).filter(Boolean);
  const subset = selectNavSubset(raw, { ...wanted, proxies }, subsetNeighbours);
  if (subset.length === 0) throw new Error("nav.dbSubset selected no compile-DB entries: none of the probe files or expected targets is in the DB");
  log(`nav compile DB: subset of ${subset.length} of ${raw.length} entries`);
  return { dir: prepareNavSubset(recipe.workDir, variant, subset), dbSubset: { entries: subset.length, of: raw.length }, entryless };
}

/**
 * A probe file with no compile-DB entry of its own is opened with flags clangd infers from another entry,
 * which depends on every entry the DB holds. A reduced DB must not change that, so ask clangd on the full
 * DB which entry it borrows from ("Compile command inferred from <file>") and report it.
 * When clangd does not say (or names a file the DB does not hold), a subset run falls back to whatever
 * the subset offers and the file is labelled "subset-inferred".
 * @param {object} input
 * @param {import("./recipe.mjs").Recipe} input.recipe
 * @param {import("./recipe.mjs").Variant} input.variant
 * @param {{file: string, directory?: string}[]} input.raw  the variant's DB entries
 * @param {string[]} input.files  the probe files
 * @param {string} input.fullDir
 * @param {boolean} input.subset  the nav stage will use a reduced DB
 * @param {(message: string) => void} input.log
 * @param {typeof findInferredProxy} input.findProxy
 * @returns {Promise<Map<string, import("./nav.mjs").ProbeFlags>>}  by pathKey of the entry-less probe file
 */
async function inferEntrylessFlags({ recipe, variant, raw, files, fullDir, subset, log, findProxy }) {
  const flagsByFile = new Map();
  for (const file of filesWithoutEntry(raw, files)) {
    const found = await findProxy({
      clangd: recipe.clangd,
      file,
      dbDir: fullDir,
      extraArgs: variant.extraArgs,
      timeoutSec: recipe.limits.checkTimeoutSec,
      env: clangdEnv(recipe.workDir),
    });
    const proxy = found.proxy ? normalizePath(found.proxy) : "";
    const known = proxy !== "" && filesWithoutEntry(raw, [proxy]).length === 0;

    if (known) log(`${path.posix.basename(file)} has no DB entry: flags inferred from ${proxy}`);
    else log(`WARNING: ${file} has no DB entry and clangd did not name an entry it infers from (${found.note || `${proxy} is not in the DB`}); ${subset ? "its flags come from whatever the subset holds" : "clangd infers them from the full DB"}`);

    // without a subset the flags are the full DB's whether or not we could name the entry
    flagsByFile.set(pathKey(file), { source: known || !subset ? "full-DB inferred" : "subset-inferred", from: known ? proxy : "" });
  }
  return flagsByFile;
}
