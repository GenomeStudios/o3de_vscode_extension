// ============================================================================
//  report.mjs - turn raw stage results into report.json and report.md
//
//  report.json keeps every per-file and per-probe row; report.md is the readable
//  summary. All the arithmetic lives in the summarise*() functions so it can be
//  tested without running clangd.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { topErrorMessages } from "./clangdCheck.mjs";
import { OTHER_PART } from "./compdb.mjs";
import { CAPABILITY_LABELS, PROBE_TYPE_NAMES } from "./probeTypes.mjs";

// 2: nav.probes covers the F12 probes only; the other probe types are in nav.relationships; nav.capabilities is new
export const REPORT_SCHEMA = 2;

// ============================================================================
//  SUMMARISING
// ============================================================================

/**
 * @param {number} part
 * @param {number} whole
 * @returns {number | null}  percentage, or null when there is nothing to divide by
 */
export function percent(part, whole) {
  return whole === 0 ? null : (100 * part) / whole;
}

/**
 * Part names to report: the recipe's parts, plus "other" when something landed there.
 * @param {string[]} partNames
 * @param {string[]} usedParts
 * @returns {string[]}
 */
function partsInUse(partNames, usedParts) {
  return usedParts.includes(OTHER_PART) ? [...partNames, OTHER_PART] : partNames;
}

/**
 * Coverage rows as an ordered list.
 * @param {Record<string, import("./compdb.mjs").CoverageRow>} coverage
 * @param {string[]} partNames
 */
export function summariseCoverage(coverage, partNames) {
  const rows = partNames.map((part) => ({ part, ...coverage[part] }));
  const other = coverage[OTHER_PART];
  if (other && (other.onDisk > 0 || other.dbEntries > 0)) rows.push({ part: OTHER_PART, ...other });
  const onDisk = rows.reduce((sum, r) => sum + r.onDisk, 0);
  const withEntries = rows.reduce((sum, r) => sum + r.withEntries, 0);
  return { parts: rows, total: { onDisk, withEntries, pct: percent(withEntries, onDisk) } };
}

/**
 * Clean counts for a group of check results.
 * @param {{clean: boolean}[]} list
 */
function cleanRate(list) {
  const clean = list.filter((f) => f.clean).length;
  return { total: list.length, clean, pct: percent(clean, list.length) };
}

/**
 * Check results. Besides the overall and per-part rates, the files are split by where
 * their compile command came from, because that is what makes variants comparable:
 *   inDb      the variant's own DB has an entry (a real compile command)
 *   common    of those, files that EVERY variant's DB has an entry for: the fair number to compare
 *   inferred  not in this DB; clangd guessed a command from a neighbour, as it does for a header
 * @param {(import("./clangdCheck.mjs").CheckResult & {inDb?: boolean, inAllDbs?: boolean})[]} files
 * @param {string[]} partNames
 */
export function summariseCheck(files, partNames) {
  const byStatus = { ok: 0, "ok-slow": 0, errors: 0, failed: 0, timeout: 0 };
  for (const f of files) byStatus[f.status]++;

  const parts = partsInUse(partNames, files.map((f) => f.part)).map((part) => {
    const inPart = files.filter((f) => f.part === part);
    const clean = inPart.filter((f) => f.clean).length;
    return { part, total: inPart.length, clean, pct: percent(clean, inPart.length) };
  });
  const clean = files.filter((f) => f.clean).length;

  return {
    total: files.length,
    clean,
    pct: percent(clean, files.length),
    byStatus,
    inDb: cleanRate(files.filter((f) => f.inDb === true)),
    common: cleanRate(files.filter((f) => f.inAllDbs === true)),
    inferred: cleanRate(files.filter((f) => f.inDb === false)),
    parts,
    topMessages: topErrorMessages(files, 10),
    files,
  };
}

/** A probe with no type is an F12 (definition) probe, as every probe was before the relationship types. */
const isDefinitionProbe = (probe) => (probe.type ?? "definition") === "definition";

