// ============================================================================
//  Consolidation (pure) — the "one source" data layer the user asked for.
//
//  Two merges over a set of targets:
//    • consolidateTargets — the UNION of everything (deduped, normalized, stable
//      order). Right for navigation (browse path) where reach matters.
//    • agreedCompile — union the includes, INTERSECT the defines + forced includes.
//      Right for a file with no single owner, where contradictory macros would
//      silently mis-resolve #if branches.
// ============================================================================

import { IncludeEntry, TargetCompile } from "./fileApi";
import { normalizePath } from "./paths";

export interface ConsolidatedCompile {
  includes: IncludeEntry[]; // normalized paths, deduped, first-seen order
  defines: string[]; // deduped, first-seen order
  forcedIncludes: string[]; // normalized paths, deduped, first-seen order
  standard?: string; // first C++ standard seen
}

/** Union + dedupe the per-target compile data into one consolidated set. */
export function consolidateTargets(targets: TargetCompile[]): ConsolidatedCompile {
  const includes: IncludeEntry[] = [];
  const seenInclude = new Set<string>();
  const defines: string[] = [];
  const seenDefine = new Set<string>();
  const forcedIncludes: string[] = [];
  const seenForced = new Set<string>();
  let standard: string | undefined;

  for (const target of targets) {
    for (const inc of target.includes) {
      const normalized = normalizePath(inc.path);
      const key = normalized.toLowerCase();
      if (!seenInclude.has(key)) {
        seenInclude.add(key);
        includes.push({ path: normalized, isSystem: inc.isSystem });
      }
    }
    for (const def of target.defines) {
      if (!seenDefine.has(def)) {
        seenDefine.add(def);
        defines.push(def);
      }
    }
    for (const forced of target.forcedIncludes) {
      const normalized = normalizePath(forced);
      const key = normalized.toLowerCase();
      if (!seenForced.has(key)) {
        seenForced.add(key);
        forcedIncludes.push(normalized);
      }
    }
    if (!standard && target.standard) {
      standard = target.standard;
    }
  }
  return { includes, defines, forcedIncludes, standard };
}

// ---- Agreed compile — for files with no single owning target ---------------
/** Values present in EVERY list, in the first list's order, deduped by `key`. */
function intersectAll(lists: string[][], key: (value: string) => string): string[] {
  if (lists.length === 0) {
    return [];
  }
  const others = lists.slice(1).map((list) => new Set(list.map(key)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of lists[0]) {
    const k = key(value);
    if (!seen.has(k) && others.every((set) => set.has(k))) {
      seen.add(k);
      out.push(value);
    }
  }
  return out;
}

/**
 * What a file compiles with when no SINGLE target owns it — engine source reached
 * through the source-engine redirect, a gem not enabled in this project, or a file
 * several targets share. One rule, "union includes, intersect semantics":
 *
 *   - Include paths: the UNION. A header any target can reach should still resolve.
 *   - Defines + forced includes: the INTERSECTION. Only what EVERY target agrees on.
 *
 * A union of defines is self-contradictory on a real project — measured on gs_play it
 * carried 14 different `O3DE_GEM_NAME=` values at once and `O3DE_HEADLESS_SERVER=1`,
 * which greys out client code as inactive in every file that falls back. An
 * intersection cannot contradict itself, and it is order-independent, so the result is
 * deterministic across refreshes by construction.
 */
export function agreedCompile(targets: TargetCompile[]): ConsolidatedCompile {
  const union = consolidateTargets(targets);
  return {
    includes: union.includes,
    defines: intersectAll(
      targets.map((target) => target.defines),
      (define) => define, // exact text: FOO=1 and FOO=2 are different, so a conflict drops out
    ),
    forcedIncludes: intersectAll(
      targets.map((target) => target.forcedIncludes.map(normalizePath)),
      (forced) => forced.toLowerCase(),
    ),
    standard: union.standard,
  };
}
