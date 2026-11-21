// ============================================================================
//  Run logs (issue #43) -- the pure line/kind helpers, plus readLogTail against
//  real files in a temp project folder (<project>/user/log/...).
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LogTail,
  MAX_TAIL_LINES,
  clampTailLines,
  logKindForTarget,
  readLogTail,
  runLogFileName,
  tailLines,
  writtenSince,
} from "../build/runLog";

suite("runLog", () => {
  // ---- Pure helpers --------------------------------------------------------
  suite("pure helpers", () => {
    test("tailLines returns the last n lines", () => {
      assert.strictEqual(tailLines("a\nb\nc\nd", 2), "c\nd");
    });

    test("tailLines with n larger than the file returns every line", () => {
      assert.strictEqual(tailLines("a\nb", 50), "a\nb");
    });

    test("tailLines ignores a trailing newline and normalises CRLF", () => {
      assert.strictEqual(tailLines("a\nb\nc\n", 2), "b\nc");
      assert.strictEqual(tailLines("a\r\nb\r\nc\r\n", 2), "b\nc");
    });

    test("tailLines of empty text, or n below 1, is empty", () => {
      assert.strictEqual(tailLines("", 5), "");
      assert.strictEqual(tailLines("a\nb", 0), "");
    });

    test("runLogFileName: the file name O3DE writes, error.log lowercase", () => {
      assert.strictEqual(runLogFileName("editor"), "Editor.log");
      assert.strictEqual(runLogFileName("game"), "Game.log");
      assert.strictEqual(runLogFileName("error"), "error.log");
    });

    test("logKindForTarget: Editor and GameLauncher have a log, a custom exe has none", () => {
      assert.strictEqual(logKindForTarget("Editor"), "editor");
      assert.strictEqual(logKindForTarget("GameLauncher"), "game");
      assert.strictEqual(logKindForTarget("MyTool"), undefined);
    });

    test("writtenSince: a log written at or after the moment counts; an older, missing or absent one does not", () => {
      const logAt = (modifiedAt?: string): LogTail => ({ kind: "error", path: "p", exists: modifiedAt !== undefined, modifiedAt, truncated: false, lines: 0, tail: "" });
      const since = Date.parse("2026-01-01T00:00:10Z");
      assert.strictEqual(writtenSince(logAt("2026-01-01T00:00:20Z"), since), true, "newer");
      assert.strictEqual(writtenSince(logAt("2026-01-01T00:00:10Z"), since), true, "the same instant");
      assert.strictEqual(writtenSince(logAt("2026-01-01T00:00:05Z"), since), false, "older");
      assert.strictEqual(writtenSince(logAt(undefined), since), false, "a log that does not exist");
      assert.strictEqual(writtenSince(null, since), false);
      assert.strictEqual(writtenSince(undefined, since), false);
    });

    test("clampTailLines: default 100, kept within 1..MAX_TAIL_LINES", () => {
      assert.strictEqual(clampTailLines(undefined), 100);
      assert.strictEqual(clampTailLines(0), 1);
      assert.strictEqual(clampTailLines(-5), 1);
      assert.strictEqual(clampTailLines(25), 25);
      assert.strictEqual(clampTailLines(MAX_TAIL_LINES + 1000), MAX_TAIL_LINES);
      assert.strictEqual(clampTailLines(Number.NaN), 100);
    });
  });

  // ---- readLogTail against real files --------------------------------------
  suite("readLogTail", () => {
    let project: string;

    setup(() => {
      project = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-runlog-"));
    });

    teardown(() => {
      fs.rmSync(project, { recursive: true, force: true });
    });

    function writeLog(fileName: string, content: string): string {
      const dir = path.join(project, "user", "log");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, fileName);
      fs.writeFileSync(file, content);
      return file;
    }

    test("returns the last N lines with size and age", () => {
      const file = writeLog("Editor.log", "one\ntwo\nthree\nfour\n");
      const result = readLogTail(project, "editor", 2);
      assert.strictEqual(result.exists, true);
      assert.strictEqual(result.path, file);
      assert.strictEqual(result.tail, "three\nfour");
      assert.strictEqual(result.lines, 2);
      assert.strictEqual(result.sizeBytes, fs.statSync(file).size);
      assert.strictEqual(result.truncated, false);
      assert.strictEqual(result.readError, undefined);
      assert.ok(result.modifiedAt && !Number.isNaN(Date.parse(result.modifiedAt)), "modifiedAt is an ISO time");
      assert.ok(result.ageSeconds !== undefined && result.ageSeconds >= 0 && result.ageSeconds < 60);
    });

    test("n larger than the file returns the whole file, not truncated", () => {
      writeLog("Editor.log", "one\ntwo\n");
      const result = readLogTail(project, "editor", 100);
      assert.strictEqual(result.tail, "one\ntwo");
      assert.strictEqual(result.lines, 2);
      assert.strictEqual(result.truncated, false);
    });

    test("a CRLF log comes back with plain newlines", () => {
      writeLog("Editor.log", "one\r\ntwo\r\nthree\r\n");
      assert.strictEqual(readLogTail(project, "editor", 2).tail, "two\nthree");
    });

    test("a file bigger than the read window: only the end is read and the partial first line is dropped", () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(4, "0")}`);
      writeLog("Editor.log", lines.join("\n") + "\n"); // 200 lines x 10 bytes = 2000 bytes
      const result = readLogTail(project, "editor", 500, 105); // window starts mid-line
      const got = result.tail.split("\n");
      assert.strictEqual(got[got.length - 1], "line-0199", "the newest line is kept");
      assert.ok(got.every((line) => /^line-\d{4}$/.test(line)), `a partial line leaked in: ${got[0]}`);
      assert.ok(got.length < 12, "only the window's lines came back");
      assert.strictEqual(result.truncated, true, "fewer lines than asked for, and the file holds more");
    });

    test("a file bigger than the window is not truncated when the window still holds the lines asked for", () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(4, "0")}`);
      writeLog("Editor.log", lines.join("\n") + "\n");
      const result = readLogTail(project, "editor", 3, 105);
      assert.strictEqual(result.tail, "line-0197\nline-0198\nline-0199");
      assert.strictEqual(result.truncated, false);
    });

    test("the tail is capped in characters, keeping the most recent lines", () => {
      const lines = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(3, "0")} ${"x".repeat(246)}`); // ~250 chars each
      writeLog("Editor.log", lines.join("\n") + "\n"); // ~100 KB, under the read window
      const result = readLogTail(project, "editor", 400);
      assert.ok(result.tail.length <= 48_000, `tail is ${result.tail.length} chars`);
      assert.ok(result.tail.endsWith(lines[399]), "the newest line is kept");
      assert.ok(result.tail.split("\n").every((line) => line.length === 250), "no partial line");
      assert.ok(result.lines < 400);
      assert.strictEqual(result.lines, result.tail.split("\n").length);
      assert.strictEqual(result.truncated, true);
    });

    test("a missing log is exists:false with the expected path, and a missing folder too", () => {
      const result = readLogTail(project, "game", 10);
      assert.strictEqual(result.exists, false);
      assert.strictEqual(result.path, path.join(project, "user", "log", "Game.log"));
      assert.strictEqual(result.tail, "");
      assert.strictEqual(result.lines, 0);
      assert.strictEqual(result.readError, undefined);

      writeLog("Editor.log", "x\n"); // folder exists now, the asked-for log still does not
      assert.strictEqual(readLogTail(project, "game", 10).exists, false);
    });

    test("the file name matches case-insensitively (error.log vs Error.log)", () => {
      const file = writeLog("Error.log", "boom\n");
      const result = readLogTail(project, "error", 10);
      assert.strictEqual(result.exists, true);
      assert.strictEqual(path.basename(result.path), path.basename(file));
      assert.strictEqual(result.tail, "boom");
    });

    test("an empty log reads as an empty tail", () => {
      writeLog("Editor.log", "");
      const result = readLogTail(project, "editor", 10);
      assert.strictEqual(result.exists, true);
      assert.strictEqual(result.sizeBytes, 0);
      assert.strictEqual(result.tail, "");
      assert.strictEqual(result.truncated, false);
    });

    test("an unreadable log never throws: readError instead", () => {
      // A directory named like the log: it is found, but cannot be read as a file.
      fs.mkdirSync(path.join(project, "user", "log", "Editor.log"), { recursive: true });
      const result = readLogTail(project, "editor", 10);
      assert.strictEqual(result.exists, true);
      assert.ok(result.readError && result.readError.length > 0, "readError explains the failure");
      assert.strictEqual(result.tail, "");
    });

    test("a project path that does not exist never throws", () => {
      const result = readLogTail(path.join(project, "nope"), "editor", 10);
      assert.strictEqual(result.exists, false);
    });
  });
});