/**
 * F12 (definition) probe pass rates; the relationship probes are summarised apart, see
 * summariseRelationships. Probes whose gem is not part of the build (expectedBuilt false)
 * are reported apart and do not count towards the headline rate.
 *
 * Probes that were skipped because the background index did not finish are not part of
 * any rate either: whether they pass would only measure how far the index got. The
 * headline is split by whether a probe needs the index at all, each with its own rate.
 * @param {import("./nav.mjs").ProbeResult[]} allProbes  every probe; only the definition ones are summarised here
 * @param {string[]} partNames
 */
export function summariseProbes(allProbes, partNames) {
  const probes = allProbes.filter(isDefinitionProbe);
  const built = probes.filter((p) => p.expectedBuilt);
  const notBuilt = probes.filter((p) => !p.expectedBuilt);
  const passed = (list) => list.filter((p) => p.status === "pass").length;
  const ranOf = (list) => list.filter((p) => p.status !== "skipped");
  const ran = ranOf(built);

  const parts = partsInUse(partNames, built.map((p) => p.part)).map((part) => {
    const inPart = built.filter((p) => p.part === part);
    const inPartRan = ranOf(inPart);
    return { part, total: inPartRan.length, pass: passed(inPartRan), pct: percent(passed(inPartRan), inPartRan.length), skipped: inPart.length - inPartRan.length };
  });

  const categories = [...new Set(built.map((p) => p.category))].sort().map((category) => {
    const inCategory = built.filter((p) => p.category === category);
    const inCategoryRan = ranOf(inCategory);
    return { category, total: inCategoryRan.length, pass: passed(inCategoryRan), pct: percent(passed(inCategoryRan), inCategoryRan.length), skipped: inCategory.length - inCategoryRan.length };
  });

  const independent = built.filter((p) => !p.needsIndex);
  const needing = built.filter((p) => p.needsIndex);
  const needingRan = ranOf(needing);

  return {
    built: {
      total: ran.length,
      pass: passed(ran),
      fail: ran.filter((p) => p.status === "fail").length,
      error: ran.filter((p) => p.status === "error").length,
      skipped: built.length - ran.length,
      pct: percent(passed(ran), ran.length),
    },
    independent: { total: independent.length, pass: passed(independent), pct: percent(passed(independent), independent.length) },
    needsIndex: { total: needing.length, ran: needingRan.length, skipped: needing.length - needingRan.length, pass: passed(needingRan), pct: percent(passed(needingRan), needingRan.length) },
    parts,
    categories,
    failures: ran.filter((p) => p.status !== "pass"),
    notBuilt: { total: notBuilt.length, pass: passed(notBuilt), skipped: notBuilt.length - ranOf(notBuilt).length, results: notBuilt },
    results: probes,
  };
}

/**
 * The pass counts of a group of probes: skipped ones are counted apart and stay out of the rate.
 * @param {{status: string}[]} list
 */
function probeRate(list) {
  const ran = list.filter((p) => p.status !== "skipped");
  const pass = ran.filter((p) => p.status === "pass").length;
  return {
    total: ran.length,
    pass,
    fail: ran.filter((p) => p.status === "fail").length,
    error: ran.filter((p) => p.status === "error").length,
    skipped: list.length - ran.length,
    pct: percent(pass, ran.length),
  };
}

/**
 * The relationship probes (references, implementation, type hierarchy, incoming calls, rename,
 * code action, completion): the headline over built projects, the breakdown by category and by
 * type, and the failures with what came back. Probes for gems that are not built, and probes
 * skipped for an unfinished index, stay out of every rate, as for F12.
 * @param {import("./nav.mjs").ProbeResult[]} allProbes
 */
export function summariseRelationships(allProbes) {
  const probes = allProbes.filter((p) => !isDefinitionProbe(p));
  const built = probes.filter((p) => p.expectedBuilt);
  const notBuilt = probes.filter((p) => !p.expectedBuilt);

  const categories = [...new Set(built.map((p) => p.category))].sort().map((category) => {
    const inCategory = built.filter((p) => p.category === category);
    return { category, types: [...new Set(inCategory.map((p) => p.type))], ...probeRate(inCategory) };
  });

  return {
    total: probes.length,
    built: probeRate(built),
    categories,
    failures: built.filter((p) => p.status !== "pass" && p.status !== "skipped"),
    notBuilt: { total: notBuilt.length, pass: notBuilt.filter((p) => p.status === "pass").length, skipped: notBuilt.filter((p) => p.status === "skipped").length, results: notBuilt },
    results: probes,
  };
}

