// ============================================================================
//  Run logs -- read the tail of an O3DE app's log (no vscode, so it is unit-tested).
//
//  O3DE writes per-project logs under <project>/user/log/: Editor.log (the Editor),
//  Game.log (the GameLauncher) and error.log (crash / fatal output, lowercase in
//  the engine source). Editor.log grows to tens of MB, so only the last chunk of
//  the file is ever read, and what is returned is capped so a call stays small.
//  Backs the o3de_read_run_log tool and o3de_run's settleSeconds report.
// ============================================================================

import * as fs from "fs";
import * as path from "path";

// ---- Kinds and file names --------------------------------------------------
export type RunLogKind = "editor" | "game" | "error";

const LOG_FILE_NAMES: Record<RunLogKind, string> = {
  editor: "Editor.log",
  game: "Game.log",
  error: "error.log",
};

/** The log file name O3DE writes for a kind. */
export function runLogFileName(kind: RunLogKind): string {
  return LOG_FILE_NAMES[kind];
}

/** The log a run target writes: Editor -> Editor.log, GameLauncher -> Game.log, a custom exe -> none known. */
export function logKindForTarget(target: string): RunLogKind | undefined {
  if (target === "Editor") {
    return "editor";
  }
  if (target === "GameLauncher") {
    return "game";
  }
  return undefined;
}

// ---- Limits ----------------------------------------------------------------
export const DEFAULT_TAIL_LINES = 100;
export const MAX_TAIL_LINES = 500;
const MAX_READ_BYTES = 256 * 1024; // only the end of the file is read
const MAX_TAIL_CHARS = 48_000; // the most recent characters kept, however many lines were asked for

/** A requested line count, clamped to 1..MAX_TAIL_LINES (default DEFAULT_TAIL_LINES). */
export function clampTailLines(requested: number | undefined): number {
  const lines = Math.round(requested ?? DEFAULT_TAIL_LINES);
  return Math.min(MAX_TAIL_LINES, Math.max(1, Number.isFinite(lines) ? lines : DEFAULT_TAIL_LINES));
}

// ---- Pure text helpers -----------------------------------------------------
/** Split into lines (LF or CRLF), ignoring the empty piece a trailing newline leaves. */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** The last n lines of the text, joined with "\n" (n < 1 gives ""). */
export function tailLines(text: string, n: number): string {
  return n < 1 ? "" : splitLines(text).slice(-n).join("\n");
}

/** Keep at most `max` of the most recent characters, starting at a line start when the cut falls mid-line. */
function keepLastChars(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(-max);
  const lineStart = cut.indexOf("\n");
  return lineStart === -1 ? cut : cut.slice(lineStart + 1);
}

// ---- Reading a log ---------------------------------------------------------
export interface LogTail {
  kind: RunLogKind;
  path: string; // the resolved file, or where it was expected when missing
  exists: boolean;
  sizeBytes?: number;
  modifiedAt?: string; // ISO time of the last write
  ageSeconds?: number; // seconds since the last write -- tells whether the log is from the current run
  truncated: boolean; // fewer lines than asked for came back because of the read window or character cap
  lines: number; // how many lines `tail` holds
  tail: string; // the last lines, "\n"-joined
  readError?: string;
}

/** True when the log exists and was last written at or after `since` (epoch ms), i.e. during or after that moment. */
export function writtenSince(log: LogTail | null | undefined, since: number): boolean {
  return log?.modifiedAt !== undefined && Date.parse(log.modifiedAt) >= since;
}

/** <project>/user/log/<name>, matching the file name case-insensitively (error.log vs Error.log on Linux). */
function resolveLogFile(projectPath: string, kind: RunLogKind): string | undefined {
  const dir = path.join(projectPath, "user", "log");
  const wanted = LOG_FILE_NAMES[kind];
  try {
    const names = fs.readdirSync(dir);
    const match = names.includes(wanted) ? wanted : names.find((name) => name.toLowerCase() === wanted.toLowerCase());
    return match ? path.join(dir, match) : undefined;
  } catch {
    return undefined; // no log folder yet
  }
}

/**
 * The last `lines` lines of a project's log. Reads only the last `maxBytes` of the file (dropping the partial line
 * the window starts in), works on a log the app still has open, and never throws: problems come back as readError.
 */
export function readLogTail(projectPath: string, kind: RunLogKind, lines: number, maxBytes = MAX_READ_BYTES): LogTail {
  const file = resolveLogFile(projectPath, kind);
  if (!file) {
    const expected = path.join(projectPath, "user", "log", LOG_FILE_NAMES[kind]);
    return { kind, path: expected, exists: false, truncated: false, lines: 0, tail: "" };
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("not a regular file");
    }
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, stat.size - length);

    let text = buffer.toString("utf8", 0, bytesRead);
    const windowed = stat.size > length;
    if (windowed) {
      text = text.slice(text.indexOf("\n") + 1); // the first line is usually cut in half
    }
    const available = splitLines(text).length;
    const tail = keepLastChars(tailLines(text, lines), MAX_TAIL_CHARS);
    const returned = tail === "" ? 0 : tail.split("\n").length;
    // Truncated = the caller got fewer lines than asked for although the file holds more: the read window ended
    // first, or the character cap cut the tail. A short file, or exactly the lines asked for, is not truncated.
    const truncated = returned < lines && (windowed || returned < available);

    return {
      kind,
      path: file,
      exists: true,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      ageSeconds: Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000)),
      truncated,
      lines: returned,
      tail,
    };
  } catch (err) {
    return { kind, path: file, exists: true, truncated: false, lines: 0, tail: "", readError: err instanceof Error ? err.message : String(err) };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing more to do */
      }
    }
  }
}
