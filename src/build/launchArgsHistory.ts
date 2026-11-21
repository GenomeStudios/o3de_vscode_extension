// ============================================================================
//  Launch-args history — the remembered Launch Options, most recent first.
//
//  Pure list rules (no vscode import) behind the Launch Options picker and the
//  o3de_get_config / o3de_set_config launchArgsHistory field. BuildOptions
//  stores the list; these functions decide what goes in it. Entries are trimmed
//  and compared exactly (no case folding, no whitespace collapsing — quoted
//  tokens are significant to parseLaunchArgs). No function mutates its input.
// ============================================================================

/** How many launch-option strings are remembered per workspace. */
export const LAUNCH_ARGS_HISTORY_MAX = 10;

// ---- Add -------------------------------------------------------------------
/** `value` placed first (moved there if already listed); a blank value changes nothing. */
export function pushLaunchArgsHistory(
  history: readonly string[],
  value: string,
  max: number = LAUNCH_ARGS_HISTORY_MAX,
): string[] {
  const entry = value.trim();
  if (entry === "") {
    return [...history];
  }
  return [entry, ...history.filter((existing) => existing !== entry)].slice(0, max);
}

// ---- Remove ----------------------------------------------------------------
/** The history without `value` (an exact match); unchanged when it is not listed. */
export function removeLaunchArgsHistory(history: readonly string[], value: string): string[] {
  const entry = value.trim();
  return history.filter((existing) => existing !== entry);
}

// ---- Clean a stored list ---------------------------------------------------
/** A usable history from whatever was stored: strings only, trimmed, no blanks or duplicates, capped. */
export function sanitizeLaunchArgsHistory(stored: unknown, max: number = LAUNCH_ARGS_HISTORY_MAX): string[] {
  if (!Array.isArray(stored)) {
    return [];
  }
  const clean: string[] = [];
  for (const item of stored) {
    const entry = typeof item === "string" ? item.trim() : "";
    if (entry !== "" && !clean.includes(entry)) {
      clean.push(entry);
    }
  }
  return clean.slice(0, max);
}