/** True for a probe whose file has no compile-DB entry (older results carry no `flags` and count as having one). */
const hasInferredFlags = (probe) => Boolean(probe.flags) && probe.flags.source !== "own entry";

/** Short text for a probe's flags column: "" for an own entry, else where the inferred flags come from. */
const flagsLabel = (probe) => (hasInferredFlags(probe) ? probe.flags.source : "");

/**
 * The probe files with no compile-DB entry of their own, one row each: where clangd's inferred flags
 * come from, and which probes sit in the file. Empty when every probe file has an entry.
 * @param {import("./nav.mjs").ProbeResult[]} probes
 * @returns {{file: string, source: string, from: string, probes: string[]}[]}
 */
export function summariseEntryless(probes) {
  /** @type {Map<string, {file: string, source: string, from: string, probes: string[]}>} */
  const byFile = new Map();
  for (const p of probes.filter((probe) => hasInferredFlags(probe))) {
    if (!byFile.has(p.file)) byFile.set(p.file, { file: p.file, source: p.flags.source, from: p.flags.from, probes: [] });
    byFile.get(p.file).probes.push(p.id);
  }
  return [...byFile.values()];
}

/**
 * Per capability (type of LSP question): how many probes ran and passed. Definition (F12), each
 * relationship type, and workspace symbol (Ctrl+T). Built projects only; skipped ones stay out of the rate.
 * Only capabilities that have probes or queries get a row, in the order of PROBE_TYPE_NAMES.
 * @param {import("./nav.mjs").ProbeResult[]} probes
 * @param {import("./nav.mjs").SymbolResult[]} symbols
 */
export function summariseCapabilities(probes, symbols) {
  const built = probes.filter((p) => p.expectedBuilt);
  const typeOf = (probe) => probe.type ?? "definition";
  const rows = PROBE_TYPE_NAMES.filter((type) => built.some((p) => typeOf(p) === type)).map((type) => ({
    type,
    label: CAPABILITY_LABELS[type],
    ...probeRate(built.filter((p) => typeOf(p) === type)),
  }));
  if (symbols.length > 0) rows.push({ type: "workspaceSymbol", label: CAPABILITY_LABELS.workspaceSymbol, ...probeRate(symbols) });
  return rows;
}

/**
 * Symbol (Ctrl+T) pass rate over the queries that ran. Queries skipped for an unfinished index are counted apart.
 *
 * pathIdentity: the same symbol (name and container) returned from two files whose paths end the same
 * under different roots, such as the SDK copy and the surrogate copy of one header. `pairs` counts
 * them over every query that ran; `examples` is the first few.
 * @param {import("./nav.mjs").SymbolResult[]} symbols
 */
export function summariseSymbols(symbols) {
  const ran = symbols.filter((s) => s.status !== "skipped");
  const pass = ran.filter((s) => s.status === "pass").length;
  const withTwins = ran.filter((s) => (s.twinCount ?? 0) > 0);
  return {
    total: ran.length,
    pass,
    pct: percent(pass, ran.length),
    skipped: symbols.length - ran.length,
    failures: ran.filter((s) => s.status !== "pass"),
    pathIdentity: {
      pairs: withTwins.reduce((sum, s) => sum + s.twinCount, 0),
      queries: withTwins.length,
      examples: withTwins.flatMap((s) => s.twins.map((t) => ({ query: s.query, ...t }))).slice(0, 8),
    },
    results: symbols,
  };
}

/**
 * Can the variants' navigation numbers be set side by side? Only when every variant's
 * background index finished; otherwise each number measures how far its own index got.
 * @param {{name: string, nav: {indexComplete: boolean} | null}[]} variants
 * @returns {{variants: string[], comparable: boolean, incomplete: string[]} | null}  null with fewer than two navigation results
 */
