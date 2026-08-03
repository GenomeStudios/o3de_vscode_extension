// ============================================================================
//  Output-stream hygiene — pure line shaping (vscode-free, unit-tested).
//
//  A terminal has a cursor; an Output channel does not. Two things therefore
//  have to be handled before child-process bytes are readable in the panel:
//
//    1. CARRIAGE-RETURN REWRITES. Tools that redraw a status line in place emit
//       "…\r…\r…" on ONE line. Appended verbatim that becomes a single
//       enormous line. We keep the last segment — what the terminal would have
//       left visible.
//    2. VOLUME. Through a pipe ninja stops redrawing and prints one
//       "[n/m] Building CXX object …" line PER EDGE instead. A full engine
//       build is thousands of those, which buries the handful of lines that
//       matter. So progress lines are THROTTLED to a heartbeat while every
//       other line (warnings, errors, cmake/linker messages) passes through
//       immediately and is never dropped.
//
//  Throttling affects DISPLAY ONLY. The runner accumulates the full raw output
//  separately for parseBuildOutput, so no diagnostic is ever lost to the filter.
//
//  The clock is injectable so the throttle is unit-testable without timers.
// ============================================================================

// ---- Types -----------------------------------------------------------------
/** A ninja "[current/total]" build-progress pair. */
export interface StreamProgress {
  current: number;
  total: number;
}

export interface FilterOptions {
  progressIntervalMs?: number; // heartbeat between progress lines (default 500)
  now?: () => number; // injectable clock (tests)
}

/** What a push()/flush() produced: lines to display, plus a progress tick if one fired. */
export interface FilterEmission {
  lines: string[];
  progress?: StreamProgress;
}

const DEFAULT_INTERVAL_MS = 500;

// ---- Pure helpers ----------------------------------------------------------
// CSI / OSC escape sequences. Colour codes survive a pipe from some tools and
// render as literal garbage in an Output channel.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

/** Remove ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Collapse an in-place-rewritten line to what would still be visible: the text
 * after the last carriage return. A trailing CR (the CRLF remnant after
 * splitting on \n) contributes nothing and is dropped first.
 */
export function collapseCarriageReturns(line: string): string {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  const last = text.lastIndexOf("\r");
  return last < 0 ? text : text.slice(last + 1);
}

//  Ninja edge progress:  [412/1337] Building CXX object Gem/CMakeFiles/…
const NINJA_PROGRESS_RE = /^\[(\d+)\/(\d+)\]/;

/** The "[n/m]" pair when `line` is a ninja progress line, else undefined. */
export function parseNinjaProgress(line: string): StreamProgress | undefined {
  const m = NINJA_PROGRESS_RE.exec(line);
  return m ? { current: Number(m[1]), total: Number(m[2]) } : undefined;
}

/** "42%" style share for a progress pair (0 when the total is unusable). */
export function progressPercent(progress: StreamProgress | undefined): number {
  if (!progress || progress.total <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((progress.current / progress.total) * 100));
}

/** How a progress pair reads in a title / on a button ("412/1337 - 31%"). */
export function progressLabel(progress: StreamProgress | undefined): string {
  if (!progress) {
    return "";
  }
  return `${progress.current}/${progress.total} - ${progressPercent(progress)}%`;
}

// ---- Stateful filter -------------------------------------------------------
/**
 * Chunk-to-display-lines shaper. Feed raw stdout/stderr chunks to push(); call
 * flush() once the process ends to release the last held-back progress line and
 * any unterminated tail.
 */
export class OutputFilter {
  private partial = ""; // incomplete trailing line carried between chunks
  private heldLine: string | undefined; // newest progress line not yet displayed
  private heldProgress: StreamProgress | undefined;
  private lastTickAt = 0;
  private latest: StreamProgress | undefined; // newest pair seen, displayed or not

  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(options: FilterOptions = {}) {
    this.intervalMs = options.progressIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /** The newest progress pair seen, regardless of whether it was displayed. */
  get progress(): StreamProgress | undefined {
    return this.latest;
  }

  /** Shape a raw chunk into the lines that should be displayed now. */
  push(chunk: string): FilterEmission {
    const emission: FilterEmission = { lines: [] };
    const text = this.partial + chunk;
    const parts = text.split("\n");
    this.partial = parts.pop() ?? ""; // last piece may be mid-line

    for (const part of parts) {
      const line = collapseCarriageReturns(stripAnsi(part));
      const progress = parseNinjaProgress(line);

      if (progress) {
        this.latest = progress;
        this.heldLine = line;
        this.heldProgress = progress;
        if (this.now() - this.lastTickAt >= this.intervalMs) {
          this.tick(emission);
        }
        continue;
      }

      // A real message. Release any held progress line FIRST: the "[n/m]
      // Building X" immediately above an error names the file being compiled,
      // so dropping it would strip the error of its context.
      this.tick(emission);
      emission.lines.push(line);
    }
    return emission;
  }

  /** Release the last held progress line and any unterminated tail. */
  flush(): FilterEmission {
    const emission: FilterEmission = { lines: [] };
    this.tick(emission);
    const tail = collapseCarriageReturns(stripAnsi(this.partial));
    this.partial = "";
    if (tail.trim() !== "") {
      emission.lines.push(tail);
    }
    return emission;
  }

  // Move a held-back progress line into the emission (no-op when nothing held).
  private tick(emission: FilterEmission): void {
    if (this.heldLine === undefined) {
      return;
    }
    emission.lines.push(this.heldLine);
    emission.progress = this.heldProgress;
    this.lastTickAt = this.now();
    this.heldLine = undefined;
    this.heldProgress = undefined;
  }
}
