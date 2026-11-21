// ============================================================================
//  Process probe (issue #44) -- the pure matching rules behind the
//  already-running guard: how `tasklist /FO CSV` output is read (Windows) and
//  how the `pgrep -f` pattern for one exe is built (Linux). The probes
//  themselves spawn real processes and are checked by hand.
// ============================================================================

import * as assert from "assert";
import { exePathPattern, tasklistListsImage } from "../build/processProbe";

suite("processProbe", () => {
  // ---- tasklist /FO CSV ----------------------------------------------------
  suite("tasklistListsImage", () => {
    const LONG_IMAGE = "GS_PlayProject.GameLauncher.exe"; // 31 characters: over the table's 25-character name column

    test("a CSV row for the image matches, however long its name", () => {
      const csv = '"GS_PlayProject.GameLauncher.exe","1234","Console","1","100,000 K"\r\n';
      assert.strictEqual(tasklistListsImage(csv, LONG_IMAGE), true);
    });

    test("the match ignores case", () => {
      assert.strictEqual(tasklistListsImage('"editor.EXE","77","Console","1","5 K"', "Editor.exe"), true);
    });

    test("the no-match INFO line does not match", () => {
      assert.strictEqual(tasklistListsImage("INFO: No tasks are running which match the specified criteria.", "Editor.exe"), false);
    });

    test("the table form cuts the name at 25 characters and does not match: why CSV is used", () => {
      const table = `${LONG_IMAGE.slice(0, 25)}  1234 Console  1  100,000 K`;
      assert.strictEqual(tasklistListsImage(table, LONG_IMAGE), false);
    });

    test("another image whose name merely contains this one does not match", () => {
      assert.strictEqual(tasklistListsImage('"MyEditor.exe","5","Console","1","5 K"', "Editor.exe"), false);
    });
  });

  // ---- pgrep -f pattern ----------------------------------------------------
  suite("exePathPattern", () => {
    const EXE = "/home/dev/GS_Play/build/linux/bin/profile/Editor";
    const matches = (pattern: string, commandLine: string): boolean => new RegExp(pattern).test(commandLine);

    test("matches the exe at the start of a command line, alone or followed by arguments", () => {
      const pattern = exePathPattern(EXE);
      assert.ok(matches(pattern, EXE));
      assert.ok(matches(pattern, `${EXE} --project-path=/home/dev/GS_Play`));
    });

    test("does not match a process that merely contains the name", () => {
      const pattern = exePathPattern(EXE);
      assert.ok(!matches(pattern, "/home/dev/O3DEEditor/bin/profile/AssetProcessor --project-path=/home/dev/GS_Play"), "an engine tool");
      assert.ok(!matches(pattern, `/bin/sh -c pgrep -f -- ${EXE}`), "a shell running the probe");
      assert.ok(!matches(pattern, `${EXE}.log viewer`), "a longer name that starts the same");
      assert.ok(!matches(pattern, `/usr/bin/gdb --args ${EXE}`), "the exe somewhere other than the start");
    });

    test("regex characters in the path are escaped", () => {
      const pattern = exePathPattern("/home/dev/My.Game+1/Editor");
      assert.ok(pattern.includes("My\\.Game\\+1"), pattern);
      assert.ok(matches(pattern, "/home/dev/My.Game+1/Editor"));
      assert.ok(!matches(pattern, "/home/dev/MyxGame+1/Editor"), "the dot is not a wildcard");
    });
  });
});