export function summariseNavComparison(variants) {
  const withNav = variants.filter((v) => v.nav);
  if (withNav.length < 2) return null;
  const incomplete = withNav.filter((v) => !v.nav.indexComplete).map((v) => v.name);
  return { variants: withNav.map((v) => v.name), comparable: incomplete.length === 0, incomplete };
}

// ============================================================================
//  BUILDING THE REPORT
// ============================================================================

/**
 * @typedef {object} VariantResult
 * @property {string} name
 * @property {string} db
 * @property {string[]} extraArgs
 * @property {number} dbEntries
 * @property {number} dbFiles
 * @property {Record<string, import("./compdb.mjs").CoverageRow> | null} coverage
 * @property {number} sampleSize
 * @property {(import("./clangdCheck.mjs").CheckResult & {inDb: boolean, inAllDbs: boolean})[] | null} check
 *   inDb: this variant's DB has an entry for the file; inAllDbs: every variant's DB has
 * @property {import("./nav.mjs").NavResult | null} nav
 * @property {Record<string, string>} errors   stage name -> error message, for stages that threw
 */

/**
 * @param {object} input
 * @param {import("./recipe.mjs").Recipe} input.recipe
 * @param {string} input.recipeFile
 * @param {string} input.recipeHash
 * @param {string} input.clangdVersion
 * @param {boolean} input.cold
 * @param {string[]} input.stages
 * @param {string} input.outDir
 * @param {Date} input.startedAt
 * @param {Date} input.finishedAt
 * @param {boolean} [input.exclusive]  the work directory run lock was held (no other bench run used the folder)
 * @param {number | null} [input.otherClangdProcesses]  clangd processes already running when the run started (null = not counted)
 * @param {VariantResult[]} input.variants
 */
export function buildReport({ recipe, recipeFile, recipeHash, clangdVersion, cold, stages, outDir, startedAt, finishedAt, exclusive = false, otherClangdProcesses = null, variants }) {
  const partNames = Object.keys(recipe.parts);
  return {
    schema: REPORT_SCHEMA,
    recipe: { name: recipe.name, file: recipeFile, hash: recipeHash, project: recipe.project, workDir: recipe.workDir },
    clangd: { path: recipe.clangd, version: clangdVersion },
    run: {
      cold,
      stages,
      dir: outDir,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
      exclusive,
      otherClangdProcesses,
    },
    navComparison: summariseNavComparison(variants),
    parts: partNames,
    variants: variants.map((v) => ({
      name: v.name,
      db: v.db,
      extraArgs: v.extraArgs,
      dbEntries: v.dbEntries,
      dbFiles: v.dbFiles,
      errors: v.errors,
      coverage: v.coverage && summariseCoverage(v.coverage, partNames),
      sampleSize: v.sampleSize,
      check: v.check && summariseCheck(v.check, partNames),
      nav: v.nav && {
        coldRequested: v.nav.coldRequested,
        freshIndex: v.nav.freshIndex,
        indexDir: v.nav.indexDir,
        indexExists: v.nav.indexExists,
        indexInsideWorkDir: v.nav.indexInsideWorkDir,
        indexSizeBytes: v.nav.indexSizeBytes,
        indexMs: v.nav.indexMs,
        indexComplete: v.nav.indexComplete,
        indexNote: v.nav.indexNote,
        dbSubset: v.nav.dbSubset ?? null,
        progressTokens: v.nav.progressTokens,
        clangdStderr: v.nav.clangdStderr,
        capabilities: summariseCapabilities(v.nav.probes, v.nav.symbols),
        entryless: summariseEntryless(v.nav.probes),
        probes: summariseProbes(v.nav.probes, partNames),
        relationships: summariseRelationships(v.nav.probes),
        symbols: summariseSymbols(v.nav.symbols),
      },
    })),
  };
}

/**
 * Warnings for the end of the run (printed by bench.mjs): one per variant whose background
 * index did not finish, and one when the variants cannot be compared for that reason.
 * @param {ReturnType<typeof buildReport>} report
 * @returns {string[]}
 */
