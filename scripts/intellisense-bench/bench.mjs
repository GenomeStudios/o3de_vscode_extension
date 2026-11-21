#!/usr/bin/env node
// ============================================================================
//  bench.mjs - IntelliSense benchmark for the O3DE Development Tools extension
//
//    node bench.mjs --recipe <file> [--variant <name>] [--only coverage|check|nav]
//                   [--cold] [--out <dir>] [--clangd <path>]
//    node bench.mjs --selftest [--work-dir <dir>] [--clangd <path>]
//
//  See README.md for what is measured and how to read the report.
// ============================================================================

import { parseArgs } from "node:util";
import { loadRecipe } from "./lib/recipe.mjs";
import { installCleanup } from "./lib/procs.mjs";
import { indexWarnings } from "./lib/report.mjs";
import { runBenchmark } from "./lib/run.mjs";
import { runSelfTest } from "./lib/selftest.mjs";

const USAGE = `Usage:
  node bench.mjs --recipe <file> [options]
  node bench.mjs --selftest [--work-dir <dir>] [--clangd <path>]

Options:
  --recipe <file>     recipe JSON (see README.md)
  --variant <name>    run only this variant (repeat or comma-separate for several)
  --only <stage>      run only coverage, check or nav (repeat or comma-separate)
  --cold              delete each variant's background index first (nav timing from scratch)
  --out <dir>         run folder; must be inside the recipe's workDir
  --clangd <path>     override the recipe's clangd (also used by --selftest)
  --selftest          prove the LSP path on a tiny scratch C++ project (default work dir D:/ib)
  --work-dir <dir>    selftest only: where the scratch project lives
  --help              show this text
`;

// ============================================================================
//  COMMAND LINE
// ============================================================================

/** @param {string | string[] | undefined} value  repeated and/or comma-separated flag values */
function splitList(value) {
  return [value ?? []].flat().flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
}

/** @param {string} message */
function log(message) {
  console.error(`[${new Date().toTimeString().slice(0, 8)}] ${message}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      recipe: { type: "string" },
      variant: { type: "string", multiple: true },
      only: { type: "string", multiple: true },
      cold: { type: "boolean", default: false },
      out: { type: "string" },
      clangd: { type: "string" },
      selftest: { type: "boolean", default: false },
      "work-dir": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help || (!values.recipe && !values.selftest)) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  installCleanup();

  if (values.selftest) {
    const ok = await runSelfTest({ workDir: values["work-dir"], clangd: values.clangd, log });
    return ok ? 0 : 1;
  }

  const loaded = loadRecipe(values.recipe);
  if (values.clangd) loaded.recipe.clangd = values.clangd;
  const { report, outDir } = await runBenchmark(loaded, {
    variants: splitList(values.variant),
    only: splitList(values.only),
    cold: values.cold,
    out: values.out,
    log,
  });
  console.log(`report.md:   ${outDir}/report.md`);
  console.log(`report.json: ${outDir}/report.json`);
  for (const warning of indexWarnings(report)) console.log(warning);
  const failedStages = report.variants.flatMap((v) => Object.keys(v.errors).map((stage) => `${v.name}:${stage}`));
  if (failedStages.length > 0) {
    console.log(`stages with errors: ${failedStages.join(", ")}`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`bench: ${err.message}`);
    process.exit(1);
  },
);