export function indexWarnings(report) {
  const warnings = report.variants
    .filter((v) => v.nav && !v.nav.indexComplete)
    .map(
      (v) =>
        `WARNING: variant ${v.name}: INDEX INCOMPLETE - partial results. ${v.nav.probes.needsIndex.skipped + v.nav.relationships.built.skipped} probes and ${v.nav.symbols.skipped} symbol queries were skipped; ` +
        "the navigation rates cover only what does not depend on the index. Raise limits.indexWaitMin or set nav.dbSubset in the recipe.",
    );
  const comparison = report.navComparison;
  if (comparison && !comparison.comparable) {
    warnings.push(`WARNING: navigation numbers are NOT comparable between variants: the index did not finish for ${comparison.incomplete.join(", ")}.`);
  }
  return warnings;
}

/**
 * Write report.json and report.md into `outDir`.
 * @param {string} outDir
 * @param {ReturnType<typeof buildReport>} report
 */
export function writeReport(outDir, report) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "report.md"), renderMarkdown(report));
}

// ============================================================================
//  MARKDOWN
// ============================================================================

/** @param {number | null} value */
export function fmtPct(value) {
  return value === null || value === undefined ? "n/a" : `${value.toFixed(1)}%`;
}

/** @param {number} bytes */
export function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** @param {number | null} ms */
export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return "n/a";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/** Make text safe for one markdown table cell. */
function cell(value) {
  return String(value ?? "").replace(/\s+/g, " ").replaceAll("|", "\\|");
}

/**
 * @param {string[]} headers
 * @param {any[][]} rows
 * @returns {string[]}
 */
function table(headers, rows) {
  if (rows.length === 0) return ["_none_", ""];
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`), ""];
}

/**
 * @param {ReturnType<typeof buildReport>} report
 * @returns {string}
 */
export function renderMarkdown(report) {
  const out = [];
  out.push(`# IntelliSense benchmark: ${report.recipe.name}`, "");
  out.push(
    ...table(
      ["", ""],
      [
        ["Recipe hash", `\`${report.recipe.hash}\``],
        ["Recipe file", report.recipe.file],
        ["clangd", `${report.clangd.version} (${report.clangd.path})`],
        ["Index mode", report.run.cold ? "COLD run (--cold: background index deleted first)" : "warm/normal run (existing background index reused)"],
        ["Stages", report.run.stages.join(", ")],
        ["Work dir lock", report.run.exclusive ? "held: no other harness run was using this work dir" : "not taken (no clangd stage ran)"],
        ["Other clangd processes at start", report.run.otherClangdProcesses === null ? "not counted" : `${report.run.otherClangdProcesses}${report.run.otherClangdProcesses > 0 ? " (they share the CPU; timings may be skewed)" : ""}`],
        ["Started", report.run.startedAt],
        ["Finished", `${report.run.finishedAt} (${report.run.durationSec} s)`],
        ["Run folder", report.run.dir],
      ],
    ),
  );

  const comparison = report.navComparison;
  if (comparison) {
    out.push(
      comparison.comparable
        ? `**Navigation comparison between variants: valid.** The index finished for every variant.`
        : `**Navigation comparison between variants: REFUSED.** The index did not finish for ${comparison.incomplete.join(", ")}; each of those numbers measures how far its index got, so do not set them side by side.`,
      "",
    );
  }

  for (const v of report.variants) {
    out.push(`## Variant: ${v.name}`, "");
    out.push(`Compile DB: \`${v.db}\` (${v.dbEntries} entries, ${v.dbFiles} distinct files)`);
    if (v.extraArgs.length > 0) out.push(`Extra clangd args: \`${v.extraArgs.join(" ")}\``);
    out.push("");
    for (const [stage, message] of Object.entries(v.errors)) out.push(`**Stage "${stage}" failed:** ${message}`, "");

    if (v.coverage) out.push(...renderCoverage(v.coverage));
    if (v.check) out.push(...renderCheck(v.check));
    if (v.nav) out.push(...renderNav(v.nav));
  }
  return out.join("\n") + "\n";
}

function renderCoverage(coverage) {
  const out = ["### Coverage: on-disk source files that have a compile-DB entry", ""];
  out.push(
    ...table(
      ["Part", "On disk", "With entry", "Coverage", "DB entries", "DB-only files"],
      [
        ...coverage.parts.map((r) => [r.part, r.onDisk, r.withEntries, fmtPct(r.pct), r.dbEntries, r.dbOnly]),
        ["**all**", coverage.total.onDisk, coverage.total.withEntries, fmtPct(coverage.total.pct), "", ""],
      ],
    ),
  );
  const missing = coverage.parts.filter((r) => r.missingSample.length > 0);
  for (const r of missing) {
    out.push(`<details><summary>${r.part}: files without an entry (first ${r.missingSample.length})</summary>`, "");
    out.push(...r.missingSample.map((f) => `- \`${f}\``), "", "</details>", "");
  }
  return out;
}

function renderCheck(check) {
  const out = ["### Check: clangd --check on a sample", ""];
  out.push(
    `Checked ${check.total} files: **${check.clean} clean (${fmtPct(check.pct)})**. ` +
      `Status: ${check.byStatus.ok} ok, ${check.byStatus["ok-slow"]} parsed, feature checks slow (counted clean), ${check.byStatus.errors} with errors, ${check.byStatus.failed} failed, ${check.byStatus.timeout} timed out before a parse.`,
    "",
  );
  out.push("The sample is the same for every variant. Files split by where their compile command came from:", "");
  out.push(
    ...table(
      ["Compile command", "Checked", "Clean", "% clean"],
      [
        ["in this variant's DB", check.inDb.total, check.inDb.clean, fmtPct(check.inDb.pct)],
        ["**in every variant's DB (the fair number to compare)**", check.common.total, check.common.clean, fmtPct(check.common.pct)],
        ["inferred by clangd (not in this DB)", check.inferred.total, check.inferred.clean, fmtPct(check.inferred.pct)],
      ],
    ),
  );
  out.push(...table(["Part", "Checked", "Clean", "% clean"], check.parts.map((r) => [r.part, r.total, r.clean, fmtPct(r.pct)])));

  out.push("**Top error messages**", "");
  out.push(...table(["Files", "Count", "Code", "Message"], check.topMessages.map((m) => [m.files, m.count, m.code, m.message])));

  const unclean = check.files.filter((f) => !f.clean);
  out.push(`**Unclean files** (${unclean.length})`, "");
  out.push(
    ...table(
      ["File", "Part", "Status", "Errors", "First message"],
      unclean.slice(0, 40).map((f) => [f.file, f.part, f.status, f.errorCount, f.diagnostics[0]?.message ?? f.otherErrors[0] ?? ""]),
    ),
  );
  if (unclean.length > 40) out.push(`_${unclean.length - 40} more in report.json_`, "");

  // clean, but kept visible: these parsed and only clangd's feature pass ran past the timeout
  const slow = check.files.filter((f) => f.status === "ok-slow");
  if (slow.length > 0) {
    out.push(`**Parsed, feature checks slow** (${slow.length}, counted clean: the AST was built with no compile error before the timeout)`, "");
    out.push(...table(["File", "Part", "Time"], slow.slice(0, 20).map((f) => [f.file, f.part, fmtDuration(f.ms)])));
    if (slow.length > 20) out.push(`_${slow.length - 20} more in report.json_`, "");
  }
  return out;
}

/** What to show in a results table for a probe or symbol: "pass", the skip reason, or "<status>: <reason>". */
function outcome(r) {
  if (r.status === "pass") return "pass";
  return r.status === "skipped" ? r.reason : `${r.status}: ${r.reason}`;
}

/** The path-identity line under the symbol table, with examples when there are any. */
function renderPathIdentity(symbols) {
  if (symbols.total === 0) return [];
  const identity = symbols.pathIdentity;
  const out = [
    `**Path identity: ${identity.pairs} duplicate symbol pair(s) across roots** in ${identity.queries} of ${symbols.total} queries ` +
      "(the same symbol name and container returned from two different files whose paths end the same, e.g. the SDK copy and the surrogate copy of a header).",
    "",
  ];
  if (identity.examples.length > 0) {
    out.push(...table(["Query", "Symbol", "File A", "File B", "Shared tail (segments)"], identity.examples.map((e) => [e.query, e.container ? `${e.container}::${e.name}` : e.name, e.a, e.b, e.tail])));
  }
  return out;
}

/** At most 8 items, then "..." when there are more. */
function firstEight(items) {
  return items.slice(0, 8).join("; ") + (items.length > 8 ? "; ..." : "");
}

/**
 * What a relationship probe got back, in one cell: the counts, then the first 8 files and names.
 * @param {import("./nav.mjs").ProbeResult} probe
 * @returns {string}
 */
export function cameBack(probe) {
  const returned = probe.returned;
  if (!returned) return "";
  const counts = Object.entries(returned.counts ?? {}).map(([name, value]) => `${value} ${name}`).join(", ");
  const sameFileTwice = returned.counts?.uris ? "(a file came back under two path spellings, such as D:/ and d:/)" : "";
  return [counts, sameFileTwice, returned.files.length > 0 ? `files: ${firstEight(returned.files)}` : "", returned.labels.length > 0 ? `names: ${firstEight(returned.labels)}` : ""].filter(Boolean).join(" | ");
}

/** The tables for the capabilities and for the relationship probes. */
function renderRelationships(nav, banner) {
  const out = [];
  out.push("**Capabilities** (probes that ran, built projects only; one row per kind of question asked of clangd)", "");
  out.push(...table(["Capability", "Pass", "Total", "Rate", "Skipped"], nav.capabilities.map((r) => [r.label, r.pass, r.total, fmtPct(r.pct), r.skipped])));

  const rel = nav.relationships;
  if (rel.total === 0) return out;

  out.push(
    `**Relationships, built projects only: ${rel.built.pass}/${rel.built.total} pass (${fmtPct(rel.built.pct)})**` +
      (rel.built.error > 0 ? `, ${rel.built.error} could not run` : "") +
      (rel.built.skipped > 0 ? `, ${rel.built.skipped} skipped (index incomplete)` : "") +
      (nav.indexComplete ? "" : banner),
    "",
  );
  out.push(...table(["Category", "Types", "Pass", "Total", "Rate"], rel.categories.map((r) => [r.category, r.types.join(", "), r.pass, r.total, fmtPct(r.pct)])));

  out.push(`**Failed relationship probes** (${rel.failures.length})`, "");
  out.push(...table(["Probe", "Type", "Expected", "Result", "Came back (first 8)"], rel.failures.map((r) => [r.id, r.type, r.expected, `${r.status}: ${r.reason}`, cameBack(r)])));

  out.push(`<details><summary>Every relationship probe (${rel.results.length})</summary>`, "");
  out.push(...table(["Probe", "Type", "Result", "Came back (first 8)"], rel.results.map((r) => [r.id, r.type, outcome(r), cameBack(r)])));
  out.push("</details>", "");
  if (rel.notBuilt.total > 0) out.push(`_${rel.notBuilt.total} relationship probes are for gems not in this build and are left out of the rates above._`, "");
  return out;
}

/** The probe files that have no compile-DB entry: where clangd gets their flags from. */
function renderEntryless(entryless) {
  if (entryless.length === 0) return [];
  const out = [
    `**Probe files without a compile-DB entry** (${entryless.length}): clangd infers their flags from another entry. ` +
      "\"full-DB inferred\" means the flags are the ones the full DB gives (a subset run keeps that entry); " +
      "\"subset-inferred\" means clangd could not name the entry, so the flags depend on the subset and are not comparable with a full-DB run.",
    "",
  ];
  out.push(...table(["File", "Flags", "Flags inferred from", "Probes"], entryless.map((e) => [e.file, e.source, e.from || "(not named by clangd)", e.probes.length])));
  return out;
}

function renderNav(nav) {
  const incomplete = !nav.indexComplete;
  const banner = " - INDEX INCOMPLETE - partial results";
  const out = ["### Navigation: F12, Ctrl+T and the relationship requests through a real clangd", ""];
  if (incomplete) {
    out.push(
      `**INDEX INCOMPLETE - partial results.** The background index did not finish, so the ${nav.probes.needsIndex.skipped + nav.relationships.built.skipped} probes that need it and all ${nav.symbols.skipped} symbol queries were skipped. ` +
        "The rates below cover only what does not depend on the index; they are not the IntelliSense quality of a finished index.",
      "",
    );
  }
  out.push(
    ...table(
      ["Index", ""],
      [
        ["Start state", nav.freshIndex ? "cold (index folder was empty)" : "warm (index folder had content)"],
        ["Compile DB", nav.dbSubset ? `SUBSET: ${nav.dbSubset.entries} of ${nav.dbSubset.of} entries (so the index time is not the full-DB time)` : "full"],
        ["Index time", `${fmtDuration(nav.indexMs)}${nav.indexComplete ? "" : " (NOT finished: wait cap reached)"}`],
        ["Index size on disk", fmtBytes(nav.indexSizeBytes)],
        ["Index folder", `${nav.indexDir} (${nav.indexExists ? "exists" : "MISSING"}, ${nav.indexInsideWorkDir ? "inside" : "OUTSIDE"} the work dir)`],
        ["Note", nav.indexNote],
      ],
    ),
  );

  const p = nav.probes;
  out.push(
    `**Probes (F12), built projects only: ${p.built.pass}/${p.built.total} pass (${fmtPct(p.built.pct)})**` +
      (p.built.error > 0 ? `, ${p.built.error} could not run` : "") +
      (p.built.skipped > 0 ? `, ${p.built.skipped} skipped (index incomplete)` : "") +
      (incomplete ? banner : ""),
    "",
  );
  out.push(
    ...table(
      ["Probes", "Total", "Ran", "Pass", "Rate"],
      [
        ["independent of the index", p.independent.total, p.independent.total, p.independent.pass, fmtPct(p.independent.pct)],
        ["needing the index", p.needsIndex.total, p.needsIndex.ran, p.needsIndex.pass, fmtPct(p.needsIndex.pct)],
      ],
    ),
  );
  out.push(...table(["Part", "Pass", "Total", "Rate"], p.parts.map((r) => [r.part, r.pass, r.total, fmtPct(r.pct)])));
  out.push(...table(["Category", "Pass", "Total", "Rate"], p.categories.map((r) => [r.category, r.pass, r.total, fmtPct(r.pct)])));
  out.push(...renderEntryless(nav.entryless ?? []));

  out.push(`**Failed probes** (${p.failures.length})`, "");
  out.push(
    ...table(
      ["Probe", "Part", "Flags", "Expected", "Result", "Landed on"],
      p.failures.map((r) => [
        r.id,
        r.part,
        flagsLabel(r),
        `${r.kind} in ...${r.expectedSuffix}`,
        `${r.status}: ${r.reason}`,
        r.targets.map((t) => `${t.path}:${t.line}`).join("; "),
      ]),
    ),
  );
  if (p.notBuilt.total > 0) {
    out.push(`**Probes for gems not in this build** (${p.notBuilt.total}, not in the rate above; ${p.notBuilt.pass} unexpectedly pass)`, "");
    out.push(...table(["Probe", "Part", "Flags", "Result"], p.notBuilt.results.map((r) => [r.id, r.part, flagsLabel(r), outcome(r)])));
  }

  out.push(...renderRelationships(nav, banner));

  const s = nav.symbols;
  out.push(`**Symbols (Ctrl+T): ${s.pass}/${s.total} pass (${fmtPct(s.pct)})**` + (s.skipped > 0 ? `, ${s.skipped} skipped (index incomplete)` : "") + (incomplete ? banner : ""), "");
  out.push(
    ...table(
      ["Query", "Expected file", "Result", "Hits", "First hit"],
      s.results.map((r) => [r.query, `...${r.expectedSuffix}`, outcome(r), r.resultCount, r.top[0] ? `${r.top[0].name} (${r.top[0].path}:${r.top[0].line})` : ""]),
    ),
  );
  out.push(...renderPathIdentity(s));
  if (nav.clangdStderr) out.push("**clangd stderr (tail)**", "", "```", nav.clangdStderr, "```", "");
  return out;
}
